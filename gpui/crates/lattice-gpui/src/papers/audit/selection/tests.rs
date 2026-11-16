//! Select all as the Tauri sheet's box reads (`bibliography-audit.tsx`:
//! `checked={selected.size === total}`, `indeterminate={selected.size < total}`).

use super::*;

#[test]
fn select_all_is_mixed_until_every_reference_is_ticked() {
    assert_eq!(select_all_state(1, 3), CheckState::Mixed);
    assert_eq!(select_all_state(2, 3), CheckState::Mixed);
    assert_eq!(select_all_state(3, 3), CheckState::On);
    // The bar is gone with nothing ticked; the box would be clear.
    assert_eq!(select_all_state(0, 3), CheckState::Off);
}
