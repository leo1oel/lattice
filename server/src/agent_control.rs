//! Host-owned files never live beneath an agent-writable directory.
use std::{fs, path::Path};
pub fn create(path: &Path, bytes: Option<&[u8]>) -> Result<fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "Could not create a private agent control file".to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Agent control files must be regular files".into());
    }
    if let Some(bytes) = bytes {
        std::io::Write::write_all(&mut file, bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    Ok(file)
}
