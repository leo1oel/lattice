use super::{
    account::{self, Credentials},
    api::{self, WorkspaceRequest},
    oauth, GoogleState, OAuthClient, Product,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("lattice-google-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Clone)]
struct Seen {
    method: String,
    url: String,
    authorization: String,
    if_match: String,
    body: Value,
    raw: String,
}
struct Provider {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}
impl Provider {
    fn new(responses: Vec<(u16, Value)>) -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let capture = seen.clone();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let Some(mut request) = server.recv_timeout(Duration::from_secs(10)).unwrap()
                else {
                    return;
                };
                let mut raw = String::new();
                request.as_reader().read_to_string(&mut raw).unwrap();
                capture.lock().unwrap().push(Seen {
                    method: request.method().to_string(),
                    url: request.url().into(),
                    authorization: request
                        .headers()
                        .iter()
                        .find(|header| header.field.equiv("Authorization"))
                        .map(|header| header.value.as_str().to_owned())
                        .unwrap_or_default(),
                    if_match: request
                        .headers()
                        .iter()
                        .find(|header| header.field.equiv("If-Match"))
                        .map(|header| header.value.as_str().to_owned())
                        .unwrap_or_default(),
                    body: serde_json::from_str(&raw).unwrap_or(Value::Null),
                    raw,
                });
                request
                    .respond(
                        tiny_http::Response::from_string(body.to_string())
                            .with_status_code(status)
                            .with_header(
                                tiny_http::Header::from_bytes("Content-Type", "application/json")
                                    .unwrap(),
                            ),
                    )
                    .unwrap();
            }
        });
        Self { base, seen }
    }
}
fn credentials() -> Credentials {
    let products =
        vec![Product::Docs, Product::Sheets, Product::Slides, Product::Forms, Product::Calendar];
    let scopes = products
        .iter()
        .flat_map(|product| product.scopes())
        .copied()
        .chain(["https://www.googleapis.com/auth/drive.file"])
        .collect::<Vec<_>>()
        .join(" ");
    Credentials {
        client: OAuthClient {
            client_id: "fixture.apps.googleusercontent.com".into(),
            client_secret: "private-secret".into(),
            products,
        },
        access_token: "private-access".into(),
        refresh_token: "private-refresh".into(),
        expires_at: account::now() + 3600,
        scopes,
        email: Some("fixture@example.edu".into()),
    }
}
fn request(product: Product, operation: &str, body: Value) -> WorkspaceRequest {
    WorkspaceRequest {
        product,
        operation: operation.into(),
        resource_id: if product == Product::Calendar { "primary" } else { "fixture-resource" }
            .into(),
        item_id: "fixture-event".into(),
        range: "A1:B2".into(),
        body,
    }
}

#[test]
fn five_products_use_real_authenticated_api_consumer_for_read_create_and_update() {
    let fixture = Fixture::new();
    account::save(&fixture.0, &credentials()).unwrap();
    let state = GoogleState::default();
    let mut responses = vec![(200, json!({"providerResult":true})); 15];
    responses.insert(14, (200, json!({"etag":"\"event-v1\"","attendees":[]})));
    let provider = Provider::new(responses);
    for product in
        [Product::Docs, Product::Sheets, Product::Slides, Product::Forms, Product::Calendar]
    {
        for operation in ["read", "create", "update"] {
            let body = if product == Product::Calendar {
                json!({"summary":"Private experiment","start":{"date":"2027-01-01"},"end":{"date":"2027-01-02"}})
            } else if operation == "create" {
                json!({"title":"Experiment"})
            } else if product == Product::Sheets {
                json!({"values":[["score",0.9]]})
            } else {
                json!({"requests":[{"fixtureRequest":{}}]})
            };
            assert_eq!(
                api::request_using(
                    &fixture.0,
                    &state,
                    request(product, operation, body),
                    &provider.base,
                    Some(&provider.base)
                )
                .unwrap(),
                json!({"providerResult":true})
            );
        }
    }
    let seen = provider.seen.lock().unwrap();
    assert_eq!(seen.len(), 16);
    assert!(seen.iter().all(|request| request.authorization == "Bearer private-access"));
    assert_eq!(seen[0].url, "/v1/documents/fixture-resource");
    assert_eq!(seen[1].body, json!({"title":"Experiment"}));
    assert_eq!(seen[5].method, "PUT");
    assert!(seen[5].url.contains("/values/A1%3AB2?valueInputOption=RAW"));
    assert_eq!(seen[7].url, "/v1/presentations");
    assert_eq!(seen[10].body, json!({"info":{"title":"Experiment"}}));
    assert!(seen[15].url.ends_with("/events/fixture-event?sendUpdates=none"));
    assert_eq!(seen[15].method, "PATCH");
    assert_eq!(seen[15].if_match, "\"event-v1\"");
    assert_eq!(seen[13].body.get("visibility"), Some(&json!("private")));
    assert_eq!(seen[15].body.get("visibility"), Some(&json!("private")));
}

#[test]
fn calendar_private_updates_refuse_meetings_and_stale_versions() {
    let fixture = Fixture::new();
    account::save(&fixture.0, &credentials()).unwrap();
    let state = GoogleState::default();
    let provider = Provider::new(vec![(
        200,
        json!({"etag":"\"v1\"","attendees":[{"email":"other@example.edu"}]}),
    )]);
    let error = api::request_using(
        &fixture.0,
        &state,
        request(Product::Calendar, "update", json!({"summary":"Changed"})),
        &provider.base,
        Some(&provider.base),
    )
    .unwrap_err();
    assert!(error.contains("attendees"));
    assert_eq!(provider.seen.lock().unwrap().len(), 1);
    let provider =
        Provider::new(vec![(200, json!({"etag":"\"v1\""})), (412, json!({"error":"changed"}))]);
    assert!(api::request_using(
        &fixture.0,
        &state,
        request(Product::Calendar, "update", json!({"summary":"Changed"})),
        &provider.base,
        Some(&provider.base)
    )
    .is_err());
    assert_eq!(provider.seen.lock().unwrap()[1].if_match, "\"v1\"");
}
#[test]
fn expired_token_refreshes_privately_then_real_request_uses_new_authorization() {
    let fixture = Fixture::new();
    let mut value = credentials();
    value.expires_at = 1;
    account::save(&fixture.0, &value).unwrap();
    let provider = Provider::new(vec![
        (200, json!({"access_token":"fresh-access","expires_in":3600})),
        (200, json!({"documentId":"fixture-resource"})),
    ]);
    let state = GoogleState::default();
    api::request_using(
        &fixture.0,
        &state,
        request(Product::Docs, "read", Value::Null),
        &provider.base,
        Some(&provider.base),
    )
    .unwrap();
    let seen = provider.seen.lock().unwrap();
    assert!(seen[0].raw.contains("grant_type=refresh_token"));
    assert!(seen[0].raw.contains("refresh_token=private-refresh"));
    assert!(!seen[0].url.contains("private"));
    assert_eq!(seen[1].authorization, "Bearer fresh-access");
    let saved = account::load(&fixture.0).unwrap();
    assert_eq!(saved.refresh_token, "private-refresh");
    assert_eq!(saved.access_token, "fresh-access");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(fixture.0.join(account::ACCOUNT_FILE)).unwrap().permissions().mode()
                & 0o777,
            0o600
        );
    }
}
#[test]
fn provider_auth_errors_preserve_saved_account_and_never_echo_credentials() {
    let fixture = Fixture::new();
    let mut value = credentials();
    value.expires_at = 1;
    account::save(&fixture.0, &value).unwrap();
    let provider = Provider::new(vec![(400, json!({"error":"private-refresh private-secret"}))]);
    let error = api::request_using(
        &fixture.0,
        &GoogleState::default(),
        request(Product::Docs, "read", Value::Null),
        &provider.base,
        Some(&provider.base),
    )
    .unwrap_err();
    assert!(!error.contains("private"));
    let saved = account::load(&fixture.0).unwrap();
    assert_eq!(saved.access_token, "private-access");
    assert_eq!(saved.refresh_token, "private-refresh");
    let provider = Provider::new(vec![(403, json!({"error":{"message":"private-access"}}))]);
    value.expires_at = account::now() + 3600;
    account::save(&fixture.0, &value).unwrap();
    let error = api::request_using(
        &fixture.0,
        &GoogleState::default(),
        request(Product::Forms, "read", Value::Null),
        &provider.base,
        Some(&provider.base),
    )
    .unwrap_err();
    assert!(error.contains("denied"));
    assert!(!error.contains("private-access"));
}
#[test]
fn missing_scopes_and_calendar_invitations_never_reach_provider() {
    let fixture = Fixture::new();
    let mut value = credentials();
    value.scopes.clear();
    account::save(&fixture.0, &value).unwrap();
    let state = GoogleState::default();
    assert!(super::status(&fixture.0, &state).unwrap().products.is_empty());
    let error = api::request_using(
        &fixture.0,
        &state,
        request(Product::Forms, "read", Value::Null),
        "http://127.0.0.1:1",
        Some("http://127.0.0.1:1"),
    )
    .unwrap_err();
    assert!(error.contains("did not grant"));
    let error = api::request_using(
        &fixture.0,
        &state,
        request(
            Product::Calendar,
            "create",
            json!({"summary":"Event","attendees":[{"email":"other@example.edu"}]}),
        ),
        "http://127.0.0.1:1",
        Some("http://127.0.0.1:1"),
    )
    .unwrap_err();
    assert!(error.contains("attendees"));
}
#[test]
fn pkce_and_callback_host_state_guards_protect_account_switching() {
    assert_eq!(
        oauth::challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    for (host, state, expected) in [
        ("127.0.0.1", "correct", true),
        ("evil.example", "correct", false),
        ("127.0.0.1", "wrong", false),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(address).unwrap();
        write!(client,"GET /oauth2callback?state={state}&code=one-time-code HTTP/1.1\r\nHost: {host}:{}\r\n\r\n",address.port()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let result =
            oauth::callback(&mut server, &format!("http://{address}/oauth2callback"), "correct")
                .unwrap();
        assert_eq!(result.is_some(), expected);
    }
    let fixture = Fixture::new();
    let credentials = credentials();
    account::save(&fixture.0, &credentials).unwrap();
    let state = GoogleState::default();
    let url = super::begin_login(&fixture.0, &state, credentials.client).unwrap();
    assert!(url.starts_with("https://accounts.google.com/"));
    assert!(!url.contains("private-secret"));
    assert!(url.contains("code_challenge_method=S256"));
    assert!(super::status(&fixture.0, &state).unwrap().pending);
    super::cancel_login(&state).unwrap();
    assert!(!super::status(&fixture.0, &state).unwrap().pending);
    assert_eq!(account::load(&fixture.0).unwrap().email, Some("fixture@example.edu".into()));
}

#[test]
fn browser_callback_exchanges_pkce_code_and_failed_reconnect_preserves_previous_account() {
    let fixture = Fixture::new();
    let state = GoogleState::default();
    let original = credentials();
    account::save(&fixture.0, &original).unwrap();
    for accepted in [true, false] {
        let responses = if accepted {
            vec![
                (
                    200,
                    json!({"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}),
                ),
                (200, json!({"email":"new-account@example.edu"})),
            ]
        } else {
            vec![(400, json!({"error":"private-secret rejected"}))]
        };
        let provider = Provider::new(responses);
        let authorize = oauth::begin_using(
            &fixture.0,
            &state,
            original.client.clone(),
            &format!("{}/token", provider.base),
            &format!("{}/userinfo", provider.base),
        )
        .unwrap();
        let url = reqwest::Url::parse(&authorize).unwrap();
        let query: std::collections::HashMap<_, _> =
            url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
        let redirect = reqwest::Url::parse(query.get("redirect_uri").unwrap()).unwrap();
        let mut browser = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
        write!(
            browser,
            "GET /oauth2callback?state={}&code=one-time-code HTTP/1.1\r\n",
            query.get("state").unwrap()
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(150));
        write!(browser, "Host: 127.0.0.1:{}\r\n\r\n", redirect.port().unwrap()).unwrap();
        browser.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut callback_response = [0; 2048];
        let count = browser.read(&mut callback_response).unwrap();
        assert!(String::from_utf8_lossy(&callback_response[..count]).starts_with("HTTP/1.1 200"));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while super::status(&fixture.0, &state).unwrap().pending
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let status = super::status(&fixture.0, &state).unwrap();
        assert!(
            !status.pending,
            "OAuth fixture did not settle; accepted={accepted}, received requests={}",
            provider.seen.lock().unwrap().len()
        );
        assert!(status.connected);
        assert_eq!(status.error, !accepted);
        let saved = account::load(&fixture.0).unwrap();
        assert_eq!(saved.email, Some("new-account@example.edu".into()));
        assert_eq!(saved.refresh_token, "new-refresh");
        let requests = provider.seen.lock().unwrap();
        let fields = reqwest::Url::parse(&format!("http://fixture/?{}", requests[0].raw)).unwrap();
        let fields: std::collections::HashMap<_, _> = fields
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(fields.get("code").unwrap(), "one-time-code");
        assert_eq!(
            oauth::challenge(fields.get("code_verifier").unwrap()),
            *query.get("code_challenge").unwrap()
        );
        assert!(!requests[0].url.contains("private-secret"));
        if accepted {
            assert_eq!(requests[1].authorization, "Bearer new-access");
        }
    }
}

#[test]
fn oauth_token_diagnostics_allowlist_codes_without_reflecting_provider_secrets() {
    let codes = [
        "invalid_client",
        "invalid_grant",
        "invalid_request",
        "unauthorized_client",
        "redirect_uri_mismatch",
        "access_denied",
    ];
    let mut replies = codes
        .iter()
        .map(|code| {
            (400, json!({"error":code,"error_description":"private-code private-secret private-token"}))
        })
        .collect::<Vec<_>>();
    replies.push((401, json!({"error":"private-code private-secret"})));
    replies.push((502, json!({"error":{"message":"private-token"}})));
    replies.push((400, json!({"error":"invalid_client","extra":"x".repeat(8192)})));
    let provider = Provider::new(replies);
    for expected in codes.iter().copied().chain(["unknown", "unknown", "unknown"]) {
        let response =
            account::client_for(&provider.base).unwrap().post(&provider.base).send().unwrap();
        let status = response.status().as_u16();
        let diagnostic = oauth::token_rejection(response);
        assert_eq!(diagnostic, format!("http_status={status} oauth_error={expected}"));
        assert!(!diagnostic.contains("private"));
        assert!(!diagnostic.contains("extra"));
    }
    assert_eq!(provider.seen.lock().unwrap().len(), 9);
}
