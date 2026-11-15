//! The Tauri app's `definitionTargetAt` cases (`latex-symbols.test.ts`,
//! `latex-root-paths.test.ts`), in byte offsets.

use super::*;

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|path| path.to_string()).collect()
}

fn asset(path: &str) -> Option<DefinitionTarget> {
    Some(DefinitionTarget::Asset {
        path: path.to_string(),
    })
}

fn include(path: &str) -> Option<DefinitionTarget> {
    Some(DefinitionTarget::Include {
        path: path.to_string(),
    })
}

#[test]
fn labels_go_to_their_definition_and_keys_to_their_entry() {
    let source = "See \\ref{fig:model} and \\label{fig:model} plus \\citep{vaswani2017}.";
    let references = [Reference {
        label: "fig:model".into(),
        path: "chapters/model.tex".into(),
        line: 12,
        ..Reference::default()
    }];
    let reference = Some(DefinitionTarget::Reference {
        path: "chapters/model.tex".into(),
        line: 12,
        label: "fig:model".into(),
    });
    let at = |needle: &str, skip: usize| source.find(needle).unwrap() + skip;
    assert_eq!(
        definition_target_at(source, at("fig:model", 2), &references, &[], Vec::new, ""),
        reference
    );
    assert_eq!(
        definition_target_at(
            source,
            at("\\label{fig:model}", 10),
            &references,
            &[],
            Vec::new,
            ""
        ),
        reference
    );
    assert_eq!(
        definition_target_at(source, at("vaswani", 2), &references, &[], Vec::new, ""),
        Some(DefinitionTarget::Citation {
            key: "vaswani2017".into()
        })
    );
    // A label nothing defines has no target.
    assert_eq!(
        definition_target_at(source, at("fig:model", 2), &[], &[], Vec::new, ""),
        None
    );
    assert_eq!(
        definition_target_at(source, 1, &references, &[], Vec::new, ""),
        None
    );
}

#[test]
fn includes_and_figures_resolve_to_project_files() {
    let source = "\\input{sections/method}\n\\include{appendix}";
    let at = |needle: &str| source.find(needle).unwrap() + 2;
    assert_eq!(
        definition_target_at(source, at("method"), &[], &[], Vec::new, ""),
        include("sections/method.tex")
    );
    assert_eq!(
        definition_target_at(source, at("appendix"), &[], &[], Vec::new, ""),
        include("appendix.tex")
    );
    let figure = "\\includegraphics[width=\\linewidth]{figures/plot}";
    let plot = figure.find("plot").unwrap() + 1;
    assert_eq!(
        definition_target_at(
            figure,
            plot,
            &[],
            &paths(&["figures/plot.png"]),
            Vec::new,
            ""
        ),
        asset("figures/plot.png")
    );
}

#[test]
fn includes_are_read_from_the_root_documents_folder() {
    let project = paths(&[
        "arxiv-v1/main.tex",
        "arxiv-v1/sections/intro.tex",
        "paper/main.tex",
        "paper/sections/intro.tex",
        "paper/sections/method.tex",
        "common/macros.tex",
    ]);
    let main = "\\documentclass{article}\n\\input{../common/macros}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n";
    let at = main.find("sections/intro").unwrap() + 2;
    assert_eq!(
        definition_target_at(main, at, &[], &project, Vec::new, "paper/main.tex"),
        include("paper/sections/intro.tex")
    );
    let tex = |raw: &str, root: &str| resolve_project_path(raw, &project, PathKind::Tex, &[], root);
    assert_eq!(
        tex("common/macros", "paper/main.tex").as_deref(),
        Some("common/macros.tex")
    );
    assert_eq!(
        tex("method", "").as_deref(),
        Some("paper/sections/method.tex")
    );
    // Two copies end with it and neither is beside the root.
    assert_eq!(tex("sections/intro", ""), None);
    assert_eq!(tex("../common/macros", ""), None);
    assert_eq!(tex("../macros", "common/main.tex"), None);
    assert_eq!(
        normalize_project_path("paper/./sections/../../common/macros.tex").as_deref(),
        Some("common/macros.tex")
    );
    assert_eq!(normalize_project_path("paper/../../outside.tex"), None);
}

#[test]
fn figures_are_read_from_the_root_documents_folder_and_graphicspath() {
    let figures = paths(&[
        "main.tex",
        "figures/plot.png",
        "paper/main.tex",
        "paper/figures/plot.png",
        "shared/logo.pdf",
    ]);
    for (path, root, roots, file) in [
        ("./figures/plot.png", "main.tex", vec![], "figures/plot.png"),
        ("./figures/plot", "main.tex", vec![], "figures/plot.png"),
        (
            "./figures/plot",
            "paper/main.tex",
            vec![],
            "paper/figures/plot.png",
        ),
        (
            "figures/plot",
            "paper/main.tex",
            vec![],
            "paper/figures/plot.png",
        ),
        (
            "../shared/logo",
            "paper/main.tex",
            vec![],
            "shared/logo.pdf",
        ),
        (
            "plot",
            "paper/main.tex",
            vec!["./figures".to_string()],
            "paper/figures/plot.png",
        ),
        (
            "logo",
            "paper/main.tex",
            vec!["../shared".to_string()],
            "shared/logo.pdf",
        ),
    ] {
        let source = format!("\\includegraphics[width=\\linewidth]{{{path}}}");
        let at = source.find(path).unwrap() + 1;
        assert_eq!(
            definition_target_at(&source, at, &[], &figures, || roots.clone(), root),
            asset(file),
            "{path} from {root}"
        );
    }
    let source = "\\includegraphics{plot}";
    let at = source.find("plot").unwrap();
    let figs = ["figs".to_string()];
    let sources = ["\\graphicspath{{figs/}}"];
    for (list, file) in [
        (
            vec!["main.tex", "a/plot.pdf", "figs/plot.pdf", "c/plot.png"],
            "figs/plot.pdf",
        ),
        (
            vec!["main.tex", "old/plot.pdf", "figs/plot.png"],
            "figs/plot.png",
        ),
    ] {
        assert_eq!(
            definition_target_at(
                source,
                at,
                &[],
                &paths(&list),
                || graphics_roots(sources),
                "main.tex"
            ),
            asset(file)
        );
    }
    assert_eq!(
        definition_target_at(
            source,
            at,
            &[],
            &paths(&["paper/main.tex", "plot.png", "paper/figs/plot.pdf"]),
            || figs.to_vec(),
            "paper/main.tex"
        ),
        asset("paper/figs/plot.pdf")
    );
    let source = "\\includegraphics{figures/plot}";
    let at = source.find("figures").unwrap() + 1;
    let mut list = vec![
        "paper/main.tex",
        "figures/plot.png",
        "paper/figures/plot.jpg",
    ];
    assert_eq!(
        definition_target_at(source, at, &[], &paths(&list), Vec::new, "paper/main.tex"),
        asset("figures/plot.png")
    );
    list.push("paper/figures/plot.png");
    assert_eq!(
        definition_target_at(source, at, &[], &paths(&list), Vec::new, "paper/main.tex"),
        asset("paper/figures/plot.png")
    );
}

#[test]
fn graphicspath_roots_are_read_from_every_source() {
    let roots = graphics_roots([
        "\\graphicspath{{figures/}{ ./img\\\\ }}",
        "\\graphicspath{{figures}}\n\\graphicspath {{../shared/}}",
    ]);
    assert_eq!(roots, ["figures", "./img", "../shared"]);
    assert_eq!(
        unwrap_latex_path(" \\detokenize{my fig\\plot} "),
        "my fig/plot"
    );
}

#[test]
fn graphicspath_roots_are_read_only_for_a_figure() {
    let source = "\\ref{fig:model} \\input{intro} \\includegraphics{plot}";
    let references = [Reference {
        label: "fig:model".into(),
        path: "main.tex".into(),
        line: 3,
        ..Reference::default()
    }];
    let project = paths(&["main.tex", "intro.tex", "figs/plot.png"]);
    let read = std::cell::Cell::new(0);
    let roots = || {
        read.set(read.get() + 1);
        vec!["figs".to_string()]
    };
    for needle in ["fig:model", "intro"] {
        let at = source.find(needle).unwrap() + 1;
        assert!(
            definition_target_at(source, at, &references, &project, roots, "main.tex").is_some()
        );
    }
    assert_eq!(read.get(), 0);
    let at = source.find("plot").unwrap();
    assert_eq!(
        definition_target_at(source, at, &references, &project, roots, "main.tex"),
        asset("figs/plot.png")
    );
    assert_eq!(read.get(), 1);
}
