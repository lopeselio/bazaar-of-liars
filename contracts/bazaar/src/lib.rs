//! # Bazaar of Liars — fair-play contract
//!
//! Every haggle is a commit-reveal:
//! 1. `open_haggle`: before the player's first message, the game server posts
//!    `sha256("bazaar-v1|merchant|good|floor|need|seed|listPrice|salt")`.
//! 2. `close_haggle`: when the haggle ends (deal or not) the server reveals the secret + salt.
//!    The contract recomputes the hash, rejects any mismatch, and on a deal also rejects any
//!    price below the revealed floor. Only then do coins and goods move.
//! 3. `expire_haggle`: if the server never reveals, anyone can expire the haggle after
//!    `REVEAL_WINDOW_BLOCKS`; it's counted publicly in `stats().unrevealed`.
//!
//! The commitment preimage MUST stay byte-identical to `packages/core/src/secrets.ts`.

use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};

/// Coins a player gets the first time they open a haggle.
pub const STARTER_COINS: u64 = 200;
/// ~1 hour of testnet blocks. After this an unrevealed haggle can be expired by anyone.
pub const REVEAL_WINDOW_BLOCKS: u64 = 3_600;
const COMMIT_DOMAIN: &str = "bazaar-v1";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Haggles,
    Coins,
    Goods,
    Earnings,
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

/// The merchant's hidden hand. Field names match the TypeScript `MerchantSecret`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub merchant_id: String,
    pub good_id: String,
    pub floor: u32,
    pub need: String,
    pub seed: u32,
    pub list_price: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Haggle {
    pub player: AccountId,
    pub merchant_id: String,
    pub good_id: String,
    pub commitment: String,
    pub opened_block: u64,
    pub status: Status,
    pub price: Option<u32>,
    /// Public once the haggle closes.
    pub secret: Option<Secret>,
    pub salt: Option<String>,
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
    /// merchant_id → coins earned
    earnings: LookupMap<String, u64>,
    haggle_count: u64,
    deals: u64,
    no_deals: u64,
    unrevealed: u64,
}

/// sha256 of the canonical preimage, lowercase hex.
pub fn commitment_of(s: &Secret, salt: &str) -> String {
    let preimage = format!(
        "{COMMIT_DOMAIN}|{}|{}|{}|{}|{}|{}|{}",
        s.merchant_id, s.good_id, s.floor, s.need, s.seed, s.list_price, salt
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
/// into each other to forge a matching hash with a different floor.
fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let log = json!({ "standard": "bazaar", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
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
            earnings: LookupMap::new(StorageKey::Earnings),
            haggle_count: 0,
            deals: 0,
            no_deals: 0,
            unrevealed: 0,
        }
    }

    fn require_server(&self) {
        require!(env::predecessor_account_id() == self.server, "only the game server can do this");
    }

    /// Owner only: rotate the server key/account.
    pub fn set_server(&mut self, server: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
        self.server = server;
    }

    /// Post the commitment. Must happen before the player's first message.
    pub fn open_haggle(&mut self, haggle_id: String, player: AccountId, merchant_id: String, good_id: String, commitment: String) {
        self.require_server();
        require!(is_id(&haggle_id), "haggle_id must be [a-z0-9_-]{1,64}");
        require!(is_id(&merchant_id) && is_id(&good_id), "merchant_id/good_id must be [a-z0-9_-]{1,64}");
        require!(is_lower_hex(&commitment, 64), "commitment must be 64 lowercase hex chars");
        require!(!self.haggles.contains_key(&haggle_id), "haggle_id already used");

        if !self.coins.contains_key(&player) {
            self.coins.insert(player.clone(), STARTER_COINS);
        }
        require!(self.coins_of(player.clone()) > 0, "player has no coins");

        self.haggles.insert(
            haggle_id.clone(),
            Haggle {
                player: player.clone(),
                merchant_id: merchant_id.clone(),
                good_id: good_id.clone(),
                commitment: commitment.clone(),
                opened_block: env::block_height(),
                status: Status::Open,
                price: None,
                secret: None,
                salt: None,
            },
        );
        self.haggle_count += 1;
        emit("haggle_opened", json!({ "haggle_id": haggle_id, "player": player, "merchant_id": merchant_id, "good_id": good_id, "commitment": commitment }));
    }

    /// Reveal the secret. `deal_price = Some(p)` settles a trade; `None` closes with no deal.
    /// Panics (and nothing moves) unless the reveal matches the commitment and `p >= floor`.
    pub fn close_haggle(&mut self, haggle_id: String, secret: Secret, salt: String, deal_price: Option<u32>) {
        self.require_server();
        let mut h = self.haggles.get(&haggle_id).cloned().unwrap_or_else(|| env::panic_str("unknown haggle"));
        require!(h.status == Status::Open, "haggle already closed");
        require!(is_lower_hex(&salt, 32), "salt must be 32 lowercase hex chars");
        require!(is_id(&secret.need), "need must be [a-z0-9_-]{1,64}");
        require!(secret.merchant_id == h.merchant_id && secret.good_id == h.good_id, "secret is for a different merchant or good");
        require!(commitment_of(&secret, &salt) == h.commitment, "reveal does not match the commitment");

        match deal_price {
            Some(price) => {
                require!(price >= secret.floor, "deal price is below the merchant's committed floor");
                let balance = self.coins_of(h.player.clone());
                require!(balance >= u64::from(price), "player can't afford this price");
                self.coins.insert(h.player.clone(), balance - u64::from(price));
                let key = format!("{}#{}", h.player, h.good_id);
                let owned = self.goods.get(&key).copied().unwrap_or(0);
                self.goods.insert(key, owned + 1);
                let earned = self.earnings.get(&h.merchant_id).copied().unwrap_or(0);
                self.earnings.insert(h.merchant_id.clone(), earned + u64::from(price));
                h.status = Status::Deal;
                h.price = Some(price);
                self.deals += 1;
            }
            None => {
                h.status = Status::NoDeal;
                self.no_deals += 1;
            }
        }

        emit(
            "haggle_closed",
            json!({ "haggle_id": haggle_id, "status": h.status, "price": h.price, "floor": secret.floor, "need": secret.need }),
        );
        h.secret = Some(secret);
        h.salt = Some(salt);
        self.haggles.insert(haggle_id, h);
    }

    /// Anyone: expire a haggle the server never revealed. Counted against the server forever.
    pub fn expire_haggle(&mut self, haggle_id: String) {
        let h = self.haggles.get_mut(&haggle_id).unwrap_or_else(|| env::panic_str("unknown haggle"));
        require!(h.status == Status::Open, "haggle already closed");
        require!(env::block_height() >= h.opened_block + REVEAL_WINDOW_BLOCKS, "reveal window still open");
        h.status = Status::Expired;
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
        self.goods.get(&format!("{player}#{good_id}")).copied().unwrap_or(0)
    }

    pub fn earnings_of(&self, merchant_id: String) -> u64 {
        self.earnings.get(&merchant_id).copied().unwrap_or(0)
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

    /// The same vector `packages/core` produces (see the TS test).
    fn tobin() -> (Secret, String, String) {
        (
            Secret { merchant_id: "tobin".into(), good_id: "lamp".into(), floor: 21, need: "restocking".into(), seed: 1906725398, list_price: 33 },
            "85dbce16545337808194316fec345c54".into(),
            "a2c539e48efd659f6c772727ba3370b03ac407d0ee041e3c2ab35b2b70343078".into(),
        )
    }

    fn setup() -> Bazaar {
        ctx("owner.testnet", 100);
        let c = Bazaar::new(acc("server.testnet"));
        ctx("server.testnet", 100);
        c
    }

    fn open(c: &mut Bazaar, id: &str) {
        let (_, _, commitment) = tobin();
        c.open_haggle(id.into(), acc("player.testnet"), "tobin".into(), "lamp".into(), commitment);
    }

    #[test]
    fn commitment_matches_typescript() {
        ctx("x.testnet", 1);
        let s = Secret { merchant_id: "farrukh".into(), good_id: "rug".into(), floor: 63, need: "hoarding".into(), seed: 1234567, list_price: 97 };
        assert_eq!(commitment_of(&s, "00112233445566778899aabbccddeeff"), "cc759ccec39a0fccd1fe5c6943d5fc8e300b027e130cbc390cba46ec4aa836cc");
        let (s, salt, c) = tobin();
        assert_eq!(commitment_of(&s, &salt), c, "the committed sample haggle in examples/ must verify onchain");
    }

    #[test]
    fn fair_deal_settles_and_reveals() {
        let mut c = setup();
        open(&mut c, "h1");
        assert_eq!(c.coins_of(acc("player.testnet")), STARTER_COINS);
        let (s, salt, _) = tobin();
        c.close_haggle("h1".into(), s.clone(), salt, Some(27));
        let h = c.get_haggle("h1".into()).unwrap();
        assert_eq!(h.status, Status::Deal);
        assert_eq!(h.secret, Some(s));
        assert_eq!(c.coins_of(acc("player.testnet")), STARTER_COINS - 27);
        assert_eq!(c.goods_of(acc("player.testnet"), "lamp".into()), 1);
        assert_eq!(c.earnings_of("tobin".into()), 27);
        assert_eq!(c.stats().deals, 1);
        assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("haggle_closed")));
    }

    #[test]
    fn no_deal_still_reveals() {
        let mut c = setup();
        open(&mut c, "h1");
        let (s, salt, _) = tobin();
        c.close_haggle("h1".into(), s, salt, None);
        assert_eq!(c.get_haggle("h1".into()).unwrap().status, Status::NoDeal);
        assert_eq!(c.coins_of(acc("player.testnet")), STARTER_COINS);
    }

    #[test]
    #[should_panic(expected = "below the merchant's committed floor")]
    fn rejects_price_below_floor() {
        let mut c = setup();
        open(&mut c, "h1");
        let (s, salt, _) = tobin();
        c.close_haggle("h1".into(), s, salt, Some(20));
    }

    #[test]
    #[should_panic(expected = "does not match the commitment")]
    fn rejects_a_changed_floor() {
        let mut c = setup();
        open(&mut c, "h1");
        let (mut s, salt, _) = tobin();
        s.floor = 10; // the server "remembers" a lower floor to justify a cheap deal
        c.close_haggle("h1".into(), s, salt, Some(15));
    }

    #[test]
    #[should_panic(expected = "does not match the commitment")]
    fn rejects_a_wrong_salt() {
        let mut c = setup();
        open(&mut c, "h1");
        let (s, _, _) = tobin();
        c.close_haggle("h1".into(), s, "ffffffffffffffffffffffffffffffff".into(), None);
    }

    #[test]
    #[should_panic(expected = "need must be")]
    fn rejects_field_shifting_with_pipes() {
        let mut c = setup();
        open(&mut c, "h1");
        let (mut s, salt, _) = tobin();
        s.need = "restocking|1".into();
        c.close_haggle("h1".into(), s, salt, None);
    }

    #[test]
    #[should_panic(expected = "only the game server")]
    fn only_server_opens() {
        let mut c = setup();
        ctx("mallory.testnet", 100);
        open(&mut c, "h1");
    }

    #[test]
    #[should_panic(expected = "only the game server")]
    fn only_server_closes() {
        let mut c = setup();
        open(&mut c, "h1");
        ctx("player.testnet", 101);
        let (s, salt, _) = tobin();
        c.close_haggle("h1".into(), s, salt, Some(33));
    }

    #[test]
    #[should_panic(expected = "already closed")]
    fn cannot_close_twice() {
        let mut c = setup();
        open(&mut c, "h1");
        let (s, salt, _) = tobin();
        c.close_haggle("h1".into(), s.clone(), salt.clone(), Some(27));
        c.close_haggle("h1".into(), s, salt, Some(27));
    }

    #[test]
    #[should_panic(expected = "already used")]
    fn haggle_ids_are_unique() {
        let mut c = setup();
        open(&mut c, "h1");
        open(&mut c, "h1");
    }

    #[test]
    #[should_panic(expected = "can't afford")]
    fn player_must_afford_the_deal() {
        let mut c = setup();
        open(&mut c, "h1");
        let (mut s, salt, _) = tobin();
        // Reuse the hashing to build a fresh, honest haggle with a huge floor.
        s.floor = 500;
        s.list_price = 600;
        let commitment = commitment_of(&s, &salt);
        c.open_haggle("h2".into(), acc("player.testnet"), "tobin".into(), "lamp".into(), commitment);
        c.close_haggle("h2".into(), s, salt, Some(500));
    }

    #[test]
    fn unrevealed_haggles_expire_publicly() {
        let mut c = setup();
        open(&mut c, "h1");
        ctx("anyone.testnet", 100 + REVEAL_WINDOW_BLOCKS);
        c.expire_haggle("h1".into());
        assert_eq!(c.get_haggle("h1".into()).unwrap().status, Status::Expired);
        assert_eq!(c.stats().unrevealed, 1);
    }

    #[test]
    #[should_panic(expected = "reveal window still open")]
    fn cannot_expire_early() {
        let mut c = setup();
        open(&mut c, "h1");
        ctx("anyone.testnet", 101);
        c.expire_haggle("h1".into());
    }

    #[test]
    #[should_panic(expected = "already closed")]
    fn expired_haggle_cannot_be_settled() {
        let mut c = setup();
        open(&mut c, "h1");
        ctx("anyone.testnet", 100 + REVEAL_WINDOW_BLOCKS);
        c.expire_haggle("h1".into());
        ctx("server.testnet", 100 + REVEAL_WINDOW_BLOCKS);
        let (s, salt, _) = tobin();
        c.close_haggle("h1".into(), s, salt, Some(27));
    }
}
