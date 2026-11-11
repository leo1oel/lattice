//! When a frame actually paints. A zero-size element placed after the editor
//! records the time its paint runs, which is the end of the editor's paint in
//! that frame; the scripted runs read it to time input to painted frame, the
//! GPUI counterpart of Lattice's keydown → requestAnimationFrame → setTimeout
//! measurement. Inert unless a scenario turns recording on.

use std::{cell::RefCell, time::Instant};

use gpui::{IntoElement, Styled as _, canvas};

thread_local! {
    static PAINTS: RefCell<Option<Vec<Instant>>> = const { RefCell::new(None) };
}

#[cfg(target_os = "macos")]
pub fn start_recording() {
    PAINTS.with(|paints| *paints.borrow_mut() = Some(Vec::new()));
}

/// The paint times recorded so far.
#[cfg(target_os = "macos")]
pub fn take() -> Vec<Instant> {
    PAINTS.with(|paints| paints.borrow_mut().replace(Vec::new()).unwrap_or_default())
}

#[cfg(target_os = "macos")]
pub fn stop_recording() {
    PAINTS.with(|paints| *paints.borrow_mut() = None);
}

pub fn probe() -> impl IntoElement {
    canvas(
        |_, _, _| {},
        |_, _, _, _| {
            PAINTS.with(|paints| {
                if let Some(paints) = paints.borrow_mut().as_mut() {
                    paints.push(Instant::now());
                }
            })
        },
    )
    .size_0()
}
