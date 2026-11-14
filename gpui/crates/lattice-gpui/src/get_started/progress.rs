//! How far the writer has come through the checklist
//! (`src/onboarding/get-started-progress.ts`): the steps done and the ones
//! skipped, the writer's across every window and project, kept as
//! `get-started.json` in the app's state folder so the checklist picks up
//! where it was left.
//!
//! The places where a step really happens (a sample build under a title of
//! the writer's own, a SyncTeX jump landing, another project entered) mark
//! it here as they happen, whether or not the checklist is open.

use std::path::PathBuf;

use gpui::{App, AppContext as _, Context, Entity, Global};
use serde_json::{Value, json};

use super::Step;

#[derive(Default)]
pub struct Progress {
    done: Vec<Step>,
    skipped: Vec<Step>,
    file: Option<PathBuf>,
}

struct ProgressGlobal(Entity<Progress>);

impl Global for ProgressGlobal {}

/// The steps named in `value`, a JSON list, in the checklist's order; a
/// name no step has (a later version's) is left out.
fn steps_in(value: Option<&Value>) -> Vec<Step> {
    let names: Vec<&str> = value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    Step::ALL
        .into_iter()
        .filter(|step| names.contains(&step.id()))
        .collect()
}

/// What a stored file says, `{ "done": [...], "skipped": [...] }` as the
/// Tauri app stores it; anything else is no progress.
pub(super) fn read(text: &str) -> (Vec<Step>, Vec<Step>) {
    let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    (steps_in(value.get("done")), steps_in(value.get("skipped")))
}

fn names(steps: &[Step]) -> Vec<&'static str> {
    steps.iter().map(|step| step.id()).collect()
}

/// Make the writer's progress, reading what an earlier run kept in `folder`.
pub fn install(folder: Option<PathBuf>, cx: &mut App) -> Entity<Progress> {
    if let Some(progress) = cx.try_global::<ProgressGlobal>() {
        return progress.0.clone();
    }
    let file = folder.map(|folder| folder.join("get-started.json"));
    let (done, skipped) = file
        .as_ref()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .map(|text| read(&text))
        .unwrap_or_default();
    let progress = cx.new(|_| Progress {
        done,
        skipped,
        file,
    });
    cx.set_global(ProgressGlobal(progress.clone()));
    progress
}

/// The writer's progress, made on first use with nowhere to keep it when
/// the app did not install it (a test, a scenario without a state folder).
pub fn global(cx: &mut App) -> Entity<Progress> {
    match cx.try_global::<ProgressGlobal>() {
        Some(progress) => progress.0.clone(),
        None => install(None, cx),
    }
}

/// The writer's progress to read, when there is any yet.
pub fn global_read(cx: &App) -> Option<&Progress> {
    cx.try_global::<ProgressGlobal>()
        .map(|progress| progress.0.read(cx))
}

/// A step happened: it is done for good, skipped or not.
pub fn mark(step: Step, cx: &mut App) {
    let progress = global(cx);
    if progress.read(cx).is_done(step) {
        return;
    }
    progress.update(cx, |progress, cx| {
        progress.done.push(step);
        progress.done.sort();
        progress.save(cx);
    });
}

pub fn skip(step: Step, cx: &mut App) {
    global(cx).update(cx, |progress, cx| {
        if !progress.skipped.contains(&step) {
            progress.skipped.push(step);
            progress.skipped.sort();
            progress.save(cx);
        }
    });
}

impl Progress {
    pub fn is_done(&self, step: Step) -> bool {
        self.done.contains(&step)
    }

    pub fn is_skipped(&self, step: Step) -> bool {
        self.skipped.contains(&step)
    }

    /// The file as it is written: small, so off the main thread only to
    /// keep the disk out of a frame.
    fn save(&self, cx: &mut Context<Self>) {
        cx.notify();
        let Some(file) = self.file.clone() else {
            return;
        };
        let text =
            json!({ "done": names(&self.done), "skipped": names(&self.skipped) }).to_string();
        cx.background_spawn(async move {
            if let Some(folder) = file.parent() {
                std::fs::create_dir_all(folder).ok();
            }
            if let Err(error) = std::fs::write(&file, text) {
                log::warn!("get started: could not keep progress: {error}");
            }
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tauri_apps_stored_shape_reads_back_in_the_checklists_order() {
        let (done, skipped) =
            read(r#"{"done":["jump","build","later-step",3],"skipped":["agent"]}"#);
        assert_eq!(done, vec![Step::Build, Step::Jump]);
        assert_eq!(skipped, vec![Step::Agent]);
    }

    #[test]
    fn anything_else_is_no_progress() {
        for text in ["", "null", "[]", r#"{"done":"build"}"#] {
            assert_eq!(read(text), (vec![], vec![]), "{text}");
        }
    }
}
