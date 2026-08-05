const SERVICE_PREFIX: &str = "com.lattice.research-writer.collab";
const MAX_COMPONENT: usize = 256;
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

fn entry(
    credential_ref: &str,
    project_instance_id: &str,
    deployment: &str,
) -> Result<keyring::Entry, String> {
    validate_component(credential_ref, "credential ref")?;
    validate_component(project_instance_id, "project instance id")?;
    validate_component(deployment, "deployment")?;
    let service = format!("{SERVICE_PREFIX}.{deployment}.{project_instance_id}");
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
    use super::validate_component;

    #[test]
    fn credential_identity_rejects_injection_and_oversize() {
        for invalid in ["", "../secret", "line\nbreak", "with space", "a\\b"] {
            assert!(validate_component(invalid, "value").is_err());
        }
        assert!(validate_component(&"a".repeat(257), "value").is_err());
        assert!(validate_component("cred_0123456789abcdef", "value").is_ok());
    }
}
