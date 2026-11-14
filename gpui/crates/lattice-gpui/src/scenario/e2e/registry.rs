//! The e2e scenario's feature modules, each registered by its own file.
//!
//! Every `.rs` file under `scenario/e2e/` (and every `<name>/mod.rs`) is a
//! module of the scenario without a line kept by hand: `build.rs` declares
//! them all, and a file that holds a `pub(super) const MODULE: Module` is a
//! feature module named after the file, which `--only <name>` selects. So a
//! new feature's checks are one new file, and adding one edits neither
//! `e2e.rs` nor a list beside it.
//!
//! A module says where it runs: after which part of the smoke flow
//! ([`After`]), and its place among that stage's modules (`rank`, low first;
//! modules of one rank run by name). A module that only macOS runs starts
//! with `#![cfg(target_os = "macos")]`; elsewhere `--only` still accepts its
//! name and runs nothing for it.
//!
//! `covers` names the app source the module exercises, as path prefixes from
//! the repository root; `scripts/gpui-e2e-modules.mjs` reads them to pick the
//! modules a branch's change touches (a module's own scenario files pick it
//! without being listed).

use anyhow::Result;
use futures::future::LocalBoxFuture;
use gpui::AsyncApp;

use super::{Fixture, Steps};
use crate::scenario::Run;

/// The part of the smoke flow a module runs after (its stage), in the flow's
/// order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::scenario) enum After {
    /// The first build and its PDF, the build sequence and the word count.
    Build,
    /// The broken build, its error followed, buffer search and Vim.
    Vim,
    /// The file repaired outside Lattice and built cleanly again.
    Repair,
    /// A second window's PDF, the Terminal panel (macOS) and the tab drag
    /// (`LATTICE_E2E_DRAG`); the modules after it run before the typing
    /// that ends the run.
    Terminal,
}

/// What a module runs: its steps, on the fixture's scratch project.
pub(in crate::scenario) type RunModule = for<'a> fn(
    &'a Run,
    &'a mut AsyncApp,
    &'a mut Steps,
    &'a Fixture,
) -> LocalBoxFuture<'a, Result<()>>;

/// One feature module's registration (its file's `MODULE`).
pub(in crate::scenario) struct Module {
    pub after: After,
    /// Its place in its stage, low first.
    pub rank: u16,
    /// The modules an `--only` run must also run for it, before it.
    pub needs: &'static [&'static str],
    /// It starts from what the full run's earlier modules leave behind (an
    /// editor open on `chapters/intro.tex`), set up in an `--only` run by
    /// `Run::standalone_setup`.
    pub setup: bool,
    /// The app source it exercises, as path prefixes from the repository
    /// root, for `scripts/gpui-e2e-modules.mjs` (and a test that they exist).
    #[cfg_attr(not(test), allow(dead_code))]
    pub covers: &'static [&'static str],
    pub run: RunModule,
}

/// A file's registration as `build.rs` lists it: its name, and its module
/// where this platform builds it.
pub(in crate::scenario) struct Registered {
    pub name: &'static str,
    pub module: Option<&'static Module>,
}

/// Every feature module, in the order a full run runs them: by stage, then
/// rank, then name; the ones this platform does not build last, by name.
pub(in crate::scenario) fn ordered() -> Vec<&'static Registered> {
    let mut all: Vec<&'static Registered> = super::REGISTERED.iter().collect();
    all.sort_by_key(|registered| {
        (
            registered
                .module
                .map(|module| (module.after, module.rank))
                .unwrap_or((After::Terminal, u16::MAX)),
            registered.module.is_none(),
            registered.name,
        )
    });
    all
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn module_names_are_unique_and_their_needs_run_first() {
        let order = ordered();
        let position = |name: &str| order.iter().position(|registered| registered.name == name);
        for (index, registered) in order.iter().enumerate() {
            assert_eq!(
                position(registered.name),
                Some(index),
                "{} twice",
                registered.name
            );
            for need in registered
                .module
                .map(|module| module.needs)
                .unwrap_or_default()
            {
                let at = position(need)
                    .unwrap_or_else(|| panic!("{} needs unknown {need}", registered.name));
                assert!(
                    at < index,
                    "{} needs {need}, which runs after it",
                    registered.name
                );
            }
        }
    }

    #[test]
    fn what_a_module_covers_exists() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        for registered in ordered() {
            for prefix in registered
                .module
                .map(|module| module.covers)
                .unwrap_or_default()
            {
                let path = repo.join(prefix);
                let (dir, stem) = match prefix.rsplit_once('/') {
                    Some((dir, stem)) => (repo.join(dir), stem),
                    None => (repo.clone(), *prefix),
                };
                let found = path.exists()
                    || std::fs::read_dir(&dir).is_ok_and(|entries| {
                        entries
                            .flatten()
                            .any(|entry| entry.file_name().to_string_lossy().starts_with(stem))
                    });
                assert!(found, "{}: nothing under {prefix}", registered.name);
            }
        }
    }
}
