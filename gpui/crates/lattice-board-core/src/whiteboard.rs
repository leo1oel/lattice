// Adapted from quiet.md's `crates/core/src/whiteboard.rs`
// (https://github.com/s1dashu/quiet-md, MIT License, Copyright (c) 2026
// s1dashu), a port of Excalidraw's file format
// (https://github.com/excalidraw/excalidraw @ 3a317b5, MIT License, Copyright
// (c) 2020 Excalidraw). See THIRD_PARTY_NOTICES.md.

//! A `.excalidraw` file: reading goes through `board::restore`, writing
//! through `board::json`; deleted elements are left out, as upstream's
//! export does.

use crate::board::json::serialize_as_json;
use crate::board::restore::{ExportedAppState, RestoreOpts, load_file};
use crate::board::types::{Element, FileData};
use std::collections::BTreeMap;

/// What the `.excalidraw` files Lattice writes say made them (`source`), as
/// the Tauri app's Excalidraw writes them.
pub const FILE_SOURCE: &str = "https://excalidraw.com";

/// One scene: its non-deleted elements in z-order, its files, and what a
/// file keeps of the app state (canvas color, grid).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Board {
    pub elements: Vec<Element>,
    pub files: BTreeMap<String, FileData>,
    pub app: ExportedAppState,
}

impl Board {
    /// A `.excalidraw` file's text; an empty file is an empty board.
    pub fn from_file(json: &str) -> Result<Board, String> {
        if json.trim().is_empty() {
            return Ok(Board::default());
        }
        let d = load_file(json, &RestoreOpts::load())?;
        Ok(Board {
            elements: d.elements.into_iter().filter(|e| !e.is_deleted).collect(),
            files: d.files,
            app: d.app_state,
        })
    }

    /// The official JSON, as a file holds it.
    pub fn file_json(&self) -> String {
        serialize_as_json(&self.elements, &self.app, &self.files, FILE_SOURCE) + "\n"
    }

    /// The board as it is in a file that changed outside (disk, git,
    /// Overleaf), merged with what is open: `base` is the file as the open
    /// board last read or wrote it, `local` the open board's elements
    /// (deleted ones included). Excalidraw's `reconcileElements` keeps the
    /// later version of each element (the lower `versionNonce` on a tie);
    /// a file leaves deleted elements out, so an element the outside change
    /// dropped is deleted here when the open board hadn't changed it since
    /// `base`, and one the open board added since `base` stays. The order
    /// is by fractional index, as upstream orders a reconciled scene.
    pub fn reconcile(local: &[Element], base: &Board, remote: Board) -> Vec<Element> {
        use rustc_hash::{FxHashMap, FxHashSet};
        let in_base: FxHashMap<&str, &Element> =
            base.elements.iter().map(|e| (e.id.as_str(), e)).collect();
        let mut remote_ids: FxHashSet<String> = FxHashSet::default();
        let local_by_id: FxHashMap<&str, &Element> =
            local.iter().map(|e| (e.id.as_str(), e)).collect();
        let mut out: Vec<Element> = Vec::with_capacity(remote.elements.len() + local.len());
        for r in remote.elements {
            remote_ids.insert(r.id.clone());
            match local_by_id.get(r.id.as_str()) {
                Some(l)
                    if l.version > r.version
                        || (l.version == r.version && l.version_nonce <= r.version_nonce) =>
                {
                    out.push((*l).clone())
                }
                _ => out.push(r),
            }
        }
        for l in local {
            if remote_ids.contains(&l.id) {
                continue;
            }
            let unchanged_since_base = in_base
                .get(l.id.as_str())
                .is_some_and(|b| b.version == l.version && b.version_nonce == l.version_nonce);
            if unchanged_since_base || l.is_deleted {
                continue;
            }
            out.push(l.clone());
        }
        crate::board::fractional_index::order_by_fractional_index(&mut out);
        out
    }

    /// Changes whenever an element does (`getSceneVersion` plus the count).
    pub fn version(&self) -> u64 {
        self.elements
            .iter()
            .fold(self.elements.len() as u64, |n, e| {
                n.wrapping_mul(31)
                    .wrapping_add(e.version as u64 ^ e.version_nonce as u64)
            })
    }
}
