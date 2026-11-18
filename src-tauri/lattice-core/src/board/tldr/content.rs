//! What tldraw stores in encoded form: rich text (TipTap documents), the
//! compressed points of draw and highlight strokes, and image sources.

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use serde_json::Value;

/// A shape's text as plain text: tldraw's rich text flattened with one line
/// per paragraph, list items marked, and marks (bold, links, …) dropped; or
/// the plain `text` prop older boards hold.
pub(super) fn plain_text(props: &Value) -> String {
    if let Some(rich) = props.get("richText").filter(|value| value.is_object()) {
        return block_lines(rich, "").join("\n").trim_end().to_string();
    }
    props.get("text").and_then(Value::as_str).unwrap_or_default().trim_end().to_string()
}

fn children(node: &Value) -> &[Value] {
    node.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
}

/// The lines a block node renders as, each list level indented by `indent`.
fn block_lines(node: &Value, indent: &str) -> Vec<String> {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "doc" | "blockquote" | "listItem" | "taskItem" => {
            children(node).iter().flat_map(|child| block_lines(child, indent)).collect()
        }
        "bulletList" | "orderedList" | "taskList" => {
            let start = node.pointer("/attrs/start").and_then(Value::as_u64).unwrap_or(1);
            let nested = format!("{indent}  ");
            let mut lines = Vec::new();
            for (number, item) in children(node).iter().enumerate() {
                let marker = match kind {
                    "orderedList" => format!("{}. ", start + number as u64),
                    "taskList" if item.pointer("/attrs/checked") == Some(&Value::Bool(true)) => {
                        "☑ ".to_string()
                    }
                    "taskList" => "☐ ".to_string(),
                    _ => "• ".to_string(),
                };
                for (line_number, line) in block_lines(item, &nested).into_iter().enumerate() {
                    lines.push(if line_number == 0 {
                        format!("{indent}{marker}{}", line.trim_start())
                    } else {
                        line
                    });
                }
            }
            lines
        }
        _ => inline_text(node).split('\n').map(|line| format!("{indent}{line}")).collect(),
    }
}

fn inline_text(node: &Value) -> String {
    match node.get("type").and_then(Value::as_str) {
        Some("text") => node.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
        Some("hardBreak") => "\n".to_string(),
        _ => children(node).iter().map(inline_text).collect(),
    }
}

/// A draw or highlight segment's points in shape space: the delta-encoded
/// base64 `path` tldraw 4.2+ writes (2D or 3D), or the `points` array or
/// absolute Float16 string of older boards. Each point is (x, y, pressure).
pub(super) fn segment_points(segment: &Value) -> Vec<[f64; 3]> {
    if let Some(path) = segment.get("path").and_then(Value::as_str) {
        let three_d = segment.get("dim").and_then(Value::as_u64) != Some(2);
        return decode_path(path, three_d);
    }
    match segment.get("points") {
        Some(Value::Array(points)) => points
            .iter()
            .map(|point| {
                let axis = |key| point.get(key).and_then(Value::as_f64).unwrap_or(0.);
                [axis("x"), axis("y"), point.get("z").and_then(Value::as_f64).unwrap_or(0.5)]
            })
            .collect(),
        Some(Value::String(encoded)) => decode_bytes(encoded)
            .as_chunks::<6>()
            .0
            .iter()
            .map(|chunk| [f16(&chunk[0..2]), f16(&chunk[2..4]), f16(&chunk[4..6])])
            .collect(),
        _ => Vec::new(),
    }
}

/// tldraw's `b64Vecs.decodePoints`: the first point as Float32s, each later
/// one as Float16 deltas from the one before.
fn decode_path(path: &str, three_d: bool) -> Vec<[f64; 3]> {
    let bytes = decode_bytes(path);
    let dims = if three_d { 3 } else { 2 };
    if bytes.len() < dims * 4 {
        return Vec::new();
    }
    let f32_at = |offset: usize| {
        f64::from(f32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("four bytes")))
    };
    let mut point = [f32_at(0), f32_at(4), if three_d { f32_at(8) } else { 0.5 }];
    let mut points = vec![point];
    for delta in bytes[dims * 4..].chunks_exact(dims * 2) {
        point[0] += f16(&delta[0..2]);
        point[1] += f16(&delta[2..4]);
        if three_d {
            point[2] += f16(&delta[4..6]);
        }
        points.push(point);
    }
    points
}

fn decode_bytes(encoded: &str) -> Vec<u8> {
    STANDARD
        .decode(encoded)
        .or_else(|_| STANDARD_NO_PAD.decode(encoded.trim_end_matches('=')))
        .unwrap_or_default()
}

/// A little-endian IEEE half-precision float.
fn f16(bytes: &[u8]) -> f64 {
    let bits = u16::from_le_bytes([bytes[0], bytes[1]]);
    let sign = if bits >> 15 == 1 { -1. } else { 1. };
    let exponent = i32::from((bits >> 10) & 0x1f);
    let fraction = f64::from(bits & 0x3ff);
    match exponent {
        0 => sign * fraction * 2f64.powi(-24),
        31 => 0.,
        _ => sign * (1. + fraction / 1024.) * 2f64.powi(exponent - 15),
    }
}

/// An image source as a data URL Excalidraw can embed: kept when it already
/// is one, else read through `read_asset` (a project-relative path). Remote
/// URLs are never fetched; a board stays local.
pub(super) fn image_data_url(
    src: &str, read_asset: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Option<(String, String)> {
    if let Some(rest) = src.strip_prefix("data:") {
        let mime = rest.split([';', ',']).next().unwrap_or_default();
        return mime.starts_with("image/").then(|| (mime.to_string(), src.to_string()));
    }
    if src.is_empty() || src.contains("://") || src.starts_with('/') || src.starts_with("asset:") {
        return None;
    }
    let path = src.strip_prefix("./").unwrap_or(src);
    let bytes = read_asset(path)?;
    let mime = image_mime(&bytes)?;
    Some((mime.to_string(), format!("data:{mime};base64,{}", STANDARD.encode(&bytes))))
}

/// The image type of `bytes` by their signature; `None` for anything else.
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    let text_start =
        String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).trim_start().to_string();
    Some(match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xff, 0xd8, 0xff, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ if text_start.starts_with("<svg") || text_start.starts_with("<?xml") => "image/svg+xml",
        _ => return None,
    })
}
