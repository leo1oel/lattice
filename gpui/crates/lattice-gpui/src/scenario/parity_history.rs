//! The History screens of the parity harness (`LATTICE_PARITY_SCREEN=history`
//! and `historyCompare`), staged as `design-system/screens/scenes.mjs`
//! stages them on the mock backend with `?versions=compare`
//! (`tools/perf-bench/bench-compare.ts`): five versions of the paper, named
//! ones with two automatic syncs between and one with a long name, each by
//! its author at its time; the History panel opened from the titlebar into
//! the documents' panel; and, for `historyCompare`, Compare… pressed.
//!
//! The versions are read from the mock backend's own module, and made real
//! here: a Git repository in the staged copy whose commits carry the same
//! messages, authors and times, each changing main.tex between the text as
//! it is and the text with the module's three older sentences put back, so
//! the versions list, the comparison's counts and its passages read the same
//! as the mock backend answers them. Two differences remain, both of real
//! Git: the first version adds references.bib beside main.tex (so it lists
//! two files where the mock lists one), and references.bib differs from Now
//! by a blank line rather than not at all.

use std::{path::Path, process::Command, sync::LazyLock, time::Duration};

use anyhow::{Context as _, Result, bail};
use gpui::AsyncApp;
use regex::Regex;

use super::{Run, sleep};

const BENCH_COMPARE: &str = include_str!("../../../../../tools/perf-bench/bench-compare.ts");

/// `[message, author, timestamp]`, newest first, as the module lists them.
static VERSIONS: LazyLock<Vec<(String, String, String)>> = LazyLock::new(|| {
    let row = Regex::new(r#"\["([^"]+)", "([^"]+)", "(\d{4}-[^"]+)"\]"#)
        .expect("the version row pattern compiles");
    row.captures_iter(BENCH_COMPARE)
        .map(|captures| {
            (
                captures[1].to_string(),
                captures[2].to_string(),
                captures[3].to_string(),
            )
        })
        .collect()
});

/// `(now, before)` sentence pairs (`OLDER_SENTENCES`).
static OLDER: LazyLock<Vec<(String, String)>> = LazyLock::new(|| {
    let start = BENCH_COMPARE.find("OLDER_SENTENCES").unwrap_or(0);
    let pair =
        Regex::new(r#"\["([^"]+)", "([^"]+)"\]"#).expect("the sentence pair pattern compiles");
    pair.captures_iter(&BENCH_COMPARE[start..])
        .map(|captures| (captures[1].to_string(), captures[2].to_string()))
        .collect()
});

fn older_text(text: &str) -> String {
    OLDER.iter().fold(text.to_string(), |older, (now, before)| {
        older.replacen(now, before, 1)
    })
}

fn git(root: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<()> {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .envs(envs.iter().copied())
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .with_context(|| format!("git {}", args.join(" ")))?;
    if !status.success() {
        bail!("git {} failed", args.join(" "));
    }
    Ok(())
}

/// The mock backend's versions as commits in `root`, the files as they are
/// left changed since the newest, as the mock's Now differs from it.
pub fn stage_versions(root: &Path) -> Result<()> {
    if VERSIONS.len() != 5 || OLDER.len() != 3 {
        bail!("bench-compare.ts no longer lists five versions and three sentences");
    }
    let main = root.join("main.tex");
    let now = std::fs::read_to_string(&main).context("the tutorial's main.tex")?;
    let older = older_text(&now);
    git(root, &["init", "--quiet", "--initial-branch=main"], &[])?;
    git(
        root,
        &["config", "user.email", "parity@lattice.invalid"],
        &[],
    )?;
    // Only the two files the mock backend's comparison names are versioned,
    // and nothing is written into the project to say so.
    std::fs::write(
        root.join(".git/info/exclude"),
        "/*\n!/main.tex\n!/references.bib\n",
    )?;
    // Oldest first, main.tex alternating so each version changes it and the
    // newest holds the older sentences.
    let mut texts = [&older, &now].into_iter().cycle();
    for (index, (message, author, timestamp)) in VERSIONS.iter().rev().enumerate() {
        let text = texts.next().expect("cycles");
        std::fs::write(&main, text)?;
        let add: &[&str] = if index == 0 {
            &["add", "main.tex", "references.bib"]
        } else {
            &["add", "main.tex"]
        };
        git(root, add, &[])?;
        git(
            root,
            &[
                "commit",
                "--quiet",
                "-m",
                message,
                "--author",
                &format!("{author} <parity@lattice.invalid>"),
            ],
            &[
                ("GIT_AUTHOR_DATE", timestamp),
                ("GIT_COMMITTER_DATE", timestamp),
            ],
        )?;
    }
    std::fs::write(&main, &now)?;
    // Now differs from the newest version in both files the mock backend's
    // comparison names (`git_compare_files`).
    let bib = root.join("references.bib");
    let mut text = std::fs::read_to_string(&bib).context("the tutorial's references.bib")?;
    text.push('\n');
    std::fs::write(&bib, text)?;
    Ok(())
}

impl Run {
    /// Stage the versions, open History from the titlebar, and for the
    /// comparison press Compare…; whether the versions (and the compared
    /// file) loaded.
    pub(super) async fn parity_history(&self, cx: &mut AsyncApp, compare: bool) -> Result<bool> {
        let root = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .context("the parity project is open")?;
        stage_versions(&root)?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_history(window, cx))
        })?;
        let loaded = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).history.read(cx).versions_shown() == VERSIONS.len()
            })
            .await;
        if !compare {
            return Ok(loaded);
        }
        self.with_window(cx, |shell, window, cx| {
            let history = shell.read(cx).history.clone();
            history.update(cx, |history, cx| history.start_comparing(window, cx));
        })?;
        let compared = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).history.read(cx).comparison_loaded(cx)
            })
            .await;
        sleep(cx, Duration::from_millis(400)).await;
        Ok(loaded && compared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_mock_backends_versions() {
        assert_eq!(VERSIONS.len(), 5);
        assert_eq!(VERSIONS[0].0, "Rebuttal draft");
        assert_eq!(OLDER.len(), 3);
        assert!(older_text(&OLDER[0].0).contains(&OLDER[0].1));
    }
}
