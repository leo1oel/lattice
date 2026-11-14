//! Get started, ported from the Tauri app's checklist
//! (`src/onboarding/get-started-*.ts(x)`): a dockable tool panel that walks
//! a first paper in six steps, in the order a first paper needs them: LaTeX
//! on this computer, a visible build, the PDF↔source jump, a citation, the
//! Agent, and a paper of the writer's own.
//!
//! Each step names what it is and one sentence of why, the onboarding
//! exception to the interface's no-helper-text rule. Where a step's place
//! is on screen, "Show me" brings it up and rings it without dimming
//! anything (`show_me`). Steps are marked done where they really happen
//! (`progress`), never by a click near them; the cite command and the Agent
//! are not in this app yet, so those two steps can only be skipped here.

pub mod panel;
pub mod progress;
pub mod show_me;

use lattice_i18n::n;

/// The steps, in the checklist's order (`GET_STARTED_STEPS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Step {
    Latex,
    Build,
    Jump,
    Cite,
    Agent,
    Own,
}

impl Step {
    pub const ALL: [Step; 6] = [
        Step::Latex,
        Step::Build,
        Step::Jump,
        Step::Cite,
        Step::Agent,
        Step::Own,
    ];

    /// The name the stored progress uses, as the Tauri app's.
    pub fn id(self) -> &'static str {
        match self {
            Step::Latex => "latex",
            Step::Build => "build",
            Step::Jump => "jump",
            Step::Cite => "cite",
            Step::Agent => "agent",
            Step::Own => "own",
        }
    }
}

/// The venue `create_tutorial` gives the sample: any other project is the
/// writer's own.
pub const TUTORIAL_VENUE: &str = "tutorial";

/// The sample's manuscript, and the `\title` line it ships with.
pub const SAMPLE_MANUSCRIPT: &str = "main.tex";
const SAMPLE_TITLE: &str =
    "\\title{Understanding Attention: A Worked Guide to Transformer Reasoning}";

pub fn is_title(line: &str) -> bool {
    line.trim_start().starts_with("\\title{")
}

/// The manuscript's `\title` line, 1-based, once its text is known.
pub fn title_line(text: &str) -> Option<u32> {
    text.lines().position(is_title).map(|line| line as u32 + 1)
}

/// Whether a sample build under `text` counts: its title is the writer's,
/// not the one the sample ships with, which proves nothing was tried.
pub fn has_own_title(text: &str) -> bool {
    text.lines()
        .find(|line| is_title(line))
        .is_some_and(|line| line.trim() != SAMPLE_TITLE)
}

/// Which computer the checklist is read on: the Agent is not offered off a
/// Mac, and neither Windows nor Linux installs BasicTeX.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    Mac,
    Windows,
    Linux,
}

impl Host {
    pub fn current() -> Host {
        if cfg!(target_os = "macos") {
            Host::Mac
        } else if cfg!(target_os = "windows") {
            Host::Windows
        } else {
            Host::Linux
        }
    }
}

/// The keys the steps name, as the host writes them (`stepKeys`): ⌘S, or
/// Ctrl+S.
pub struct Keys {
    pub save: &'static str,
    pub jump: &'static str,
    pub cite: &'static str,
}

impl Keys {
    pub fn of(host: Host) -> Keys {
        match host {
            Host::Mac => Keys {
                save: "⌘S",
                jump: "⌘⇧J",
                cite: "⌘⇧K",
            },
            _ => Keys {
                save: "Ctrl+S",
                jump: "Ctrl+Shift+J",
                cite: "Ctrl+Shift+K",
            },
        }
    }
}

/// A step as the checklist reads it: messages, filled with the host's keys
/// where they name one.
pub struct StepText {
    pub step: Step,
    pub title: &'static str,
    pub why: &'static str,
    /// What the ring says over the place "Show me" brings up; a step
    /// without one has no place to show.
    pub hint: Option<&'static str>,
}

const ANOTHER_COMPUTER: &str = n!(
    "Start from a venue template, open a folder on this computer, or bring a project from Overleaf."
);

/// The steps as `host` reads them (`getStartedSteps`).
pub fn steps(host: Host) -> Vec<StepText> {
    let text = |step, title, why, hint| StepText {
        step,
        title,
        why,
        hint,
    };
    let mut steps = vec![
        text(
            Step::Latex,
            n!("Install LaTeX"),
            n!("Lattice builds your PDF with the LaTeX on this Mac, and BasicTeX is about 1 GB."),
            None,
        ),
        text(
            Step::Build,
            n!("Change the title, then build"),
            n!(
                "Edit the \\title line in main.tex and press {saveKeys} to see the PDF beside it update in about a second."
            ),
            Some(n!("Edit the title, then press {saveKeys}")),
        ),
        text(
            Step::Jump,
            n!("Jump between PDF and source"),
            n!(
                "Double-click any sentence in the PDF to land on the line that wrote it, and press {jumpKeys} to jump back."
            ),
            Some(n!("Double-click a sentence")),
        ),
        text(
            Step::Cite,
            n!("Cite a paper"),
            n!(
                "In the editor, press {citeKeys} and pick one of this project’s papers, or add your own in Papers by arXiv ID, DOI or title."
            ),
            Some(n!("Click in the text, then press {citeKeys}")),
        ),
        text(
            Step::Agent,
            n!("Ask the Agent to revise"),
            n!(
                "Select a paragraph, choose Annotate, write what should change, then Save and revise now."
            ),
            Some(n!("Check that an agent is connected")),
        ),
        text(
            Step::Own,
            n!("Start your own paper"),
            n!(
                "Start from a venue template, open a folder on this Mac, or bring a project from Overleaf."
            ),
            None,
        ),
    ];
    // The embedded agent is not supported on the experimental Windows host
    // or on Linux; Windows has TeX Live's own installer, Linux the
    // distribution's packages.
    if host != Host::Mac {
        steps.retain(|step| step.step != Step::Agent);
    }
    for step in &mut steps {
        match (host, step.step) {
            (Host::Windows, Step::Latex) => {
                step.why = n!(
                    "Install TeX Live for Windows to build your PDF. You can keep editing before installing LaTeX."
                )
            }
            (Host::Windows, Step::Build) => {
                step.why = n!(
                    "Edit the title line in main.tex and press {saveKeys} to update the PDF beside it."
                )
            }
            (Host::Linux, Step::Latex) => {
                step.why = n!(
                    "Lattice builds your PDF with the TeX Live on this computer. Install it from your distribution’s packages, then choose Recheck."
                )
            }
            (Host::Windows | Host::Linux, Step::Own) => step.why = ANOTHER_COMPUTER,
            _ => {}
        }
    }
    steps
}

/// A message translated, its keys filled in.
pub fn fill(message: &'static str, keys: &Keys) -> String {
    lattice_i18n::fill_named(
        lattice_i18n::tr(message),
        &[
            ("saveKeys", &keys.save as &dyn std::fmt::Display),
            ("jumpKeys", &keys.jump),
            ("citeKeys", &keys.cite),
        ],
    )
}

/// A sentence cut where it names keys (⌘S, ⌘⇧K, Ctrl+Shift+J), so they
/// can be drawn as keys: the pieces alternate text and keys, text first.
pub fn split_keys(text: &str) -> Vec<(bool, &str)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some((start, end)) = next_keys(rest) {
        if start > 0 {
            out.push((false, &rest[..start]));
        }
        out.push((true, &rest[start..end]));
        rest = &rest[end..];
    }
    if !rest.is_empty() {
        out.push((false, rest));
    }
    out
}

/// The first run of keys in `text`: modifier glyphs then one capital or
/// digit, or Ctrl+ (Shift+ or Alt+) and one capital or digit.
fn next_keys(text: &str) -> Option<(usize, usize)> {
    let key = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit();
    for (start, c) in text.char_indices() {
        if "⌘⇧⌥⌃".contains(c) {
            let after = text[start..].trim_start_matches(|c| "⌘⇧⌥⌃".contains(c));
            let at = text.len() - after.len();
            if after.chars().next().is_some_and(key) {
                return Some((start, at + 1));
            }
        } else if text[start..].starts_with("Ctrl+") {
            let mut at = start + "Ctrl+".len();
            for modifier in ["Shift+", "Alt+"] {
                if text[at..].starts_with(modifier) {
                    at += modifier.len();
                    break;
                }
            }
            if text[at..].chars().next().is_some_and(key) {
                return Some((start, at + 1));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_in_a_sentence_are_cut_out_on_either_host() {
        assert_eq!(
            split_keys("Edit it, then press ⌘S to see it, ⌘⇧J back"),
            vec![
                (false, "Edit it, then press "),
                (true, "⌘S"),
                (false, " to see it, "),
                (true, "⌘⇧J"),
                (false, " back"),
            ]
        );
        assert_eq!(
            split_keys("press Ctrl+Shift+K and Ctrl+S."),
            vec![
                (false, "press "),
                (true, "Ctrl+Shift+K"),
                (false, " and "),
                (true, "Ctrl+S"),
                (false, "."),
            ]
        );
        assert_eq!(
            split_keys("⌘ alone, Ctrl+x"),
            vec![(false, "⌘ alone, Ctrl+x")]
        );
    }

    #[test]
    fn only_a_title_of_the_writers_own_counts() {
        let shipped = "\\documentclass{article}\n\\title{Understanding Attention: A Worked Guide to Transformer Reasoning}\n";
        assert!(!has_own_title(shipped));
        assert!(has_own_title("  \\title{My paper}\n"));
        assert!(!has_own_title("no title here"));
        assert_eq!(title_line(shipped), Some(2));
    }

    #[test]
    fn off_a_mac_the_agent_step_goes_and_the_wording_follows_the_host() {
        let ids = |host| {
            steps(host)
                .iter()
                .map(|step| step.step.id())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(Host::Mac),
            ["latex", "build", "jump", "cite", "agent", "own"]
        );
        assert_eq!(ids(Host::Linux), ["latex", "build", "jump", "cite", "own"]);
        let own = |host| {
            steps(host)
                .into_iter()
                .find(|step| step.step == Step::Own)
                .unwrap()
                .why
        };
        assert!(own(Host::Mac).contains("this Mac"));
        assert!(own(Host::Windows).contains("this computer"));
    }

    #[test]
    fn a_step_names_the_hosts_keys() {
        let build = &steps(Host::Mac)[1];
        assert_eq!(
            fill(build.hint.unwrap(), &Keys::of(Host::Mac)),
            "Edit the title, then press ⌘S"
        );
        assert_eq!(
            fill(build.hint.unwrap(), &Keys::of(Host::Linux)),
            "Edit the title, then press Ctrl+S"
        );
    }
}
