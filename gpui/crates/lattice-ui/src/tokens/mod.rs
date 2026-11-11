//! Every design token, one constant per `--name` in design-system/tokens.json
//! (`--color-window` is `COLOR_WINDOW`), split by concept.
//!
//! Sizes are rems of a 16px root, so the interface size setting scales them
//! through `Window::set_rem_size`. `code_themes` holds the code themes
//! from design-system/code-themes.json.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

mod presets;
mod glyphs;
mod syntax;
mod color;
mod typography;
mod space;
mod motion;
mod shadow;
mod code_themes;

pub use presets::*;
pub use glyphs::*;
pub use syntax::*;
pub use color::*;
pub use typography::*;
pub use space::*;
pub use motion::*;
pub use shadow::*;
pub use code_themes::*;
