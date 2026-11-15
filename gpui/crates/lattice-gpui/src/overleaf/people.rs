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

/// Every hue the live channel told of, keyed as the Tauri app's
/// `collabPeopleHues` keys them (`name:…`, `email:…` in lower case), for
/// the pages that run its React review cards: the suggestions' authors
/// first, then the people online, who win over a name that merely matches.
pub fn people_hues(bridge: &OverleafBridge, path: &str) -> Vec<(String, u32)> {
    let mut hues: Vec<(String, u32)> = Vec::new();
    let mut set = |key: String, hue: u32| match hues.iter_mut().find(|(known, _)| *known == key) {
        Some(entry) => entry.1 = hue,
        None => hues.push((key, hue)),
    };
    if let Some(review) = bridge.live_review(path) {
        for change in &review.changes {
            if let Some(name) = bridge.author_name(change.user_id.as_deref()) {
                set(format!("name:{}", name.trim()), change.hue);
            }
        }
    }
    for peer in bridge.peers() {
        if !peer.name.trim().is_empty() {
            set(format!("name:{}", peer.name.trim()), peer.hue);
        }
        if let Some(email) = &peer.email {
            set(format!("email:{}", email.trim().to_lowercase()), peer.hue);
        }
    }
    hues
}
