//! What a rebuild changed: the pages whose signatures differ, so only those
//! are drawn again (`changedPages` in `src/pdf/pdf-page-swap.ts`).

use std::collections::HashSet;

use lattice_core::pdf_pages::PageSignatures;

/// The pages whose signatures differ, or `None` when the document as a
/// whole changed.
pub(super) fn changed_pages(
    before: &PageSignatures,
    after: &PageSignatures,
) -> Option<HashSet<usize>> {
    if before.document != after.document || before.pages.len() != after.pages.len() {
        return None;
    }
    Some(
        after
            .pages
            .iter()
            .zip(&before.pages)
            .enumerate()
            .filter(|(_, (new, old))| new != old)
            .map(|(ix, _)| ix)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rebuild_redraws_only_the_pages_whose_signatures_changed() {
        let before = PageSignatures {
            document: "d".into(),
            pages: vec!["a".into(), "b".into(), "c".into()],
        };
        let after = PageSignatures {
            document: "d".into(),
            pages: vec!["a".into(), "B".into(), "c".into()],
        };
        assert_eq!(changed_pages(&before, &after), Some([1].into()));
        let renumbered = PageSignatures {
            document: "e".into(),
            ..after
        };
        assert_eq!(changed_pages(&before, &renumbered), None);
    }
}
