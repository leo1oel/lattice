//! Named regions for the parity harness (`gpui/parity/`), which compares the
//! GPUI app with the Tauri app region by region.
//!
//! A region is a part of the window the harness compares with the element
//! that draws the same thing in the Tauri app: the titlebar, a panel card,
//! a tab, a tree row. Its place is recorded by a [`probe`], an empty element
//! laid over its parent, which notes the parent's bounds each time it is
//! prepainted. A [`text_probe`] inside the element that holds a label notes
//! the text style that label is drawn in (family, size, weight, line
//! height), as GPUI resolves it there.
//!
//! Probes cost nothing unless a parity run [`enable`]d them: they are not
//! even added to the tree. A recorded region keeps its last value. Cached
//! views skip prepaint while nothing in them changes, so the registry is
//! never cleared between frames; the parity scene is static, so the last
//! value is the one on screen.

use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

use gpui::{AnyElement, Bounds, IntoElement, Pixels, SharedString, Styled as _, canvas};

static ENABLED: AtomicBool = AtomicBool::new(false);

thread_local! {
    // GPUI prepaints on the main thread only.
    static REGIONS: RefCell<BTreeMap<SharedString, Region>> = RefCell::default();
}

/// The text style a label is drawn in, in logical pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct TextLook {
    pub family: SharedString,
    pub size: f32,
    pub weight: f32,
    pub line_height: f32,
}

/// What the probes recorded under one name.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Region {
    /// In logical pixels, from the window's top-left corner.
    pub bounds: Option<Bounds<Pixels>>,
    pub text: Option<TextLook>,
}

/// Turn the probes on, before the first frame of a parity run.
pub fn enable() {
    ENABLED.store(true, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Everything recorded so far, by name.
pub fn regions() -> BTreeMap<SharedString, Region> {
    REGIONS.with(|regions| regions.borrow().clone())
}

/// Record a region the harness cannot probe from inside the tree, such as the
/// editor's text, which Zed's editor styles from its settings.
pub fn record(name: impl Into<SharedString>, region: Region) {
    REGIONS.with(|regions| {
        regions.borrow_mut().insert(name.into(), region);
    });
}

fn update(name: SharedString, f: impl FnOnce(&mut Region)) {
    REGIONS.with(|regions| f(regions.borrow_mut().entry(name).or_default()));
}

/// Records its parent's bounds as region `name`. Add it as a child of the
/// element that is the region; it takes no space and draws nothing.
pub fn probe(name: impl Into<SharedString>) -> Option<AnyElement> {
    if !enabled() {
        return None;
    }
    let name = name.into();
    Some(
        canvas(
            move |bounds, _, _| update(name, |region| region.bounds = Some(bounds)),
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .into_any_element(),
    )
}

/// Records the text style in effect where it is placed as region `name`'s
/// text. Add it as a child of the element whose own text is the label.
pub fn text_probe(name: impl Into<SharedString>) -> Option<AnyElement> {
    if !enabled() {
        return None;
    }
    let name = name.into();
    Some(
        canvas(
            move |_, window, _| {
                let style = window.text_style();
                let rem = window.rem_size();
                let look = TextLook {
                    family: style.font_family.clone(),
                    size: f32::from(style.font_size.to_pixels(rem)),
                    weight: style.font_weight.0,
                    line_height: f32::from(style.line_height_in_pixels(rem)),
                };
                update(name, |region| region.text = Some(look));
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_0()
        .into_any_element(),
    )
}
