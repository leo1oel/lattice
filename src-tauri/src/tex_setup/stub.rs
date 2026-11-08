//! One-click TeX install helpers are macOS-only for now.

use tauri::ipc::Channel;

use super::{TexInstallMode, TexInstallProgress};

type Progress = Channel<TexInstallProgress>;

pub fn install_tex(_mode: TexInstallMode, _on_progress: &Progress) -> Result<(), String> {
    #[cfg(windows)]
    return Err("Installez TeX Live pour Windows (https://tug.org/texlive/windows.html), puis redémarrez Lattice. Les outils de recherche sont déjà inclus dans cette version.".into());
    #[cfg(not(windows))]
    Err("One-click TeX install is not available on Linux yet.".into())
}

pub fn install_dependency(_missing_file: &str, _on_progress: &Progress) -> Result<(), String> {
    #[cfg(windows)]
    return Err("Installez le paquet manquant avec TeX Live Manager ou MiKTeX Console, puis relancez la compilation.".into());
    #[cfg(not(windows))]
    Err("One-click TeX package install is not available on Linux yet.".into())
}
