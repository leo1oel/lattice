//! Opening a tldraw board: it is converted once into the board format, beside
//! the original, which stays as it was.

use super::paths::{extension, relative_to, safe_path};
use crate::board::{convert_tldr_file, BOARD_EXTENSION, TLDRAW_EXTENSION};
use crate::util::err;
use std::path::Path;

/// The project path of the board the project's `.tldr` at `relative` opens
/// as: the `.excalidraw` of the same name beside it, converted from it the
/// first time (see [`convert_tldr_file`]) and opened as it is after that.
pub fn convert_tldr_board(root: &Path, relative: &str) -> Result<String, String> {
    let board = safe_path(root, relative)?;
    if extension(&board).as_deref() != Some(TLDRAW_EXTENSION) {
        return Err("Only tldraw boards (.tldr) can be converted.".to_string());
    }
    let beside = board.with_extension(BOARD_EXTENSION);
    let converted = if beside.is_file() { beside } else { convert_tldr_file(&board)? };
    relative_to(&root.canonicalize().map_err(err)?, &converted)
}
