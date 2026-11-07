//! Platform-neutral download of a pinned TeX/tool archive.

use super::installer::{create_private_file, PinnedDownload};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

/// Stream `pinned` into a new private file at `path`, checking its SHA-256.
/// `on_bytes(downloaded, total)` follows along when the size is known.
pub(crate) fn download(
    pinned: &PinnedDownload, path: &Path, mut on_bytes: impl FnMut(u64, u64),
) -> Result<(), String> {
    let name = pinned.name;
    let user_agent = format!("Lattice/{}", env!("CARGO_PKG_VERSION"));
    let client = crate::http::blocking_as(&user_agent, pinned.timeout)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not initialize the {name} download: {error}"))?;
    let mut response = client
        .get(pinned.url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Could not download {}: {error}", pinned.source))?;
    let total = response.content_length().filter(|total| *total > 0);
    let mut file = create_private_file(path)?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("The {name} download was interrupted: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("Could not save the {name} download: {error}"))?;
        hasher.update(&buffer[..read]);
        downloaded += read as u64;
        if let Some(total) = total {
            on_bytes(downloaded, total);
        }
    }
    file.flush().map_err(|error| format!("Could not finish saving {name}: {error}"))?;
    if format!("{:x}", hasher.finalize()) != pinned.sha256 {
        return Err(format!("The downloaded {} failed its security check.", pinned.artifact));
    }
    Ok(())
}
