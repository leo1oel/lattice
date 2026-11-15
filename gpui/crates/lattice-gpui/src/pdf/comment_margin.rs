//! Where the PDF's comment column stands each card (`pdf-comment-margin.ts`
//! in the Tauri app): beside its mark, the way Word and Google Docs keep a
//! comment level with its passage. Pure, so the alignment is tested without
//! a PDF.

/// A card to place: the height its mark stands at (in the pages' scroll
/// coordinates) and its own height.
#[derive(Clone, Debug, PartialEq)]
pub struct MarginCard {
    pub id: String,
    pub anchor: f32,
    pub height: f32,
}

/// The space between two cards that would otherwise touch.
pub const MARGIN_CARD_GAP: f32 = 8.;

/// Each card's top, in the order the cards were given. A card stands level
/// with its mark unless the card above reaches past it, when it moves down
/// just clear of that one. The open card (`active`) is the exception: it
/// always stands level with its mark, the cards after it move down clear of
/// it and the cards before it move up only as far as they must to clear it,
/// so the one being read or answered never drifts from its passage.
///
/// Cards are taken in their marks' order down the pages; two at one height
/// keep the order they were given in.
pub fn layout_margin_cards(cards: &[MarginCard], active: Option<&str>, gap: f32) -> Vec<f32> {
    let mut order: Vec<usize> = (0..cards.len()).collect();
    // A stable sort keeps two at one height in the order given.
    order.sort_by(|left, right| cards[*left].anchor.total_cmp(&cards[*right].anchor));
    let mut tops = vec![0.; cards.len()];
    let pinned = active.and_then(|active| order.iter().position(|&ix| cards[ix].id == active));
    let mut floor = f32::NEG_INFINITY;
    for (place, &ix) in order.iter().enumerate() {
        let card = &cards[ix];
        let top = if Some(place) == pinned {
            card.anchor
        } else {
            card.anchor.max(floor)
        };
        tops[ix] = top;
        floor = top + card.height + gap;
    }
    if let Some(pinned) = pinned.filter(|pinned| *pinned > 0) {
        let mut ceiling = tops[order[pinned]] - gap;
        for &ix in order[..pinned].iter().rev() {
            let top = tops[ix].min(ceiling - cards[ix].height);
            tops[ix] = top;
            ceiling = top - gap;
        }
    }
    tops
}

#[cfg(test)]
mod tests;
