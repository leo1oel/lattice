//! HTTP plumbing shared by the literature providers (OpenAlex, Semantic
//! Scholar, Crossref). The public service returns metadata, never shared
//! provider credentials. Callers with personal credentials keep talking
//! directly to the provider.
use reqwest::blocking::{Client, RequestBuilder};
use serde_json::Value;
use std::time::Duration;

pub(crate) const ENDPOINT: &str = "https://lattice-literature.paperlattice.workers.dev/v1/query";

/// A blocking client that never follows redirects, so a provider response
/// cannot bounce a query, or the API key attached to it, to another host.
pub(crate) fn client(timeout: Duration, user_agent: Option<&str>) -> reqwest::Result<Client> {
    let mut builder =
        Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none());
    if let Some(agent) = user_agent {
        builder = builder.user_agent(agent);
    }
    builder.build()
}

pub(crate) fn request(
    client: &Client, url: &str, body: Option<Value>, public: bool,
) -> Result<RequestBuilder, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid literature URL.")?;
    let provider = match parsed.host_str() {
        Some("api.openalex.org") => Some("openalex"),
        Some("api.semanticscholar.org") if public => {
            return Err("Semantic Scholar requires a personal API key.".into())
        }
        Some("api.semanticscholar.org") => Some("semanticscholar"),
        Some("api.crossref.org") => Some("crossref"),
        _ => None,
    };
    if let Some(provider) = provider.filter(|_| public) {
        let params = parsed
            .query_pairs()
            .filter(|(key, _)| !matches!(key.as_ref(), "api_key" | "mailto"))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut payload = serde_json::json!({
            "provider": provider, "path": parsed.path(), "params": params,
        });
        if let Some(body) = body {
            payload["body"] = body;
        }
        return Ok(client.post(ENDPOINT).json(&payload));
    }
    Ok(match body {
        Some(body) => client.post(url).json(&body),
        None => client.get(url),
    })
}

/// Serve exactly one request on a loopback port for a provider test. Returns
/// the server's base URL and the responder thread; join it so assertions made
/// inside `respond` fail the test.
#[cfg(test)]
pub(crate) fn serve_once(
    respond: impl FnOnce(tiny_http::Request) + Send + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr());
    let responder = std::thread::spawn(move || {
        respond(server.recv_timeout(Duration::from_secs(10)).unwrap().expect("one request"))
    });
    (base, responder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "calls the deployed public literature service using shared quota"]
    fn live_public_metadata_without_personal_credentials() {
        let client = client(Duration::from_secs(10), None).unwrap();
        for (url, pointer, expected) in [
            (
                "https://api.openalex.org/works/https://doi.org/10.1038/nphys1170",
                "/doi",
                "https://doi.org/10.1038/nphys1170",
            ),
            (
                "https://api.crossref.org/works/10.1038/nphys1170",
                "/message/DOI",
                "10.1038/nphys1170",
            ),
        ] {
            let response = request(&client, url, None, true).unwrap().send().unwrap();
            let status = response.status();
            let payload: Value = response.json().unwrap();
            assert!(
                status.is_success(),
                "public lookup {url} returned {status}: {}",
                payload.get("error").and_then(Value::as_str).unwrap_or("unknown error")
            );
            assert_eq!(payload.pointer(pointer).and_then(Value::as_str), Some(expected));
        }
    }

    #[test]
    fn public_semantic_scholar_requests_are_rejected() {
        let error = request(
            &Client::new(),
            "https://api.semanticscholar.org/graph/v1/paper/batch?fields=title&api_key=private&mailto=private",
            Some(serde_json::json!({"ids": ["ARXIV:1706.03762"]})),
            true,
        )
        .err()
        .unwrap();
        assert!(error.contains("personal API key"));
    }

    #[test]
    fn personal_access_and_local_test_servers_stay_direct() {
        for (url, public) in [
            ("https://api.openalex.org/works?search=paper", false),
            ("http://127.0.0.1:12345/works", true),
        ] {
            let request = request(&Client::new(), url, None, public).unwrap().build().unwrap();
            assert_eq!(request.url().as_str(), url);
            assert_eq!(request.method(), reqwest::Method::GET);
        }
    }
}
