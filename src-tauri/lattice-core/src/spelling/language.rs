//! Which language a LaTeX document is written in, read from its preamble.
//!
//! The main language is what babel or polyglossia typesets the document in:
//! the last language option of `\usepackage[...]{babel}` (class options
//! count too, as babel reads them first), a `main=` option or a
//! `\babelprovide[main]`, or polyglossia's `\setdefaultlanguage` /
//! `\setmainlanguage`. The preamble is often not in the file being edited
//! (a chapter of a thesis, a `preamble.tex` the root `\input`s, a local
//! `.sty`), so the scan starts at the compile root and follows the files its
//! preamble reads, like `latex/venue.rs` does for conference templates.
//!
//! Switching language inside the body (`\selectlanguage`, `otherlanguage`)
//! is not read: the whole document is checked in its main language.

use crate::latex::strip_comment;
use crate::project;
use regex::Regex;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// Files read at most, so a cycle or a huge tree of inputs cannot stall a
/// lint pass.
const MAX_FILES: usize = 64;

/// A document's main language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentLanguage {
    /// English, or no language declared: Harper checks it.
    English,
    /// A language with a dictionary in `dictionaries.json`, by its code.
    Known(&'static str),
    /// A language option Lattice has no dictionary for, as written.
    Unknown(String),
}

/// babel and polyglossia language names, lowercase, and the dictionary code
/// each is spelled with ("en" for every English variant). A name missing
/// here is still a language when babel is given it (see `BABEL_FLAGS`).
pub(super) const LANGUAGE_NAMES: &[(&str, &str)] = &[
    ("english", "en"),
    ("american", "en"),
    ("usenglish", "en"),
    ("british", "en"),
    ("ukenglish", "en"),
    ("canadian", "en"),
    ("australian", "en"),
    ("newzealand", "en"),
    ("french", "fr"),
    ("francais", "fr"),
    ("français", "fr"),
    ("frenchb", "fr"),
    ("acadian", "fr"),
    ("canadien", "fr"),
    ("german", "de"),
    ("ngerman", "de"),
    ("germanb", "de"),
    ("ngermanb", "de"),
    ("austrian", "de-AT"),
    ("naustrian", "de-AT"),
    ("swissgerman", "de-CH"),
    ("nswissgerman", "de-CH"),
    ("spanish", "es"),
    ("spanishmx", "es"),
    ("italian", "it"),
    ("portuguese", "pt-PT"),
    ("portuges", "pt-PT"),
    ("brazil", "pt-BR"),
    ("brazilian", "pt-BR"),
    ("dutch", "nl"),
    ("polish", "pl"),
    ("russian", "ru"),
    ("ukrainian", "uk"),
    ("czech", "cs"),
    ("slovak", "sk"),
    ("slovene", "sl"),
    ("slovenian", "sl"),
    ("croatian", "hr"),
    ("swedish", "sv"),
    ("norsk", "nb"),
    ("norwegian", "nb"),
    ("bokmal", "nb"),
    ("nynorsk", "nn"),
    ("catalan", "ca"),
    ("romanian", "ro"),
    ("magyar", "hu"),
    ("hungarian", "hu"),
    ("greek", "el"),
    ("bulgarian", "bg"),
    ("latvian", "lv"),
    ("lithuanian", "lt"),
    ("irish", "ga"),
    ("welsh", "cy"),
    ("icelandic", "is"),
    ("esperanto", "eo"),
];

/// babel package options that are not languages.
const BABEL_FLAGS: &[&str] = &[
    "activeacute",
    "activegrave",
    "base",
    "keepshorthandsactive",
    "noconfigs",
    "nocase",
    "showlanguages",
    "silent",
];

fn language_code(name: &str) -> Option<&'static str> {
    let name = name.trim().to_lowercase();
    LANGUAGE_NAMES.iter().find(|(known, _)| *known == name).map(|(_, code)| *code)
}

fn classify(name: &str, code: Option<&'static str>) -> DocumentLanguage {
    match code {
        Some("en") => DocumentLanguage::English,
        Some(code) if super::catalog::entry(code).is_some() => DocumentLanguage::Known(code),
        _ => DocumentLanguage::Unknown(name.trim().to_string()),
    }
}

/// The language `document` (project-relative) is typeset in.
pub fn document_language(root: &Path, document: &str) -> DocumentLanguage {
    let mut scan = Scan { root, seen: HashSet::new(), found: Found::default() };
    scan.file(document);
    scan.found.language()
}

/// The document whose preamble decides the language of `open_path`: the root
/// a build would compile while it is open, else the project's default root,
/// else the open file itself.
pub fn compile_root_for(root: &Path, open_path: &str) -> String {
    project::resolve_compile_root(root, open_path)
        .map(|compile_root| compile_root.path)
        .or_else(|| {
            let manifest = project::read_manifest(root).ok()?;
            crate::latex::default_root(&manifest).map(|document| document.path.clone())
        })
        .unwrap_or_else(|| open_path.to_string())
}

#[derive(Default)]
struct Found {
    /// Language names among the document class's options, in order.
    class_languages: Vec<String>,
    /// babel was loaded, so the class's language options apply.
    babel: bool,
    /// The last language option babel was given, and a `main=` one.
    babel_last: Option<String>,
    babel_main: Option<String>,
    /// Polyglossia's main language, with the variant it was given.
    polyglossia: Option<(String, Option<String>)>,
}

impl Found {
    fn language(&self) -> DocumentLanguage {
        if let Some((name, variant)) = &self.polyglossia {
            return classify(name, polyglossia_code(name, variant.as_deref()));
        }
        let name = self.babel_main.as_ref().or(self.babel_last.as_ref()).or(if self.babel {
            self.class_languages.last()
        } else {
            None
        });
        match name {
            Some(name) => classify(name, language_code(name)),
            None => DocumentLanguage::English,
        }
    }

    /// Options as babel reads them: `main=` names the main language outright,
    /// and otherwise the last language wins.
    fn babel_options(&mut self, options: &str) {
        self.babel = true;
        for option in options.split(',').map(str::trim).filter(|option| !option.is_empty()) {
            if let Some((key, value)) = option.split_once('=') {
                if key.trim() == "main" {
                    self.babel_main = Some(value.trim().to_string());
                }
                continue;
            }
            let lower = option.to_lowercase();
            if BABEL_FLAGS.contains(&lower.as_str()) || lower.starts_with("provide") {
                continue;
            }
            self.babel_last = Some(option.to_string());
        }
    }
}

/// Polyglossia names variants with an option: `variant=brazilian` for
/// Portuguese, `variant=swiss` for German, `variant=nynorsk` for Norwegian.
fn polyglossia_code(name: &str, variant: Option<&str>) -> Option<&'static str> {
    let variant = variant.map(|variant| variant.trim().to_lowercase());
    match (name.trim().to_lowercase().as_str(), variant.as_deref()) {
        ("portuguese", Some("brazilian" | "brazil")) => Some("pt-BR"),
        ("german", Some("austrian")) => Some("de-AT"),
        ("german", Some("swiss")) => Some("de-CH"),
        ("norwegian", Some("nynorsk")) => Some("nn"),
        (other, _) => language_code(other),
    }
}

fn option_value<'a>(options: &'a str, key: &str) -> Option<&'a str> {
    options.split(',').find_map(|option| {
        let (name, value) = option.split_once('=')?;
        (name.trim() == key).then(|| value.trim())
    })
}

struct Scan<'a> {
    root: &'a Path,
    seen: HashSet<String>,
    found: Found,
}

impl Scan<'_> {
    /// Reads `relative`'s preamble; true once `\begin{document}` is reached.
    fn file(&mut self, relative: &str) -> bool {
        if self.seen.len() >= MAX_FILES || !self.seen.insert(relative.to_string()) {
            return false;
        }
        let Some(text) = project::safe_path(self.root, relative)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
        else {
            return false;
        };
        // Option lists span lines, so the uncommented preamble is read whole.
        let mut code = String::new();
        for line in text.lines() {
            let line = strip_comment(line);
            if let Some(at) = line.find("\\begin{document}") {
                code.push_str(&line[..at]);
                self.read(&code);
                return true;
            }
            code.push_str(line);
            code.push('\n');
        }
        self.read(&code);
        false
    }

    fn read(&mut self, code: &str) {
        for command in commands().captures_iter(code) {
            let options = command.get(2).map_or("", |options| options.as_str());
            let argument = command[3].trim();
            match &command[1] {
                "documentclass" | "LoadClass" => {
                    self.found.class_languages.extend(
                        options
                            .split(',')
                            .map(str::trim)
                            .filter(|option| language_code(option).is_some())
                            .map(str::to_string),
                    );
                    if self.local(argument, "cls") {
                        return;
                    }
                }
                "usepackage" | "RequirePackage" => {
                    for package in argument.split(',').map(str::trim) {
                        if package == "babel" {
                            self.found.babel_options(options);
                        } else if self.local(package, "sty") {
                            return;
                        }
                    }
                }
                "babelprovide" => {
                    if options.split(',').any(|option| option.trim() == "main") {
                        self.found.babel_main = Some(argument.to_string());
                    }
                }
                "setdefaultlanguage" | "setmainlanguage" => {
                    let variant = option_value(options, "variant").map(str::to_string);
                    self.found.polyglossia = Some((argument.to_string(), variant));
                }
                // \input and \include
                _ => {
                    let reached_body = if self.exists(argument) {
                        self.file(argument)
                    } else {
                        self.file(&format!("{argument}.tex"))
                    };
                    if reached_body {
                        return;
                    }
                }
            }
        }
    }

    fn exists(&self, relative: &str) -> bool {
        project::safe_path(self.root, relative).is_ok_and(|path| path.is_file())
    }

    /// A class or package the project ships beside its documents, read as
    /// part of the preamble. Installed ones (TeX Live's) are not read.
    fn local(&mut self, name: &str, extension: &str) -> bool {
        let local = format!("{name}.{extension}");
        self.exists(&local) && self.file(&local)
    }
}

/// The preamble commands that load babel or polyglossia, set their
/// language, or read another file, with their options and braced argument.
fn commands() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\\(documentclass|LoadClass|usepackage|RequirePackage|babelprovide|setdefaultlanguage|setmainlanguage|input|include)\b\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}",
        )
        .expect("language command regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn project(files: &[(&str, &str)]) -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new("spelling-language");
        for (path, text) in files {
            dir.write(path, text);
        }
        let root = dir.to_path_buf();
        (dir, root)
    }

    fn language_of(preamble: &str) -> DocumentLanguage {
        let (_dir, root) = project(&[(
            "main.tex",
            &format!("{preamble}\n\\begin{{document}}\nTexte.\n\\end{{document}}\n"),
        )]);
        document_language(&root, "main.tex")
    }

    #[test]
    fn babel_main_language_is_its_last_language_option() {
        use DocumentLanguage::*;
        let cases = [
            ("\\documentclass{article}", English),
            ("\\documentclass{article}\n\\usepackage[T1]{fontenc}", English),
            ("\\documentclass{article}\n\\usepackage[french]{babel}", Known("fr")),
            ("\\documentclass{article}\n\\usepackage[english,ngerman]{babel}", Known("de")),
            ("\\documentclass{article}\n\\usepackage[ngerman, english]{babel}", English),
            ("\\documentclass{article}\n\\usepackage[main=french,english]{babel}", Known("fr")),
            ("\\documentclass[a4paper,11pt,french]{article}\n\\usepackage{babel}", Known("fr")),
            ("\\documentclass[french]{article}\n\\usepackage[spanish]{babel}", Known("es")),
            ("\\documentclass[french]{article}", English),
            ("\\documentclass{article}\n\\usepackage[\n  english,\n  brazil\n]{babel}", Known("pt-BR")),
            ("\\documentclass{article}\n\\usepackage[portuguese,shorthands=off]{babel}", Known("pt-PT")),
            ("\\documentclass{article}\n\\usepackage[nswissgerman]{babel}", Known("de-CH")),
            ("\\documentclass{article}\n\\usepackage[russian,KeepShorthandsActive]{babel}", Known("ru")),
            ("\\documentclass{article}\n\\usepackage[finnish]{babel}", Unknown("finnish".into())),
            ("\\documentclass{article}\n\\usepackage{babel}\n\\babelprovide[import,main]{italian}", Known("it")),
            ("\\documentclass{article}\n% \\usepackage[french]{babel}", English),
            ("\\documentclass{article}\n\\usepackage[british]{babel}", English),
        ];
        for (preamble, expected) in cases {
            assert_eq!(language_of(preamble), expected, "{preamble}");
        }
    }

    #[test]
    fn polyglossia_main_language_and_its_variant() {
        use DocumentLanguage::*;
        let cases = [
            ("\\usepackage{polyglossia}\n\\setdefaultlanguage{french}\n\\setotherlanguage{english}", Known("fr")),
            ("\\usepackage{polyglossia}\n\\setmainlanguage[variant=brazilian]{portuguese}", Known("pt-BR")),
            ("\\usepackage{polyglossia}\n\\setmainlanguage{portuguese}", Known("pt-PT")),
            ("\\usepackage{polyglossia}\n\\setdefaultlanguage[variant=swiss]{german}", Known("de-CH")),
            ("\\usepackage{polyglossia}\n\\setdefaultlanguage[spelling=new]{german}", Known("de")),
            ("\\usepackage{polyglossia}\n\\setdefaultlanguage[variant=british]{english}", English),
        ];
        for (preamble, expected) in cases {
            assert_eq!(language_of(&format!("\\documentclass{{article}}\n{preamble}")), expected);
        }
    }

    #[test]
    fn the_preamble_is_followed_into_inputs_and_local_packages() {
        let (_dir, root) = project(&[
            ("main.tex", "\\documentclass{report}\n\\input{setup/preamble}\n\\begin{document}\n\\include{chapters/one}\n\\end{document}\n"),
            ("setup/preamble.tex", "\\usepackage{thesis}\n"),
            ("thesis.sty", "\\RequirePackage[ngerman]{babel}\n"),
            ("chapters/one.tex", "\\chapter{Einleitung}\n"),
        ]);
        assert_eq!(document_language(&root, "main.tex"), DocumentLanguage::Known("de"));
        // A body that quotes babel in an example does not change the language.
        let (_dir, root) = project(&[(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\n\\usepackage[french]{babel}\n\\end{document}\n",
        )]);
        assert_eq!(document_language(&root, "main.tex"), DocumentLanguage::English);
        // Inputs that read each other end the scan instead of looping.
        let (_dir, root) = project(&[
            ("main.tex", "\\documentclass{article}\n\\input{a}\n\\usepackage[italian]{babel}\n"),
            ("a.tex", "\\input{main}\n"),
        ]);
        assert_eq!(document_language(&root, "main.tex"), DocumentLanguage::Known("it"));
    }

    #[test]
    fn a_chapter_takes_the_language_of_its_compile_root() {
        let (_dir, root) = project(&[
            ("thesis.tex", "\\documentclass{book}\n\\usepackage[french]{babel}\n\\begin{document}\n\\include{ch/intro}\n\\end{document}\n"),
            ("ch/intro.tex", "% !TEX root = ../thesis.tex\n\\chapter{Introduction}\n"),
            ("ch/orphan.tex", "\\chapter{Annexe}\n"),
        ]);
        assert_eq!(compile_root_for(&root, "ch/intro.tex"), "thesis.tex");
        assert_eq!(compile_root_for(&root, "thesis.tex"), "thesis.tex");
        // No magic comment and no manifest: the open file decides alone.
        assert_eq!(compile_root_for(&root, "ch/orphan.tex"), "ch/orphan.tex");
        let language = document_language(&root, &compile_root_for(&root, "ch/intro.tex"));
        assert_eq!(language, DocumentLanguage::Known("fr"));
    }
}
