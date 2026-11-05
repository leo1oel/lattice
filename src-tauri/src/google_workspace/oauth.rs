use super::{
    account::{self, Credentials, API_ERROR},
    GoogleState, OAuthClient,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";

/// Provider descriptions can contain credentials or reflected request data.
/// Keep diagnostics finite: an HTTP status and a recognized OAuth error code.
pub(super) fn token_rejection(mut response: reqwest::blocking::Response) -> String {
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    let code =
        if response.by_ref().take(4097).read_to_end(&mut bytes).is_ok() && bytes.len() <= 4096 {
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|value| match value.get("error").and_then(serde_json::Value::as_str) {
                    Some("invalid_client") => Some("invalid_client"),
                    Some("invalid_grant") => Some("invalid_grant"),
                    Some("invalid_request") => Some("invalid_request"),
                    Some("unauthorized_client") => Some("unauthorized_client"),
                    Some("redirect_uri_mismatch") => Some("redirect_uri_mismatch"),
                    Some("access_denied") => Some("access_denied"),
                    _ => None,
                })
                .unwrap_or("unknown")
        } else {
            "unknown"
        };
    format!("http_status={status} oauth_error={code}")
}

fn network_class(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else {
        "request"
    }
}

pub(super) fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn nonce() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub fn begin_login(dir: &Path, state: &GoogleState, client: OAuthClient) -> Result<String, String> {
    begin_using(dir, state, client, account::TOKEN_URL, USERINFO_URL)
}

pub(super) fn begin_using(
    dir: &Path, state: &GoogleState, client: OAuthClient, token_url: &str, userinfo_url: &str,
) -> Result<String, String> {
    client.validate()?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Could not open the Google sign-in callback.".to_string())?;
    listener.set_nonblocking(true).map_err(|_| API_ERROR.to_string())?;
    let port = listener.local_addr().map_err(|_| API_ERROR.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/oauth2callback");
    let verifier = nonce();
    let expected_state = nonce();
    let mut url = reqwest::Url::parse(AUTHORIZE_URL).map_err(|_| API_ERROR.to_string())?;
    let mut scopes = vec!["openid", "email", "https://www.googleapis.com/auth/drive.file"];
    for product in &client.products {
        scopes.extend(product.scopes());
    }
    scopes.sort_unstable();
    scopes.dedup();
    url.query_pairs_mut().extend_pairs([
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", scopes.join(" ").as_str()),
        ("state", expected_state.as_str()),
        ("code_challenge", challenge(&verifier).as_str()),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);
    let generation = state.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut previous = account::load(dir).map(|value| value.status()).unwrap_or_default();
    previous.pending = true;
    *state.0.status.lock().map_err(|_| API_ERROR.to_string())? = Some(previous);
    let dir = dir.to_path_buf();
    let state = state.clone();
    let flow = Flow {
        generation,
        listener,
        redirect,
        expected_state,
        verifier,
        client,
        token_url: token_url.into(),
        userinfo_url: userinfo_url.into(),
    };
    std::thread::spawn(move || {
        let outcome = finish(&dir, &state, flow);
        if state.0.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let mut status = state.0.status.lock().unwrap_or_else(|error| error.into_inner());
        if state.0.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if outcome.is_err() {
            let mut previous = account::load(&dir).map(|value| value.status()).unwrap_or_default();
            previous.error = true;
            *status = Some(previous);
        } else {
            *status = None;
        }
    });
    Ok(url.into())
}
pub fn cancel_login(state: &GoogleState) -> Result<(), String> {
    // Linearize cancellation with the callback's final write, so no credential
    // save can land after cancellation returns to the user.
    let _guard = state.0.credential_lock.lock().map_err(|_| API_ERROR.to_string())?;
    state.0.generation.fetch_add(1, Ordering::SeqCst);
    *state.0.status.lock().map_err(|_| API_ERROR.to_string())? = None;
    Ok(())
}
struct Flow {
    generation: u64,
    listener: TcpListener,
    redirect: String,
    expected_state: String,
    verifier: String,
    client: OAuthClient,
    token_url: String,
    userinfo_url: String,
}
fn finish(dir: &Path, state: &GoogleState, flow: Flow) -> Result<(), String> {
    let Flow {
        generation,
        listener,
        redirect,
        expected_state,
        verifier,
        client,
        token_url,
        userinfo_url,
    } = flow;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(300)
        && state.0.generation.load(Ordering::SeqCst) == generation
    {
        let (mut stream, _) = match listener.accept() {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(_) => return Err(API_ERROR.into()),
        };
        // Accepted sockets can inherit the listener's nonblocking flag on
        // macOS. A fragmented browser request must wait for its remaining
        // headers, rather than treating WouldBlock as a closed callback.
        stream.set_nonblocking(false).map_err(|_| API_ERROR.to_string())?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let Some(code) = callback(&mut stream, &redirect, &expected_state)? else { continue };
        let mut fields = vec![
            ("client_id", client.client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
        ];
        if !client.client_secret.is_empty() {
            fields.push(("client_secret", &client.client_secret));
        }
        let http = account::client_for(&token_url)?;
        let response = http
            .post(&token_url)
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(account::form(&fields))
            .send()
            .map_err(|error| {
                log::warn!(
                    "Google OAuth token exchange network failure: {}",
                    network_class(&error)
                );
                API_ERROR.to_string()
            })?;
        if !response.status().is_success() {
            log::warn!("Google OAuth token exchange rejected: {}", token_rejection(response));
            return Err(API_ERROR.into());
        }
        let value: serde_json::Value = response.json().map_err(|_| {
            log::warn!("Google OAuth token exchange returned invalid JSON");
            API_ERROR.to_string()
        })?;
        let access = value
            .get("access_token")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                log::warn!("Google OAuth token exchange omitted its access token");
                API_ERROR.to_string()
            })?
            .to_string();
        let requested = std::iter::once("openid")
            .chain(std::iter::once("email"))
            .chain(std::iter::once("https://www.googleapis.com/auth/drive.file"))
            .chain(client.products.iter().flat_map(|product| product.scopes()).copied())
            .collect::<Vec<_>>()
            .join(" ");
        let granted = value.get("scope").and_then(|v| v.as_str()).unwrap_or(&requested);
        let email = http
            .get(&userinfo_url)
            .bearer_auth(&access)
            .send()
            .ok()
            .filter(|value| value.status().is_success())
            .and_then(|value| value.json::<serde_json::Value>().ok())
            .and_then(|value| value.get("email").and_then(|v| v.as_str()).map(str::to_owned));
        let credentials = Credentials {
            client,
            access_token: access,
            refresh_token: value
                .get("refresh_token")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .into(),
            expires_at: account::now()
                + value.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600).min(86400),
            scopes: granted.into(),
            email,
        };
        let _guard = state.0.credential_lock.lock().map_err(|_| API_ERROR.to_string())?;
        if state.0.generation.load(Ordering::SeqCst) != generation {
            return Err(API_ERROR.into());
        }
        return account::save(dir, &credentials).inspect_err(|_| {
            log::warn!("Google OAuth credential storage write failed");
        });
    }
    Err("Google sign-in was cancelled or timed out.".into())
}

/// Ignore unsolicited callbacks without state/Host/path agreement. Never echo a code into HTML/logs.
pub(super) fn callback(
    stream: &mut TcpStream, redirect: &str, state: &str,
) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    while bytes.len() < 8192 {
        let count = match stream.read(&mut buffer) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    let line = lines.next().unwrap_or_default();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let base = reqwest::Url::parse(redirect).map_err(|_| API_ERROR.to_string())?;
    let host = format!("127.0.0.1:{}", base.port().unwrap_or_default());
    let host_valid = lines.any(|line| {
        line.split_once(':')
            .is_some_and(|(name, value)| name.eq_ignore_ascii_case("host") && value.trim() == host)
    });
    let url = base.join(target).map_err(|_| API_ERROR.to_string())?;
    let values: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = values.iter().filter(|(key, _)| key == "state").collect();
    let codes: Vec<_> = values.iter().filter(|(key, _)| key == "code").collect();
    let valid = method == "GET"
        && target.starts_with("/oauth2callback?")
        && url.origin() == base.origin()
        && url.path() == base.path()
        && host_valid
        && states.len() == 1
        && states[0].1 == state;
    if !valid {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return Ok(None);
    }
    let body = "Google sign-in received. You can close this tab and return to Lattice.";
    let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
    if values.iter().any(|(key, _)| key == "error") {
        return Err("Google sign-in was declined.".into());
    }
    if codes.len() != 1 || codes[0].1.len() > 4096 || codes[0].1.is_empty() {
        return Ok(None);
    }
    Ok(Some(codes[0].1.to_string()))
}
