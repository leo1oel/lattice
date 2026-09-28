//! Personal literature-provider keys and the Crossref contact email, kept in
//! one system-keychain item and cached in-process after the first read.
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

#[cfg(not(test))]
const SERVICE: &str = "app.leo1oel.researchwriter.literature";
#[cfg(not(test))]
const ACCOUNT: &str = "credential-vault-v1";
const MAX_SECRET: usize = 16 * 1024;
const MAX_EMAIL: usize = 320;
const TEST_TIMEOUT: Duration = Duration::from_secs(8);

static VAULT: Mutex<Option<CredentialVault>> = Mutex::new(None);

#[derive(Clone, Default, Deserialize, Serialize)]
struct CredentialVault {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    openalex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    semanticscholar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    firecrawl: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    crossref_email: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiteratureProvider {
    OpenAlex,
    SemanticScholar,
    Firecrawl,
}

impl LiteratureProvider {
    /// Runtime overrides consulted, in order, when no key is saved.
    fn env_names(self) -> &'static [&'static str] {
        match self {
            Self::OpenAlex => &["OPENALEX_API_KEY"],
            Self::SemanticScholar => &["SEMANTIC_SCHOLAR_API_KEY", "S2_API_KEY"],
            Self::Firecrawl => &["LATTICE_FIRECRAWL_KEY"],
        }
    }

    /// A cheap authenticated request that proves a key works.
    fn test_url(self) -> &'static str {
        match self {
            Self::OpenAlex => "https://api.openalex.org/works/https://doi.org/10.1038/nphys1170",
            Self::SemanticScholar => {
                "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/nphys1170?fields=paperId"
            }
            Self::Firecrawl => "https://api.firecrawl.dev/v2/team/credit-usage",
        }
    }
}

impl CredentialVault {
    fn saved(&self, provider: LiteratureProvider) -> Option<&String> {
        match provider {
            LiteratureProvider::OpenAlex => self.openalex.as_ref(),
            LiteratureProvider::SemanticScholar => self.semanticscholar.as_ref(),
            LiteratureProvider::Firecrawl => self.firecrawl.as_ref(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialSource {
    Saved,
    Environment,
    Anonymous,
    Shared,
    Missing,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureCredentialStatus {
    openalex: CredentialSource,
    semanticscholar: CredentialSource,
    firecrawl: CredentialSource,
    crossref_email: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialTestState {
    Ok,
    Unauthorized,
    RateLimited,
    Unavailable,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct LiteratureCredentialTest {
    status: CredentialTestState,
    authenticated: bool,
}

fn vault_lock() -> Result<MutexGuard<'static, Option<CredentialVault>>, String> {
    VAULT.lock().map_err(|_| "secure credential store unavailable".to_string())
}

#[cfg(not(test))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "secure credential store unavailable".to_string())
}

#[cfg(test)]
fn entry() -> Result<keyring::Entry, String> {
    // Paper-import tests also resolve credentials. Never prompt for or expose
    // the developer's real vault while exercising fake literature tools.
    Ok(keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default())))
}

fn loaded_vault() -> Result<CredentialVault, String> {
    let mut cache = vault_lock()?;
    if let Some(vault) = cache.as_ref() {
        return Ok(vault.clone());
    }
    let vault = read_vault(&entry()?)?;
    *cache = Some(vault.clone());
    Ok(vault)
}

fn read_vault(entry: &keyring::Entry) -> Result<CredentialVault, String> {
    match entry.get_password() {
        Ok(encoded) => serde_json::from_str(&encoded)
            .map_err(|_| "could not read credentials from the system keychain".to_string()),
        Err(keyring::Error::NoEntry) => Ok(CredentialVault::default()),
        Err(_) => Err("could not read credentials from the system keychain".to_string()),
    }
}

fn update_vault(update: impl FnOnce(&mut CredentialVault)) -> Result<(), String> {
    let mut cache = vault_lock()?;
    update_cached_vault(&mut cache, &entry()?, update)
}

fn update_cached_vault(
    cache: &mut Option<CredentialVault>, entry: &keyring::Entry,
    update: impl FnOnce(&mut CredentialVault),
) -> Result<(), String> {
    let mut next =
        if let Some(vault) = cache.as_ref() { vault.clone() } else { read_vault(entry)? };
    update(&mut next);
    let encoded = serde_json::to_string(&next)
        .map_err(|_| "could not save credentials in the system keychain".to_string())?;
    entry
        .set_password(&encoded)
        .map_err(|_| "could not save credentials in the system keychain".to_string())?;
    *cache = Some(next);
    Ok(())
}

fn normalized_secret(secret: String) -> Result<String, String> {
    let secret = secret.trim().to_string();
    if secret.is_empty() || secret.len() > MAX_SECRET || secret.chars().any(char::is_control) {
        return Err("invalid literature credential".to_string());
    }
    Ok(secret)
}

fn normalized_email(email: String) -> Result<Option<String>, String> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Ok(None);
    }
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if email.len() > MAX_EMAIL
        || local.is_empty()
        || domain.is_empty()
        || !domain.contains('.')
        || parts.next().is_some()
        || email.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("invalid literature contact email".to_string());
    }
    Ok(Some(email))
}

fn env_value(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
    })
}

fn shared_firecrawl_key() -> Option<&'static str> {
    option_env!("LATTICE_FIRECRAWL_KEY").map(str::trim).filter(|value| !value.is_empty())
}

/// The saved key, then the runtime environment, then (Firecrawl only) the
/// build-time shared key. The shared fallback is intentionally last.
fn effective(vault: &CredentialVault, provider: LiteratureProvider) -> Option<String> {
    vault.saved(provider).cloned().or_else(|| env_value(provider.env_names())).or_else(|| {
        shared_firecrawl_key()
            .filter(|_| provider == LiteratureProvider::Firecrawl)
            .map(str::to_string)
    })
}

fn source(vault: &CredentialVault, provider: LiteratureProvider) -> CredentialSource {
    if vault.saved(provider).is_some() {
        CredentialSource::Saved
    } else if env_value(provider.env_names()).is_some() {
        CredentialSource::Environment
    } else if provider != LiteratureProvider::Firecrawl {
        CredentialSource::Anonymous
    } else if shared_firecrawl_key().is_some() {
        CredentialSource::Shared
    } else {
        CredentialSource::Missing
    }
}

fn contact(vault: &CredentialVault) -> Option<String> {
    vault.crossref_email.clone().or_else(|| {
        env_value(&["BIBCITE_MAILTO"]).and_then(|email| normalized_email(email).ok().flatten())
    })
}

fn status(vault: &CredentialVault) -> LiteratureCredentialStatus {
    LiteratureCredentialStatus {
        openalex: source(vault, LiteratureProvider::OpenAlex),
        semanticscholar: source(vault, LiteratureProvider::SemanticScholar),
        firecrawl: source(vault, LiteratureProvider::Firecrawl),
        crossref_email: contact(vault).unwrap_or_default(),
    }
}

fn current_status() -> Result<LiteratureCredentialStatus, String> {
    loaded_vault().map(|vault| status(&vault))
}

pub(crate) fn openalex_key() -> Result<Option<String>, String> {
    Ok(effective(&loaded_vault()?, LiteratureProvider::OpenAlex))
}

pub(crate) fn semanticscholar_key() -> Result<Option<String>, String> {
    Ok(effective(&loaded_vault()?, LiteratureProvider::SemanticScholar))
}

pub(crate) fn firecrawl_key() -> Result<Option<String>, String> {
    Ok(effective(&loaded_vault()?, LiteratureProvider::Firecrawl))
}

pub(crate) fn crossref_contact() -> Result<Option<String>, String> {
    Ok(contact(&loaded_vault()?))
}

/// Keychain reads and provider requests block, so each command runs off the
/// async runtime; `failure` reports a task that stopped unexpectedly.
async fn off_thread<T: Send + 'static>(
    failure: &str, work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| failure.to_string())?
}

#[tauri::command]
pub async fn get_literature_credentials() -> Result<LiteratureCredentialStatus, String> {
    off_thread("could not read literature credential settings", current_status).await
}

#[tauri::command]
pub async fn set_literature_credential(
    provider: LiteratureProvider, secret: Option<String>,
) -> Result<LiteratureCredentialStatus, String> {
    off_thread("could not save literature credential settings", move || {
        let secret = secret.map(normalized_secret).transpose()?;
        update_vault(|vault| match provider {
            LiteratureProvider::OpenAlex => vault.openalex = secret,
            LiteratureProvider::SemanticScholar => vault.semanticscholar = secret,
            LiteratureProvider::Firecrawl => vault.firecrawl = secret,
        })?;
        current_status()
    })
    .await
}

#[tauri::command]
pub async fn set_literature_contact(email: String) -> Result<LiteratureCredentialStatus, String> {
    off_thread("could not save literature contact settings", move || {
        let email = normalized_email(email)?;
        update_vault(|vault| vault.crossref_email = email)?;
        current_status()
    })
    .await
}

#[tauri::command]
pub async fn test_literature_credential(
    provider: LiteratureProvider, secret: Option<String>,
) -> Result<LiteratureCredentialTest, String> {
    off_thread("could not test literature credential", move || {
        let key = match secret {
            Some(secret) => Some(normalized_secret(secret)?),
            None => effective(&loaded_vault()?, provider),
        };
        test_provider_at(provider, key, provider.test_url())
    })
    .await
}

fn test_provider_at(
    provider: LiteratureProvider, key: Option<String>, url: &str,
) -> Result<LiteratureCredentialTest, String> {
    let client = crate::literature_service::client(TEST_TIMEOUT, None)
        .map_err(|_| "could not create literature API client".to_string())?;
    let mut request = crate::literature_service::request(&client, url, None, key.is_none())?;
    if let Some(secret) = key.as_deref() {
        request = match provider {
            LiteratureProvider::SemanticScholar => request.header("x-api-key", secret),
            LiteratureProvider::OpenAlex | LiteratureProvider::Firecrawl => {
                request.bearer_auth(secret)
            }
        };
    }
    let status = match request.send().map(|response| response.status().as_u16()) {
        Ok(200..=299) => CredentialTestState::Ok,
        Ok(401 | 403) => CredentialTestState::Unauthorized,
        Ok(429) => CredentialTestState::RateLimited,
        Ok(_) | Err(_) => CredentialTestState::Unavailable,
    };
    Ok(LiteratureCredentialTest { status, authenticated: key.is_some() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "writes and removes an isolated temporary system-keychain item"]
    fn system_keychain_roundtrip_isolated() {
        let entry = keyring::Entry::new(
            "app.leo1oel.researchwriter.literature.test",
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        let result = (|| -> Result<CredentialVault, String> {
            let mut cache = None;
            update_cached_vault(&mut cache, &entry, |vault| {
                vault.openalex = Some("isolated-test-not-a-real-key".into());
            })?;
            let persisted = read_vault(&entry)?;
            assert_eq!(persisted.openalex.as_deref(), Some("isolated-test-not-a-real-key"));
            cache = None;
            update_cached_vault(&mut cache, &entry, |vault| vault.openalex = None)?;
            read_vault(&entry)
        })();
        let cleanup = entry.delete_credential();
        assert!(result.unwrap().openalex.is_none());
        cleanup.unwrap();
    }

    #[test]
    fn persistence_removal_and_failed_write_preserve_other_credentials() {
        // Unit tests must never reach the developer's real keychain.
        let entry = entry().unwrap();
        let mock = entry.get_credential().downcast_ref::<keyring::mock::MockCredential>().unwrap();
        let mut cache = None;
        update_cached_vault(&mut cache, &entry, |vault| {
            vault.openalex = Some("first".into());
            vault.semanticscholar = Some("second".into());
            vault.firecrawl = Some("third".into());
        })
        .unwrap();
        assert_eq!(read_vault(&entry).unwrap().openalex.as_deref(), Some("first"));
        mock.set_error(keyring::Error::NoEntry);
        assert!(update_cached_vault(&mut cache, &entry, |vault| {
            vault.openalex = Some("failed-replacement".into());
        })
        .is_err());
        assert_eq!(cache.as_ref().unwrap().openalex.as_deref(), Some("first"));
        assert_eq!(read_vault(&entry).unwrap().openalex.as_deref(), Some("first"));
        // Simulate reopening with no in-process cache, then removing one key.
        cache = None;
        update_cached_vault(&mut cache, &entry, |vault| vault.openalex = None).unwrap();
        let reloaded = read_vault(&entry).unwrap();
        assert!(reloaded.openalex.is_none());
        assert_eq!(reloaded.semanticscholar.as_deref(), Some("second"));
        assert_eq!(reloaded.firecrawl.as_deref(), Some("third"));
    }

    #[test]
    fn validates_secrets_and_contacts() {
        assert_eq!(normalized_secret("  token  ".into()).unwrap(), "token");
        for secret in ["", "bad\nkey"] {
            assert!(normalized_secret(secret.into()).is_err(), "{secret:?}");
        }
        assert_eq!(normalized_email(" ".into()).unwrap(), None);
        assert_eq!(
            normalized_email(" person@example.org ".into()).unwrap(),
            Some("person@example.org".into())
        );
        assert!(normalized_email("person@localhost".into()).is_err());
    }

    /// Saved keys win, and the status the frontend sees never carries them.
    #[test]
    fn saved_keys_have_priority_and_are_never_serialized() {
        let vault = CredentialVault {
            openalex: Some("not-for-the-frontend".into()),
            semanticscholar: Some("also-secret".into()),
            firecrawl: Some("firecrawl-secret".into()),
            crossref_email: Some("person@example.org".into()),
        };
        let firecrawl = LiteratureProvider::Firecrawl;
        assert_eq!(effective(&vault, firecrawl).as_deref(), Some("firecrawl-secret"));
        assert_eq!(source(&vault, firecrawl), CredentialSource::Saved);
        assert!(matches!(
            source(&CredentialVault::default(), firecrawl),
            CredentialSource::Environment | CredentialSource::Shared | CredentialSource::Missing
        ));
        let json = serde_json::to_string(&status(&vault)).unwrap();
        assert!(json.contains("saved"));
        for secret in ["not-for-the-frontend", "also-secret", "firecrawl-secret"] {
            assert!(!json.contains(secret));
        }
    }

    /// A key is sent the way its provider expects, the response is
    /// classified, and the result never echoes the key.
    #[test]
    fn tests_a_draft_key_against_its_provider() {
        use CredentialTestState as State;
        for (provider, header, value, status, expected) in [
            (
                LiteratureProvider::SemanticScholar,
                "x-api-key",
                "draft-secret",
                429,
                State::RateLimited,
            ),
            (LiteratureProvider::Firecrawl, "authorization", "Bearer draft-secret", 200, State::Ok),
        ] {
            let (base, responder) = crate::literature_service::serve_once(move |request| {
                assert_eq!(request.method(), &tiny_http::Method::Get);
                assert!(request
                    .headers()
                    .iter()
                    .any(|found| found.field.equiv(header) && found.value.as_str() == value));
                request.respond(tiny_http::Response::empty(status)).unwrap();
            });
            let result = test_provider_at(provider, Some("draft-secret".into()), &base).unwrap();
            responder.join().unwrap();
            assert_eq!(result.status, expected, "{header}");
            assert!(result.authenticated);
            assert!(!serde_json::to_string(&result).unwrap().contains("draft-secret"));
        }
    }
}
