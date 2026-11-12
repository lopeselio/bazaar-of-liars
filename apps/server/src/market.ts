/**
 * Canal Street's agent economy, run by the game server against the bazaar contract (v3).
 *
 * - Prices player haggles from each merchant's onchain purse and stock (packages/core economy.ts).
 * - Every tick (one replica at a time), the agents act on their own:
 *     merchants low on stock restock a lot from Auntie Wu at the docks, haggling under the same
 *     rules engine and commit-reveal as players, then hire Little Lo to haul it;
 *     merchants use up goods they bought, so they want more;
 *     the rival traders buy at one stall and sell at another.
 *   Every spend is signed by the agent's own key (authorize_spend / pay_agent) and capped onchain.
 * - Customers across Manhattan post delivery orders with their own signatures, funded by their
 *   (capped) daily income; missed orders are expired and refunded.
 * - Agents shop at player-owned stalls while their owners are away: traders pick up bargains to
 *   flip, and a customer about to give up on a delivery buys from a stall instead.
 * - Writes a news feed of what happened, with the transaction behind each line.
 */
import { randomUUID } from "node:crypto";
import {
  AGENTS,
  BOTS,
  SHIP_GAP_MS,
  EVENT_GAP_MS,
  eventHeadline,
  bountyMultiplier,
  tradersLieLow,
  type StreetEvent,
  TIP_RESOLVE_WINDOW_MS,
  informantById,
  type TipClaim,
  agentBid,
  bidCommitment,
  depositFor,
  CUSTOMERS,
  barterQuote,
  pickBarter,
  customerShopping,
  customerWouldBuy,
  WALK_IN_CHANCE,
  traderWouldBuy,
  orderTerms,
  siteById,
  GOODS,
  MERCHANTS,
  WHOLESALER,
  commit,
  mulberry32,
  newSalt,
  playSecret,
  restockPlan,
  rollBuySecret,
  rollSellSecret,
  rollWholesaleSecret,
  traderRoute,
  type Holdings,
  type Merchant,
  type MerchantSecret,
  type PlayerMemory,
  type Reason,
  BUYS_PER_WINDOW,
  BUY_WINDOW_MS,
  advanceFor,
  repaymentFor,
  owedOn,
  tradingFloat,
  WALKED_WAIT_MS,
} from "@bazaar/core";
import { barterSide, intentsHoldings, readIntentsIdentity, readIntentsVerifier, readSalt, simulateIntents, withdrawBack } from "@bazaar/merchant";
import { explorerTx, readAgents, readDeedAsks, type DeedAsk, readAuctions, readEvent, readTip, readMemory, readOrders, readStalls, type AgentSigner, type AgentView, type Ledger, type OnchainAuction, type OnchainOrder, type OnchainStall } from "@bazaar/merchant";
import type { NewsItem, Store } from "./store.js";

const GOOD_IDS = Object.keys(GOODS);
const DEMAND_MS = 15 * 60_000;
const AGENT_NAME = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));
const short = (id: string) => (AGENT_NAME[id] ?? id).replace(/^Old /, "").split(" ")[0];
const GOOD_VALUES = Object.fromEntries(Object.values(GOODS).map((g) => [g.id, g.baseValue]));
/** Open orders the street aims to have at any time. */
const OPEN_ORDERS_TARGET = 5;
/** Closed orders are pruned from contract storage after this long (their events stay onchain). */
const PRUNE_AFTER_MS = 30 * 60_000;
/** What each agent owes Auntie Wu from an advance (the pay_agent memos onchain are the record). */
const ADVANCES_KEY = "advances";
type Advances = Record<string, { amount: number; at: number; tx: string }>;
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const memLevels = (m: PlayerMemory) => ({ grudge: Math.min(5, m.lowballs), loyalty: Math.min(5, m.deals) });

export interface MarketAgent {
  id: string;
  name: string;
  kind: AgentView["kind"];
  account: string;
  accountUrl: string;
  coins: number;
  stock: Record<string, number>;
  /** Average cost per unit, in coins. */
  costBasis: Record<string, number>;
  dailyCap: number;
  spentToday: number;
  /** For merchants: can a player buy here, and can it buy from a player? */
  status?: "open" | "sold_out" | "broke";
}

export interface MarketOrder extends OnchainOrder {
  customerName: string;
  siteName: string;
  district: string;
  x: number;
  z: number;
  goodName: string;
}

export interface TipSecret {
  id: string;
  informant: string;
  player: string;
  claim: TipClaim;
  salt: string;
  checkMs: number;
  text: string;
}

export class Market {
  private cache: { at: number; agents: MarketAgent[] } | null = null;
  private orderCache: { at: number; orders: MarketOrder[] } | null = null;
  private stallCache: { at: number; stalls: OnchainStall[] } | null = null;
  private auctionCache: { at: number; auctions: OnchainAuction[] } | null = null;
  private eventCache: { at: number; event: StreetEvent | null } | null = null;
  private deedCache: { at: number; asks: DeedAsk[] } | null = null;
  private rng = mulberry32(Date.now() % 2 ** 31);

  constructor(
    private ledger: Ledger,
    private signers: Record<string, AgentSigner>,
    private store: Store,
    /** The NEAR Intents Verifier agents barter through (unset: no barter). */
    private intentsVerifier: string | null = null,
  ) {}

  private accountUrl(account: string) {
    return `https://${this.ledger.network === "testnet" ? "testnet." : ""}nearblocks.io/address/${account}`;
  }

  async agents(maxAgeMs = 3000): Promise<MarketAgent[]> {
    if (this.cache && Date.now() - this.cache.at < maxAgeMs) return this.cache.agents;
    const raw = await readAgents(this.ledger.network, this.ledger.contractId, GOOD_IDS);
    const agents = raw.map((a): MarketAgent => {
      const m = MERCHANTS.find((x) => x.id === a.id);
      const stock = Object.fromEntries(GOOD_IDS.map((g, i) => [g, a.goods[i] ?? 0]));
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        account: a.account,
        accountUrl: this.accountUrl(a.account),
        coins: a.coins,
        stock,
        costBasis: Object.fromEntries(GOOD_IDS.map((g, i) => [g, Math.round((a.cost_basis[i] ?? 0) / 100)])),
        dailyCap: a.daily_cap,
        spentToday: a.spent_today,
        ...(m ? { status: stock[m.goodId] > 0 ? "open" : a.coins < GOODS[m.goodId].baseValue ? "broke" : "sold_out" } : {}),
      };
    });
    this.cache = { at: Date.now(), agents };
    return agents;
  }
  invalidate() {
    this.cache = null;
    this.orderCache = null;
    this.stallCache = null;
    this.auctionCache = null;
    this.eventCache = null;
    this.deedCache = null;
  }

  /** Deeds on the market (v3.11). */
  async deedAsks(maxAgeMs = 3000): Promise<DeedAsk[]> {
    if (this.deedCache && Date.now() - this.deedCache.at < maxAgeMs) return this.deedCache.asks;
    const asks = await readDeedAsks(this.ledger.network, this.ledger.contractId);
    this.deedCache = { at: Date.now(), asks };
    return asks;
  }

  /** Player-owned stalls (v3.3). */
  async stalls(maxAgeMs = 3000): Promise<OnchainStall[]> {
    if (this.stallCache && Date.now() - this.stallCache.at < maxAgeMs) return this.stallCache.stalls;
    const stalls = await readStalls(this.ledger.network, this.ledger.contractId);
    this.stallCache = { at: Date.now(), stalls };
    return stalls;
  }

  /** An agent buys one unit from a player's stall, signing for the price itself. */
  private async buyFromStall(agentId: string, stall: OnchainStall, goodId: string, price: number) {
    const id = `s-${randomUUID()}`;
    await this.signers[agentId].authorizeSpend(id, price);
    const tx = await this.ledger.stallSale!({ saleId: id, slot: stall.slot, goodId });
    this.invalidate();
    return explorerTx(this.ledger.network, tx);
  }

  /** A trader browses the player stalls for a bargain to flip. */
  private async shopStalls(traderId: string) {
    const me = (await this.agents(0)).find((a) => a.id === traderId);
    if (!me) return;
    const budget = Math.min(me.coins, me.dailyCap - me.spentToday);
    for (const st of await this.stalls(0)) {
      for (const l of st.listings) {
        if (l.qty <= 0 || !traderWouldBuy(l.price, GOODS[l.good_id]?.baseValue ?? 0, budget, this.rng)) continue;
        const tx = await this.buyFromStall(traderId, st, l.good_id, l.price);
        await this.say({ kind: "stall", text: `${short(traderId)} bought ${GOODS[l.good_id].name} from a player's stall (${st.slot}) for ${l.price}`, tx, agents: [traderId] });
        return; // one purchase per visit
      }
    }
  }

  /** Delivery orders in contract storage, with where they go. */
  async orders(maxAgeMs = 3000): Promise<MarketOrder[]> {
    if (this.orderCache && Date.now() - this.orderCache.at < maxAgeMs) return this.orderCache.orders;
    const raw = await readOrders(this.ledger.network, this.ledger.contractId);
    const orders = raw.flatMap((o) => {
      const site = siteById(o.site);
      const c = CUSTOMERS.find((x) => x.id === o.customer);
      return site && c ? [{ ...o, customerName: c.name, siteName: site.name, district: site.district, x: site.x, z: site.z, goodName: GOODS[o.good_id]?.name ?? o.good_id }] : [];
    });
    this.orderCache = { at: Date.now(), orders };
    return orders;
  }

  private async holdings(agentId: string, goodId: string): Promise<Holdings> {
    const a = (await this.agents(0)).find((x) => x.id === agentId);
    if (!a) throw new Error(`unknown agent ${agentId}`);
    return { coins: a.coins, stock: a.stock[goodId] ?? 0, costBasis: a.costBasis[goodId] ?? 0 };
  }

  /**
   * Price a player's haggle from the merchant's real purse and shelf.
   * Returns null with a reason when the merchant can't trade (sold out, or too broke to buy).
   */
  async price(merchant: Merchant, side: "sell" | "buy", memory: PlayerMemory): Promise<{ secret: MerchantSecret; escrow?: number; reasons: Reason[] } | { refusal: string }> {
    if (side === "sell") {
      const h = await this.holdings(merchant.id, merchant.goodId);
      if (h.stock <= 0) return { refusal: `${short(merchant.id)} is sold out. A restock is on the way from the docks.` };
      const sales = await this.store.count(`sales:${merchant.id}`);
      return rollSellSecret(this.rng, merchant, GOODS[merchant.goodId], h, sales, memory);
    }
    if ((await this.store.count(`buys:${merchant.id}`)) >= BUYS_PER_WINDOW)
      return { refusal: `${short(merchant.id)} has bought enough ${GOODS[merchant.buysGoodId].name.toLowerCase()} for now. Try again in a few minutes, or sell elsewhere.` };
    const h = await this.holdings(merchant.id, merchant.buysGoodId);
    const p = rollBuySecret(this.rng, merchant, GOODS[merchant.buysGoodId], h, memory);
    if (!p) return { refusal: `${short(merchant.id)} is too broke to buy anything right now.` };
    return p;
  }

  async news(n = 20) {
    return this.store.news(n);
  }
  private async say(item: Omit<NewsItem, "t">) {
    await this.store.pushNews({ t: Date.now(), ...item });
  }

  /** A player's haggle settled: count demand and tell the street. */
  async onPlayerDeal(merchantId: string, side: "sell" | "buy", goodId: string, price: number, closeTx: string | null) {
    this.invalidate();
    if (side === "sell") await this.store.bump(`sales:${merchantId}`, DEMAND_MS);
    else await this.store.bump(`buys:${merchantId}`, BUY_WINDOW_MS);
    await this.say({
      kind: "sale",
      text: side === "sell" ? `A player bought ${GOODS[goodId].name} from ${short(merchantId)} for ${price}` : `${short(merchantId)} bought a player's ${GOODS[goodId].name} for ${price}`,
      tx: closeTx ? explorerTx(this.ledger.network, closeTx) : undefined,
      agents: [merchantId],
    });
  }

  /**
   * One agent-to-agent haggle, committed and settled onchain like a player's:
   * the agent on the other side signs first (authorize_spend), then the server commits the
   * seller's secret, the rules engine plays it out, and the server reveals and settles.
   */
  private async agentHaggle(a: {
    agentId: string;
    seller: Merchant;
    secret: MerchantSecret;
    qty?: number;
    escrow?: number;
    bot: keyof typeof BOTS;
    authorize: number;
    budget?: number;
  }) {
    const id = `a-${randomUUID()}`;
    const signer = this.signers[a.agentId];
    await signer.authorizeSpend(id, a.authorize);
    const salt = newSalt();
    await this.ledger.open({
      haggleId: id,
      player: signer.account,
      side: a.secret.side,
      merchantId: a.seller.id,
      goodId: a.secret.goodId,
      grudge: a.secret.grudge,
      loyalty: a.secret.loyalty,
      commitment: commit(a.secret, salt),
      ...(a.qty ? { qty: a.qty } : {}),
      ...(a.escrow !== undefined ? { escrow: a.escrow } : {}),
    });
    const { state } = playSecret(a.secret, a.seller.personality, BOTS[a.bot], a.budget);
    const price = state.status === "deal" ? state.dealPrice! : null;
    const closeTx = await this.ledger.close({ haggleId: id, secret: a.secret, salt, dealPrice: price, lowballed: state.lowballed });
    this.invalidate();
    return { price, closeUrl: explorerTx(this.ledger.network, closeTx), rounds: state.round };
  }

  /** A buyer that just walked away from a seller doesn't come straight back. */
  private async walkedRecently(buyerId: string, sellerId: string) {
    return (await this.store.count(`walked:${buyerId}:${sellerId}`)) > 0;
  }
  private async walked(buyerId: string, sellerId: string) {
    await this.store.bump(`walked:${buyerId}:${sellerId}`, WALKED_WAIT_MS);
  }

  private async memoryOf(agentId: string, merchantId: string) {
    return readMemory(this.ledger.network, this.ledger.contractId, this.signers[agentId].account, merchantId);
  }

  /** A merchant low on stock buys a lot at the docks and hires the runner to haul it. */
  private async restock(m: Merchant) {
    const me = (await this.agents(0)).find((x) => x.id === m.id)!;
    const good = GOODS[m.goodId];
    const plan = restockPlan(good, { coins: me.coins, stock: me.stock[good.id], costBasis: me.costBasis[good.id] }, me.spentToday, me.dailyCap);
    if (!plan) {
      // Once a day per merchant, whichever replica gets there first: the claim is a store key.
      if (me.stock[good.id] === 0 && me.coins < good.baseValue && (await this.store.lock(`said-closed:${m.id}:${utcDay()}`, 26 * 3_600_000))) {
        await this.say({ kind: "closed", text: `${short(m.id)} is broke and has shuttered the stall. An investor, or Auntie Wu, could reopen it.`, agents: [m.id] });
      }
      return;
    }
    if (await this.walkedRecently(m.id, WHOLESALER.id)) return;
    const lotsToday = await this.store.count(`lots:${good.id}`);
    const { secret } = rollWholesaleSecret(this.rng, WHOLESALER, good, plan.qty, lotsToday);
    Object.assign(secret, memLevels(await this.memoryOf(m.id, WHOLESALER.id)));
    const r = await this.agentHaggle({ agentId: m.id, seller: WHOLESALER, secret, qty: plan.qty, bot: "sharp", authorize: plan.maxSpend, budget: plan.maxSpend });
    if (r.price === null) {
      await this.walked(m.id, WHOLESALER.id);
      await this.say({ kind: "restock", text: `${short(m.id)} haggled with Auntie Wu over ${plan.qty} ${good.name} but walked away`, tx: r.closeUrl, agents: [m.id, WHOLESALER.id] });
      return;
    }
    await this.store.bump(`lots:${good.id}`, 24 * 3_600_000);
    await this.say({
      kind: "restock",
      text: `${short(m.id)} bought ${plan.qty} ${good.name} from Auntie Wu for ${r.price} (${Math.round(r.price / plan.qty)} each)`,
      tx: r.closeUrl,
      agents: [m.id, WHOLESALER.id],
    });
    const hireTx = await this.signers[m.id].payAgent("lo", plan.runnerFee, `haul ${plan.qty} ${good.id} from Pier 34`);
    this.invalidate();
    await this.say({ kind: "hire", text: `${short(m.id)} paid Little Lo ${plan.runnerFee} to haul the lot from Pier 34`, tx: explorerTx(this.ledger.network, hireTx), agents: [m.id, "lo"] });
  }

  /** A rival trader sells what it holds to whoever wants it, or buys something to flip. */
  private async trade(traderId: string) {
    const agents = await this.agents(0);
    const me = agents.find((a) => a.id === traderId)!;
    const def = AGENTS.find((a) => a.id === traderId)!;
    const held = Object.entries(me.stock).find(([, n]) => n > 0);
    if (held) {
      const [goodId] = held;
      const buyer = MERCHANTS.find((m) => m.buysGoodId === goodId)!;
      const b = agents.find((a) => a.id === buyer.id)!;
      if ((await this.store.count(`buys:${buyer.id}`)) >= BUYS_PER_WINDOW || (await this.walkedRecently(traderId, buyer.id))) return;
      // A merchant buys from a trader only out of what it can spare: the coins for its next lot stay
      // put. (Farrukh spent an advance on four lamps on 12 Nov and couldn't restock his rugs.)
      const spare = Math.max(0, b.coins - tradingFloat({ kind: "merchant", goodId: buyer.goodId }));
      const p = rollBuySecret(this.rng, buyer, GOODS[goodId], { coins: spare, stock: b.stock[goodId], costBasis: 0 }, await this.memoryOf(traderId, buyer.id));
      if (!p) return;
      const r = await this.agentHaggle({ agentId: traderId, seller: buyer, secret: p.secret, escrow: p.escrow, bot: "seller", authorize: 1 });
      if (r.price !== null) await this.store.bump(`buys:${buyer.id}`, BUY_WINDOW_MS);
      else await this.walked(traderId, buyer.id);
      await this.say({
        kind: "trade",
        text: r.price === null ? `${short(traderId)} couldn't get a price from ${short(buyer.id)} for a ${GOODS[goodId].name}` : `${short(traderId)} sold a ${GOODS[goodId].name} to ${short(buyer.id)} for ${r.price}`,
        tx: r.closeUrl,
        agents: [traderId, buyer.id],
      });
      return;
    }
    const stock = Object.fromEntries(agents.filter((a) => a.kind === "merchant").map((a) => [a.id, a.stock[MERCHANTS.find((m) => m.id === a.id)!.goodId]]));
    const route = traderRoute(MERCHANTS, GOODS, stock, me.coins - me.spentToday > 0 ? Math.min(me.coins, me.dailyCap - me.spentToday) : 0, this.rng);
    if (!route) return;
    const seller = MERCHANTS.find((m) => m.id === route.buyFrom)!;
    if (await this.walkedRecently(traderId, seller.id)) return;
    const s = agents.find((a) => a.id === seller.id)!;
    const good = GOODS[route.goodId];
    const priced = rollSellSecret(this.rng, seller, good, { coins: s.coins, stock: s.stock[good.id], costBasis: s.costBasis[good.id] }, await this.store.count(`sales:${seller.id}`), await this.memoryOf(traderId, seller.id));
    const budget = Math.min(me.coins, Math.round(good.baseValue * 1.25));
    const r = await this.agentHaggle({ agentId: traderId, seller, secret: priced.secret, bot: (def.bot ?? "splitter") as keyof typeof BOTS, authorize: budget, budget });
    if (r.price !== null) await this.store.bump(`sales:${seller.id}`, DEMAND_MS);
    else await this.walked(traderId, seller.id);
    await this.say({
      kind: "trade",
      text: r.price === null ? `${short(traderId)} haggled with ${short(seller.id)} over a ${good.name} and walked` : `${short(traderId)} bought a ${good.name} from ${short(seller.id)} for ${r.price}, to flip to ${short(route.sellTo)}`,
      tx: r.closeUrl,
      agents: [traderId, seller.id],
    });
  }

  /**
   * NEAR Intents barter: a merchant that ran out of the good it uses trades some of its own stock
   * with Auntie Wu. Both goods go into the Intents Verifier for each agent's own identity, each
   * agent signs its side (token_diff + mt_withdraw) with its own key, and the server relays one
   * execute_intents that settles both or neither. Anything left in the Verifier after a failure is
   * swept back to the agents (each withdraws its own balance in its own transaction).
   */
  private async barter() {
    const verifier = await this.verifierReady();
    if (!verifier) return;
    // A previous barter didn't finish, or a periodic check: return anything left in the Verifier.
    if ((await this.store.getJSON("intents-pending")) || this.rng() < 0.02) {
      await this.sweepIntents(verifier);
      return;
    }
    const agents = await this.agents(0);
    const wu = agents.find((a) => a.id === WHOLESALER.id);
    if (!wu || !(await this.canBarter(WHOLESALER.id))) return;
    const candidates = [];
    for (const m of MERCHANTS) {
      const me = agents.find((a) => a.id === m.id);
      const q = me && barterQuote({ sells: m.goodId, uses: m.buysGoodId }, { sells: me.stock[m.goodId] ?? 0, uses: me.stock[m.buysGoodId] ?? 0 }, wu.stock[m.buysGoodId] ?? 0, GOOD_VALUES);
      if (q && (await this.canBarter(m.id))) candidates.push({ m, q });
    }
    const pick = pickBarter(candidates, this.rng);
    if (!pick) return;
    const { m, q } = pick;
    const mine = this.signers[m.id]!, wus = this.signers[WHOLESALER.id]!;
    const game = this.ledger.contractId, net = this.ledger.network;
    await this.store.putJSON("intents-pending", { agents: [m.id, WHOLESALER.id] }, 24 * 3_600_000);
    try {
      await this.ledger.intentsDeposit!({ agentId: m.id, goodId: q.give.good, qty: q.give.qty });
      await this.ledger.intentsDeposit!({ agentId: WHOLESALER.id, goodId: q.get.good, qty: q.get.qty });
      // A deposit the Verifier refused still "succeeds" (it's refunded): check both actually landed.
      const [hm, hw] = await Promise.all([
        intentsHoldings(net, verifier, game, mine.intentsIdentity()!, [q.give.good]),
        intentsHoldings(net, verifier, game, wus.intentsIdentity()!, [q.get.good]),
      ]);
      if ((hm[q.give.good] ?? 0) < q.give.qty || (hw[q.get.good] ?? 0) < q.get.qty) throw new Error("a deposit didn't reach the Verifier");
      const saltHex = await readSalt(net, verifier);
      const signed = [
        await mine.signIntents({ verifier, saltHex, intents: barterSide(game, q.give, q.get, mine.account, "bazaar barter") }),
        await wus.signIntents({ verifier, saltHex, intents: barterSide(game, q.get, q.give, wus.account, "bazaar barter") }),
      ];
      await simulateIntents(net, verifier, signed);
      const tx = await this.ledger.executeIntents!(verifier, signed);
      this.invalidate();
      await this.say({
        kind: "barter",
        text: `${short(m.id)} bartered ${q.give.qty} ${GOODS[q.give.good].name} for ${q.get.qty} ${GOODS[q.get.good].name} with Auntie Wu, settled through NEAR Intents`,
        tx: explorerTx(net, tx),
        agents: [m.id, WHOLESALER.id],
      });
    } catch (e) {
      console.warn(`barter ${m.id}:`, (e as Error).message);
      return; // "intents-pending" stays set: the next barter step sweeps
    }
    // Settled, but a withdraw inside it can fail on its own: sweep anything left before clearing.
    await this.sweepIntents(verifier);
  }

  /** The Verifier the contract has registered, once it matches what this server was told to use. */
  private verifierCache: { at: number; v: string | null } | null = null;
  private async verifierReady(): Promise<string | null> {
    if (!this.intentsVerifier || !this.ledger.intentsDeposit || !this.ledger.executeIntents) return null;
    if (!this.verifierCache || Date.now() - this.verifierCache.at > 10 * 60_000) {
      const onchain = await readIntentsVerifier(this.ledger.network, this.ledger.contractId).catch(() => null);
      this.verifierCache = { at: Date.now(), v: onchain === this.intentsVerifier ? onchain : null };
      if (onchain !== this.intentsVerifier) console.warn(`intents: contract has verifier ${onchain}, server expects ${this.intentsVerifier}; barter off`);
    }
    return this.verifierCache.v;
  }

  /** An agent can barter only if its key is here and is the identity the contract registered for it. */
  private identityOk = new Map<string, boolean>();
  private async canBarter(agentId: string): Promise<boolean> {
    if (this.identityOk.has(agentId)) return this.identityOk.get(agentId)!;
    const mine = this.signers[agentId]?.intentsIdentity() ?? null;
    const registered = mine ? await readIntentsIdentity(this.ledger.network, this.ledger.contractId, agentId).catch(() => undefined) : null;
    if (registered === undefined) return false; // couldn't ask; try again next tick
    const ok = !!mine && registered === mine;
    if (!ok) console.warn(`intents: ${agentId} key identity ${mine} ≠ registered ${registered}; it won't barter`);
    this.identityOk.set(agentId, ok);
    return ok;
  }

  /** Withdraw every barter agent's goods left in the Verifier back to its game account, one agent per transaction. */
  private async sweepIntents(verifier: string) {
    const game = this.ledger.contractId, net = this.ledger.network;
    let clean = true;
    for (const id of [WHOLESALER.id, ...MERCHANTS.map((m) => m.id)]) {
      const signer = this.signers[id];
      const ident = signer?.intentsIdentity();
      if (!signer || !ident) continue;
      try {
        const held = Object.entries(await intentsHoldings(net, verifier, game, ident, GOOD_IDS)).filter(([, n]) => n > 0);
        if (!held.length) continue;
        const saltHex = await readSalt(net, verifier);
        const signed = await signer.signIntents({ verifier, saltHex, intents: held.flatMap(([g, n]) => withdrawBack(game, g, n, signer.account)) });
        await this.ledger.executeIntents!(verifier, [signed]);
        console.log(`intents sweep: returned ${held.map(([g, n]) => `${n} ${g}`).join(", ")} to ${id}`);
        this.invalidate();
      } catch (e) {
        clean = false;
        console.warn(`intents sweep ${id}:`, (e as Error).message);
      }
    }
    if (clean) await this.store.putJSON("intents-pending", null, 1000);
  }

  /** Merchants and customers use up some of what they bought, so they keep wanting it. */
  private async consume() {
    for (const c of CUSTOMERS) {
      const me = (await this.agents(0)).find((a) => a.id === c.id);
      const held = me && Object.entries(me.stock).find(([, n]) => n > 0);
      if (held && this.rng() < 0.4) {
        const tx = await this.ledger.consume!({ agentId: c.id, goodId: held[0], qty: 1 });
        this.invalidate();
        await this.say({ kind: "consume", text: `${c.name} put a ${GOODS[held[0]].name} to use`, tx: explorerTx(this.ledger.network, tx), agents: [c.id] });
      }
    }
    for (const m of MERCHANTS) {
      const me = (await this.agents(0)).find((a) => a.id === m.id)!;
      if ((me.stock[m.buysGoodId] ?? 0) > 0 && this.rng() < 0.35) {
        const tx = await this.ledger.consume!({ agentId: m.id, goodId: m.buysGoodId, qty: 1 });
        this.invalidate();
        await this.say({ kind: "consume", text: `${short(m.id)} put a ${GOODS[m.buysGoodId].name} to use`, tx: explorerTx(this.ledger.network, tx), agents: [m.id] });
      }
    }
  }

  /**
   * A customer buys one unit from the merchant who sells that good, in a signed agent haggle
   * like any trader's. This is how customer income reaches the street without players.
   */
  private async customerBuys(customerId: string, goodId: string, why: string): Promise<boolean> {
    const agents = await this.agents(0);
    const me = agents.find((a) => a.id === customerId);
    const seller = MERCHANTS.find((m) => m.goodId === goodId);
    const s = seller && agents.find((a) => a.id === seller.id);
    const c = CUSTOMERS.find((x) => x.id === customerId);
    if (!me || !seller || !s || !c || !this.signers[customerId]) return false;
    if (await this.walkedRecently(customerId, seller.id)) return false;
    const held = Object.values(me.stock).reduce((a, b) => a + b, 0);
    const good = GOODS[goodId];
    const plan = customerShopping({ coins: me.coins, held, capLeft: me.dailyCap - me.spentToday }, good, s.stock[goodId] ?? 0, this.rng);
    if (!plan) return false;
    const priced = rollSellSecret(this.rng, seller, good, { coins: s.coins, stock: s.stock[goodId], costBasis: s.costBasis[goodId] }, await this.store.count(`sales:${seller.id}`), await this.memoryOf(customerId, seller.id));
    const r = await this.agentHaggle({ agentId: customerId, seller, secret: priced.secret, bot: "splitter", authorize: plan.budget, budget: plan.budget });
    if (r.price !== null) await this.store.bump(`sales:${seller.id}`, DEMAND_MS);
    else await this.walked(customerId, seller.id);
    await this.say({
      kind: "trade",
      text: r.price === null ? `${c.name} haggled with ${short(seller.id)} over a ${good.name} and walked` : `${c.name} ${why} and bought a ${good.name} from ${short(seller.id)} for ${r.price}`,
      tx: r.closeUrl,
      agents: [customerId, seller.id],
    });
    return r.price !== null;
  }

  /**
   * Customers keep the order board stocked: expire what's overdue, prune old closed orders, and
   * post new ones (each customer at most one open order), topping up from daily income first.
   */
  private async customers() {
    const now = Date.now();
    const orders = await this.orders(0);
    for (const o of orders.filter((x) => x.status === "open" && x.deadline_ms < now - 5000)) {
      const tx = await this.ledger.expireOrder!(o.id);
      // Nobody delivered: buy it from a player's stall instead, if one has it within the bounty.
      const stalls = await this.stalls(0);
      const pick = stalls.flatMap((st) => st.listings.filter((l) => l.good_id === o.good_id && l.qty > 0 && customerWouldBuy(l.price, o.bounty)).map((l) => ({ st, l })))
        .sort((a, b) => a.l.price - b.l.price)[0];
      if (pick) {
        try {
          const stx = await this.buyFromStall(o.customer, pick.st, o.good_id, pick.l.price);
          await this.say({ kind: "stall", text: `${o.customerName} gave up on a courier and bought ${o.goodName} from a player's stall for ${pick.l.price}`, tx: stx, agents: [o.customer] });
          continue;
        } catch (e) {
          console.warn("customer stall purchase:", (e as Error).message);
        }
      }
      // No player's stall has it either: walk to the bazaar and haggle with the merchant.
      try {
        if (await this.customerBuys(o.customer, o.good_id, "gave up on a courier")) continue;
      } catch (e) {
        console.warn("customer bazaar purchase:", (e as Error).message);
      }
      await this.say({ kind: "closed", text: `${o.customerName} gave up waiting for ${o.goodName}`, tx: explorerTx(this.ledger.network, tx), agents: [o.customer] });
    }
    const stale = orders.filter((x) => x.status !== "open" && x.posted_ms < now - PRUNE_AFTER_MS).map((x) => x.id);
    if (stale.length) await this.ledger.pruneOrders!(stale);

    const open = orders.filter((x) => x.status === "open" && x.deadline_ms >= now);
    const idle = CUSTOMERS.filter((c) => !open.some((o) => o.customer === c.id));
    const boost = bountyMultiplier(await this.event());
    for (let n = open.length; n < OPEN_ORDERS_TARGET && idle.length; n++) {
      const c = idle.splice(Math.floor(this.rng() * idle.length), 1)[0];
      const t = orderTerms(this.rng, c, GOOD_VALUES);
      t.bounty = Math.round(t.bounty * boost);
      const me = (await this.agents(0)).find((a) => a.id === c.id);
      if (!me) continue;
      if (me.coins < t.bounty) {
        try {
          await this.ledger.payIncome!({ agentId: c.id, amount: Math.max(t.bounty - me.coins, 100) });
          this.invalidate();
        } catch {
          continue; // this customer's income is spent for today
        }
      }
      const id = `o-${Date.now().toString(36)}-${c.id}`;
      const tx = await this.signers[c.id].postOrder({ orderId: id, goodId: t.goodId, bounty: t.bounty, deadlineMs: Date.now() + t.windowMs, site: t.siteId, express: t.express });
      this.invalidate();
      await this.say({
        kind: "order",
        text: `${c.name} (${siteById(t.siteId)!.name}) wants ${GOODS[t.goodId].name}${t.express ? ", express" : ""}: pays ${t.bounty}`,
        tx: explorerTx(this.ledger.network, tx),
        agents: [c.id],
      });
    }
  }

  /** A player delivered (called by the server after fulfil_order settles). */
  async onDelivered(o: MarketOrder, fare: number, mode: string, tx: string) {
    this.invalidate();
    await this.say({
      kind: "delivery",
      text: `A courier delivered ${o.goodName} to ${o.customerName} for ${o.bounty}${fare ? ` (${mode} fare ${fare} to Checker Cab Co.)` : ""}`,
      tx: explorerTx(this.ledger.network, tx),
      agents: [o.customer, ...(fare ? ["cab"] : [])],
    });
  }

  // ---------- cargo ship auctions at Pier 34 ----------

  /** Recent auctions, newest first (v3.7). */
  async auctions(maxAgeMs = 3000): Promise<OnchainAuction[]> {
    if (this.auctionCache && Date.now() - this.auctionCache.at < maxAgeMs) return this.auctionCache.auctions;
    const auctions = await readAuctions(this.ledger.network, this.ledger.contractId);
    this.auctionCache = { at: Date.now(), auctions };
    return auctions;
  }

  /**
   * Agents that might bid on a lot: Auntie Wu, the merchants, and the rival traders. Each agent
   * decides once per lot, and one agent failing doesn't stop the others.
   */
  private async agentBids(a: OnchainAuction) {
    const agents = await this.agents(0);
    for (const def of AGENTS.filter((x) => ["wholesaler", "merchant", "trader"].includes(x.kind))) {
      const me = agents.find((x) => x.id === def.id);
      const signer = this.signers[def.id];
      const flag = `bidded:${a.id}:${def.id}`;
      if (!me || !signer || a.bids.some((b) => b.bidder === signer.account) || (await this.store.getJSON(flag))) continue;
      await this.store.putJSON(flag, 1, 3_600_000);
      const capLeft = me.dailyCap - me.spentToday;
      const amount = agentBid(
        { kind: def.kind, sells: MERCHANTS.find((m) => m.id === def.id)?.goodId, stock: me.stock[a.good_id] ?? 0, coins: me.coins, capLeft },
        { goodId: a.good_id, qty: a.qty, reserve: a.reserve, baseValue: GOOD_VALUES[a.good_id] ?? 0 },
        this.rng,
      );
      if (amount === null) continue;
      // Deposits are hidden while bidding is open, but vary them anyway: anywhere from the usual
      // round figure up to the agent's headroom.
      const room = Math.min(me.coins, capLeft);
      const base = Math.min(depositFor(amount, a.reserve, me.coins), room);
      const deposit = base + Math.floor(this.rng() * Math.max(0, room - base) * 0.5);
      const salt = newSalt();
      const bidId = `b-${randomUUID()}`;
      try {
        // The salt is the agent's secret until the reveal; it waits in the store, never onchain.
        await this.store.putJSON(`bid:${a.id}:${def.id}`, { amount, salt }, 3_600_000);
        await signer.authorizeSpend(bidId, deposit);
        const tx = await this.ledger.commitBid!({ auctionId: a.id, bidId, bidder: signer.account, commitment: bidCommitment(a.id, signer.account, amount, salt), deposit });
        this.invalidate();
        await this.say({ kind: "auction", text: `${short(def.id)} sealed a bid on the ${GOODS[a.good_id].name} lot`, tx: explorerTx(this.ledger.network, tx), agents: [def.id] });
      } catch (e) {
        // An authorization nothing used stays counted against the agent's cap until tomorrow.
        console.error(`harbour bid ${def.id}:`, (e as Error).message);
      }
    }
  }

  /** Agents open their sealed bids once bidding has closed. */
  private async agentReveals(a: OnchainAuction) {
    for (const b of a.bids.filter((x) => x.agent && x.amount === null)) {
      const id = Object.keys(this.signers).find((k) => this.signers[k].account === b.bidder);
      const sealed = id ? await this.store.getJSON<{ amount: number; salt: string }>(`bid:${a.id}:${id}`) : null;
      if (!sealed) continue;
      try {
        await this.ledger.revealBid!({ auctionId: a.id, bidder: b.bidder, amount: sealed.amount, salt: sealed.salt });
        this.invalidate();
      } catch (e) {
        console.error(`harbour reveal ${id}:`, (e as Error).message);
      }
    }
  }

  /**
   * The harbour, run every few seconds (one replica at a time): dock a ship when one is due, have
   * the agents bid and reveal, and settle a lot when its reveal window closes.
   */
  async harbour() {
    await this.resolveTips().catch((e) => console.error("rumours:", (e as Error).message));
    await this.streetEvents().catch((e) => console.error("events:", (e as Error).message));
    const now = Date.now();
    const recent = await this.auctions(0);
    for (const a of recent.filter((x) => x.status === "bidding")) {
      try {
        if (now < a.bids_close_ms - 20_000) {
          // Agents sit on their hands for a moment, so a player gets a chance to bid first.
          if (now >= a.opened_ms + 25_000) await this.agentBids(a);
        } else if (now >= a.bids_close_ms && now < a.reveal_close_ms) {
          await this.agentReveals(a);
        } else if (now >= a.reveal_close_ms + 2000) {
          const tx = await this.ledger.settleAuction!(a.id);
          this.invalidate();
          const done = (await this.auctions(0)).find((x) => x.id === a.id);
          const good = GOODS[a.good_id].name;
          const who = done?.winner ? (AGENTS.find((d) => this.signers[d.id]?.account === done.winner)?.name ?? "A player") : null;
          await this.say({
            kind: "auction",
            text: who ? `${who} won ${a.qty} ${good} at the Pier 34 auction for ${done!.price}` : `Nobody met the reserve on ${a.qty} ${good}. The ship sailed on.`,
            tx: explorerTx(this.ledger.network, tx),
            agents: [],
          });
        }
      } catch (e) {
        console.error(`harbour ${a.id}:`, (e as Error).message);
      }
    }
    const last = recent[0]?.opened_ms ?? 0;
    if (recent.some((x) => x.status === "bidding") || now < last + SHIP_GAP_MS + 5000) return;
    const id = `ship-${now.toString(36)}`;
    const tx = await this.ledger.shipArrives!(id);
    this.invalidate();
    const a = (await this.auctions(0)).find((x) => x.id === id);
    if (a)
      await this.say({
        kind: "auction",
        text: `A cargo ship docked at Pier 34 with ${a.qty} ${GOODS[a.good_id].name}. Sealed bids close in ${Math.round((a.bids_close_ms - a.opened_ms) / 60_000 * 10) / 10} min (reserve ${a.reserve}).`,
        tx: explorerTx(this.ledger.network, tx),
        agents: [],
      });
  }

  // ---------- the rumour network ----------

  /** Change the pending-tips list under a short lock, so a sale and a resolve never overwrite each other. */
  private async editPending(f: (ids: string[]) => string[]) {
    for (let i = 0; i < 20; i++) {
      const token = await this.store.lock("tips-pending", 10_000);
      if (!token) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      try {
        const ids = (await this.store.getJSON<string[]>("tips:pending")) ?? [];
        await this.store.putJSON("tips:pending", f(ids).slice(-200), 24 * 3_600_000);
        return;
      } finally {
        await this.store.unlock("tips-pending", token);
      }
    }
    throw new Error("the tips list is busy");
  }

  /**
   * Remember a tip's claim and salt (server-side only) until its check time. Called before the
   * sale goes onchain, so a crash can't leave a sold tip that nobody can reveal.
   */
  async rememberTip(t: TipSecret) {
    await this.store.putJSON(`tip:${t.id}`, t, 2 * 3_600_000);
    await this.editPending((ids) => [...ids.filter((x) => x !== t.id), t.id]);
  }
  async forgetTip(id: string) {
    await this.editPending((ids) => ids.filter((x) => x !== id));
    await this.store.del(`tip:${id}`);
  }
  async setTipText(id: string, text: string) {
    const t = await this.tipSecret(id);
    if (t) await this.store.putJSON(`tip:${id}`, { ...t, text }, 2 * 3_600_000);
  }

  /** What a player was told, for their own tips. */
  async tipSecret(id: string) {
    return this.store.getJSON<TipSecret>(`tip:${id}`);
  }

  /** Reveal every tip whose check time has come; the contract checks it against real stock. */
  private async resolveTips() {
    const pending = (await this.store.getJSON<string[]>("tips:pending")) ?? [];
    if (!pending.length) return;
    const now = Date.now();
    const done: string[] = [];
    for (const id of pending) {
      const t = await this.tipSecret(id);
      if (!t) {
        done.push(id);
        continue;
      }
      if (now < t.checkMs + 1500) continue;
      try {
        if (now >= t.checkMs + TIP_RESOLVE_WINDOW_MS) await this.ledger.expireTip!(id);
        else {
          const tx = await this.ledger.resolveTip!({ tipId: id, claim: t.claim, salt: t.salt });
          const inf = informantById(t.informant);
          // Report what the contract decided, not a fresh read of the stock.
          const onchain = await readTip(this.ledger.network, this.ledger.contractId, id).catch(() => null);
          const how = onchain?.status === "false" ? "was a lie: the buyer got their money back" : onchain?.status === "void" ? "didn't count: the buyer traded with the merchant" : "came true";
          await this.say({
            kind: "rumour",
            text: `${inf?.name ?? t.informant}'s tip about ${short(t.claim.agent_id)}'s ${GOODS[t.claim.good_id]?.name ?? t.claim.good_id} ${how}`,
            tx: explorerTx(this.ledger.network, tx),
            agents: [t.claim.agent_id],
          });
        }
        this.invalidate();
        done.push(id);
      } catch (e) {
        const m = (e as Error).message;
        console.error(`rumour ${id}:`, m);
        if (/already resolved|unknown tip/.test(m)) done.push(id);
      }
    }
    // Tips sold meanwhile were added to the list; only take out what was handled here.
    if (done.length) await this.editPending((ids) => ids.filter((x) => !done.includes(x)));
  }

  // ---------- street events ----------

  /** The current or most recent street event (v3.10). */
  async event(maxAgeMs = 3000): Promise<StreetEvent | null> {
    if (this.eventCache && Date.now() - this.eventCache.at < maxAgeMs) return this.eventCache.event;
    const event = await readEvent(this.ledger.network, this.ledger.contractId).catch(() => null);
    this.eventCache = { at: Date.now(), event };
    return event;
  }

  /** Start the next event when one is due; the contract decides what it is. */
  private async streetEvents() {
    const last = await this.event(0);
    if (last && Date.now() < last.start_ms + EVENT_GAP_MS + 5000) return;
    const tx = await this.ledger.startEvent!(`ev-${Date.now().toString(36)}`);
    this.invalidate();
    const e = await this.event(0);
    if (e) await this.say({ kind: "event", text: eventHeadline(e, (g) => GOODS[g]?.name ?? g), tx: explorerTx(this.ledger.network, tx), agents: [] });
  }

  async advances(): Promise<Advances> {
    return (await this.store.getJSON<Advances>(ADVANCES_KEY)) ?? {};
  }

  /**
   * The watchdog's relief: Auntie Wu advances coins to agents that have been broke too long,
   * signing pay_agent with her own key (her onchain daily cap applies). Returns what she paid.
   */
  async relieve(ids: string[]): Promise<{ id: string; amount: number; tx: string }[]> {
    const paid: { id: string; amount: number; tx: string }[] = [];
    if (!this.signers[WHOLESALER.id]) return paid;
    // Stalls first: Wu's daily cap covers only a few advances, and a shut stall stops the street.
    const stallsFirst = [...ids].sort((a, b) => Number(MERCHANTS.some((m) => m.id === b)) - Number(MERCHANTS.some((m) => m.id === a)));
    for (const id of stallsFirst) {
      const agents = await this.agents(0);
      const wu = agents.find((a) => a.id === WHOLESALER.id);
      const me = agents.find((a) => a.id === id);
      if (!wu || !me) continue;
      const owed = owedOn((await this.advances())[id], Date.now());
      const m = MERCHANTS.find((x) => x.id === id);
      const d = advanceFor({ id, kind: me.kind, coins: me.coins, goodId: m?.goodId, owed }, { coins: wu.coins, spentToday: wu.spentToday, dailyCap: wu.dailyCap });
      if ("skip" in d) {
        console.log(`relief ${id}: ${d.skip}`);
        continue;
      }
      const tx = await this.signers[WHOLESALER.id].payAgent(id, d.amount, m ? `advance against ${short(id)}'s next lot` : `advance to ${short(id)}`);
      this.invalidate();
      const url = explorerTx(this.ledger.network, tx);
      await this.store.putJSON(ADVANCES_KEY, { ...(await this.advances()), [id]: { amount: d.amount, at: Date.now(), tx: url } }, 30 * 86_400_000);
      await this.say({
        kind: "invest",
        text: m ? `Auntie Wu advanced ${short(id)} ${d.amount} coins against the next lot of ${GOODS[m.goodId].name}` : `Auntie Wu staked ${short(id)} ${d.amount} coins to get trading again`,
        tx: url,
        agents: [WHOLESALER.id, id],
      });
      paid.push({ id, amount: d.amount, tx: url });
    }
    return paid;
  }

  /** Agents back on their feet repay Auntie Wu's advance in full, each signing its own payment. */
  private async repayAdvances() {
    const owed = await this.advances();
    for (const [id, loan] of Object.entries(owed)) {
      if (!owedOn(loan, Date.now())) continue; // written off
      const me = (await this.agents(0)).find((a) => a.id === id);
      if (!me || !this.signers[id]) continue;
      const amount = repaymentFor({ id, kind: me.kind, coins: me.coins, goodId: MERCHANTS.find((x) => x.id === id)?.goodId, owed: loan.amount, spentToday: me.spentToday, dailyCap: me.dailyCap });
      if (amount === null) continue;
      const tx = await this.signers[id].payAgent(WHOLESALER.id, amount, `repay Auntie Wu's advance`);
      this.invalidate();
      const rest = { ...(await this.advances()) };
      delete rest[id];
      await this.store.putJSON(ADVANCES_KEY, rest, 30 * 86_400_000);
      await this.say({ kind: "invest", text: `${short(id)} paid Auntie Wu back the ${amount} coins she advanced`, tx: explorerTx(this.ledger.network, tx), agents: [id, WHOLESALER.id] });
    }
  }

  /** One round of the agents acting on their own. Errors are logged, never thrown. */
  async tick() {
    const step = async (name: string, f: () => Promise<void>) => {
      try {
        await f();
      } catch (e) {
        // near-kit puts the useful part (NotEnoughAllowance, a panic) in `data`, not the message.
        const x = e as Error & { code?: string; data?: unknown; panic?: string };
        const detail = x.panic ?? (x.data !== undefined ? JSON.stringify(x.data).slice(0, 300) : "");
        console.error(`market ${name}:`, x.message, x.code ?? "", detail);
      }
    };
    for (const m of MERCHANTS) await step(`restock ${m.id}`, () => this.restock(m));
    await step("repay", () => this.repayAdvances());
    await step("consume", () => this.consume());
    await step("customers", () => this.customers());
    await step("barter", () => this.barter());
    if (this.rng() < WALK_IN_CHANCE) {
      const c = CUSTOMERS[Math.floor(this.rng() * CUSTOMERS.length)];
      const m = MERCHANTS[Math.floor(this.rng() * MERCHANTS.length)];
      await step(`walk-in ${c.id}`, async () => void (await this.customerBuys(c.id, m.goodId, "walked into the bazaar")));
    }
    const traders = AGENTS.filter((a) => a.kind === "trader");
    const ev = await this.event();
    if (tradersLieLow(ev)) {
      // Once per raid. Traders skip haggling on Canal Street, but still shop at licensed stalls.
      if (!(await this.store.getJSON(`lielow:${ev!.id}`))) {
        await this.store.putJSON(`lielow:${ev!.id}`, 1, 3_600_000);
        await this.say({ kind: "event", text: "Ivy and Rex are lying low while the inspectors walk Canal Street", agents: traders.map((t) => t.id) });
      }
    } else {
      const t = traders[Math.floor(this.rng() * traders.length)];
      if (t && this.rng() < 0.6) await step(`trade ${t.id}`, () => this.trade(t.id));
    }
    const shopper = traders[Math.floor(this.rng() * traders.length)];
    if (shopper) await step(`stalls ${shopper.id}`, () => this.shopStalls(shopper.id));
  }
}
