use super::*;
use crate::test_support::TempDir;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

#[test]
fn accepts_the_urls_git_clones_and_nothing_else() {
    for url in [
        "https://github.com/latex3/latex2e.git",
        "https://github.com/latex3/latex2e",
        "http://example.com/group/paper.git",
        "ssh://git@github.com/owner/paper.git",
        "ssh://git@example.com:2222/owner/paper",
        "git://example.com/paper.git",
        "git@github.com:owner/paper.git",
        "gitlab.example.com:group/sub/paper",
        "https://user:token@example.com/paper.git",
        "file:///Volumes/Shared/paper.git",
    ] {
        assert!(is_clone_url(url), "{url} should be accepted");
    }
    for url in [
        "",
        "paper",
        "/Users/ada/paper",
        "./paper",
        "https://",
        "https://github.com",
        "https:///paper.git",
        "ftp://example.com/paper.git",
        "git@github.com:",
        "-uhttps://example.com/paper.git",
        "--upload-pack=touch /tmp/x",
        "https://github.com/owner/my paper.git",
        "C/folder:name",
    ] {
        assert!(!is_clone_url(url), "{url} should be refused");
    }
}

#[test]
fn reads_progress_from_what_git_prints() {
    let at = |line| {
        parse_progress(line)
            .map(|progress| progress.map(|p| (p.stage, (p.progress * 100.0).round())))
    };
    assert_eq!(
        at("Receiving objects:  45% (450/1000), 1.20 MiB | 1.10 MiB/s"),
        Some(Some(("receiving", 36.0)))
    );
    assert_eq!(at("Receiving objects: 100% (1000/1000), done."), Some(Some(("receiving", 80.0))));
    assert_eq!(at("Resolving deltas:  50% (5/10)"), Some(Some(("resolving", 88.0))));
    assert_eq!(at("Updating files: 100% (12/12), done."), Some(Some(("checkout", 100.0))));
    assert_eq!(at("remote: Counting objects:  10% (1/10)"), Some(Some(("connecting", 0.0))));
    // A phase that does not move the bar leaves it where it was.
    assert_eq!(at("Filtering content:  50% (1/2), 1.20 MiB | 1.10 MiB/s"), Some(None));
    // Counts with no total move nothing, and are not something git said.
    assert_eq!(at("remote: Enumerating objects: 10, done."), Some(None));
    assert_eq!(at("Checking connectivity: 5123, done."), Some(None));
    assert_eq!(at("Checking connectivity: 5123"), Some(None));
    assert_eq!(at("fatal: unable to checkout working tree"), None);
    assert_eq!(at("Cloning into 'paper'..."), None);
}

fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::to_string).collect()
}

#[test]
fn tells_sign_in_missing_repositories_and_network_apart() {
    // git's advice after the first line is the same whatever went wrong.
    const ADVICE: &str = "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";
    let auth = [
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
            .to_string(),
        format!("git@github.com: Permission denied (publickey).\n{ADVICE}"),
        format!("Host key verification failed.\n{ADVICE}"),
        "fatal: Authentication failed for 'https://example.com/paper.git/'".to_string(),
    ];
    for message in auth {
        assert!(matches!(classify_failure(&lines(&message)), CloneError::Auth(_)), "{message}");
    }
    assert_eq!(
        classify_failure(&lines("fatal: repository 'https://github.com/owner/nope/' not found")),
        CloneError::NotFound("repository 'https://github.com/owner/nope/' not found".to_string()),
    );
    assert_eq!(
        classify_failure(&lines(&format!("ERROR: Repository not found.\n{ADVICE}"))),
        CloneError::NotFound("Repository not found.".to_string()),
    );
    assert!(matches!(
        classify_failure(&lines("fatal: unable to access 'https://nohost.invalid/x/': Could not resolve host: nohost.invalid")),
        CloneError::Network(_)
    ));
    // ssh through a proxy that could not reach the host.
    assert!(matches!(
        classify_failure(&lines("Connection closed by 127.0.0.1 port 7897")),
        CloneError::Network(_)
    ));
    assert_eq!(classify_failure(&[]), CloneError::Failed("git clone failed.".to_string()));
}

#[test]
fn names_git_s_own_error_not_the_host_s_chatter_before_it() {
    // A transfer that dropped after the host had started sending.
    let dropped = "warning: redirecting to https://github.com/owner/paper.git/\nremote: Enumerating objects: 1234, done.\nremote: Total 1234 (delta 0), reused 0 (delta 0), pack-reused 1234\nerror: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output";
    assert_eq!(
        classify_failure(&lines(dropped)),
        CloneError::Failed(
            "RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)"
                .to_string()
        ),
    );
    assert_eq!(
        classify_failure(&lines(
            "remote: Enumerating objects: 1234, done.\nfatal: write error: No space left on device"
        )),
        CloneError::Failed("write error: No space left on device".to_string()),
    );
    // ssh's own line, not the advice git adds after it.
    assert_eq!(
        classify_failure(&lines(
            "Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."
        )),
        CloneError::Auth("git@github.com: Permission denied (publickey).".to_string()),
    );
}

#[test]
fn names_the_host_s_own_error_over_git_s_advice() {
    // GitLab over ssh, for a project that is missing or hidden from the account.
    let gitlab = "remote: \nremote: ========================================================================\nremote: \nremote: ERROR: The project you were looking for could not be found or you don't have permission to view it.\nremote: \nremote: ========================================================================\nremote: \nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";
    assert_eq!(
        classify_failure(&lines(gitlab)),
        CloneError::NotFound(
            "The project you were looking for could not be found or you don't have permission to view it."
                .to_string()
        ),
    );
    // GitHub over https: git's own line, not the host's echo before it.
    assert_eq!(
        classify_failure(&lines(
            "remote: Repository not found.\nfatal: repository 'https://github.com/owner/nope.git/' not found"
        )),
        CloneError::NotFound("repository 'https://github.com/owner/nope.git/' not found".to_string()),
    );
}

#[test]
fn names_ssh_s_error_not_its_post_quantum_warning() {
    // OpenSSH 10.1+ connecting to an sshd without post-quantum key exchange.
    let refused = "** WARNING: connection is not using a post-quantum key exchange algorithm.\n** This session may be vulnerable to \"store now, decrypt later\" attacks.\n** The server may need to be upgraded. See https://openssh.com/pq.html\ngit@git.example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
    assert_eq!(
        classify_failure(&lines(refused)),
        CloneError::Auth("git@git.example.com: Permission denied (publickey).".to_string()),
    );
}

#[test]
fn a_folder_git_may_not_write_to_is_not_a_sign_in_failure() {
    assert_eq!(
        classify_failure(&lines(
            "fatal: could not create work tree dir 'paper': Permission denied"
        )),
        CloneError::Failed("could not create work tree dir 'paper': Permission denied".to_string()),
    );
}

#[test]
fn the_git_shim_without_the_command_line_tools_is_git_missing() {
    assert_eq!(
        classify_failure(&lines("xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun")),
        CloneError::GitMissing,
    );
}

/// A bare repository holding one commit, reachable by a file:// URL, or
/// `None` when git is not installed.
fn origin(label: &str) -> Option<(TempDir, String)> {
    if !commands::available("git") {
        return None;
    }
    let scratch = TempDir::new(&format!("git-clone-{label}"));
    let work = scratch.join("work");
    fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "--quiet"]);
    fs::write(work.join("main.tex"), "\\documentclass{article}\n").unwrap();
    git(&work, &["add", "main.tex"]);
    git(
        &work,
        &[
            "-c",
            "user.name=Lattice",
            "-c",
            "user.email=l@example.com",
            "commit",
            "--quiet",
            "-m",
            "first",
        ],
    );
    git(&scratch, &["clone", "--quiet", "--bare", "work", "paper.git"]);
    let url = tauri::Url::from_file_path(scratch.join("paper.git")).unwrap().to_string();
    Some((scratch, url))
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git").current_dir(root).args(args).status().unwrap();
    assert!(status.success(), "git {} failed", args.join(" "));
}

fn destination(scratch: &TempDir, name: &str) -> PathBuf {
    scratch.join(name)
}

#[test]
fn clones_into_a_new_folder_and_reports_progress() {
    let Some((scratch, url)) = origin("ok") else { return };
    let dest = destination(&scratch, "paper");
    let stages = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&stages);
    clone("clone-ok", &url, &dest, move |progress| seen.lock().unwrap().push(progress.stage))
        .unwrap();
    assert!(dest.join("main.tex").is_file());
    assert!(dest.join(".git").is_dir());
    assert_eq!(stages.lock().unwrap().first(), Some(&"connecting"));
}

#[test]
fn clones_into_an_empty_folder_that_is_already_there() {
    let Some((scratch, url)) = origin("empty") else { return };
    let dest = destination(&scratch, "paper");
    fs::create_dir_all(&dest).unwrap();
    clone("clone-empty", &url, &dest, |_| {}).unwrap();
    assert!(dest.join("main.tex").is_file());
}

#[test]
fn refuses_a_folder_with_something_in_it() {
    let Some((scratch, url)) = origin("exists") else { return };
    let dest = destination(&scratch, "paper");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("notes.txt"), "mine").unwrap();
    assert_eq!(clone("clone-exists", &url, &dest, |_| {}), Err(CloneError::FolderExists));
    assert_eq!(fs::read_to_string(dest.join("notes.txt")).unwrap(), "mine");
}

#[test]
fn refuses_a_bad_url_and_a_missing_parent_before_running_git() {
    let scratch = TempDir::new("git-clone-refusals");
    assert_eq!(
        clone("clone-bad", "paper", &scratch.join("paper"), |_| {}),
        Err(CloneError::InvalidUrl)
    );
    assert_eq!(
        clone("clone-bad", "https://example.com/paper.git", &scratch.join("missing/paper"), |_| {}),
        Err(CloneError::NoParent),
    );
}

#[test]
fn a_missing_repository_leaves_no_folder_behind() {
    let Some((scratch, _)) = origin("missing") else { return };
    let url = tauri::Url::from_file_path(scratch.join("nope.git")).unwrap().to_string();
    let dest = destination(&scratch, "nope");
    let error = clone("clone-missing", &url, &dest, |_| {}).unwrap_err();
    assert!(matches!(error, CloneError::NotFound(_)), "{error:?}");
    assert!(!dest.exists());
}

#[test]
fn a_cancel_before_git_starts_stops_the_clone_and_cleans_up() {
    let Some((scratch, url)) = origin("cancel") else { return };
    let dest = destination(&scratch, "paper");
    // The first progress report comes before git runs: cancel there.
    let error = clone("clone-cancel", &url, &dest, |progress| {
        if progress.stage == "connecting" {
            cancel("clone-cancel");
        }
    })
    .unwrap_err();
    assert_eq!(error, CloneError::Cancelled);
    assert!(!dest.exists());
    // Nothing is left registered for the window.
    assert!(!CLONES.lock().unwrap().contains_key("clone-cancel"));
}

#[test]
fn an_older_clone_finishing_leaves_a_newer_one_cancellable() {
    // A reload started a second clone in the same window while the first
    // was still finishing.
    CLONES.lock().unwrap().insert("clone-reloaded".to_string(), (u64::MAX, 0, false));
    assert!(forget("clone-reloaded", 0), "the replaced clone counts as stopped");
    assert!(CLONES.lock().unwrap().contains_key("clone-reloaded"));
    cancel("clone-reloaded");
    assert_eq!(CLONES.lock().unwrap().get("clone-reloaded"), Some(&(u64::MAX, 0, true)));
    assert!(forget("clone-reloaded", u64::MAX));
    assert!(!CLONES.lock().unwrap().contains_key("clone-reloaded"));
}
