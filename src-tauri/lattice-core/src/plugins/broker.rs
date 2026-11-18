//! The host calls a plugin may make while a command runs, each checked
//! against what the writer granted. A call outside the grant fails with
//! `PERMISSION_DENIED` and the permission it needed, so a plugin can tell
//! the writer what to enable instead of guessing.
//!
//! There is no call that writes a file. "Read-only" is structural in API
//! level 1, not a promise: a change reaches the project only as an action
//! the writer confirms in Lattice's own UI.

use super::protocol::{
    error_codes, BibliographyEntriesParams, BibliographyEntriesResult, BibliographyEntry,
    BibliographyFile, HttpFetchParams, HttpFetchResult, Permissions, ProjectRead, SecretsGetParams,
    SecretsGetResult,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const MAX_BODY: usize = 4 << 20;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// A JSON-RPC error a host call answers with.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RpcError {
    pub(crate) code: i64,
    pub(crate) message: String,
    pub(crate) data: Option<Value>,
}

impl RpcError {
    fn denied(permission: &str) -> Self {
        Self {
            code: error_codes::PERMISSION_DENIED,
            message: format!("This plugin was not granted {permission}."),
            data: Some(json!({ "permission": permission })),
        }
    }
    fn host(message: impl Into<String>) -> Self {
        Self { code: error_codes::HOST_ERROR, message: message.into(), data: None }
    }
    pub(crate) fn invalid_params(message: impl Into<String>) -> Self {
        Self { code: -32602, message: message.into(), data: None }
    }
    pub(crate) fn no_method(method: &str) -> Self {
        Self { code: -32601, message: format!("Unknown method {method}."), data: None }
    }
}

/// Where a plugin's secrets live: the Keychain in the app, memory in tests.
pub trait SecretStore: Send + Sync {
    fn get(&self, plugin: &str, name: &str) -> Result<Option<String>, String>;
    fn set(&self, plugin: &str, name: &str, value: Option<&str>) -> Result<(), String>;
}

/// The Keychain (Secret Service on Linux), one item per plugin secret.
pub struct KeyringSecrets;

impl KeyringSecrets {
    fn entry(plugin: &str, name: &str) -> Result<keyring::Entry, String> {
        let service = format!("{}.plugins", crate::app_identity::identifier());
        keyring::Entry::new(&service, &format!("{plugin}/{name}"))
            .map_err(|_| "The secure credential store is unavailable.".to_string())
    }
}

impl SecretStore for KeyringSecrets {
    fn get(&self, plugin: &str, name: &str) -> Result<Option<String>, String> {
        match Self::entry(plugin, name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Cannot read the plugin's secret: {e}")),
        }
    }
    fn set(&self, plugin: &str, name: &str, value: Option<&str>) -> Result<(), String> {
        let entry = Self::entry(plugin, name)?;
        match value {
            Some(value) => {
                entry.set_password(value).map_err(|e| format!("Cannot save the secret: {e}"))
            }
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("Cannot remove the secret: {e}")),
            },
        }
    }
}

pub(crate) struct Broker<'a> {
    pub(crate) plugin_id: &'a str,
    pub(crate) granted: &'a Permissions,
    pub(crate) project_root: Option<&'a Path>,
    pub(crate) secrets: &'a dyn SecretStore,
}

impl Broker<'_> {
    pub(crate) fn handle(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        fn parsed<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, RpcError> {
            serde_json::from_value(params).map_err(|e| RpcError::invalid_params(e.to_string()))
        }
        let result = match method {
            "bibliography/entries" => serde_json::to_value(self.bibliography(parsed(params)?)?),
            "http/fetch" => serde_json::to_value(self.fetch(parsed(params)?)?),
            "secrets/get" => serde_json::to_value(self.secret(parsed(params)?)?),
            _ => return Err(RpcError::no_method(method)),
        };
        result.map_err(|e| RpcError::host(e.to_string()))
    }

    fn bibliography(
        &self, params: BibliographyEntriesParams,
    ) -> Result<BibliographyEntriesResult, RpcError> {
        if !self.granted.reads(ProjectRead::Bibliography) {
            return Err(RpcError::denied("project-read: bibliography"));
        }
        let root = self.project_root.ok_or_else(|| RpcError::host("No project is open."))?;
        let sources = crate::project::iter_bibliography_sources(root).map_err(RpcError::host)?;
        let files = sources
            .into_iter()
            .filter(|(path, _)| params.file.as_ref().is_none_or(|wanted| wanted == path))
            .map(|(path, text)| bibliography_file(path, &text))
            .collect();
        Ok(BibliographyEntriesResult { files })
    }

    fn fetch(&self, params: HttpFetchParams) -> Result<HttpFetchResult, RpcError> {
        let url =
            url::Url::parse(&params.url).map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let origin = url.origin().ascii_serialization();
        if !self.granted.network.contains(&origin) {
            return Err(RpcError::denied(&format!("network: {origin}")));
        }
        let method = params.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
        let method = match method.as_str() {
            "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" => {
                reqwest::Method::from_bytes(method.as_bytes())
            }
            _ => return Err(RpcError::invalid_params(format!("Unsupported method {method}."))),
        }
        .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        if params.body.as_ref().is_some_and(|b| b.len() > MAX_BODY) {
            return Err(RpcError::invalid_params("The request body is larger than 4 MiB."));
        }
        let allowed = self.granted.network.clone();
        // A redirect may only lead to another declared origin, or the grant
        // would be one hop from any host on the internet.
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            let declared = allowed.contains(&attempt.url().origin().ascii_serialization());
            if declared && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        let client =
            crate::http::blocking_as(&format!("Lattice/{} plugin", crate::VERSION), FETCH_TIMEOUT)
                .redirect(policy)
                .build()
                .map_err(|e| RpcError::host(e.to_string()))?;
        let mut request = client.request(method, url);
        for (name, value) in &params.headers {
            if !matches!(name.to_ascii_lowercase().as_str(), "host" | "cookie" | "content-length") {
                request = request.header(name, value);
            }
        }
        if let Some(body) = params.body {
            request = request.body(body);
        }
        let response =
            request.send().map_err(|e| RpcError::host(format!("The request failed: {e}")))?;
        let status = response.status().as_u16();
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        for (name, value) in response.headers() {
            let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
            headers
                .entry(name.as_str().to_string())
                .and_modify(|v| {
                    v.push_str(", ");
                    v.push_str(&value);
                })
                .or_insert(value);
        }
        let mut body = Vec::new();
        response
            .take(MAX_BODY as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|e| RpcError::host(format!("The response could not be read: {e}")))?;
        if body.len() > MAX_BODY {
            return Err(RpcError::host("The response is larger than 4 MiB."));
        }
        Ok(HttpFetchResult { status, headers, body: String::from_utf8_lossy(&body).into_owned() })
    }

    fn secret(&self, params: SecretsGetParams) -> Result<SecretsGetResult, RpcError> {
        if !self.granted.secrets.contains(&params.name) {
            return Err(RpcError::denied(&format!("secrets: {}", params.name)));
        }
        let value = self.secrets.get(self.plugin_id, &params.name).map_err(RpcError::host)?;
        Ok(SecretsGetResult { value })
    }
}

fn bibliography_file(path: String, text: &str) -> BibliographyFile {
    let document = match crate::bib_document::parse(text) {
        Ok(document) => document,
        Err(error) => {
            return BibliographyFile { path, entries: Vec::new(), error: Some(error.message()) }
        }
    };
    let entries = document
        .entries
        .iter()
        .map(|entry| BibliographyEntry {
            key: entry.key.clone(),
            entry_type: entry.kind.clone(),
            fields: entry
                .fields
                .iter()
                .map(|field| {
                    let raw = &text[field.value_from..field.value_to];
                    (
                        field.name.to_lowercase(),
                        crate::bib_document::expand_value(raw, &document.macros),
                    )
                })
                .collect(),
            line: u32::try_from(entry.line).unwrap_or(u32::MAX),
        })
        .collect();
    BibliographyFile { path, entries, error: None }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct MemorySecrets(pub(crate) Mutex<BTreeMap<String, String>>);

    impl SecretStore for MemorySecrets {
        fn get(&self, plugin: &str, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(&format!("{plugin}/{name}")).cloned())
        }
        fn set(&self, plugin: &str, name: &str, value: Option<&str>) -> Result<(), String> {
            let mut map = self.0.lock().unwrap();
            let key = format!("{plugin}/{name}");
            match value {
                Some(v) => map.insert(key, v.to_string()),
                None => map.remove(&key),
            };
            Ok(())
        }
    }

    fn broker<'a>(
        granted: &'a Permissions, root: Option<&'a Path>, secrets: &'a MemorySecrets,
    ) -> Broker<'a> {
        Broker { plugin_id: "dev.test.p", granted, project_root: root, secrets }
    }

    #[test]
    fn bibliography_entries_need_the_bibliography_grant() {
        let fixture = crate::project::test_support::Fixture::project("plugin-broker-bib");
        let project = fixture.root.as_path();
        fixture.write("refs.bib", "@string{acm = {ACM}}\n@article{knuth84, title = {Literate Programming}, publisher = acm}\n");
        let secrets = MemorySecrets::default();
        let none = Permissions::default();
        let denied = broker(&none, Some(project), &secrets)
            .handle("bibliography/entries", json!({}))
            .unwrap_err();
        assert_eq!(denied.code, error_codes::PERMISSION_DENIED);
        assert_eq!(denied.data, Some(json!({"permission": "project-read: bibliography"})));

        let granted =
            Permissions { project_read: vec![ProjectRead::Bibliography], ..Default::default() };
        let value = broker(&granted, Some(project), &secrets)
            .handle("bibliography/entries", json!({}))
            .unwrap();
        let result: BibliographyEntriesResult = serde_json::from_value(value).unwrap();
        let file = result.files.iter().find(|f| f.path == "refs.bib").expect("refs.bib");
        assert_eq!(file.entries[0].key, "knuth84");
        assert_eq!(file.entries[0].fields["publisher"], "ACM");
        assert_eq!(file.entries[0].line, 2);
    }

    #[test]
    fn fetch_reaches_only_declared_origins() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let origin = format!("http://127.0.0.1:{port}");
        let handle = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            let auth = request.headers().iter().any(|h| h.field.equiv("x-token") && h.value == "t");
            request
                .respond(tiny_http::Response::from_string(if auth { "ok" } else { "no" }))
                .unwrap();
        });
        let secrets = MemorySecrets::default();
        let none = Permissions::default();
        let denied = broker(&none, None, &secrets)
            .handle("http/fetch", json!({"url": format!("{origin}/x")}))
            .unwrap_err();
        assert_eq!(denied.data, Some(json!({"permission": format!("network: {origin}")})));

        let granted = Permissions { network: vec![origin.clone()], ..Default::default() };
        let value = broker(&granted, None, &secrets)
            .handle(
                "http/fetch",
                json!({"url": format!("{origin}/x"), "headers": {"x-token": "t"}}),
            )
            .unwrap();
        handle.join().unwrap();
        let result: HttpFetchResult = serde_json::from_value(value).unwrap();
        assert_eq!((result.status, result.body.as_str()), (200, "ok"));
    }

    #[test]
    fn secrets_are_per_plugin_and_per_declared_name() {
        let secrets = MemorySecrets::default();
        secrets.set("dev.test.p", "api-key", Some("k")).unwrap();
        secrets.set("dev.other.p", "token", Some("x")).unwrap();
        let granted = Permissions { secrets: vec!["api-key".into()], ..Default::default() };
        let b = broker(&granted, None, &secrets);
        assert_eq!(
            b.handle("secrets/get", json!({"name": "api-key"})).unwrap(),
            json!({"value": "k"})
        );
        assert_eq!(
            b.handle("secrets/get", json!({"name": "token"})).unwrap_err().code,
            error_codes::PERMISSION_DENIED
        );
        assert_eq!(b.handle("project/readFile", json!({})).unwrap_err().code, -32601);
    }
}
