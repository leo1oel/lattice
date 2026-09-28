//! Running the bibcite CLI and reading its per-provider diagnostics. Output is
//! redacted before it is parsed or kept, and only structured outcomes (never
//! raw errors, which can contain URLs and keys) reach the report.
use super::*;
use crate::commands;
use crate::papers::ScratchBibliography;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Final provider diagnostics to outcomes, first match wins: bibcite's
/// specific phrases come before the bare HTTP status fallbacks.
const OUTCOMES: &[(&[&str], &str)] = &[
    (&["publication matched"], "matched"),
    (&["disabled by caller"], "not_configured"),
    (&["batch result reused"], "batch_reused"),
    (&["batch unavailable"], "unavailable"),
    (&["queue_busy", "pacing"], "queue_busy"),
    (&["daily_quota"], "daily_quota"),
    (&["upstream_rate_limit"], "rate_limited"),
    (&["captcha"], "blocked"),
    (&["401", "unauthorized"], "unauthorized"),
    (&["403", "forbidden"], "forbidden"),
    (&["429", "rate-limit"], "rate_limited"),
    (&["timeout", "timed out", "budget exhausted"], "timeout"),
    (&["unreachable", "connecterror", "remoteprotocolerror"], "connection_failed"),
    (&["server error", "500", "502", "503", "504"], "server_error"),
    (&["no publication found"], "no_match"),
    (&["failure", "disabled", "error"], "unavailable"),
];

/// A bibcite command that reuses the batch's Semantic Scholar outcome instead
/// of querying S2 again for this entry.
pub(super) fn audit_command(s2_batch_status: Option<&str>) -> Result<Command, String> {
    let mut command = commands::BIBCITE.command()?;
    if let Some(status) = s2_batch_status {
        command.env(
            "BIBCITE_S2_BATCH_STATUS",
            match status {
                "checked" => "checked",
                "not_configured" => "disabled",
                _ => "unavailable",
            },
        );
    }
    Ok(command)
}

pub(super) fn run_bibcite(args: &[&str], command: Option<Command>) -> Result<Output, String> {
    let mut command = match command {
        Some(c) => c,
        None => commands::BIBCITE.command()?,
    };
    // File-backed capture cannot deadlock when a verbose provider fills a pipe
    // while the parent is polling the child's deadline.
    let capture = scratch(None)?;
    let stdout = capture.dir.join("stdout");
    let stderr = capture.dir.join("stderr");
    command
        .args(args)
        .stdout(Stdio::from(fs::File::create(&stdout).map_err(|e| e.to_string())?))
        .stderr(Stdio::from(fs::File::create(&stderr).map_err(|e| e.to_string())?));
    commands::in_new_process_group(&mut command);
    let mut child =
        command.spawn().map_err(|e| crate::papers::uv_tool_spawn_error("bibcite", &e))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(commands::redact_bibcite_output(
                &command,
                Output {
                    status,
                    stdout: fs::read(&stdout).map_err(|e| e.to_string())?,
                    stderr: fs::read(&stderr).map_err(|e| e.to_string())?,
                },
            ));
        }
        if Instant::now() >= deadline {
            // uv may launch the CLI as a child; stop the whole isolated group
            // so a timeout does not leave provider requests running.
            #[cfg(unix)]
            commands::signal_process_group(child.id(), libc::SIGKILL);
            let _ = child.kill();
            let _ = child.wait();
            return Err("bibcite timed out after 60 seconds".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// A private scratch directory for the audit's bibcite input and output.
pub(super) fn scratch(contents: Option<&str>) -> Result<ScratchBibliography, String> {
    ScratchBibliography::new("lattice-bib-audit", contents)
}

/// The BibTeX record from `bibcite get --json`.
pub(super) fn parse_get_output(output: &Output) -> Result<String, String> {
    if !output.status.success() {
        let e = String::from_utf8_lossy(&output.stderr);
        return Err(if e.trim().is_empty() { "bibcite failed".into() } else { e.trim().into() });
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "bibcite returned invalid JSON")?;
    value
        .get("bibtex")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "bibcite returned no exact BibTeX record".into())
}

/// A title lookup that every provider answered with "no match", as opposed
/// to one cut short by an unavailable provider.
pub(super) fn is_clean_lookup_miss(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    output.status.code() == Some(2)
        && publication_sources(&stderr).iter().all(|source| {
            matches!(source.outcome.as_str(), "no_match" | "not_configured" | "batch_reused")
        })
        && stderr.lines().any(|line| {
            line.starts_with("[bibcite] No match found anywhere for:")
                || line.starts_with("[bibcite] Only an arXiv preprint was found for:")
        })
}

/// The last outcome bibcite reported for each known provider.
pub(super) fn publication_sources(stderr: &str) -> Vec<SourceCheck> {
    let mut sources = BTreeMap::new();
    for line in stderr.lines() {
        let Some((source, detail)) = line.strip_prefix('[').and_then(|s| s.split_once("] ")) else {
            continue;
        };
        let source = if source == "dblp-fuzzy" || source == "dblp-exact" { "dblp" } else { source };
        if !matches!(
            source,
            "dblp" | "semanticscholar" | "googlescholar" | "crossref" | "unpaywall" | "openalex"
        ) {
            continue;
        }
        let detail = detail.to_ascii_lowercase();
        // Intermediate retry diagnostics aren't final source outcomes.
        if detail.contains("retrying once") {
            continue;
        }
        let outcome = OUTCOMES
            .iter()
            .find(|(needles, _)| needles.iter().any(|needle| detail.contains(needle)))
            .map_or("unknown", |(_, outcome)| outcome);
        sources.insert(source.to_string(), outcome.to_string());
    }
    sources.into_iter().map(|(source, outcome)| SourceCheck { source, outcome }).collect()
}

pub(super) fn output_sources(output: &Output) -> Vec<SourceCheck> {
    publication_sources(&String::from_utf8_lossy(&output.stderr))
}

/// Provider outcomes of a lookup whose record `checked` judged. A match that
/// was not accepted is only a candidate, and the source that supplied the
/// record reports whether it was selected.
pub(super) fn metadata_sources(output: &Output, checked: &AuditResult) -> Vec<SourceCheck> {
    let mut sources = output_sources(output);
    if !checked.verified() {
        for source in sources.iter_mut().filter(|source| source.outcome == "matched") {
            source.outcome = "candidate".into();
        }
    }
    if let Some(source) = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .ok()
        .and_then(|value| value.get("source").and_then(|v| v.as_str()).map(str::to_string))
    {
        upsert_source(&mut sources, selected_source(&source, checked, output));
    }
    sources
}

/// The row for the source whose record `checked` judged, noting whether
/// bibcite answered from its cache.
pub(super) fn selected_source(source: &str, checked: &AuditResult, output: &Output) -> SourceCheck {
    let cached = String::from_utf8_lossy(&output.stderr)
        .lines()
        .any(|line| line.starts_with("[cache] hit:"));
    let outcome = match (checked.verified(), cached) {
        (true, false) => "selected",
        (true, true) => "selected_cached",
        (false, false) => "candidate",
        (false, true) => "candidate_cached",
    };
    SourceCheck::new(source, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn provider_errors_redact_the_spawned_credentials() {
        let mut command = Command::new("/bin/sh");
        command.env("OPENALEX_API_KEY", "draft+secret");
        let output = run_bibcite(
            &["-c", "printf '%s' \"$OPENALEX_API_KEY\"; printf '%s' 'HTTP 401 https://api.openalex.org/works?api_key=draft%2Bsecret' >&2; exit 1"],
            Some(command),
        )
        .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "[redacted]");
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("HTTP 401"));
        assert!(!stderr.contains("draft"));
        let capture = scratch(None).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&capture.dir).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    #[cfg(unix)]
    fn captures_more_than_a_pipe_buffer_without_deadlocking() {
        let output =
            run_bibcite(&["-c", "head -c 131072 /dev/zero"], Some(Command::new("/bin/sh")))
                .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 131072);
    }

    #[test]
    fn final_dblp_diagnostics_include_fuzzy_and_ignore_recovered_timeouts() {
        let failed = publication_sources(
            "[dblp] no publication found\n[dblp-fuzzy] skipped: DBLP lookup budget exhausted",
        );
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].outcome, "timeout");
        let recovered = publication_sources("[dblp-exact] request timed out; retrying once\n[dblp] publication matched\n[semanticscholar] disabled by caller");
        assert_eq!(recovered[0].outcome, "matched");
        assert_eq!(recovered[1].outcome, "not_configured");
    }
}
