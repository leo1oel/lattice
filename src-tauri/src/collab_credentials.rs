use reqwest::Url;
use sha2::{Digest, Sha256};

const SERVICE_PREFIX: &str = "com.lattice.research-writer.collab";
const MAX_COMPONENT: usize = 256;
const MAX_DEPLOYMENT: usize = 2048;
const MAX_SECRET: usize = 16 * 1024;

fn validate_component(value: &str, name: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_COMPONENT
        || value.contains(['\n', '\r', '\0', '/', '\\'])
    {
        return Err(format!("invalid {name}"));
    }
    if !value
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
    Ok(Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn entry(
    credential_ref: &str,
    project_instance_id: &str,
    deployment: &str,
) -> Result<keyring::Entry, String> {
    validate_component(credential_ref, "credential ref")?;
    validate_component(project_instance_id, "project instance id")?;
    let deployment_key = deployment_key(deployment)?;
    let service = format!("{SERVICE_PREFIX}.{deployment_key}.{project_instance_id}");
    keyring::Entry::new(&service, credential_ref)
        .map_err(|_| "secure credential store unavailable".to_string())
}

#[tauri::command]
pub fn put_collab_credential(
    credential_ref: String,
    secret: String,
    project_instance_id: String,
    deployment: String,
) -> Result<(), String> {
    if secret.is_empty() || secret.len() > MAX_SECRET || secret.contains(['\n', '\r', '\0']) {
        return Err("invalid credential secret".to_string());
    }
    entry(&credential_ref, &project_instance_id, &deployment)?
        .set_password(&secret)
        .map_err(|_| "could not save credential in the system keychain".to_string())
}

#[tauri::command]
pub fn get_collab_credential(
    credential_ref: String,
    project_instance_id: String,
    deployment: String,
) -> Result<Option<String>, String> {
    match entry(&credential_ref, &project_instance_id, &deployment)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("could not read credential from the system keychain".to_string()),
    }
}

#[tauri::command]
pub fn delete_collab_credential(
    credential_ref: String,
    project_instance_id: String,
    deployment: String,
) -> Result<(), String> {
    match entry(&credential_ref, &project_instance_id, &deployment)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("could not delete credential from the system keychain".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{deployment_key, validate_component};

    #[test]
    fn credential_identity_rejects_injection_and_oversize() {
        for invalid in ["", "../secret", "line\nbreak", "with space", "a\\b"] {
            assert!(validate_component(invalid, "value").is_err());
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
}
