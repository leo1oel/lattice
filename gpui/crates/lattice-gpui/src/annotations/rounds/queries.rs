//! What the window reads of the rounds without running them: which
//! annotations a round can ask about, the open round and how far it has
//! come, and the order its proposals are reviewed in.

use lattice_core::project::{AnnotationRound, EditorComment};

/// The open round: the last one that has not settled.
pub(super) fn open_round(rounds: &[AnnotationRound]) -> Option<&AnnotationRound> {
    rounds.last().filter(|round| round.settled_at.is_none())
}

fn state(comment: &EditorComment) -> Option<&str> {
    comment.revision.as_ref().map(|revision| revision.state.as_str())
}

/// A local annotation the agent can be asked about now.
pub fn revisable(comment: &EditorComment, running: &dyn Fn(&str) -> bool) -> bool {
    if comment.number == 0 || comment.resolved || running(&comment.id) {
        return false;
    }
    match comment.revision.as_ref() {
        Some(revision) if revision.state == "proposed" => false,
        // A question waits for its answer.
        Some(revision) if revision.state == "asked" => {
            revision.answer.as_deref().is_some_and(|answer| !answer.trim().is_empty())
        }
        _ => true,
    }
}

/// Proposals still waiting for the writer, in the order the review walks
/// them: by file, then place, then number.
pub fn pending_proposals(annotations: &[&EditorComment]) -> Vec<EditorComment> {
    let mut proposals: Vec<EditorComment> = annotations
        .iter()
        .filter(|comment| !comment.resolved && state(comment) == Some("proposed"))
        .map(|comment| (*comment).clone())
        .collect();
    proposals.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.from.cmp(&right.from))
            .then(left.number.cmp(&right.number))
    });
    proposals
}

/// The open round's progress: its number, how many annotations it asked
/// about, how many are answered and how many still run.
pub fn round_progress(
    rounds: &[AnnotationRound],
    annotations: &[&EditorComment],
    running: &dyn Fn(&str) -> bool,
) -> Option<(u32, usize, usize, usize)> {
    let round = open_round(rounds)?;
    let ids: Vec<&String> = round.outcomes.keys().collect();
    let answered = annotations
        .iter()
        .filter(|comment| {
            ids.contains(&&comment.id)
                && !running(&comment.id)
                && comment.revision.as_ref().is_some_and(|revision| revision.round == round.number)
        })
        .count();
    let still = ids.iter().filter(|id| running(id)).count();
    Some((round.number, ids.len(), answered, still))
}
