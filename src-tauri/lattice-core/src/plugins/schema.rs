//! The plugin API as a JSON Schema document, generated from `protocol` and
//! `manifest` and committed as `plugin-api/schema/level-<N>.json`.
//!
//! The committed file is what authors and the SDK's TypeScript types read,
//! and what CI compares: `schema_file_is_current` fails when the types
//! changed without regenerating it, and
//! `scripts/check-plugin-api-schema.mjs` fails when the regenerated file
//! removes or narrows anything the base branch's file had.
//!
//! Regenerate with
//! `LATTICE_UPDATE_PLUGIN_SCHEMA=1 cargo test -p lattice-core plugins::schema`.

use super::manifest::Manifest;
use super::protocol::*;
use schemars::{generate::SchemaSettings, JsonSchema, SchemaGenerator};
use serde_json::{json, Map, Value};

/// Each method: name, direction, since level, params type, result type
/// (`None` for a notification).
type MethodRow = (
    &'static str,
    &'static str,
    u32,
    fn(&mut SchemaGenerator) -> Value,
    Option<fn(&mut SchemaGenerator) -> Value>,
);

fn of<T: JsonSchema>(generator: &mut SchemaGenerator) -> Value {
    generator.subschema_for::<T>().to_value()
}

const METHODS: &[MethodRow] = &[
    ("initialize", "hostToPlugin", 1, of::<InitializeParams>, Some(of::<InitializeResult>)),
    ("command/run", "hostToPlugin", 1, of::<RunParams>, Some(of::<CommandResult>)),
    ("$/cancelRequest", "hostToPlugin", 1, of::<CancelParams>, None),
    (
        "bibliography/entries",
        "pluginToHost",
        1,
        of::<BibliographyEntriesParams>,
        Some(of::<BibliographyEntriesResult>),
    ),
    ("http/fetch", "pluginToHost", 1, of::<HttpFetchParams>, Some(of::<HttpFetchResult>)),
    ("secrets/get", "pluginToHost", 1, of::<SecretsGetParams>, Some(of::<SecretsGetResult>)),
    ("log", "pluginToHost", 1, of::<LogParams>, None),
    ("progress", "pluginToHost", 1, of::<ProgressParams>, None),
];

/// The whole API at `API_LEVEL`, deterministic so it can be committed.
pub fn document() -> Value {
    let mut generator = SchemaSettings::draft2020_12().into_generator();
    let mut methods = Map::new();
    for (name, direction, since, params, result) in METHODS {
        let mut method =
            json!({ "direction": direction, "since": since, "params": params(&mut generator) });
        match result {
            Some(result) => method["result"] = result(&mut generator),
            None => method["notification"] = json!(true),
        }
        methods.insert((*name).to_string(), method);
    }
    let manifest = of::<Manifest>(&mut generator);
    let errors = json!({
        "permissionDenied": error_codes::PERMISSION_DENIED,
        "unsupportedApiLevel": error_codes::UNSUPPORTED_API_LEVEL,
        "hostError": error_codes::HOST_ERROR,
        "requestCancelled": error_codes::REQUEST_CANCELLED,
    });
    let defs: Map<String, Value> = generator.take_definitions(true).into_iter().collect();
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Lattice plugin API",
        "apiLevel": API_LEVEL,
        "apiCompat": API_COMPAT,
        "manifestSchema": super::manifest::SCHEMA,
        "manifest": manifest,
        "methods": methods,
        "errorCodes": errors,
        "$defs": defs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn committed_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../plugin-api/schema")
            .join(format!("level-{API_LEVEL}.json"))
    }

    #[test]
    fn schema_file_is_current() {
        let generated = serde_json::to_string_pretty(&document()).unwrap() + "\n";
        let path = committed_path();
        if std::env::var_os("LATTICE_UPDATE_PLUGIN_SCHEMA").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &generated).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == generated,
            "{} is out of date with plugins::protocol. Regenerate it with \
             LATTICE_UPDATE_PLUGIN_SCHEMA=1 cargo test -p lattice-core plugins::schema, then run \
             node scripts/check-plugin-api-schema.mjs to confirm the change only adds.",
            path.display()
        );
    }

    #[test]
    fn every_method_names_its_types() {
        let doc = document();
        let defs = doc["$defs"].as_object().unwrap();
        for (name, method) in doc["methods"].as_object().unwrap() {
            let reference =
                method["params"]["$ref"].as_str().unwrap_or_else(|| panic!("{name} params"));
            assert!(defs.contains_key(reference.trim_start_matches("#/$defs/")), "{name}");
        }
    }
}
