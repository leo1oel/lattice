//! Lattice's webview islands: the surfaces that stay web content in the GPUI
//! app (the Agent, boards, sheets, slide decks, the visual Markdown editor,
//! the HTML viewer), each hosted by an [`Island`] in its panel.
//!
//! - [`island`]: the host: lifecycle, lazy load and hibernation, reveal, the
//!   theme, focus and shortcut forwarding, overlays and dock drags.
//! - [`bridge`]: the page's messages to the host and back.
//! - [`protocol`]: the local asset protocol pages are served from.
//! - [`files`]: the file bridge's project scope, read only; the islands'
//!   documents are written by their owners through lattice-core.
//! - [`keys`]: which of the app's shortcuts a page hands back, and how.

pub mod bridge;
pub mod files;
mod held;
pub mod island;
pub mod keys;
mod masked;
mod native;
mod navigation;
pub mod protocol;
mod registry;
mod theme;

pub use files::FileScope;
pub use island::{HIBERNATE_AFTER, Island, IslandConfig, IslandEvent, IslandState, IslandStats};
pub use protocol::{Bundle, BundleFile};
pub use registry::{check_drawn_after_frame, set_dock_dragging, set_hibernate_after};
pub use theme::{IslandTheme, theme_payload};
