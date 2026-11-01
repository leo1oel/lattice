//! Live preview for LuaLaTeX projects, driven by rtex (realtime-tex).
//!
//! rtex keeps a LuaLaTeX process with the preamble loaded and re-typesets only
//! the paragraph being edited, then runs whole-document passes in the
//! background. It is on by default in LuaLaTeX projects, which a writer can
//! turn off, and never bundled: the first time such a project opens, `install`
//! downloads one pinned release into Application Support, verified by
//! SHA-256, and it runs on the user's own TeX Live.
//!
//! Lattice hosts the release's `rtex serve` as a supervised child (`session`)
//! rather than linking the `rtex-core` crate: linking would compile rtex into
//! every copy of Lattice, which is the bundling this feature must avoid, and
//! its 0.0.x engine runs in a process Lattice can kill without going down
//! with it. Its JSON lines go to the window unparsed.
//!
//! None of this touches the normal build. latexmk stays the only source of the
//! exported PDF, diagnostics and SyncTeX; rtex works in its own build folder
//! (`session::build_dir`), outside the project.

mod install;
mod resources;
mod session;

pub(crate) use install::{install, remove, status, InstallProgress, InstallStatus};
pub(crate) use resources::{read_fallback_pdf, read_font_file, read_image_file};
pub(crate) use session::{allowed_command, Session};

/// The rtex release Lattice downloads. The display-list format and the
/// `rtex serve` protocol change together before 0.1, so the renderer in
/// `src/live-preview/` is written against exactly this version. It names the
/// install folder too, so a new pin never runs an older release left in place.
pub(crate) const RTEX_VERSION: &str = "0.0.6";

/// `Application Support/<identifier>/live-preview`: the installed release and
/// rtex's build folders, all removed together by [`remove`].
fn home() -> Option<std::path::PathBuf> {
    crate::commands::app_support_dir().map(|directory| directory.join("live-preview"))
}
