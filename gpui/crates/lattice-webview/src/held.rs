//! What an island holds for its page until the page listens.

use crate::bridge::Outbound;

/// Hold `message` until the page listens: every response in order, and of
/// each event only the latest, in the place of the first, since a page that
/// has not loaded needs only where things stand (an island never shown would
/// otherwise gather an event per change on disk).
pub(crate) fn hold(queue: &mut Vec<Outbound>, message: Outbound) {
    let held = match &message {
        Outbound::Event { kind, .. } => queue.iter_mut().find(
            |held| matches!(held, Outbound::Event { kind: held_kind, .. } if held_kind == kind),
        ),
        Outbound::Response { .. } => None,
    };
    match held {
        Some(held) => *held = message,
        None => queue.push(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn a_page_not_yet_listening_gets_the_latest_of_each_event_and_every_response() {
        let mut queue = Vec::new();
        for revision in 0..100 {
            hold(
                &mut queue,
                Outbound::event("html:assets-changed", Value::Null),
            );
            hold(
                &mut queue,
                Outbound::event("html:render", json!({ "revision": revision })),
            );
        }
        hold(&mut queue, Outbound::response(1, Ok(json!("a"))));
        hold(&mut queue, Outbound::response(2, Err("b".into())));
        hold(
            &mut queue,
            Outbound::event("html:assets-changed", Value::Null),
        );
        assert_eq!(
            queue,
            vec![
                Outbound::event("html:assets-changed", Value::Null),
                Outbound::event("html:render", json!({ "revision": 99 })),
                Outbound::response(1, Ok(json!("a"))),
                Outbound::response(2, Err("b".into())),
            ]
        );
    }
}
