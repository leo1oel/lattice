//! `parity` with `LATTICE_PARITY_SCREEN=overleafPicker` or
//! `settingsOverleaf`: the Overleaf screens staged as the parity harness
//! stages them in the Tauri app (`tools/perf-bench/bench-overleaf.ts`), with
//! nothing asked of the network.
//!
//! - `overleafPicker` (`?overleaf=picker`): signed in as the bench's own
//!   person, "Open from Overleaf" lists the bench's five projects, the first
//!   chosen, the tutorial unlinked so the upload card shows.
//! - `settingsOverleaf` (`?overleaf=review`): the tutorial linked to
//!   "Understanding Attention", last synced four minutes ago, the live
//!   channel up, and Settings open on Overleaf.
//!
//! The projects are read from the bench's `PICKER_PROJECTS`, so both apps
//! show the same rows; that file keeps each on one line for this parser.

use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail};
use gpui::AsyncApp;
use lattice_core::overleaf::{OverleafLink, OverleafProject, OverleafProjectList, OverleafStatus};

use super::{Run, sleep};

const BENCH: &str = include_str!("../../../../../tools/perf-bench/bench-overleaf.ts");
const HOST: &str = "https://www.overleaf.com";
const MINUTE_MS: i64 = 60_000;

impl Run {
    /// Stage the Overleaf screen `screen` names, over a window already laid
    /// out; false for any other screen.
    pub(super) async fn parity_overleaf(&self, cx: &mut AsyncApp, screen: &str) -> Result<bool> {
        let (name, email) = bench_me()?;
        let status = OverleafStatus {
            connected: true,
            expired: false,
            email: Some(email),
            name: Some(name),
            host: HOST.into(),
        };
        match screen {
            "overleafPicker" => {
                let list = OverleafProjectList {
                    projects: picker_projects()?,
                    invites: Vec::new(),
                };
                self.with_window(cx, |shell, window, cx| {
                    shell.update(cx, |shell, cx| shell.open_overleaf_picker(window, cx));
                    let picker = shell
                        .read(cx)
                        .overleaf_picker()
                        .ok_or_else(|| anyhow!("the picker did not open"))?;
                    picker.update(cx, |picker, cx| picker.scenario_stage(status, list, cx));
                    // The scene clicks the first row, which leaves nothing
                    // focused in the search.
                    window.blur(cx);
                    anyhow::Ok(())
                })??;
                sleep(cx, Duration::from_millis(600)).await;
                Ok(true)
            }
            "settingsOverleaf" => {
                let link = OverleafLink {
                    project_id: "ol-understanding-attention".into(),
                    project_name: "Understanding Attention".into(),
                    host: HOST.into(),
                    last_sync: Some(iso_ago(4 * MINUTE_MS)),
                    paused: false,
                };
                self.with_window(cx, |shell, window, cx| {
                    let bridge = shell.read(cx).overleaf.clone();
                    bridge.update(cx, |bridge, cx| {
                        bridge.scenario_stage(status.clone(), link.clone(), cx)
                    });
                    shell.update(cx, |shell, cx| {
                        shell.open_settings(
                            Some(lattice_settings::SettingsTab::Overleaf),
                            window,
                            cx,
                        )
                    });
                })?;
                // Settings makes its Overleaf page when it first draws it.
                let made = self
                    .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                        overleaf_page(shell, cx).is_some()
                    })
                    .await;
                if !made {
                    bail!("Settings did not open on Overleaf");
                }
                self.with_window(cx, |shell, _, cx| {
                    if let Some(connection) = overleaf_page(shell, cx) {
                        connection.update(cx, |connection, cx| {
                            connection.scenario_stage(status, Some(link), cx)
                        });
                    }
                })?;
                sleep(cx, Duration::from_millis(600)).await;
                self.with_window(cx, |_, window, cx| window.blur(cx))?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

fn overleaf_page(
    shell: &gpui::Entity<crate::shell::Shell>,
    cx: &gpui::App,
) -> Option<gpui::Entity<crate::settings::overleaf_pane::OverleafConnection>> {
    shell
        .read(cx)
        .settings
        .as_ref()
        .and_then(|settings| settings.read(cx).overleaf_connection())
}

/// `now` less `ago` milliseconds, as Overleaf writes times.
fn iso_ago(ago: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::milliseconds(ago))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The bench's `PICKER_PROJECTS`: `[id, name, ownerName, ownerEmail, age,
/// accessLevel]` rows, the age a product like `26 * HOUR`.
/// The bench's signed-in person (`PEOPLE.me`): their name and email.
fn bench_me() -> Result<(String, String)> {
    let line = BENCH
        .split_once("const PEOPLE = {")
        .and_then(|(_, rest)| rest.split_once("\n}"))
        .and_then(|(block, _)| {
            block
                .lines()
                .map(str::trim)
                .find(|line| line.starts_with("me:"))
        })
        .context("no PEOPLE.me in bench-overleaf.ts")?;
    let field = |key: &str| -> Result<String> {
        let (_, rest) = line
            .split_once(&format!("{key}: \""))
            .with_context(|| format!("PEOPLE.me has no {key}"))?;
        let (value, _) = rest.split_once('"').context("an unclosed string")?;
        Ok(value.to_string())
    };
    Ok((field("name")?, field("email")?))
}

fn picker_projects() -> Result<Vec<OverleafProject>> {
    let block = BENCH
        .split_once("const PICKER_PROJECTS:")
        .and_then(|(_, rest)| rest.split_once("];"))
        .map(|(block, _)| block)
        .context("no PICKER_PROJECTS in bench-overleaf.ts")?;
    let projects = block
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("[\""))
        .map(parse_row)
        .collect::<Result<Vec<_>>>()?;
    if projects.is_empty() {
        bail!("PICKER_PROJECTS has no rows");
    }
    Ok(projects)
}

fn parse_row(line: &str) -> Result<OverleafProject> {
    // The quoted fields, and what lies between the fourth and the fifth.
    let mut strings = Vec::new();
    let mut between = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('"') {
        between.push(rest[..start].to_string());
        let after = &rest[start + 1..];
        let end = after.find('"').context("an unclosed string")?;
        strings.push(after[..end].to_string());
        rest = &after[end + 1..];
    }
    let [id, name, owner_name, owner_email, access] = <[String; 5]>::try_from(strings)
        .map_err(|_| anyhow!("a row without five strings: {line}"))?;
    let age = between.get(4).context("no age")?;
    Ok(OverleafProject {
        id,
        name,
        last_updated: Some(iso_ago(age_ms(age)?)),
        owner_email: Some(owner_email),
        owner_name: Some(owner_name),
        access_level: Some(access),
        archived: false,
        trashed: false,
    })
}

/// `2 * HOUR` and the like, in milliseconds.
fn age_ms(expression: &str) -> Result<i64> {
    let expression = expression.trim().trim_matches(',').trim();
    let (count, unit) = expression
        .split_once('*')
        .context("an age that is not a product")?;
    let count: f64 = count.trim().parse()?;
    let unit = match unit.trim() {
        "MINUTE" => MINUTE_MS,
        "HOUR" => 60 * MINUTE_MS,
        "DAY" => 24 * 60 * MINUTE_MS,
        other => bail!("an unknown unit {other}"),
    };
    Ok((count * unit as f64) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bench_projects_parse() {
        let projects = picker_projects().unwrap();
        assert_eq!(projects.len(), 5);
        assert_eq!(projects[0].name, "Understanding Attention");
        assert_eq!(projects[2].name, "Thesis Chapter 3: Efficient Kernels");
        assert_eq!(projects[4].access_level.as_deref(), Some("review"));
        assert_eq!(age_ms(" 26 * HOUR, ").unwrap(), 26 * 3_600_000);
    }

    #[test]
    fn the_bench_person_parses() {
        assert_eq!(
            bench_me().unwrap(),
            ("Leo Gu".to_string(), "leo@example.edu".to_string())
        );
    }
}
