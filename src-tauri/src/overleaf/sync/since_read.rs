//! Whether a file changed on disk since the sync read it: a sync never writes
//! over or deletes an edit newer than what it planned against.

use crate::overleaf::files::{disk_path, MAX_SYNC_FILE_BYTES};
use std::fs;
use std::path::Path;

/// What became of `path` on disk since this sync read it there.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SinceRead {
    /// It still holds what was read (`None`: it was absent), so writing over
    /// it or deleting it loses nothing.
    Unchanged,
    /// The file this sync read was edited or deleted: the next sync reads the
    /// change as the local edit it is.
    Edited,
    /// Something this sync never read sits there — a file too large, not a
    /// regular file, under a symlinked folder, or unreadable. It is left
    /// alone, but syncing again would find exactly the same, so it is no edit
    /// to report.
    Unread,
}

/// The editor's own saves wait for a sync to finish, but an agent or another
/// program writes whenever it likes. Its edit is newer than anything the plan
/// knows about, so a file changed since the read is left exactly as it is.
/// Only a file within the size limit is ever read, here as in the sync's own
/// read of the project.
pub(super) fn since_read(root: &Path, path: &str, read: Option<&Vec<u8>>) -> SinceRead {
    let disk = disk_path(root, path);
    let meta = fs::symlink_metadata(&disk);
    let Some(read) = read else {
        return match meta {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SinceRead::Unchanged,
            _ => SinceRead::Unread,
        };
    };
    match meta {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_SYNC_FILE_BYTES => match fs::read(&disk) {
            Ok(bytes) if bytes == *read => SinceRead::Unchanged,
            _ => SinceRead::Edited,
        },
        _ => SinceRead::Edited,
    }
}
