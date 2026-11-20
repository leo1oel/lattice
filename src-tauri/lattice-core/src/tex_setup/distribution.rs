//! Which TeX distribution a build runs, by the name its writer installed it
//! under, for the advice that says what to add to it. Lattice's one-click
//! install sets up BasicTeX on a Mac and TeX Live on Windows, but a writer may
//! build with any TeX, and "BasicTeX does not include every package" read
//! wrong on a Linux TinyTeX.
//!
//! Read from where the `kpsewhich` a build resolves lives, the program the
//! doctor's checks and the installers already go by: the year trees the
//! installers find with `tex_live::root_of_bin`, MiKTeX's program folders as
//! `miktex::is_miktex_bin` knows them. Nothing is run.

use super::{miktex, tex_live};
use crate::commands;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TexDistribution {
    BasicTex,
    MacTex,
    TinyTex,
    TexLive,
    Miktex,
}

impl TexDistribution {
    /// The name the writer knows it by.
    pub fn name(self) -> &'static str {
        match self {
            Self::BasicTex => "BasicTeX",
            Self::MacTex => "MacTeX",
            Self::TinyTex => "TinyTeX",
            Self::TexLive => "TeX Live",
            Self::Miktex => "MiKTeX",
        }
    }

    /// Whose packages a missing file comes from: BasicTeX, MacTeX and TinyTeX
    /// are TeX Live trees, and MiKTeX has its own.
    pub fn packages(self) -> &'static str {
        match self {
            Self::Miktex => "MiKTeX",
            _ => "TeX Live",
        }
    }
}

/// The distribution of the TeX a build runs, or `None` when there is no TeX
/// or Lattice cannot tell which it is. Links are followed: TinyTeX links its
/// programs into `~/bin` or `~/.local/bin`, and a Mac's `/Library/TeX/texbin`
/// points into `/usr/local/texlive`.
pub fn detect_distribution() -> Option<TexDistribution> {
    if !commands::available("kpsewhich") {
        return None;
    }
    let program = std::fs::canonicalize(commands::resolve("kpsewhich")).ok()?;
    distribution_of(&program, cfg!(target_os = "macos"))
}

/// The distribution `program`, a TeX program with its links followed,
/// belongs to. `macos` says whether this is a Mac, where the year tree
/// under /usr/local/texlive that is not BasicTeX's is MacTeX's.
fn distribution_of(program: &Path, macos: bool) -> Option<TexDistribution> {
    let bin = program.parent()?;
    let stem = program.file_stem()?.to_string_lossy().to_ascii_lowercase();
    // Linux MiKTeX names its programs `miktex-kpsewhich` and links the plain
    // names to them; on Windows they sit in `…\miktex\bin\x64`.
    if stem.starts_with("miktex") || miktex::is_miktex_bin(bin) {
        return Some(TexDistribution::Miktex);
    }
    if let Some(root) = tex_live::root_of_bin(bin) {
        let name = root.file_name()?.to_string_lossy().to_ascii_lowercase();
        return Some(if name.trim_start_matches('.') == "tinytex" {
            TexDistribution::TinyTex
        } else if name.ends_with("basic") {
            // BasicTeX's tree is `/usr/local/texlive/2026basic`.
            TexDistribution::BasicTex
        } else if macos && root.parent() == Some(Path::new("/usr/local/texlive")) {
            TexDistribution::MacTex
        } else {
            TexDistribution::TexLive
        });
    }
    // A Linux distribution's own TeX Live packages, and Homebrew's `texlive`
    // formula (`/opt/homebrew/Cellar/texlive/<version>/bin`).
    let packaged = !macos && bin == Path::new("/usr/bin");
    let homebrew = program.components().any(|part| part.as_os_str() == "texlive");
    (packaged || homebrew).then_some(TexDistribution::TexLive)
}

#[cfg(test)]
mod tests {
    use super::*;
    use TexDistribution::*;

    fn of(program: &str, macos: bool) -> Option<TexDistribution> {
        distribution_of(Path::new(program), macos)
    }

    #[test]
    fn names_each_distribution_by_where_its_programs_are() {
        assert_eq!(of("/home/ada/.TinyTeX/bin/x86_64-linux/kpsewhich", false), Some(TinyTex));
        assert_eq!(
            of("/Users/ada/Library/TinyTeX/bin/universal-darwin/kpsewhich", true),
            Some(TinyTex)
        );
        assert_eq!(
            of("C:/Users/ada/AppData/Roaming/TinyTeX/bin/windows/kpsewhich.exe", false),
            Some(TinyTex)
        );
        assert_eq!(
            of("/usr/local/texlive/2026basic/bin/universal-darwin/kpsewhich", true),
            Some(BasicTex)
        );
        assert_eq!(
            of("/usr/local/texlive/2026/bin/universal-darwin/kpsewhich", true),
            Some(MacTex)
        );
        // The same tree on Linux is TeX Live's own installer.
        assert_eq!(of("/usr/local/texlive/2026/bin/x86_64-linux/kpsewhich", false), Some(TexLive));
        // The per-user TeX Live Lattice installs on Windows.
        assert_eq!(
            of("C:/Users/ada/AppData/Local/Programs/texlive/2026/bin/windows/kpsewhich.exe", false),
            Some(TexLive)
        );
        assert_eq!(of("/usr/bin/kpsewhich", false), Some(TexLive));
        assert_eq!(of("/opt/homebrew/Cellar/texlive/20250308/bin/kpsewhich", true), Some(TexLive));
        assert_eq!(of("C:/Program Files/MiKTeX/miktex/bin/x64/kpsewhich.exe", false), Some(Miktex));
        assert_eq!(of("/usr/bin/miktex-kpsewhich", false), Some(Miktex));
    }

    #[test]
    fn names_none_it_cannot_tell() {
        // Neither a year tree nor a distribution's own folder.
        assert_eq!(of("/opt/tex/kpsewhich", false), None);
        assert_eq!(of("/nix/store/abc-texlive-combined-2025/bin/kpsewhich", false), None);
        // A Mac has no TeX of its own in /usr/bin.
        assert_eq!(of("/usr/bin/kpsewhich", true), None);
    }

    #[test]
    fn packages_come_from_tex_live_except_on_miktex() {
        assert_eq!(TinyTex.packages(), "TeX Live");
        assert_eq!(BasicTex.packages(), "TeX Live");
        assert_eq!(Miktex.packages(), "MiKTeX");
    }
}
