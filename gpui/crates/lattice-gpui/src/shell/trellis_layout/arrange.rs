//! The open documents in a workspace's arrangement (`placesOf`,
//! `arrangeDocuments`, `filledSlots` and `keepDocumentSlot` in
//! `src/trellis/trellis-layout.ts`).

use indexmap::IndexMap;
use trellis::model::{LayoutDocument, PanelNode, Views};

use super::presets::Documents;
use super::{
    DocumentPlaces, Place, ROOT_PDF, document_slot, file_key, file_record, is_document_slot,
    is_document_view, map_panels, panels_of, tidy,
};

/// Where each document of `doc` sits: its panel, and whether it is in front
/// there.
pub fn places_of(doc: &LayoutDocument) -> DocumentPlaces {
    let mut places = DocumentPlaces::new();
    for panel in panels_of(doc, true) {
        for id in &panel.views {
            let key = file_key(doc.views.get(id));
            if !key.is_empty() && !places.contains_key(&key) {
                places.insert(
                    key,
                    Place {
                        panel: panel.id.clone(),
                        selected: panel.selected == *id,
                    },
                );
            }
        }
    }
    places
}

/// A workspace's arrangement (`doc`) holding the open documents. Each goes
/// back to the panel it sat in when this workspace last had it (`places`).
/// The others fill the slots nothing went back to, one each in tab order
/// (the active document into the active panel: its place, else the first
/// slot), and the rest join the active panel. Each keeps its view from
/// `current` (so its tab survives), and a panel shows the active document,
/// else the one it last showed. A slot no document fills stays, an empty
/// document panel; with no slot at all, the shell's tab sync gives the
/// documents a panel of their own. A known limit, as in the Tauri app: a
/// workspace saved with no PDF panel drops the other compiled documents'
/// PDF tabs, and each comes back on its document's next build.
pub fn arrange_documents(
    doc: &LayoutDocument,
    current: &LayoutDocument,
    documents: Documents,
    places: &DocumentPlaces,
) -> LayoutDocument {
    let mut views: Views = doc
        .views
        .iter()
        .filter(|(_, view)| !is_document_slot(Some(view)))
        .map(|(id, view)| (id.clone(), view.clone()))
        .collect();
    if views.contains_key("pdf")
        && let Some(pdf) = current.views.get("pdf").filter(|pdf| pdf.params.is_some())
    {
        views.insert("pdf".into(), pdf.clone());
    }
    // A slot's panel, by the panel's id; docked panels first.
    let mut slot_of: IndexMap<String, String> = IndexMap::new();
    for panel in panels_of(doc, true) {
        if let Some(slot) = panel
            .views
            .iter()
            .find(|id| is_document_slot(doc.views.get(*id)))
        {
            slot_of.insert(panel.id.clone(), slot.clone());
        }
    }
    let mut by_key: IndexMap<String, String> = IndexMap::new();
    for (id, view) in &current.views {
        let key = file_key(Some(view));
        if !key.is_empty() && !by_key.contains_key(&key) {
            by_key.insert(key, id.clone());
        }
    }
    let placed = |key: &str| -> Option<String> {
        places
            .get(key)
            .filter(|place| slot_of.contains_key(&place.panel))
            .map(|place| place.panel.clone())
    };
    let slots: Vec<String> = slot_of.keys().cloned().collect();
    let lead = placed(documents.active_key).or_else(|| slots.first().cloned());
    let mut members: IndexMap<String, Vec<String>> = IndexMap::new();
    let join =
        |panel: &str, key: &str, views: &mut Views, members: &mut IndexMap<String, Vec<String>>| {
            let id = match by_key.get(key) {
                Some(id) => {
                    views.insert(id.clone(), current.views[id].clone());
                    id.clone()
                }
                None => {
                    let id = trellis::model::uid("file");
                    views.insert(id.clone(), file_record(key));
                    id
                }
            };
            members.entry(panel.to_string()).or_default().push(id);
        };
    if let Some(lead) = &lead {
        let mut loose: Vec<String> = Vec::new();
        for key in documents.keys() {
            if let Some(panel) = placed(&key) {
                join(&panel, &key, &mut views, &mut members);
            } else if key == documents.active_key {
                join(lead, &key, &mut views, &mut members);
            } else {
                loose.push(key);
            }
        }
        let mut loose = loose.into_iter();
        for panel in &slots {
            if !members.contains_key(panel)
                && let Some(key) = loose.next()
            {
                join(panel, &key, &mut views, &mut members);
            }
        }
        for key in loose {
            join(lead, &key, &mut views, &mut members);
        }
    }
    let active = (!documents.active_key.is_empty())
        .then(|| {
            by_key.get(documents.active_key).cloned().or_else(|| {
                views
                    .iter()
                    .find(|(_, view)| file_key(Some(view)) == documents.active_key)
                    .map(|(id, _)| id.clone())
            })
        })
        .flatten();
    // The compiled documents' PDF tabs are the project's: they stay open,
    // with the live PDF.
    let pdf_tabs: Vec<String> = current
        .views
        .iter()
        .filter(|(_, view)| view.kind == ROOT_PDF)
        .map(|(id, _)| id.clone())
        .collect();
    let mut out = map_panels(doc, |panel| {
        let mut panel = fill_slot(
            panel,
            &slot_of,
            &members,
            active.as_deref(),
            places,
            doc,
            &mut views,
        );
        if panel.views.iter().any(|id| id == "pdf") && !pdf_tabs.is_empty() {
            for id in &pdf_tabs {
                views.insert(id.clone(), current.views[id].clone());
                if !panel.views.contains(id) {
                    panel.views.push(id.clone());
                }
            }
        }
        panel
    });
    out.views = views;
    tidy(&out)
}

/// `panel` with its slot replaced by the documents that went there, or kept
/// when none did.
fn fill_slot(
    panel: &PanelNode,
    slot_of: &IndexMap<String, String>,
    members: &IndexMap<String, Vec<String>>,
    active: Option<&str>,
    places: &DocumentPlaces,
    doc: &LayoutDocument,
    views: &mut Views,
) -> PanelNode {
    let Some(slot) = slot_of.get(&panel.id) else {
        return panel.clone();
    };
    let filled = members.get(&panel.id).cloned().unwrap_or_default();
    if filled.is_empty() {
        views.insert(slot.clone(), doc.views[slot].clone());
        return panel.clone();
    }
    let ids: Vec<String> = panel
        .views
        .iter()
        .flat_map(|id| {
            if id == slot {
                filled.clone()
            } else {
                vec![id.clone()]
            }
        })
        .collect();
    let front = filled
        .iter()
        .find(|id| Some(id.as_str()) == active)
        .or_else(|| {
            filled.iter().find(|id| {
                places
                    .get(&file_key(views.get(*id)))
                    .is_some_and(|place| place.selected)
            })
        })
        .unwrap_or(&filled[0])
        .clone();
    let shows_active = active.is_some_and(|active| filled.iter().any(|id| id == active));
    let selected = if panel.selected == *slot || shows_active {
        front
    } else {
        panel.selected.clone()
    };
    let selected = if ids.contains(&selected) {
        selected
    } else {
        ids.first()
            .cloned()
            .unwrap_or_else(|| panel.selected.clone())
    };
    PanelNode {
        id: panel.id.clone(),
        views: ids,
        selected,
    }
}

/// The slots of `doc`'s panels that hold a document now: they leave.
pub fn filled_slots(doc: &LayoutDocument) -> Vec<String> {
    panels_of(doc, true)
        .into_iter()
        .filter(|panel| {
            panel
                .views
                .iter()
                .any(|id| doc.views.get(id).is_some_and(|view| view.kind == "file"))
        })
        .flat_map(|panel| {
            panel
                .views
                .iter()
                .filter(|id| is_document_slot(doc.views.get(*id)))
                .cloned()
        })
        .collect()
}

/// `current`, just after `view_id` closed out of `previous`, keeping the
/// document panel it was the last document of as an empty slot, so closing
/// a document never changes the arrangement. `None` when the panel still
/// holds a document (or a slot).
pub fn keep_document_slot(
    previous: &LayoutDocument,
    current: &LayoutDocument,
    view_id: &str,
) -> Option<LayoutDocument> {
    let panel = panels_of(previous, true)
        .into_iter()
        .find(|target| target.views.iter().any(|id| id == view_id))?;
    if panel
        .views
        .iter()
        .any(|id| id != view_id && is_document_view(previous.views.get(id)))
    {
        return None;
    }
    let (slot, slot_record) = document_slot(&panel.id);
    let live = panels_of(current, true)
        .into_iter()
        .any(|target| target.id == panel.id);
    let at = panel.views.iter().position(|id| id == view_id).unwrap_or(0);
    let source = if live { current } else { previous };
    let mut out = map_panels(source, |target| {
        if target.id != panel.id {
            return target.clone();
        }
        let members: Vec<String> = if live {
            let at = at.min(target.views.len());
            let mut members = target.views.clone();
            members.insert(at, slot.clone());
            members
        } else {
            target
                .views
                .iter()
                .map(|id| {
                    if id == view_id {
                        slot.clone()
                    } else {
                        id.clone()
                    }
                })
                .collect()
        };
        let selected = if members.contains(&target.selected) {
            target.selected.clone()
        } else {
            slot.clone()
        };
        PanelNode {
            id: target.id.clone(),
            views: members,
            selected,
        }
    });
    out.views.insert(slot.clone(), slot_record);
    out.views.shift_remove(view_id);
    Some(out)
}
