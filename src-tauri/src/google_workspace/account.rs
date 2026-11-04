use super::Product;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(super) const ACCOUNT_FILE: &str = "google-workspace.json";
pub(super) const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub(super) const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
pub(super) const API_ERROR: &str = "Google Workspace request failed. Check account access, enabled APIs and the requested operation.";

#[derive(Clone, Default)]
pub struct GoogleState(pub(super) Arc<Inner>);
#[derive(Default)]
pub(super) struct Inner {
    pub generation: AtomicU64,
    pub status: Mutex<Option<GoogleStatus>>,
    pub credential_lock: Mutex<()>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthClient {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    pub products: Vec<Product>,
}
impl OAuthClient {
    pub(super) fn validate(&self) -> Result<(), String> {
        if !self.client_id.ends_with(".apps.googleusercontent.com")
            || self.client_id.len() > 256
            || self.client_id.chars().any(|c| c.is_control() || c.is_whitespace())
            || self.client_secret.len() > 1024
            || self.client_secret.chars().any(char::is_control)
            || self.products.is_empty()
            || self.products.len() > 5
        {
            return Err(
                "Provide a Google Desktop OAuth client and select at least one product.".into()
            );
        }
        Ok(())
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    pub connected: bool,
    pub pending: bool,
    pub email: Option<String>,
    pub products: Vec<Product>,
    pub error: bool,
}
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Credentials {
    pub client: OAuthClient,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub scopes: String,
    pub email: Option<String>,
}
impl Credentials {
    pub fn status(&self) -> GoogleStatus {
        GoogleStatus {
            connected: true,
            email: self.email.clone(),
            products: self
                .client
                .products
                .iter()
                .copied()
                .filter(|product| {
                    self.scopes.split_whitespace().any(|scope| scope == product.scopes()[0])
                })
                .collect(),
            ..Default::default()
        }
    }
}
pub(super) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}
pub(super) fn form(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(key, value)| {
            format!("{}={}", crate::util::url_encode(key), crate::util::url_encode(value))
        })
        .collect::<Vec<_>>()
        .join("&")
}
pub(super) fn client() -> Result<Client, String> {
    crate::http::blocking(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| API_ERROR.into())
}
pub(super) fn load(dir: &Path) -> Result<Credentials, String> {
    let path = dir.join(ACCOUNT_FILE);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Connect Google Workspace first.".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return Err("Invalid Google account storage.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Google account storage must be private (chmod 600).".into());
        }
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| API_ERROR.to_string())?)
        .map_err(|_| API_ERROR.into())
}
pub(super) fn save(dir: &Path, value: &Credentials) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|_| API_ERROR.to_string())?;
    let temporary = dir.join(format!(".google-workspace-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| API_ERROR.to_string())?;
        file.write_all(&serde_json::to_vec(value).map_err(|_| API_ERROR.to_string())?)
            .map_err(|_| API_ERROR.to_string())?;
        file.sync_all().map_err(|_| API_ERROR.to_string())?;
        fs::rename(&temporary, dir.join(ACCOUNT_FILE)).map_err(|_| API_ERROR.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub fn status(dir: &Path, state: &GoogleState) -> Result<GoogleStatus, String> {
    if let Some(value) = state.0.status.lock().map_err(|_| API_ERROR.to_string())?.clone() {
        return Ok(value);
    }
    match load(dir) {
        Ok(value) => Ok(value.status()),
        Err(_) if !dir.join(ACCOUNT_FILE).exists() => Ok(GoogleStatus::default()),
        Err(error) => Err(error),
    }
}
pub(super) fn access(
    dir: &Path, state: &GoogleState, token_url: &str,
) -> Result<Credentials, String> {
    let _guard = state.0.credential_lock.lock().map_err(|_| API_ERROR.to_string())?;
    let mut credentials = load(dir)?;
    if credentials.expires_at > now() + 60 {
        return Ok(credentials);
    }
    if credentials.refresh_token.is_empty() {
        return Err("Google access expired. Connect again.".into());
    }
    let mut fields = vec![
        ("client_id", credentials.client.client_id.as_str()),
        ("refresh_token", credentials.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if !credentials.client.client_secret.is_empty() {
        fields.push(("client_secret", &credentials.client.client_secret));
    }
    let response = client()?
        .post(token_url)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form(&fields))
        .send()
        .map_err(|_| API_ERROR.to_string())?;
    if !response.status().is_success() {
        return Err("Google access expired or was revoked. Connect again.".into());
    }
    let value: serde_json::Value = response.json().map_err(|_| API_ERROR.to_string())?;
    credentials.access_token = value
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or(API_ERROR)?
        .to_owned();
    credentials.expires_at =
        now() + value.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600).min(86400);
    if let Some(scope) = value.get("scope").and_then(|value| value.as_str()) {
        credentials.scopes = scope.to_owned();
    }
    if let Some(refresh) = value
        .get("refresh_token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
    {
        credentials.refresh_token = refresh.to_owned();
    }
    // A failed refresh never overwrites the last valid account or refresh token.
    save(dir, &credentials)?;
    Ok(credentials)
}
pub fn disconnect(dir: &Path, state: &GoogleState) -> Result<(), String> {
    state.0.generation.fetch_add(1, Ordering::SeqCst);
    let _guard = state.0.credential_lock.lock().map_err(|_| API_ERROR.to_string())?;
    // Local disconnect works offline; revocation is best effort and uses a form body, never a URL.
    if let (Ok(value), Ok(http)) = (load(dir), client()) {
        let token =
            if value.refresh_token.is_empty() { value.access_token } else { value.refresh_token };
        let _ = http
            .post(REVOKE_URL)
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(form(&[("token", &token)]))
            .send();
    }
    match fs::remove_file(dir.join(ACCOUNT_FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(API_ERROR.into()),
    }
    *state.0.status.lock().map_err(|_| API_ERROR.to_string())? = None;
    Ok(())
}
