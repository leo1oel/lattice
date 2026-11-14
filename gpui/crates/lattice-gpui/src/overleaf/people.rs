//! One colour per person across everything Overleaf collaboration draws:
//! the presence chips, comment threads, suggestions and the comment marks
//! in the source (`src/overleaf/overleaf-collab-people.ts`).
//!
//! Overleaf gives each account a hue, but only two things carry it here:
//! the people online now and the authors of suggestions. Comments name
//! their author and, at most, an email, so a comment's colour is the hue
//! known for that email, else that name (presence winning over a
//! suggestion author who merely shares it); someone with no known hue takes
//! the palette colour of their email or name.

use gpui::Hsla;
use lattice_editor::remote_cursors::hue_color;

use super::bridge::OverleafBridge;

/// Overleaf's hue for "you": the blue its own editor reserves for the
/// account looking at it.
pub const OWN_HUE: u32 = 200;

/// The person's colour: their Overleaf hue, else the palette colour Lattice
/// gives their email or name.
pub fn person_color(bridge: &OverleafBridge, name: &str, email: Option<&str>, mine: bool) -> Hsla {
    if mine {
        return hue_color(OWN_HUE as f32);
    }
    let peers = bridge.peers();
    let by_email = email.and_then(|email| {
        peers.iter().find(|peer| {
            peer.email
                .as_deref()
                .is_some_and(|theirs| theirs.trim().eq_ignore_ascii_case(email.trim()))
        })
    });
    let by_name = || {
        peers
            .iter()
            .find(|peer| peer.name.trim() == name.trim() && !name.trim().is_empty())
    };
    if let Some(peer) = by_email.or_else(by_name) {
        return hue_color(peer.hue as f32);
    }
    let suggested = bridge.suggestion_hue_of(name);
    if let Some(hue) = suggested {
        return hue_color(hue as f32);
    }
    crate::history::widgets::peer_color(email.filter(|email| !email.is_empty()).unwrap_or(name))
}
