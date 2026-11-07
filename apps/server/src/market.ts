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
  TIP_RESOLVE_WINDOW_MS,
  informantById,
  type TipClaim,
  agentBid,
  bidCommitment,
  depositFor,
  CUSTOMERS,
  customerWouldBuy,
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
} from "@bazaar/core";
import { explorerTx, readAgents, readAuctions, readMemory, readOrders, readStalls, type AgentSigner, type AgentView, type Ledger, type OnchainAuction, type OnchainOrder, type OnchainStall } from "@bazaar/merchant";
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

export class Market {
  private cache: { at: number; agents: MarketAgent[] } | null = null;
  private orderCache: { at: number; orders: MarketOrder[] } | null = null;
  private stallCache: { at: number; stalls: OnchainStall[] } | null = null;
  private auctionCache: { at: number; auctions: OnchainAuction[] } | null = null;
  private rng = mulberry32(Date.now() % 2 ** 31);

  constructor(
    private ledger: Ledger,
    private signers: Record<string, AgentSigner>,
    private store: Store,
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

  private async memoryOf(agentId: string, merchantId: string) {
    return readMemory(this.ledger.network, this.ledger.contractId, this.signers[agentId].account, merchantId);
  }

  /** A merchant low on stock buys a lot at the docks and hires the runner to haul it. */
  private async restock(m: Merchant) {
    const me = (await this.agents(0)).find((x) => x.id === m.id)!;
    const good = GOODS[m.goodId];
    const plan = restockPlan(good, { coins: me.coins, stock: me.stock[good.id], costBasis: me.costBasis[good.id] }, me.spentToday, me.dailyCap);
    if (!plan) {
      if (me.stock[good.id] === 0 && me.coins < good.baseValue) {
        await this.say({ kind: "closed", text: `${short(m.id)} is broke and has shuttered the stall. An investor could reopen it.`, agents: [m.id] });
      }
      return;
    }
    const lotsToday = await this.store.count(`lots:${good.id}`);
    const { secret } = rollWholesaleSecret(this.rng, WHOLESALER, good, plan.qty, lotsToday);
    Object.assign(secret, memLevels(await this.memoryOf(m.id, WHOLESALER.id)));
    const r = await this.agentHaggle({ agentId: m.id, seller: WHOLESALER, secret, qty: plan.qty, bot: "sharp", authorize: plan.maxSpend, budget: plan.maxSpend });
    if (r.price === null) {
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
      const p = rollBuySecret(this.rng, buyer, GOODS[goodId], { coins: b.coins, stock: b.stock[goodId], costBasis: 0 }, await this.memoryOf(traderId, buyer.id));
      if (!p) return;
      const r = await this.agentHaggle({ agentId: traderId, seller: buyer, secret: p.secret, escrow: p.escrow, bot: "seller", authorize: 1 });
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
    const s = agents.find((a) => a.id === seller.id)!;
    const good = GOODS[route.goodId];
    const priced = rollSellSecret(this.rng, seller, good, { coins: s.coins, stock: s.stock[good.id], costBasis: s.costBasis[good.id] }, await this.store.count(`sales:${seller.id}`), await this.memoryOf(traderId, seller.id));
    const budget = Math.min(me.coins, Math.round(good.baseValue * 1.25));
    const r = await this.agentHaggle({ agentId: traderId, seller, secret: priced.secret, bot: (def.bot ?? "splitter") as keyof typeof BOTS, authorize: budget, budget });
    if (r.price !== null) await this.store.bump(`sales:${seller.id}`, DEMAND_MS);
    await this.say({
      kind: "trade",
      text: r.price === null ? `${short(traderId)} haggled with ${short(seller.id)} over a ${good.name} and walked` : `${short(traderId)} bought a ${good.name} from ${short(seller.id)} for ${r.price}, to flip to ${short(route.sellTo)}`,
      tx: r.closeUrl,
      agents: [traderId, seller.id],
    });
  }

  /** Merchants use up some of what they bought, so they keep wanting it. */
  private async consume() {
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
      await this.say({ kind: "closed", text: `${o.customerName} gave up waiting for ${o.goodName}`, tx: explorerTx(this.ledger.network, tx), agents: [o.customer] });
    }
    const stale = orders.filter((x) => x.status !== "open" && x.posted_ms < now - PRUNE_AFTER_MS).map((x) => x.id);
    if (stale.length) await this.ledger.pruneOrders!(stale);

    const open = orders.filter((x) => x.status === "open" && x.deadline_ms >= now);
    const idle = CUSTOMERS.filter((c) => !open.some((o) => o.customer === c.id));
    for (let n = open.length; n < OPEN_ORDERS_TARGET && idle.length; n++) {
      const c = idle.splice(Math.floor(this.rng() * idle.length), 1)[0];
      const t = orderTerms(this.rng, c, GOOD_VALUES);
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

  /** A tip sold: remember its claim and salt (server-side only) until its check time. */
  async rememberTip(t: { id: string; informant: string; player: string; claim: TipClaim; salt: string; checkMs: number; text: string }) {
    await this.store.putJSON(`tip:${t.id}`, t, 2 * 3_600_000);
    const pending = (await this.store.getJSON<string[]>("tips:pending")) ?? [];
    await this.store.putJSON("tips:pending", [...pending.filter((x) => x !== t.id), t.id].slice(-200), 24 * 3_600_000);
  }

  /** What a player was told, for their own tips. */
  async tipSecret(id: string) {
    return this.store.getJSON<{ id: string; informant: string; player: string; claim: TipClaim; salt: string; checkMs: number; text: string }>(`tip:${id}`);
  }

  /** Reveal every tip whose check time has come; the contract checks it against real stock. */
  private async resolveTips() {
    const pending = (await this.store.getJSON<string[]>("tips:pending")) ?? [];
    if (!pending.length) return;
    const now = Date.now();
    const left: string[] = [];
    for (const id of pending) {
      const t = await this.tipSecret(id);
      if (!t) continue;
      if (now < t.checkMs + 1500) {
        left.push(id);
        continue;
      }
      try {
        if (now >= t.checkMs + TIP_RESOLVE_WINDOW_MS) await this.ledger.expireTip!(id);
        else {
          const tx = await this.ledger.resolveTip!({ tipId: id, claim: t.claim, salt: t.salt });
          const inf = informantById(t.informant);
          // The outcome is public now; the claim was revealed onchain with it.
          const stock = (await this.agents(0)).find((a) => a.id === t.claim.agent_id)?.stock[t.claim.good_id];
          const holds = stock === undefined ? null : t.claim.at_most ? stock <= t.claim.n : stock >= t.claim.n;
          await this.say({
            kind: "rumour",
            text: `${inf?.name ?? t.informant}'s tip about ${short(t.claim.agent_id)}'s ${GOODS[t.claim.good_id]?.name ?? t.claim.good_id} ${holds === false ? "was a lie: the buyer got their money back" : "came true"}`,
            tx: explorerTx(this.ledger.network, tx),
            agents: [t.claim.agent_id],
          });
        }
        this.invalidate();
      } catch (e) {
        const m = (e as Error).message;
        console.error(`rumour ${id}:`, m);
        if (!/already resolved|unknown tip/.test(m)) left.push(id);
      }
    }
    await this.store.putJSON("tips:pending", left, 24 * 3_600_000);
  }

  /** One round of the agents acting on their own. Errors are logged, never thrown. */
  async tick() {
    const step = async (name: string, f: () => Promise<void>) => {
      try {
        await f();
      } catch (e) {
        console.error(`market ${name}:`, (e as Error).message);
      }
    };
    for (const m of MERCHANTS) await step(`restock ${m.id}`, () => this.restock(m));
    await step("consume", () => this.consume());
    await step("customers", () => this.customers());
    const traders = AGENTS.filter((a) => a.kind === "trader");
    const t = traders[Math.floor(this.rng() * traders.length)];
    if (t && this.rng() < 0.6) await step(`trade ${t.id}`, () => this.trade(t.id));
    const shopper = traders[Math.floor(this.rng() * traders.length)];
    if (shopper) await step(`stalls ${shopper.id}`, () => this.shopStalls(shopper.id));
  }
}
