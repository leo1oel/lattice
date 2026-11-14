//! Inserting figures and tables into a document, ported from the Tauri
//! app's `src/editor/insert/`: what each inserts (`figure`, `table`), the
//! figure options dialog (`figure_dialog`) and the table generator
//! (`table_dialog`). The window wires them to the editor in front
//! (`shell/insert_flow.rs`).

pub mod figure;
pub mod figure_dialog;
pub mod table;
pub mod table_dialog;
