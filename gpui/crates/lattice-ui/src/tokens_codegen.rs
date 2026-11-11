//! Writes `src/tokens/` from `design-system/tokens.json`, and fails the
//! crate's tests while the two disagree.
//!
//! The JSON is exported from Paper by `design-system/export.mjs` and is the
//! same file the Tauri app's drift test (`src/styles/design-system-drift.test.ts`)
//! holds its CSS to, so a token changed in Paper reaches both apps through one
//! export. To regenerate after an export:
//!
//! ```sh
//! LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens
//! ```
//!
//! The generator understands exactly the value forms the export writes today
//! and panics on any other, so a new form shows up as a failing test here
//! rather than as a token silently dropped.

use std::fmt::Write as _;

use serde_json::{Map, Value};

const TOKENS_JSON: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../design-system/tokens.json"
);
const TOKENS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/tokens");

/// Section headings, in the order the export writes the types.
const SECTIONS: &[(&str, &str)] = &[
    ("color", "Colour"),
    ("fontFamily", "Font families"),
    ("fontSize", "Font sizes"),
    ("fontWeight", "Font weights"),
    ("letterSpacing", "Letter spacing"),
    ("lineHeight", "Line heights"),
    ("opacity", "Opacity"),
    ("breakpoint", "Breakpoints"),
    ("container", "Containers"),
    ("spacing", "Spacing and sizes"),
    ("radius", "Radius"),
    ("duration", "Durations"),
    ("easing", "Easing"),
    ("transition", "Motion: duration and curve together"),
    ("shadow", "Shadows"),
];

/// One generated module: its file, what it holds, and which tokens go in it.
struct Module {
    name: &'static str,
    about: &'static str,
    holds: fn(name: &str, kind: &str) -> bool,
}

const ACCENT_PRESETS: &[&str] = &["blue", "purple", "pink", "orange", "green", "teal"];

/// The modules, by concept, as DESIGN.md groups the tokens. Each token lands
/// in the first module that holds it.
const MODULES: &[Module] = &[
    Module {
        name: "presets",
        about: "The tints and accent presets of Settings › Appearance.",
        holds: |name, kind| {
            kind == "color"
                && (name.starts_with("--color-tint-")
                    || ACCENT_PRESETS
                        .iter()
                        .any(|preset| name == format!("--color-accent-{preset}")))
        },
    },
    Module {
        name: "glyphs",
        about: "File glyph hues, one per kind of file.",
        holds: |name, kind| kind == "color" && name.starts_with("--color-glyph-"),
    },
    Module {
        name: "syntax",
        about: "The code themes' syntax colours: Weft & Warp and GitHub.",
        holds: |name, kind| kind == "color" && name.starts_with("--color-syntax-"),
    },
    Module {
        name: "color",
        about: "Surfaces, inks, lines, the accent, states and statuses, and the opacity steps they are mixed at.",
        holds: |_, kind| kind == "color" || kind == "opacity",
    },
    Module {
        name: "typography",
        about: "Font stacks and the type roles' sizes, weights, tracking and leading.",
        holds: |_, kind| {
            matches!(
                kind,
                "fontFamily" | "fontSize" | "fontWeight" | "letterSpacing" | "lineHeight"
            )
        },
    },
    Module {
        name: "space",
        about: "Spacing, control and row sizes, containers, breakpoints and radii.",
        holds: |_, kind| matches!(kind, "spacing" | "container" | "breakpoint" | "radius"),
    },
    Module {
        name: "motion",
        about: "Durations, spring curves and the motion tiers that pair them.",
        holds: |_, kind| matches!(kind, "duration" | "easing" | "transition"),
    },
    Module {
        name: "shadow",
        about: "The elevation ladder's shadow stacks, light and dark.",
        holds: |_, kind| kind == "shadow",
    },
];

/// Every generated file, `mod.rs` first, as `(file name, contents)`.
pub(crate) fn generate(json: &str) -> Vec<(String, String)> {
    let root: Value = serde_json::from_str(json).expect("tokens.json parses");
    let tokens = root["tokens"]
        .as_object()
        .expect("tokens.json has a tokens map");
    let module_of = |name: &str, token: &Value| {
        let kind = token["type"].as_str().unwrap_or_default();
        assert!(
            SECTIONS.iter().any(|(section, _)| *section == kind),
            "{name} has type {kind:?}, which tokens_codegen does not know; teach it the type"
        );
        MODULES
            .iter()
            .position(|module| (module.holds)(name, kind))
            .unwrap_or_else(|| panic!("{name} ({kind}) belongs to no module"))
    };

    let mut files = vec![("mod.rs".to_string(), mod_rs())];
    for (ix, module) in MODULES.iter().enumerate() {
        let mut body = String::new();
        for (kind, heading) in SECTIONS {
            let section: Vec<_> = tokens
                .iter()
                .filter(|(name, token)| {
                    token["type"].as_str() == Some(kind) && module_of(name, token) == ix
                })
                .collect();
            if section.is_empty() {
                continue;
            }
            writeln!(body, "\n// {heading}\n").unwrap();
            for (name, token) in section {
                write_doc(&mut body, token);
                writeln!(body, "{}", constant(name, kind, token.as_object().unwrap())).unwrap();
            }
        }
        let mut file = format!("//! {}\n//!\n{GENERATED}", module.about);
        file.push_str(&imports(&body));
        file.push_str(&body);
        files.push((format!("{}.rs", module.name), file));
    }
    files
}

const GENERATED: &str = "\
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.
";

fn mod_rs() -> String {
    let mut out = String::from(
        "//! Every design token, one constant per `--name` in design-system/tokens.json\n\
         //! (`--color-window` is `COLOR_WINDOW`), split by concept.\n\
         //!\n\
         //! Sizes are rems of a 16px root, so the interface size setting scales them\n\
         //! through `Window::set_rem_size`.\n//!\n",
    );
    out.push_str(GENERATED);
    out.push('\n');
    for module in MODULES {
        writeln!(out, "mod {};", module.name).unwrap();
    }
    out.push('\n');
    for module in MODULES {
        writeln!(out, "pub use {}::*;", module.name).unwrap();
    }
    out
}

/// The `use` lines a generated body needs, and no others.
fn imports(body: &str) -> String {
    let uses = |pattern: &str| body.contains(pattern);
    let mut out = String::from("\n");
    if uses("Duration::") {
        out.push_str("use std::time::Duration;\n\n");
    }
    let gpui: Vec<&str> = [("FontWeight", "FontWeight("), ("Rems", "Rems(")]
        .into_iter()
        .filter(|(_, pattern)| uses(pattern))
        .map(|(name, _)| name)
        .collect();
    match gpui.as_slice() {
        [] => {}
        [one] => writeln!(out, "use gpui::{one};\n").unwrap(),
        many => writeln!(out, "use gpui::{{{}}};\n", many.join(", ")).unwrap(),
    }
    let types: Vec<&str> = [
        ("ColorToken", ": ColorToken"),
        ("Ease", "Ease::"),
        ("FontStack", ": FontStack"),
        ("MotionToken", ": MotionToken"),
        ("ShadowToken", ": ShadowToken"),
        ("hex", "hex("),
        ("layer", "layer("),
        ("rgba8", "rgba8("),
    ]
    .into_iter()
    .filter(|(_, pattern)| uses(pattern))
    .map(|(name, _)| name)
    .collect();
    match types.as_slice() {
        [] => {}
        [one] => writeln!(out, "use crate::token_types::{one};").unwrap(),
        many => writeln!(out, "use crate::token_types::{{{}}};", many.join(", ")).unwrap(),
    }
    out
}

fn constant(name: &str, kind: &str, token: &Map<String, Value>) -> String {
    let ident = ident(name);
    match kind {
        "color" => color_token(&ident, token),
        "fontFamily" => format!(
            "pub const {ident}: FontStack = FontStack(&[{}]);",
            font_stack(value(token))
        ),
        "fontSize" | "lineHeight" | "breakpoint" | "container" | "spacing" => {
            format!("pub const {ident}: Rems = {};", rems(value(token)))
        }
        "radius" => match var_reference(value(token)) {
            Some(target) => format!("pub const {ident}: Rems = {target};"),
            None => format!("pub const {ident}: Rems = {};", rems(value(token))),
        },
        "fontWeight" => format!(
            "pub const {ident}: FontWeight = FontWeight({});",
            float(value(token))
        ),
        "letterSpacing" => {
            let em = value(token)
                .strip_suffix("em")
                .unwrap_or_else(|| panic!("{name}: letter spacing in em"));
            format!("/// In em.\npub const {ident}: f32 = {};", float(em))
        }
        "opacity" => format!("pub const {ident}: f32 = {};", percent(value(token))),
        "duration" => {
            let ms = value(token)
                .strip_suffix("ms")
                .unwrap_or_else(|| panic!("{name}: duration in ms"));
            let ms: u64 = ms.parse().unwrap_or_else(|_| panic!("{name}: whole ms"));
            format!("pub const {ident}: Duration = Duration::from_millis({ms});")
        }
        "easing" => format!("pub const {ident}: Ease = {};", ease(value(token))),
        "transition" => {
            let (duration, ease) = transition(value(token));
            format!("pub const {ident}: MotionToken = MotionToken::new({duration}, {ease});")
        }
        "shadow" => {
            let light = shadow(value(token));
            let dark = token
                .get("dark")
                .and_then(Value::as_str)
                .map(shadow)
                .unwrap_or_else(|| light.clone());
            format!(
                "pub const {ident}: ShadowToken = ShadowToken {{\n    light: &[\n{light}    ],\n    dark: &[\n{dark}    ],\n}};"
            )
        }
        _ => unreachable!(),
    }
}

fn value(token: &Map<String, Value>) -> &str {
    token["value"].as_str().expect("a token value is a string")
}

fn write_doc(out: &mut String, token: &Value) {
    let description = token["description"].as_str().unwrap_or_default().trim();
    let app = token["app"].as_str().unwrap_or_default();
    if !description.is_empty() {
        for line in description.lines() {
            writeln!(out, "/// {}", line.trim_end()).unwrap();
        }
    }
    if !app.is_empty() {
        if !description.is_empty() {
            out.push_str("///\n");
        }
        writeln!(out, "/// App: `{app}`.").unwrap();
    }
}

/// `--color-tint-paper-window` → `COLOR_TINT_PAPER_WINDOW`.
fn ident(name: &str) -> String {
    name.trim_start_matches("--")
        .replace('-', "_")
        .to_ascii_uppercase()
}

fn var_reference(value: &str) -> Option<String> {
    value
        .strip_prefix("var(")
        .and_then(|rest| rest.strip_suffix(')'))
        .map(ident)
}

/// A float literal Rust accepts as `f32`: `1` → `1.0`.
fn float(number: &str) -> String {
    let number = number.trim();
    number
        .parse::<f64>()
        .unwrap_or_else(|_| panic!("{number:?} is not a number"));
    if number.contains('.') {
        number.to_string()
    } else {
        format!("{number}.0")
    }
}

/// `9%` → `0.09`, through the decimal string so `4.3%` stays `0.043`.
fn percent(value: &str) -> String {
    let number = value
        .trim()
        .strip_suffix('%')
        .unwrap_or_else(|| panic!("{value:?} is not a percentage"));
    let fraction: f64 = number.parse::<f64>().expect("a percentage") / 100.;
    let text = format!("{fraction:.6}");
    let text = text.trim_end_matches('0');
    float(text.strip_suffix('.').unwrap_or(text))
}

/// `28px` → `Rems(1.75)`.
fn rems(value: &str) -> String {
    let px: f64 = value
        .trim()
        .strip_suffix("px")
        .unwrap_or_else(|| panic!("{value:?} is not in px"))
        .parse()
        .expect("a pixel size");
    let rems = px / 16.;
    // Every token is a multiple of 1/16 px or a decimal px; both print
    // exactly at six places.
    let text = format!("{rems:.6}");
    let text = text.trim_end_matches('0');
    format!("Rems({})", float(text.strip_suffix('.').unwrap_or(text)))
}

fn color_token(ident: &str, token: &Map<String, Value>) -> String {
    let light = color(value(token));
    match token.get("dark").and_then(Value::as_str) {
        Some(dark) => format!(
            "pub const {ident}: ColorToken = ColorToken::new({light}, {});",
            color(dark)
        ),
        None => format!("pub const {ident}: ColorToken = ColorToken::same({light});"),
    }
}

/// `#F7F7F6` → `hex(0xF7F7F6)`; `rgb(28 28 31 / 9%)` → `rgba8(28, 28, 31, 0.09)`.
fn color(value: &str) -> String {
    let value = value.trim();
    if let Some(digits) = value.strip_prefix('#') {
        assert!(
            digits.len() == 6 && digits.chars().all(|c| c.is_ascii_hexdigit()),
            "{value:?}: only #RRGGBB colours are expected"
        );
        return format!("hex(0x{})", digits.to_ascii_uppercase());
    }
    if let Some(body) = value
        .strip_prefix("rgb(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let (channels, alpha) = body
            .split_once('/')
            .unwrap_or_else(|| panic!("{value:?}: rgb() with an alpha is expected"));
        let channels: Vec<u8> = channels
            .split_whitespace()
            .map(|c| {
                c.parse()
                    .unwrap_or_else(|_| panic!("{value:?}: 0-255 channels"))
            })
            .collect();
        assert_eq!(channels.len(), 3, "{value:?}: three channels");
        return format!(
            "rgba8({}, {}, {}, {})",
            channels[0],
            channels[1],
            channels[2],
            percent(alpha.trim())
        );
    }
    panic!("{value:?}: an unknown colour form; teach tokens_codegen")
}

/// `"Inter Variable", Inter, sans-serif` → `"Inter Variable", "Inter", "sans-serif"`.
fn font_stack(value: &str) -> String {
    value
        .split(',')
        .map(|family| format!("{:?}", family.trim().trim_matches('"')))
        .collect::<Vec<_>>()
        .join(", ")
}

fn ease(value: &str) -> String {
    let value = value.trim();
    if value == "ease-out" {
        return "Ease::EaseOut".into();
    }
    if let Some(stops) = value
        .strip_prefix("linear(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let stops: Vec<String> = stops.split(',').map(float).collect();
        return format!("Ease::Linear(&[{}])", stops.join(", "));
    }
    if let Some(points) = value
        .strip_prefix("cubic-bezier(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let points: Vec<String> = points.split(',').map(float).collect();
        assert_eq!(points.len(), 4, "{value:?}: four control values");
        return format!("Ease::CubicBezier({})", points.join(", "));
    }
    panic!("{value:?}: an unknown easing form; teach tokens_codegen")
}

/// `var(--duration-fast) var(--ease-fast)` → `(DURATION_FAST, EASE_FAST)`.
fn transition(value: &str) -> (String, String) {
    let parts: Vec<String> = value
        .split_whitespace()
        .map(|part| {
            var_reference(part).unwrap_or_else(|| panic!("{value:?}: a var() pair is expected"))
        })
        .collect();
    assert_eq!(parts.len(), 2, "{value:?}: duration then curve");
    (parts[0].clone(), parts[1].clone())
}

/// A CSS shadow list, one `layer(...)` line per layer.
fn shadow(value: &str) -> String {
    let mut out = String::new();
    for layer in value.split("),") {
        let layer = layer.trim();
        let (lengths, color) = layer
            .split_once("rgba(")
            .unwrap_or_else(|| panic!("{value:?}: each layer ends in rgba()"));
        let mut lengths: Vec<String> = lengths
            .split_whitespace()
            .map(|length| float(length.trim_end_matches("px")))
            .collect();
        assert!(
            (3..=4).contains(&lengths.len()),
            "{value:?}: x, y, blur and an optional spread"
        );
        if lengths.len() == 3 {
            lengths.push("0.0".into());
        }
        let channels: Vec<&str> = color
            .trim_end_matches(')')
            .split(',')
            .map(str::trim)
            .collect();
        assert_eq!(channels.len(), 4, "{value:?}: rgba(r, g, b, a)");
        writeln!(
            out,
            "        layer({}, {}, {}, {}, rgba8({}, {}, {}, {})),",
            lengths[0],
            lengths[1],
            lengths[2],
            lengths[3],
            channels[0],
            channels[1],
            channels[2],
            float(channels[3])
        )
        .unwrap();
    }
    out
}

#[test]
fn generated_tokens_match_the_design_system() {
    let json = std::fs::read_to_string(TOKENS_JSON)
        .unwrap_or_else(|error| panic!("reading {TOKENS_JSON}: {error}"));
    let expected = generate(&json);
    let dir = std::path::Path::new(TOKENS_DIR);
    if std::env::var_os("LATTICE_UI_WRITE_TOKENS").is_some() {
        std::fs::create_dir_all(dir).expect("creating src/tokens");
        for entry in std::fs::read_dir(dir).expect("src/tokens").flatten() {
            std::fs::remove_file(entry.path()).expect("clearing src/tokens");
        }
        for (file, contents) in &expected {
            std::fs::write(dir.join(file), contents).expect("writing src/tokens");
        }
        return;
    }
    const REGENERATE: &str =
        "Regenerate with `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.";
    let mut on_disk: Vec<String> = std::fs::read_dir(dir)
        .expect("reading src/tokens")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    on_disk.sort();
    let mut wanted: Vec<String> = expected.iter().map(|(file, _)| file.clone()).collect();
    wanted.sort();
    assert_eq!(
        on_disk, wanted,
        "src/tokens holds other files than the generator writes. {REGENERATE}"
    );
    for (file, contents) in &expected {
        // Line endings may be rewritten by a Windows checkout.
        let actual = std::fs::read_to_string(dir.join(file))
            .expect("reading a token file")
            .replace("\r\n", "\n");
        if &actual != contents {
            let first = actual
                .lines()
                .zip(contents.lines())
                .position(|(a, b)| a != b)
                .unwrap_or(actual.lines().count().min(contents.lines().count()));
            panic!(
                "src/tokens/{file} disagrees with design-system/tokens.json from line {}: \
                 {:?} should be {:?}. {REGENERATE}",
                first + 1,
                actual.lines().nth(first).unwrap_or_default(),
                contents.lines().nth(first).unwrap_or_default()
            );
        }
    }
}

#[test]
fn every_token_in_the_json_has_a_constant() {
    let json = std::fs::read_to_string(TOKENS_JSON).expect("tokens.json");
    let root: Value = serde_json::from_str(&json).unwrap();
    let generated: String = generate(&json).into_iter().map(|(_, text)| text).collect();
    for name in root["tokens"].as_object().unwrap().keys() {
        assert!(
            generated.contains(&format!("pub const {}:", ident(name))),
            "{name} has no constant"
        );
    }
}

#[test]
fn percentages_keep_their_decimals() {
    assert_eq!(percent("9%"), "0.09");
    assert_eq!(percent("4.3%"), "0.043");
    assert_eq!(percent("81.6%"), "0.816");
    assert_eq!(percent("100%"), "1.0");
    assert_eq!(rems("2px"), "Rems(0.125)");
    assert_eq!(rems("999px"), "Rems(62.4375)");
    assert_eq!(rems("16px"), "Rems(1.0)");
}
