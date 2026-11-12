//! A link card's title, description and icon (`link_preview`).

use crate::link_preview::{self, LinkPreviewResult};

#[tauri::command]
pub async fn link_preview(url: String) -> LinkPreviewResult {
    link_preview::link_preview(url).await
}
