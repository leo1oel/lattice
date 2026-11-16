//! How a terminal's shell is started, for a host that runs the
//! pseudo-terminal itself: the GPUI app hands this to Zed's terminal, which
//! opens its own pty, so it cannot go through `pty::spawn_shell`.
//!
//! The program, its arguments and its environment are the ones
//! `pty::spawn_shell` (and `windows.rs` on Windows) give the Tauri app's
//! shells; keep the two in step.

use std::path::{Path, PathBuf};

/// The shell a terminal tab runs, and what it starts with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellLaunch {
    /// The writer's login shell (`/bin/zsh`), or PowerShell on Windows.
    pub program: PathBuf,
    /// `-l` on Unix, as every terminal app starts it.
    pub args: Vec<String>,
    /// Variables the shell starts with, over Lattice's own environment.
    pub env: Vec<(String, String)>,
    /// Variables of Lattice's own environment the shell must not inherit.
    pub env_remove: Vec<String>,
}

impl ShellLaunch {
    /// The program's name ("zsh"), for a terminal's tab.
    pub fn name(&self) -> String {
        self.program.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
    }
}

/// How a new terminal's shell starts: the login shell with Lattice's search
/// path, the terminal type a modern emulator reports and `TERM_PROGRAM`
/// naming Lattice.
pub fn shell_launch() -> ShellLaunch {
    let mut env = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERM_PROGRAM".to_string(), "Lattice".to_string()),
        ("TERM_PROGRAM_VERSION".to_string(), crate::VERSION.to_string()),
    ];
    #[cfg(unix)]
    {
        env.push(("PATH".to_string(), super::pty::starting_path().to_string_lossy().into_owned()));
        // A Finder launch has no locale; LC_CTYPE alone leaves messages in
        // the writer's language (pty.rs).
        if ["LC_ALL", "LC_CTYPE", "LANG"].iter().all(|name| std::env::var_os(name).is_none()) {
            env.push(("LC_CTYPE".to_string(), "UTF-8".to_string()));
        }
        ShellLaunch {
            program: super::pty::login_shell(),
            args: vec!["-l".to_string()],
            env,
            env_remove: vec!["LATTICE_PROJECT".to_string()],
        }
    }
    #[cfg(windows)]
    {
        env.push((
            "PATH".to_string(),
            crate::commands::child_path().to_string_lossy().into_owned(),
        ));
        ShellLaunch {
            program: super::windows::login_shell(),
            args: vec!["-NoLogo".to_string(), "-NoExit".to_string()],
            env,
            env_remove: vec!["LATTICE_PROJECT".to_string()],
        }
    }
}

/// The project folder as a shell can start in it. The root is canonicalized,
/// which on Windows spells it `\\?\C:\…` (or `\\?\UNC\…`); PowerShell (and
/// conda's hook) does not accept that as a starting directory and falls back
/// to System32 or shows a `FileSystem::\\?\` prompt. The conversion is the
/// one Node's entry points get (`sidecar::node_script_path`): ordinary drive
/// and UNC spellings, UTF-16 kept whole, other namespaces left alone. Off
/// Windows the root is unchanged.
pub fn shell_cwd(root: &Path) -> PathBuf {
    crate::sidecar::node_script_path(root)
}

/// The PowerShell statement that moves a shell into `dir` literally.
/// Windows PowerShell 5.1 reads `[` and `]` in its inherited working
/// directory as wildcards and falls back to `System32\WindowsPowerShell\v1.0`
/// (Overleaf projects are often named "[EMNLP] …"), so the folder is also set
/// with `-LiteralPath` once the shell is up.
pub fn set_location_script(dir: &Path) -> String {
    format!("Set-Location -LiteralPath {}", powershell_quote(&dir.to_string_lossy()))
}

/// PowerShell reads the curly quotes `‘ ’ ‚ ‛` as `'` and `“ ” „` as `"`, so
/// either delimiter can be closed early by text that looks harmless.
const SINGLE_QUOTES: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];
const DOUBLE_QUOTES: [char; 4] = ['"', '\u{201C}', '\u{201D}', '\u{201E}'];

/// `text` as one literal PowerShell string. Single quotes when the text has
/// none (nothing is special inside them); double quotes when it has single
/// quotes but no double ones, with `` ` `` and `$` escaped so nothing
/// expands; and with both, single quotes again with each single-quote
/// character doubled, which PowerShell reads as one.
pub fn powershell_quote(text: &str) -> String {
    if !text.contains(SINGLE_QUOTES) {
        return format!("'{text}'");
    }
    let (delimiter, special): (char, &[char]) = if text.contains(DOUBLE_QUOTES) {
        ('\'', &SINGLE_QUOTES)
    } else {
        ('"', &['`', '$'])
    };
    let mut quoted = String::with_capacity(text.len() + 8);
    quoted.push(delimiter);
    for c in text.chars() {
        if special.contains(&c) {
            quoted.push(if delimiter == '\'' { c } else { '`' });
        }
        quoted.push(c);
    }
    quoted.push(delimiter);
    quoted
}

#[cfg(test)]
mod set_location_tests {
    use super::{powershell_quote, set_location_script};
    use std::path::Path;

    #[test]
    fn brackets_stay_literal() {
        assert_eq!(
            set_location_script(Path::new(r"C:\Docs\[EMNLP] thesis")),
            r"Set-Location -LiteralPath 'C:\Docs\[EMNLP] thesis'"
        );
    }

    #[test]
    fn text_with_single_quotes_is_double_quoted_without_expansion() {
        assert_eq!(
            set_location_script(Path::new(r"C:\Docs\[EMNLP] Ada’s $HOME `n thesis")),
            "Set-Location -LiteralPath \"C:\\Docs\\[EMNLP] Ada’s `$HOME ``n thesis\""
        );
        assert_eq!(powershell_quote("Ada's ‘a’ ‚b‛"), "\"Ada's ‘a’ ‚b‛\"");
    }

    #[test]
    fn text_with_both_quote_kinds_doubles_every_single_quote() {
        assert_eq!(powershell_quote("Ada's “x” ’y‘ ‚z‛ $v"), "'Ada''s “x” ’’y‘‘ ‚‚z‛‛ $v'");
        assert_eq!(powershell_quote("a\"b'c"), "'a\"b''c'");
    }
}

/// A running process's name ("latexmk"), when it still exists: what closing
/// a terminal whose foreground job it leads would stop.
#[cfg(unix)]
pub fn process_name(pid: i32) -> Option<String> {
    super::pty::process_name(pid)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_shell_starts_as_a_login_shell_naming_lattice() {
        let launch = shell_launch();
        assert!(launch.program.is_absolute());
        assert_eq!(launch.args, ["-l"]);
        let get = |name: &str| {
            launch.env.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
        };
        assert_eq!(get("TERM_PROGRAM"), Some("Lattice"));
        assert_eq!(get("TERM"), Some("xterm-256color"));
        assert!(get("PATH").is_some_and(|path| !path.is_empty()));
        assert_eq!(launch.env_remove, ["LATTICE_PROJECT"]);
    }

    #[test]
    fn a_running_process_is_named() {
        let name = process_name(std::process::id() as i32);
        assert!(name.is_some_and(|name| !name.is_empty()));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::shell_cwd;
    use std::path::Path;

    #[test]
    fn the_shell_starts_in_the_plain_spelling_of_the_project_folder() {
        for (root, plain) in [
            (r"\\?\C:\Users\Ada\Papers", r"C:\Users\Ada\Papers"),
            (r"\\?\D:\Lattice é 中文\Papers", r"D:\Lattice é 中文\Papers"),
            (r"\\?\UNC\server\share\Papers", r"\\server\share\Papers"),
            (r"C:\Users\Ada\Papers", r"C:\Users\Ada\Papers"),
            // Not a drive or a share: no plain spelling to give it.
            (r"\\?\Volume{abc}\Papers", r"\\?\Volume{abc}\Papers"),
        ] {
            assert_eq!(shell_cwd(Path::new(root)), Path::new(plain));
        }
    }
}
