//! The JSON Schema for theme files (`design-system/themes/theme-1.schema.json`),
//! generated from the role tables so an editor can complete and check a
//! theme. `cargo test -p lattice-theme schema` fails while the committed file
//! is out of date; `LATTICE_UPDATE_THEME_SCHEMA=1` rewrites it.

use serde_json::{json, Map, Value};

use crate::roles::{ACCENT, COLOR_ROLES, SYNTAX_ROLES, TERMINAL_ROLES};

fn color_map(keys: impl Iterator<Item = &'static str>, opaque: bool) -> Value {
    let pattern = if opaque { "^#[0-9a-fA-F]{6}$" } else { "^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$" };
    let properties: Map<String, Value> = keys
        .map(|key| (key.to_string(), json!({ "type": "string", "pattern": pattern })))
        .collect();
    json!({ "type": "object", "additionalProperties": false, "properties": properties })
}

/// The schema for schema 1.
pub fn schema() -> Value {
    let colors = color_map(COLOR_ROLES.iter().map(|role| role.key).chain([ACCENT]), false);
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://lattice-writer.github.io/lattice-plugins/schema/theme-1.json",
        "title": "Lattice theme",
        "type": "object",
        "required": ["schema", "id", "name", "version", "variants"],
        "properties": {
            "$schema": { "type": "string" },
            "schema": { "const": 1 },
            "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$", "maxLength": 128 },
            "name": { "type": "string", "minLength": 1, "maxLength": 64 },
            "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+([-+].*)?$" },
            "author": { "type": "string" },
            "license": { "type": "string", "description": "SPDX identifier" },
            "description": { "type": "string" },
            "variants": {
                "type": "array",
                "minItems": 1,
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "required": ["id", "appearance"],
                    "properties": {
                        "id": { "type": "string", "minLength": 1 },
                        "name": { "type": "string" },
                        "appearance": { "enum": ["light", "dark"] },
                        "colors": colors,
                        "syntax": color_map(SYNTAX_ROLES.iter().copied(), true),
                        "terminal": color_map(TERMINAL_ROLES.iter().copied(), false)
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    const PATH: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../design-system/themes/theme-1.schema.json");

    #[test]
    fn schema_file_is_current() {
        let generated = serde_json::to_string_pretty(&super::schema()).unwrap() + "\n";
        if std::env::var_os("LATTICE_UPDATE_THEME_SCHEMA").is_some() {
            std::fs::write(PATH, &generated).unwrap();
        }
        let committed = std::fs::read_to_string(PATH).unwrap_or_default();
        assert!(
            committed == generated,
            "design-system/themes/theme-1.schema.json is out of date: run LATTICE_UPDATE_THEME_SCHEMA=1 cargo test -p lattice-theme schema"
        );
    }
}
