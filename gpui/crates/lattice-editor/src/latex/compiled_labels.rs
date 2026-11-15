//! What the last build numbered each label, read from the `.aux` files it
//! wrote: the Tauri app's `src/editor/latex/compiled-labels.ts`, whose
//! tests the ones below repeat. A reference card says "(3), page 4 in the
//! last build" from it.
//!
//! The host says which build that is ([`crate::ProjectIndex::set_compiled_build`]);
//! the index reads its `.aux` files once, off the main thread, and again only
//! for a new build.

use std::{collections::HashMap, path::Path, sync::LazyLock};

use regex::Regex;

/// A label's number and page as TeX wrote them, markup taken off.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CompiledLabel {
    pub number: String,
    pub page: String,
}

/// The build whose `.aux` is read: its root document and the folder its
/// `.aux` files went to (project-relative; the document's own folder when
/// empty, `BuildResult::aux_folder`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompiledBuild {
    /// Which build it was: a new one is read again, even into the same
    /// folder (a new `CompiledBuild` object in the Tauri app).
    pub id: u64,
    pub root_document: String,
    pub aux_folder: String,
}

/// A document's chapters read for their numbers: the `.aux` is the build's
/// output, so it is bounded too (`MAX_AUX_INPUTS`).
const MAX_AUX_INPUTS: usize = 300;
/// A document can write anything to its `.aux`; a longer one is read as
/// empty, numbering nothing (`MAX_AUX_CHARS`).
const MAX_AUX_BYTES: usize = 4_000_000;

static NEWLABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\newlabel\{([^}]*)\}").expect("the \\newlabel pattern compiles")
});
static INPUT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\@input\{([^}]+\.aux)\}").expect("the \\@input pattern compiles")
});
static MARKUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\[A-Za-z@]+\s*").expect("the markup pattern compiles"));

/// The brace-balanced group that opens at `from`, and the offset just past it.
fn group(text: &str, from: usize) -> Option<(&str, usize)> {
    let bytes = text.as_bytes();
    if bytes.get(from) != Some(&b'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut index = from;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&text[from + 1..index], index + 1));
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// A number or page as TeX wrote it (`{\relax 3}`, `{\textup {(3)}}`),
/// without its markup.
fn plain(value: &str) -> String {
    MARKUP
        .replace_all(value, "")
        .replace(['{', '}'], "")
        .trim()
        .to_string()
}

/// `\newlabel{key}{{number}{page}…}` lines, and the chapter `.aux` files an
/// `\include` adds through `\@input{…}`. cleveref's `key@cref` twins are not
/// labels the writer typed.
pub fn parse_aux(aux: &str) -> (HashMap<String, CompiledLabel>, Vec<String>) {
    let mut labels = HashMap::new();
    for found in NEWLABEL.captures_iter(aux) {
        let (Some(whole), Some(key)) = (found.get(0), found.get(1)) else {
            continue;
        };
        let key = key.as_str();
        let Some((outer, _)) = group(aux, whole.end()) else {
            continue;
        };
        let Some((number, after)) = group(outer, 0) else {
            continue;
        };
        let Some((page, _)) = group(outer, after) else {
            continue;
        };
        if key.ends_with("@cref") {
            continue;
        }
        labels.insert(
            key.to_string(),
            CompiledLabel {
                number: plain(number),
                page: plain(page),
            },
        );
    }
    let inputs = INPUT
        .captures_iter(aux)
        .filter_map(|found| Some(found.get(1)?.as_str().to_string()))
        .collect();
    (labels, inputs)
}

/// The last build's label numbers and pages: the root document's `.aux`, in
/// the build's aux folder, and each chapter's it names, from that same
/// folder. A file that cannot be read numbers nothing.
pub fn read_compiled_labels(root: &Path, build: &CompiledBuild) -> HashMap<String, CompiledLabel> {
    let folder = if build.aux_folder.is_empty() {
        build
            .root_document
            .rsplit_once('/')
            .map_or("", |(folder, _)| folder)
            .to_string()
    } else {
        build.aux_folder.clone()
    };
    let read = |relative: &str| -> String {
        let path = if folder.is_empty() {
            relative.to_string()
        } else {
            format!("{folder}/{relative}")
        };
        lattice_core::project::read_file(root, &path)
            .ok()
            .filter(|text| text.len() <= MAX_AUX_BYTES)
            .unwrap_or_default()
    };
    let name = build.root_document.rsplit('/').next().unwrap_or_default();
    let stem = name
        .len()
        .checked_sub(4)
        .filter(|at| name.is_char_boundary(*at) && name[*at..].eq_ignore_ascii_case(".tex"))
        .map_or(name, |at| &name[..at]);
    let (mut labels, inputs) = parse_aux(&read(&format!("{stem}.aux")));
    for input in inputs.iter().take(MAX_AUX_INPUTS) {
        let (more, _) = parse_aux(&read(input));
        for (key, label) in more {
            labels.entry(key).or_insert(label);
        }
    }
    labels
}

/// "(3), page 4 in the last build": what a reference card says of a label
/// the build numbered (`compiledFact`); `None` without a number.
pub fn compiled_fact(kind: &str, label: &CompiledLabel) -> Option<String> {
    if label.number.is_empty() {
        return None;
    }
    let number = if kind == "equation" {
        format!("({})", label.number)
    } else {
        label.number.clone()
    };
    Some(if label.page.is_empty() {
        number
    } else {
        lattice_i18n::t!(
            "{number}, page {page} in the last build",
            number = number,
            page = label.page
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(number: &str, page: &str) -> CompiledLabel {
        CompiledLabel {
            number: number.into(),
            page: page.into(),
        }
    }

    #[test]
    fn reads_each_label_with_or_without_hyperref_and_skips_cleveref_twins() {
        let (labels, inputs) = parse_aux(
            &[
                "\\relax",
                "\\newlabel{eq:loss}{{3}{4}{Training}{equation.2.3}{}}",
                "\\newlabel{eq:loss@cref}{{[equation][3][]3}{[1][4][]4}}",
                "\\newlabel{sec:intro}{{1.2}{\\relax 2}}",
                "\\newlabel{fig:{nested}}{{\\textup {5}}{7}}",
                "\\@input{chapters/results.aux}",
            ]
            .join("\n"),
        );
        assert_eq!(
            labels,
            HashMap::from([
                ("eq:loss".to_string(), label("3", "4")),
                ("sec:intro".to_string(), label("1.2", "2")),
            ])
        );
        assert_eq!(inputs, vec!["chapters/results.aux".to_string()]);
    }

    #[test]
    fn reads_the_root_document_s_aux_and_its_chapters() {
        let root = tempfile::tempdir().expect("a scratch folder");
        std::fs::create_dir_all(root.path().join("paper/chapters")).unwrap();
        std::fs::write(
            root.path().join("paper/main.aux"),
            "\\newlabel{eq:a}{{1}{2}}\n\\@input{chapters/b.aux}\n",
        )
        .unwrap();
        std::fs::write(
            root.path().join("paper/chapters/b.aux"),
            "\\newlabel{eq:b}{{2.1}{9}}\n",
        )
        .unwrap();
        let build = CompiledBuild {
            id: 1,
            root_document: "paper/main.tex".into(),
            aux_folder: String::new(),
        };
        assert_eq!(
            read_compiled_labels(root.path(), &build),
            HashMap::from([
                ("eq:a".to_string(), label("1", "2")),
                ("eq:b".to_string(), label("2.1", "9")),
            ])
        );
        // A build into the hidden build folder reads its `.aux` from there.
        let hidden = CompiledBuild {
            id: 2,
            root_document: "paper/main.tex".into(),
            aux_folder: ".research/build/paper".into(),
        };
        assert!(read_compiled_labels(root.path(), &hidden).is_empty());
    }

    #[test]
    fn facts_say_the_number_and_page() {
        assert_eq!(
            compiled_fact("equation", &label("3", "4")).as_deref(),
            Some("(3), page 4 in the last build")
        );
        assert_eq!(
            compiled_fact("figure", &label("2", "")).as_deref(),
            Some("2")
        );
        assert_eq!(compiled_fact("figure", &label("", "1")), None);
    }
}
