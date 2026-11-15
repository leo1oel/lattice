//! Completion from what the project's files hold, as the Tauri app's
//! `includeCompletions` and `macroCompletions` (`latex-completions.ts`):
//! inside `\input{`, `\include{` or `\includegraphics{` the project's TeX
//! files or its figures (each figure also under the `\graphicspath` roots
//! it sits in, relative to the root), and after a `\` the commands and
//! environments the project defines with `\newcommand` and
//! `\newenvironment`, the open file's unsaved ones among them.
//!
//! What the other files hold is read by the host into [`ProjectFacts`]
//! (`lattice-gpui`'s `editor_panel/index_lint.rs`, which reads them for the
//! lint already); the open file is read from the buffer at each ask.

use std::{cell::RefCell, rc::Rc, sync::LazyLock};

use gpui::App;
use lattice_i18n::t;
use regex::Regex;

use super::definition::graphics_roots;
use crate::completion::{
    CompletionItem, CompletionKind, CompletionList, CompletionQuery, CompletionSource,
};

/// What the project's files hold, besides the open one.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectFacts {
    /// Every project file, project-relative.
    pub paths: Vec<String>,
    /// The `\graphicspath` roots the other TeX sources set.
    pub graphics_roots: Vec<String>,
    /// The commands and environments the other TeX sources define.
    pub macros: Vec<LocalMacro>,
}

/// The facts as the sources and the host share them.
pub type Facts = Rc<RefCell<ProjectFacts>>;

/// A command or environment a project source defines (`LocalMacro`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalMacro {
    /// `\name`, or `\begin{name}` for an environment.
    pub label: String,
    pub environment: bool,
}

static NEWCOMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:new|renew|provide)command\*?\{(\\[A-Za-z@]+)\}")
        .expect("the newcommand pattern compiles")
});
static NEWENVIRONMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:new|renew)environment\*?\{([A-Za-z*][A-Za-z0-9*]*)\}")
        .expect("the newenvironment pattern compiles")
});
static OPEN_INCLUDE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(includegraphics|include|input)(?:\[[^\]]*\])?\{([^}]*)$")
        .expect("the include slot pattern compiles")
});
static MACRO_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\[A-Za-z@]*$").expect("the macro word pattern compiles"));
static GRAPHICS_FILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\.(png|jpe?g|pdf|svg|eps|webp)$").expect("the graphics file pattern compiles")
});

/// The commands, then the environments, each source defines, the first
/// definition of a name kept (`parseLocalMacros`).
pub fn local_macros<'a>(sources: impl IntoIterator<Item = &'a str>) -> Vec<LocalMacro> {
    let mut macros: Vec<LocalMacro> = Vec::new();
    let mut add = |label: String, environment: bool| {
        if !macros.iter().any(|known| known.label == label) {
            macros.push(LocalMacro { label, environment });
        }
    };
    for source in sources {
        for found in NEWCOMMAND.captures_iter(source) {
            add(found[1].to_string(), false);
        }
        for found in NEWENVIRONMENT.captures_iter(source) {
            add(format!("\\begin{{{}}}", &found[1]), true);
        }
    }
    macros
}

fn matches(query: &str, field: &str) -> bool {
    query.is_empty() || field.to_lowercase().contains(query)
}

/// The project's TeX files in an `\input{` or `\include{`, its figures in an
/// `\includegraphics{`, matched anywhere in the path.
pub struct IncludeSource {
    pub facts: Facts,
}

/// The options for the argument typed so far (`query`) of `command`, with
/// the open file's own text for its `\graphicspath` roots.
pub fn include_items(
    facts: &ProjectFacts,
    command: &str,
    query: &str,
    open_text: &str,
) -> Vec<CompletionItem> {
    let graphics = command == "includegraphics";
    let mut roots = facts.graphics_roots.clone();
    if graphics {
        for root in graphics_roots([open_text]) {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    let figure = super::cards::reference_kind_label("figure").to_string();
    // A path and its detail, in the order first seen; a later detail for
    // the same path replaces the earlier one, as the Tauri app's Map does.
    let mut details: Vec<(String, String)> = Vec::new();
    let mut set = |path: String, detail: String| match details.iter_mut().find(|(p, _)| *p == path)
    {
        Some(entry) => entry.1 = detail,
        None => details.push((path, detail)),
    };
    for path in &facts.paths {
        if !graphics {
            if path.ends_with(".tex") {
                set(path.clone(), "tex".into());
            }
            continue;
        }
        if !GRAPHICS_FILE.is_match(path) {
            continue;
        }
        set(path.clone(), figure.clone());
        for root in &roots {
            if let Some(rest) = path.strip_prefix(&format!("{root}/")) {
                set(rest.to_string(), "graphicspath".into());
            }
        }
    }
    let query = query.to_lowercase();
    details
        .into_iter()
        .filter(|(path, _)| matches(&query, path))
        .map(|(path, detail)| CompletionItem {
            label: path.clone().into(),
            insert: path,
            caret: None,
            detail: Some(detail.into()),
            kind: CompletionKind::File,
            reopen: false,
        })
        .collect()
}

impl CompletionSource for IncludeSource {
    fn complete(&self, query: &CompletionQuery, _: &App) -> Option<CompletionList> {
        let found = OPEN_INCLUDE.captures(query.before)?;
        let typed = found.get(2)?.as_str();
        let command = &found[1];
        let open_text = if command == "includegraphics" {
            query.text.text()
        } else {
            String::new()
        };
        let items = include_items(&self.facts.borrow(), command, typed, &open_text);
        Some(CompletionList {
            range: query.offset - typed.len()..query.offset,
            items,
        })
    }
}

/// The project's own commands and environments after a `\`, matched
/// anywhere in the name.
pub struct MacroSource {
    pub facts: Facts,
}

/// The open file's macros, then the other files' ones, matching `word`
/// (with its `\`).
pub fn macro_items(
    open: Vec<LocalMacro>,
    others: &[LocalMacro],
    word: &str,
) -> Vec<CompletionItem> {
    let mut macros = open;
    for other in others {
        if !macros.iter().any(|known| known.label == other.label) {
            macros.push(other.clone());
        }
    }
    let query = word.to_lowercase();
    macros
        .into_iter()
        .filter(|found| found.label.to_lowercase().contains(&query))
        .map(|found| CompletionItem {
            label: found.label.clone().into(),
            insert: found.label,
            caret: None,
            detail: Some(
                if found.environment {
                    t!("project environment")
                } else {
                    t!("project command")
                }
                .to_string()
                .into(),
            ),
            kind: if found.environment {
                CompletionKind::Environment
            } else {
                CompletionKind::Command
            },
            reopen: false,
        })
        .collect()
}

impl CompletionSource for MacroSource {
    fn complete(&self, query: &CompletionQuery, _: &App) -> Option<CompletionList> {
        let word = MACRO_WORD.find(query.before)?.as_str();
        let text = query.text.text();
        let items = macro_items(
            local_macros([text.as_str()]),
            &self.facts.borrow().macros,
            word,
        );
        Some(CompletionList {
            range: query.offset - word.len()..query.offset,
            items,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(items: &[CompletionItem]) -> Vec<String> {
        items.iter().map(|item| item.label.to_string()).collect()
    }

    fn details(items: &[CompletionItem]) -> Vec<String> {
        items
            .iter()
            .map(|item| {
                item.detail
                    .as_ref()
                    .map(|d| d.to_string())
                    .unwrap_or_default()
            })
            .collect()
    }

    /// `parseLocalMacros` in latex-text.ts: `\newcommand`, `\renewcommand`
    /// and `\providecommand` (starred or not) name commands, `\newenvironment`
    /// and `\renewenvironment` environments, the first definition wins.
    #[test]
    fn reads_the_commands_and_environments_a_source_defines() {
        let macros = local_macros([
            "\\newcommand{\\R}{\\mathbb{R}}\n\\renewcommand*{\\vec}[1]{\\mathbf{#1}}\n\\newenvironment{proofsketch}{}{}",
            "\\providecommand{\\R}{x}\\newcommand{\\cA}{\\mathcal{A}}",
        ]);
        assert_eq!(
            macros.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(),
            ["\\R", "\\vec", "\\begin{proofsketch}", "\\cA"]
        );
        assert!(macros[2].environment && !macros[0].environment);
    }

    #[test]
    fn lists_the_open_file_s_macros_before_the_project_s_matching_the_word() {
        let open = local_macros(["\\newcommand{\\Rplus}{x}"]);
        let others = local_macros([
            "\\newcommand{\\R}{x}\\newcommand{\\Rplus}{y}\\newenvironment{remark}{}{}",
        ]);
        let items = macro_items(open, &others, "\\r");
        assert_eq!(labels(&items), ["\\Rplus", "\\R"]);
        let items = macro_items(Vec::new(), &others, "\\be");
        assert_eq!(labels(&items), ["\\begin{remark}"]);
        assert_eq!(items[0].kind, CompletionKind::Environment);
    }

    /// `includeCompletions`: an `\input` lists `.tex` files; an
    /// `\includegraphics` lists figures, each also relative to the
    /// `\graphicspath` root it sits under, the open file's roots included.
    #[test]
    fn lists_tex_files_or_figures_under_their_roots() {
        let facts = ProjectFacts {
            paths: vec![
                "main.tex".into(),
                "chapters/intro.tex".into(),
                "figures/plot.PDF".into(),
                "img/logo.png".into(),
                "notes.txt".into(),
            ],
            graphics_roots: vec!["figures".into()],
            macros: Vec::new(),
        };
        let inputs = include_items(&facts, "input", "", "");
        assert_eq!(labels(&inputs), ["main.tex", "chapters/intro.tex"]);
        assert_eq!(details(&inputs), ["tex", "tex"]);
        assert_eq!(
            labels(&include_items(&facts, "include", "INTRO", "")),
            ["chapters/intro.tex"]
        );
        let figures = include_items(&facts, "includegraphics", "", "\\graphicspath{{img/}}");
        assert_eq!(
            labels(&figures),
            ["figures/plot.PDF", "plot.PDF", "img/logo.png", "logo.png"]
        );
        assert_eq!(details(&figures)[1], "graphicspath");
        assert_eq!(details(&figures)[3], "graphicspath");
    }
}
