//! Linux release notices. The AppImage is updated manually; the signed macOS
//! updater feed has no Linux artifact. Check the latest release metadata and
//! only offer a release with an AppImage. Never download or install an executable.
use std::io::Read;
use std::time::Duration;

#[cfg(target_os = "linux")]
const FEED: &str = "https://api.github.com/repos/leo1oel/lattice/releases/latest";
const MAX_FEED_BYTES: u64 = 1024 * 1024;

fn numeric_version(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.');
    let mut parsed = [0; 3];
    for number in &mut parsed {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *number = part.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    Some(parsed)
}

fn newer_release(feed: &[u8], current: &str) -> Result<Option<String>, String> {
    let json: serde_json::Value = serde_json::from_slice(feed).map_err(|e| e.to_string())?;
    let tag = json.get("tag_name").and_then(|v| v.as_str()).ok_or("Release has no tag")?;
    let version = tag.strip_prefix('v').ok_or("Invalid release tag")?;
    let available = numeric_version(version).ok_or("Invalid release version")?;
    let installed = numeric_version(current).ok_or("Invalid installed version")?;
    let assets = json.get("assets").and_then(|v| v.as_array()).ok_or("Release has no assets")?;
    let expected = format!("Lattice_{version}_amd64.AppImage");
    let has_appimage = assets
        .iter()
        .any(|asset| asset.get("name").and_then(|v| v.as_str()) == Some(expected.as_str()));
    Ok((has_appimage && available > installed).then(|| version.to_string()))
}

fn fetch_url(url: &str, current: &str) -> Result<Option<String>, String> {
    let response = crate::http::blocking_as("Lattice release check", Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let mut body = Vec::new();
    response.take(MAX_FEED_BYTES + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 > MAX_FEED_BYTES {
        return Err("Release feed is too large".into());
    }
    newer_release(&body, current)
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) async fn check_linux_release() -> Result<Option<String>, String> {
    crate::ipc::run_quietly("Linux release check", || fetch_url(FEED, env!("CARGO_PKG_VERSION")))
        .await
}

#[cfg(test)]
mod tests {
    use super::{fetch_url, newer_release};
    use std::time::Duration;

    fn feed(version: &str, asset_version: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"tag_name": format!("v{version}"), "assets": [{"name": format!("Lattice_{asset_version}_amd64.AppImage")}]})).unwrap()
    }

    #[test]
    fn only_a_newer_release_with_its_linux_artifact_is_offered() {
        assert_eq!(
            newer_release(&feed("0.16.0", "0.16.0"), "0.15.8").unwrap(),
            Some("0.16.0".into())
        );
        assert_eq!(newer_release(&feed("0.15.8", "0.15.8"), "0.15.8").unwrap(), None);
        assert_eq!(newer_release(&feed("0.9.9", "0.9.9"), "0.15.8").unwrap(), None);
        assert_eq!(
            newer_release(&feed("0.10.0", "0.10.0"), "0.9.9").unwrap(),
            Some("0.10.0".into())
        );
        assert_eq!(newer_release(&feed("0.16.0", "0.15.8"), "0.15.8").unwrap(), None);
        assert!(newer_release(&feed("0.16.0-beta", "0.16.0-beta"), "0.15.8").is_err());
        assert!(newer_release(br#"{}"#, "0.15.8").is_err());
        assert!(newer_release(b"not json", "0.15.8").is_err());
    }

    #[test]
    fn fetch_checks_the_release_response_without_downloading_the_appimage() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/release", server.server_addr());
        let responder = std::thread::spawn(move || {
            let request = server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(request.url(), "/release");
            request.respond(tiny_http::Response::from_data(feed("0.16.0", "0.16.0"))).unwrap();
        });
        assert_eq!(fetch_url(&url, "0.15.8").unwrap(), Some("0.16.0".into()));
        responder.join().unwrap();
    }
}
