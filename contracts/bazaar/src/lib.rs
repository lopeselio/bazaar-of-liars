//! # Bazaar of Liars — fair-play contract (v2)
//!
//! Every haggle is a commit-reveal:
//! 1. `open_haggle`: before the player's first message, the game server posts
//!    `sha256("bazaar-v2|side|merchant|good|limit|need|seed|listPrice|grudge|loyalty|salt")`.
//!    The contract checks that `grudge` / `loyalty` (what the merchant remembers about this
//!    player) match its own records, so the server can't quietly hold a grudge that isn't real.
//!    When the merchant is BUYING, the player's good is escrowed here until the haggle ends.
//! 2. `close_haggle`: when the haggle ends (deal or not) the server reveals the secret + salt.
//!    The contract recomputes the hash and rejects any mismatch. On a deal it also checks the
//!    limit: a merchant selling never goes below its floor, a merchant buying never pays above
//!    its ceiling. Only then do coins and goods move, and the merchant's memory updates.
//! 3. `expire_haggle`: if the server never reveals, anyone can expire the haggle after
//!    `REVEAL_WINDOW_BLOCKS` (escrow is returned); it's counted publicly in `stats().unrevealed`.
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
const COMMIT_DOMAIN: &str = "bazaar-v2";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Haggles,
    Coins,
    Goods,
    Memory,
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

/// The merchant's hidden hand. Field names match the TypeScript `MerchantSecret`.
/// `floor` is the merchant's limit: the lowest it sells for, or the highest it buys for.
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
    pub player: AccountId,
    pub side: Side,
    pub merchant_id: String,
    pub good_id: String,
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
    /// "player#good" → count
    goods: LookupMap<String, u32>,
    /// "player#merchant" → memory
    memory: LookupMap<String, Memory>,
    /// Top players by peak coins, best first. Peaks only rise, so this is exact.
    leaders: Vec<LeaderEntry>,
    haggle_count: u64,
    deals: u64,
    no_deals: u64,
    unrevealed: u64,
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
    let log = json!({ "standard": "bazaar", "version": "2.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn goods_key(player: &AccountId, good: &str) -> String {
    format!("{player}#{good}")
}
fn memory_key(player: &AccountId, merchant: &str) -> String {
    format!("{player}#{merchant}")
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
        }
    }

    fn require_server(&self) {
        require!(env::predecessor_account_id() == self.server, "only the game server can do this");
    }

    /// Owner only: rotate the server account.
    pub fn set_server(&mut self, server: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
        self.server = server;
    }

    fn add_goods(&mut self, player: &AccountId, good: &str, delta: i64) {
        let key = goods_key(player, good);
        let have = i64::from(self.goods.get(&key).copied().unwrap_or(0));
        let next = have + delta;
        require!(next >= 0, "player doesn't have that good");
        self.goods.insert(key, next as u32);
    }

    fn set_coins(&mut self, player: &AccountId, coins: u64) {
        self.coins.insert(player.clone(), coins);
        // Leaderboard of peak purses.
        if let Some(e) = self.leaders.iter_mut().find(|e| &e.player == player) {
            if coins <= e.peak {
                return;
            }
            e.peak = coins;
        } else if self.leaders.len() < TOP_N || coins > self.leaders.last().map(|e| e.peak).unwrap_or(0) {
            self.leaders.push(LeaderEntry { player: player.clone(), peak: coins });
        } else {
            return;
        }
        self.leaders.sort_by(|a, b| b.peak.cmp(&a.peak));
        self.leaders.truncate(TOP_N);
    }

    /// Post the commitment. Must happen before the player's first message.
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
    ) {
        self.require_server();
        require!(is_id(&haggle_id), "haggle_id must be [a-z0-9_-]{1,64}");
        require!(is_id(&merchant_id) && is_id(&good_id), "merchant_id/good_id must be [a-z0-9_-]{1,64}");
        require!(is_lower_hex(&commitment, 64), "commitment must be 64 lowercase hex chars");
        require!(!self.haggles.contains_key(&haggle_id), "haggle_id already used");

        // The merchant's memory is ours, not the server's to invent.
        let mem = self.memory_of(player.clone(), merchant_id.clone());
        require!(
            grudge == mem.lowballs.min(MEMORY_CAP) && loyalty == mem.deals.min(MEMORY_CAP),
            "grudge/loyalty don't match the merchant's onchain memory"
        );

        if !self.coins.contains_key(&player) {
            self.set_coins(&player, STARTER_COINS);
        }
        match side {
            Side::Sell => require!(self.coins_of(player.clone()) > 0, "player has no coins"),
            // Escrow the good the player is selling.
            Side::Buy => self.add_goods(&player, &good_id, -1),
        }

        self.haggles.insert(
            haggle_id.clone(),
            Haggle {
                player: player.clone(),
                side,
                merchant_id: merchant_id.clone(),
                good_id: good_id.clone(),
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
            json!({ "haggle_id": haggle_id, "player": player, "side": side, "merchant_id": merchant_id, "good_id": good_id, "commitment": commitment }),
        );
    }

    /// Reveal the secret. `deal_price = Some(p)` settles a trade; `None` closes with no deal.
    /// `lowballed` updates the merchant's memory of this player.
    /// Panics (and nothing moves) unless the reveal matches the commitment and the deal
    /// respects the merchant's limit.
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
        match (h.side, deal_price) {
            (Side::Sell, Some(price)) => {
                require!(price >= secret.floor, "deal price is below the merchant's committed floor");
                let balance = self.coins_of(player.clone());
                require!(balance >= u64::from(price), "player can't afford this price");
                self.set_coins(&player, balance - u64::from(price));
                self.add_goods(&player, &h.good_id, 1);
            }
            (Side::Buy, Some(price)) => {
                require!(price <= secret.floor, "deal price is above the merchant's committed ceiling");
                let balance = self.coins_of(player.clone());
                self.set_coins(&player, balance + u64::from(price));
                // The escrowed good goes to the merchant.
            }
            (Side::Buy, None) => self.add_goods(&player, &h.good_id, 1), // return escrow
            (Side::Sell, None) => {}
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
            json!({ "haggle_id": haggle_id, "side": h.side, "status": h.status, "price": h.price, "limit": secret.floor, "need": secret.need }),
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
        if h.side == Side::Buy {
            let (p, g) = (h.player.clone(), h.good_id.clone());
            self.add_goods(&p, &g, 1);
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

    /// Everything the game UI needs about a player in one call. At most 16 goods.
    pub fn player_state(&self, player: AccountId, good_ids: Vec<String>) -> PlayerState {
        require!(good_ids.len() <= 16, "at most 16 goods");
        PlayerState {
            known: self.coins.contains_key(&player),
            coins: self.coins_of(player.clone()),
            goods: good_ids.into_iter().map(|g| self.goods_of(player.clone(), g)).collect(),
        }
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
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(caller)).block_height(block).build());
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
        let c = Bazaar::new(acc("server.testnet"));
        ctx("server.testnet", 100);
        c
    }

    fn player() -> AccountId {
        acc("player.testnet")
    }

    fn open(c: &mut Bazaar, id: &str, s: &Secret) {
        c.open_haggle(id.into(), player(), s.side, s.merchant_id.clone(), s.good_id.clone(), s.grudge, s.loyalty, commitment_of(s, SALT));
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
        assert_eq!(c.leaderboard()[0], LeaderEntry { player: player(), peak: STARTER_COINS + 8 });
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
        for i in 0..12u64 {
            c.set_coins(&acc(&format!("p{i}.testnet")), 100 + i);
        }
        let lb = c.leaderboard();
        assert_eq!(lb.len(), TOP_N);
        assert_eq!(lb[0].peak, 111);
        assert_eq!(lb[TOP_N - 1].peak, 102);
        // Spending doesn't lower a peak.
        c.set_coins(&acc("p11.testnet"), 5);
        assert_eq!(c.leaderboard()[0].peak, 111);
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
}
