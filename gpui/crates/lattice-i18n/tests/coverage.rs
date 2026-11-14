//! The port of the Tauri app's `scripts/check-i18n-coverage.mjs` for the GPUI
//! app: every message its sources translate (`t!`, `tc!`, `n!`, `tr`,
//! `tr_context`) has Chinese in the catalogs, unless it reads the same in
//! every language (a product or format name, listed in the Tauri app's
//! `scripts/i18n-unlocalized-baseline.txt` or this crate's
//! `locales/unlocalized.txt`); every message in this crate's own catalog has
//! Chinese; and the GPUI list names only messages still in use.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use lattice_i18n::{GPUI_CATALOG, chinese, po};

fn crates_dir() -> PathBuf {
    // Canonical, so no path under it starts with this crate's own directory
    // by way of `lattice-i18n/..`.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .unwrap()
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Read a Rust string literal starting at `text[0] == '"'`: its value and the
/// rest after it.
fn literal(text: &str) -> Option<(String, &str)> {
    let mut chars = text.strip_prefix('"')?.char_indices();
    let mut value = String::new();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((value, &text[i + 2..])),
            '\\' => match chars.next()?.1 {
                'n' => value.push('\n'),
                't' => value.push('\t'),
                '\n' => {
                    // A line continuation skips the next line's indentation.
                    let rest = &text[i + 2..];
                    let skipped = rest.len() - rest.trim_start().len();
                    for _ in 0..skipped.saturating_sub(1) {
                        chars.next();
                    }
                }
                other => value.push(other),
            },
            other => value.push(other),
        }
    }
    None
}

/// Every (context, message) a source translates.
fn translated_messages(source: &str) -> Vec<(Option<String>, String)> {
    let mut out = Vec::new();
    for (opener, with_context) in [
        ("t!(", false),
        ("n!(", false),
        ("tr(", false),
        ("tc!(", true),
        ("tr_context(", true),
    ] {
        let mut rest = source;
        while let Some(at) = rest.find(opener) {
            // `tr(` inside another word (`attr(`, `str(`) is not the call.
            let before = rest[..at].chars().next_back();
            rest = &rest[at + opener.len()..];
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let args = rest.trim_start();
            let Some((first, after)) = literal(args) else {
                continue;
            };
            if with_context {
                let Some(after) = after.trim_start().strip_prefix(',') else {
                    continue;
                };
                if let Some((message, _)) = literal(after.trim_start()) {
                    out.push((Some(first), message));
                }
            } else {
                out.push((None, first));
            }
        }
    }
    out
}

fn allowlist(text: &str) -> BTreeSet<String> {
    text.lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

fn has_han(text: &str) -> bool {
    text.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c))
}

/// Whether a message has words to translate once its placeholders go.
fn has_words(message: &str) -> bool {
    let mut stripped = String::new();
    let mut depth = 0;
    for c in message.chars() {
        match c {
            '{' => depth += 1,
            '}' if depth > 0 => depth -= 1,
            _ if depth == 0 => stripped.push(c),
            _ => {}
        }
    }
    stripped.chars().any(|c| c.is_ascii_alphabetic())
}

#[test]
fn every_translated_message_has_chinese() {
    let tauri_allowed = allowlist(include_str!(
        "../../../../scripts/i18n-unlocalized-baseline.txt"
    ));
    let gpui_allowed = allowlist(include_str!("../locales/unlocalized.txt"));
    let mut files = Vec::new();
    rust_files(&crates_dir(), &mut files);
    let mut used = BTreeSet::new();
    let mut missing = BTreeSet::new();
    for file in &files {
        // This crate's own tests and docs exercise the macros with samples.
        if file.starts_with(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .canonicalize()
                .unwrap(),
        ) {
            continue;
        }
        let source = fs::read_to_string(file).unwrap();
        for (context, message) in translated_messages(&source) {
            used.insert(message.clone());
            if !has_words(&message)
                || tauri_allowed.contains(&message)
                || gpui_allowed.contains(&message)
            {
                continue;
            }
            if !chinese(context.as_deref(), &message).is_some_and(has_han) {
                let place = file.strip_prefix(crates_dir()).unwrap_or(file);
                missing.insert(format!("{}: {message:?}", place.display()));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "these messages have no Chinese; add them to crates/lattice-i18n/locales/zh-CN/<area>.po \
         (or, for a name that reads the same in every language, to locales/unlocalized.txt):\n{}",
        missing.into_iter().collect::<Vec<_>>().join("\n")
    );
    let stale: Vec<_> = gpui_allowed.difference(&used).collect();
    assert!(
        stale.is_empty(),
        "locales/unlocalized.txt lists messages no source translates any more: {stale:?}"
    );
}

#[test]
fn the_gpui_catalog_is_translated() {
    let gpui_allowed = allowlist(include_str!("../locales/unlocalized.txt"));
    let untranslated: Vec<_> = po::parse(GPUI_CATALOG)
        .into_iter()
        .filter(|entry| {
            has_words(&entry.msgid)
                && !gpui_allowed.contains(&entry.msgid)
                && !has_han(&entry.msgstr)
        })
        .map(|entry| entry.msgid)
        .collect();
    assert!(
        untranslated.is_empty(),
        "locales/zh-CN/ has messages without Chinese: {untranslated:?}"
    );
}

#[test]
fn the_scanner_reads_calls_and_literals() {
    let source = r#"
        let a = t!("Build");
        let b = t!("Version {0}", v);
        let c = tc!("tab", "Close");
        let d = tr("Open \"it\"");
        let e = attr("not this");
        let f = tr_context("ctx", "With context");
    "#;
    assert_eq!(
        translated_messages(source),
        vec![
            (None, "Build".to_owned()),
            (None, "Version {0}".to_owned()),
            (None, "Open \"it\"".to_owned()),
            (Some("tab".to_owned()), "Close".to_owned()),
            (Some("ctx".to_owned()), "With context".to_owned()),
        ]
    );
}
