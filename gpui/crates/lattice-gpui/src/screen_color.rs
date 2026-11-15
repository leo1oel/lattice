//! A colour sampled from anywhere on screen, for a colour picker's
//! eyedropper, as the Tauri app's `sample_screen_color` takes it
//! (`src-tauri/src/macos_window.rs`): AppKit's system-wide `NSColorSampler`,
//! which owns the loupe, sampling across displays, Escape and screen
//! access, so the app neither captures the desktop nor asks for screen
//! recording itself.
//!
//! Elsewhere there is no sampler, and the eyedropper is not offered.

use futures::channel::oneshot;

/// Whether this platform can sample the screen.
pub fn available() -> bool {
    cfg!(target_os = "macos")
}

/// Open the sampler (on the main thread, where GPUI's handlers run) and
/// resolve with the chosen pixel as `#RRGGBB`, or `None` when the writer
/// cancels.
pub fn sample() -> oneshot::Receiver<Option<String>> {
    let (sender, receiver) = oneshot::channel();
    imp::sample(sender);
    receiver
}

#[cfg(target_os = "macos")]
mod imp {
    use std::{cell::RefCell, ptr::NonNull};

    use block2::RcBlock;
    use futures::channel::oneshot;
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};

    fn rgb_hex(red: f64, green: f64, blue: f64) -> String {
        let channel = |value: f64| (value.clamp(0., 1.) * 255.).round() as u8;
        format!(
            "#{:02X}{:02X}{:02X}",
            channel(red),
            channel(green),
            channel(blue)
        )
    }

    pub(super) fn sample(sender: oneshot::Sender<Option<String>>) {
        let sender = RefCell::new(Some(sender));
        let handler = RcBlock::new(move |color: *mut AnyObject| {
            let chosen = NonNull::new(color).and_then(|color| {
                // SAFETY: AppKit keeps the chosen NSColor alive for the
                // handler's call, and every message here is NSColor's and
                // NSColorSpace's own.
                unsafe {
                    let color = color.as_ref();
                    let space: Retained<AnyObject> =
                        msg_send![class!(NSColorSpace), sRGBColorSpace];
                    let srgb: Option<Retained<AnyObject>> =
                        msg_send![color, colorUsingColorSpace: &*space];
                    let srgb = srgb?;
                    let red: f64 = msg_send![&*srgb, redComponent];
                    let green: f64 = msg_send![&*srgb, greenComponent];
                    let blue: f64 = msg_send![&*srgb, blueComponent];
                    Some(rgb_hex(red, green, blue))
                }
            });
            if let Some(sender) = sender.borrow_mut().take() {
                let _ = sender.send(chosen);
            }
        });
        // SAFETY: the block has AppKit's NSColor callback signature, and the
        // sampler keeps itself alive until its session completes.
        unsafe {
            let sampler: Retained<AnyObject> = msg_send![class!(NSColorSampler), new];
            let _: () = msg_send![&*sampler, showSamplerWithSelectionHandler: &*handler];
        }
    }

    #[cfg(test)]
    mod tests {
        // `#RRGGBB` from AppKit's 0-to-1 components, rounded as the Tauri
        // command rounds them.
        #[test]
        fn components_become_a_hex_code() {
            assert_eq!(super::rgb_hex(1., 0.945, 0.651), "#FFF1A6");
            assert_eq!(super::rgb_hex(-0.1, 0.5, 2.), "#0080FF");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use futures::channel::oneshot;

    pub(super) fn sample(sender: oneshot::Sender<Option<String>>) {
        let _ = sender.send(None);
    }
}
