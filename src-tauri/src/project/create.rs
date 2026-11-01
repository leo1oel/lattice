//! New projects: conference templates and the disposable tutorial.

use super::manifest::{write_manifest, MANIFEST_SCHEMA_VERSION};
use super::paths::is_plain_segment;
use super::tree::build_artifact_ignore_lines;
use crate::models::{ProjectManifest, RootDocument};
use crate::util::err;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(super) const RESEARCH_GITIGNORE: &str = "history/\nsessions/\ncheckpoints/\ncache/\n";

const NEURIPS_2026_STYLE: &str = include_str!("../../templates/neurips-2026/neurips_2026.sty");

/// A venue's bundled files, written at the same paths they have under
/// `templates/<dir>`: its `main.tex` (titled on creation) first, then the
/// style files, bibliography styles and cover artwork beside it.
macro_rules! venue_template {
    ($dir:literal: $($path:literal),+ $(,)?) => {
        &[$(($path, include_bytes!(concat!("../../templates/", $dir, "/", $path)))),+]
    };
}

type TemplateFiles = &'static [(&'static str, &'static [u8])];

const NEURIPS_TEMPLATE: TemplateFiles =
    venue_template!("neurips-2026": "main.tex", "neurips_2026.sty");
const ICML_TEMPLATE: TemplateFiles =
    venue_template!("icml-2026": "main.tex", "icml2026.sty", "icml2026.bst");
const ICLR_TEMPLATE: TemplateFiles = venue_template!("iclr-2026":
    "main.tex", "iclr2026_conference.sty", "iclr2026_conference.bst");
const ACL_TEMPLATE: TemplateFiles = venue_template!("acl": "main.tex", "acl.sty", "acl_natbib.bst");
const CVPR_TEMPLATE: TemplateFiles =
    venue_template!("cvpr-2027": "main.tex", "cvpr.sty", "ieeenat_fullname.bst");
const AAAI_TEMPLATE: TemplateFiles =
    venue_template!("aaai-2027": "main.tex", "aaai2027.sty", "aaai2027.bst");
// The classes draw their covers from these PDFs at fixed paths.
const THUTHESIS_TEMPLATE: TemplateFiles = venue_template!("thuthesis":
    "main.tex",
    "thuthesis.cls",
    "thuthesis-numeric.bst",
    "thuthesis-author-year.bst",
    "thu-fig-logo.pdf",
    "thu-text-logo.pdf",
);
const USTCTHESIS_TEMPLATE: TemplateFiles = venue_template!("ustcthesis":
    "main.tex",
    "ustcthesis.cls",
    "ustcthesis-numeric.bst",
    "ustcthesis-authoryear.bst",
    "figures/ustc-logo.pdf",
    "figures/ustc-name.pdf",
    "figures/ustc-name-stxingkai.pdf",
    "figures/ustc-title-page-heading.pdf",
);

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
    Acl,
    Cvpr,
    Aaai,
    Thuthesis,
    Ustcthesis,
    Blank,
    /// A blank `ctexart` article: Chinese text, headings, dates and numbering.
    ChineseArticle,
}

impl Venue {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "neurips" | "nips" => Ok(Self::Neurips),
            "icml" => Ok(Self::Icml),
            "iclr" => Ok(Self::Iclr),
            "acl" | "arr" => Ok(Self::Acl),
            "cvpr" => Ok(Self::Cvpr),
            "aaai" => Ok(Self::Aaai),
            "thuthesis" => Ok(Self::Thuthesis),
            "ustcthesis" => Ok(Self::Ustcthesis),
            "blank" => Ok(Self::Blank),
            "chinese-article" | "ctexart" => Ok(Self::ChineseArticle),
            other => Err(format!(
                "Unknown venue “{other}”. Choose neurips, icml, iclr, acl, cvpr, aaai, thuthesis, ustcthesis, blank, or chinese-article."
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Neurips => "neurips",
            Self::Icml => "icml",
            Self::Iclr => "iclr",
            Self::Acl => "acl",
            Self::Cvpr => "cvpr",
            Self::Aaai => "aaai",
            Self::Thuthesis => "thuthesis",
            Self::Ustcthesis => "ustcthesis",
            Self::Blank => "blank",
            Self::ChineseArticle => "chinese-article",
        }
    }

    /// The main-text page limit the venue's call for papers sets (ACL's is the
    /// long-paper one). None of them limits words, so a new project has no
    /// word budget until the writer sets one; a thesis has neither.
    fn page_budget(self) -> Option<u32> {
        match self {
            Self::Neurips | Self::Iclr => Some(9),
            Self::Icml | Self::Acl | Self::Cvpr => Some(8),
            Self::Aaai => Some(7),
            Self::Thuthesis | Self::Ustcthesis | Self::Blank | Self::ChineseArticle => None,
        }
    }

    /// The engine a new project builds with. The conference styles are written
    /// for pdfLaTeX (and arXiv compiles submissions with it), so they keep it;
    /// AAAI's refuses any other. The Chinese thesis classes require XeLaTeX. A
    /// blank article has no such constraint and gets LuaLaTeX: Unicode source
    /// without inputenc/fontenc, and the rtex live preview, which only runs on
    /// LuaLaTeX. Only new projects: an existing project keeps its manifest.
    /// ctex builds with either Unicode engine, but under LuaLaTeX it loads
    /// luatexja, which takes several times as long, so the Chinese article
    /// gets XeLaTeX and gives up the live preview.
    fn engine(self) -> &'static str {
        match self {
            Self::Neurips | Self::Icml | Self::Iclr | Self::Acl | Self::Cvpr | Self::Aaai => "pdf",
            Self::Thuthesis | Self::Ustcthesis | Self::ChineseArticle => "xelatex",
            Self::Blank => "lualatex",
        }
    }

    /// Whether the class loads CJK fonts, so the title can keep every
    /// character of the project name.
    fn loads_cjk_fonts(self) -> bool {
        matches!(self, Self::Thuthesis | Self::Ustcthesis | Self::ChineseArticle)
    }

    fn template(self) -> TemplateFiles {
        match self {
            Self::Neurips => NEURIPS_TEMPLATE,
            Self::Icml => ICML_TEMPLATE,
            Self::Iclr => ICLR_TEMPLATE,
            Self::Acl => ACL_TEMPLATE,
            Self::Cvpr => CVPR_TEMPLATE,
            Self::Aaai => AAAI_TEMPLATE,
            Self::Thuthesis => THUTHESIS_TEMPLATE,
            Self::Ustcthesis => USTCTHESIS_TEMPLATE,
            Self::Blank => &[("main.tex", b"\\documentclass{article}\n\\begin{document}\n\\title{LATTICE_PROJECT_TITLE}\n\\maketitle\n\n\\end{document}\n")],
            Self::ChineseArticle => &[("main.tex", b"\\documentclass{ctexart}\n\\begin{document}\n\\title{LATTICE_PROJECT_TITLE}\n\\maketitle\n\n\\end{document}\n")],
        }
    }
}

pub fn default_manifest(name: &str) -> ProjectManifest {
    default_manifest_with_venue(name, Venue::Neurips)
}

fn default_manifest_with_venue(name: &str, venue: Venue) -> ProjectManifest {
    ProjectManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        project_id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        root_documents: vec![RootDocument {
            path: "main.tex".to_string(),
            name: "Main paper".to_string(),
            is_default: true,
        }],
        primary_bibliography: "references.bib".to_string(),
        trusted: false,
        engine: venue.engine().to_string(),
        keep_engine: false,
        stop_on_first_error: false,
        venue: venue.as_str().to_string(),
        word_budget: None,
        page_budget: venue.page_budget(),
        deadline: None,
        spelling_words: Vec::new(),
        grammar_ignored_rules: Vec::new(),
        grammar_ignored_sentences: Vec::new(),
        submission_items: Vec::new(),
        unread: serde_json::Map::new(),
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
    // A thesis class also takes English theses; the Chinese article is for Chinese.
    let language = if venue == Venue::ChineseArticle { "Chinese" } else { "English" };
    fs::write(root.join(".research/brief.md"), brief_in(name, language)).map_err(err)?;
    let title = latex_title(name, venue.loads_cjk_fonts());
    for (relative, contents) in venue.template() {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        if *relative == "main.tex" {
            let body = std::str::from_utf8(contents).map_err(err)?;
            fs::write(path, body.replace("LATTICE_PROJECT_TITLE", &title)).map_err(err)?;
        } else {
            fs::write(path, contents).map_err(err)?;
        }
    }
    fs::write(root.join("references.bib"), "").map_err(err)?;
    Ok(root)
}

/// A project holding only a one-page `main.tex` and an empty bibliography, so
/// a test has no venue template files to account for.
#[cfg(test)]
pub fn create_blank(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let (root, name) = prepare_project_skeleton(parent, name)?;
    write_manifest(&root, &default_manifest(name))?;
    fs::write(root.join(".research/brief.md"), default_brief(name)).map_err(err)?;
    let main = "\\documentclass{article}\n\\begin{document}\nBlank.\n\\end{document}\n";
    fs::write(root.join("main.tex"), main).map_err(err)?;
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

/// `name` as LaTeX title text. Only the Chinese classes (the theses and
/// `ctexart`) load fonts for every character a project name may hold, so they
/// keep all of it; the other templates keep its ASCII characters.
fn latex_title(name: &str, any_script: bool) -> String {
    let kept =
        name.chars().filter(|character| any_script || character.is_ascii()).collect::<String>();
    let title = match kept.trim() {
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
    brief_in(name, "English")
}

/// The research brief the agent reads, asking for text in `language`.
fn brief_in(name: &str, language: &str) -> String {
    format!(
        "# {name}\n\n## Research question\n\nDescribe the central question.\n\n## Thesis\n\nState the current thesis.\n\n## Constraints\n\n- Write in {language}.\n- Ground factual claims in project evidence.\n\n## Open decisions\n\n- Add the first research decision.\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::manifest::read_manifest;
    use crate::project::test_support::Fixture;

    const VENUE_STYLES: [&str; 9] = [
        "neurips.sty",
        "neurips_2026.sty",
        "icml2026.sty",
        "iclr2026_conference.sty",
        "acl.sty",
        "cvpr.sty",
        "aaai2027.sty",
        "thuthesis.cls",
        "ustcthesis.cls",
    ];

    const ALL_VENUES: [Venue; 10] = [
        Venue::Neurips,
        Venue::Icml,
        Venue::Iclr,
        Venue::Acl,
        Venue::Cvpr,
        Venue::Aaai,
        Venue::Thuthesis,
        Venue::Ustcthesis,
        Venue::Blank,
        Venue::ChineseArticle,
    ];

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
    fn new_projects_use_the_bundled_venue_templates_with_safe_titles() {
        assert_eq!(latex_title("R&D_100%", false), "R\\&D\\_100\\%");
        assert_eq!(latex_title("科研", false), "Untitled research");
        assert_eq!(latex_title("科研 R&D", true), "科研 R\\&D");
        let parent = Fixture::empty("venue-templates");
        for (venue, name, engine, loads, budget) in [
            (Venue::Neurips, "neurips-paper", "pdf", "[preprint]{neurips_2026}", Some(9)),
            (Venue::Icml, "icml-paper", "pdf", "[preprint]{icml2026}", Some(8)),
            (Venue::Iclr, "iclr-paper", "pdf", "{iclr2026_conference,times}", Some(9)),
            (Venue::Acl, "acl-paper", "pdf", "[preprint]{acl}", Some(8)),
            (Venue::Cvpr, "cvpr-paper", "pdf", "package{cvpr}", Some(8)),
            (Venue::Aaai, "aaai-paper", "pdf", "[preprint]{aaai2027}", Some(7)),
            // The thesis classes require XeLaTeX.
            (Venue::Thuthesis, "thu-thesis", "xelatex", "[degree=master]{thuthesis}", None),
            (Venue::Ustcthesis, "ustc-thesis", "xelatex", "[degree=master]{ustcthesis}", None),
        ] {
            let root = create_with_venue(&parent.root, name, venue).unwrap();
            let manifest = read_manifest(&root).unwrap();
            assert_eq!(Venue::parse(&manifest.venue), Ok(venue));
            assert_eq!(manifest.engine, engine, "{name}");
            assert_eq!(manifest.page_budget, budget, "{name}");
            let main = read(&root, "main.tex");
            assert!(main.contains(loads), "{name}");
            assert!(main.contains(name) && !main.contains("LATTICE_PROJECT_TITLE"), "{name}");
            // Style files and cover artwork are copied byte for byte.
            assert_eq!(venue.template()[0].0, "main.tex");
            for (file, contents) in &venue.template()[1..] {
                assert_eq!(fs::read(root.join(file)).unwrap(), *contents, "{file}");
            }
            let own = |file: &str| venue.template().iter().any(|(template, _)| *template == file);
            for style in VENUE_STYLES {
                assert_eq!(root.join(style).exists(), own(style), "{name}: {style}");
            }
        }
        let chinese = create_with_venue(&parent.root, "清华论文", Venue::Thuthesis).unwrap();
        assert!(read(&chinese, "main.tex").contains("title  = {清华论文},"));
        for venue in ALL_VENUES {
            assert_eq!(Venue::parse(venue.as_str()), Ok(venue));
        }
        assert_eq!(Venue::parse("ARR"), Ok(Venue::Acl));

        // The default is NeurIPS, without the template's instructions or any
        // legacy agent state.
        let neurips = create(&parent.root, "Elegant paper").unwrap();
        assert_eq!(read_manifest(&neurips).unwrap().venue, Venue::Neurips.as_str());
        let source = read(&neurips, "main.tex");
        for expected in ["\\documentclass{article}", "\\bibliographystyle{plainnat}"] {
            assert!(source.contains(expected), "{expected}");
        }
        assert!(!source.contains("Formatting Instructions For NeurIPS 2026"));
        for absent in ["arxiv.sty", ".research/omp-sessions", ".research/omp-session-map"] {
            assert!(!neurips.join(absent).exists(), "{absent}");
        }
        for ignore in [".gitignore", ".research/.gitignore"] {
            assert!(!read(&neurips, ignore).contains("omp-"), "{ignore}");
        }
    }

    /// Builds every bundled template the way the app does. Needs latexmk and
    /// the packages `tex_setup/basictex.sh` installs: Lattice's base set plus
    /// newtx, kastrup, ctex, xecjk, zhnumber, bibunits, xits and stix2-otf.
    #[test]
    #[ignore = "requires latexmk, pdfLaTeX, XeLaTeX and the template packages basictex.sh installs"]
    fn every_bundled_template_builds_a_pdf() {
        use crate::latex::{build, read_compiled_pdf, ActiveBuild, BuildSteps};
        let parent = Fixture::empty("template-builds");
        for venue in ALL_VENUES {
            let root = create_with_venue(&parent.root, venue.as_str(), venue).unwrap();
            let result =
                build(&root, false, &ActiveBuild::default(), None, &BuildSteps::silent()).unwrap();
            assert!(result.success, "{}: {}", venue.as_str(), result.log);
            assert!(read_compiled_pdf(&root).unwrap().starts_with(b"%PDF-"), "{}", venue.as_str());
            if venue.engine() == "xelatex" {
                let log = fs::read_to_string(root.join("main.log")).unwrap();
                assert!(!log.contains("Missing character"), "{}: {log}", venue.as_str());
            }
        }
    }

    #[test]
    fn the_chinese_article_keeps_its_chinese_title_and_builds_with_xelatex() {
        let parent = Fixture::empty("chinese-article");
        assert_eq!(Venue::parse("ctexart"), Ok(Venue::ChineseArticle));
        let root = create_with_venue(&parent.root, "我的论文", Venue::ChineseArticle).unwrap();
        let manifest = read_manifest(&root).unwrap();
        assert_eq!(
            (manifest.venue.as_str(), manifest.engine.as_str(), manifest.page_budget),
            ("chinese-article", "xelatex", None)
        );
        let source = read(&root, "main.tex");
        assert!(source.starts_with("\\documentclass{ctexart}\n"), "{source}");
        assert!(source.contains("\\title{我的论文}"), "{source}");
        assert!(read(&root, ".research/brief.md").contains("- Write in Chinese."));

        // The plain blank article still has no CJK fonts, so its title stays ASCII.
        let blank = create_with_venue(&parent.root, "空白", Venue::Blank).unwrap();
        assert!(read(&blank, "main.tex").contains("\\title{Untitled research}"));
        assert!(read(&blank, ".research/brief.md").contains("- Write in English."));
    }
}
