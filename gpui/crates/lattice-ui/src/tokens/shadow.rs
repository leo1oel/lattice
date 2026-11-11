//! The elevation ladder's shadow stacks, light and dark.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

use crate::token_types::{ShadowToken, layer, rgba8};

// Shadows

/// App: `--shadow-raised`.
pub const SHADOW_RAISED: ShadowToken = ShadowToken {
    light: &[
        layer(0.0, 1.0, 2.0, 0.0, rgba8(0, 0, 0, 0.06)),
        layer(0.0, 1.0, 4.0, 0.0, rgba8(0, 0, 0, 0.04)),
    ],
    dark: &[
        layer(0.0, 1.0, 2.0, 0.0, rgba8(0, 0, 0, 0.24)),
        layer(0.0, 1.0, 4.0, 0.0, rgba8(0, 0, 0, 0.16)),
    ],
};
/// App: `--shadow-popover`.
pub const SHADOW_POPOVER: ShadowToken = ShadowToken {
    light: &[
        layer(0.0, 17.5, 23.4, 0.0, rgba8(0, 0, 0, 0.04)),
        layer(0.0, 9.4, 12.5, 0.0, rgba8(0, 0, 0, 0.03)),
        layer(0.0, 5.25, 7.0, 0.0, rgba8(0, 0, 0, 0.02)),
        layer(0.0, 2.8, 3.7, -2.0, rgba8(0, 0, 0, 0.01)),
        layer(0.0, 1.2, 1.5, 0.0, rgba8(0, 0, 0, 0.01)),
    ],
    dark: &[
        layer(0.0, 17.5, 23.4, 0.0, rgba8(0, 0, 0, 0.16)),
        layer(0.0, 9.4, 12.5, 0.0, rgba8(0, 0, 0, 0.12)),
        layer(0.0, 5.25, 7.0, 0.0, rgba8(0, 0, 0, 0.08)),
        layer(0.0, 2.8, 3.7, -2.0, rgba8(0, 0, 0, 0.04)),
        layer(0.0, 1.2, 1.5, 0.0, rgba8(0, 0, 0, 0.04)),
    ],
};
/// App: `--shadow-floating`.
pub const SHADOW_FLOATING: ShadowToken = ShadowToken {
    light: &[
        layer(0.0, 25.0, 50.0, 0.0, rgba8(0, 0, 0, 0.05)),
        layer(0.0, 12.0, 24.0, 0.0, rgba8(0, 0, 0, 0.04)),
        layer(0.0, 6.0, 12.0, 0.0, rgba8(0, 0, 0, 0.03)),
        layer(0.0, 3.0, 6.0, 0.0, rgba8(0, 0, 0, 0.02)),
        layer(0.0, 1.5, 3.0, 0.0, rgba8(0, 0, 0, 0.02)),
    ],
    dark: &[
        layer(0.0, 25.0, 50.0, 0.0, rgba8(0, 0, 0, 0.2)),
        layer(0.0, 12.0, 24.0, 0.0, rgba8(0, 0, 0, 0.16)),
        layer(0.0, 6.0, 12.0, 0.0, rgba8(0, 0, 0, 0.12)),
        layer(0.0, 3.0, 6.0, 0.0, rgba8(0, 0, 0, 0.08)),
        layer(0.0, 1.5, 3.0, 0.0, rgba8(0, 0, 0, 0.08)),
    ],
};
/// App: `--shadow-dialog`.
pub const SHADOW_DIALOG: ShadowToken = ShadowToken {
    light: &[
        layer(0.0, 40.0, 80.0, 0.0, rgba8(0, 0, 0, 0.06)),
        layer(0.0, 20.0, 40.0, 0.0, rgba8(0, 0, 0, 0.05)),
        layer(0.0, 10.0, 20.0, 0.0, rgba8(0, 0, 0, 0.04)),
        layer(0.0, 5.0, 10.0, 0.0, rgba8(0, 0, 0, 0.03)),
        layer(0.0, 2.0, 4.0, 0.0, rgba8(0, 0, 0, 0.02)),
    ],
    dark: &[
        layer(0.0, 40.0, 80.0, 0.0, rgba8(0, 0, 0, 0.24)),
        layer(0.0, 20.0, 40.0, 0.0, rgba8(0, 0, 0, 0.2)),
        layer(0.0, 10.0, 20.0, 0.0, rgba8(0, 0, 0, 0.16)),
        layer(0.0, 5.0, 10.0, 0.0, rgba8(0, 0, 0, 0.12)),
        layer(0.0, 2.0, 4.0, 0.0, rgba8(0, 0, 0, 0.08)),
    ],
};
/// App: `--shadow-pdf-page`.
pub const SHADOW_PDF_PAGE: ShadowToken = ShadowToken {
    light: &[
        layer(0.0, 8.0, 24.0, 0.0, rgba8(22, 22, 24, 0.08)),
    ],
    dark: &[
        layer(0.0, 10.0, 28.0, 0.0, rgba8(0, 0, 0, 0.28)),
    ],
};
