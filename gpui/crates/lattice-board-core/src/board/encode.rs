// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Scenes embedded in images. Port of Excalidraw
//! `packages/excalidraw/data/encode.ts` (`encode` / `decode`: byte strings,
//! zlib), `data/image.ts` (the PNG `tEXt` chunk) and the SVG payload half of
//! `scene/export.ts` (`encodeSvgBase64Payload` / `decodeSvgBase64Payload`)
//! @ 3a317b5. Encryption (`compressData`, collaboration links) isn't ported.
//!
//! A "byte string" is upstream's: one char per byte (code points 0–255),
//! which is Latin-1 here.

use super::image::mime;
use base64::Engine;
use serde_json::Value;

/// Why an image yields no scene (`ImageSceneDataError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SceneDataError {
    /// The image has no scene in it (`"INVALID"`, `IMAGE_NOT_CONTAINS_SCENE_DATA`).
    NoScene,
    /// It has one that can't be read (`"FAILED"`).
    Failed,
}

/// `EncodedData` (`encoding: "bstring"`).
#[derive(Clone, Debug, PartialEq)]
pub struct EncodedData {
    pub encoded: String,
    pub compressed: bool,
    pub version: Option<String>,
}

/// Bytes as a byte string.
pub fn to_byte_string(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}
/// A byte string's bytes; None if a char is past 255.
pub fn byte_string_to_bytes(s: &str) -> Option<Vec<u8>> {
    s.chars().map(|c| u8::try_from(c as u32).ok()).collect()
}

/// `encode`: the text, zlib-deflated unless `compress` is false, as a byte
/// string.
pub fn encode(text: &str, compress: bool) -> EncodedData {
    let encoded = if compress {
        to_byte_string(&miniz_oxide::deflate::compress_to_vec_zlib(
            text.as_bytes(),
            6,
        ))
    } else {
        to_byte_string(text.as_bytes())
    };
    EncodedData {
        encoded,
        compressed: compress,
        version: Some("1".into()),
    }
}

/// `decode`.
pub fn decode(d: &EncodedData) -> Result<String, String> {
    let bytes = byte_string_to_bytes(&d.encoded).ok_or("decode: not a byte string")?;
    let bytes = if d.compressed {
        miniz_oxide::inflate::decompress_to_vec_zlib(&bytes)
            .map_err(|e| format!("inflate: {e:?}"))?
    } else {
        bytes
    };
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// `JSON.stringify(encodedData)`, keys in upstream's order.
pub fn encoded_to_json(d: &EncodedData) -> String {
    let mut out = String::from("{");
    if let Some(v) = &d.version {
        out.push_str(&format!("\"version\":{},", Value::from(v.as_str())));
    }
    out.push_str(&format!(
        "\"encoding\":\"bstring\",\"compressed\":{},\"encoded\":{}}}",
        d.compressed,
        Value::from(d.encoded.as_str())
    ));
    out
}

/// Reads `{"encoded": …}` JSON into the scene JSON; legacy un-encoded
/// scene JSON comes back as is.
fn decode_encoded_json(json: &str) -> Result<String, SceneDataError> {
    let v: Value = serde_json::from_str(json).map_err(|_| SceneDataError::Failed)?;
    let Some(o) = v.as_object() else {
        return Err(SceneDataError::Failed);
    };
    if !o.contains_key("encoded") {
        // legacy, un-encoded scene JSON
        return if o.get("type").and_then(Value::as_str)
            == Some(super::consts::EXPORT_DATA_TYPE_EXCALIDRAW)
        {
            Ok(json.into())
        } else {
            Err(SceneDataError::Failed)
        };
    }
    if o.get("encoding").and_then(Value::as_str) != Some("bstring") {
        return Err(SceneDataError::Failed);
    }
    let d = EncodedData {
        encoded: o
            .get("encoded")
            .and_then(Value::as_str)
            .ok_or(SceneDataError::Failed)?
            .into(),
        compressed: o
            .get("compressed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        version: o.get("version").and_then(Value::as_str).map(str::to_owned),
    };
    decode(&d).map_err(|_| SceneDataError::Failed)
}

// ---------------------------------------------------------------------------
// PNG (png-chunks-extract / png-chunk-text / png-chunks-encode)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// The chunks of a PNG: (type, data).
pub fn png_chunks(png: &[u8]) -> Result<Vec<([u8; 4], Vec<u8>)>, String> {
    if !png.starts_with(&PNG_SIGNATURE) {
        return Err("Invalid .png file header".into());
    }
    let mut out = vec![];
    let mut i = 8;
    while i + 8 <= png.len() {
        let len = u32::from_be_bytes(png[i..i + 4].try_into().unwrap()) as usize;
        let name: [u8; 4] = png[i + 4..i + 8].try_into().unwrap();
        let end = i + 8 + len;
        if end + 4 > png.len() {
            return Err("Truncated .png chunk".into());
        }
        out.push((name, png[i + 8..end].to_vec()));
        i = end + 4;
        if &name == b"IEND" {
            break;
        }
    }
    Ok(out)
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

/// `png-chunks-encode`.
pub fn encode_png_chunks(chunks: &[([u8; 4], Vec<u8>)]) -> Vec<u8> {
    let mut out = PNG_SIGNATURE.to_vec();
    for (name, data) in chunks {
        out.extend((data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend(name);
        out.extend(data);
        let crc = crc32(&out[start..]);
        out.extend(crc.to_be_bytes());
    }
    out
}

/// `getTEXtChunk`: the first `tEXt` chunk's keyword and text (Latin-1).
pub fn get_text_chunk(png: &[u8]) -> Option<(String, String)> {
    let chunks = png_chunks(png).ok()?;
    let (_, data) = chunks.iter().find(|(n, _)| n == b"tEXt")?;
    let nul = data.iter().position(|&b| b == 0)?;
    Some((
        to_byte_string(&data[..nul]),
        to_byte_string(&data[nul + 1..]),
    ))
}

/// `encodePngMetadata`: the PNG with the scene in a `tEXt` chunk (keyword
/// `application/vnd.excalidraw+json`) before `IEND`.
pub fn encode_png_metadata(png: &[u8], metadata: &str) -> Result<Vec<u8>, String> {
    let mut chunks = png_chunks(png)?;
    let text = encoded_to_json(&encode(metadata, true));
    let mut data: Vec<u8> = mime::EXCALIDRAW.bytes().collect();
    data.push(0);
    data.extend(text.chars().map(|c| c as u32 as u8));
    let at = chunks.len().saturating_sub(1);
    chunks.insert(at, (*b"tEXt", data));
    Ok(encode_png_chunks(&chunks))
}

/// `decodePngMetadata`: the scene JSON embedded in a PNG.
pub fn decode_png_metadata(png: &[u8]) -> Result<String, SceneDataError> {
    match get_text_chunk(png) {
        Some((k, text)) if k == mime::EXCALIDRAW => decode_encoded_json(&text),
        _ => Err(SceneDataError::NoScene),
    }
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/// `encodeSvgBase64Payload`: the comments and base64 text that go in the
/// SVG's `<metadata>` (version 2: the base64 of a byte string).
pub fn encode_svg_base64_payload(payload: &str) -> String {
    let json = encoded_to_json(&encode(payload, true));
    let bytes: Vec<u8> = json.chars().map(|c| c as u32 as u8).collect();
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!(
        "<!-- payload-type:{} --><!-- payload-version:2 --><!-- payload-start -->{b64}<!-- payload-end -->",
        mime::EXCALIDRAW
    )
}

/// `decodeSvgBase64Payload`: the scene JSON embedded in an SVG.
pub fn decode_svg_base64_payload(svg: &str) -> Result<String, SceneDataError> {
    if !svg.contains(&format!("payload-type:{}", mime::EXCALIDRAW)) {
        return Err(SceneDataError::NoScene);
    }
    let re = regex::Regex::new(r"<!-- payload-start -->\s*(.+?)\s*<!-- payload-end -->").unwrap();
    let Some(m) = re.captures(svg) else {
        return Err(SceneDataError::NoScene);
    };
    let version = regex::Regex::new(r"<!-- payload-version:(\d+) -->")
        .unwrap()
        .captures(svg)
        .map_or("1".to_string(), |c| c[1].to_string());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(m[1].trim())
        .map_err(|_| SceneDataError::Failed)?;
    let json = if version != "1" {
        to_byte_string(&bytes)
    } else {
        String::from_utf8(bytes).map_err(|_| SceneDataError::Failed)?
    };
    decode_encoded_json(&json)
}
