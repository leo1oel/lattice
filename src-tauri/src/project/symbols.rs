//! `\label` and `\cite` keys across the manuscript: finding, renaming,
//! removing, and spotting unused ones.

use super::bibliography::{citations, iter_bibliography_sources};
use super::history::apply_transaction;
use super::paths::relative_to;
use super::references::{command_argument_at, references};
use super::tree::read_file;
use super::{clip_line, err, line_number_at, skip_bytes};
use crate::models::{RenameSymbolResult, SymbolOccurrence, UnusedSymbols};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

const REFERENCE_COMMANDS: &[&str] = &["ref", "eqref", "pageref", "autoref", "cref", "Cref"];
const CITATION_COMMANDS: &[&str] = &[
    "cite",
    "nocite",
    "citep",
    "citet",
    "citeyear",
    "citeyearpar",
    "citealp",
    "citealt",
    "citeauthor",
    "supercite",
    "parencite",
    "smartcite",
    "textcite",
    "autocite",
    "footcite",
    "fullcite",
];

/// Every `.tex` file outside `.research` (eight levels deep), sorted by path.
pub(super) fn iter_tex_sources(root: &Path) -> Result<Vec<(String, String)>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root)
        .max_depth(8)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "tex"))
        .filter(|entry| {
            !entry
                .path()
                .strip_prefix(root)
                .is_ok_and(|path| path.components().any(|part| part.as_os_str() == ".research"))
        })
    {
        let source = fs::read_to_string(entry.path()).map_err(err)?;
        files.push((relative_to(root, entry.path())?, source));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn validate_symbol_name(kind: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Enter a {kind} name."));
    }
    if value.chars().count() > 120 {
        return Err(format!("Keep the {kind} under 120 characters."));
    }
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, ':' | '_' | '-' | '.' | '+')
    }) {
        return Err(format!("Use letters, numbers, and :_-.+ in the {kind}."));
    }
    Ok(())
}

/// Byte mask for LaTeX regions where command-looking text is literal. Symbol
/// search and destructive citation edits must agree on this mask so examples
/// in comments, `\verb`, and verbatim-like environments never become edits.
fn latex_literal_mask(source: &str) -> Vec<bool> {
    let bytes = source.as_bytes();
    let mut masked = vec![false; bytes.len()];

    let mut index = 0usize;
    while index < bytes.len() {
        let preceding_backslashes =
            || bytes[..index].iter().rev().take_while(|b| **b == b'\\').count();
        if bytes[index] == b'%' && preceding_backslashes() % 2 == 0 {
            let end = source[index..].find('\n').map_or(bytes.len(), |offset| index + offset);
            masked[index..end].fill(true);
            index = end;
        } else {
            index += 1;
        }
    }

    for environment in ["verbatim", "verbatim*", "lstlisting", "minted"] {
        let opening = format!("\\begin{{{environment}}}");
        let closing = format!("\\end{{{environment}}}");
        let mut cursor = 0usize;
        while let Some(relative) = source[cursor..].find(&opening) {
            let start = cursor + relative;
            if masked[start] {
                cursor = start + opening.len();
                continue;
            }
            let finish = source[start + opening.len()..]
                .find(&closing)
                .map_or(bytes.len(), |offset| start + opening.len() + offset + closing.len());
            masked[start..finish].fill(true);
            cursor = finish;
        }
    }

    let mut cursor = 0usize;
    while let Some(relative) = source[cursor..].find("\\verb") {
        let start = cursor + relative;
        if masked[start] {
            cursor = start + "\\verb".len();
            continue;
        }
        let mut delimiter_at = start + "\\verb".len();
        if bytes.get(delimiter_at) == Some(&b'*') {
            delimiter_at += 1;
        }
        let Some(&delimiter) = bytes.get(delimiter_at) else {
            break;
        };
        if delimiter.is_ascii_alphabetic() || delimiter.is_ascii_whitespace() {
            cursor = delimiter_at;
            continue;
        }
        let Some(relative_end) =
            bytes[delimiter_at + 1..].iter().position(|byte| *byte == delimiter)
        else {
            break;
        };
        let finish = delimiter_at + 1 + relative_end + 1;
        masked[start..finish].fill(true);
        cursor = finish;
    }

    masked
}

/// One `\command[opt]{a, b}` found outside literal regions.
struct ParsedCommandArgument {
    command_from: usize,
    command_to: usize,
    content_from: usize,
    content_to: usize,
    /// `(from, to, key)` for every non-empty comma-separated key.
    keys: Vec<(usize, usize, String)>,
}

fn find_command_arguments(source: &str, commands: &[&str]) -> Vec<ParsedCommandArgument> {
    let bytes = source.as_bytes();
    let literal = latex_literal_mask(source);
    let mut arguments = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'\\' || literal[index] {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let name_end =
            skip_bytes(bytes, name_start, |byte| byte.is_ascii_alphabetic() || *byte == b'*');
        if name_end == name_start {
            index += 1;
            continue;
        }
        let name = &source[name_start..name_end];
        if !commands.contains(&name.strip_suffix('*').unwrap_or(name)) {
            index = name_end;
            continue;
        }
        let mut cursor = skip_bytes(bytes, name_end, u8::is_ascii_whitespace);
        while bytes.get(cursor) == Some(&b'[') {
            let Some(close) = source[cursor + 1..].find(']') else {
                break;
            };
            cursor = skip_bytes(bytes, cursor + close + 2, u8::is_ascii_whitespace);
        }
        let Some((argument, end)) = command_argument_at(source, cursor) else {
            index = name_end;
            continue;
        };
        let content_from = end - 1 - argument.len();
        let mut offset = content_from;
        let keys = argument
            .split(',')
            .filter_map(|part| {
                let from = offset + part.len() - part.trim_start().len();
                offset += part.len() + 1;
                let key = part.trim();
                (!key.is_empty()).then(|| (from, from + key.len(), key.to_string()))
            })
            .collect();
        arguments.push(ParsedCommandArgument {
            command_from: index,
            command_to: end,
            content_from,
            content_to: end - 1,
            keys,
        });
        index = end;
    }
    arguments
}

fn find_command_argument_keys(source: &str, commands: &[&str]) -> Vec<(usize, usize, String)> {
    find_command_arguments(source, commands)
        .into_iter()
        .flat_map(|argument| argument.keys)
        .collect()
}

/// One in-place occurrence of a label or citation key.
struct SymbolEdit {
    path: String,
    from: usize,
    to: usize,
    line: u32,
    /// "definition" or "reference".
    role: &'static str,
    snippet: String,
}

impl SymbolEdit {
    fn new(path: &str, source: &str, from: usize, to: usize, role: &'static str) -> Self {
        let line = line_number_at(source, from);
        let snippet =
            clip_line(source.lines().nth(line.saturating_sub(1) as usize).unwrap_or(""), 160);
        Self { path: path.to_string(), from, to, line, role, snippet }
    }

    fn occurrence(self, kind: &str, symbol: &str) -> SymbolOccurrence {
        SymbolOccurrence {
            kind: kind.to_string(),
            symbol: symbol.to_string(),
            role: self.role.to_string(),
            path: self.path,
            line: self.line,
            snippet: self.snippet,
        }
    }
}

fn collect_label_edits(root: &Path, label: &str) -> Result<Vec<SymbolEdit>, String> {
    let mut edits = Vec::new();
    for (path, source) in iter_tex_sources(root)? {
        for (role, commands) in [("definition", &["label"][..]), ("reference", REFERENCE_COMMANDS)]
        {
            for (from, to, key) in find_command_argument_keys(&source, commands) {
                if key == label {
                    edits.push(SymbolEdit::new(&path, &source, from, to, role));
                }
            }
        }
    }
    Ok(edits)
}

fn collect_citation_edits(root: &Path, key: &str) -> Result<Vec<SymbolEdit>, String> {
    let mut edits = Vec::new();
    for (path, source) in iter_tex_sources(root)? {
        for (from, to, found) in find_command_argument_keys(&source, CITATION_COMMANDS) {
            if found.eq_ignore_ascii_case(key) {
                edits.push(SymbolEdit::new(&path, &source, from, to, "reference"));
            }
        }
    }
    for (relative, bibliography) in iter_bibliography_sources(root)? {
        if let Some(from) = bibliography_key_offset(&bibliography, key) {
            edits.push(SymbolEdit::new(
                &relative,
                &bibliography,
                from,
                from + key.len(),
                "definition",
            ));
        }
    }
    Ok(edits)
}

/// Offset of the exact `key` in an `@type{key` header, scanning every `@`.
fn bibliography_key_offset(source: &str, key: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'@' {
            index += 1;
            continue;
        }
        let type_end = skip_bytes(bytes, index + 1, u8::is_ascii_alphabetic);
        let cursor = skip_bytes(bytes, type_end, u8::is_ascii_whitespace);
        if bytes.get(cursor) != Some(&b'{') {
            index += 1;
            continue;
        }
        let key_start = skip_bytes(bytes, cursor + 1, u8::is_ascii_whitespace);
        let key_end = skip_bytes(bytes, key_start, |byte| {
            !matches!(byte, b',' | b'}') && !byte.is_ascii_whitespace()
        });
        if &source[key_start..key_end] == key {
            return Some(key_start);
        }
        index = key_start.max(index + 1);
    }
    None
}

/// The two kinds of cross-reference symbols a writer can find and rename;
/// the frontend names them `"label"` and `"citation"`.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Symbol {
    Label,
    Citation,
}

impl Symbol {
    /// Name used in validation and conflict messages.
    fn name(self) -> &'static str {
        match self {
            Self::Label => "label",
            Self::Citation => "citation key",
        }
    }

    /// `SymbolOccurrence::kind`, also the noun in rename history labels.
    fn kind(self) -> &'static str {
        match self {
            Self::Label => "label",
            Self::Citation => "citation",
        }
    }

    fn edits(self, root: &Path, value: &str) -> Result<Vec<SymbolEdit>, String> {
        match self {
            Self::Label => collect_label_edits(root, value),
            Self::Citation => collect_citation_edits(root, value),
        }
    }

    fn is_defined(self, root: &Path, value: &str) -> Result<bool, String> {
        Ok(match self {
            Self::Label => references(root)?.iter().any(|item| item.label == value),
            Self::Citation => citations(root)?.iter().any(|citation| citation.key == value),
        })
    }

    pub fn occurrences(self, root: &Path, value: &str) -> Result<Vec<SymbolOccurrence>, String> {
        validate_symbol_name(self.name(), value)?;
        let value = value.trim();
        Ok(self
            .edits(root, value)?
            .into_iter()
            .map(|edit| edit.occurrence(self.kind(), value))
            .collect())
    }

    pub fn rename(self, root: &Path, old: &str, new: &str) -> Result<RenameSymbolResult, String> {
        validate_symbol_name(self.name(), old)?;
        validate_symbol_name(self.name(), new)?;
        let (old, new) = (old.trim(), new.trim());
        if old == new {
            return Err(format!("Choose a different {}.", self.name()));
        }
        if self.is_defined(root, new)? {
            return Err(format!("The {} “{new}” already exists.", self.name()));
        }
        let edits = self.edits(root, old)?;
        if edits.is_empty() {
            return Err(format!("No occurrences of “{old}” were found."));
        }
        let mut by_path: BTreeMap<&str, Vec<(usize, usize)>> = BTreeMap::new();
        for edit in &edits {
            by_path.entry(&edit.path).or_default().push((edit.from, edit.to));
        }
        let mut file_edits = Vec::new();
        for (path, mut ranges) in by_path {
            let mut source = read_file(root, path)?;
            // Descending by start offset, so edits apply back-to-front.
            ranges.sort_by_key(|range| std::cmp::Reverse(range.0));
            for (from, to) in ranges {
                if source.get(from..to) != Some(old) {
                    return Err(format!("Could not rename “{old}” in {path}; the file changed."));
                }
                source.replace_range(from..to, new);
            }
            file_edits.push((path.to_string(), source));
        }
        let changed_files = file_edits.iter().map(|(path, _)| path.clone()).collect();
        let label = format!("Rename {} {old} → {new}", self.kind());
        let transaction = apply_transaction(root, &label, file_edits)?
            .ok_or_else(|| "The rename did not change any files.".to_string())?;
        let occurrence_count = edits.len() as u32;
        Ok(RenameSymbolResult { changed_files, occurrence_count, transaction_id: transaction.id })
    }
}

/// Manuscript uses that make removing a bibliography key unsafe. A wildcard
/// `\nocite{*}` applies to every key, unlike rename/find operations where `*`
/// must never be treated as the requested symbol.
pub fn find_citation_usages(root: &Path, key: &str) -> Result<Vec<SymbolOccurrence>, String> {
    validate_symbol_name(Symbol::Citation.name(), key)?;
    let key = key.trim();
    let mut edits = collect_citation_edits(root, key)?;
    edits.extend(collect_citation_edits(root, "*")?);
    Ok(edits
        .into_iter()
        .filter(|edit| edit.role == "reference")
        .map(|edit| edit.occurrence("citation", key))
        .collect())
}

/// A whole-file citation edit: (relative path, expected contents, new contents).
pub(crate) type PreparedFileEdit = (String, String, String);

/// Build manuscript edits that remove one citation key without touching disk.
/// Multi-key commands keep their other keys; a command whose only key is the
/// removed one disappears entirely. The caller can commit these edits beside
/// the bibliography update as one citation history transaction.
pub(crate) fn remove_citation_usages(
    root: &Path, key: &str,
) -> Result<(Vec<PreparedFileEdit>, u32), String> {
    validate_symbol_name(Symbol::Citation.name(), key)?;
    let key = key.trim();
    let mut file_edits = Vec::new();
    let mut occurrence_count = 0u32;
    for (path, source) in iter_tex_sources(root)? {
        let mut next = source.clone();
        let mut arguments = find_command_arguments(&source, CITATION_COMMANDS);
        arguments.sort_by_key(|argument| std::cmp::Reverse(argument.command_from));
        for argument in arguments {
            let (removed, remaining): (Vec<_>, Vec<_>) =
                argument.keys.iter().partition(|(_, _, found)| found.eq_ignore_ascii_case(key));
            if removed.is_empty() {
                continue;
            }
            occurrence_count += removed.len() as u32;
            let remaining = remaining
                .iter()
                .filter_map(|(from, to, _)| source.get(*from..*to))
                .collect::<Vec<_>>();
            if remaining.is_empty() {
                let mut command_to = argument.command_to;
                // Preserve one word boundary when a prose citation sat between
                // spaces, rather than leaving a visibly doubled gap.
                if source[..argument.command_from].ends_with(' ')
                    && source[command_to..].starts_with(' ')
                {
                    command_to += 1;
                }
                next.replace_range(argument.command_from..command_to, "");
            } else {
                next.replace_range(
                    argument.content_from..argument.content_to,
                    &remaining.join(", "),
                );
            }
        }
        if next != source {
            file_edits.push((path, source, next));
        }
    }
    Ok((file_edits, occurrence_count))
}

pub fn unused_symbols(root: &Path) -> Result<UnusedSymbols, String> {
    let mut defined_labels = BTreeSet::new();
    let mut referenced_labels = BTreeSet::new();
    let mut cited_keys = BTreeSet::new();
    for (_path, source) in iter_tex_sources(root)? {
        for (keys, commands) in [
            (&mut defined_labels, &["label"][..]),
            (&mut referenced_labels, REFERENCE_COMMANDS),
            (&mut cited_keys, CITATION_COMMANDS),
        ] {
            keys.extend(
                find_command_argument_keys(&source, commands).into_iter().map(|(_, _, key)| key),
            );
        }
    }
    let labels = defined_labels.difference(&referenced_labels).cloned().collect();
    let bibliography_keys =
        citations(root)?.into_iter().map(|citation| citation.key).collect::<BTreeSet<_>>();
    let citations = bibliography_keys.difference(&cited_keys).cloned().collect();
    Ok(UnusedSymbols { labels, citations })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    #[test]
    fn labels_and_citations_can_be_found_renamed_and_reported_unused() {
        let fixture = Fixture::project("rename-symbols");
        let root = &fixture.root;
        fixture.write(
            "main.tex",
            "See \\ref{fig:model} and \\cref{fig:model, eq:loss}.\n\\label{fig:model}\n\\label{fig:dead}\n\\citep{vaswani2017attention}\n",
        );
        fixture.write(
            "references.bib",
            "@article{vaswani2017attention,\n  title={Attention},\n}\n@article{dead, title={Dead}, year={2021},}\n",
        );
        let unused = unused_symbols(root).unwrap();
        assert_eq!(
            (unused.labels, unused.citations),
            (vec!["fig:dead".into()], vec!["dead".into()])
        );

        let label_hits = Symbol::Label.occurrences(root, "fig:model").unwrap();
        let roles = label_hits.iter().map(|hit| hit.role.as_str()).collect::<Vec<_>>();
        assert_eq!(roles, ["definition", "reference", "reference"]);
        Symbol::Label.rename(root, "fig:model", "fig:architecture").unwrap();

        assert_eq!(Symbol::Citation.occurrences(root, "vaswani2017attention").unwrap().len(), 2);
        Symbol::Citation.rename(root, "vaswani2017attention", "vaswani2017").unwrap();
        assert_eq!(
            fixture.read("main.tex"),
            "See \\ref{fig:architecture} and \\cref{fig:architecture, eq:loss}.\n\\label{fig:architecture}\n\\label{fig:dead}\n\\citep{vaswani2017}\n"
        );
        assert!(fixture.read("references.bib").contains("@article{vaswani2017,"));
    }

    #[test]
    fn symbol_kinds_arrive_as_the_frontend_names_them() {
        let kinds: Vec<Symbol> = serde_json::from_str(r#"["label", "citation"]"#).unwrap();
        let names = kinds.iter().map(|kind| kind.name()).collect::<Vec<_>>();
        assert_eq!(names, ["label", "citation key"]);
        assert!(serde_json::from_str::<Symbol>(r#""environment""#).is_err());
    }
}
