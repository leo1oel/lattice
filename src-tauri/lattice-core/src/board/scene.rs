//! The `.excalidraw` scene Lattice stores boards in: the JSON
//! `@excalidraw/excalidraw` 0.18 reads and writes (`serializeAsJSON`), typed
//! so every shell writes the same keys in the same order. Only what Lattice
//! writes itself is modelled here; the editors read their own files.

use serde::Serialize;
use std::collections::BTreeMap;

/// The scene a new board starts from. `appState` holds only what Excalidraw
/// keeps in a saved file; view state (scroll, zoom) is per user and never
/// stored in it.
pub const EMPTY_SCENE: &str = r##"{
  "type": "excalidraw",
  "version": 2,
  "source": "lattice",
  "elements": [],
  "appState": {
    "gridSize": 20,
    "gridStep": 5,
    "gridModeEnabled": false,
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}"##;

pub fn empty_scene() -> String {
    EMPTY_SCENE.to_string()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub version: u32,
    pub source: &'static str,
    pub elements: Vec<Element>,
    pub app_state: SavedAppState,
    pub files: BTreeMap<String, BinaryFile>,
}

impl Default for Scene {
    fn default() -> Self {
        Scene {
            kind: "excalidraw",
            version: 2,
            source: "lattice",
            elements: Vec::new(),
            app_state: SavedAppState::default(),
            files: BTreeMap::new(),
        }
    }
}

impl Scene {
    /// Two-space indented, as `serializeAsJSON` writes it.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("a scene always serializes")
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAppState {
    pub grid_size: u32,
    pub grid_step: u32,
    pub grid_mode_enabled: bool,
    pub view_background_color: &'static str,
}

impl Default for SavedAppState {
    fn default() -> Self {
        SavedAppState {
            grid_size: 20,
            grid_step: 5,
            grid_mode_enabled: false,
            view_background_color: "#ffffff",
        }
    }
}

/// An image's bytes, inlined as a data URL under its `fileId`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryFile {
    pub mime_type: String,
    pub id: String,
    #[serde(rename = "dataURL")]
    pub data_url: String,
    pub created: u64,
    pub last_retrieved: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    #[serde(rename = "type")]
    pub kind_name: &'static str,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub angle: f64,
    pub stroke_color: String,
    pub background_color: String,
    pub fill_style: &'static str,
    pub stroke_width: f64,
    pub stroke_style: &'static str,
    pub roughness: f64,
    pub opacity: f64,
    pub group_ids: Vec<String>,
    pub frame_id: Option<String>,
    pub index: String,
    pub roundness: Option<Roundness>,
    pub seed: u32,
    pub version: u32,
    pub version_nonce: u32,
    pub is_deleted: bool,
    pub bound_elements: Option<Vec<BoundElement>>,
    pub updated: u64,
    pub link: Option<String>,
    pub locked: bool,
    #[serde(flatten)]
    pub kind: Kind,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Roundness {
    #[serde(rename = "type")]
    pub kind: u8,
}

/// `ROUNDNESS.PROPORTIONAL_RADIUS`: lines, arrows and diamonds.
pub const PROPORTIONAL_RADIUS: Roundness = Roundness { kind: 2 };

#[derive(Clone, Debug, Serialize)]
pub struct BoundElement {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointBinding {
    pub element_id: String,
    pub focus: f64,
    pub gap: f64,
}

/// What each element type adds to the shared fields.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum Kind {
    Shape {},
    Frame {
        name: Option<String>,
    },
    Text {
        text: String,
        font_size: f64,
        font_family: u32,
        text_align: &'static str,
        vertical_align: &'static str,
        container_id: Option<String>,
        original_text: String,
        auto_resize: bool,
        line_height: f64,
    },
    Linear {
        points: Vec<[f64; 2]>,
        last_committed_point: Option<[f64; 2]>,
        start_binding: Option<PointBinding>,
        end_binding: Option<PointBinding>,
        start_arrowhead: Option<&'static str>,
        end_arrowhead: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        elbowed: Option<bool>,
    },
    FreeDraw {
        points: Vec<[f64; 2]>,
        pressures: Vec<f64>,
        simulate_pressure: bool,
        last_committed_point: Option<[f64; 2]>,
    },
    Image {
        file_id: String,
        status: &'static str,
        scale: [f64; 2],
        crop: Option<ImageCrop>,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub natural_width: f64,
    pub natural_height: f64,
}

/// Excalidraw's `FONT_FAMILY` numbers Lattice writes.
pub mod font_family {
    pub const CASCADIA: u32 = 3;
    pub const EXCALIFONT: u32 = 5;
    /// Excalidraw's "Normal" font and Lattice's default, so boards match the app.
    pub const NUNITO: u32 = 6;
}

/// `getLineHeight`: the unitless line height Excalidraw lays text out with.
pub fn line_height(family: u32) -> f64 {
    match family {
        font_family::CASCADIA => 1.2,
        2 | 7 | 9 => 1.15,
        _ => 1.25,
    }
}

/// `BOUND_TEXT_PADDING`.
pub const BOUND_TEXT_PADDING: f64 = 5.;

/// An estimate of a line's advance width. Excalidraw measures text with its
/// real fonts once they load; this only has to place converted text close to
/// where it lands and wrap labels inside their containers.
pub fn line_width(line: &str, font_size: f64, family: u32) -> f64 {
    let monospace = family == font_family::CASCADIA;
    line.chars()
        .map(|ch| {
            let em = if is_wide(ch) {
                1.0
            } else if monospace {
                0.6
            } else if ch == ' ' {
                0.28
            } else if "il.,:;'|!jIft()[]".contains(ch) {
                0.3
            } else if "mwMW".contains(ch) {
                0.85
            } else if ch.is_uppercase() {
                0.66
            } else {
                0.55
            };
            em * font_size
        })
        .sum()
}

/// CJK and other full-width characters, which a line may break between.
fn is_wide(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF | 0xA000..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6 | 0x1F300..=0x1FAFF
        | 0x20000..=0x3FFFD)
}

/// Width and height of `text` laid out without wrapping.
pub fn measure(text: &str, font_size: f64, family: u32) -> (f64, f64) {
    let lines: Vec<&str> = text.split('\n').collect();
    let width = lines.iter().map(|line| line_width(line, font_size, family)).fold(0., f64::max);
    (width, lines.len() as f64 * font_size * line_height(family))
}

/// `wrapText`, approximately: break lines at spaces, or anywhere next to a
/// wide character, so no line is wider than `max_width` unless one word is.
pub fn wrap(text: &str, font_size: f64, family: u32, max_width: f64) -> String {
    let mut out: Vec<String> = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        for word in split_words(paragraph) {
            let candidate = format!("{line}{word}");
            if line.is_empty() || line_width(candidate.trim_end(), font_size, family) <= max_width {
                line = candidate;
                continue;
            }
            out.push(line.trim_end().to_string());
            line = word.trim_start().to_string();
        }
        out.push(line.trim_end().to_string());
    }
    out.join("\n")
}

/// Words with their trailing space, each wide character a word of its own.
fn split_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    for ch in text.chars() {
        if is_wide(ch) {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            words.push(ch.to_string());
            continue;
        }
        word.push(ch);
        if ch == ' ' {
            words.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// A stable 31-bit, non-zero number from a string (FNV-1a), for the seeds and
/// nonces Excalidraw would otherwise draw at random.
pub fn stable_seed(key: &str) -> u32 {
    let hash = key
        .bytes()
        .fold(0x811c_9dc5_u32, |hash, byte| (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193));
    (hash & 0x7fff_ffff).max(1)
}

/// The `n`th of a run of ascending fractional indices (`a0`, `a1`, … `az`,
/// `b00`, …): the integer keys of the `fractional-indexing` scheme Excalidraw
/// orders elements by.
pub fn fractional_index(n: usize) -> String {
    const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rest = n;
    let mut width = 1u32;
    while rest >= 62usize.pow(width) {
        rest -= 62usize.pow(width);
        width += 1;
    }
    let head = char::from(b'a' + width as u8 - 1);
    let mut digits = vec![b'0'; width as usize];
    for slot in digits.iter_mut().rev() {
        *slot = DIGITS[rest % 62];
        rest /= 62;
    }
    format!("{head}{}", String::from_utf8(digits).expect("ASCII digits"))
}

/// A coordinate rounded to hundredths, so converted files stay readable and
/// never hold `-0.0`.
pub fn round(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.;
    }
    (value * 100.).round() / 100. + 0.
}
