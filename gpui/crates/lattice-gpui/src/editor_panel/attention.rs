//! The editor's attention motions, the moments it marks text for the
//! writer's eye (`lattice_ui::attention` has their timing):
//!
//! - [`reveal_flash`]: a jump's target line flashed.

pub(crate) mod reveal_flash;

pub(super) use reveal_flash::flash;
