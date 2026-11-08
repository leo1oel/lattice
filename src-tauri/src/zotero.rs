//! Reading the writer's Zotero library through the desktop app's local API
//! (Zotero 7 and later, `http://127.0.0.1:23119/api/`, read-only), so a
//! collection comes into Papers without re-adding each paper.
//!
//! Only reads, and only the personal library (user id 0). Each item comes as
//! Zotero's own BibTeX export, with the Better BibTeX key put in when there is
//! one, so the keys a manuscript already cites keep working; the import itself
//! runs through the ordinary Add papers path, which skips what Papers holds.
//! The API refuses requests that look like a browser's, so Lattice is never
//! mistaken for one (its agent string does not start with `Mozilla/`).

use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

/// Zotero's connector server. 127.0.0.1, not `localhost`: Zotero listens on
/// IPv4 only, and `localhost` may resolve to `::1` first.
const ZOTERO_SERVER: &str = "http://127.0.0.1:23119";

/// The errors the frontend names in the writer's language; anything else is
/// shown as written.
pub const NOT_RUNNING: &str = "zotero-not-running";
pub const API_DISABLED: &str = "zotero-local-api-disabled";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroCollection {
    pub key: String,
    pub name: String,
    /// The collection it sits in; None at the top.
    pub parent: Option<String>,
    /// Items directly in it (not in its subcollections).
    pub items: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItem {
    /// The item's BibTeX entry, under `citation_key`.
    pub bibtex: String,
    pub citation_key: String,
    /// Its PDF attachment's item key, for `attachment_path`.
    pub pdf: Option<String>,
}

pub struct Zotero {
    server: String,
    client: Client,
}

impl Zotero {
    pub fn local() -> Result<Self, String> {
        Self::at(ZOTERO_SERVER)
    }

    fn at(server: &str) -> Result<Self, String> {
        // Never through a proxy: a configured HTTP(S)_PROXY would make a
        // running Zotero look absent. A large collection's export takes a while.
        let client = crate::http::loopback(Duration::from_secs(120))
            .user_agent(concat!("Lattice/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("Could not create the Zotero client: {error}"))?;
        Ok(Self { server: server.to_string(), client })
    }

    fn get(&self, path: &str) -> Result<reqwest::blocking::Response, String> {
        let url = format!("{}/api/users/0{path}", self.server);
        let response = self.client.get(&url).send().map_err(|error| {
            if error.is_connect() {
                NOT_RUNNING.to_string()
            } else {
                format!("Zotero did not answer: {error}")
            }
        })?;
        match response.status() {
            status if status.is_success() => Ok(response),
            StatusCode::FORBIDDEN => Err(API_DISABLED.to_string()),
            status => {
                let body = response.text().unwrap_or_default();
                Err(format!("Zotero answered HTTP {}: {}", status.as_u16(), body.trim()))
            }
        }
    }

    fn get_json(&self, path: &str) -> Result<Value, String> {
        self.get(path)?.json().map_err(|error| format!("Zotero sent an unreadable answer: {error}"))
    }

    /// Every collection of the personal library, by name.
    pub fn collections(&self) -> Result<Vec<ZoteroCollection>, String> {
        let listed = self.get_json("/collections")?;
        let mut collections: Vec<ZoteroCollection> = listed
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|collection| {
                let data = &collection["data"];
                Some(ZoteroCollection {
                    key: collection["key"].as_str()?.to_string(),
                    name: data["name"].as_str().unwrap_or_default().to_string(),
                    parent: data["parentCollection"].as_str().map(str::to_string),
                    items: collection["meta"]["numItems"].as_u64().unwrap_or(0),
                })
            })
            .collect();
        collections.sort_by_key(|collection| collection.name.to_lowercase());
        Ok(collections)
    }

    /// The top-level items of `collection` (the whole library when None),
    /// each as BibTeX under its Better BibTeX key when it has one.
    pub fn items(&self, collection: Option<&str>) -> Result<Vec<ZoteroItem>, String> {
        let scope = collection.map(|key| format!("/collections/{key}")).unwrap_or_default();
        let listed = self.get_json(&format!("{scope}/items/top?include=data,bibtex"))?;
        let items = listed.as_array().cloned().unwrap_or_default();
        let keys: Vec<&str> = items.iter().filter_map(|item| item["key"].as_str()).collect();
        let better_bibtex = self.better_bibtex_keys(&keys);
        Ok(items
            .iter()
            .filter_map(|item| {
                let bibtex =
                    item["bibtex"].as_str().map(str::trim).filter(|text| text.starts_with('@'))?;
                let exported = entry_key(bibtex)?;
                let data = &item["data"];
                // Better BibTeX's live key, else Zotero's own citation-key
                // field, else a key pinned in Extra.
                let pinned = [
                    item["key"].as_str().and_then(|key| better_bibtex.get(key).cloned()),
                    data["citationKey"].as_str().map(str::to_string),
                    extra_citation_key(data["extra"].as_str().unwrap_or_default()),
                ]
                .into_iter()
                .flatten()
                .find(|key| is_citation_key(key));
                let citation_key = pinned.unwrap_or_else(|| exported.to_string());
                let attachment = &item["links"]["attachment"];
                let pdf = (attachment["attachmentType"].as_str() == Some("application/pdf"))
                    .then(|| attachment["href"].as_str()?.rsplit('/').next().map(str::to_string))
                    .flatten();
                Some(ZoteroItem {
                    bibtex: without_file_field(&with_key(bibtex, &citation_key)),
                    citation_key,
                    pdf,
                })
            })
            .collect())
    }

    /// Better BibTeX's keys by item key, when it is installed; none otherwise.
    fn better_bibtex_keys(&self, keys: &[&str]) -> HashMap<String, String> {
        if keys.is_empty() {
            return HashMap::new();
        }
        let request = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "item.citationkey", "params": [keys],
        });
        let answer = self
            .client
            .post(format!("{}/better-bibtex/json-rpc", self.server))
            .json(&request)
            .send()
            .ok()
            .filter(|response| response.status().is_success())
            .and_then(|response| response.json::<Value>().ok());
        let Some(Value::Object(result)) = answer.map(|answer| answer["result"].clone()) else {
            return HashMap::new();
        };
        result
            .into_iter()
            .filter_map(|(key, citation_key)| {
                // Keys may come back library-qualified ("1:ABCD2345").
                let key = key.rsplit(':').next()?.to_string();
                Some((key, citation_key.as_str()?.to_string()))
            })
            .collect()
    }

    /// Where the attachment `key`'s file is on this Mac.
    pub fn attachment_path(&self, key: &str) -> Result<PathBuf, String> {
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!("Not a Zotero item key: {key}"));
        }
        let url =
            self.get(&format!("/items/{key}/file/view/url"))?.text().map_err(|e| e.to_string())?;
        reqwest::Url::parse(url.trim())
            .ok()
            .filter(|url| url.scheme() == "file")
            .and_then(|url| url.to_file_path().ok())
            .ok_or_else(|| "Zotero has no file on this Mac for this attachment.".to_string())
    }
}

/// A key a `\cite` can use.
fn is_citation_key(key: &str) -> bool {
    !key.is_empty() && !key.chars().any(|c| c.is_whitespace() || "{},%\"#'()=\\~".contains(c))
}

/// Better BibTeX's pinned key, as it writes it into Extra.
fn extra_citation_key(extra: &str) -> Option<String> {
    extra.lines().find_map(|line| {
        let (field, value) = line.split_once(':')?;
        field.trim().eq_ignore_ascii_case("citation key").then(|| value.trim().to_string())
    })
}

/// The key of a BibTeX entry `@type{key, …`.
fn entry_key(bibtex: &str) -> Option<&str> {
    let open = bibtex.find('{')?;
    let close = open + bibtex[open..].find(',')?;
    Some(bibtex[open + 1..close].trim()).filter(|key| !key.is_empty())
}

fn with_key(bibtex: &str, key: &str) -> String {
    let (Some(open), Some(exported)) = (bibtex.find('{'), entry_key(bibtex)) else {
        return bibtex.to_string();
    };
    let close = open + bibtex[open..].find(',').unwrap_or(0);
    debug_assert_eq!(bibtex[open + 1..close].trim(), exported);
    format!("{}{{{key}{}", &bibtex[..open], &bibtex[close..])
}

/// The entry without Zotero's `file = {…}` field: it lists paths on this Mac,
/// which have no place in a bibliography that syncs to co-authors.
fn without_file_field(bibtex: &str) -> String {
    let mut out = Vec::new();
    let mut lines = bibtex.lines();
    while let Some(line) = lines.next() {
        let field = line.trim_start();
        let is_file =
            field.split_once('=').is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("file"));
        if !is_file {
            out.push(line);
            continue;
        }
        // Skip to the end of its braced value, which may span lines.
        let mut depth = 0i32;
        let mut text = line.to_string();
        loop {
            depth += text.matches('{').count() as i32 - text.matches('}').count() as i32;
            if depth <= 0 {
                break;
            }
            match lines.next() {
                Some(next) => text = next.to_string(),
                None => break,
            }
        }
    }
    let mut joined = out.join("\n");
    // The field before it may now end the entry with a dangling comma.
    if let Some(at) = joined.rfind('}') {
        let head = joined[..at].trim_end();
        if let Some(stripped) = head.strip_suffix(',') {
            joined = format!("{stripped}\n{}", &joined[at..]);
        }
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A stand-in Zotero answering each path from `routes` (404 otherwise),
    /// recording what was asked.
    fn fake_zotero(routes: Vec<(&'static str, u16, String)>) -> (Zotero, Arc<Mutex<Vec<String>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let asked = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&asked);
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let url = request.url().to_string();
                log.lock().unwrap().push(format!("{} {url}", request.method()));
                let (status, body) = routes
                    .iter()
                    .find(|(path, _, _)| *path == url)
                    .map(|(_, status, body)| (*status, body.clone()))
                    .unwrap_or((404, "Not found".to_string()));
                let _ = request
                    .respond(tiny_http::Response::from_string(body).with_status_code(status));
            }
        });
        (Zotero::at(&base).unwrap(), asked)
    }

    const ENTRY: &str = "\n@article{lee_sparse_2024,\n\ttitle = {Sparse attention},\n\tauthor = {Lee, Ada},\n\tyear = {2024},\n\tfile = {Full Text PDF:/Users/ada/Zotero/storage/AB12CD34/Lee.pdf:application/pdf},\n}\n";

    #[test]
    fn collections_come_back_by_name_with_their_parents() {
        let collections = serde_json::json!([
            {"key": "BBBB2222", "data": {"name": "thesis", "parentCollection": false}, "meta": {"numItems": 3}},
            {"key": "AAAA1111", "data": {"name": "Related work", "parentCollection": "BBBB2222"}, "meta": {"numItems": 12}},
        ]);
        let (zotero, _) =
            fake_zotero(vec![("/api/users/0/collections", 200, collections.to_string())]);
        assert_eq!(
            zotero.collections().unwrap(),
            vec![
                ZoteroCollection {
                    key: "AAAA1111".into(),
                    name: "Related work".into(),
                    parent: Some("BBBB2222".into()),
                    items: 12
                },
                ZoteroCollection {
                    key: "BBBB2222".into(),
                    name: "thesis".into(),
                    parent: None,
                    items: 3
                },
            ]
        );
    }

    #[test]
    fn items_keep_the_better_bibtex_key_and_name_their_pdf() {
        let items = serde_json::json!([
            {
                "key": "ITEM0001",
                "data": {"extra": ""},
                "links": {"attachment": {"href": "http://localhost:23119/api/users/0/items/PDF00001", "attachmentType": "application/pdf"}},
                "bibtex": ENTRY,
            },
            {
                "key": "ITEM0002",
                "data": {"extra": "tex.note: x\nCitation Key: pinned2023"},
                "links": {"attachment": {"href": "http://localhost:23119/api/users/0/items/HTML0001", "attachmentType": "text/html"}},
                "bibtex": "@book{smith_book_2023,\n\ttitle = {A book},\n}",
            },
            {"key": "NOTE0001", "data": {}, "bibtex": ""},
        ]);
        let rpc = serde_json::json!({"jsonrpc": "2.0", "id": 1, "result": {"1:ITEM0001": "Lee2024Sparse"}});
        let (zotero, asked) = fake_zotero(vec![
            (
                "/api/users/0/collections/AAAA1111/items/top?include=data,bibtex",
                200,
                items.to_string(),
            ),
            ("/better-bibtex/json-rpc", 200, rpc.to_string()),
        ]);
        let imported = zotero.items(Some("AAAA1111")).unwrap();
        assert_eq!(imported.len(), 2);
        assert_eq!(imported[0].citation_key, "Lee2024Sparse");
        assert!(
            imported[0].bibtex.starts_with("@article{Lee2024Sparse,"),
            "{}",
            imported[0].bibtex
        );
        assert!(!imported[0].bibtex.contains("/Users/ada"), "{}", imported[0].bibtex);
        assert!(imported[0].bibtex.ends_with("year = {2024}\n}"), "{}", imported[0].bibtex);
        assert_eq!(imported[0].pdf.as_deref(), Some("PDF00001"));
        // No Better BibTeX key from the server: the key pinned in Extra.
        assert_eq!(imported[1].citation_key, "pinned2023");
        assert_eq!(imported[1].pdf, None);
        assert!(asked.lock().unwrap().iter().any(|line| line.starts_with("POST /better-bibtex")));
    }

    #[test]
    fn without_better_bibtex_the_export_key_stays() {
        let items =
            serde_json::json!([{"key": "ITEM0001", "data": {}, "links": {}, "bibtex": ENTRY}]);
        let (zotero, _) = fake_zotero(vec![(
            "/api/users/0/items/top?include=data,bibtex",
            200,
            items.to_string(),
        )]);
        assert_eq!(zotero.items(None).unwrap()[0].citation_key, "lee_sparse_2024");
    }

    #[test]
    fn a_closed_zotero_and_a_disabled_local_api_are_told_apart() {
        let (disabled, _) =
            fake_zotero(vec![("/api/users/0/collections", 403, "Local API is not enabled".into())]);
        assert_eq!(disabled.collections().unwrap_err(), API_DISABLED);
        // A port nothing listens on.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = closed.local_addr().unwrap();
        drop(closed);
        let absent = Zotero::at(&format!("http://{address}")).unwrap();
        assert_eq!(absent.collections().unwrap_err(), NOT_RUNNING);
    }

    #[test]
    fn an_attachment_resolves_to_its_file_on_this_mac() {
        let (zotero, _) = fake_zotero(vec![
            (
                "/api/users/0/items/PDF00001/file/view/url",
                200,
                "file:///Users/ada/Zotero/storage/AB12CD34/Lee%202024.pdf".into(),
            ),
            (
                "/api/users/0/items/LINK0001/file/view/url",
                400,
                "Not a file attachment: LINK0001".into(),
            ),
        ]);
        assert_eq!(
            zotero.attachment_path("PDF00001").unwrap(),
            PathBuf::from("/Users/ada/Zotero/storage/AB12CD34/Lee 2024.pdf")
        );
        assert!(zotero.attachment_path("LINK0001").is_err());
        assert!(zotero.attachment_path("../x").is_err());
    }
}
