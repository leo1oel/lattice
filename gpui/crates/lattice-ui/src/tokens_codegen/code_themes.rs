//! Writes `src/tokens/code_themes.rs` from `design-system/code-themes.json`.
//!
//! That JSON is `codeThemeProperties` (`src/settings/code-themes.ts`) as the
//! app computes it, exported by `design-system/code-themes.mjs`, whose
//! `--check` fails while the two disagree. So a code theme changed in the app
//! reaches the Zed editor themes through two regenerations, each guarded:
//!
//! ```sh
//! node design-system/code-themes.mjs
//! LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens
//! ```
//!
//! Like the token generator, this understands exactly the value forms the
//! export writes (`#rrggbb`, `var(--editor-bg)` and a `color-mix()` of a
//! colour over it) and the properties it sets, and panics on any other.

use std::fmt::Write as _;

use serde_json::Value;

pub(super) const CODE_THEMES_JSON: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../design-system/code-themes.json"
);

/// The token roles, in code-themes.ts's order, one `--syntax-*` each.
const ROLES: &[&str] = &[
    "keyword",
    "operator",
    "function",
    "type",
    "variable",
    "variable-special",
    "property",
    "attribute",
    "string",
    "comment",
    "comment-doc",
    "number",
    "constant",
    "bracket",
    "citation",
    "reference",
];

/// The `--code-*` properties, each with the `CodeVariant` field it fills
/// (`--code-ground` fills `ground`, written apart).
const SURFACE: &[(&str, &str)] = &[
    ("--code-ink", "ink"),
    ("--code-line-number", "line_number"),
    ("--code-line-number-contrast", "line_number_contrast"),
    ("--code-caret", "caret"),
    ("--code-line", "line"),
    ("--code-selection-focused", "selection_focused"),
    ("--code-selection", "selection"),
];

const EDITOR_GROUND: &str = "var(--editor-bg)";

const GENERATED: &str = "\
//! Generated from design-system/code-themes.json by
//! src/tokens_codegen/code_themes.rs. Do not edit: change
//! src/settings/code-themes.ts, run `node design-system/code-themes.mjs`, then
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while this file
//! and the JSON disagree.
";

/// The contents of `src/tokens/code_themes.rs`.
pub(super) fn generate(json: &str) -> String {
    let root: Value = serde_json::from_str(json).expect("code-themes.json parses");
    let themes = root["themes"]
        .as_array()
        .expect("code-themes.json has a themes list");
    let mut out = String::from(
        "//! The code themes of Settings › Appearance, Weft & Warp aside (its colours\n\
         //! are the `COLOR_SYNTAX_*` tokens), as the app paints them in a light app\n\
         //! and a dark app: every colour already fitted to its ground.\n//!\n",
    );
    out.push_str(GENERATED);
    out.push_str(
        "\nuse crate::{\n    Appearance,\n    editor_theme::{CodeGround, CodeSyntax, CodeThemeSource, CodeVariant},\n    token_types::{hex, rgba8},\n};\n",
    );
    for theme in themes {
        let id = theme["id"].as_str().expect("a theme id");
        let name = theme["name"].as_str().expect("a theme name");
        let ident = format!("CODE_THEME_{}", id.replace('-', "_").to_ascii_uppercase());
        writeln!(out, "\n/// {name}.").unwrap();
        writeln!(
            out,
            "pub const {ident}: CodeThemeSource = CodeThemeSource {{"
        )
        .unwrap();
        writeln!(out, "    id: {id:?},\n    name: {name:?},").unwrap();
        for app in ["light", "dark"] {
            let variant = &theme["apps"][app];
            assert!(variant.is_object(), "{id} has no {app} app variant");
            write_variant(&mut out, &format!("{id} in a {app} app"), app, variant);
        }
        out.push_str("};\n");
    }
    out
}

fn write_variant(out: &mut String, what: &str, app: &str, variant: &Value) {
    let kind = variant["kind"].as_str().expect("a variant kind");
    let on_window = match variant["ground"].as_str() {
        Some("window") => true,
        Some("own") => false,
        other => panic!("{what}: ground {other:?} is neither window nor own"),
    };
    let properties = variant["properties"]
        .as_object()
        .unwrap_or_else(|| panic!("{what} has no properties"));
    // With every known property looked up below, an equal count means no
    // other is set.
    let expected = ROLES.len() + SURFACE.len() + 1;
    assert_eq!(
        properties.len(),
        expected,
        "{what} sets other properties than tokens_codegen knows: {:?}",
        properties.keys().collect::<Vec<_>>()
    );
    let property = |name: &str| -> &str {
        properties
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{what} has no {name}"))
    };

    writeln!(out, "    {app}_app: CodeVariant {{").unwrap();
    writeln!(out, "        kind: {},", appearance(kind)).unwrap();
    let ground = property("--code-ground");
    if on_window {
        assert_eq!(ground, EDITOR_GROUND, "{what} stands on the window");
        out.push_str("        ground: CodeGround::Window,\n");
    } else {
        writeln!(
            out,
            "        ground: CodeGround::Own({}),",
            color(ground, false, what)
        )
        .unwrap();
    }
    for (name, field) in SURFACE {
        writeln!(
            out,
            "        {field}: {},",
            color(property(name), on_window, what)
        )
        .unwrap();
    }
    out.push_str("        syntax: CodeSyntax {\n");
    for role in ROLES {
        writeln!(
            out,
            "            {}: {},",
            field(role),
            color(property(&format!("--syntax-{role}")), false, what)
        )
        .unwrap();
    }
    out.push_str("        },\n    },\n");
}

fn appearance(kind: &str) -> &'static str {
    match kind {
        "light" => "Appearance::Light",
        "dark" => "Appearance::Dark",
        _ => panic!("{kind:?} is neither light nor dark"),
    }
}

/// `variable-special` → `variable_special`; `type` → `type_`.
fn field(role: &str) -> String {
    match role {
        "type" => "type_".into(),
        _ => role.replace('-', "_"),
    }
}

/// `#rrggbb` → `hex(0xRRGGBB)`; on the window, `color-mix(in srgb, #rrggbb 5%,
/// var(--editor-bg))` → `rgba8(r, g, b, 0.05)`, the colour at that alpha, which
/// Zed lays over the editor's background as CSS mixes it into `--editor-bg`.
fn color(value: &str, on_window: bool, what: &str) -> String {
    let Some(body) = value
        .strip_prefix("color-mix(in srgb, ")
        .and_then(|rest| rest.strip_suffix(&format!(", {EDITOR_GROUND})")))
    else {
        return super::color(value);
    };
    assert!(
        on_window,
        "{what}: {value:?} mixes over the window's ground, but the variant has its own"
    );
    let (hex, alpha) = body
        .split_once(' ')
        .unwrap_or_else(|| panic!("{what}: {value:?} is a colour and a percentage"));
    let digits = hex
        .strip_prefix('#')
        .filter(|digits| digits.len() == 6)
        .unwrap_or_else(|| panic!("{what}: {value:?} mixes a #rrggbb colour"));
    let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).expect("hex digits");
    format!(
        "rgba8({}, {}, {}, {})",
        channel(0),
        channel(2),
        channel(4),
        super::percent(alpha)
    )
}

#[test]
fn a_mix_over_the_editor_ground_is_the_colour_at_its_alpha() {
    assert_eq!(
        color(
            "color-mix(in srgb, #0969da 20%, var(--editor-bg))",
            true,
            "test"
        ),
        "rgba8(9, 105, 218, 0.2)"
    );
    assert_eq!(color("#44475a", false, "test"), "hex(0x44475A)");
}
