//! The endpoint's API key, alone in its own system-keychain item. Only two
//! readers ever see it: the key helper Pi runs for each request
//! (`model_endpoint::run_cli`) and Test connection. Nothing caches it.

const MAX_KEY: usize = 16 * 1024;
const UNAVAILABLE: &str = "Lattice could not use the system keychain.";

#[cfg(not(test))]
fn with_entry<T>(
    use_entry: impl FnOnce(&keyring::Entry) -> Result<T, String>,
) -> Result<T, String> {
    // Derived from the bundle identifier, so a lab or Beta build keeps its own.
    let service = format!("{}.model-endpoint", crate::app_identity::identifier());
    use_entry(&keyring::Entry::new(&service, "api-key-v1").map_err(|_| UNAVAILABLE.to_string())?)
}

#[cfg(test)]
fn with_entry<T>(
    use_entry: impl FnOnce(&keyring::Entry) -> Result<T, String>,
) -> Result<T, String> {
    // Tests never prompt for or touch the developer's real keychain; each test
    // thread keeps its own key.
    thread_local! {
        static MOCK: keyring::Entry = keyring::Entry::new_with_credential(
            Box::new(keyring::mock::MockCredential::default()),
        );
    }
    MOCK.with(use_entry)
}

/// A pasted key, trimmed; `None` for one that cannot be a key.
pub(super) fn normalized(key: &str) -> Option<String> {
    let key = key.trim();
    (!key.is_empty() && key.len() <= MAX_KEY && !key.chars().any(char::is_control))
        .then(|| key.to_string())
}

pub(super) fn read() -> Result<Option<String>, String> {
    with_entry(|entry| match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(UNAVAILABLE.to_string()),
    })
}

pub(super) fn save(key: &str) -> Result<(), String> {
    with_entry(|entry| entry.set_password(key).map_err(|_| UNAVAILABLE.to_string()))
}

pub(super) fn remove() -> Result<(), String> {
    with_entry(|entry| match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(UNAVAILABLE.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_replaces_and_removes_the_key() {
        assert_eq!(read().unwrap(), None);
        save("first").unwrap();
        save("second").unwrap();
        assert_eq!(read().unwrap().as_deref(), Some("second"));
        remove().unwrap();
        remove().unwrap();
        assert_eq!(read().unwrap(), None);
    }

    #[test]
    fn normalizes_pasted_keys() {
        assert_eq!(normalized("  sk-key \n").as_deref(), Some("sk-key"));
        for bad in ["", "   ", "two\nlines", &"x".repeat(MAX_KEY + 1)] {
            assert_eq!(normalized(bad), None, "{bad:?}");
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "writes and removes an isolated temporary system-keychain item"]
    fn system_keychain_roundtrip_isolated() {
        let entry = keyring::Entry::new(
            "app.leo1oel.researchwriter.model-endpoint.test",
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        entry.set_password("isolated-test-not-a-real-key").unwrap();
        let read = entry.get_password();
        entry.delete_credential().unwrap();
        assert_eq!(read.unwrap(), "isolated-test-not-a-real-key");
    }
}
