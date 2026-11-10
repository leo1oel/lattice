use super::*;
use crate::project::manifest::read_manifest;
use crate::project::test_support::Fixture;

const VENUE_STYLES: [&str; 10] = [
    "neurips.sty",
    "neurips_2026.sty",
    "icml2026.sty",
    "iclr2026_conference.sty",
    "acl.sty",
    "cvpr.sty",
    "aaai2027.sty",
    "IEEEtran.cls",
    "thuthesis.cls",
    "ustcthesis.cls",
];

const ALL_VENUES: [Venue; 14] = [
    Venue::Neurips,
    Venue::Icml,
    Venue::Iclr,
    Venue::Acl,
    Venue::Cvpr,
    Venue::CvprRebuttal,
    Venue::Aaai,
    Venue::IeeeConference,
    Venue::IeeeJournal,
    Venue::Acm,
    Venue::Thuthesis,
    Venue::Ustcthesis,
    Venue::Blank,
    Venue::ChineseArticle,
];

fn read(root: &Path, relative: &str) -> String {
    fs::read_to_string(root.join(relative)).unwrap()
}

#[test]
fn tutorial_project_is_complete_and_kept_until_another_build_replaces_it() {
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
    let json =
        |relative: &str| serde_json::from_str::<serde_json::Value>(&read(&root, relative)).unwrap();
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

    // Opened again, the writer's copy is kept as they left it.
    let notes = read(&root, "notes.md");
    fs::write(root.join("notes.md"), "learner edit\n").unwrap();
    fs::write(root.join("learner-file.txt"), "kept\n").unwrap();
    assert_eq!(create_tutorial(&parent.root).unwrap(), root);
    assert_eq!(read(&root, "notes.md"), "learner edit\n");
    assert_eq!(read(&root, "learner-file.txt"), "kept\n");

    // Another build's copy is made again from this build's sample.
    fs::write(
        root.join(".research/tutorial.json"),
        "{\"id\":\"understanding-attention\",\"version\":8}",
    )
    .unwrap();
    assert_eq!(create_tutorial(&parent.root).unwrap(), root);
    assert_eq!(read(&root, "notes.md"), notes);
    assert!(!root.join("learner-file.txt").exists());
    assert_eq!(json(".research/tutorial.json")["version"], 9);

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
        (Venue::IeeeConference, "ieee-paper", "pdf", "[conference]{IEEEtran}", None),
        (Venue::IeeeJournal, "ieee-article", "pdf", "[journal]{IEEEtran}", None),
        (Venue::Acm, "acm-paper", "pdf", "[sigconf]{acmart}", None),
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
    assert_eq!(Venue::parse("IEEE"), Ok(Venue::IeeeConference));
    assert_eq!(Venue::parse("acmart"), Ok(Venue::Acm));

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
/// newtx, kastrup, acmart, libertine, inconsolata, ctex, xecjk, zhnumber,
/// bibunits, xits and stix2-otf.
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
fn the_cvpr_rebuttal_is_the_author_kits_response_template_unmodified() {
    let parent = Fixture::empty("cvpr-rebuttal");
    let root = create_with_venue(&parent.root, "cvpr-response", Venue::CvprRebuttal).unwrap();
    let manifest = read_manifest(&root).unwrap();
    assert_eq!(Venue::parse(&manifest.venue), Ok(Venue::CvprRebuttal));
    assert_eq!(
        (manifest.engine.as_str(), manifest.page_budget, manifest.primary_bibliography.as_str()),
        ("pdf", Some(1), "main.bib")
    );
    // Every file, main.tex included, is the author kit's byte for byte:
    // the response keeps the kit's title and its \bibliography{main}.
    for (file, contents) in CVPR_REBUTTAL_TEMPLATE {
        assert_eq!(fs::read(root.join(file)).unwrap(), *contents, "{file}");
    }
    let main = read(&root, "main.tex");
    for expected in ["\\usepackage[rebuttal]{cvpr}", "\\input{preamble}", "\\bibliography{main}"] {
        assert!(main.contains(expected), "{expected}");
    }
    assert_eq!(read(&root, "main.bib"), "");
    assert!(!root.join("references.bib").exists());
    // The paper and the response ship the same release's style files.
    for file in ["cvpr.sty", "ieeenat_fullname.bst"] {
        let style =
            |template: TemplateFiles| template.iter().find(|(path, _)| *path == file).unwrap().1;
        assert_eq!(style(CVPR_REBUTTAL_TEMPLATE), style(CVPR_TEMPLATE), "{file}");
    }
}

#[test]
fn the_ieee_and_acm_templates_start_with_a_sample_bibliography_in_their_style() {
    let parent = Fixture::empty("ieee-acm");
    for (venue, style, cites) in [
        (Venue::IeeeConference, "IEEEtran", "shell2015ieeetran"),
        (Venue::IeeeJournal, "IEEEtran", "shell2015ieeetran"),
        (Venue::Acm, "ACM-Reference-Format", "acmart"),
    ] {
        let root = create_with_venue(&parent.root, venue.as_str(), venue).unwrap();
        assert_eq!(read_manifest(&root).unwrap().primary_bibliography, "references.bib");
        // The sample is kept, not replaced by an empty bibliography.
        let bibliography = read(&root, "references.bib");
        assert!(bibliography.contains(&format!("{{{cites},")), "{bibliography}");
        let main = read(&root, "main.tex");
        for expected in [
            format!("\\bibliographystyle{{{style}}}"),
            "\\bibliography{references}".to_string(),
            format!("\\cite{{{cites},kopka2004guide}}"),
        ] {
            assert!(main.contains(&expected), "{}: {expected}", venue.as_str());
        }
    }
    // The two IEEE templates bundle the same IEEEtran release.
    let file = |template: TemplateFiles, name: &str| {
        template.iter().find(|(path, _)| *path == name).unwrap().1
    };
    for name in ["IEEEtran.cls", "IEEEtran.bst", "references.bib"] {
        assert_eq!(
            file(IEEE_CONFERENCE_TEMPLATE, name),
            file(IEEE_JOURNAL_TEMPLATE, name),
            "{name}"
        );
    }
    // acmart comes from TeX Live, so the ACM project holds no class file.
    assert!(!ACM_TEMPLATE.iter().any(|(path, _)| path.ends_with(".cls")));
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
