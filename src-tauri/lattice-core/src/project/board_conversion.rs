//! Opening a tldraw board: it is converted once into the board format, beside
//! the original, which stays as it was.

use super::paths::{extension, relative_to, safe_path};
use crate::board::{convert_tldr_file, TLDRAW_EXTENSION};
use crate::util::err;
use std::path::Path;

/// Convert the project's `.tldr` at `relative` and return the new
/// `.excalidraw`'s project path (see [`convert_tldr_file`]).
pub fn convert_tldr_board(root: &Path, relative: &str) -> Result<String, String> {
    let board = safe_path(root, relative)?;
    if extension(&board).as_deref() != Some(TLDRAW_EXTENSION) {
        return Err("Only tldraw boards (.tldr) can be converted.".to_string());
    }
    let converted = convert_tldr_file(&board)?;
    relative_to(&root.canonicalize().map_err(err)?, &converted)
}
