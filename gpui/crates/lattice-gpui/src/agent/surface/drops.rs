//! Files dragged in from the Finder onto the Agent panel, attached to its
//! composer as the Tauri app attaches them (`use-project-tree.ts`'s drop
//! handling, `agent-composer-files.ts`): the island takes the drag from
//! WebKit (`Island::accept_file_drops`), so Synara's frame never sees it,
//! and the page hears each phase (`agent:file-drag`). The page decides as
//! the Tauri app does whether the files are ones the Agent can read
//! (`classifyExternalProjectDrop`), lights the panel while they are over
//! it, and on the drop asks for their bytes (`read_agent_composer_files`),
//! which it relays into the composer as its "+" menu would.
//!
//! The bytes read are only those of the drop that just happened: a page
//! cannot have the app read a path it names.

use gpui::{AppContext as _, Context};
use serde_json::{Value, json};

use super::SynaraSurface;

impl SynaraSurface {
    /// A phase of a Finder drag over the page (`island:file-drop`).
    pub(super) fn file_dragged(&mut self, payload: &Value, cx: &mut Context<Self>) {
        let phase = payload
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("leave");
        let paths: Vec<String> = payload
            .get("paths")
            .and_then(Value::as_array)
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(|path| path.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if phase == "drop" {
            self.dropped = paths.clone();
        }
        self.post(
            "agent:file-drag",
            json!({ "phase": phase, "paths": paths }),
            cx,
        );
    }

    /// `read_agent_composer_files`, for the paths of the last drop alone.
    pub(super) fn read_dropped(&mut self, id: u64, cx: &mut Context<Self>) {
        let dropped = std::mem::take(&mut self.dropped);
        let read = cx.background_spawn(async move {
            lattice_core::project::read_agent_composer_files(&dropped)
                .and_then(|files| serde_json::to_value(files).map_err(|error| error.to_string()))
        });
        cx.spawn(async move |this, cx| {
            let answer = read.await;
            this.update(cx, |this, cx| {
                this.drop_read = Some(match &answer {
                    Ok(files) => Ok(files.as_array().map_or(0, Vec::len)),
                    Err(error) => Err(error.clone()),
                });
                this.respond(id, answer, cx);
            })
            .ok();
        })
        .detach();
    }

    /// How many files the page's last read of a drop took, or why it took
    /// none, for a scenario.
    pub fn drop_read(&self) -> Option<&Result<usize, String>> {
        self.drop_read.as_ref()
    }
}
