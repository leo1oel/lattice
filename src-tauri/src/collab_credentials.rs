//! Lattice Shares room credentials in the system keychain.
//!
//! Every room lives in one keychain item, so macOS asks for access once rather
//! than once per room. Items from the older one-per-room layout migrate the
//! next time their room is opened.

use reqwest::Url;
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

const SERVICE_PREFIX: &str = "com.lattice.research-writer.collab";
const VAULT_ACCOUNT: &str = "credential-vault-v1";
const MAX_COMPONENT: usize = 256;
const MAX_DEPLOYMENT: usize = 2048;
const MAX_SECRET: usize = 16 * 1024;
const UNAVAILABLE: &str = "secure credential store unavailable";
const READ_FAILED: &str = "could not read credential from the system keychain";
const SAVE_FAILED: &str = "could not save credential in the system keychain";
static VAULT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, serde::Deserialize, serde::Serialize)]
struct CredentialVault {
    credentials: BTreeMap<String, String>,
}

/// The vault item, held under the process-wide lock for one read-modify-write.
struct OpenVault {
    _guard: MutexGuard<'static, ()>,
    entry: keyring::Entry,
    vault: CredentialVault,
}

impl OpenVault {
    fn open() -> Result<Self, String> {
        let guard = VAULT_LOCK.lock().map_err(|_| UNAVAILABLE.to_string())?;
        let entry = keyring::Entry::new(SERVICE_PREFIX, VAULT_ACCOUNT)
            .map_err(|_| UNAVAILABLE.to_string())?;
        let vault = match entry.get_password() {
            Ok(encoded) => serde_json::from_str(&encoded).map_err(|_| READ_FAILED.to_string())?,
            Err(keyring::Error::NoEntry) => CredentialVault::default(),
            Err(_) => return Err(READ_FAILED.to_string()),
        };
        Ok(Self { _guard: guard, entry, vault })
    }

    fn save(&self) -> Result<(), String> {
        let encoded = serde_json::to_string(&self.vault).map_err(|_| SAVE_FAILED.to_string())?;
        self.entry.set_password(&encoded).map_err(|_| SAVE_FAILED.to_string())
    }
}

fn validate_component(value: &str, name: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_COMPONENT
        || value.contains(['\n', '\r', '\0', '/', '\\'])
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err(format!("invalid {name}"));
    }
    Ok(())
}

fn deployment_key(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > MAX_DEPLOYMENT {
        return Err("invalid deployment".to_string());
    }
    let url = Url::parse(value).map_err(|_| "invalid deployment".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("invalid deployment".to_string());
    }
    Ok(crate::util::sha256_hex(value))
}

/// Refuse an identity that could name some other keychain item.
fn validate_identity(
    credential_ref: &str, project_instance_id: &str, deployment: &str,
) -> Result<(), String> {
    validate_component(credential_ref, "credential ref")?;
    validate_component(project_instance_id, "project instance id")?;
    deployment_key(deployment).map(drop)
}

/// The pre-vault item for one room, keyed by deployment and project.
fn legacy_entry(
    credential_ref: &str, project_instance_id: &str, deployment: &str,
) -> Result<keyring::Entry, String> {
    let deployment_key = deployment_key(deployment)?;
    let service = format!("{SERVICE_PREFIX}.{deployment_key}.{project_instance_id}");
    keyring::Entry::new(&service, credential_ref).map_err(|_| UNAVAILABLE.to_string())
}

#[tauri::command]
pub fn put_collab_credential(
    credential_ref: String, secret: String, project_instance_id: String, deployment: String,
) -> Result<(), String> {
    if secret.is_empty() || secret.len() > MAX_SECRET || secret.contains(['\n', '\r', '\0']) {
        return Err("invalid credential secret".to_string());
    }
    validate_identity(&credential_ref, &project_instance_id, &deployment)?;
    let mut open = OpenVault::open()?;
    open.vault.credentials.insert(credential_ref, secret);
    open.save()
}

#[tauri::command]
pub fn get_collab_credential(
    credential_ref: String, project_instance_id: String, deployment: String,
) -> Result<Option<String>, String> {
    validate_identity(&credential_ref, &project_instance_id, &deployment)?;
    let mut open = OpenVault::open()?;
    if let Some(secret) = open.vault.credentials.get(&credential_ref) {
        return Ok(Some(secret.clone()));
    }

    let legacy_entry = legacy_entry(&credential_ref, &project_instance_id, &deployment)?;
    match legacy_entry.get_password() {
        Ok(secret) => {
            open.vault.credentials.insert(credential_ref, secret.clone());
            open.save()?;
            // Migration is complete before the old item is removed. Failure to
            // clean it up must not make a valid saved room unusable.
            let _ = legacy_entry.delete_credential();
            Ok(Some(secret))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(READ_FAILED.to_string()),
    }
}

#[tauri::command]
pub fn delete_collab_credential(
    credential_ref: String, project_instance_id: String, deployment: String,
) -> Result<(), String> {
    validate_identity(&credential_ref, &project_instance_id, &deployment)?;
    let mut open = OpenVault::open()?;
    if open.vault.credentials.remove(&credential_ref).is_some() {
        // Keep one empty vault item so its Keychain authorization survives
        // deleting the final recent room.
        open.save()?;
    }
    // Do not probe a legacy per-room item here: each probe can itself trigger
    // the macOS password dialog this command is meant to avoid. Old entries
    // migrate and are cleaned up the next time that room is opened.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{deployment_key, validate_component, CredentialVault};

    #[test]
    fn credential_identity_rejects_injection_and_oversize() {
        for invalid in ["", "../secret", "line\nbreak", "with space", "a\\b"] {
            assert!(validate_component(invalid, "value").is_err(), "accepted {invalid:?}");
        }
        assert!(validate_component(&"a".repeat(257), "value").is_err());
        assert!(validate_component("cred_0123456789abcdef", "value").is_ok());
    }

    #[test]
    fn credential_deployment_accepts_origins_and_hashes_them_for_the_service_name() {
        let remote = deployment_key("https://lattice-collab.example.workers.dev").unwrap();
        let local = deployment_key("http://localhost:8787").unwrap();
        assert_eq!(remote.len(), 64);
        assert_eq!(local.len(), 64);
        assert_ne!(remote, local);

        for invalid in [
            "lattice-collab.example.workers.dev",
            "ftp://example.com",
            "https://user@example.com",
            "https://example.com/path",
            "https://example.com/?query=1",
        ] {
            assert!(deployment_key(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn vault_keeps_multiple_room_credentials_in_one_value() {
        let encoded = r#"{"credentials":{"collab_first":"secret-a","collab_second":"secret-b"}}"#;
        let vault: CredentialVault = serde_json::from_str(encoded).unwrap();
        assert_eq!(vault.credentials.len(), 2);
        assert_eq!(serde_json::to_string(&vault).unwrap(), encoded);
    }
}
