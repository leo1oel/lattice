//! Installing a release, as tauri-plugin-updater installs one on macOS: the
//! archive (`Lattice.app.tar.gz`) is downloaded, its minisign signature
//! checked against the channel's public key (the updater's own key, apart
//! from Apple's code signing), and the app bundle it holds put in place of
//! the running one. The running app keeps its files open, so it goes on
//! until it restarts; the next launch is the new version.

use std::{
    io::Read as _,
    path::{Path, PathBuf},
    time::Duration,
};

use base64::Engine as _;

/// How long a download may take, end to end.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// How long a manifest request may take.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = concat!("Lattice/", env!("CARGO_PKG_VERSION"), " (GPUI)");

/// The app bundle the running binary is in (`…/Lattice.app`), if it is in
/// one: a binary run from a build tree has nothing to replace.
pub fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

/// Read `url`: an `http(s)` address, or a `file://` one (a local channel).
pub fn fetch_text(url: &str) -> Result<String, String> {
    if let Some(path) = url.strip_prefix("file://") {
        return std::fs::read_to_string(path).map_err(|error| error.to_string());
    }
    let client = lattice_core::http::blocking_as(USER_AGENT, CHECK_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?;
    response.text().map_err(|error| error.to_string())
}

/// Download `url`, telling `progress` the share received so far when the
/// size is known.
pub fn download(url: &str, mut progress: impl FnMut(Option<f32>)) -> Result<Vec<u8>, String> {
    if let Some(path) = url.strip_prefix("file://") {
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        progress(Some(1.));
        return Ok(bytes);
    }
    let client = lattice_core::http::blocking_as(USER_AGENT, DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?;
    let total = response.content_length().filter(|total| *total > 0);
    let mut bytes = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let read = response
            .read(&mut chunk)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        progress(total.map(|total| (bytes.len() as f32 / total as f32).min(1.)));
    }
    Ok(bytes)
}

/// Check `bytes` against `signature` (the `.sig` file's text, base64) with
/// `public_key` (the minisign public key's text, base64), as the plugin
/// checks them.
pub fn verify(bytes: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let decode = |text: &str| -> Result<String, String> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .map_err(|error| format!("not base64: {error}"))?;
        String::from_utf8(raw).map_err(|error| error.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(public_key)?)
        .map_err(|error| format!("the update key: {error}"))?;
    let signature = minisign_verify::Signature::decode(&decode(signature)?)
        .map_err(|error| format!("the update's signature: {error}"))?;
    key.verify(bytes, &signature, true)
        .map_err(|error| format!("the update's signature does not match: {error}"))
}

/// Put the bundle in `archive` (a gzipped tar holding one `*.app`) in place
/// of `bundle`: unpacked beside it first, so the swap is two renames on one
/// volume, and the old bundle removed once the new one is in place.
pub fn replace_bundle(archive: &[u8], bundle: &Path) -> Result<(), String> {
    let parent = bundle
        .parent()
        .ok_or_else(|| "the app has no folder".to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".lattice-update-")
        .tempdir_in(parent)
        .map_err(|error| format!("could not unpack beside the app: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(archive);
    tar::Archive::new(decoder)
        .unpack(staging.path())
        .map_err(|error| format!("could not unpack the update: {error}"))?;
    let unpacked = std::fs::read_dir(staging.path())
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .ok_or_else(|| "the update holds no app".to_string())?;
    let old = parent.join(format!(
        ".lattice-replaced-{}.app",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::rename(bundle, &old)
        .map_err(|error| format!("could not move the running app aside: {error}"))?;
    if let Err(error) = std::fs::rename(&unpacked, bundle) {
        // Put the running app back where it was.
        std::fs::rename(&old, bundle).ok();
        return Err(format!("could not put the update in place: {error}"));
    }
    std::fs::remove_dir_all(&old).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key pair and a signature made with `tauri signer` for these tests,
    /// over [`SIGNED`].
    const PUBLIC_KEY: &str = include_str!("fixtures/test.pub");
    const SIGNATURE: &str = include_str!("fixtures/signed.txt.sig");
    const SIGNED: &[u8] = include_bytes!("fixtures/signed.txt");

    #[test]
    fn a_signed_update_passes_and_a_changed_one_does_not() {
        assert_eq!(verify(SIGNED, SIGNATURE, PUBLIC_KEY), Ok(()));
        let mut changed = SIGNED.to_vec();
        changed.push(b'!');
        assert!(verify(&changed, SIGNATURE, PUBLIC_KEY).is_err());
        assert!(verify(SIGNED, "not base64!", PUBLIC_KEY).is_err());
    }

    #[test]
    fn an_update_replaces_the_bundle_and_the_old_one_goes() {
        let folder = tempfile::tempdir().unwrap();
        let bundle = folder.path().join("Lattice.app");
        std::fs::create_dir_all(bundle.join("Contents")).unwrap();
        std::fs::write(bundle.join("Contents/version"), "old").unwrap();
        let mut archive = Vec::new();
        {
            let encoder =
                flate2::write::GzEncoder::new(&mut archive, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(3);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "Lattice.app/Contents/version", &b"new"[..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        replace_bundle(&archive, &bundle).unwrap();
        assert_eq!(
            std::fs::read_to_string(bundle.join("Contents/version")).unwrap(),
            "new"
        );
        let left: Vec<_> = std::fs::read_dir(folder.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from("Lattice.app")]);
        assert!(replace_bundle(b"not an archive", &bundle).is_err());
        assert!(
            bundle.join("Contents/version").exists(),
            "a bad update keeps the app"
        );
    }
}
