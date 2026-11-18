// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! List markers advanced by duplication (`1. foo` duplicates as `2. foo`).
//! Port of Excalidraw `packages/element/src/listMarker.ts` @ 3a317b5.
//! Upstream's lookahead `(?=\s|$)` is checked by hand after the match; `\s`
//! and `\d` keep their JavaScript meaning. Indices are byte offsets
//! (upstream: UTF-16 units).

use super::binding::BindingStore;
use super::scene::Scene;
use super::text::{
    get_bound_text_element, get_container_element, mutate_in, redraw_text_bounding_box,
    refresh_text_dimensions,
};
use super::text_measure::Measure;
use super::text_wrapping::js_space;
use super::types::Element;
use regex::Regex;
use std::sync::LazyLock;

const JS_SPACE_CLASS: &str =
    r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
/// `1.`, `1)`, `(1)`, `[1]`, `a.`, `a)`, `(a)`, `A.`, `iv.` … at the start.
static LIST_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^([{JS_SPACE_CLASS}]*)(?:\(([0-9]{{1,9}}|[a-zA-Z]+)\)|\[([0-9]{{1,9}})\]|([0-9]{{1,9}}|[a-zA-Z]+)([.)]))")).unwrap()
});
/// A text that's just a number (a step badge).
static LONE_NUMBER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([{JS_SPACE_CLASS}]*)([0-9]{{1,9}})[{JS_SPACE_CLASS}]*$"
    ))
    .unwrap()
});

/// Letters below `i` count alphabetically, from `i` up as roman numerals.
const LAST_ALPHA_ORDINAL: u32 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListMarkerKind {
    Decimal,
    Alpha,
    Roman,
}

impl ListMarkerKind {
    fn name(self) -> &'static str {
        match self {
            Self::Decimal => "decimal",
            Self::Alpha => "alpha",
            Self::Roman => "roman",
        }
    }
    /// `MAX_ORDINAL`: lists count to 42 (so `2024. foo` isn't one), letters
    /// to `i`, roman numerals to `xcix`.
    fn max_ordinal(self) -> u32 {
        match self {
            Self::Decimal => 42,
            Self::Alpha => 9,
            Self::Roman => 99,
        }
    }
}

fn to_roman(v: u32) -> String {
    const TENS: [&str; 10] = ["", "x", "xx", "xxx", "xl", "l", "lx", "lxx", "lxxx", "xc"];
    const ONES: [&str; 10] = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"];
    format!("{}{}", TENS[(v / 10) as usize], ONES[(v % 10) as usize])
}
fn roman_value(s: &str) -> Option<u32> {
    (1..=ListMarkerKind::Roman.max_ordinal()).find(|&v| to_roman(v) == s)
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListMarker {
    /// Where the marker's value starts in the text.
    pub index: usize,
    pub value: String,
    pub kind: ListMarkerKind,
    pub is_upper_case: bool,
    /// `1.` and `2.` share a style, `1.` and `(1)` don't.
    pub style: String,
    /// 1-based.
    pub ordinal: u32,
    /// Where the item's text (after the marker and whitespace) starts.
    pub content_index: usize,
}

fn parse_lone_number(text: &str) -> Option<ListMarker> {
    let c = LONE_NUMBER.captures(text)?;
    let value = c[2].to_owned();
    Some(ListMarker {
        index: c[1].len(),
        ordinal: value.parse().ok()?,
        value,
        kind: ListMarkerKind::Decimal,
        is_upper_case: false,
        style: "decimal".into(),
        content_index: text.len(),
    })
}

fn parse_list_marker(text: &str) -> Option<ListMarker> {
    let c = LIST_MARKER.captures(text)?;
    let end = c.get(0)?.end();
    // `(?=\s|$)`
    if text[end..].chars().next().is_some_and(|ch| !js_space(ch)) {
        return None;
    }
    let (paren, bracket, plain) = (c.get(2), c.get(3), c.get(4));
    let value = paren.or(bracket).or(plain)?.as_str().to_owned();
    let lower = value.to_lowercase();
    let is_upper_case = value.chars().any(|ch| ch.is_ascii_uppercase());
    let alpha_ordinal = (lower.as_bytes()[0] as i64 - b'a' as i64 + 1) as i32;
    let (kind, ordinal) = if value.chars().any(|ch| ch.is_ascii_digit()) {
        (ListMarkerKind::Decimal, value.parse().ok()?)
    } else if is_upper_case && value.chars().any(|ch| ch.is_ascii_lowercase()) {
        return None;
    }
    // mixed case
    else if value.len() == 1 && alpha_ordinal <= LAST_ALPHA_ORDINAL as i32 {
        (ListMarkerKind::Alpha, alpha_ordinal as u32)
    } else {
        (ListMarkerKind::Roman, roman_value(&lower)?)
    };
    let affixes = if paren.is_some() {
        "()"
    } else if bracket.is_some() {
        "[]"
    } else {
        c.get(5).map_or("", |m| m.as_str())
    };
    let rest = &text[end..];
    Some(ListMarker {
        index: c[1].len() + if plain.is_some() { 0 } else { 1 },
        value,
        kind,
        is_upper_case,
        style: format!(
            "{}{}{affixes}",
            kind.name(),
            if is_upper_case { "-upper" } else { "" }
        ),
        ordinal,
        content_index: end + (rest.len() - rest.trim_start_matches(js_space).len()),
    })
}

/// `getListItemMarker`: the marker the text starts with (or the number it
/// is), unless the text is a whole list (other lines start with markers of
/// the same style).
pub fn get_list_item_marker(text: &str) -> Option<ListMarker> {
    let marker = parse_lone_number(text).or_else(|| parse_list_marker(text))?;
    if marker.ordinal > marker.kind.max_ordinal() {
        return None;
    }
    if text[marker.index..]
        .split('\n')
        .skip(1)
        .any(|l| parse_list_marker(l).is_some_and(|m| m.style == marker.style))
    {
        return None;
    }
    Some(marker)
}

/// `renumberListMarker`: None past `MAX_ORDINAL`.
pub fn renumber_list_marker(text: &str, marker: &ListMarker, ordinal: u32) -> Option<String> {
    if ordinal > marker.kind.max_ordinal() {
        return None;
    }
    let mut value = match marker.kind {
        // keeps zero padding (`01.` → `02.`)
        ListMarkerKind::Decimal => {
            let width = if marker.value.starts_with('0') {
                marker.value.len()
            } else {
                0
            };
            format!("{ordinal:0width$}")
        }
        ListMarkerKind::Alpha => char::from(b'a' + (ordinal - 1) as u8).to_string(),
        ListMarkerKind::Roman => to_roman(ordinal),
    };
    if marker.is_upper_case {
        value = value.to_uppercase();
    }
    Some(format!(
        "{}{value}{}",
        &text[..marker.index],
        &text[marker.index + marker.value.len()..]
    ))
}

/// A marker advanced by duplication, to go back and forth (undo).
#[derive(Clone, Debug, PartialEq)]
pub struct ListMarkerAdvance {
    pub element_id: String,
    pub prev_original_text: String,
    pub next_original_text: String,
    /// Where the item's text starts in `next_original_text`.
    pub content_start: usize,
    /// The label's container before the label (may have) grown it.
    pub prev_container_size: Option<(f64, f64)>,
}

fn set_text(scene: &mut dyn BindingStore, id: &str, original_text: &str, m: &dyn Measure) {
    let Some(e) = scene.get_element(id).cloned() else {
        return;
    };
    let container = get_container_element(&e, &*scene).cloned();
    if let Some(c) = container {
        mutate_in(scene, id, |e| {
            if let Some(t) = e.text_mut() {
                t.original_text = original_text.into()
            }
        });
        // re-wraps the label, and grows the container if need be
        if let Some(e) = scene.get_element(id).cloned() {
            redraw_text_bounding_box(scene, &e, Some(&c.id), m);
        }
    } else {
        // re-wraps the text, keeping it anchored as per its alignment
        let dims = refresh_text_dimensions(&e, None, &*scene, Some(original_text), None, m);
        mutate_in(scene, id, |e| {
            if let Some(t) = e.text_mut() {
                t.original_text = original_text.into();
            }
            if let Some(d) = &dims {
                d.apply(e);
            }
        });
    }
}

/// `advanceDuplicatedListMarkers`: advances the markers of the duplicated
/// texts and labels (`duplicated`: the new elements, in the scene).
/// Several items continue the list from the highest of them, but only when
/// they're bare markers; nothing happens when anything but list items was
/// duplicated.
pub fn advance_duplicated_list_markers(
    duplicated: &[String],
    scene: &mut Scene,
    m: &dyn Measure,
) -> Vec<ListMarkerAdvance> {
    struct Item {
        text: Element,
        container: Option<Element>,
        marker: ListMarker,
    }
    let mut by_style: Vec<(String, Vec<Item>)> = vec![];
    for id in duplicated {
        let Some(e) = scene.get_non_deleted_element(id) else {
            continue;
        };
        // a label goes with its container
        if e.container_id()
            .is_some_and(|c| duplicated.iter().any(|d| d == c))
        {
            continue;
        }
        let text = if e.is_text() {
            Some(e)
        } else {
            get_bound_text_element(e, scene)
        };
        let Some((text, marker)) =
            text.and_then(|t| get_list_item_marker(&t.text()?.original_text).map(|m| (t, m)))
        else {
            return vec![];
        };
        let item = Item {
            container: (text.id != e.id).then(|| e.clone()),
            text: text.clone(),
            marker,
        };
        match by_style.iter_mut().find(|(s, _)| *s == item.marker.style) {
            Some((_, v)) => v.push(item),
            None => by_style.push((item.marker.style.clone(), vec![item])),
        }
    }
    let all: Vec<&Item> = by_style.iter().flat_map(|(_, v)| v).collect();
    if all.len() > 1
        && all
            .iter()
            .any(|i| i.marker.content_index < i.text.text().map_or(0, |t| t.original_text.len()))
    {
        return vec![];
    }
    let mut advances = vec![];
    for (_, mut items) in by_style {
        let max = items.iter().map(|i| i.marker.ordinal).max().unwrap_or(0);
        items.sort_by_key(|i| i.marker.ordinal);
        for (k, item) in items.iter().enumerate() {
            let prev = item.text.text().map_or("", |t| &t.original_text);
            let Some(next) = renumber_list_marker(prev, &item.marker, max + 1 + k as u32) else {
                continue;
            };
            advances.push(ListMarkerAdvance {
                element_id: item.text.id.clone(),
                prev_original_text: prev.into(),
                content_start: item.marker.content_index + next.len() - prev.len(),
                next_original_text: next.clone(),
                prev_container_size: item.container.as_ref().map(|c| (c.width, c.height)),
            });
            set_text(scene, &item.text.id, &next, m);
        }
    }
    advances
}

/// `applyListMarkerAdvances`: sets the markers back (`back`) or forth again.
pub fn apply_list_marker_advances(
    advances: &[ListMarkerAdvance],
    back: bool,
    scene: &mut dyn BindingStore,
    m: &dyn Measure,
) {
    for a in advances {
        let Some(e) = scene
            .get_element(&a.element_id)
            .filter(|e| e.is_text() && !e.is_deleted)
            .cloned()
        else {
            continue;
        };
        if back
            && let Some(c) = get_container_element(&e, &*scene).map(|c| c.id.clone())
            && let Some((w, h)) = a.prev_container_size
        {
            // labels only ever grow their containers
            mutate_in(scene, &c, |e| (e.width, e.height) = (w, h));
        }
        set_text(
            scene,
            &a.element_id,
            if back {
                &a.prev_original_text
            } else {
                &a.next_original_text
            },
            m,
        );
    }
}
