//! A document written for pdfLaTeX, built with XeLaTeX or LuaLaTeX.
//!
//! arXiv templates open with `\pdfoutput=1`, a pdfTeX primitive the other two
//! engines do not have, so the build stops on line 1 with TeX's bare
//! "Undefined control sequence". The log names the primitive; this module
//! turns that into advice the interface can act on, and decides when the
//! switch to pdfLaTeX is safe to make without asking.

use super::build_log::{advice, normalize_log_path};
use crate::latex::BuildResult;
use crate::models::{Diagnostic, ProjectManifest};
use crate::project;
use regex::Regex;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

/// pdfTeX primitives that XeLaTeX or LuaLaTeX leave undefined: measured on
/// TeX Live 2026, each passes `\ifdefined` under pdfLaTeX and fails under at
/// least one of the others, before `\documentclass` and after it. A list, not
/// a `\pdf` prefix, because `\pdfbookmark` and its kind are package macros
/// that are just as undefined under pdfLaTeX without their package.
const PDFTEX_ONLY: &str = "\
    ifpdfprimitive pdfadjustspacing pdfannot pdfappendkern pdfcatalog pdfcolorstack \
    pdfcolorstackinit pdfcompresslevel pdfcopyfont pdfcreationdate pdfdecimaldigits \
    pdfdest pdfdestmargin pdfdraftmode pdfeachlinedepth pdfeachlineheight pdfelapsedtime \
    pdfendlink pdfendthread pdfescapehex pdfescapename pdfescapestring pdffakespace \
    pdffiledump pdffilemoddate pdffilesize pdffirstlineheight pdffontattr pdffontexpand \
    pdffontname pdffontobjnum pdffontsize pdfforcepagebox pdfgamma pdfgentounicode \
    pdfglyphtounicode pdfhorigin pdfignoreddimen pdfimageapplygamma pdfimagegamma \
    pdfimagehicolor pdfimageresolution pdfincludechars pdfinclusioncopyfonts \
    pdfinclusionerrorlevel pdfinfo pdfinfoomitdate pdfinsertht pdfinterwordspaceoff \
    pdfinterwordspaceon pdflastannot pdflastlinedepth pdflastlink pdflastmatch pdflastobj \
    pdflastxform pdflastximage pdflastxpos pdflastypos pdflinkmargin pdfliteral \
    pdfmajorversion pdfmapfile pdfmapline pdfmatch pdfmdfivesum pdfminorversion \
    pdfmovechars pdfnames pdfnobuiltintounicode pdfnoligatures pdfnormaldeviate pdfobj \
    pdfobjcompresslevel pdfomitcharset pdfoutline pdfoutput pdfpageattr pdfpagebox \
    pdfpageheight pdfpageref pdfpageresources pdfpagesattr pdfpagewidth pdfpkmode \
    pdfpkresolution pdfprependkern pdfprimitive pdfprotrudechars pdfrandomseed pdfrefobj \
    pdfrefxform pdfrefximage pdfresettimer pdfrestore pdfretval pdfrunninglinkoff \
    pdfrunninglinkon pdfsave pdfsavepos pdfsetmatrix pdfsetrandomseed pdfshellescape \
    pdfsnaprefpoint pdfsnapy pdfsnapycomp pdfspacefont pdfstartlink pdfstartthread \
    pdfstrcmp pdfsuppressptexinfo pdfsuppresswarningdupdest pdfsuppresswarningdupmap \
    pdfsuppresswarningpagegroup pdftexbanner pdftexrevision pdftexversion pdfthread \
    pdfthreadmargin pdftracingfonts pdftrailer pdftrailerid pdfunescapehex \
    pdfuniformdeviate pdfuniqueresname pdfvorigin pdfxform pdfxformname pdfximage \
    pdfximagebbox";

/// Packages that only load, or only do their job, under XeLaTeX or LuaLaTeX.
/// Names starting with `xe`, `lua` or `ctex` count too (xeCJK, luacode,
/// luatexja, ctex, …).
const UNICODE_ENGINE_PACKAGES: [&str; 9] = [
    "bidi",
    "emoji",
    "fontsetup",
    "fontspec",
    "mathspec",
    "polyglossia",
    "unicode-math",
    "xltxtra",
    "xunicode",
];

const PDFTEX_ONLY_CODE: &str = "pdftex-only-command";

/// Explain the build's "Undefined control sequence" when XeTeX or LuaTeX
/// raised it on a pdfTeX primitive. `log` is the last typeset pass. TeX ends
/// the first context line after the error on the control sequence it could
/// not run (`l.1 \pdfoutput`, or a macro's expansion when the primitive sits
/// inside one), so that is the name looked up.
pub(super) fn explain_pdftex_only_commands(log: &str, diagnostics: &mut [Diagnostic]) {
    let engine = if log.contains("This is XeTeX") {
        "XeLaTeX"
    } else if log.contains("This is LuaTeX") || log.contains("This is LuaHBTeX") {
        "LuaLaTeX"
    } else {
        return;
    };
    let undefined = Regex::new(
        r"(?m)^([^\n:]+\.(?:tex|sty|cls)):(\d+): Undefined control sequence\.\n([^\n]*)",
    )
    .unwrap();
    let last_command = Regex::new(r"\\([A-Za-z]+)\s*$").unwrap();
    for capture in undefined.captures_iter(log) {
        let Some(name) = last_command.captures(&capture[3]).map(|name| name[1].to_string()) else {
            continue;
        };
        if !PDFTEX_ONLY.split_ascii_whitespace().any(|primitive| primitive == name) {
            continue;
        }
        let line = capture[2].parse().ok();
        let file = normalize_log_path(&capture[1]);
        let Some(diagnostic) = diagnostics.iter_mut().find(|diagnostic| {
            diagnostic.code.is_none()
                && diagnostic.line == line
                && diagnostic.file.as_deref() == Some(file.as_str())
                && diagnostic.message == "Undefined control sequence."
        }) else {
            continue;
        };
        let command = format!("\\{name}");
        // Keeps its file and line, so clicking it still lands on the command.
        let explained = advice(
            "error",
            PDFTEX_ONLY_CODE,
            &[("command", &command), ("engine", engine)],
            format!(
                "`{command}` only works in pdfLaTeX, but this document was built with {engine}. Switch the project to pdfLaTeX to build it."
            ),
        );
        diagnostic.code = explained.code;
        diagnostic.params = explained.params;
        diagnostic.message = explained.message;
    }
}

/// A switch the build made on its own, for the note that says so and offers
/// to undo it.
pub(super) struct EngineSwitch {
    /// The manifest engine before the switch (`xelatex`, `lualatex`).
    pub(super) previous: String,
    pub(super) command: String,
}

impl EngineSwitch {
    pub(super) fn note(&self) -> Diagnostic {
        let from = engine_label(&self.previous);
        let command = &self.command;
        advice(
            "info",
            "engine-switched",
            &[("from", from), ("previous", &self.previous), ("command", command)],
            format!(
                "Switched this project from {from} to pdfLaTeX: the document uses `{command}`, which only works in pdfLaTeX, and loads nothing that needs {from}."
            ),
        )
    }
}

fn engine_label(engine: &str) -> &'static str {
    match engine {
        "xelatex" => "XeLaTeX",
        "lualatex" => "LuaLaTeX",
        _ => "pdfLaTeX",
    }
}

/// Whether a build that failed on a pdfTeX primitive should switch the
/// project to pdfLaTeX without asking. Only when nothing says the document
/// wants the engine it has: the project's own engine is XeLaTeX or LuaLaTeX
/// (a latexmkrc can choose the engine itself, so the manifest is not the
/// whole story there), the writer never undid an earlier switch, the root
/// document's `% !TEX program` names no other engine, and no TeX source in
/// the project loads a XeTeX/LuaTeX-only package or font command. Anything
/// else leaves the decision to the writer, with the one-click switch.
pub(super) fn automatic_switch(root: &Path, result: &BuildResult) -> Option<EngineSwitch> {
    if result.success {
        return None;
    }
    let command = result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == Some(PDFTEX_ONLY_CODE))?
        .params
        .get("command")?
        .clone();
    let manifest = project::read_manifest(root).ok()?;
    if !switchable(&manifest) || project::has_latexmkrc(root) {
        return None;
    }
    let root_document = project::safe_path(root, &result.root_document).ok()?;
    let program = project::tex_program_engine(&fs::read_to_string(root_document).ok()?);
    if program.is_some_and(|engine| engine != "pdf") || project_needs_unicode_engine(root) {
        return None;
    }
    Some(EngineSwitch { previous: manifest.engine, command })
}

fn switchable(manifest: &ProjectManifest) -> bool {
    matches!(manifest.engine.as_str(), "xelatex" | "lualatex") && !manifest.keep_engine
}

fn project_needs_unicode_engine(root: &Path) -> bool {
    const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
    let needs_unicode_engine = unicode_engine_detector();
    WalkDir::new(root)
        .max_depth(6)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
        })
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry.path().extension().and_then(|ext| ext.to_str()).is_some_and(|ext| {
                    matches!(ext.to_ascii_lowercase().as_str(), "tex" | "sty" | "cls" | "ltx")
                })
                && entry.metadata().is_ok_and(|metadata| metadata.len() <= MAX_SOURCE_BYTES)
        })
        .any(|entry| fs::read_to_string(entry.path()).is_ok_and(|text| needs_unicode_engine(&text)))
}

/// Whether a TeX source loads a package or uses a command that needs XeLaTeX
/// or LuaLaTeX, outside comments. Loads behind `\ifxetex` count as well: the
/// guard says the author meant the document for that engine too, which is
/// reason enough not to decide for them.
fn unicode_engine_detector() -> impl Fn(&str) -> bool {
    let packages =
        Regex::new(r"\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}").unwrap();
    let class = Regex::new(r"\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*ctex").unwrap();
    let commands = Regex::new(
        r"\\(?:setmainfont|setsansfont|setmonofont|setmathfont|newfontfamily|newfontface|setCJK[A-Za-z]*font|directlua|luaexec|XeTeX[A-Za-z]*)\b",
    )
    .unwrap();
    let unicode_package = |name: &str| {
        let name = name.trim().to_ascii_lowercase();
        UNICODE_ENGINE_PACKAGES.contains(&name.as_str())
            || ["xe", "lua", "ctex"].iter().any(|prefix| name.starts_with(prefix))
    };
    move |source| {
        let text: String = source.lines().map(|line| format!("{}\n", uncommented(line))).collect();
        packages.captures_iter(&text).any(|capture| capture[1].split(',').any(unicode_package))
            || class.is_match(&text)
            || commands.is_match(&text)
    }
}

/// `line` up to its first `%` that is not `\%`.
fn uncommented(line: &str) -> &str {
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        match character {
            '%' if !escaped => return &line[..index],
            '\\' => escaped = !escaped,
            _ => escaped = false,
        }
    }
    line
}
