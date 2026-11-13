//! The first page of each recent project, as the welcome screen's desk shows
//! it (`src/project/first-pages.ts`): page 1 of the last PDF a build wrote,
//! with the venue whose template that build typeset, and when the paper
//! last changed.
//!
//! After every build that writes a PDF of a project's main document, the
//! PDF's place, its venue and a fingerprint of its bytes are kept, by
//! project, in `first-pages.json` in the app's state directory: an
//! up-to-date rebuild hands back the same bytes and changes nothing; other
//! bytes are an edit, dated now (the first PDF seen is not dated, as the
//! app's is not). Only the recent projects keep one. The page itself is
//! drawn when the desk shows, small, by the PDF worker every viewer shares.

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

use gpui::{App, AsyncApp, Global, RenderImage, Task};
use serde::{Deserialize, Serialize};

use crate::{
    pdf::{PdfEngine, RenderRequest},
    recents::{RecentProjects, now_ms},
    shell::workspaces::{state_dir, write_json},
};

const FILE: &str = "first-pages.json";
/// Twice the desk card's width, so the page stays sharp on a Retina screen.
const RENDER_WIDTH: u32 = 480;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    pdf: PathBuf,
    venue: Option<String>,
    fingerprint: u64,
    /// When a build last wrote other bytes: when the paper last changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    edited_at: Option<u64>,
}

pub struct FirstPages {
    dir: Option<PathBuf>,
    pages: BTreeMap<PathBuf, Stored>,
}

impl Global for FirstPages {}

/// A desk card's page: drawn, with its venue and when it last changed.
#[derive(Clone)]
pub struct ShownPage {
    pub image: Arc<RenderImage>,
    pub venue: Option<String>,
    pub edited_at: Option<u64>,
}

/// FNV-1a over the bytes: the same PDF, or another.
fn fingerprint(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

impl FirstPages {
    pub fn init(scripted: bool, cx: &mut App) {
        let dir = state_dir(scripted);
        let pages = dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join(FILE)).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        cx.set_global(Self { dir, pages });
    }

    /// A build of `root` wrote `pdf`, typesetting `venue`'s template.
    pub fn record(root: PathBuf, pdf: PathBuf, venue: Option<String>, cx: &mut App) {
        if !cx.has_global::<Self>() {
            return;
        }
        cx.spawn(async move |cx: &mut AsyncApp| {
            let read = pdf.clone();
            let Some(print) = cx
                .background_executor()
                .spawn(async move { std::fs::read(&read).ok().map(|bytes| fingerprint(&bytes)) })
                .await
            else {
                return;
            };
            cx.update(|cx| {
                let keep: Vec<PathBuf> = RecentProjects::list(cx)
                    .iter()
                    .map(|recent| recent.path.clone())
                    .collect();
                let store = cx.global_mut::<Self>();
                let stored = store.pages.get(&root);
                if stored.is_some_and(|stored| {
                    stored.fingerprint == print && stored.venue == venue && stored.pdf == pdf
                }) {
                    return;
                }
                let edited_at = match stored {
                    None => None,
                    Some(stored) if stored.fingerprint == print => stored.edited_at,
                    Some(_) => Some(now_ms()),
                };
                store.pages.insert(
                    root.clone(),
                    Stored {
                        pdf,
                        venue,
                        fingerprint: print,
                        edited_at,
                    },
                );
                store
                    .pages
                    .retain(|path, _| *path == root || keep.contains(path));
                if let Some(dir) = &store.dir
                    && let Err(error) = write_json(&dir.join(FILE), &store.pages)
                {
                    log::warn!("could not save the first pages: {error:#}");
                }
            });
        })
        .detach();
    }

    /// Keep `pdf` as `root`'s page, first seen, for a scenario that stages
    /// the desk.
    #[cfg(target_os = "macos")]
    pub fn stage(root: PathBuf, pdf: PathBuf, venue: &str, cx: &mut App) {
        if cx.has_global::<Self>() {
            cx.global_mut::<Self>().pages.insert(
                root,
                Stored {
                    pdf,
                    venue: Some(venue.to_string()),
                    fingerprint: 0,
                    edited_at: None,
                },
            );
        }
    }

    /// Each of `roots`' stored first page, drawn; a project without one (or
    /// whose PDF is gone) is left out.
    pub fn load(roots: &[PathBuf], cx: &mut App) -> Task<HashMap<PathBuf, ShownPage>> {
        let wanted: Vec<(PathBuf, Stored)> = cx
            .try_global::<Self>()
            .map(|store| {
                roots
                    .iter()
                    .filter_map(|root| Some((root.clone(), store.pages.get(root)?.clone())))
                    .collect()
            })
            .unwrap_or_default();
        let engine = if wanted.is_empty() {
            None
        } else {
            PdfEngine::global(cx).ok()
        };
        cx.spawn(async move |cx: &mut AsyncApp| {
            let mut shown = HashMap::new();
            let Some(engine) = engine else {
                return shown;
            };
            for (root, stored) in wanted {
                if let Some(image) = draw_first_page(&engine, &stored.pdf, cx).await {
                    shown.insert(
                        root,
                        ShownPage {
                            image,
                            venue: stored.venue,
                            edited_at: stored.edited_at,
                        },
                    );
                }
            }
            shown
        })
    }
}

async fn draw_first_page(
    engine: &Arc<PdfEngine>,
    pdf: &Path,
    cx: &mut AsyncApp,
) -> Option<Arc<RenderImage>> {
    let path = pdf.to_path_buf();
    let bytes = cx
        .background_executor()
        .spawn(async move { std::fs::read(path).ok() })
        .await?;
    let doc = engine.new_document();
    let drawn = async {
        let info = engine.open(doc, bytes).await.ok()?.ok()?;
        let page = engine
            .render(RenderRequest {
                doc,
                generation: info.generation,
                page: 0,
                width_px: RENDER_WIDTH,
                region: None,
                dark: false,
                cancel: Arc::new(AtomicBool::new(false)),
            })
            .await
            .ok()?
            .ok()?;
        Some(page.image)
    }
    .await;
    engine.close(doc);
    drawn
}

#[cfg(test)]
mod tests {
    use super::fingerprint;

    #[test]
    fn the_same_bytes_print_the_same() {
        assert_eq!(fingerprint(b"%PDF-1.5"), fingerprint(b"%PDF-1.5"));
        assert_ne!(fingerprint(b"%PDF-1.5"), fingerprint(b"%PDF-1.6"));
    }
}
