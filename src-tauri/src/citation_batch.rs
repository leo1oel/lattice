//! Exact-ID Semantic Scholar hydration, not twenty parallel title searches.
//! Misses are left to the existing audit; they never mean "reference valid".
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const BATCH_SIZE: usize = 20;
static LAST_BATCH: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Paper {
    pub external_ids: BTreeMap<String, serde_json::Value>,
    pub title: String,
    pub venue: Option<String>,
    pub year: Option<u32>,
    pub citation_styles: Option<CitationStyles>,
}

#[derive(Deserialize)]
pub(crate) struct CitationStyles {
    pub bibtex: String,
}

pub(crate) fn lookup(ids: &[String]) -> Result<BTreeMap<String, Paper>, String> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let key = crate::literature_credentials::semanticscholar_key()?;
    // The server coordinates public quota across clients; this guard also
    // avoids overlapping local batches when using personal credentials.
    let mut last = LAST_BATCH.try_lock().map_err(|_| "Batch service busy.")?;
    if let Some(previous) = *last {
        std::thread::sleep(Duration::from_millis(1100).saturating_sub(previous.elapsed()));
    }
    *last = Some(Instant::now());
    drop(last);
    lookup_at(
        ids,
        key.as_deref(),
        "https://api.semanticscholar.org/graph/v1/paper/batch",
    )
}

fn lookup_at(
    ids: &[String],
    key: Option<&str>,
    endpoint: &str,
) -> Result<BTreeMap<String, Paper>, String> {
    if ids.len() > BATCH_SIZE {
        return Err("Too many papers in an audit batch.".into());
    }
    let ids = ids
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create batch client.")?;
    let url = format!("{endpoint}?fields=externalIds,title,venue,year,citationStyles");
    let mut request = crate::literature_service::request(
        &client,
        &url,
        Some(serde_json::json!({ "ids": ids })),
        key.is_none(),
    )?;
    if let Some(key) = key {
        request = request.header("x-api-key", key);
    }
    // Exactly one request. In particular, a 429 never starts a retry loop.
    let response = request.send().map_err(|_| "Batch service unavailable.")?;
    if !response.status().is_success() {
        return Err(format!(
            "Batch service returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let papers: Vec<serde_json::Value> = response.json().map_err(|_| "Invalid batch response.")?;
    if papers.len() != ids.len() {
        return Err("Incomplete batch response.".into());
    }
    // Nulls retain their position. Confirm the external ID too: response order
    // alone must never attach another paper's metadata to a bibliography entry.
    Ok(ids
        .into_iter()
        .zip(papers)
        .filter_map(|(id, paper)| {
            let paper: Paper = serde_json::from_value(paper).ok()?;
            let (kind, value) = id.split_once(':')?;
            let external = paper
                .external_ids
                .get(if kind == "DOI" { "DOI" } else { "ArXiv" })?
                .as_str()?;
            external.eq_ignore_ascii_case(value).then_some((id, paper))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_deduplicates_and_rejects_misidentified_results() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/batch", server.server_addr());
        let responder = std::thread::spawn(move || {
            let mut request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Post);
            let body: serde_json::Value = serde_json::from_reader(request.as_reader()).unwrap();
            assert_eq!(
                body["ids"],
                serde_json::json!(["ARXIV:1706.03762", "DOI:10.1234/a", "DOI:10.1234/b"])
            );
            request.respond(tiny_http::Response::from_string(r#"[
                {"externalIds":{"ArXiv":"1706.03762"},"title":"Attention","venue":"NeurIPS","year":2017},
                null,
                {"externalIds":{"DOI":"10.1234/wrong"},"title":"Wrong paper"}
            ]"#)).unwrap();
        });
        let ids = [
            "DOI:10.1234/b",
            "ARXIV:1706.03762",
            "DOI:10.1234/a",
            "DOI:10.1234/a",
        ]
        .map(str::to_string);
        let papers = lookup_at(&ids, None, &endpoint).unwrap();
        responder.join().unwrap();
        assert_eq!(papers.len(), 1);
        assert_eq!(papers["ARXIV:1706.03762"].title, "Attention");
    }

    #[test]
    fn rate_limit_is_one_request_and_never_echoes_the_key() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/batch", server.server_addr());
        let responder = std::thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert!(request
                .headers()
                .iter()
                .any(|h| h.field.equiv("x-api-key") && h.value.as_str() == "test-only-secret"));
            request.respond(tiny_http::Response::empty(429)).unwrap();
            assert!(server
                .recv_timeout(Duration::from_millis(100))
                .unwrap()
                .is_none());
        });
        let error = lookup_at(
            &["DOI:10.1234/a".into()],
            Some("test-only-secret"),
            &endpoint,
        )
        .err()
        .unwrap();
        responder.join().unwrap();
        assert!(error.contains("429"));
        assert!(!error.contains("test-only-secret"));
    }
}
