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
//! ## Delivery orders (v3.1)
//! Customers across Manhattan are agents too. A customer posts an order with its own signature
//! (`post_order`), which locks the bounty from its purse. When a player delivers, the server calls
//! `fulfil_order`: the good moves to the customer, the bounty to the player, and any cab fare to the
//! cab company's account. A missed deadline lets anyone expire the order and refund the bounty.
//!
//! ## Street cred (v3.2)
//! Players earn XP onchain. The contract awards what it can see itself (a deal, a delivery), plus
//! a streak bonus on the first XP of each UTC day. The server may add what only it sees (a caught
//! bluff) through `award_cred`, capped per player per day. Constants match packages/core cred.ts.
//!
//! ## Player stalls (v3.3)
//! At 120 XP (level 3) a player can buy a licence for one of four stall slots. They stock it with
//! goods they own and set prices. Agents buy from it while the player is away, each purchase
//! signed by the buying agent (`authorize_spend`) and settled here: the good goes to the agent,
//! the price (less a 10% street commission, burned) goes to the stall's till. Constants match
//! packages/core stalls.ts.
//!
//! ## Dock work (v3.4)
//! A broke player (fewer than 20 coins) can work one shift a day for the wholesaler. The
//! wholesaler signs for the wage itself (`authorize_spend`), the server calls `pay_wages`, and the
//! contract checks the player is broke and hasn't worked today. No coins are created.
//!
//! ## Goods are NEP-245 multi tokens (v3.5)
//! Every good (rug, saffron, lamp) is a token of this contract, with `mt_balance_of`, `mt_supply`,
//! `mt_token`, `mt_transfer` (1 yoctoNEAR), `mt_batch_transfer`, `mt_transfer_call` and the
//! standard `nep245` mint / burn / transfer events for every movement. Goods in escrow (a haggle in
//! progress, stock on a player's stall) are held by this contract's own account.
//!
//! The commitment preimage MUST stay byte-identical to `packages/core/src/secrets.ts`.

use near_sdk::serde_json::json;
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{AccountId, BorshStorageKey, Gas, PanicOnDefault, PromiseError, PromiseOrValue, env, ext_contract, near, require};

/// NEP-245 receiver interface, for `mt_transfer_call`.
#[ext_contract(ext_mt_receiver)]
pub trait MtReceiver {
    fn mt_on_transfer(&mut self, sender_id: AccountId, previous_owner_ids: Vec<AccountId>, token_ids: Vec<String>, amounts: Vec<U128>, msg: String) -> PromiseOrValue<Vec<U128>>;
}

const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const GAS_FOR_RECEIVER: Gas = Gas::from_tgas(30);

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
    Orders,
    Income,
    Cred,
    ServerXp,
    Stalls,
    Supply,
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
    Customer,
    Cab,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Open,
    Delivered,
    Expired,
}

/// A customer's standing order for one good, delivered to its door.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Order {
    pub id: String,
    pub customer: String,
    pub good_id: String,
    /// Coins locked from the customer's purse, paid on delivery.
    pub bounty: u64,
    /// Block time (ms) after which the order can be expired.
    pub deadline_ms: u64,
    /// Drop site id (see packages/core orders.ts).
    pub site: String,
    pub express: bool,
    pub status: OrderStatus,
    pub posted_ms: u64,
    pub courier: Option<AccountId>,
    pub fare: u64,
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
    pub deliveries: u64,
    /// Coins burned by licence fees and stall commission.
    pub burned: u64,
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
    /// v3.1: open and recent delivery orders
    orders: IterableMap<String, Order>,
    /// v3.1: customer id → (day, coins of income paid that day)
    income: LookupMap<String, (u64, u64)>,
    deliveries: u64,
    /// v3.2: street cred per player
    cred: LookupMap<AccountId, Cred>,
    /// v3.2: player → (day, server-awarded XP that day)
    server_xp: LookupMap<AccountId, (u64, u64)>,
    /// v3.3: player stalls, by slot
    stalls: IterableMap<String, PlayerStall>,
    /// v3.3: coins burned by licence fees and street commission
    burned: u64,
    /// v3.5: NEP-245 total supply per good
    supply: LookupMap<String, u128>,
}

/// NEP-245 token: goods are fungible within a type, so no single owner.
#[near(serializers = [json])]
pub struct MtToken {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

/// The v3.3 state layout (unchanged in v3.4), read once by `migrate`.
#[near(serializers = [borsh])]
pub struct BazaarV33 {
    owner: AccountId,
    server: AccountId,
    haggles: LookupMap<String, Haggle>,
    coins: LookupMap<AccountId, u64>,
    goods: LookupMap<String, u32>,
    memory: LookupMap<String, Memory>,
    leaders: Vec<LeaderEntry>,
    haggle_count: u64,
    deals: u64,
    no_deals: u64,
    unrevealed: u64,
    agents: LookupMap<String, Agent>,
    agent_ids: Vec<String>,
    agent_by_account: LookupMap<AccountId, String>,
    cost_basis: LookupMap<String, u64>,
    auths: LookupMap<String, Auth>,
    investments: LookupMap<String, u64>,
    orders: IterableMap<String, Order>,
    income: LookupMap<String, (u64, u64)>,
    deliveries: u64,
    cred: LookupMap<AccountId, Cred>,
    server_xp: LookupMap<AccountId, (u64, u64)>,
    stalls: IterableMap<String, PlayerStall>,
    burned: u64,
}

/// One good on a player's stall.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub good_id: String,
    pub qty: u32,
    pub price: u32,
}

/// A player-owned stall on Canal Street.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PlayerStall {
    pub slot: String,
    pub owner: AccountId,
    pub listings: Vec<Listing>,
    /// Coins waiting to be collected.
    pub till: u64,
    pub sold: u64,
    /// Everything the stall has ever paid its owner (after commission).
    pub earned: u64,
    pub opened_ms: u64,
}

pub const STALL_SLOTS: [&str; 4] = ["corner-1", "corner-2", "corner-3", "corner-4"];
pub const LICENCE_PRICE: u64 = 150;
pub const LICENCE_XP: u64 = 120;
pub const STALL_COMMISSION_PCT: u64 = 10;
pub const MAX_STALL_PRICE: u32 = 500;
pub const DOCK_WAGE: u64 = 40;
pub const BROKE_BELOW: u64 = 20;

/// A player's street cred.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Cred {
    pub xp: u64,
    pub streak: u32,
    pub best_streak: u32,
    /// UTC day of the last XP earned.
    pub last_day: u64,
}

pub const XP_DEAL: u64 = 5;
pub const XP_DELIVERY: u64 = 10;
pub const XP_EXPRESS_BONUS: u64 = 5;
pub const XP_STREAK_BONUS: u64 = 5;
pub const STREAK_CAP: u32 = 7;
pub const SERVER_XP_PER_DAY: u64 = 80;

/// Most coins a customer's business brings in per UTC day.
pub const CUSTOMER_INCOME_PER_DAY: u64 = 400;
/// Most open orders at once, across all customers.
pub const MAX_OPEN_ORDERS: usize = 40;

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

/// NEP-245 event (standard "nep245", version "1.0.0").
fn mt_event(event: &str, data: near_sdk::serde_json::Value) {
    let log = json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": [data] });
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
            orders: IterableMap::new(StorageKey::Orders),
            income: LookupMap::new(StorageKey::Income),
            deliveries: 0,
            cred: LookupMap::new(StorageKey::Cred),
            server_xp: LookupMap::new(StorageKey::ServerXp),
            stalls: IterableMap::new(StorageKey::Stalls),
            burned: 0,
            supply: LookupMap::new(StorageKey::Supply),
        }
    }

    /// Owner (the contract account itself): upgrade v3.3/v3.4 state to v3.5 (NEP-245 goods).
    /// `supply` is each good's total across all balances, summed from the state before migrating.
    /// Refuses while anything is in escrow, so every unit is in someone's balance.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(supply: Vec<(String, U128)>) -> Self {
        let old: BazaarV33 = env::state_read().unwrap_or_else(|| env::panic_str("no v3.3 state to migrate"));
        require!(old.haggle_count == old.deals + old.no_deals + old.unrevealed, "close every open haggle before migrating");
        require!(old.stalls.values().all(|st| st.listings.iter().all(|l| l.qty == 0)), "empty every stall before migrating");
        let mut sup = LookupMap::new(StorageKey::Supply);
        for (good, n) in supply {
            sup.insert(good, n.0);
        }
        Self {
            owner: old.owner,
            server: old.server,
            haggles: old.haggles,
            coins: old.coins,
            goods: old.goods,
            memory: old.memory,
            leaders: old.leaders,
            haggle_count: old.haggle_count,
            deals: old.deals,
            no_deals: old.no_deals,
            unrevealed: old.unrevealed,
            agents: old.agents,
            agent_ids: old.agent_ids,
            agent_by_account: old.agent_by_account,
            cost_basis: old.cost_basis,
            auths: old.auths,
            investments: old.investments,
            orders: old.orders,
            income: old.income,
            deliveries: old.deliveries,
            cred: old.cred,
            server_xp: old.server_xp,
            stalls: old.stalls,
            burned: old.burned,
            supply: sup,
        }
    }

    /// Add XP to a player (never an agent), with the streak bonus on the first XP of a UTC day.
    fn grant(&mut self, player: &AccountId, xp: u64, reason: &str) {
        if self.agent_of(player).is_some() {
            return;
        }
        let mut c = self.cred.get(player).copied().unwrap_or_default();
        let day = today();
        let mut bonus = 0;
        if c.last_day != day || c.xp == 0 {
            c.streak = if c.xp > 0 && c.last_day + 1 == day { c.streak + 1 } else { 1 };
            c.best_streak = c.best_streak.max(c.streak);
            c.last_day = day;
            bonus = XP_STREAK_BONUS * u64::from(c.streak.min(STREAK_CAP));
        }
        c.xp += xp + bonus;
        self.cred.insert(player.clone(), c);
        emit("cred", json!({ "player": player, "xp": xp, "streak_bonus": bonus, "reason": reason, "total": c.xp, "streak": c.streak }));
    }

    /// Server: XP for what only the server sees (a caught bluff), capped per player per day.
    pub fn award_cred(&mut self, player: AccountId, xp: u64, reason: String) {
        self.require_server();
        require!(is_id(&reason), "reason must be [a-z0-9_-]{1,64}");
        let day = today();
        let (d, given) = self.server_xp.get(&player).copied().unwrap_or((day, 0));
        let given = if d == day { given } else { 0 };
        require!(given + xp <= SERVER_XP_PER_DAY, "over today's server-awarded XP");
        self.server_xp.insert(player.clone(), (day, given + xp));
        self.grant(&player, xp, &reason);
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
            self.mint_goods(&account, &good, units, "opening stock");
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

    /// Move goods between balances, with the NEP-245 transfer event.
    fn move_goods(&mut self, from: &AccountId, to: &AccountId, good: &str, qty: u32, memo: &str) {
        if qty == 0 {
            return;
        }
        self.add_goods(from, good, -i64::from(qty));
        self.add_goods(to, good, i64::from(qty));
        mt_event("mt_transfer", json!({ "old_owner_id": from, "new_owner_id": to, "token_ids": [good], "amounts": [qty.to_string()], "memo": memo }));
    }
    fn mint_goods(&mut self, to: &AccountId, good: &str, qty: u32, memo: &str) {
        self.add_goods(to, good, i64::from(qty));
        let s = self.supply.get(good).copied().unwrap_or(0);
        self.supply.insert(good.to_string(), s + u128::from(qty));
        mt_event("mt_mint", json!({ "owner_id": to, "token_ids": [good], "amounts": [qty.to_string()], "memo": memo }));
    }
    fn burn_goods(&mut self, from: &AccountId, good: &str, qty: u32, memo: &str) {
        self.add_goods(from, good, -i64::from(qty));
        let s = self.supply.get(good).copied().unwrap_or(0);
        self.supply.insert(good.to_string(), s.saturating_sub(u128::from(qty)));
        mt_event("mt_burn", json!({ "owner_id": from, "token_ids": [good], "amounts": [qty.to_string()], "memo": memo }));
    }

    // ---------- NEP-245: goods as multi tokens ----------

    fn mt_amount(amount: U128) -> u32 {
        require!(amount.0 > 0 && amount.0 <= u128::from(u32::MAX), "amount must be 1..=4294967295");
        amount.0 as u32
    }
    fn mt_move_batch(&mut self, sender: &AccountId, receiver: &AccountId, token_ids: &[String], amounts: &[U128], approvals_given: bool, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(!approvals_given, "approvals are not supported");
        require!(sender != receiver, "sender and receiver must differ");
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "token_ids and amounts must match");
        let memo = memo.unwrap_or_default();
        for (t, a) in token_ids.iter().zip(amounts) {
            require!(self.supply.contains_key(t), "unknown token");
            let qty = Self::mt_amount(*a);
            self.move_goods(sender, receiver, t, qty, &memo);
        }
    }

    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        let sender = env::predecessor_account_id();
        self.mt_move_batch(&sender, &receiver_id, &[token_id], &[amount], approval.is_some(), memo);
    }

    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>) {
        let sender = env::predecessor_account_id();
        let given = approvals.is_some_and(|a| a.iter().any(Option::is_some));
        self.mt_move_batch(&sender, &receiver_id, &token_ids, &amounts, given, memo);
    }

    #[payable]
    pub fn mt_transfer_call(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], approval.map(|a| vec![Some(a)]), memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        let sender = env::predecessor_account_id();
        let given = approvals.is_some_and(|a| a.iter().any(Option::is_some));
        self.mt_move_batch(&sender, &receiver_id, &token_ids, &amounts, given, memo);
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_RECEIVER)
            .mt_on_transfer(sender.clone(), vec![sender.clone(); token_ids.len()], token_ids.clone(), amounts.clone(), msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).mt_resolve_transfer(sender, receiver_id, token_ids, amounts))
            .into()
    }

    /// NEP-245 resolve: refund whatever the receiver didn't use (all of it if the call failed).
    /// Returns the amounts the receiver kept.
    #[private]
    pub fn mt_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, #[callback_result] unused: Result<Vec<U128>, PromiseError>) -> Vec<U128> {
        let unused = match unused {
            Ok(u) if u.len() == amounts.len() => u,
            _ => amounts.clone(),
        };
        token_ids
            .iter()
            .zip(amounts.iter().zip(unused))
            .map(|(t, (sent, back))| {
                let have = u128::from(self.goods_of(receiver_id.clone(), t.clone()));
                let refund = back.0.min(sent.0).min(have) as u32;
                self.move_goods(&receiver_id, &sender_id, t, refund, "refund");
                U128(sent.0 - u128::from(refund))
            })
            .collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(u128::from(self.goods_of(account_id, token_id)))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.into_iter().map(|t| self.mt_balance_of(account_id.clone(), t)).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.supply.get(&token_id).map(|s| U128(*s))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<MtToken>> {
        token_ids.into_iter().map(|t| self.supply.contains_key(&t).then_some(MtToken { token_id: t, owner_id: None })).collect()
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
        self.burn_goods(&a.account, &good_id, qty, "used up");
        emit("consumed", json!({ "agent": agent_id, "good_id": good_id, "qty": qty }));
    }

    // ---------- delivery orders ----------

    /// Server: a customer's business brings in coins, at most `CUSTOMER_INCOME_PER_DAY` a day.
    /// It's the money its bounties are paid from.
    pub fn pay_income(&mut self, agent_id: String, amount: u64) {
        self.require_server();
        let a = self.agent(&agent_id);
        require!(a.kind == AgentKind::Customer, "only customers have income");
        let day = today();
        let (d, paid) = self.income.get(&agent_id).copied().unwrap_or((day, 0));
        let paid = if d == day { paid } else { 0 };
        require!(paid + amount <= CUSTOMER_INCOME_PER_DAY, "over the customer's daily income");
        self.income.insert(agent_id.clone(), (day, paid + amount));
        self.add_coins(&a.account, amount as i64);
        emit("income", json!({ "agent": agent_id, "amount": amount }));
    }

    /// Signed by a customer's own account: post an order and lock its bounty.
    pub fn post_order(&mut self, order_id: String, good_id: String, bounty: u64, deadline_ms: u64, site: String, express: bool) {
        let who = env::predecessor_account_id();
        let c = self.agent_of(&who).unwrap_or_else(|| env::panic_str("only a customer can post an order"));
        require!(c.kind == AgentKind::Customer, "only a customer can post an order");
        require!(is_id(&order_id) && is_id(&good_id) && is_id(&site), "ids must be [a-z0-9_-]{1,64}");
        require!(!self.orders.contains_key(&order_id), "order_id already used");
        let open = self.orders.values().filter(|o| o.status == OrderStatus::Open).count();
        require!(open < MAX_OPEN_ORDERS, "too many open orders");
        let now = env::block_timestamp_ms();
        require!(deadline_ms > now && deadline_ms <= now + DAY_MS, "deadline must be within the next day");
        require!(bounty > 0, "bounty must be positive");
        self.charge_cap(&c.id, bounty as i64);
        self.add_coins(&who, -(bounty as i64));
        let order = Order { id: order_id.clone(), customer: c.id.clone(), good_id, bounty, deadline_ms, site, express, status: OrderStatus::Open, posted_ms: now, courier: None, fare: 0 };
        emit("order_posted", json!(order));
        self.orders.insert(order_id, order);
    }

    /// Server: a player delivered. The good goes to the customer, the bounty to the player, and
    /// `fare` (if they took a cab or helicopter) out of the bounty to the cab company.
    pub fn fulfil_order(&mut self, order_id: String, player: AccountId, fare: u64) {
        self.require_server();
        let mut o = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("unknown order"));
        require!(o.status == OrderStatus::Open, "order is no longer open");
        require!(env::block_timestamp_ms() <= o.deadline_ms, "the customer stopped waiting");
        require!(self.agent_of(&player).is_none(), "agents don't run deliveries");
        require!(fare <= o.bounty, "fare can't exceed the bounty");
        let customer = self.agent(&o.customer);
        self.move_goods(&player, &customer.account, &o.good_id, 1, "delivery");
        self.add_coins(&player, (o.bounty - fare) as i64);
        if fare > 0 {
            let cab = self
                .agent_ids
                .iter()
                .filter_map(|id| self.agents.get(id))
                .find(|a| a.kind == AgentKind::Cab)
                .map(|a| a.account.clone())
                .unwrap_or_else(|| env::panic_str("no cab company registered"));
            self.add_coins(&cab, fare as i64);
        }
        self.grant(&player, XP_DELIVERY + if o.express { XP_EXPRESS_BONUS } else { 0 }, "delivery");
        o.status = OrderStatus::Delivered;
        o.courier = Some(player.clone());
        o.fare = fare;
        self.deliveries += 1;
        emit("order_delivered", json!({ "order_id": order_id, "courier": player, "customer": o.customer, "good_id": o.good_id, "bounty": o.bounty, "fare": fare }));
        self.orders.insert(order_id, o);
    }

    /// Anyone: expire an order past its deadline and refund the customer's bounty.
    pub fn expire_order(&mut self, order_id: String) {
        let mut o = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("unknown order"));
        require!(o.status == OrderStatus::Open, "order is no longer open");
        require!(env::block_timestamp_ms() > o.deadline_ms, "the customer is still waiting");
        let customer = self.agent(&o.customer);
        self.add_coins(&customer.account, o.bounty as i64);
        self.charge_cap(&o.customer, -(o.bounty as i64));
        o.status = OrderStatus::Expired;
        emit("order_expired", json!({ "order_id": order_id }));
        self.orders.insert(order_id, o);
    }

    /// Server: drop closed orders from storage (their events stay in the chain's history).
    pub fn prune_orders(&mut self, order_ids: Vec<String>) {
        self.require_server();
        for id in order_ids {
            if self.orders.get(&id).is_some_and(|o| o.status != OrderStatus::Open) {
                self.orders.remove(&id);
            }
        }
    }

    // ---------- dock work ----------

    /// Server: pay a broke player a day's dock wage from the wholesaler's purse. The wholesaler
    /// signed `authorize_spend(wage_id, ≥ DOCK_WAGE)` first. Once per player per UTC day.
    pub fn pay_wages(&mut self, wage_id: String, player: AccountId) {
        self.require_server();
        let auth = self.auths.remove(&wage_id).unwrap_or_else(|| env::panic_str("the wholesaler hasn't authorized this wage"));
        let boss = self.agent_of(&auth.agent).unwrap_or_else(|| env::panic_str("only an agent pays wages"));
        require!(boss.kind == AgentKind::Wholesaler, "only the wholesaler hires dock workers");
        require!(auth.max >= DOCK_WAGE, "the authorization doesn't cover a wage");
        require!(self.agent_of(&player).is_none(), "agents don't work the docks");
        require!(self.coins_of(player.clone()) < BROKE_BELOW, "dock work is for players who are broke");
        // The once-a-day record lives in the per-day income ledger, keyed "wage#player".
        let key = format!("wage#{player}");
        let day = today();
        require!(self.income.get(&key).is_none_or(|(d, _)| *d != day), "you've already worked a shift today");
        self.income.insert(key, (day, DOCK_WAGE));
        self.charge_cap(&boss.id, DOCK_WAGE as i64 - auth.max as i64);
        self.add_coins(&auth.agent, -(DOCK_WAGE as i64));
        self.add_coins(&player, DOCK_WAGE as i64);
        emit("wages_paid", json!({ "wage_id": wage_id, "player": player, "employer": boss.id, "amount": DOCK_WAGE }));
    }

    // ---------- player stalls ----------

    fn stall_slot_of(&self, player: &AccountId) -> Option<String> {
        self.stalls.iter().find(|(_, st)| &st.owner == player).map(|(k, _)| k.clone())
    }
    fn my_stall(&self, player: &AccountId) -> PlayerStall {
        let slot = self.stall_slot_of(player).unwrap_or_else(|| env::panic_str("you don't have a stall"));
        self.stalls.get(&slot).cloned().unwrap()
    }

    /// Server, for a player: buy the licence for a free stall slot. Needs 120 XP of street cred;
    /// the fee is burned.
    pub fn buy_licence(&mut self, player: AccountId, slot: String) {
        self.require_server();
        require!(STALL_SLOTS.contains(&slot.as_str()), "no such stall slot");
        require!(!self.stalls.contains_key(&slot), "that slot is taken");
        require!(self.agent_of(&player).is_none(), "agents don't hold licences");
        require!(self.stall_slot_of(&player).is_none(), "you already have a stall");
        require!(self.cred_of(player.clone()).xp >= LICENCE_XP, "a licence needs street cred level 3");
        self.add_coins(&player, -(LICENCE_PRICE as i64));
        self.burned += LICENCE_PRICE;
        let st = PlayerStall { slot: slot.clone(), owner: player.clone(), listings: vec![], till: 0, sold: 0, earned: 0, opened_ms: env::block_timestamp_ms() };
        self.stalls.insert(slot.clone(), st);
        emit("licence_bought", json!({ "player": player, "slot": slot, "fee": LICENCE_PRICE }));
    }

    /// Server, for a stall owner: move goods from their purse onto the stall at a price
    /// (`price` updates the listing; `qty` may be 0 to only reprice).
    pub fn stock_stall(&mut self, player: AccountId, good_id: String, qty: u32, price: u32) {
        self.require_server();
        require!(is_id(&good_id), "good id must be [a-z0-9_-]{1,64}");
        require!((1..=MAX_STALL_PRICE).contains(&price), "price must be 1..=500");
        let mut st = self.my_stall(&player);
        self.move_goods(&player, &env::current_account_id(), &good_id, qty, "onto a stall");
        match st.listings.iter_mut().find(|l| l.good_id == good_id) {
            Some(l) => {
                l.qty += qty;
                l.price = price;
            }
            None => st.listings.push(Listing { good_id: good_id.clone(), qty, price }),
        }
        emit("stall_stocked", json!({ "player": player, "slot": st.slot, "good_id": good_id, "qty": qty, "price": price }));
        self.stalls.insert(st.slot.clone(), st);
    }

    /// Server, for a stall owner: take goods back off the stall.
    pub fn withdraw_stock(&mut self, player: AccountId, good_id: String, qty: u32) {
        self.require_server();
        let mut st = self.my_stall(&player);
        let l = st.listings.iter_mut().find(|l| l.good_id == good_id).unwrap_or_else(|| env::panic_str("not on your stall"));
        require!(l.qty >= qty, "not that many on your stall");
        l.qty -= qty;
        self.move_goods(&env::current_account_id(), &player, &good_id, qty, "off a stall");
        self.stalls.insert(st.slot.clone(), st);
    }

    /// Server, for a stall owner: move the till into their purse.
    pub fn collect_till(&mut self, player: AccountId) -> u64 {
        self.require_server();
        let mut st = self.my_stall(&player);
        let amount = st.till;
        st.till = 0;
        self.add_coins(&player, amount as i64);
        emit("till_collected", json!({ "player": player, "slot": st.slot, "amount": amount }));
        self.stalls.insert(st.slot.clone(), st);
        amount
    }

    /// Server: an agent buys one unit from a player's stall at its listed price. The agent signed
    /// for it with `authorize_spend(sale_id, max)` first. The owner's take goes to the till; the
    /// street commission is burned.
    pub fn stall_sale(&mut self, sale_id: String, slot: String, good_id: String) {
        self.require_server();
        let auth = self.auths.remove(&sale_id).unwrap_or_else(|| env::panic_str("the agent hasn't authorized this spend"));
        let agent = self.agent_of(&auth.agent).unwrap_or_else(|| env::panic_str("only agents buy from stalls"));
        let mut st = self.stalls.get(&slot).cloned().unwrap_or_else(|| env::panic_str("no stall in that slot"));
        let l = st.listings.iter_mut().find(|l| l.good_id == good_id && l.qty > 0).unwrap_or_else(|| env::panic_str("the stall is out of that"));
        let price = u64::from(l.price);
        require!(price <= auth.max, "price is above what the agent authorized");
        l.qty -= 1;
        // The agent pays from its own purse, within its cap.
        self.charge_cap(&agent.id, price as i64 - auth.max as i64);
        self.add_coins(&auth.agent, -(price as i64));
        let commission = price * STALL_COMMISSION_PCT / 100;
        self.burned += commission;
        st.till += price - commission;
        st.earned += price - commission;
        st.sold += 1;
        // The buyer's running cost basis for what it now holds.
        let key = goods_key(&auth.agent, &good_id);
        let held = u64::from(self.goods_of(auth.agent.clone(), good_id.clone()));
        let old = self.cost_basis.get(&key).copied().unwrap_or(0);
        self.cost_basis.insert(key, (old * held + price * 100) / (held + 1));
        self.move_goods(&env::current_account_id(), &auth.agent, &good_id, 1, "stall sale");
        emit("stall_sale", json!({ "sale_id": sale_id, "slot": slot, "owner": st.owner, "buyer": agent.id, "good_id": good_id, "price": price, "commission": commission }));
        self.stalls.insert(slot, st);
    }

    /// Server, for a stall owner: give up the stall. Stock and till go back to the player.
    pub fn release_stall(&mut self, player: AccountId) {
        self.require_server();
        let st = self.my_stall(&player);
        for l in &st.listings {
            self.move_goods(&env::current_account_id(), &player, &l.good_id, l.qty, "stall closed");
        }
        self.add_coins(&player, st.till as i64);
        self.stalls.remove(&st.slot);
        emit("stall_released", json!({ "player": player, "slot": st.slot }));
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
                self.move_goods(&merchant.account, &env::current_account_id(), &good_id, qty, "escrow");
            }
            Side::Buy => {
                require!(qty == 1, "players sell one unit at a time");
                self.move_goods(&player, &env::current_account_id(), &good_id, 1, "escrow");
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
                self.move_goods(&env::current_account_id(), &player, &h.good_id, h.qty, "deal");
            }
            (Side::Sell, None) => {
                if let (Some(a), Some(auth)) = (&buyer_agent, &auth) {
                    self.charge_cap(&a.id, -(auth.max as i64));
                }
                self.move_goods(&env::current_account_id(), &merchant.account, &h.good_id, h.qty, "no deal");
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
                self.move_goods(&env::current_account_id(), &merchant.account, &h.good_id, 1, "deal");
            }
            (Side::Buy, None) => {
                if let (Some(a), Some(auth)) = (&buyer_agent, &auth) {
                    self.charge_cap(&a.id, -(auth.max as i64));
                }
                self.move_goods(&env::current_account_id(), &player, &h.good_id, 1, "no deal");
                self.add_coins(&merchant.account, h.escrow as i64);
            }
        }
        if deal_price.is_some() {
            h.status = Status::Deal;
            h.price = deal_price;
            self.deals += 1;
            self.grant(&player, XP_DEAL, "deal");
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
            Side::Sell => self.move_goods(&env::current_account_id(), &merchant.account, &h.good_id, h.qty, "expired"),
            Side::Buy => {
                let (p, g) = (h.player.clone(), h.good_id.clone());
                self.move_goods(&env::current_account_id(), &p, &g, 1, "expired");
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

    pub fn stalls(&self) -> Vec<PlayerStall> {
        self.stalls.values().cloned().collect()
    }

    pub fn stall_of(&self, player: AccountId) -> Option<PlayerStall> {
        self.stall_slot_of(&player).and_then(|s| self.stalls.get(&s).cloned())
    }

    pub fn cred_of(&self, player: AccountId) -> Cred {
        self.cred.get(&player).copied().unwrap_or_default()
    }

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    /// Orders still in storage (open, or closed and not yet pruned), up to `limit`.
    pub fn orders(&self, open_only: bool, limit: u32) -> Vec<Order> {
        self.orders
            .values()
            .filter(|o| !open_only || o.status == OrderStatus::Open)
            .take(limit.min(100) as usize)
            .cloned()
            .collect()
    }

    pub fn leaderboard(&self) -> Vec<LeaderEntry> {
        self.leaders.clone()
    }

    pub fn stats(&self) -> Stats {
        Stats { server: self.server.clone(), haggles: self.haggle_count, deals: self.deals, no_deals: self.no_deals, unrevealed: self.unrevealed, deliveries: self.deliveries, burned: self.burned }
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
        c.register_agent("deli".into(), "Mama Rosa's Deli".into(), acc("deli.testnet"), AgentKind::Customer, 500, 200, vec![]);
        c.register_agent("cab".into(), "Checker Cab Co.".into(), acc("cab.testnet"), AgentKind::Cab, 0, 0, vec![]);
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

    // ---------- delivery orders ----------

    /// The deli posts an order for saffron at block 100 (t = 100 s), waiting 300 s.
    fn post(c: &mut Bazaar, id: &str, bounty: u64) {
        ctx("deli.testnet", 100);
        c.post_order(id.into(), "saffron".into(), bounty, 400_000, "timessq".into(), false);
        ctx("server.testnet", 100);
    }

    /// Give the player a saffron by buying it from Zaria.
    fn get_saffron(c: &mut Bazaar) {
        let s = Secret { merchant_id: "zaria".into(), good_id: "saffron".into(), floor: 30, ..sell_secret() };
        open(c, "s1", &s);
        c.close_haggle("s1".into(), s, SALT.into(), Some(40), false);
    }

    #[test]
    fn a_delivery_pays_the_courier_and_the_cab() {
        let mut c = setup();
        post(&mut c, "o1", 90);
        assert_eq!(c.coins_of(acc("deli.testnet")), 110, "bounty locked");
        get_saffron(&mut c);
        c.fulfil_order("o1".into(), player(), 26);
        assert_eq!(c.coins_of(player()), STARTER_COINS - 40 + 90 - 26);
        assert_eq!(c.coins_of(acc("cab.testnet")), 26);
        assert_eq!(c.goods_of(acc("deli.testnet"), "saffron".into()), 1);
        assert_eq!(c.goods_of(player(), "saffron".into()), 0);
        let o = c.get_order("o1".into()).unwrap();
        assert_eq!((o.status, o.courier, o.fare), (OrderStatus::Delivered, Some(player()), 26));
        assert_eq!(c.stats().deliveries, 1);
    }

    #[test]
    #[should_panic(expected = "only a customer")]
    fn only_a_customer_posts_orders() {
        let mut c = setup();
        c.post_order("o1".into(), "saffron".into(), 50, 400_000, "timessq".into(), false);
    }

    #[test]
    #[should_panic(expected = "doesn't have that good")]
    fn you_cannot_deliver_what_you_dont_have() {
        let mut c = setup();
        post(&mut c, "o1", 90);
        c.fulfil_order("o1".into(), player(), 0);
    }

    #[test]
    #[should_panic(expected = "stopped waiting")]
    fn late_deliveries_are_refused() {
        let mut c = setup();
        post(&mut c, "o1", 90);
        get_saffron(&mut c);
        ctx("server.testnet", 401);
        c.fulfil_order("o1".into(), player(), 0);
    }

    #[test]
    fn missed_orders_expire_and_refund_the_customer() {
        let mut c = setup();
        post(&mut c, "o1", 90);
        ctx("anyone.testnet", 401);
        c.expire_order("o1".into());
        assert_eq!(c.coins_of(acc("deli.testnet")), 200);
        assert_eq!(c.get_order("o1".into()).unwrap().status, OrderStatus::Expired);
        let deli = c.agents(vec![]).into_iter().find(|a| a.id == "deli").unwrap();
        assert_eq!(deli.spent_today, 0, "the reservation is released");
    }

    #[test]
    #[should_panic(expected = "still waiting")]
    fn orders_cannot_expire_early() {
        let mut c = setup();
        post(&mut c, "o1", 90);
        c.expire_order("o1".into());
    }

    #[test]
    #[should_panic(expected = "daily income")]
    fn customer_income_is_capped() {
        let mut c = setup();
        c.pay_income("deli".into(), 300);
        c.pay_income("deli".into(), 101);
    }

    #[test]
    fn open_orders_are_listed_and_closed_ones_pruned() {
        let mut c = setup();
        post(&mut c, "o1", 50);
        post(&mut c, "o2", 60);
        get_saffron(&mut c);
        c.fulfil_order("o1".into(), player(), 0);
        assert_eq!(c.orders(true, 10).len(), 1);
        c.prune_orders(vec!["o1".into(), "o2".into()]);
        assert!(c.get_order("o1".into()).is_none());
        assert!(c.get_order("o2".into()).is_some(), "open orders are never pruned");
    }

    #[test]
    fn migrate_keeps_v33_state() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        post(&mut c, "o1", 50);
        c.award_cred(player(), 4, "caught_bluff".into());
        // Write the v3.3 layout, as it sits on testnet today, then migrate.
        let old = BazaarV33 {
            owner: acc("owner.testnet"),
            server: acc("server.testnet"),
            haggles: LookupMap::new(StorageKey::Haggles),
            coins: LookupMap::new(StorageKey::Coins),
            goods: LookupMap::new(StorageKey::Goods),
            memory: LookupMap::new(StorageKey::Memory),
            leaders: c.leaders.clone(),
            haggle_count: 1,
            deals: 1,
            no_deals: 0,
            unrevealed: 0,
            agents: LookupMap::new(StorageKey::Agents),
            agent_ids: c.agent_ids.clone(),
            agent_by_account: LookupMap::new(StorageKey::AgentByAccount),
            cost_basis: LookupMap::new(StorageKey::CostBasis),
            auths: LookupMap::new(StorageKey::Auths),
            investments: LookupMap::new(StorageKey::Investments),
            orders: IterableMap::new(StorageKey::Orders),
            income: LookupMap::new(StorageKey::Income),
            deliveries: 3,
            cred: LookupMap::new(StorageKey::Cred),
            server_xp: LookupMap::new(StorageKey::ServerXp),
            stalls: IterableMap::new(StorageKey::Stalls),
            burned: 150,
        };
        c.server_xp.flush();
        c.cred.flush();
        c.orders.flush();
        c.coins.flush();
        c.goods.flush();
        c.agents.flush();
        c.haggles.flush();
        env::state_write(&old);
        let m = Bazaar::migrate(vec![("rug".into(), U128(103)), ("saffron".into(), U128(3))]);
        assert_eq!(m.coins_of(player()), STARTER_COINS - 60);
        assert_eq!(m.goods_of(player(), "rug".into()), 1);
        assert_eq!(m.get_haggle("h1".into()).unwrap().status, Status::Deal);
        assert_eq!(m.agents(vec!["rug".into()]).len(), 7);
        assert_eq!(m.stats().deliveries, 3);
        assert_eq!(m.get_order("o1".into()).unwrap().status, OrderStatus::Open);
        assert_eq!(m.cred_of(player()).xp, 10 + 4, "cred carries over");
        assert!(m.stalls().is_empty());
        assert_eq!(m.stats().burned, 150);
        assert_eq!(m.mt_supply("rug".into()), Some(U128(103)));
        assert_eq!(m.mt_balance_of(player(), "rug".into()), U128(1));
    }

    // ---------- street cred ----------

    fn at_day(caller: &str, day: u64) {
        let ms = day * DAY_MS + 1_000;
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(caller)).block_height(100).block_timestamp(ms * 1_000_000).build());
    }

    #[test]
    fn deals_and_deliveries_earn_xp_with_a_daily_streak_bonus() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        // First XP ever: the deal (5) plus a 1-day streak bonus (5).
        assert_eq!(c.cred_of(player()), Cred { xp: 10, streak: 1, best_streak: 1, last_day: 0 });
        post(&mut c, "o1", 90);
        get_saffron(&mut c);
        c.fulfil_order("o1".into(), player(), 0);
        // Same day: deal +5 and delivery +10, no second bonus.
        assert_eq!(c.cred_of(player()).xp, 25);
    }

    #[test]
    fn streaks_grow_on_consecutive_days_and_reset_after_a_gap() {
        let mut c = setup();
        at_day("server.testnet", 10);
        c.award_cred(player(), 4, "caught_bluff".into());
        at_day("server.testnet", 11);
        c.award_cred(player(), 4, "caught_bluff".into());
        let cr = c.cred_of(player());
        assert_eq!((cr.streak, cr.xp), (2, 4 + 5 + 4 + 10));
        at_day("server.testnet", 13);
        c.award_cred(player(), 4, "caught_bluff".into());
        let cr = c.cred_of(player());
        assert_eq!((cr.streak, cr.best_streak), (1, 2));
    }

    #[test]
    #[should_panic(expected = "server-awarded XP")]
    fn server_awarded_xp_is_capped_per_day() {
        let mut c = setup();
        c.award_cred(player(), 60, "caught_bluff".into());
        c.award_cred(player(), 21, "caught_bluff".into());
    }

    #[test]
    #[should_panic(expected = "only the game server")]
    fn only_the_server_awards_xp() {
        let mut c = setup();
        ctx("player.testnet", 100);
        c.award_cred(player(), 4, "caught_bluff".into());
    }

    #[test]
    fn agents_earn_no_cred() {
        let mut c = setup();
        ctx("ivy.testnet", 100);
        c.authorize_spend("t1".into(), 70);
        ctx("server.testnet", 100);
        let s = sell_secret();
        c.open_haggle("t1".into(), acc("ivy.testnet"), Side::Sell, "farrukh".into(), "rug".into(), 0, 0, commitment_of(&s, SALT), None, None);
        c.close_haggle("t1".into(), s, SALT.into(), Some(60), false);
        assert_eq!(c.cred_of(acc("ivy.testnet")).xp, 0);
    }

    // ---------- player stalls ----------

    /// Give the player enough cred for a licence and a saffron to sell.
    fn licensed(c: &mut Bazaar) {
        get_saffron(c);
        c.award_cred(player(), 80, "caught_bluff".into());
        at_day("server.testnet", 1);
        c.award_cred(player(), 40, "caught_bluff".into());
        ctx("server.testnet", 100);
        c.buy_licence(player(), "corner-1".into());
    }

    #[test]
    fn a_licensed_stall_sells_to_an_agent_while_the_owner_is_away() {
        let mut c = setup();
        licensed(&mut c);
        assert_eq!(c.coins_of(player()), STARTER_COINS - 40 - LICENCE_PRICE);
        c.stock_stall(player(), "saffron".into(), 1, 50);
        assert_eq!(c.goods_of(player(), "saffron".into()), 0, "on the stall now");
        // Ivy signs for the purchase herself.
        ctx("ivy.testnet", 100);
        c.authorize_spend("sale1".into(), 60);
        ctx("server.testnet", 100);
        c.stall_sale("sale1".into(), "corner-1".into(), "saffron".into());
        assert_eq!(c.goods_of(acc("ivy.testnet"), "saffron".into()), 1);
        assert_eq!(c.coins_of(acc("ivy.testnet")), 300 - 50);
        let st = c.stall_of(player()).unwrap();
        assert_eq!((st.till, st.sold, st.listings[0].qty), (45, 1, 0));
        assert_eq!(c.stats().burned, LICENCE_PRICE + 5);
        // The owner comes back and collects.
        assert_eq!(c.collect_till(player()), 45);
        assert_eq!(c.coins_of(player()), STARTER_COINS - 40 - LICENCE_PRICE + 45);
    }

    #[test]
    #[should_panic(expected = "street cred level 3")]
    fn a_licence_needs_street_cred() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        c.buy_licence(player(), "corner-1".into());
    }

    #[test]
    #[should_panic(expected = "slot is taken")]
    fn one_owner_per_slot() {
        let mut c = setup();
        licensed(&mut c);
        c.buy_licence(acc("other.testnet"), "corner-1".into());
    }

    #[test]
    #[should_panic(expected = "hasn't authorized")]
    fn the_server_cannot_buy_from_a_stall_with_an_agents_coins() {
        let mut c = setup();
        licensed(&mut c);
        c.stock_stall(player(), "saffron".into(), 1, 50);
        c.stall_sale("sale1".into(), "corner-1".into(), "saffron".into());
    }

    #[test]
    #[should_panic(expected = "above what the agent authorized")]
    fn agents_never_pay_more_than_they_signed_for() {
        let mut c = setup();
        licensed(&mut c);
        c.stock_stall(player(), "saffron".into(), 1, 90);
        ctx("ivy.testnet", 100);
        c.authorize_spend("sale1".into(), 60);
        ctx("server.testnet", 100);
        c.stall_sale("sale1".into(), "corner-1".into(), "saffron".into());
    }

    #[test]
    fn releasing_a_stall_returns_stock_and_till() {
        let mut c = setup();
        licensed(&mut c);
        c.stock_stall(player(), "saffron".into(), 1, 50);
        c.release_stall(player());
        assert_eq!(c.goods_of(player(), "saffron".into()), 1);
        assert!(c.stall_of(player()).is_none());
    }

    // ---------- dock work ----------

    /// Wu (with a cap and coins) signs for a wage.
    fn wu_signs(c: &mut Bazaar, id: &str) {
        ctx("owner.testnet", 100);
        c.register_agent("wu".into(), "Auntie Wu".into(), acc("wu.testnet"), AgentKind::Wholesaler, 400, 0, vec![]);
        ctx("farrukh.testnet", 100);
        c.pay_agent("wu".into(), 90, "lot".into());
        ctx("wu.testnet", 100);
        c.authorize_spend(id.into(), DOCK_WAGE);
        ctx("server.testnet", 100);
    }

    #[test]
    fn a_broke_player_works_a_shift_for_the_wholesaler() {
        let mut c = setup();
        c.set_coins(&player(), 5);
        wu_signs(&mut c, "w1");
        c.pay_wages("w1".into(), player());
        assert_eq!(c.coins_of(player()), 45);
        assert_eq!(c.coins_of(acc("wu.testnet")), 50);
    }

    #[test]
    #[should_panic(expected = "for players who are broke")]
    fn only_broke_players_get_dock_work() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        wu_signs(&mut c, "w1");
        c.pay_wages("w1".into(), player());
    }

    #[test]
    #[should_panic(expected = "already worked a shift today")]
    fn one_shift_a_day() {
        let mut c = setup();
        c.set_coins(&player(), 0);
        wu_signs(&mut c, "w1");
        c.pay_wages("w1".into(), player());
        c.set_coins(&player(), 0);
        ctx("wu.testnet", 100);
        c.authorize_spend("w2".into(), DOCK_WAGE);
        ctx("server.testnet", 100);
        c.pay_wages("w2".into(), player());
    }

    #[test]
    #[should_panic(expected = "hasn't authorized this wage")]
    fn the_server_cannot_pay_wages_from_the_wholesalers_purse_alone() {
        let mut c = setup();
        c.set_coins(&player(), 0);
        c.pay_wages("w1".into(), player());
    }

    // ---------- NEP-245 goods ----------

    fn with_deposit(caller: &str, yocto: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acc(caller))
            .current_account_id(acc("bazaar.testnet"))
            .block_height(100)
            .attached_deposit(near_sdk::NearToken::from_yoctonear(yocto))
            .build());
    }

    #[test]
    fn goods_are_minted_with_supply_and_nep245_events() {
        let mut c = setup();
        assert_eq!(c.mt_supply("rug".into()), Some(U128(103)), "Farrukh's 3 + Wu's 100");
        assert_eq!(c.mt_batch_supply(vec!["saffron".into(), "gold".into()]), vec![Some(U128(3)), None]);
        assert_eq!(c.mt_token(vec!["rug".into()])[0].as_ref().unwrap().token_id, "rug");
        ctx("owner.testnet", 100);
        c.register_agent("tobin".into(), "Tobin".into(), acc("tobin.testnet"), AgentKind::Merchant, 400, 50, vec![("lamp".into(), 2, 10)]);
        assert_eq!(c.mt_supply("lamp".into()), Some(U128(2)));
        assert!(get_logs().iter().any(|l| l.contains(r#""standard":"nep245""#) && l.contains("mt_mint")));
    }

    #[test]
    fn a_deal_moves_tokens_through_escrow_with_transfer_events() {
        let mut c = setup();
        let s = sell_secret();
        open(&mut c, "h1", &s);
        // While haggling, Farrukh's rug is held by the contract.
        assert_eq!(c.mt_balance_of(farrukh(), "rug".into()), U128(2));
        assert_eq!(c.mt_balance_of(env::current_account_id(), "rug".into()), U128(1));
        c.close_haggle("h1".into(), s, SALT.into(), Some(60), false);
        assert_eq!(c.mt_balance_of(player(), "rug".into()), U128(1));
        assert_eq!(c.mt_balance_of(env::current_account_id(), "rug".into()), U128(0));
        assert!(get_logs().iter().any(|l| l.contains("mt_transfer") && l.contains(r#""new_owner_id":"player.testnet""#)));
        assert_eq!(c.mt_supply("rug".into()), Some(U128(103)), "trading doesn't change supply");
    }

    #[test]
    fn using_a_good_burns_it() {
        let mut c = setup();
        c.consume("farrukh".into(), "rug".into(), 1);
        assert_eq!(c.mt_supply("rug".into()), Some(U128(102)));
        assert!(get_logs().iter().any(|l| l.contains("mt_burn")));
    }

    #[test]
    fn a_real_account_can_transfer_its_goods() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        with_deposit("player.testnet", 1);
        c.mt_transfer(acc("friend.testnet"), "rug".into(), U128(1), None, Some("a gift".into()));
        assert_eq!(c.mt_balance_of(acc("friend.testnet"), "rug".into()), U128(1));
        assert_eq!(c.mt_balance_of(player(), "rug".into()), U128(0));
    }

    #[test]
    #[should_panic(expected = "exactly 1 yoctoNEAR")]
    fn transfers_need_exactly_one_yocto() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        with_deposit("player.testnet", 0);
        c.mt_transfer(acc("friend.testnet"), "rug".into(), U128(1), None, None);
    }

    #[test]
    #[should_panic(expected = "doesn't have that good")]
    fn you_cannot_transfer_more_than_you_hold() {
        let mut c = setup();
        with_deposit("player.testnet", 1);
        c.mt_transfer(acc("friend.testnet"), "rug".into(), U128(1), None, None);
    }

    #[test]
    fn a_failed_transfer_call_is_refunded() {
        let mut c = setup();
        buy_rug(&mut c, "h1");
        with_deposit("player.testnet", 1);
        c.mt_transfer(acc("market.testnet"), "rug".into(), U128(1), None, None);
        // The receiver's call failed: resolve gives the whole amount back.
        ctx("bazaar.testnet", 100);
        let kept = c.mt_resolve_transfer(player(), acc("market.testnet"), vec!["rug".into()], vec![U128(1)], Err(PromiseError::Failed));
        assert_eq!(kept, vec![U128(0)]);
        assert_eq!(c.mt_balance_of(player(), "rug".into()), U128(1));
    }
}
