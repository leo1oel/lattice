//! Lattice's domain logic, shared by every shell that hosts it.
//!
//! Everything a window can ask for lives here: projects and their history,
//! LaTeX builds, Overleaf sync, the paper library, the agent and slide
//! sidecars. A shell (the Tauri app in `src-tauri/src`) owns the windows and
//! the command table, and hands the core the few things only it has, through
//! `host`: where its resources are, and where events and streamed output go.
//! `runtime` is the async runtime the core spawns on, which a shell may share.
//! `app_state` is the project registry: which project each window shows, and
//! what an open project owns.

/// The version the core reports as Lattice's: user agents, the terminal,
/// TexLab, research-environment episodes. It must match the shell's.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod agent_literature;
mod alphaxiv;
pub mod app_identity;
pub mod app_state;
pub mod bib_document;
pub mod citation_audit;
mod citation_batch;
pub mod citation_health;
pub mod command_diagnostics;
pub mod commands;
pub mod diagnostic_logs;
pub mod doctor;
pub mod export;
mod firecrawl;
pub mod format_latex;
pub mod fs_watch;
mod fts;
pub mod git;
pub mod harper;
pub mod host;
mod host_paths;
pub mod http;
pub mod latex;
pub mod link_preview;
pub mod literature;
pub mod literature_credentials;
mod literature_service;
pub mod live_preview;
pub mod model_endpoint;
pub mod models;
mod openalex;
pub mod overleaf;
pub mod overleaf_rt;
pub mod paper_pdf_proxy;
pub mod papers;
mod pdf_fonts;
pub mod pdf_pages;
mod platform_fs;
#[cfg(windows)]
mod platform_windows;
pub mod presentation;
#[cfg(target_os = "macos")]
pub mod process_inspector;
pub mod project;
#[cfg(unix)]
mod project_fs;
#[cfg(windows)]
#[path = "project_fs_windows.rs"]
mod project_fs;
pub mod research_env;
pub mod review_pdf;
pub mod runtime;
mod sidecar;
pub mod spelling;
pub mod synara;
pub mod terminal;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
pub mod tex_setup;
pub mod texcount;
pub mod texlab;
pub mod util;
mod web_metadata;
pub mod wide_event;
#[cfg(all(test, windows))]
mod windows_tests;
pub mod zotero;
