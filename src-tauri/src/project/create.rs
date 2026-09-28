//! New projects: conference templates, the disposable tutorial, and blank
//! workspaces for joining a live share.

use super::err;
use super::manifest::write_manifest;
use super::paths::is_plain_segment;
use super::tree::build_artifact_ignore_lines;
use crate::models::{ProjectManifest, RootDocument};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(super) const RESEARCH_GITIGNORE: &str = "history/\nsessions/\ncheckpoints/\ncache/\n";

const NEURIPS_2026_STYLE: &str = include_str!("../../templates/neurips-2026/neurips_2026.sty");

/// Each venue's `main.tex` (titled on creation) and the style files beside it.
const NEURIPS_TEMPLATE: &[(&str, &str)] = &[
    ("main.tex", include_str!("../../templates/neurips-2026/main.tex")),
    ("neurips_2026.sty", NEURIPS_2026_STYLE),
];
const ICML_TEMPLATE: &[(&str, &str)] = &[
    ("main.tex", include_str!("../../templates/icml-2026/main.tex")),
    ("icml2026.sty", include_str!("../../templates/icml-2026/icml2026.sty")),
    ("icml2026.bst", include_str!("../../templates/icml-2026/icml2026.bst")),
];
const ICLR_TEMPLATE: &[(&str, &str)] = &[
    ("main.tex", include_str!("../../templates/iclr-2026/main.tex")),
    ("iclr2026_conference.sty", include_str!("../../templates/iclr-2026/iclr2026_conference.sty")),
    ("iclr2026_conference.bst", include_str!("../../templates/iclr-2026/iclr2026_conference.bst")),
];

const TUTORIAL_PROJECT_NAME: &str = "Understanding Attention";

/// A bundled tutorial file, written at the same path it has under `templates/tutorial`.
macro_rules! tutorial_file {
    ($path:literal) => {
        ($path, include_bytes!(concat!("../../templates/tutorial/", $path)))
    };
}

const TUTORIAL_FILES: &[(&str, &[u8])] = &[
    tutorial_file!("main.tex"),
    tutorial_file!("notes.md"),
    tutorial_file!("attention-demo.html"),
    tutorial_file!("attention-map.tldr"),
    tutorial_file!("attention-results.lattice-sheet"),
    tutorial_file!("slides/understanding-attention/index.tsx"),
    tutorial_file!("project.toml"),
    tutorial_file!("references.bib"),
    tutorial_file!("figures/scaled-dot-product-attention.png"),
    tutorial_file!("figures/multi-head-attention.png"),
    tutorial_file!("figures/attention-figure-2.pdf"),
    tutorial_file!("figures/ATTRIBUTION.md"),
];

const TUTORIAL_BRIEF: &str = "# Understanding Attention\n\n## Goal\n\nLearn the Lattice workflow with an original short paper about attention.\n\n## Evidence\n\nImport arXiv:1706.03762 from the Papers panel before asking an Agent to make factual changes.\n\n## Constraints\n\n- Keep claims conservative.\n- Cite the original paper for architecture and reported results.\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Venue {
    Neurips,
    Icml,
    Iclr,
}

impl Venue {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "neurips" | "nips" => Ok(Self::Neurips),
            "icml" => Ok(Self::Icml),
            "iclr" => Ok(Self::Iclr),
            other => Err(format!("Unknown venue “{other}”. Choose neurips, icml, or iclr.")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Neurips => "neurips",
            Self::Icml => "icml",
            Self::Iclr => "iclr",
        }
    }

    /// Default (word, page) budgets.
    pub(super) fn budgets(self) -> (Option<u32>, Option<u32>) {
        match self {
            Self::Neurips | Self::Iclr => (Some(5500), Some(9)),
            Self::Icml => (Some(5500), Some(8)),
        }
    }

    fn template(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Neurips => NEURIPS_TEMPLATE,
            Self::Icml => ICML_TEMPLATE,
            Self::Iclr => ICLR_TEMPLATE,
        }
    }
}

pub fn default_manifest(name: &str) -> ProjectManifest {
    default_manifest_with_venue(name, Venue::Neurips)
}

fn default_manifest_with_venue(name: &str, venue: Venue) -> ProjectManifest {
    let (word_budget, page_budget) = venue.budgets();
    ProjectManifest {
        schema_version: 1,
        project_id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        root_documents: vec![RootDocument {
            path: "main.tex".to_string(),
            name: "Main paper".to_string(),
            is_default: true,
        }],
        primary_bibliography: "references.bib".to_string(),
        trusted: false,
        engine: "pdf".to_string(),
        venue: venue.as_str().to_string(),
        word_budget,
        page_budget,
        spelling_words: Vec::new(),
    }
}

/// NeurIPS default used by unit tests across the crate.
#[cfg(test)]
pub fn create(parent: &Path, name: &str) -> Result<PathBuf, String> {
    create_with_venue(parent, name, Venue::Neurips)
}

pub fn create_with_venue(parent: &Path, name: &str, venue: Venue) -> Result<PathBuf, String> {
    let (root, name) = prepare_project_skeleton(parent, name)?;
    write_manifest(&root, &default_manifest_with_venue(name, venue))?;
    fs::write(root.join(".research/brief.md"), default_brief(name)).map_err(err)?;
    let title = latex_title(name);
    for (relative, body) in venue.template() {
        fs::write(root.join(relative), body.replace("LATTICE_PROJECT_TITLE", &title))
            .map_err(err)?;
    }
    fs::write(root.join("references.bib"), "").map_err(err)?;
    Ok(root)
}

/// Empty workspace for joining a live share — no conference template files.
/// Guests keep their own projects untouched; shared files materialize here.
pub fn create_blank(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let (root, name) = prepare_project_skeleton(parent, name)?;
    let mut manifest = default_manifest_with_venue(name, Venue::Neurips);
    manifest.venue = "shared".to_string();
    write_manifest(&root, &manifest)?;
    fs::write(
        root.join(".research/brief.md"),
        format!("# {name}\n\nLive collaboration workspace. Your other local projects were not modified.\n"),
    )
    .map_err(err)?;
    // The body must not be empty: pdflatex writes no PDF for a document with
    // no pages, latexmk records that failure in main.fdb_latexmk, and since
    // the placeholder never changes every later build replays it as up to
    // date — a build the guest cannot escape while the real files arrive.
    fs::write(
        root.join("main.tex"),
        "% Waiting for shared project files…\n\\documentclass{article}\n\\begin{document}\nWaiting for the shared project files to arrive…\n\\end{document}\n",
    )
    .map_err(err)?;
    fs::write(root.join("references.bib"), "").map_err(err)?;
    Ok(root)
}

/// Check `name` and lay out `parent/name`'s folders and ignore files.
/// Returns the new root and the trimmed name.
fn prepare_project_skeleton<'a>(
    parent: &Path, name: &'a str,
) -> Result<(PathBuf, &'a str), String> {
    let name = name.trim();
    if !is_plain_segment(name) {
        return Err("Choose a simple project name without path separators.".to_string());
    }
    let root = parent.join(name);
    create_skeleton(&root)?;
    Ok((root, name))
}

fn create_skeleton(root: &Path) -> Result<(), String> {
    if root.exists() && fs::read_dir(root).map_err(err)?.next().is_some() {
        return Err("That folder already exists and is not empty.".to_string());
    }
    for directory in [
        ".research/papers",
        ".research/history",
        ".research/sessions",
        ".research/licenses",
        "figures",
    ] {
        fs::create_dir_all(root.join(directory)).map_err(err)?;
    }
    fs::write(root.join(".research/.gitignore"), RESEARCH_GITIGNORE).map_err(err)?;
    let ignore = [
        ".research/history/",
        ".research/sessions/",
        ".research/checkpoints/",
        ".research/cache/",
        "/main.pdf",
    ]
    .into_iter()
    .map(str::to_string)
    .chain(build_artifact_ignore_lines())
    .map(|line| format!("{line}\n"))
    .collect::<String>();
    fs::write(root.join(".gitignore"), ignore).map_err(err)
}

/// Recreate the stable sample project used by the in-app tutorial.
/// The managed tutorial is disposable: every launch starts from the bundled baseline.
pub fn create_tutorial(parent: &Path) -> Result<PathBuf, String> {
    let root = parent.join(TUTORIAL_PROJECT_NAME);
    if root.exists() {
        let managed = fs::read(root.join(".research/tutorial.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|marker| marker["id"] == "understanding-attention");
        if !managed {
            return Err(format!(
                "A folder named “{TUTORIAL_PROJECT_NAME}” already exists in Lattice Tutorials. Move it, then try again."
            ));
        }
        fs::remove_dir_all(&root).map_err(err)?;
    }

    create_skeleton(&root)?;
    let mut manifest = default_manifest(TUTORIAL_PROJECT_NAME);
    manifest.venue = "tutorial".to_string();
    manifest.word_budget = None;
    manifest.page_budget = None;
    write_manifest(&root, &manifest)?;
    fs::create_dir_all(root.join("slides/understanding-attention")).map_err(err)?;
    let style = NEURIPS_2026_STYLE.replacen(
        "\\ProvidesPackage{neurips_2026}",
        "\\ProvidesPackage{neurips}",
        1,
    );
    let marker = "{\n  \"id\": \"understanding-attention\",\n  \"version\": 9\n}\n";
    for (relative, contents) in [(".research/brief.md", TUTORIAL_BRIEF.as_bytes())]
        .into_iter()
        .chain([(".research/tutorial.json", marker.as_bytes())])
        .chain(TUTORIAL_FILES.iter().copied())
        .chain([("neurips.sty", style.as_bytes())])
    {
        fs::write(root.join(relative), contents).map_err(err)?;
    }
    Ok(root)
}

fn latex_title(name: &str) -> String {
    let ascii = name.chars().filter(char::is_ascii).collect::<String>();
    let title = match ascii.trim() {
        "" => "Untitled research",
        value => value,
    };
    title
        .chars()
        .map(|character| match character {
            '\\' => "\\textbackslash{}".to_string(),
            '{' | '}' | '$' | '&' | '#' | '_' | '%' => format!("\\{character}"),
            '~' | '^' => format!("\\{character}{{}}"),
            _ => character.to_string(),
        })
        .collect()
}

pub(super) fn default_brief(name: &str) -> String {
    format!(
        "# {name}\n\n## Research question\n\nDescribe the central question.\n\n## Thesis\n\nState the current thesis.\n\n## Constraints\n\n- Write in English.\n- Ground factual claims in project evidence.\n\n## Open decisions\n\n- Add the first research decision.\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::manifest::read_manifest;
    use crate::project::test_support::Fixture;

    fn read(root: &Path, relative: &str) -> String {
        fs::read_to_string(root.join(relative)).unwrap()
    }

    #[test]
    fn tutorial_project_is_complete_and_resets_on_reopen() {
        let parent = Fixture::empty("tutorial-project");
        let root = create_tutorial(&parent.root).unwrap();
        for (relative, contents) in TUTORIAL_FILES {
            assert_eq!(fs::read(root.join(relative)).unwrap(), *contents, "{relative}");
        }
        assert!(root.join("neurips.sty").is_file());
        let presentation = read(&root, "slides/understanding-attention/index.tsx");
        assert!(presentation.contains("export default [Cover, AttentionFlow]"));
        assert!(presentation.contains("katex.renderToString"));
        assert!(!presentation.contains("EditingPaths"));
        let json = |relative: &str| {
            serde_json::from_str::<serde_json::Value>(&read(&root, relative)).unwrap()
        };
        let spreadsheet = json("attention-results.lattice-sheet");
        assert_eq!(spreadsheet["format"], "lattice-spreadsheet");
        assert_eq!(spreadsheet["version"], 1);
        let results = &spreadsheet["workbook"]["sheets"]["results"];
        assert_eq!(
            (results["rowCount"].as_i64(), results["columnCount"].as_i64()),
            (Some(1000), Some(52))
        );
        assert_eq!(results["cellData"]["7"]["2"]["f"], "=AVERAGE(C3:C6)");
        let board = json("attention-map.tldr");
        assert_eq!(board["tldrawFileFormatVersion"], 1);
        let board_records = board["records"].as_array().unwrap();
        assert!(board_records.len() >= 18);
        for id in ["shape:query", "shape:context"] {
            assert!(board_records.iter().any(|record| record["id"] == id), "{id}");
        }
        assert_eq!(json(".research/tutorial.json")["version"], 9);
        assert_eq!(read_manifest(&root).unwrap().venue, "tutorial");
        assert!(read(&root, "main.tex").contains("\\usepackage[preprint]{neurips}"));
        assert_eq!(read(&root, "references.bib").matches("@").count(), 9);
        assert!(fs::read(root.join("figures/attention-figure-2.pdf"))
            .unwrap()
            .starts_with(b"%PDF-1.3"));

        let notes = read(&root, "notes.md");
        fs::write(root.join("notes.md"), "learner edit\n").unwrap();
        fs::write(root.join("learner-file.txt"), "temporary\n").unwrap();
        assert_eq!(create_tutorial(&parent.root).unwrap(), root);
        assert_eq!(read(&root, "notes.md"), notes);
        assert!(!root.join("learner-file.txt").exists());

        // A folder of the same name that Lattice does not manage is never deleted.
        fs::write(root.join(".research/tutorial.json"), "{\"id\":\"someone-else\"}").unwrap();
        fs::write(root.join("keep.txt"), "keep\n").unwrap();
        assert!(create_tutorial(&parent.root).is_err());
        assert_eq!(read(&root, "keep.txt"), "keep\n");
    }

    #[test]
    fn blank_collab_workspace_has_no_venue_template() {
        let parent = Fixture::empty("collab-blank");
        let root = create_blank(&parent.root, "share-LT-ABC123").unwrap();
        assert_eq!(read_manifest(&root).unwrap().venue, "shared");
        // The placeholder has to typeset to something (see `create_blank`).
        let placeholder = read(&root, "main.tex");
        let body = placeholder
            .split_once("\\begin{document}")
            .and_then(|(_, rest)| rest.split_once("\\end{document}"))
            .map(|(body, _)| body.trim().to_string())
            .unwrap_or_default();
        assert!(!body.is_empty(), "placeholder must typeset at least one page: {placeholder:?}");
        for style in ["neurips.sty", "neurips_2026.sty", "icml2026.sty", "iclr2026_conference.sty"]
        {
            assert!(!root.join(style).exists(), "{style}");
        }
    }

    #[test]
    fn new_projects_use_the_bundled_venue_templates_with_safe_titles() {
        assert_eq!(latex_title("R&D_100%"), "R\\&D\\_100\\%");
        assert_eq!(latex_title("科研"), "Untitled research");
        let parent = Fixture::empty("venue-templates");
        let neurips = create(&parent.root, "Elegant paper").unwrap();
        let source = read(&neurips, "main.tex");
        for expected in [
            "\\documentclass{article}",
            "\\usepackage[preprint]{neurips_2026}",
            "\\bibliographystyle{plainnat}",
        ] {
            assert!(source.contains(expected), "{expected}");
        }
        assert!(!source.contains("Formatting Instructions For NeurIPS 2026"));
        for absent in
            ["neurips.sty", "arxiv.sty", ".research/omp-sessions", ".research/omp-session-map"]
        {
            assert!(!neurips.join(absent).exists(), "{absent}");
        }
        assert!(!read(&neurips, ".gitignore").contains("omp-"));
        assert!(!read(&neurips, ".research/.gitignore").contains("omp-"));

        for (venue, name, usepackage) in [
            (Venue::Neurips, "neurips-paper", "\\usepackage[preprint]{neurips_2026}"),
            (Venue::Icml, "icml-paper", "\\usepackage[preprint]{icml2026}"),
            (Venue::Iclr, "iclr-paper", "\\usepackage{iclr2026_conference,times}"),
        ] {
            let root = create_with_venue(&parent.root, name, venue).unwrap();
            assert_eq!(read_manifest(&root).unwrap().venue, venue.as_str());
            assert!(read(&root, "main.tex").contains(usepackage), "{name}");
            for (file, contents) in &venue.template()[1..] {
                assert_eq!(read(&root, file), *contents, "{file}");
            }
            let own = |file: &str| venue.template().iter().any(|(template, _)| *template == file);
            for style in
                ["neurips.sty", "neurips_2026.sty", "icml2026.sty", "iclr2026_conference.sty"]
            {
                assert_eq!(root.join(style).exists(), own(style), "{name}: {style}");
            }
        }
    }
}
