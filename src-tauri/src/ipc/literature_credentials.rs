//! Settings › Literature's provider keys and Crossref contact
//! (`literature_credentials`).

use crate::literature_credentials::{
    self, LiteratureCredentialStatus, LiteratureCredentialTest, LiteratureProvider,
};

#[tauri::command]
pub async fn get_literature_credentials() -> Result<LiteratureCredentialStatus, String> {
    literature_credentials::get_literature_credentials().await
}

#[tauri::command]
pub async fn set_literature_credential(
    provider: LiteratureProvider, secret: Option<String>,
) -> Result<LiteratureCredentialStatus, String> {
    literature_credentials::set_literature_credential(provider, secret).await
}

#[tauri::command]
pub async fn set_literature_contact(email: String) -> Result<LiteratureCredentialStatus, String> {
    literature_credentials::set_literature_contact(email).await
}

#[tauri::command]
pub async fn test_literature_credential(
    provider: LiteratureProvider, secret: Option<String>,
) -> Result<LiteratureCredentialTest, String> {
    literature_credentials::test_literature_credential(provider, secret).await
}
