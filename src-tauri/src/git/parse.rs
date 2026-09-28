//! Parsing what git prints for the status panel and the version timeline.

use super::is_internal_path;
use crate::models::{GitFileStatus, GitLogEntry, GitLogFile, GitStatus};

/// Parse `git status --porcelain=v2 -z` output into the status of a readable
/// repository, remotes left for the caller (so `""` parses to one with nothing
/// to report). Records are NUL-terminated; a rename/copy (`2`) record's
/// *original* path follows as its own NUL-terminated token, and paths are
/// never quoted in `-z` mode.
///
/// Branch and upstream tracking stay empty: nothing in the app has read them
/// since the commit/push panel went.
pub(super) fn parse_porcelain_v2(raw: &str) -> GitStatus {
    let mut result = GitStatus {
        available: true,
        repository: true,
        branch: None,
        remote: None,
        remote_url: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };
    let mut tokens = raw.split('\0');
    while let Some(token) = tokens.next() {
        let Some((kind, rest)) = token.split_once(' ') else {
            continue;
        };
        // Fields between <XY> and <path>:
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        let skipped = match kind {
            "1" => 6,
            "2" => 7,
            "u" => 8,
            "?" => {
                push_v2_entry(&mut result.files, "??", rest);
                continue;
            }
            _ => continue,
        };
        let mut fields = rest.splitn(skipped + 2, ' ');
        let xy = fields.next().unwrap_or("");
        let path = fields.nth(skipped).unwrap_or("");
        if kind == "2" {
            let _original = tokens.next();
        }
        push_v2_entry(&mut result.files, xy, path);
    }
    result
}

fn push_v2_entry(files: &mut Vec<GitFileStatus>, xy: &str, path: &str) {
    if path.is_empty() {
        return;
    }
    let mut states = xy.chars();
    // v2 marks "unchanged" with '.'; classify_status and the staged/unstaged
    // flags below speak the v1 dialect where that position is a space.
    let mut next_state = || match states.next() {
        Some('.') | None => ' ',
        Some(state) => state,
    };
    let (index, worktree) = (next_state(), next_state());
    files.push(GitFileStatus {
        path: path.replace('\\', "/"),
        status: classify_status(index, worktree),
        staged: index != ' ' && index != '?',
        unstaged: worktree != ' ' || index == '?',
    });
}

fn classify_status(index: char, worktree: char) -> String {
    let code = if worktree == 'U' || index == 'U' || (index == 'A' && worktree == 'A') {
        'U'
    } else if worktree == '?' {
        '?'
    } else if worktree != ' ' {
        worktree
    } else {
        index
    };
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "conflict",
        '?' => "untracked",
        _ => "modified",
    }
    .to_string()
}

/// Parse `git log --name-status` with `%x1e`-separated records whose header
/// fields (hash, short hash, author, ISO date, subject) are `%x1f`-separated.
pub(super) fn parse_log(raw: &str) -> Vec<GitLogEntry> {
    let entry = |record: &str| {
        let mut lines = record.trim_matches('\n').lines();
        let mut header = lines.next()?.splitn(5, '\u{1f}');
        let mut field = || header.next().unwrap_or("").to_string();
        let (hash, short_hash, author_name, timestamp, message) =
            (field(), field(), field(), field(), field());
        if hash.is_empty() {
            return None;
        }
        let listed = lines.filter_map(parse_name_status_line).collect::<Vec<_>>();
        let had_files = !listed.is_empty();
        let files =
            listed.into_iter().filter(|file| !is_internal_path(&file.path)).collect::<Vec<_>>();
        // A version whose every change was Lattice's own state is not a
        // version of the user's work. Projects from before `.research/` was
        // ignored have a long run of these, one per Overleaf sync.
        if had_files && files.is_empty() {
            return None;
        }
        Some(GitLogEntry { hash, short_hash, author_name, timestamp, message, files })
    };
    raw.split('\u{1e}').filter_map(entry).collect()
}

fn parse_name_status_line(line: &str) -> Option<GitLogFile> {
    let mut parts = line.trim_end().split('\t');
    let code = parts.next()?.chars().next()?;
    // Renames and copies list old then new; report the new path so the
    // timeline points at the file that exists in that commit.
    if matches!(code, 'R' | 'C') {
        parts.next()?;
    }
    let path = parts.next()?;
    let kind = match code {
        'A' | 'C' => "added",
        'D' => "deleted",
        'R' => "renamed",
        _ => "modified",
    };
    Some(GitLogFile { path: path.replace('\\', "/"), kind: kind.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_status() {
        assert!(parse_porcelain_v2("").files.is_empty());
        let raw = [
            "1 .M N... 100644 100644 100644 abc def main.tex",
            "1 A. N... 000000 100644 100644 000 def sections/intro.tex",
            "? notes.md",
            "2 R. N... 100644 100644 100644 abc def R100 new.tex",
            "old.tex",
            "u UU N... 100644 100644 100644 100644 a1 b2 c3 conflicted.tex",
            "1 .M N... 100644 100644 100644 abc def path with spaces.tex",
        ]
        .join("\0");
        // Renames report the new path; the original follows as its own token
        // and must not surface as a file of its own.
        let expected = [
            ("main.tex", "modified", false, true),
            ("sections/intro.tex", "added", true, false),
            ("notes.md", "untracked", false, true),
            ("new.tex", "renamed", true, false),
            ("conflicted.tex", "conflict", true, true),
            ("path with spaces.tex", "modified", false, true),
        ];
        let files = parse_porcelain_v2(&raw).files;
        assert_eq!(files.len(), expected.len());
        for (file, (path, status, staged, unstaged)) in files.iter().zip(expected) {
            assert_eq!(
                (file.path.as_str(), file.status.as_str(), file.staged, file.unstaged),
                (path, status, staged, unstaged)
            );
        }
    }
}
