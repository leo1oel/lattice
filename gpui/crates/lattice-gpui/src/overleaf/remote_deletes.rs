//! Files gone here but still on Overleaf (`use-overleaf-remote-deletes.ts`).
//! Deletion is never inferred from absence: an ordinary file obeys Settings
//! › Overleaf › "When you delete a file here" (leave it, remove it, or ask),
//! and app-owned leftovers are cleaned silently. Either needs the file's id,
//! which only the channel knows; without it the removal waits for a later
//! sync.

use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context};
use lattice_core::overleaf::RemoteDelete;
use lattice_i18n::t;
use lattice_settings::OverleafRemoteDelete;
use lattice_ui::components::ToastLevel;

use super::{bridge::OverleafBridge, sync};
use crate::{
    confirm::{self, Confirm},
    notices::{self, Notice},
};

/// Settle `paths`, deleted here and still on Overleaf. `automatic`: the
/// sync's own app-owned clutter, removed as it is.
pub(super) fn settle(
    bridge: &mut OverleafBridge,
    root: &Path,
    paths: Vec<String>,
    automatic: bool,
    cx: &mut Context<OverleafBridge>,
) {
    let policy = crate::settings::get(cx).overleaf_remote_delete;
    if !automatic && policy == OverleafRemoteDelete::Never {
        return;
    }
    let asking = !automatic && policy == OverleafRemoteDelete::Ask;
    let known: Vec<(String, String, String)> = paths
        .into_iter()
        .filter(|path| !(asking && bridge.declined(root, path)))
        .filter_map(|path| {
            bridge
                .entity(&path)
                .map(|(id, kind)| (path, id.clone(), kind.clone()))
        })
        .collect();
    if known.is_empty() || (asking && confirm::is_pending(cx)) {
        return;
    }
    if !asking {
        remove(root.to_path_buf(), known, automatic, false, cx);
        return;
    }
    let names = known
        .iter()
        .map(|(path, ..)| path.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let count = known.len();
    let (title, body) = if count == 1 {
        (
            t!("Remove one file from the Overleaf project?").to_string(),
            t!("{names} was deleted from the local project, but is still on Overleaf. Even if you remove it now, Overleaf's history will keep it.", names = &names).to_string(),
        )
    } else {
        (
            t!("Remove {0} files from the Overleaf project?", count).to_string(),
            t!("{names} were deleted from the local project, but are still on Overleaf. Even if you remove them now, Overleaf's history will keep them.", names = &names).to_string(),
        )
    };
    let this = cx.entity().downgrade();
    let declined = this.clone();
    let declined_root = root.to_path_buf();
    let declined_paths: Vec<String> = known.iter().map(|(path, ..)| path.clone()).collect();
    let confirmed_root = root.to_path_buf();
    confirm::ask(
        Confirm::new(title)
            .body(body)
            .confirm_label(t!("Delete on Overleaf too"))
            .destructive()
            .on_confirm(move |_, cx| {
                let known = known.clone();
                let root = confirmed_root.clone();
                this.update(cx, |bridge, cx| {
                    if bridge.is_current(&root) {
                        remove(root, known, false, true, cx);
                    }
                })
                .ok();
            })
            .on_cancel(move |cx| {
                declined
                    .update(cx, |bridge, _| {
                        for path in &declined_paths {
                            bridge.decline(&declined_root, path);
                        }
                    })
                    .ok();
            }),
        cx,
    );
}

/// Remove each of `known` (path, id, kind) from Overleaf, then say what
/// happened. A writer's deletion names its path, so lattice-core re-reads
/// Overleaf's history first and leaves a file a co-author edited meanwhile.
fn remove(
    root: PathBuf,
    known: Vec<(String, String, String)>,
    automatic: bool,
    asked: bool,
    cx: &mut Context<OverleafBridge>,
) {
    let run_root = root.clone();
    let task = cx.background_spawn(async move {
        let mut outcomes = Vec::new();
        for (path, id, kind) in known {
            let named = (!automatic).then_some(path.as_str());
            let (outcome, expired) = sync::delete_entity(&run_root, &kind, &id, named);
            let failed = outcome.is_err();
            outcomes.push((path, outcome, expired));
            if failed {
                break;
            }
        }
        outcomes
    });
    cx.spawn(async move |this, cx| {
        let outcomes = task.await;
        this.update(cx, |bridge, cx| {
            if !bridge.is_current(&root) {
                return;
            }
            let mut kept = Vec::new();
            let mut removed = 0usize;
            for (path, outcome, expired) in outcomes {
                if expired {
                    super::session_changed(cx);
                }
                match outcome {
                    Ok(RemoteDelete::Deleted) => removed += 1,
                    Ok(RemoteDelete::ChangedOnOverleaf) => kept.push(path),
                    Ok(RemoteDelete::BackHere) => {}
                    Err(error) => notices::show(
                        Notice::new(
                            ToastLevel::Error,
                            t!("Could not remove {0} from Overleaf: {1}", &path, &error),
                        ),
                        cx,
                    ),
                }
            }
            if automatic {
                return;
            }
            if !kept.is_empty() {
                let names = kept.join(", ");
                let single = kept.len() == 1;
                let message: String = match (asked, single) {
                    (true, true) => t!("{names} changed on Overleaf after you were asked, so it was not removed there. The next sync brings the newer version back here.", names = &names).into(),
                    (true, false) => t!("{names} changed on Overleaf after you were asked, so they were not removed there. The next sync brings the newer versions back here.", names = &names).into(),
                    (false, true) => t!("{names} changed on Overleaf since the last sync, so it was not removed there. The next sync brings the newer version back here.", names = &names).into(),
                    (false, false) => t!("{names} changed on Overleaf since the last sync, so they were not removed there. The next sync brings the newer versions back here.", names = &names).into(),
                };
                notices::show(Notice::new(ToastLevel::Info, message), cx);
            }
            if removed > 0 {
                let message: String = if removed == 1 {
                    t!("Removed one file from Overleaf").into()
                } else {
                    t!("Removed {removed} files from Overleaf", removed = removed).into()
                };
                notices::show(Notice::new(ToastLevel::Info, message), cx);
            }
        })
        .ok();
    })
    .detach();
}
