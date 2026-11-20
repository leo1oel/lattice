//! The Overleaf git token (Account Settings → Git integration), kept in the
//! system keychain. One token serves every project on the host it was made
//! for; it is never written to a project folder or a git remote's URL.
use serde::Serialize;

const MAX_TOKEN: usize = 1024;

#[cfg(not(test))]
const ACCOUNT: &str = "git-token-v1";

/// Whether a token is saved. The token itself never leaves the backend.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafGitTokenStatus {
    pub saved: bool,
}

#[cfg(not(test))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(&format!("{}.overleaf", crate::app_identity::identifier()), ACCOUNT)
        .map_err(|_| "secure credential store unavailable".to_string())
}

#[cfg(test)]
fn entry() -> Result<keyring::Entry, String> {
    // Unit tests must never reach the developer's real keychain.
    Ok(keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default())))
}

/// A token as it will be sent in an HTTP header: visible ASCII only, so a
/// pasted newline cannot add a header of its own.
fn normalized(token: &str) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("The git token is empty.".to_string());
    }
    if token.len() > MAX_TOKEN || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("That does not look like an Overleaf git token.".to_string());
    }
    Ok(token.to_string())
}

fn read(entry: &keyring::Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(token) => Ok(Some(token).filter(|token| !token.is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("could not read the Overleaf git token from the system keychain".to_string()),
    }
}

fn write(entry: &keyring::Entry, token: Option<&str>) -> Result<(), String> {
    let saved = match token {
        Some(token) => entry.set_password(token),
        None => entry.delete_credential(),
    };
    match saved {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("could not save the Overleaf git token in the system keychain".to_string()),
    }
}

/// The saved token, for the one git process that sends it.
pub fn token() -> Result<Option<String>, String> {
    read(&entry()?)
}

pub fn status() -> Result<OverleafGitTokenStatus, String> {
    Ok(OverleafGitTokenStatus { saved: token()?.is_some() })
}

/// Save `token`, or forget the saved one when it is `None`.
pub fn set(token: Option<String>) -> Result<OverleafGitTokenStatus, String> {
    let token = token.map(|token| normalized(&token)).transpose()?;
    write(&entry()?, token.as_deref())?;
    Ok(OverleafGitTokenStatus { saved: token.is_some() })
}

/// Keychain access blocks, so each command runs off the async runtime.
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    crate::runtime::spawn_blocking(work)
        .await
        .map_err(|_| "could not reach the Overleaf git token settings".to_string())?
}

pub async fn get_status() -> Result<OverleafGitTokenStatus, String> {
    off_thread(status).await
}

pub async fn set_token(token: Option<String>) -> Result<OverleafGitTokenStatus, String> {
    off_thread(move || set(token)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock() -> keyring::Entry {
        keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
    }

    #[test]
    fn a_saved_token_is_read_back_and_forgetting_it_leaves_none() {
        let entry = mock();
        assert_eq!(read(&entry).unwrap(), None);

        write(&entry, Some("olp_abc123")).unwrap();
        assert_eq!(read(&entry).unwrap().as_deref(), Some("olp_abc123"));

        write(&entry, None).unwrap();
        assert_eq!(read(&entry).unwrap(), None);
        // Forgetting what is not saved is not an error.
        write(&entry, None).unwrap();
    }

    #[test]
    fn only_a_token_that_is_safe_in_a_header_is_accepted() {
        assert_eq!(normalized("  olp_abc123\n").unwrap(), "olp_abc123");
        for bad in ["", "   ", "two words", "olp_abc\r\nX-Injected: 1", "tab\there", "é"] {
            assert!(normalized(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(normalized(&"a".repeat(MAX_TOKEN + 1)).is_err());
    }
}
