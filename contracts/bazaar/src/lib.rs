//! # Bazaar of Liars — fair-play contract (v3: Canal Street's agent economy)
//!
//! Every haggle is a commit-reveal:
//! 1. `open_haggle`: before the first message, the game server posts
//!    `sha256("bazaar-v2|side|merchant|good|limit|need|seed|listPrice|grudge|loyalty|salt")`.
//!    The contract checks that `grudge` / `loyalty` (what the merchant remembers about this
//!    player) match its own records, and escrows what's being traded: the merchant's goods
//!    when it sells, the player's good and the merchant's coins when it buys.
//! 2. `close_haggle`: when the haggle ends (deal or not) the server reveals the secret + salt.
//!    The contract recomputes the hash and rejects any mismatch. On a deal it also checks the
//!    limit: a merchant selling never goes below its floor, a merchant buying never pays above
//!    its ceiling. Only then do coins and goods move between the two accounts.
//! 3. `expire_haggle`: if the server never reveals, anyone can expire the haggle after
//!    `REVEAL_WINDOW_BLOCKS` (escrows are returned); it's counted publicly in `stats().unrevealed`.
//!
//! ## Agents (v3)
//! Merchants, the wholesaler, rival traders and the runner are agents with their own NEAR
//! accounts. Their coins and stock live here, keyed by those accounts, so every sale pays the
//! merchant itself. Each agent's policy is enforced here, not trusted to the server:
//! - an agent spends only after it signs `authorize_spend` (or `pay_agent`) with its own key,
//!   and never more than its `daily_cap` in a UTC day;
//! - a merchant never sells below what its stock cost it (its running cost basis);
//! - a merchant buying from a player can only pay out of coins escrowed from its own purse.
//!
//! The agents' keys are function-call keys for this contract only: they can't move NEAR.
//!
//! The commitment preimage MUST stay byte-identical to `packages/core/src/secrets.ts`.

use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};

/// Coins a player gets the first time they open a haggle.
pub const STARTER_COINS: u64 = 200;
/// ~1 hour of testnet blocks. After this an unrevealed haggle can be expired by anyone.
pub const REVEAL_WINDOW_BLOCKS: u64 = 3_600;
/// Memory levels saturate here (matches the rules engine).
pub const MEMORY_CAP: u32 = 5;
/// Leaderboard size.
pub const TOP_N: usize = 10;
/// Most units in one lot.
pub const MAX_QTY: u32 = 20;
const COMMIT_DOMAIN: &str = "bazaar-v2";
const DAY_MS: u64 = 86_400_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Haggles,
    Coins,
    Goods,
    Memory,
    Agents,
    AgentByAccount,
    CostBasis,
    Auths,
    Investments,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Open,
    Deal,
    NoDeal,
    Expired,
}

/// "sell": the merchant sells to the player. "buy": the merchant buys from the player.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Sell,
    Buy,
}

impl Side {
    fn as_str(self) -> &'static str {
        match self {
            Side::Sell => "sell",
            Side::Buy => "buy",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Merchant,
    Wholesaler,
    Trader,
    Runner,
}

/// The merchant's hidden hand. Field names match the TypeScript `MerchantSecret`.
/// `floor` is the merchant's limit: the lowest it sells for, or the highest it buys for.
/// For a lot (`qty` > 1) it's the limit for the whole lot.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub side: Side,
    pub merchant_id: String,
    pub good_id: String,
    pub floor: u32,
    pub need: String,
    pub seed: u32,
    pub list_price: u32,
    pub grudge: u32,
    pub loyalty: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Haggle {
    /// The merchant's counterpart: a player, or an agent (a trader, or a merchant at the docks).
    pub player: AccountId,
    pub side: Side,
    pub merchant_id: String,
    pub good_id: String,
    /// Units traded (1 at a stall, a lot at the docks).
    pub qty: u32,
    /// Coins locked from the merchant's purse while it's buying.
    pub escrow: u64,
    pub grudge: u32,
    pub loyalty: u32,
    pub commitment: String,
    pub opened_block: u64,
    pub status: Status,
    pub price: Option<u32>,
    /// Public once the haggle closes.
    pub secret: Option<Secret>,
    pub salt: Option<String>,
}

/// What a merchant remembers about a player.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Memory {
    pub lowballs: u32,
    pub deals: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LeaderEntry {
    pub player: AccountId,
    /// The most coins this player has ever held.
    pub peak: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub account: AccountId,
    pub kind: AgentKind,
    /// Most coins it may commit in one UTC day.
    pub daily_cap: u64,
    pub spent_day: u64,
    pub spent_today: u64,
}

/// A spend an agent signed for one haggle.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Auth {
    pub agent: AccountId,
    pub max: u64,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub id: String,
    pub name: String,
    pub account: AccountId,
    pub kind: AgentKind,
    pub coins: u64,
    /// Units held of each requested good, in order.
    pub goods: Vec<u32>,
    /// Average coins paid per unit of each requested good, in hundredths.
    pub cost_basis: Vec<u64>,
    pub daily_cap: u64,
    pub spent_today: u64,
}

#[near(serializers = [json])]
pub struct Stats {
    pub server: AccountId,
    pub haggles: u64,
    pub deals: u64,
    pub no_deals: u64,
    /// Haggles the server never revealed. Should always be 0.
    pub unrevealed: u64,
}

#[near(serializers = [json])]
pub struct PlayerState {
    /// False until the player's first haggle (which grants `STARTER_COINS`).
    pub known: bool,
    pub coins: u64,
    /// Count of each requested good, in the order asked.
    pub goods: Vec<u32>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bazaar {
    owner: AccountId,
    /// The game server: the only account that can open and close haggles.
    server: AccountId,
    haggles: LookupMap<String, Haggle>,
    coins: LookupMap<AccountId, u64>,
    /// "account#good" → count
    goods: LookupMap<String, u32>,
    /// "player#merchant" → memory
    memory: LookupMap<String, Memory>,
    /// Top players (and traders) by peak coins, best first. Peaks only rise, so this is exact.
    leaders: Vec<LeaderEntry>,
    haggle_count: u64,
    deals: u64,
    no_deals: u64,
    unrevealed: u64,
    agents: LookupMap<String, Agent>,
    agent_ids: Vec<String>,
    agent_by_account: LookupMap<AccountId, String>,
    /// "account#good" → average cost per unit, in hundredths of a coin
    cost_basis: LookupMap<String, u64>,
    /// haggle id → the spend an agent signed for it
    auths: LookupMap<String, Auth>,
    /// "player#agent" → coins invested
    investments: LookupMap<String, u64>,
}

/// sha256 of the canonical preimage, lowercase hex.
pub fn commitment_of(s: &Secret, salt: &str) -> String {
    let preimage = format!(
        "{COMMIT_DOMAIN}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        s.side.as_str(),
        s.merchant_id,
        s.good_id,
        s.floor,
        s.need,
        s.seed,
        s.list_price,
        s.grudge,
        s.loyalty,
        salt
    );
    hex(&env::sha256(preimage.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Ids are `[a-z0-9_-]{1,64}`. Crucially no `|`, so preimage fields can't be shifted
/// into each other to forge a matching hash with a different limit.
fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let log = json!({ "standard": "bazaar", "version": "3.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn goods_key(account: &AccountId, good: &str) -> String {
    format!("{account}#{good}")
}
fn memory_key(player: &AccountId, merchant: &str) -> String {
    format!("{player}#{merchant}")
}
fn today() -> u64 {
    env::block_timestamp_ms() / DAY_MS
}

#[near]
impl Bazaar {
    #[init]
    pub fn new(server: AccountId) -> Self {
        Self {
            owner: env::predecessor_account_id(),
            server,
            haggles: LookupMap::new(StorageKey::Haggles),
            coins: LookupMap::new(StorageKey::Coins),
            goods: LookupMap::new(StorageKey::Goods),
            memory: LookupMap::new(StorageKey::Memory),
            leaders: Vec::new(),
            haggle_count: 0,
            deals: 0,
            no_deals: 0,
            unrevealed: 0,
            agents: LookupMap::new(StorageKey::Agents),
            agent_ids: Vec::new(),
            agent_by_account: LookupMap::new(StorageKey::AgentByAccount),
            cost_basis: LookupMap::new(StorageKey::CostBasis),
            auths: LookupMap::new(StorageKey::Auths),
            investments: LookupMap::new(StorageKey::Investments),
        }
    }

    fn require_server(&self) {
        require!(env::predecessor_account_id() == self.server, "only the game server can do this");
    }
    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    /// Owner only: rotate the server account.
    pub fn set_server(&mut self, server: AccountId) {
        self.require_owner();
        self.server = server;
    }

    #[allow(clippy::too_many_arguments)]
    /// Owner only: give an agent its account, policy and opening stock. `stock` is
    /// (good, units, cost per unit in coins). Re-registering updates the name and cap only.
    pub fn register_agent(&mut self, id: String, name: String, account: AccountId, kind: AgentKind, daily_cap: u64, coins: u64, stock: Vec<(String, u32, u32)>) {
        self.require_owner();
        require!(is_id(&id), "agent id must be [a-z0-9_-]{1,64}");
        if let Some(a) = self.agents.get(&id).cloned() {
            require!(a.account == account, "an agent keeps its account");
            self.agents.insert(id, Agent { name, daily_cap, ..a });
            return;
        }
        require!(!self.agent_by_account.contains_key(&account), "account is already an agent");
        self.agents.insert(id.clone(), Agent { id: id.clone(), name: name.clone(), account: account.clone(), kind, daily_cap, spent_day: today(), spent_today: 0 });
        self.agent_ids.push(id.clone());
        self.agent_by_account.insert(account.clone(), id.clone());
        self.set_coins(&account, coins);
        for (good, units, cost) in stock {
            require!(is_id(&good), "good id must be [a-z0-9_-]{1,64}");
            self.add_goods(&account, &good, i64::from(units));
            self.cost_basis.insert(goods_key(&account, &good), u64::from(cost) * 100);
        }
        emit("agent_registered", json!({ "id": id, "name": name, "account": account, "kind": kind, "daily_cap": daily_cap, "coins": coins }));
    }

    fn agent(&self, id: &str) -> Agent {
        self.agents.get(id).cloned().unwrap_or_else(|| env::panic_str("unknown agent"))
    }
    fn agent_of(&self, account: &AccountId) -> Option<Agent> {
        self.agent_by_account.get(account).and_then(|id| self.agents.get(id).cloned())
    }

    /// Count `amount` against the agent's daily cap (negative releases an unused reservation).
    fn charge_cap(&mut self, id: &str, amount: i64) {
        let mut a = self.agent(id);
        let day = today();
        if a.spent_day != day {
            a.spent_day = day;
            a.spent_today = 0;
        }
        let next = a.spent_today as i64 + amount;
        require!(next <= a.daily_cap as i64, "over the agent's daily spending cap");
        a.spent_today = next.max(0) as u64;
        self.agents.insert(id.to_string(), a);
    }

    fn add_goods(&mut self, account: &AccountId, good: &str, delta: i64) {
        let key = goods_key(account, good);
        let have = i64::from(self.goods.get(&key).copied().unwrap_or(0));
        let next = have + delta;
        require!(next >= 0, "player doesn't have that good");
        self.goods.insert(key, next as u32);
    }

    fn add_coins(&mut self, account: &AccountId, delta: i64) {
        let have = self.coins_of(account.clone()) as i64;
        let next = have + delta;
        require!(next >= 0, "not enough coins");
        self.set_coins(account, next as u64);
    }

    fn set_coins(&mut self, account: &AccountId, coins: u64) {
        self.coins.insert(account.clone(), coins);
        // Leaderboard of peak purses: players and rival traders, not shopkeepers.
        if self.agent_of(account).is_some_and(|a| a.kind != AgentKind::Trader) {
            return;
        }
        if let Some(e) = self.leaders.iter_mut().find(|e| &e.player == account) {
            if coins <= e.peak {
                return;
            }
            e.peak = coins;
        } else if self.leaders.len() < TOP_N || coins > self.leaders.last().map(|e| e.peak).unwrap_or(0) {
            self.leaders.push(LeaderEntry { player: account.clone(), peak: coins });
        } else {
            return;
        }
        self.leaders.sort_by(|a, b| b.peak.cmp(&a.peak));
        self.leaders.truncate(TOP_N);
    }

    // ---------- agents spend with their own keys ----------

    /// Signed by an agent's own account: allow the game server to spend up to `max` coins of
    /// this agent's purse in one haggle (a trader at a stall, a merchant restocking at the docks).
    pub fn authorize_spend(&mut self, haggle_id: String, max: u64) {
        let who = env::predecessor_account_id();
        let a = self.agent_of(&who).unwrap_or_else(|| env::panic_str("only an agent can authorize its own spending"));
        require!(is_id(&haggle_id), "haggle_id must be [a-z0-9_-]{1,64}");
        require!(!self.haggles.contains_key(&haggle_id) && !self.auths.contains_key(&haggle_id), "haggle_id already used");
        require!(max > 0 && max <= self.coins_of(who.clone()), "can't authorize more than the agent holds");
        self.charge_cap(&a.id, max as i64);
        self.auths.insert(haggle_id.clone(), Auth { agent: who.clone(), max });
        emit("spend_authorized", json!({ "haggle_id": haggle_id, "agent": a.id, "max": max }));
    }

    /// Signed by an agent's own account: pay another agent (hiring a runner, say).
    pub fn pay_agent(&mut self, to: String, amount: u64, memo: String) {
        let who = env::predecessor_account_id();
        let from = self.agent_of(&who).unwrap_or_else(|| env::panic_str("only an agent can pay from its purse"));
        let to_agent = self.agent(&to);
        require!(amount > 0 && memo.len() <= 140, "amount must be positive, memo at most 140 chars");
        self.charge_cap(&from.id, amount as i64);
        self.add_coins(&who, -(amount as i64));
        self.add_coins(&to_agent.account, amount as i64);
        emit("agent_paid", json!({ "from": from.id, "to": to, "amount": amount, "memo": memo }));
    }

    /// Server, for a player: invest coins in an agent (say, a merchant that's gone broke).
    pub fn invest(&mut self, player: AccountId, agent_id: String, amount: u64) {
        self.require_server();
        require!(self.agent_of(&player).is_none(), "agents don't invest");
        let a = self.agent(&agent_id);
        require!(amount > 0, "amount must be positive");
        self.add_coins(&player, -(amount as i64));
        self.add_coins(&a.account, amount as i64);
        let key = memory_key(&player, &agent_id);
        let total = self.investments.get(&key).copied().unwrap_or(0) + amount;
        self.investments.insert(key, total);
        emit("invested", json!({ "player": player, "agent": agent_id, "amount": amount, "total": total }));
    }

    /// Server: a merchant uses up a good it bought (so it wants another one later).
    pub fn consume(&mut self, agent_id: String, good_id: String, qty: u32) {
        self.require_server();
        let a = self.agent(&agent_id);
        self.add_goods(&a.account, &good_id, -i64::from(qty));
        emit("consumed", json!({ "agent": agent_id, "good_id": good_id, "qty": qty }));
    }

    // ---------- haggles ----------

    /// Post the commitment. Must happen before the first message.
    /// `qty` defaults to 1. `escrow` is required when the merchant buys: the coins locked from
    /// its purse, at least its committed ceiling.
    #[allow(clippy::too_many_arguments)]
    pub fn open_haggle(
        &mut self,
        haggle_id: String,
        player: AccountId,
        side: Side,
        merchant_id: String,
        good_id: String,
        grudge: u32,
        loyalty: u32,
        commitment: String,
        qty: Option<u32>,
        escrow: Option<u64>,
    ) {
        self.require_server();
        require!(is_id(&haggle_id), "haggle_id must be [a-z0-9_-]{1,64}");
        require!(is_id(&merchant_id) && is_id(&good_id), "merchant_id/good_id must be [a-z0-9_-]{1,64}");
        require!(is_lower_hex(&commitment, 64), "commitment must be 64 lowercase hex chars");
        require!(!self.haggles.contains_key(&haggle_id), "haggle_id already used");
        let qty = qty.unwrap_or(1);
        require!((1..=MAX_QTY).contains(&qty), "qty must be 1..=20");
        let merchant = self.agent(&merchant_id);
        require!(matches!(merchant.kind, AgentKind::Merchant | AgentKind::Wholesaler), "only merchants and the wholesaler haggle");
        require!(merchant.account != player, "an agent can't haggle with itself");

        // An agent on the other side must have signed for this spend itself.
        if self.agent_of(&player).is_some() {
            let auth = self.auths.get(&haggle_id).cloned().unwrap_or_else(|| env::panic_str("the agent hasn't authorized this spend"));
            require!(auth.agent == player, "authorization is from a different agent");
        } else if !self.coins.contains_key(&player) {
            self.set_coins(&player, STARTER_COINS);
        }

        // The merchant's memory is ours, not the server's to invent.
        let mem = self.memory_of(player.clone(), merchant_id.clone());
        require!(
            grudge == mem.lowballs.min(MEMORY_CAP) && loyalty == mem.deals.min(MEMORY_CAP),
            "grudge/loyalty don't match the merchant's onchain memory"
        );

        let mut locked = 0;
        match side {
            Side::Sell => {
                require!(self.coins_of(player.clone()) > 0, "player has no coins");
                // The merchant's goods wait here until the deal.
                let have = self.goods_of(merchant.account.clone(), good_id.clone());
                require!(have >= qty, "the merchant is sold out");
                self.add_goods(&merchant.account, &good_id, -i64::from(qty));
            }
            Side::Buy => {
                require!(qty == 1, "players sell one unit at a time");
                self.add_goods(&player, &good_id, -1);
                locked = escrow.unwrap_or_else(|| env::panic_str("a buying merchant must escrow coins"));
                require!(locked > 0, "escrow must be positive");
                require!(self.coins_of(merchant.account.clone()) >= locked, "the merchant can't afford to buy");
                self.add_coins(&merchant.account, -(locked as i64));
            }
        }

        self.haggles.insert(
            haggle_id.clone(),
            Haggle {
                player: player.clone(),
                side,
                merchant_id: merchant_id.clone(),
                good_id: good_id.clone(),
                qty,
                escrow: locked,
                grudge,
                loyalty,
                commitment: commitment.clone(),
                opened_block: env::block_height(),
                status: Status::Open,
                price: None,
                secret: None,
                salt: None,
            },
        );
        self.haggle_count += 1;
        emit(
            "haggle_opened",
            json!({ "haggle_id": haggle_id, "player": player, "side": side, "merchant_id": merchant_id, "good_id": good_id, "qty": qty, "escrow": locked, "commitment": commitment }),
        );
    }

    /// Reveal the secret. `deal_price = Some(p)` settles a trade; `None` closes with no deal.
    /// `lowballed` updates the merchant's memory of this player.
    /// Panics (and nothing moves) unless the reveal matches the commitment and the deal
    /// respects every limit: the merchant's committed floor or ceiling, the no-loss rule,
    /// the buyer's purse, and an agent buyer's signed maximum.
    pub fn close_haggle(&mut self, haggle_id: String, secret: Secret, salt: String, deal_price: Option<u32>, lowballed: bool) {
        self.require_server();
        let mut h = self.haggles.get(&haggle_id).cloned().unwrap_or_else(|| env::panic_str("unknown haggle"));
        require!(h.status == Status::Open, "haggle already closed");
        require!(is_lower_hex(&salt, 32), "salt must be 32 lowercase hex chars");
        require!(is_id(&secret.need), "need must be [a-z0-9_-]{1,64}");
        require!(
            secret.side == h.side && secret.merchant_id == h.merchant_id && secret.good_id == h.good_id,
            "secret is for a different side, merchant or good"
        );
        require!(secret.grudge == h.grudge && secret.loyalty == h.loyalty, "secret's memory differs from the one checked at open");
        require!(commitment_of(&secret, &salt) == h.commitment, "reveal does not match the commitment");

        let player = h.player.clone();
        let merchant = self.agent(&h.merchant_id);
        let buyer_agent = self.agent_of(&player);
        let auth = self.auths.remove(&haggle_id);
        match (h.side, deal_price) {
            (Side::Sell, Some(price)) => {
                require!(price >= secret.floor, "deal price is below the merchant's committed floor");
                // No-loss rule: the committed floor covers what the stock cost the merchant.
                let basis = self.cost_basis.get(&goods_key(&merchant.account, &h.good_id)).copied().unwrap_or(0);
                require!(u64::from(secret.floor) * 100 >= basis * u64::from(h.qty), "the merchant's floor is below its cost");
                let balance = self.coins_of(player.clone());
                require!(balance >= u64::from(price), "player can't afford this price");
                if let (Some(a), Some(auth)) = (&buyer_agent, &auth) {
                    require!(u64::from(price) <= auth.max, "price is above what the agent authorized");
                    self.charge_cap(&a.id, u64::from(price) as i64 - auth.max as i64);
                    // The buyer's running cost basis for what it now holds.
                    let key = goods_key(&player, &h.good_id);
                    let held = u64::from(self.goods_of(player.clone(), h.good_id.clone()));
                    let old = self.cost_basis.get(&key).copied().unwrap_or(0);
                    let next = (old * held + u64::from(price) * 100) / (held + u64::from(h.qty));
                    self.cost_basis.insert(key, next);
                }
                self.add_coins(&player, -i64::from(price));
                self.add_coins(&merchant.account, i64::from(price));
                self.add_goods(&player, &h.good_id, i64::from(h.qty));
            }
            (Side::Sell, None) => {
                if let (Some(a), Some(auth)) = (&buyer_agent, &auth) {
                    self.charge_cap(&a.id, -(auth.max as i64));
                }
                self.add_goods(&merchant.account, &h.good_id, i64::from(h.qty));
            }
            (Side::Buy, Some(price)) => {
                // An agent selling signed for this haggle; selling spends nothing, so release the reservation.
                if let (Some(a), Some(auth)) = (&buyer_agent, &auth) {
                    self.charge_cap(&a.id, -(auth.max as i64));
                }
                require!(price <= secret.floor, "deal price is above the merchant's committed ceiling");
                require!(u64::from(price) <= h.escrow, "deal price is above the merchant's escrow");
                self.add_coins(&player, i64::from(price));
                self.add_coins(&merchant.account, h.escrow as i64 - i64::from(price));
                self.add_goods(&merchant.account, &h.good_id, 1);
            }
            (Side::Buy, None) => {
                if let (Some(a), Some(auth)) = (&buyer_agent, &auth) {
                    self.charge_cap(&a.id, -(auth.max as i64));
                }
                self.add_goods(&player, &h.good_id, 1);
                self.add_coins(&merchant.account, h.escrow as i64);
            }
        }
        if deal_price.is_some() {
            h.status = Status::Deal;
            h.price = deal_price;
            self.deals += 1;
        } else {
            h.status = Status::NoDeal;
            self.no_deals += 1;
        }

        let key = memory_key(&player, &h.merchant_id);
        let mut mem = self.memory.get(&key).copied().unwrap_or_default();
        mem.lowballs += u32::from(lowballed);
        mem.deals += u32::from(deal_price.is_some());
        self.memory.insert(key, mem);

        emit(
            "haggle_closed",
            json!({ "haggle_id": haggle_id, "player": player, "merchant_id": h.merchant_id, "side": h.side, "good_id": h.good_id, "qty": h.qty, "status": h.status, "price": h.price, "limit": secret.floor, "need": secret.need }),
        );
        h.secret = Some(secret);
        h.salt = Some(salt);
        self.haggles.insert(haggle_id, h);
    }

    /// Anyone: expire a haggle the server never revealed. Counted against the server forever.
    pub fn expire_haggle(&mut self, haggle_id: String) {
        let mut h = self.haggles.get(&haggle_id).cloned().unwrap_or_else(|| env::panic_str("unknown haggle"));
        require!(h.status == Status::Open, "haggle already closed");
        require!(env::block_height() >= h.opened_block + REVEAL_WINDOW_BLOCKS, "reveal window still open");
        let merchant = self.agent(&h.merchant_id);
        match h.side {
            Side::Sell => self.add_goods(&merchant.account, &h.good_id, i64::from(h.qty)),
            Side::Buy => {
                let (p, g) = (h.player.clone(), h.good_id.clone());
                self.add_goods(&p, &g, 1);
                self.add_coins(&merchant.account, h.escrow as i64);
            }
        }
        if let Some((a, auth)) = self.auths.remove(&haggle_id).and_then(|auth| self.agent_of(&auth.agent).map(|a| (a, auth))) {
            self.charge_cap(&a.id, -(auth.max as i64));
        }
        h.status = Status::Expired;
        self.haggles.insert(haggle_id.clone(), h);
        self.unrevealed += 1;
        emit("haggle_expired", json!({ "haggle_id": haggle_id }));
    }

    // ---------- views ----------

    pub fn get_haggle(&self, haggle_id: String) -> Option<Haggle> {
        self.haggles.get(&haggle_id).cloned()
    }

    pub fn coins_of(&self, player: AccountId) -> u64 {
        self.coins.get(&player).copied().unwrap_or(0)
    }

    pub fn goods_of(&self, player: AccountId, good_id: String) -> u32 {
        self.goods.get(&goods_key(&player, &good_id)).copied().unwrap_or(0)
    }

    pub fn memory_of(&self, player: AccountId, merchant_id: String) -> Memory {
        self.memory.get(&memory_key(&player, &merchant_id)).copied().unwrap_or_default()
    }

    pub fn invested(&self, player: AccountId, agent_id: String) -> u64 {
        self.investments.get(&memory_key(&player, &agent_id)).copied().unwrap_or(0)
    }

    /// Everything the game UI needs about a player in one call. At most 16 goods.
    pub fn player_state(&self, player: AccountId, good_ids: Vec<String>) -> PlayerState {
        require!(good_ids.len() <= 16, "at most 16 goods");
        PlayerState {
            known: self.coins.contains_key(&player),
            coins: self.coins_of(player.clone()),
            goods: good_ids.into_iter().map(|g| self.goods_of(player.clone(), g)).collect(),
        }
    }

    /// Every agent's purse, stock and policy. At most 16 goods.
    pub fn agents(&self, good_ids: Vec<String>) -> Vec<AgentView> {
        require!(good_ids.len() <= 16, "at most 16 goods");
        let day = today();
        self.agent_ids
            .iter()
            .filter_map(|id| self.agents.get(id))
            .map(|a| AgentView {
                id: a.id.clone(),
                name: a.name.clone(),
                account: a.account.clone(),
                kind: a.kind,
                coins: self.coins_of(a.account.clone()),
                goods: good_ids.iter().map(|g| self.goods_of(a.account.clone(), g.clone())).collect(),
                cost_basis: good_ids.iter().map(|g| self.cost_basis.get(&goods_key(&a.account, g)).copied().unwrap_or(0)).collect(),
                daily_cap: a.daily_cap,
                spent_today: if a.spent_day == day { a.spent_today } else { 0 },
            })
            .collect()
    }

    pub fn leaderboard(&self) -> Vec<LeaderEntry> {
        self.leaders.clone()
    }

    pub fn stats(&self) -> Stats {
        Stats { server: self.server.clone(), haggles: self.haggle_count, deals: self.deals, no_deals: self.no_deals, unrevealed: self.unrevealed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(caller: &str, block: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(caller)).block_height(block).block_timestamp(block * 1_000_000_000).build());
    }

    const SALT: &str = "00112233445566778899aabbccddeeff";

    fn sell_secret() -> Secret {
        Secret { side: Side::Sell, merchant_id: "farrukh".into(), good_id: "rug".into(), floor: 52, need: "rent_due".into(), seed: 7, list_price: 80, grudge: 0, loyalty: 0 }
    }
    fn buy_secret() -> Secret {
        Secret { side: Side::Buy, merchant_id: "zaria".into(), good_id: "rug".into(), floor: 70, need: "restocking".into(), seed: 9, list_price: 40, grudge: 0, loyalty: 0 }
    }

    fn setup() -> Bazaar {
        ctx("owner.testnet", 100);
        let mut c = Bazaar::new(acc("server.testnet"));
        let stock = |g: &str, n: u32, cost: u32| vec![(g.to_string(), n, cost)];
        c.register_agent("farrukh".into(), "Old Farrukh".into(), acc("farrukh.testnet"), AgentKind::Merchant, 400, 100, stock("rug", 3, 40));
        c.register_agent("zaria".into(), "Zaria".into(), acc("zaria.testnet"), AgentKind::Merchant, 400, 200, stock("saffron", 3, 20));
        c.register_agent("wu".into(), "Auntie Wu".into(), acc("wu.testnet"), AgentKind::Wholesaler, 0, 0, stock("rug", 100, 0));
        c.register_agent("ivy".into(), "Ivy".into(), acc("ivy.testnet"), AgentKind::Trader, 150, 300, vec![]);
        c.register_agent("lo".into(), "Little Lo".into(), acc("lo.testnet"), AgentKind::Runner, 50, 0, vec![]);
        ctx("server.testnet", 100);
        c
    }

    fn farrukh() -> AccountId {
        acc("farrukh.testnet")
    }

    fn player() -> AccountId {
        acc("player.testnet")
    }

    fn open(c: &mut Bazaar, id: &str, s: &Secret) {
        let escrow = (s.side == Side::Buy).then_some(80);
        c.open_haggle(id.into(), player(), s.side, s.merchant_id.clone(), s.good_id.clone(), s.grudge, s.loyalty, commitment_of(s, SALT), None, escrow);
    }

    /// Buy a rug from Farrukh at 60, so the player has something to sell.
    fn buy_rug(c: &mut Bazaar, id: &str) {
        let s = sell_secret();
        open(c, id, &s);
        c.close_haggle(id.into(), s, SALT.into(), Some(60), false);
    }

    #[test]
    fn commitment_matches_typescript() {
        ctx("x.testnet", 1);
        // Vectors from packages/core commit() (see core.test.ts).
        assert_eq!(commitment_of(&sell_secret(), SALT), "407317eee375123b66094f34a115fc6ce18bebb5051b02da3bf9637bb8bfc716");
        assert_eq!(commitment_of(&buy_secret(), SALT), "3f5829091774f4e6bae193be28c7b402e0bfc653e8b98121d24c05c40459c1f3");
    }

    #[test]
    fn fair_purchase_settles_and_reveals() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        let h = c.get_haggle("h1".into()).unwrap();
        assert_eq!(h.status, Status::Deal);
        assert_eq!(h.secret, Some(sell_secret()));
        assert_eq!(c.coins_of(player()), STARTER_COINS - 60);
        assert_eq!(c.goods_of(player(), "rug".into()), 1);
        assert_eq!(c.memory_of(player(), "farrukh".into()), Memory { lowballs: 0, deals: 1 });
        // The sale paid Farrukh's own account and came off his shelf.
        assert_eq!(c.coins_of(farrukh()), 160);
        assert_eq!(c.goods_of(farrukh(), "rug".into()), 2);
        assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("haggle_closed")));
    }

    #[test]
    fn selling_escrows_the_good_and_pays_the_player() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        let s = buy_secret();
        open(&mut c, "h2", &s);
        assert_eq!(c.goods_of(player(), "rug".into()), 0, "escrowed while haggling");
        c.close_haggle("h2".into(), s, SALT.into(), Some(68), false);
        assert_eq!(c.coins_of(player()), STARTER_COINS - 60 + 68);
        assert_eq!(c.goods_of(player(), "rug".into()), 0);
        // Zaria paid out of her own purse (escrow 80, refund 12) and now holds the rug.
        assert_eq!(c.coins_of(acc("zaria.testnet")), 200 - 68);
        assert_eq!(c.goods_of(acc("zaria.testnet"), "rug".into()), 1);
        assert!(c.leaderboard().contains(&LeaderEntry { player: player(), peak: STARTER_COINS + 8 }));
    }

    #[test]
    fn no_sale_returns_the_escrowed_good() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        let s = buy_secret();
        open(&mut c, "h2", &s);
        c.close_haggle("h2".into(), s, SALT.into(), None, true);
        assert_eq!(c.goods_of(player(), "rug".into()), 1);
        assert_eq!(c.memory_of(player(), "zaria".into()), Memory { lowballs: 1, deals: 0 });
        assert_eq!(c.coins_of(acc("zaria.testnet")), 200, "escrow returned");
    }

    #[test]
    #[should_panic(expected = "doesn't have that good")]
    fn cannot_sell_what_you_dont_own() {
        let mut c = setup();
        open(&mut c, "h1", &buy_secret());
    }

    #[test]
    #[should_panic(expected = "above the merchant's committed ceiling")]
    fn merchant_never_pays_above_its_ceiling() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        let s = buy_secret();
        open(&mut c, "h2", &s);
        c.close_haggle("h2".into(), s, SALT.into(), Some(71), false);
    }

    #[test]
    #[should_panic(expected = "below the merchant's committed floor")]
    fn rejects_price_below_floor() {
        let mut c = setup();
        let s = sell_secret();
        open(&mut c, "h1", &s);
        c.close_haggle("h1".into(), s, SALT.into(), Some(51), false);
    }

    #[test]
    #[should_panic(expected = "does not match the commitment")]
    fn rejects_a_changed_floor() {
        let mut c = setup();
        let s = sell_secret();
        open(&mut c, "h1", &s);
        c.close_haggle("h1".into(), Secret { floor: 40, ..s }, SALT.into(), Some(45), false);
    }

    #[test]
    #[should_panic(expected = "different side")]
    fn rejects_a_switched_side() {
        let mut c = setup();
        let s = sell_secret();
        open(&mut c, "h1", &s);
        c.close_haggle("h1".into(), Secret { side: Side::Buy, ..s }, SALT.into(), Some(45), false);
    }

    #[test]
    #[should_panic(expected = "onchain memory")]
    fn server_cannot_invent_a_grudge() {
        let mut c = setup();
        open(&mut c, "h1", &Secret { grudge: 2, ..sell_secret() });
    }

    #[test]
    fn memory_carries_into_the_next_commitment() {
        let mut c = setup();
        let s = sell_secret();
        open(&mut c, "h1", &s);
        c.close_haggle("h1".into(), s, SALT.into(), None, true);
        // Now the merchant remembers one lowball, and the next haggle must commit to it.
        open(&mut c, "h2", &Secret { grudge: 1, ..sell_secret() });
        assert_eq!(c.get_haggle("h2".into()).unwrap().grudge, 1);
    }

    #[test]
    #[should_panic(expected = "need must be")]
    fn rejects_field_shifting_with_pipes() {
        let mut c = setup();
        let s = sell_secret();
        open(&mut c, "h1", &s);
        c.close_haggle("h1".into(), Secret { need: "rent_due|1".into(), ..s }, SALT.into(), None, false);
    }

    #[test]
    #[should_panic(expected = "only the game server")]
    fn only_server_opens() {
        let mut c = setup();
        ctx("mallory.testnet", 100);
        open(&mut c, "h1", &sell_secret());
    }

    #[test]
    #[should_panic(expected = "only the game server")]
    fn only_server_closes() {
        let mut c = setup();
        let s = sell_secret();
        open(&mut c, "h1", &s);
        ctx("player.testnet", 101);
        c.close_haggle("h1".into(), s, SALT.into(), Some(80), false);
    }

    #[test]
    #[should_panic(expected = "already closed")]
    fn cannot_close_twice() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        c.close_haggle("h1".into(), sell_secret(), SALT.into(), Some(60), false);
    }

    #[test]
    #[should_panic(expected = "already used")]
    fn haggle_ids_are_unique() {
        let mut c = setup();
        open(&mut c, "h1", &sell_secret());
        open(&mut c, "h1", &sell_secret());
    }

    #[test]
    #[should_panic(expected = "can't afford")]
    fn player_must_afford_the_deal() {
        let mut c = setup();
        let s = Secret { floor: 500, list_price: 600, ..sell_secret() };
        open(&mut c, "h1", &s);
        c.close_haggle("h1".into(), s, SALT.into(), Some(500), false);
    }

    #[test]
    fn player_state_tells_new_from_broke() {
        let mut c = setup();
        assert!(!c.player_state(player(), vec!["rug".into()]).known);
        buy_rug(&mut c, "h1");
        let st = c.player_state(player(), vec!["rug".into(), "lamp".into()]);
        assert!(st.known);
        assert_eq!(st.coins, STARTER_COINS - 60);
        assert_eq!(st.goods, vec![1, 0]);
    }

    #[test]
    fn leaderboard_keeps_the_top_peaks() {
        let mut c = setup();
        // Ivy (a rival trader, 300 coins) is ranked alongside players.
        for i in 0..12u64 {
            c.set_coins(&acc(&format!("p{i}.testnet")), 100 + i);
        }
        let lb = c.leaderboard();
        assert_eq!(lb.len(), TOP_N);
        assert_eq!(lb[0], LeaderEntry { player: acc("ivy.testnet"), peak: 300 });
        assert_eq!(lb[1].peak, 111);
        assert_eq!(lb[TOP_N - 1].peak, 103);
        // Spending doesn't lower a peak.
        c.set_coins(&acc("p11.testnet"), 5);
        assert_eq!(c.leaderboard()[1].peak, 111);
    }

    #[test]
    fn unrevealed_haggles_expire_publicly_and_return_escrow() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        open(&mut c, "h2", &buy_secret());
        ctx("anyone.testnet", 100 + REVEAL_WINDOW_BLOCKS);
        c.expire_haggle("h2".into());
        assert_eq!(c.get_haggle("h2".into()).unwrap().status, Status::Expired);
        assert_eq!(c.goods_of(player(), "rug".into()), 1);
        assert_eq!(c.coins_of(acc("zaria.testnet")), 200);
        assert_eq!(c.stats().unrevealed, 1);
    }

    #[test]
    #[should_panic(expected = "reveal window still open")]
    fn cannot_expire_early() {
        let mut c = setup();
        open(&mut c, "h1", &sell_secret());
        ctx("anyone.testnet", 101);
        c.expire_haggle("h1".into());
    }

    // ---------- agents ----------

    fn wholesale_secret(floor: u32) -> Secret {
        Secret { side: Side::Sell, merchant_id: "wu".into(), good_id: "rug".into(), floor, need: "restocking".into(), seed: 1, list_price: floor * 2, grudge: 0, loyalty: 0 }
    }

    /// Farrukh signs for a restock himself, then the server runs the haggle at the docks.
    fn restock(c: &mut Bazaar, id: &str, max: u64, floor: u32, price: Option<u32>) {
        ctx("farrukh.testnet", 100);
        c.authorize_spend(id.into(), max);
        ctx("server.testnet", 100);
        let s = wholesale_secret(floor);
        c.open_haggle(id.into(), farrukh(), Side::Sell, "wu".into(), "rug".into(), 0, 0, commitment_of(&s, SALT), Some(4), None);
        c.close_haggle(id.into(), s, SALT.into(), price, false);
    }

    #[test]
    fn a_merchant_restocks_with_its_own_signature_and_tracks_cost() {
        let mut c = setup();
        restock(&mut c, "w1", 100, 80, Some(90));
        assert_eq!(c.coins_of(farrukh()), 10);
        assert_eq!(c.coins_of(acc("wu.testnet")), 90);
        assert_eq!(c.goods_of(farrukh(), "rug".into()), 7);
        // (3 × 40 + 90) / 7 = 30 coins a unit.
        let v = c.agents(vec!["rug".into()]);
        let f = v.iter().find(|a| a.id == "farrukh").unwrap();
        assert_eq!(f.cost_basis, vec![3000]);
        assert_eq!(f.spent_today, 90, "only what was spent counts against the cap");
    }

    #[test]
    #[should_panic(expected = "hasn't authorized")]
    fn the_server_cannot_spend_an_agents_coins_without_its_signature() {
        let mut c = setup();
        let s = wholesale_secret(80);
        c.open_haggle("w1".into(), farrukh(), Side::Sell, "wu".into(), "rug".into(), 0, 0, commitment_of(&s, SALT), Some(4), None);
    }

    #[test]
    #[should_panic(expected = "above what the agent authorized")]
    fn an_agent_never_pays_past_what_it_signed_for() {
        let mut c = setup();
        restock(&mut c, "w1", 85, 80, Some(90));
    }

    #[test]
    #[should_panic(expected = "daily spending cap")]
    fn agents_respect_their_daily_cap() {
        let mut c = setup();
        ctx("ivy.testnet", 100);
        c.authorize_spend("a1".into(), 100);
        c.authorize_spend("a2".into(), 60);
    }

    #[test]
    #[should_panic(expected = "only an agent")]
    fn only_agents_authorize_spending() {
        let mut c = setup();
        ctx("player.testnet", 100);
        c.authorize_spend("a1".into(), 10);
    }

    #[test]
    #[should_panic(expected = "below its cost")]
    fn a_merchant_never_sells_below_cost() {
        let mut c = setup();
        // Farrukh's rugs cost him 40 each; a floor of 39 is a loss.
        let s = Secret { floor: 39, list_price: 70, ..sell_secret() };
        open(&mut c, "h1", &s);
        c.close_haggle("h1".into(), s, SALT.into(), Some(50), false);
    }

    #[test]
    #[should_panic(expected = "sold out")]
    fn an_empty_shelf_cannot_sell() {
        let mut c = setup();
        for i in 0..4 {
            open(&mut c, &format!("h{i}"), &sell_secret());
        }
    }

    #[test]
    #[should_panic(expected = "can't afford to buy")]
    fn a_broke_merchant_cannot_buy() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        let s = buy_secret();
        c.open_haggle("h2".into(), player(), Side::Buy, "zaria".into(), "rug".into(), 0, 0, commitment_of(&s, SALT), None, Some(500));
    }

    #[test]
    fn hiring_a_runner_pays_it_from_the_merchants_purse() {
        let mut c = setup();
        ctx("farrukh.testnet", 100);
        c.pay_agent("lo".into(), 7, "haul 4 rugs from Pier 34".into());
        assert_eq!(c.coins_of(farrukh()), 93);
        assert_eq!(c.coins_of(acc("lo.testnet")), 7);
        assert!(get_logs().iter().any(|l| l.contains("agent_paid") && l.contains("Pier 34")));
    }

    #[test]
    fn a_trader_buys_at_a_stall_and_makes_the_leaderboard() {
        let mut c = setup();
        ctx("ivy.testnet", 100);
        c.authorize_spend("t1".into(), 70);
        ctx("server.testnet", 100);
        let s = sell_secret();
        c.open_haggle("t1".into(), acc("ivy.testnet"), Side::Sell, "farrukh".into(), "rug".into(), 0, 0, commitment_of(&s, SALT), None, None);
        c.close_haggle("t1".into(), s, SALT.into(), Some(60), false);
        assert_eq!(c.goods_of(acc("ivy.testnet"), "rug".into()), 1);
        assert_eq!(c.coins_of(acc("ivy.testnet")), 240);
        assert!(c.leaderboard().iter().any(|e| e.player == acc("ivy.testnet")));
        assert!(!c.leaderboard().iter().any(|e| e.player == farrukh()), "shopkeepers aren't ranked");
    }

    #[test]
    fn players_can_invest_in_a_merchant() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        c.invest(player(), "farrukh".into(), 40);
        assert_eq!(c.coins_of(player()), STARTER_COINS - 60 - 40);
        assert_eq!(c.coins_of(farrukh()), 200);
        assert_eq!(c.invested(player(), "farrukh".into()), 40);
    }

    #[test]
    fn a_trader_sells_to_a_merchant_only_with_its_own_signature() {
        let mut c = setup();
        // Ivy buys a rug from Farrukh, then sells it to Zaria.
        ctx("ivy.testnet", 100);
        c.authorize_spend("t1".into(), 70);
        ctx("server.testnet", 100);
        let s = sell_secret();
        c.open_haggle("t1".into(), acc("ivy.testnet"), Side::Sell, "farrukh".into(), "rug".into(), 0, 0, commitment_of(&s, SALT), None, None);
        c.close_haggle("t1".into(), s, SALT.into(), Some(60), false);
        ctx("ivy.testnet", 100);
        c.authorize_spend("t2".into(), 1);
        ctx("server.testnet", 100);
        let b = buy_secret();
        c.open_haggle("t2".into(), acc("ivy.testnet"), Side::Buy, "zaria".into(), "rug".into(), 0, 0, commitment_of(&b, SALT), None, Some(80));
        c.close_haggle("t2".into(), b, SALT.into(), Some(68), false);
        assert_eq!(c.coins_of(acc("ivy.testnet")), 300 - 60 + 68);
        assert_eq!(c.goods_of(acc("zaria.testnet"), "rug".into()), 1);
        let ivy = c.agents(vec![]).into_iter().find(|a| a.id == "ivy").unwrap();
        assert_eq!(ivy.spent_today, 60, "selling doesn't count as spending");
    }
}
