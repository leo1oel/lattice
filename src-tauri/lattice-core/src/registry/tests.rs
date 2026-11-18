//! The registry client against a loopback server, with lists signed by a
//! throwaway key made here (never the registry's own): the same minisign
//! format the registry's CI writes, pre-hashed with BLAKE2b-512.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use blake2::{Blake2b512, Digest as _};
use ring::signature::{Ed25519KeyPair, KeyPair};

use super::*;

struct Key {
    pair: Ed25519KeyPair,
    id: [u8; 8],
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl Key {
    fn new(seed: u8) -> Self {
        Key { pair: Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap(), id: [seed; 8] }
    }

    fn public(&self) -> PublicKey {
        let bytes = [b"Ed".as_slice(), &self.id, self.pair.public_key().as_ref()].concat();
        PublicKey::from_base64(&b64(&bytes)).unwrap()
    }

    fn sign(&self, body: &[u8], comment: &str) -> String {
        let signature = self.pair.sign(&Blake2b512::digest(body));
        let line = [b"ED".as_slice(), &self.id, signature.as_ref()].concat();
        let global = self.pair.sign(&[signature.as_ref(), comment.as_bytes()].concat());
        format!(
            "untrusted comment: test\n{}\ntrusted comment: {comment}\n{}\n",
            b64(&line),
            b64(global.as_ref())
        )
    }
}

/// A Pages site on loopback whose files a test replaces as it goes.
#[derive(Clone)]
struct Site {
    url: String,
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl Site {
    fn start() -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr().to_ip().unwrap());
        let files: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
        let served = files.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let body = served.lock().unwrap().get(request.url()).cloned();
                let _ = match body {
                    Some(body) => request.respond(tiny_http::Response::from_data(body)),
                    None => request.respond(tiny_http::Response::empty(404)),
                };
            }
        });
        Site { url, files }
    }

    fn put(&self, path: &str, body: impl Into<Vec<u8>>) {
        self.files.lock().unwrap().insert(format!("/{path}"), body.into());
    }

    fn take_down(&self) {
        self.files.lock().unwrap().clear();
    }

    /// Publishes a signed index and block list at `serial`, serving each
    /// theme file (id, version) the index lists.
    fn publish(&self, key: &Key, serial: u64, themes: &[(&str, &str)], blocked: &str) {
        let entries: Vec<String> = themes
            .iter()
            .map(|(id, version)| {
                let file = theme_file(id, version);
                let path = format!("themes/{id}/{version}.lattice-theme.json");
                let entry = format!(
                    r##"{{"id":"{id}","name":"{id}","version":"{version}","author":null,"license":"MIT","description":null,"repository":"https://github.com/example/themes","tag":"v{version}","commit":"0000000000000000000000000000000000000000","path":"theme.json","url":"{}/{path}","sha256":"{:x}","size":{},"variants":[{{"id":"night","name":null,"appearance":"dark","colors":{{"chrome":"#101018"}}}}]}}"##,
                    self.url,
                    Sha256::digest(file.as_bytes()),
                    file.len()
                );
                self.put(&path, file);
                entry
            })
            .collect();
        let index = format!(
            r#"{{"format":1,"serial":{serial},"generated":"2026-11-18T12:00:00.000Z","themes":[{}],"plugins":[]}}"#,
            entries.join(",")
        );
        let blocked = format!(
            r#"{{"format":1,"serial":{serial},"generated":"2026-11-18T12:00:00.000Z","blocked":{blocked}}}"#
        );
        self.put("index.json.minisig", key.sign(index.as_bytes(), &comment("index.json", serial)));
        self.put(
            "blocked.json.minisig",
            key.sign(blocked.as_bytes(), &comment("blocked.json", serial)),
        );
        self.put("index.json", index);
        self.put("blocked.json", blocked);
    }
}

fn comment(file: &str, serial: u64) -> String {
    format!("lattice-plugins file:{file} serial:{serial}")
}

fn theme_file(id: &str, version: &str) -> String {
    format!(
        r##"{{"schema":1,"id":"{id}","name":"{id}","version":"{version}","variants":[{{"id":"night","appearance":"dark","colors":{{"chrome":"#101018"}}}}]}}"##
    )
}

struct Fixture {
    dir: PathBuf,
    site: Site,
    key: Key,
    registry: Registry,
    store: ThemeStore,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("lattice-registry-{}", uuid::Uuid::new_v4()));
    let site = Site::start();
    let key = Key::new(7);
    let registry = Registry::with(dir.join("registry"), &site.url, vec![key.public()]);
    let store = ThemeStore::new(&dir);
    Fixture { dir, site, key, registry, store }
}

const NO_BLOCKS: &str = "[]";

fn refused(status: &Status) -> &str {
    match status {
        Status::Refused { message } => message,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_embedded_keys_are_the_registrys() {
    let ids: Vec<String> = verify::PUBLIC_KEYS
        .iter()
        .map(|key| {
            PublicKey::from_base64(key).unwrap();
            let bytes = base64::engine::general_purpose::STANDARD.decode(key).unwrap();
            bytes[2..10].iter().rev().map(|byte| format!("{byte:02X}")).collect()
        })
        .collect();
    assert_eq!(ids, ["03272612D22DB2A5", "D520097EDBD2D0F4"]);
}

#[test]
fn a_signature_verifies_only_for_its_key_file_and_serial() {
    let (key, other) = (Key::new(1), Key::new(2));
    let keys = [other.public(), key.public()];
    let body = br#"{"serial":4}"#;
    let good = key.sign(body, &comment("index.json", 4));
    assert_eq!(verify::verify(&keys, "index.json", body, &good, 4), Ok(()));
    // Either trusted key may sign.
    assert!(verify::verify(&keys[..1], "index.json", body, &good, 4).is_err());
    let tampered = br#"{"serial":5}"#;
    let bad = verify::verify(&keys, "index.json", tampered, &good, 4).unwrap_err();
    assert!(bad.contains("no valid signature"), "{bad}");
    let untrusted = Key::new(3).sign(body, &comment("index.json", 4));
    assert!(verify::verify(&keys, "index.json", body, &untrusted, 4).is_err());
    let wrong_file = key.sign(body, &comment("blocked.json", 4));
    let moved = verify::verify(&keys, "index.json", body, &wrong_file, 4).unwrap_err();
    assert!(moved.contains("another file or serial"), "{moved}");
    assert!(verify::verify(&keys, "index.json", body, &good, 5).is_err());
    assert!(verify::verify(&keys, "index.json", body, "not a signature", 4).is_err());
}

#[test]
fn a_fetched_list_is_cached_and_served_offline() {
    let f = fixture();
    let empty = f.registry.listing(&f.store, false);
    assert!(empty.index.is_none() && empty.status == Status::Cached);
    f.site.publish(&f.key, 2, &[("dev.example.ink", "1.0.0")], NO_BLOCKS);
    let fresh = f.registry.listing(&f.store, true);
    assert_eq!(fresh.status, Status::Fresh);
    assert_eq!(fresh.index.as_ref().unwrap().themes[0].id, "dev.example.ink");
    f.site.take_down();
    let offline = f.registry.listing(&f.store, true);
    assert!(matches!(&offline.status, Status::Offline { message } if message.contains("HTTP 404")));
    assert_eq!(offline.index.unwrap().serial, 2);
    assert_eq!(offline.fetched_at, fresh.fetched_at);
}

#[test]
fn an_older_or_forged_list_is_refused_and_the_cache_kept() {
    let f = fixture();
    f.site.publish(&f.key, 3, &[], NO_BLOCKS);
    assert_eq!(f.registry.listing(&f.store, true).status, Status::Fresh);
    f.site.publish(&f.key, 2, &[], NO_BLOCKS);
    let rollback = f.registry.listing(&f.store, true);
    assert!(refused(&rollback.status).contains("older list (serial 2 after 3)"));
    assert_eq!(rollback.index.unwrap().serial, 3);
    f.site.publish(&Key::new(9), 4, &[], NO_BLOCKS);
    let forged = f.registry.listing(&f.store, true);
    assert!(refused(&forged.status).contains("no valid signature"));
    // An index and block list from two publishes do not pair up.
    f.site.publish(&f.key, 5, &[], NO_BLOCKS);
    let old_blocked =
        f.key.sign(br#"{"format":1,"serial":4,"blocked":[]}"#, &comment("blocked.json", 4));
    f.site.put("blocked.json", r#"{"format":1,"serial":4,"blocked":[]}"#);
    f.site.put("blocked.json.minisig", old_blocked);
    let torn = f.registry.listing(&f.store, true);
    assert!(refused(&torn.status).contains("updating its list"));
    assert_eq!(torn.index.unwrap().serial, 3);
}

#[test]
fn installs_record_their_version_offer_updates_and_report_blocks() {
    let f = fixture();
    let ink = "dev.example.ink";
    assert!(f.registry.install_theme(&f.store, ink).unwrap_err().contains("Load the theme list"));
    f.site.publish(&f.key, 1, &[(ink, "1.0.0")], NO_BLOCKS);
    f.registry.listing(&f.store, true);
    assert_eq!(f.registry.install_theme(&f.store, ink).unwrap().version, "1.0.0");
    let current = f.registry.listing(&f.store, false).installed;
    assert_eq!(
        current,
        [InstalledTheme { id: ink.into(), version: "1.0.0".into(), update: None, blocked: None }]
    );

    let bad = r#"[{"id":"dev.example.bad","versions":"*","action":"disable","reason":"Phishes."}]"#;
    f.site.publish(&f.key, 2, &[(ink, "1.1.0"), ("dev.example.bad", "1.0.0")], bad);
    let listing = f.registry.listing(&f.store, true);
    assert_eq!(listing.installed[0].update.as_deref(), Some("1.1.0"));
    let refused = f.registry.install_theme(&f.store, "dev.example.bad").unwrap_err();
    assert_eq!(refused, "dev.example.bad 1.0.0 is blocked: Phishes.");
    assert!(f.store.get("dev.example.bad").is_none());

    let ink_blocked =
        r#"[{"id":"dev.example.ink","versions":"<=1.0.0","action":"warn","reason":"Unreadable."}]"#;
    f.site.publish(&f.key, 3, &[(ink, "1.1.0")], ink_blocked);
    let listing = f.registry.listing(&f.store, true);
    assert_eq!(listing.installed[0].blocked.as_ref().unwrap().reason, "Unreadable.");
    f.registry.install_theme(&f.store, ink).unwrap();
    let updated = &f.registry.listing(&f.store, false).installed[0];
    assert_eq!(
        (updated.version.as_str(), &updated.update, &updated.blocked),
        ("1.1.0", &None, &None)
    );
}

#[test]
fn a_download_that_does_not_match_the_index_is_refused() {
    let f = fixture();
    let ink = "dev.example.ink";
    f.site.publish(&f.key, 1, &[(ink, "1.0.0")], NO_BLOCKS);
    f.registry.listing(&f.store, true);
    let path = format!("themes/{ink}/1.0.0.lattice-theme.json");
    let swapped = theme_file(ink, "1.0.0").replace("#101018", "#ff0000");
    f.site.put(&path, swapped);
    let err = f.registry.install_theme(&f.store, ink).unwrap_err();
    assert!(err.contains("checksum"), "{err}");
    let file = theme_file(ink, "1.0.0");
    f.site.put(&path, &file.as_bytes()[..file.len() - 1]);
    let err = f.registry.install_theme(&f.store, ink).unwrap_err();
    assert!(err.contains("not the size"), "{err}");
    assert!(f.store.get(ink).is_none());
    assert!(f.registry.listing(&f.store, false).installed.is_empty());
}

#[test]
fn block_ranges_match_like_npm_and_fail_closed() {
    assert!(verify::version_in("*", "9.9.9"));
    assert!(verify::version_in("<=0.3.1", "0.3.1"));
    assert!(!verify::version_in("<=0.3.1", "0.3.2"));
    assert!(verify::version_in(">=1.0.0 <1.2.0", "1.1.5"));
    assert!(!verify::version_in(">= 1.0.0 < 1.2.0", "1.2.0"));
    assert!(verify::version_in("1.0.0 || 2.0.0", "2.0.0"));
    assert!(!verify::version_in("1.0.0", "1.0.1"));
    assert!(verify::version_in("not a range", "1.0.0"));
    assert!(verify::newer("1.10.0", "1.9.0"));
    assert!(!verify::newer("1.0.0", "1.0.0"));
}
