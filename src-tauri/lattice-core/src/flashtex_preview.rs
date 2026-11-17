//! A development spike: live preview for pdfLaTeX (and, with a locally built
//! host, XeLaTeX) projects, driven by FlashTeX's `flashtex-host`.
//!
//! FlashTeX is a Rust port of pdfTeX with incremental compilation: the host
//! keeps the document's engine state between compiles, takes the editor's
//! unsaved text, re-typesets only the pages an edit reaches and writes a real
//! PDF. The window hands that PDF to the PDF panel it already has, whose page
//! signatures (`pdf_pages.rs`) redraw only the pages that changed.
//!
//! It follows rtex's shape (`live_preview.rs`) for the same reasons. The
//! engine is GPL-2.0-or-later and Lattice is not, so it is never bundled or
//! linked: `install` downloads one pinned release into Application Support,
//! verified by SHA-256, and `session` runs its `flashtex-host` as a separate,
//! supervised process that Lattice can kill without going down with it.
//!
//! The spike is off unless a developer turns it on in the window
//! (`src/live-preview/flashtex-preview.ts`), and it never touches the normal
//! build: latexmk stays the only source of the exported PDF, diagnostics and
//! SyncTeX. The host writes the editor's buffers into the folder it compiles,
//! so it works in a copy of the project (`mirror`), never the project itself.

mod install;
#[cfg(unix)]
mod mirror;
#[cfg(unix)]
mod protocol;
// The host listens on a Unix socket, so Windows (where FlashTeX has no
// release either) gets a session that never starts.
#[cfg_attr(not(unix), path = "flashtex_preview/session_unsupported.rs")]
mod session;

pub use install::{install, status, InstallProgress, InstallStatus};
pub use session::{Buffer, CompileReport, Engine, Session, SessionHandle};

/// The FlashTeX release Lattice downloads. Its host speaks
/// `display-list-v3` 3.2, which `protocol` is written against, and it names
/// the install folder, so a new pin never runs an older release left in place.
pub const FLASHTEX_VERSION: &str = "0.2.0";

/// A `flashtex-host-unicode` to run XeLaTeX projects with. No release ships
/// FlashTeX's XeTeX host yet, so only a developer who built it from source
/// (crates/flashtex-xetex) can try XeLaTeX projects, by naming it here.
const UNICODE_HOST_VARIABLE: &str = "LATTICE_FLASHTEX_UNICODE_HOST";

/// `Application Support/<identifier>/flashtex-preview`: the installed release
/// and each session's copy of its project.
fn home() -> Option<std::path::PathBuf> {
    crate::commands::app_support_dir().map(|directory| directory.join("flashtex-preview"))
}
