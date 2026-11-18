//! Boards: Lattice's whiteboards, stored as Excalidraw scenes (`.excalidraw`).
//!
//! Plain Rust with no shell types, so the Tauri app and the GPUI app share the
//! empty scene a new board starts from and the one-time conversion of the
//! tldraw boards (`.tldr`) Lattice wrote before.

mod scene;
mod tldr;

pub use scene::{empty_scene, Element, Kind, Scene, EMPTY_SCENE};
pub use tldr::{convert_tldr, AssetReader};

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// The board file extension.
pub const BOARD_EXTENSION: &str = "excalidraw";
/// The extension of tldraw boards, converted when opened.
pub const TLDRAW_EXTENSION: &str = "tldr";

/// Convert the tldraw board at `board` into an `.excalidraw` beside it and
/// return the new file's path. The `.tldr` stays untouched, and an existing
/// file is never overwritten: `foo.tldr` becomes `foo.excalidraw`, else
/// `foo (converted).excalidraw`, `foo (converted 2).excalidraw`, …
pub fn convert_tldr_file(board: &Path) -> Result<PathBuf, String> {
    let name = board.file_name().and_then(|name| name.to_str()).unwrap_or("The board");
    let source =
        fs::read_to_string(board).map_err(|error| format!("{name} could not be read: {error}"))?;
    let folder = board.parent().unwrap_or(Path::new("."));
    let read_asset = |relative: &str| read_board_asset(folder, relative);
    let json = convert_tldr(&source, &read_asset)?.to_json();
    let stem = board.file_stem().and_then(|stem| stem.to_str()).unwrap_or("board");
    let candidates = std::iter::once(format!("{stem}.{BOARD_EXTENSION}"))
        .chain(std::iter::once(format!("{stem} (converted).{BOARD_EXTENSION}")))
        .chain((2..).map(|number| format!("{stem} (converted {number}).{BOARD_EXTENSION}")));
    for candidate in candidates {
        let target = folder.join(candidate);
        // create_new: a file that appeared since the check is still never replaced.
        match fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                file.write_all(json.as_bytes()).map_err(|error| {
                    format!("The converted board could not be written: {error}")
                })?;
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("The converted board could not be written: {error}")),
        }
    }
    unreachable!("an unbounded name search always finds a free name")
}

/// An image a board refers to by a path inside its folder. Paths that climb
/// out of it, and links, are not followed.
fn read_board_asset(folder: &Path, relative: &str) -> Option<Vec<u8>> {
    let path = Path::new(relative);
    if !path.components().all(|part| matches!(part, Component::Normal(_) | Component::CurDir)) {
        return None;
    }
    let path = folder.join(path);
    fs::symlink_metadata(&path).ok().filter(|metadata| metadata.is_file())?;
    fs::read(path).ok()
}

#[cfg(test)]
mod tests;
