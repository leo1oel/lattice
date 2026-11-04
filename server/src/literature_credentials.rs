//! Headless credentials come from the service environment, never a desktop keychain.
fn read(names: &[&str]) -> Result<Option<String>, String> {
    Ok(names.iter().find_map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty())))
}
pub(crate) fn openalex_key() -> Result<Option<String>, String> {
    read(&["OPENALEX_API_KEY"])
}
pub(crate) fn semanticscholar_key() -> Result<Option<String>, String> {
    read(&["SEMANTIC_SCHOLAR_API_KEY", "S2_API_KEY"])
}
pub(crate) fn firecrawl_key() -> Result<Option<String>, String> {
    read(&["LATTICE_FIRECRAWL_KEY"])
}
pub(crate) fn crossref_contact() -> Result<Option<String>, String> {
    read(&["CROSSREF_MAILTO"])
}
