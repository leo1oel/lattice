//! Builds and what they report, as the Tauri app shows them: the Build
//! button's card with the passes latexmk ran (`sequence`), the diagnostics
//! card over the PDF with TeX's messages in plain words and a fix to apply
//! (`diagnostics`, `explain`, `card`), how a build ended (`outcome`), the
//! TeX doctor and the setup and package installs (`doctor`, `tex_setup`),
//! and the status bar's word counts (`word_count`).
//!
//! The logic is ported line by line from the Tauri app's TypeScript (each
//! module names its source) and keeps its tests; the backend is
//! lattice-core's, the one the Tauri app's commands call.

pub mod card;
pub mod diagnostics;
pub mod doctor;
pub mod explain;
pub mod hover_card;
mod icons;
pub mod outcome;
pub mod sequence;
pub mod tex_setup;
pub mod word_count;
pub mod word_count_item;
