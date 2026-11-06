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
 * - Writes a news feed of what happened, with the transaction behind each line.
 */
import { randomUUID } from "node:crypto";
import {
  AGENTS,
  BOTS,
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
import { explorerTx, readAgents, readMemory, type AgentSigner, type AgentView, type Ledger } from "@bazaar/merchant";
import type { NewsItem, Store } from "./store.js";

const GOOD_IDS = Object.keys(GOODS);
const DEMAND_MS = 15 * 60_000;
const AGENT_NAME = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));
const short = (id: string) => (AGENT_NAME[id] ?? id).replace(/^Old /, "").split(" ")[0];
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

export class Market {
  private cache: { at: number; agents: MarketAgent[] } | null = null;
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
    const traders = AGENTS.filter((a) => a.kind === "trader");
    const t = traders[Math.floor(this.rng() * traders.length)];
    if (t && this.rng() < 0.6) await step(`trade ${t.id}`, () => this.trade(t.id));
  }
}
