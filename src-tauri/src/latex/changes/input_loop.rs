//! `\input` files that include each other, found before latexdiff is asked
//! to flatten them.
//!
//! `latexdiff --flatten` pastes every `\input`, `\include`, `\subfile` and
//! `\import` into the file that names it, recursively, with no check for a
//! file it is already inside: `a.tex` reading `b.tex` reading `a.tex` makes it
//! recurse until it is killed, holding more memory every second (#658). The
//! files are walked here the way latexdiff finds them, so the loop is named
//! instead.
//!
//! latexdiff resolves `\input` and `\include` against the folder of the file
//! that started the flattening (the root document, or the file a `\subfile`
//! or `\import` opened), not the file they are written in; a name without a
//! three- or four-letter extension gets `.tex`. Only files that exist are
//! followed, as latexdiff leaves a missing one alone.

use regex::Regex;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// What the flattening follows, as latexdiff's own patterns match it.
static INCLUDES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\\(?:(input|include|subfile)\{([^{}]*)\}|(sub)?(?:import|inputfrom|includefrom)\{([^{}]*)\}\s*\{([^{}]*)\})",
    )
    .unwrap()
});

/// One file the flattening reads, and the folder its own `\input`s resolve in.
#[derive(Clone)]
struct Read {
    file: PathBuf,
    base: PathBuf,
}

/// The chain of files, from `document`, that leads back into itself
/// (`main.tex → a.tex → b.tex → a.tex`), relative to `folder`; `None` when
/// the flattening ends.
pub(super) fn input_loop(folder: &Path, document: &str) -> Option<Vec<String>> {
    let file = folder.join(document);
    let base = file.parent().unwrap_or(folder).to_path_buf();
    let mut walk = Walk { folder, finished: HashSet::new(), stack: Vec::new() };
    walk.visit(Read { file, base })
}

struct Walk<'a> {
    folder: &'a Path,
    /// Files whose whole tree was walked without a loop: each is read once,
    /// so a file every chapter includes does not make the walk exponential.
    finished: HashSet<PathBuf>,
    /// The chain being followed, by the file each identity names.
    stack: Vec<(PathBuf, PathBuf)>,
}

impl Walk<'_> {
    fn visit(&mut self, read: Read) -> Option<Vec<String>> {
        let identity = fs::canonicalize(&read.file).unwrap_or_else(|_| read.file.clone());
        if let Some(at) = self.stack.iter().position(|(seen, _)| *seen == identity) {
            let mut chain: Vec<String> =
                self.stack.iter().map(|(_, file)| self.shown(file)).collect();
            // From the root, so the writer sees where the loop is entered.
            chain.push(self.shown(&self.stack[at].1));
            return Some(chain);
        }
        if self.finished.contains(&identity) {
            return None;
        }
        let text = fs::read(&read.file).ok()?;
        self.stack.push((identity.clone(), read.file.clone()));
        for child in includes(&String::from_utf8_lossy(&text), &read.base, self.folder) {
            if let Some(chain) = self.visit(child) {
                return Some(chain);
            }
        }
        self.stack.pop();
        self.finished.insert(identity);
        None
    }

    fn shown(&self, file: &Path) -> String {
        let shown = file.strip_prefix(self.folder).unwrap_or(file);
        shown.to_string_lossy().replace('\\', "/")
    }
}

/// The existing files `text` pastes in, outside comments; `root` is the
/// version's own folder, standing in for latexdiff's working folder.
fn includes(text: &str, base: &Path, root: &Path) -> Vec<Read> {
    let mut found = Vec::new();
    for line in text.lines() {
        let code = &line[..comment_start(line).unwrap_or(line.len())];
        for capture in INCLUDES.captures_iter(code) {
            let read = if let Some(name) = capture.get(2) {
                let file = base.join(with_extension(name.as_str().trim()));
                // A subfile's own inputs resolve beside it.
                let child_base = if &capture[1] == "subfile" {
                    file.parent().unwrap_or(base).to_path_buf()
                } else {
                    base.to_path_buf()
                };
                Read { file, base: child_base }
            } else {
                let (folder, name) = (capture[4].trim(), capture[5].trim());
                // `\subimport` is relative to the current folder, `\import` to
                // latexdiff's working folder; each version's is resolved in that
                // version's own folder, so its own tree is walked. An absolute
                // folder stays as written.
                let folder =
                    if capture.get(3).is_some() { base.join(folder) } else { root.join(folder) };
                let file = folder.join(with_extension(name));
                Read { base: file.parent().unwrap_or(base).to_path_buf(), file }
            };
            // `#1` in a macro definition is not a file.
            if !read.file.to_string_lossy().contains('#') && read.file.is_file() {
                found.push(read);
            }
        }
    }
    found
}

/// `chapter` → `chapter.tex`; a three- or four-letter extension stays.
fn with_extension(name: &str) -> String {
    let has_extension = name.rsplit_once('.').is_some_and(|(_, extension)| {
        (3..=4).contains(&extension.len())
            && extension.chars().all(|c| c.is_alphanumeric() || c == '_')
    });
    if has_extension {
        name.to_string()
    } else {
        format!("{name}.tex")
    }
}

/// Where the line's comment starts: the first `%` not written `\%`.
fn comment_start(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' => return Some(at),
            b'\\' => at += 2,
            _ => at += 1,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn project(files: &[(&str, &str)]) -> TempDir {
        let root = TempDir::new("input-loop");
        for (path, text) in files {
            root.write(path, text);
        }
        root
    }

    /// The fixture that made latexdiff run away in #658.
    #[test]
    fn inputs_that_read_each_other_are_named_as_a_loop() {
        let root = project(&[
            (
                "main.tex",
                "\\documentclass{article}\n\\begin{document}\n\\input{a}\n\\end{document}\n",
            ),
            ("a.tex", "A\n\\input{sections/b}\n"),
            ("sections/b.tex", "B\n\\input{a.tex}\n"),
        ]);
        assert_eq!(
            input_loop(&root, "main.tex"),
            Some(vec!["main.tex".into(), "a.tex".into(), "sections/b.tex".into(), "a.tex".into()])
        );
        let itself = project(&[("main.tex", "\\include{main}\n")]);
        assert_eq!(
            input_loop(&itself, "main.tex"),
            Some(vec!["main.tex".into(), "main.tex".into()])
        );
    }

    #[test]
    fn a_tree_without_a_loop_passes_even_when_files_are_shared() {
        let root = project(&[
            ("main.tex", "\\input{intro}\n\\input{method} % \\input{main}\n\\input{missing}\n\\newcommand\\x[1]{\\input{#1}}\n"),
            ("intro.tex", "\\input{macros}\n"),
            ("method.tex", "\\input{macros}\n50\\% \\input{macros}\n"),
            ("macros.tex", "% \\input{main}\n"),
        ]);
        assert_eq!(input_loop(&root, "main.tex"), None);
    }

    #[test]
    fn subfiles_and_imports_resolve_beside_the_file_they_open() {
        let root = project(&[
            ("paper/main.tex", "\\subfile{parts/one}\n"),
            ("paper/parts/one.tex", "\\subimport{deep/}{two}\n"),
            ("paper/parts/deep/two.tex", "\\input{back}\n"),
            ("paper/parts/deep/back.tex", "\\subimport{../}{one}\n"),
        ]);
        assert_eq!(
            input_loop(&root, "paper/main.tex"),
            Some(vec![
                "paper/main.tex".into(),
                "paper/parts/one.tex".into(),
                "paper/parts/deep/two.tex".into(),
                "paper/parts/deep/back.tex".into(),
                "paper/parts/one.tex".into(),
            ])
        );
    }

    #[test]
    fn imports_resolve_in_the_version_folder() {
        let root = project(&[
            ("main.tex", "\\import{sections/}{a}\n"),
            ("sections/a.tex", "\\input{b}\n"),
            ("sections/b.tex", "\\import{sections/}{a}\n"),
        ]);
        assert_eq!(
            input_loop(&root, "main.tex"),
            Some(vec![
                "main.tex".into(),
                "sections/a.tex".into(),
                "sections/b.tex".into(),
                "sections/a.tex".into(),
            ])
        );
    }

    #[test]
    fn names_get_tex_unless_they_have_an_extension() {
        assert_eq!(with_extension("chapter"), "chapter.tex");
        assert_eq!(with_extension("table.data"), "table.data");
        assert_eq!(with_extension("v1.2/notes"), "v1.2/notes.tex");
    }
}
