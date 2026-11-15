//! What an empty palette query lists before every command
//! (`src/app/command-palette-leading.ts`): the last three commands run from
//! the palette, then the commands for the document in front ("In this
//! document", or "In this paper" for a paper's reader), each once, then the
//! files opened recently. The recent commands outlive the app
//! (`lattice.recent-commands.v1`: the newest eight, kept in the state folder),
//! and a command that opts out (`recent: false`) is never among them.

use std::path::PathBuf;

use gpui::{App, AppContext as _, Global};

/// How many recent commands an empty query leads with, and how many are
/// kept.
pub(super) const RECENT_SHOWN: usize = 3;
const RECENT_KEPT: usize = 8;
/// How many recently opened files follow them.
pub(super) const RECENT_FILES_SHOWN: usize = 4;

/// What the writer is looking at, as far as the suggestions go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Surface {
    Source,
    Markdown,
    Paper,
}

impl Surface {
    /// The surface of the document in front, by its layout key (a paper's
    /// reader) or its file's extension.
    pub(super) fn of(key: &str, paper: bool) -> Option<Surface> {
        if paper {
            return Some(Surface::Paper);
        }
        let lower = key.to_ascii_lowercase();
        if lower.ends_with(".tex") {
            Some(Surface::Source)
        } else if lower.ends_with(".md") || lower.ends_with(".markdown") {
            Some(Surface::Markdown)
        } else {
            None
        }
    }

    /// The commands worth one keystroke here, best first (`SURFACE_COMMANDS`,
    /// by the GPUI table's ids); a command the palette does not list now is
    /// skipped.
    pub(super) fn commands(self) -> &'static [&'static str] {
        match self {
            Surface::Source => &["build", "sync-pdf", "cite", "ref"],
            Surface::Markdown => &["find", "quick-open", "discover"],
            Surface::Paper => &["find", "discover", "quick-open"],
        }
    }
}

/// The ids of the commands an empty query leads with, and each one's group:
/// the recent ones that are listed now and may be recent, at most three,
/// then the surface's that are not among them.
pub(super) fn leading<'a>(
    available: &[(&'a str, bool)],
    recent: &[String],
    surface: Option<Surface>,
) -> Vec<(&'a str, Lead)> {
    let listed = |id: &str| available.iter().find(|(listed, _)| *listed == id).copied();
    let mut out: Vec<(&'a str, Lead)> = recent
        .iter()
        .filter_map(|id| listed(id))
        .filter(|(_, may_be_recent)| *may_be_recent)
        .take(RECENT_SHOWN)
        .map(|(id, _)| (id, Lead::Recent))
        .collect();
    for id in surface.map(Surface::commands).unwrap_or_default() {
        if let Some((id, _)) = listed(id)
            && !out.iter().any(|(shown, _)| *shown == id)
        {
            out.push((id, Lead::Surface));
        }
    }
    out
}

/// Which leading group a command is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lead {
    Recent,
    Surface,
}

/// The commands run from the palette, newest first.
#[derive(Default)]
pub(crate) struct RecentCommands {
    ids: Vec<String>,
    file: Option<PathBuf>,
}

impl Global for RecentCommands {}

impl RecentCommands {
    /// Read what an earlier run kept in the state folder (none for a run
    /// that keeps nothing).
    pub(crate) fn init(state: Option<PathBuf>, cx: &mut App) {
        let file = state.map(|state| state.join("recent-commands.json"));
        let ids = file
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .map(|text| read(&text))
            .unwrap_or_default();
        cx.set_global(RecentCommands { ids, file });
    }

    pub(crate) fn list(cx: &App) -> Vec<String> {
        cx.try_global::<RecentCommands>()
            .map(|recent| recent.ids.clone())
            .unwrap_or_default()
    }

    /// `id` ran from the palette: first now, each id once, eight kept.
    pub(crate) fn remember(id: &str, cx: &mut App) {
        let recent = cx.default_global::<RecentCommands>();
        recent.ids = remembered(&recent.ids, id);
        if let Some(file) = recent.file.clone() {
            let text = serde_json::to_string(&recent.ids).unwrap_or_default();
            cx.background_spawn(async move {
                if let Some(folder) = file.parent() {
                    std::fs::create_dir_all(folder).ok();
                }
                std::fs::write(file, text).ok();
            })
            .detach();
        }
    }
}

fn remembered(ids: &[String], id: &str) -> Vec<String> {
    std::iter::once(id.to_string())
        .chain(ids.iter().filter(|kept| *kept != id).cloned())
        .take(RECENT_KEPT)
        .collect()
}

/// The kept ids, dropping anything that is not a string list's entry.
fn read(text: &str) -> Vec<String> {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Array(values)) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .take(RECENT_KEPT)
            .collect(),
        _ => Vec::new(),
    }
}

/// The recent commands, read from the state folder (none kept for a
/// scripted run).
pub(crate) fn init(scripted: bool, cx: &mut App) {
    RecentCommands::init(super::workspaces::state_dir(scripted), cx);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_leading_groups_are_three_recent_then_the_surfaces_own() {
        // command-palette-leading.test.ts's expectations.
        let available = [
            ("build", true),
            ("sync-pdf", true),
            ("rebuild", false),
            ("find", true),
            ("settings", true),
            ("vim", true),
            ("quick-open", true),
        ];
        let recent: Vec<String> = ["rebuild", "build", "gone", "settings", "vim", "find"]
            .map(String::from)
            .to_vec();
        let lead = leading(&available, &recent, Some(Surface::Source));
        assert_eq!(
            lead,
            vec![
                ("build", Lead::Recent),
                ("settings", Lead::Recent),
                ("vim", Lead::Recent),
                ("sync-pdf", Lead::Surface),
            ]
        );
        assert_eq!(leading(&available, &[], None), vec![]);
        assert_eq!(
            leading(&available, &[], Some(Surface::Markdown)),
            vec![("find", Lead::Surface), ("quick-open", Lead::Surface)]
        );
    }

    #[test]
    fn a_surface_is_its_files_kind() {
        assert_eq!(
            Surface::of("chapters/intro.TEX", false),
            Some(Surface::Source)
        );
        assert_eq!(
            Surface::of("notes.markdown", false),
            Some(Surface::Markdown)
        );
        assert_eq!(Surface::of("figure.png", false), None);
        assert_eq!(Surface::of("paper:1706.03762", true), Some(Surface::Paper));
    }

    #[test]
    fn a_command_run_comes_first_once_and_eight_are_kept() {
        let ids: Vec<String> = (0..8).map(|n| format!("c{n}")).collect();
        let next = remembered(&ids, "c3");
        assert_eq!(next[0], "c3");
        assert_eq!(next.iter().filter(|id| *id == "c3").count(), 1);
        let next = remembered(&next, "new");
        assert_eq!(next.len(), 8);
        assert_eq!(next[0], "new");
        assert_eq!(read(r#"["a", 3, "b"]"#), vec!["a", "b"]);
        assert!(read("{}").is_empty());
    }
}
