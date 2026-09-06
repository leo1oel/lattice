use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

const SERVICE: &str = "app.leo1oel.researchwriter.literature";
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
    crossref_email: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiteratureProvider {
    OpenAlex,
    SemanticScholar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialSource {
    Saved,
    Environment,
    Anonymous,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureCredentialStatus {
    openalex: CredentialSource,
    semanticscholar: CredentialSource,
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
    VAULT
        .lock()
        .map_err(|_| "secure credential store unavailable".to_string())
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "secure credential store unavailable".to_string())
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
    cache: &mut Option<CredentialVault>,
    entry: &keyring::Entry,
    update: impl FnOnce(&mut CredentialVault),
) -> Result<(), String> {
    let mut next = if let Some(vault) = cache.as_ref() {
        vault.clone()
    } else {
        read_vault(entry)?
    };
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
        env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn effective(vault: &CredentialVault, provider: LiteratureProvider) -> Option<String> {
    match provider {
        LiteratureProvider::OpenAlex => vault
            .openalex
            .clone()
            .or_else(|| env_value(&["OPENALEX_API_KEY"])),
        LiteratureProvider::SemanticScholar => vault
            .semanticscholar
            .clone()
            .or_else(|| env_value(&["SEMANTIC_SCHOLAR_API_KEY", "S2_API_KEY"])),
    }
}

fn source(vault: &CredentialVault, provider: LiteratureProvider) -> CredentialSource {
    let saved = match provider {
        LiteratureProvider::OpenAlex => vault.openalex.is_some(),
        LiteratureProvider::SemanticScholar => vault.semanticscholar.is_some(),
    };
    if saved {
        CredentialSource::Saved
    } else if effective(vault, provider).is_some() {
        CredentialSource::Environment
    } else {
        CredentialSource::Anonymous
    }
}

fn status(vault: &CredentialVault) -> LiteratureCredentialStatus {
    LiteratureCredentialStatus {
        openalex: source(vault, LiteratureProvider::OpenAlex),
        semanticscholar: source(vault, LiteratureProvider::SemanticScholar),
        crossref_email: vault.crossref_email.clone().unwrap_or_else(|| {
            env_value(&["BIBCITE_MAILTO"])
                .and_then(|email| normalized_email(email).ok().flatten())
                .unwrap_or_default()
        }),
    }
}

pub(crate) fn openalex_key() -> Result<Option<String>, String> {
    Ok(effective(&loaded_vault()?, LiteratureProvider::OpenAlex))
}

pub(crate) fn semanticscholar_key() -> Result<Option<String>, String> {
    Ok(effective(
        &loaded_vault()?,
        LiteratureProvider::SemanticScholar,
    ))
}

pub(crate) fn crossref_contact() -> Result<Option<String>, String> {
    let vault = loaded_vault()?;
    Ok(vault.crossref_email.or_else(|| {
        env_value(&["BIBCITE_MAILTO"]).and_then(|email| normalized_email(email).ok().flatten())
    }))
}

#[tauri::command]
pub async fn get_literature_credentials() -> Result<LiteratureCredentialStatus, String> {
    tauri::async_runtime::spawn_blocking(|| loaded_vault().map(|vault| status(&vault)))
        .await
        .map_err(|_| "could not read literature credential settings".to_string())?
}

#[tauri::command]
pub async fn set_literature_credential(
    provider: LiteratureProvider,
    secret: Option<String>,
) -> Result<LiteratureCredentialStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let secret = secret.map(normalized_secret).transpose()?;
        update_vault(|vault| match provider {
            LiteratureProvider::OpenAlex => vault.openalex = secret,
            LiteratureProvider::SemanticScholar => vault.semanticscholar = secret,
        })?;
        loaded_vault().map(|vault| status(&vault))
    })
    .await
    .map_err(|_| "could not save literature credential settings".to_string())?
}

#[tauri::command]
pub async fn set_literature_contact(email: String) -> Result<LiteratureCredentialStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let email = normalized_email(email)?;
        update_vault(|vault| vault.crossref_email = email)?;
        loaded_vault().map(|vault| status(&vault))
    })
    .await
    .map_err(|_| "could not save literature contact settings".to_string())?
}

#[tauri::command]
pub async fn test_literature_credential(
    provider: LiteratureProvider,
    secret: Option<String>,
) -> Result<LiteratureCredentialTest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = match secret {
            Some(secret) => Some(normalized_secret(secret)?),
            None => effective(&loaded_vault()?, provider),
        };
        test_provider(provider, key)
    })
    .await
    .map_err(|_| "could not test literature credential".to_string())?
}

fn test_provider(
    provider: LiteratureProvider,
    key: Option<String>,
) -> Result<LiteratureCredentialTest, String> {
    let url = match provider {
        LiteratureProvider::OpenAlex => {
            "https://api.openalex.org/works/https://doi.org/10.1038/nphys1170"
        }
        LiteratureProvider::SemanticScholar => {
            "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/nphys1170?fields=paperId"
        }
    };
    test_provider_at(provider, key, url)
}

fn test_provider_at(
    provider: LiteratureProvider,
    key: Option<String>,
    url: &str,
) -> Result<LiteratureCredentialTest, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(TEST_TIMEOUT)
        .redirect(Policy::none())
        .build()
        .map_err(|_| "could not create literature API client".to_string())?;
    let mut request = crate::literature_service::request(&client, url, None, key.is_none())?;
    if let Some(secret) = key.as_deref() {
        request = match provider {
            LiteratureProvider::OpenAlex => request.bearer_auth(secret),
            LiteratureProvider::SemanticScholar => request.header("x-api-key", secret),
        };
    }
    let authenticated = key.is_some();
    let status = match request.send() {
        Ok(response) if response.status().is_success() => CredentialTestState::Ok,
        Ok(response) if matches!(response.status().as_u16(), 401 | 403) => {
            CredentialTestState::Unauthorized
        }
        Ok(response) if response.status().as_u16() == 429 => CredentialTestState::RateLimited,
        Ok(_) | Err(_) => CredentialTestState::Unavailable,
    };
    Ok(LiteratureCredentialTest {
        status,
        authenticated,
    })
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
            assert_eq!(
                persisted.openalex.as_deref(),
                Some("isolated-test-not-a-real-key")
            );
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
        let entry =
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        let mut cache = None;
        update_cached_vault(&mut cache, &entry, |vault| {
            vault.openalex = Some("first".into());
            vault.semanticscholar = Some("second".into());
        })
        .unwrap();
        assert_eq!(
            read_vault(&entry).unwrap().openalex.as_deref(),
            Some("first")
        );
        entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap()
            .set_error(keyring::Error::NoEntry);
        assert!(update_cached_vault(&mut cache, &entry, |vault| {
            vault.openalex = Some("failed-replacement".into());
        })
        .is_err());
        assert_eq!(cache.as_ref().unwrap().openalex.as_deref(), Some("first"));
        assert_eq!(
            read_vault(&entry).unwrap().openalex.as_deref(),
            Some("first")
        );
        // Simulate reopening with no in-process cache, then removing one key.
        cache = None;
        update_cached_vault(&mut cache, &entry, |vault| vault.openalex = None).unwrap();
        let reloaded = read_vault(&entry).unwrap();
        assert!(reloaded.openalex.is_none());
        assert_eq!(reloaded.semanticscholar.as_deref(), Some("second"));
    }

    #[test]
    fn validates_secrets_and_contacts() {
        assert_eq!(normalized_secret("  token  ".into()).unwrap(), "token");
        assert!(normalized_secret("".into()).is_err());
        assert!(normalized_secret("bad\nkey".into()).is_err());
        assert_eq!(normalized_email(" ".into()).unwrap(), None);
        assert_eq!(
            normalized_email(" person@example.org ".into()).unwrap(),
            Some("person@example.org".into())
        );
        assert!(normalized_email("person@localhost".into()).is_err());
    }

    #[test]
    fn saved_status_does_not_serialize_secrets() {
        let vault = CredentialVault {
            openalex: Some("not-for-the-frontend".into()),
            semanticscholar: Some("also-secret".into()),
            crossref_email: Some("person@example.org".into()),
        };
        let json = serde_json::to_string(&status(&vault)).unwrap();
        assert!(json.contains("saved"));
        assert!(!json.contains("not-for-the-frontend"));
        assert!(!json.contains("also-secret"));
    }

    #[test]
    fn classifies_provider_response_without_echoing_key() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/paper", server.server_addr());
        let responder = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            assert!(request
                .headers()
                .iter()
                .any(|header| header.field.equiv("x-api-key")
                    && header.value.as_str() == "draft-secret"));
            request.respond(tiny_http::Response::empty(429)).unwrap();
        });
        let result = test_provider_at(
            LiteratureProvider::SemanticScholar,
            Some("draft-secret".into()),
            &endpoint,
        )
        .unwrap();
        responder.join().unwrap();
        assert_eq!(result.status, CredentialTestState::RateLimited);
        assert!(result.authenticated);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("draft-secret"));
    }
}
