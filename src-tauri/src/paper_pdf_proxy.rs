use std::{collections::HashMap, io, sync::Arc};

use axum::{
    body::Body,
    extract::{Query, State},
    http::{
        header::{
            ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
            ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CONTENT_LENGTH,
            CONTENT_RANGE, CONTENT_TYPE, RANGE,
        },
        HeaderMap, HeaderValue, Method, Request, StatusCode,
    },
    response::Response,
    routing::get,
    Router,
};
use futures_util::TryStreamExt;
use tokio::{net::TcpListener, sync::OnceCell};
use uuid::Uuid;

const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;

struct ProxyServer {
    base_url: String,
    token: String,
}

struct ProxyState {
    client: reqwest::Client,
    token: String,
}

static SERVER: OnceCell<ProxyServer> = OnceCell::const_new();

/// Returns a process-local, bearer-capability URL which streams `url` to PDF.js.
pub async fn preview_url(url: &str) -> Result<String, String> {
    let mut upstream = parse_upstream_url(url)?;
    upstream.set_fragment(None);

    let server = SERVER.get_or_try_init(start_server).await?;
    let mut local = reqwest::Url::parse(&server.base_url)
        .map_err(|error| format!("Failed to construct PDF proxy URL: {error}"))?;
    local
        .query_pairs_mut()
        .append_pair("token", &server.token)
        .append_pair("url", upstream.as_str());
    Ok(local.into())
}

fn parse_upstream_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid PDF URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("PDF URL must use HTTP or HTTPS".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("PDF URL must not contain credentials".into());
    }
    Ok(parsed)
}

async fn start_server() -> Result<ProxyServer, String> {
    let token = Uuid::new_v4().simple().to_string();
    let client = reqwest::Client::builder()
        .user_agent("Lattice research writer (paper preview)")
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("Too many PDF redirects")
            } else if parse_upstream_url(attempt.url().as_str()).is_ok() {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|error| format!("Failed to create PDF proxy client: {error}"))?;
    let state = Arc::new(ProxyState {
        client,
        token: token.clone(),
    });
    let app = Router::new()
        .route("/paper.pdf", get(proxy).options(proxy))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Failed to bind PDF proxy: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Failed to read PDF proxy address: {error}"))?;

    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            log::warn!("PDF proxy stopped: {error}");
        }
    });

    Ok(ProxyServer {
        base_url: format!("http://{address}/paper.pdf"),
        token,
    })
}

async fn proxy(
    State(state): State<Arc<ProxyState>>,
    Query(query): Query<HashMap<String, String>>,
    request: Request<Body>,
) -> Response<Body> {
    if query.get("token") != Some(&state.token) {
        return response(StatusCode::UNAUTHORIZED, Body::empty());
    }

    if request.method() == Method::OPTIONS {
        return cors(response(StatusCode::NO_CONTENT, Body::empty()));
    }

    let Some(raw_url) = query.get("url") else {
        return cors(response(StatusCode::BAD_REQUEST, Body::empty()));
    };
    let upstream_url = match parse_upstream_url(raw_url) {
        Ok(url) => url,
        Err(message) => return cors(response(StatusCode::BAD_REQUEST, Body::from(message))),
    };

    let mut upstream_request = state.client.get(upstream_url);
    if let Some(range) = request.headers().get(RANGE) {
        upstream_request = upstream_request.header(RANGE, range);
    }
    let upstream = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            return cors(response(
                StatusCode::BAD_GATEWAY,
                Body::from(format!("Upstream PDF request failed: {error}")),
            ));
        }
    };

    if declared_size(upstream.headers()).is_some_and(|size| size > MAX_PDF_BYTES) {
        return cors(response(
            StatusCode::PAYLOAD_TOO_LARGE,
            Body::from("PDF exceeds the 100 MiB limit"),
        ));
    }

    let status = upstream.status();
    let copied_headers = upstream.headers().clone();
    let mut received = 0_u64;
    let stream = upstream
        .bytes_stream()
        .map_err(io::Error::other)
        .and_then(move |chunk| {
            received = received.saturating_add(chunk.len() as u64);
            std::future::ready(if received > MAX_PDF_BYTES {
                Err(io::Error::other("PDF exceeds the 100 MiB limit"))
            } else {
                Ok(chunk)
            })
        });
    let mut result = response(status, Body::from_stream(stream));
    for name in [CONTENT_TYPE, CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES] {
        if let Some(value) = copied_headers.get(&name) {
            result.headers_mut().insert(name, value.clone());
        }
    }
    // Never serve publisher HTML as executable content on our loopback origin.
    result
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
    result.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    cors(result)
}

fn declared_size(headers: &HeaderMap) -> Option<u64> {
    let content_length = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let complete_length = headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit_once('/'))
        .and_then(|(_, total)| total.parse().ok());
    complete_length.or(content_length)
}

fn response(status: StatusCode, body: Body) -> Response<Body> {
    Response::builder().status(status).body(body).unwrap()
}

fn cors(mut response: Response<Body>) -> Response<Body> {
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, OPTIONS"),
    );
    headers.insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range"),
    );
    headers.insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use tokio::sync::oneshot;

    // The singleton server belongs to its Tokio runtime. Keep these requests
    // in one runtime, as in the application, instead of retaining a dead server
    // between independent #[tokio::test] runtimes.
    #[tokio::test]
    async fn streaming_proxy_contract() {
        streams_first_chunk_before_upstream_finishes().await;
        forwards_range_and_preserves_206_or_200().await;
        preserves_416_and_upstream_error_statuses().await;
        rejects_an_invalid_capability().await;
        rejects_declared_oversized_responses().await;
        rejects_undeclared_oversized_streams().await;
        ignores_range_when_the_origin_does().await;
        assert!(preview_url("file:///tmp/paper.pdf").await.is_err());
        assert!(preview_url("https://user:password@example.com/paper.pdf")
            .await
            .is_err());
    }

    #[tokio::test]
    #[ignore = "Manual browser smoke; set LATTICE_PDF_PREVIEW_URL_FILE and LATTICE_PDF_PREVIEW_SOURCE"]
    async fn live_pdf_preview() {
        let source = std::env::var("LATTICE_PDF_PREVIEW_SOURCE").unwrap();
        let path = std::env::var("LATTICE_PDF_PREVIEW_URL_FILE").unwrap();
        std::fs::write(path, preview_url(&source).await.unwrap()).unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
    }

    async fn origin(app: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/paper.pdf")
    }

    async fn streams_first_chunk_before_upstream_finishes() {
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let release = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
        let url = origin(Router::new().route(
            "/paper.pdf",
            get(move || {
                let release = release.clone();
                async move {
                    let stream = futures_util::stream::unfold(0, move |step| {
                        let release = release.clone();
                        async move {
                            match step {
                                0 => Some((Ok::<_, io::Error>("first"), 1)),
                                1 => {
                                    release.lock().await.take().unwrap().await.ok();
                                    Some((Ok("second"), 2))
                                }
                                _ => None,
                            }
                        }
                    });
                    Body::from_stream(stream)
                }
            }),
        ))
        .await;

        let response = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            reqwest::get(preview_url(&url).await.unwrap()),
        )
        .await
        .expect("Response headers must not wait for the complete PDF")
        .unwrap();
        let mut stream = response.bytes_stream();
        let first = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            futures_util::TryStreamExt::try_next(&mut stream),
        )
        .await
        .expect("The proxy must forward bytes before the origin finishes")
        .unwrap()
        .unwrap();
        assert_eq!(&first[..], b"first");
        release_tx.send(()).unwrap();
        assert_eq!(
            futures_util::TryStreamExt::try_next(&mut stream)
                .await
                .unwrap()
                .unwrap(),
            "second"
        );
    }

    async fn forwards_range_and_preserves_206_or_200() {
        let url = origin(Router::new().route(
            "/paper.pdf",
            get(|headers: HeaderMap| async move {
                if let Some(range) = headers.get(RANGE) {
                    assert_eq!(range, "bytes=1-2");
                    Response::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(CONTENT_RANGE, "bytes 1-2/4")
                        .header(ACCEPT_RANGES, "bytes")
                        .body(Body::from("bc"))
                        .unwrap()
                } else {
                    response(StatusCode::OK, Body::from("abcd"))
                }
            }),
        ))
        .await;
        let proxy = preview_url(&url).await.unwrap();
        let client = reqwest::Client::new();

        let ranged = client
            .get(&proxy)
            .header(RANGE, "bytes=1-2")
            .send()
            .await
            .unwrap();
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.headers()[CONTENT_RANGE], "bytes 1-2/4");
        assert_eq!(ranged.bytes().await.unwrap(), "bc");
        let full = client.get(proxy).send().await.unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert!(full.headers()[ACCESS_CONTROL_EXPOSE_HEADERS]
            .to_str()
            .unwrap()
            .contains("Content-Length"));
        assert_eq!(full.bytes().await.unwrap(), "abcd");
    }

    async fn ignores_range_when_the_origin_does() {
        let url =
            origin(Router::new().route("/paper.pdf", get(|| async { Body::from("full PDF") })))
                .await;
        let local = preview_url(&url).await.unwrap();
        assert_eq!(local, preview_url(&format!("{url}#page=2")).await.unwrap());
        let client = reqwest::Client::new();
        let preflight = client
            .request(Method::OPTIONS, &local)
            .send()
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(preflight.headers()[ACCESS_CONTROL_ALLOW_HEADERS], "Range");
        let response = client
            .get(local)
            .header(RANGE, "bytes=1-2")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.bytes().await.unwrap(), "full PDF");
    }

    async fn rejects_undeclared_oversized_streams() {
        let url = origin(Router::new().route(
            "/paper.pdf",
            get(|| async {
                Body::from_stream(futures_util::stream::iter(
                    (0..101).map(|_| Ok::<_, io::Error>(vec![0_u8; 1024 * 1024])),
                ))
            }),
        ))
        .await;
        let mut response = reqwest::get(preview_url(&url).await.unwrap())
            .await
            .unwrap();
        let mut bytes = 0;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => bytes += chunk.len() as u64,
                Ok(None) => panic!("Oversized stream must fail, not silently truncate"),
                Err(_) => break,
            }
        }
        assert!(bytes <= MAX_PDF_BYTES);
    }

    async fn preserves_416_and_upstream_error_statuses() {
        let range_url = origin(Router::new().route(
            "/paper.pdf",
            get(|| async {
                Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(CONTENT_RANGE, "bytes */4")
                    .body(Body::empty())
                    .unwrap()
            }),
        ))
        .await;
        assert_eq!(
            reqwest::get(preview_url(&range_url).await.unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );

        let error_url = origin(Router::new().route(
            "/paper.pdf",
            get(|| async { response(StatusCode::SERVICE_UNAVAILABLE, Body::from("later")) }),
        ))
        .await;
        assert_eq!(
            reqwest::get(preview_url(&error_url).await.unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    async fn rejects_an_invalid_capability() {
        let url =
            origin(Router::new().route("/paper.pdf", get(|| async { Body::from("pdf") }))).await;
        let proxy = preview_url(&url)
            .await
            .unwrap()
            .replace("token=", "token=wrong");
        assert_eq!(
            reqwest::get(proxy).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }

    async fn rejects_declared_oversized_responses() {
        let url = origin(Router::new().route(
            "/paper.pdf",
            get(|| async {
                Response::builder()
                    .header(CONTENT_LENGTH, MAX_PDF_BYTES + 1)
                    .body(Body::from_stream(futures_util::stream::pending::<
                        Result<&'static str, io::Error>,
                    >()))
                    .unwrap()
            }),
        ))
        .await;
        assert_eq!(
            reqwest::get(preview_url(&url).await.unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }
}
