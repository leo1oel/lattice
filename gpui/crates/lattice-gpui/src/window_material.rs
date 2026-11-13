//! The window's material: macOS vibrancy behind the interface, or an opaque
//! colour (Settings › Appearance › Translucency), as the Tauri app sets it
//! (`src/settings/use-appearance.ts`, `src-tauri/src/macos_window.rs`).
//!
//! A workspace window asked to be translucent gets the under-window material
//! (`NSVisualEffectView`, following the window's active state, so a window in
//! the background stops recompositing), below GPUI's view, with the window
//! and GPUI's layer turned clear. The palette then lays the titlebar, the
//! gutters, the Project and Papers cards and the welcome page over it at the
//! chosen strength (`Palette::with_glass`); everything else stays opaque.
//!
//! Reduce transparency (System Settings › Accessibility › Display) keeps the
//! window opaque, and the system only reports it when asked, so it is asked
//! again whenever a window comes forward. The window's `NSAppearance` follows
//! the theme the writer chose, as the Tauri app pins it, so the material is
//! light under a light theme on a dark system and the other way round.
//!
//! Elsewhere, and in a window other than a workspace's, the window stays
//! opaque and Settings says translucency is macOS-only.

use gpui::{App, Global, Window};
use lattice_settings::Translucency;
use lattice_ui::{ActiveLattice as _, Glass, LatticeTheme};

/// What turned out to be behind a workspace window (`WindowBacking` in
/// use-appearance.ts).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Backing {
    /// Vibrancy, at the chosen strength.
    Translucent,
    /// The writer chose Off.
    #[default]
    Opaque,
    /// Translucency was asked for, but Reduce transparency is on.
    ReducedTransparency,
    /// Not on this platform.
    Unsupported,
}

#[derive(Default)]
struct CurrentBacking(Backing);

impl Global for CurrentBacking {}

/// The backing the workspace windows have now, for Settings' note.
pub fn backing(cx: &App) -> Backing {
    cx.try_global::<CurrentBacking>()
        .map(|backing| backing.0)
        .unwrap_or_default()
}

fn glass(translucency: Translucency) -> Glass {
    match translucency {
        Translucency::Off => Glass::Off,
        Translucency::Subtle => Glass::Subtle,
        Translucency::Strong => Glass::Strong,
    }
}

/// Give `window` (a workspace window) the material the settings ask for,
/// and lay the palette over it. Called as the window opens, whenever it
/// comes forward and whenever the translucency or the theme changes.
pub fn apply(window: &mut Window, cx: &mut App) {
    let translucency = crate::settings::get(cx).appearance.translucency;
    // The appearance the writer (or the run) fixed, else the system's.
    let pinned = crate::app::appearance_chosen(cx).then(|| cx.palette().is_dark());
    let backing_now = platform::apply(window, translucency != Translucency::Off, pinned);
    if backing(cx) != backing_now {
        // Settings' note follows the backing even when the palette does not
        // change (Reduce transparency turned on while translucency is Off).
        cx.refresh_windows();
    }
    cx.set_global(CurrentBacking(backing_now));
    let glass = match backing_now {
        Backing::Translucent => glass(translucency),
        _ => Glass::Off,
    };
    LatticeTheme::set_glass(glass, cx);
}

/// Apply the material to every workspace window.
pub fn apply_all(cx: &mut App) {
    cx.defer(|cx| {
        crate::shell::windows::for_shells(cx, |_| true, |_, window, cx| apply(window, cx));
    });
}

#[cfg(target_os = "macos")]
mod platform {
    use gpui::{Window, WindowBackgroundAppearance};
    use objc2::{
        class, msg_send,
        runtime::{AnyObject, Bool},
    };
    use objc2_foundation::{NSRect, NSString};

    use super::Backing;

    /// The identifier the material's view carries, so it is found again
    /// among the content view's subviews instead of being kept by pointer.
    const MATERIAL_VIEW: &str = "lattice-window-material";
    /// `NSVisualEffectMaterialUnderWindowBackground`.
    const UNDER_WINDOW_BACKGROUND: isize = 21;
    /// `NSVisualEffectBlendingModeBehindWindow`.
    const BEHIND_WINDOW: isize = 0;
    /// `NSVisualEffectStateFollowsWindowActiveState`.
    const FOLLOWS_WINDOW_ACTIVE_STATE: isize = 0;
    /// `NSViewWidthSizable | NSViewHeightSizable`.
    const FILLS_SUPERVIEW: usize = 2 | 16;
    /// `NSWindowBelow`.
    const BELOW: isize = -1;

    fn reduce_transparency() -> bool {
        unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let reduce: Bool = msg_send![workspace, accessibilityDisplayShouldReduceTransparency];
            reduce.as_bool()
        }
    }

    pub fn apply(window: &mut Window, translucent: bool, dark: Option<bool>) -> Backing {
        let backing = if !translucent {
            Backing::Opaque
        } else if reduce_transparency() {
            Backing::ReducedTransparency
        } else {
            Backing::Translucent
        };
        let clear = backing == Backing::Translucent;
        let Ok(native) = crate::native::native(window) else {
            return Backing::Unsupported;
        };
        unsafe {
            let ns_window = native.ns_window();
            // The theme's appearance, or the system's when it follows it.
            let appearance: *mut AnyObject = match dark {
                Some(dark) => {
                    let name = NSString::from_str(if dark {
                        "NSAppearanceNameDarkAqua"
                    } else {
                        "NSAppearanceNameAqua"
                    });
                    msg_send![class!(NSAppearance), appearanceNamed: &*name]
                }
                None => std::ptr::null_mut(),
            };
            let _: () = msg_send![ns_window, setAppearance: appearance];
            show_material_view(ns_window, clear);
        }
        window.set_background_appearance(if clear {
            WindowBackgroundAppearance::Transparent
        } else {
            WindowBackgroundAppearance::Opaque
        });
        backing
    }

    /// Show or hide the window's material, adding it below GPUI's view the
    /// first time it is shown.
    unsafe fn show_material_view(ns_window: *mut AnyObject, shown: bool) {
        unsafe {
            let content: *mut AnyObject = msg_send![ns_window, contentView];
            if content.is_null() {
                return;
            }
            let identifier = NSString::from_str(MATERIAL_VIEW);
            let subviews: *mut AnyObject = msg_send![content, subviews];
            let count: usize = msg_send![subviews, count];
            for index in 0..count {
                let view: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
                let id: *mut AnyObject = msg_send![view, identifier];
                if !id.is_null() {
                    let same: Bool = msg_send![id, isEqualToString: &*identifier];
                    if same.as_bool() {
                        let _: () = msg_send![view, setHidden: Bool::new(!shown)];
                        return;
                    }
                }
            }
            if !shown {
                return;
            }
            let bounds: NSRect = msg_send![content, bounds];
            let view: *mut AnyObject = msg_send![class!(NSVisualEffectView), alloc];
            let view: *mut AnyObject = msg_send![view, initWithFrame: bounds];
            if view.is_null() {
                return;
            }
            let _: () = msg_send![view, setIdentifier: &*identifier];
            let _: () = msg_send![view, setMaterial: UNDER_WINDOW_BACKGROUND];
            let _: () = msg_send![view, setBlendingMode: BEHIND_WINDOW];
            let _: () = msg_send![view, setState: FOLLOWS_WINDOW_ACTIVE_STATE];
            let _: () = msg_send![view, setAutoresizingMask: FILLS_SUPERVIEW];
            let _: () = msg_send![
                content,
                addSubview: view,
                positioned: BELOW,
                relativeTo: std::ptr::null_mut::<AnyObject>()
            ];
            // The content view keeps it now.
            let _: () = msg_send![view, release];
        }
    }

    /// Whether the window has the material showing, for the e2e scenario.
    pub fn material_shown(window: &Window) -> bool {
        let Ok(native) = crate::native::native(window) else {
            return false;
        };
        unsafe {
            let content: *mut AnyObject = msg_send![native.ns_window(), contentView];
            if content.is_null() {
                return false;
            }
            let identifier = NSString::from_str(MATERIAL_VIEW);
            let subviews: *mut AnyObject = msg_send![content, subviews];
            let count: usize = msg_send![subviews, count];
            (0..count).any(|index| {
                let view: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
                let id: *mut AnyObject = msg_send![view, identifier];
                if id.is_null() {
                    return false;
                }
                let same: Bool = msg_send![id, isEqualToString: &*identifier];
                let hidden: Bool = msg_send![view, isHidden];
                same.as_bool() && !hidden.as_bool()
            })
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use gpui::Window;

    use super::Backing;

    pub fn apply(_: &mut Window, _: bool, _: Option<bool>) -> Backing {
        Backing::Unsupported
    }

    pub fn material_shown(_: &Window) -> bool {
        false
    }
}

pub use platform::material_shown;
