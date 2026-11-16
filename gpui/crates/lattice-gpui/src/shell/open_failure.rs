//! Why a project file did not open, as the Tauri app says it
//! (`src/app/file-open-failure.ts`): a text file past the editor's size
//! limit is not called binary. It gets an error notice with both sizes in
//! the interface's units and Show in Finder, where another app can open it.
//! Any other failure shows as it came, as an error notice from the app.

use std::path::Path;

use gpui::App;
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use crate::notices::{self, Notice, NoticeAction};

/// lattice-core's `too_large` text (`project/tree.rs`): the file's size and
/// the limit, in bytes.
fn too_large(message: &str) -> Option<(u64, u64)> {
    let rest = message
        .strip_prefix("This file is too large to open in the editor (")?
        .strip_suffix(" bytes).")?;
    let (size, limit) = rest.split_once(" bytes; the limit is ")?;
    Some((size.parse().ok()?, limit.parse().ok()?))
}

/// Say why `path` (in the project at `root`) did not open.
pub(crate) fn show(error: &anyhow::Error, root: Option<&Path>, path: &Path, cx: &mut App) {
    log::error!("{error:#}");
    let reported = error
        .chain()
        .find_map(|cause| too_large(&cause.to_string()).map(|sizes| (cause.to_string(), sizes)));
    let Some((_, (size, limit))) = reported else {
        notices::show(
            Notice::new(ToastLevel::Error, format!("{error:#}")).source(t!("App")),
            cx,
        );
        return;
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut notice = Notice::new(
        ToastLevel::Error,
        t!("{name} is too large to open in the editor", name = name),
    )
    .source(t!("App"))
    .detail(t!(
        "It is {size}; the editor opens files up to {limit}. Open it in another app instead.",
        size = crate::submission::format_size(size),
        limit = crate::submission::format_size(limit)
    ));
    if root.is_some() {
        let file = path.to_path_buf();
        notice = notice.action(NoticeAction::new(t!("Show in Finder"), move |_, cx| {
            cx.reveal_path(&file);
        }));
    }
    notices::show(notice, cx);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_reads_lattice_cores_sizes() {
        // The text lattice-core's `too_large` writes.
        let message = "This file is too large to open in the editor (12500000 bytes; the limit is 10000000 bytes).";
        assert_eq!(too_large(message), Some((12_500_000, 10_000_000)));
        assert_eq!(too_large("No such file or directory"), None);
    }
}
