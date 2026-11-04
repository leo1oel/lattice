//! Read a user-selected, inert sprite package. No scripts, URLs, or external paths.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path};

pub const MAX_IMAGE: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pet {
    pub name: String,
    pub version: u8,
    pub mime: String,
    pub image: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    display_name: String,
    #[serde(default = "first_version")]
    sprite_version_number: u8,
    spritesheet_path: String,
}
fn first_version() -> u8 {
    1
}

pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Pet file could not be opened")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Pet file could not be read")?;
    if bytes.len() as u64 > limit {
        return Err("Pet file is too large".into());
    }
    Ok(bytes)
}

pub fn import(path: &Path) -> Result<Pet, String> {
    let manifest_path = path.canonicalize().map_err(|_| "Choose a pet.json file")?;
    let manifest: Manifest = serde_json::from_slice(&read_limited(&manifest_path, 32 * 1024)?)
        .map_err(|_| "The pet manifest is invalid")?;
    let name = manifest.display_name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("The pet needs a name of at most 80 characters".into());
    }
    let version = manifest.sprite_version_number;
    if ![1, 2].contains(&version) {
        return Err("Supported pet sprite versions are 1 and 2".into());
    }
    let root = manifest_path.parent().ok_or("The pet package has no folder")?;
    let image_path = root
        .join(&manifest.spritesheet_path)
        .canonicalize()
        .map_err(|_| "The pet spritesheet could not be found")?;
    if !image_path.starts_with(root) || !image_path.is_file() {
        return Err("The spritesheet must stay inside the pet package folder".into());
    }
    let bytes = read_limited(&image_path, MAX_IMAGE)?;
    let (mime, width, height) = dimensions(&bytes).ok_or("Use a PNG or WebP spritesheet")?;
    let expected_height = if version == 2 { 2288 } else { 1872 };
    if width != 1536 || height != expected_height {
        return Err(format!("The spritesheet must be 1536 × {expected_height} pixels"));
    }
    Ok(Pet { name: name.into(), version, mime: mime.into(), image: STANDARD.encode(bytes) })
}

/// Dimensions from the fixed PNG/WebP headers; the WebView still decodes the
/// image before showing it. SVG and executable formats are never accepted.
fn dimensions(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16)? == b"IHDR" {
        return Some((
            "image/png",
            u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?),
            u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?),
        ));
    }
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    let size = match bytes.get(12..16)? {
        b"VP8X" => {
            let read = |start| {
                Some(
                    u32::from_le_bytes([
                        *bytes.get(start)?,
                        *bytes.get(start + 1)?,
                        *bytes.get(start + 2)?,
                        0,
                    ]) + 1,
                )
            };
            (read(24)?, read(27)?)
        }
        b"VP8L" if *bytes.get(20)? == 0x2f => {
            let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        }
        b"VP8 " if bytes.get(23..26)? == b"\x9d\x01\x2a" => (
            u16::from_le_bytes(bytes.get(26..28)?.try_into().ok()?) as u32 & 0x3fff,
            u16::from_le_bytes(bytes.get(28..30)?.try_into().ok()?) as u32 & 0x3fff,
        ),
        _ => return None,
    };
    Some(("image/webp", size.0, size.1))
}
