//! The reminder that TeX packages are out of date, as the Tauri app's
//! `use-tex-update-reminder.ts` and `useDailyTexPackageCheck` give it.
//!
//! Once a week, a minute after launch (so tlmgr never competes with opening
//! a project), the TeX doctor's package check asks the repository what it
//! has newer; only an answer counts, so offline it tries again next launch.
//! TeX Live's repository changes daily, so a week batches those changes into
//! one update. When it finds updates in a tree the writer owns (handed over
//! by an earlier administrator prompt), it installs them silently, since no
//! password is needed; only a failed silent update falls back to the notice.
//! Otherwise a notice says so: a TeX Live tree under /usr/local/texlive gets
//! the doctor's one-click update, whose one administrator prompt hands the
//! tree over; any other TeX gets the command and a Copy button, since
//! Lattice does not change it. It never nags: once a launch at most, no
//! sooner than a day after the last one, and Later keeps it away three days.
//! A build running when the answer comes holds back the notice and the
//! silent update until the build ends, so neither lands over the build, and
//! an update (from anywhere) or a check that finds nothing left takes the
//! notice down.
//!
//! An update started from the reminder reports where it stands in a notice
//! of its own, its bar moving with tlmgr's progress, since the reminder is
//! gone and the doctor's progress lives in its sheet.

use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use gpui::{App, AppContext as _, Context, Entity, EntityId, Global, Subscription, Task};
use lattice_core::tex_setup::TexPackageUpdates;
use lattice_i18n::t;
use lattice_ui::components::{ToastLevel, ToastProgress};
use serde::{Deserialize, Serialize};

use super::{
    center::TexSetupCenter,
    package_updates::{UPDATE_COMMAND, update_failure},
};
use crate::notices::{self, Notice, NoticeAction};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// How often the background check asks (`PACKAGE_CHECK_INTERVAL_MS`).
const CHECK_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// How long Later keeps the reminder away (`REMINDER_SNOOZE_MS`).
pub const SNOOZE: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// After launch, so the check never competes with opening a project
/// (`BACKGROUND_CHECK_DELAY_MS`).
const CHECK_DELAY: Duration = Duration::from_secs(60);
const REMINDER_KEY: &str = "tex-package-update-reminder";
const UPDATE_KEY: &str = "tex-package-update-run";

/// When the reminder last showed, and until when Later holds it
/// (`lattice.tex-update-reminder.v1`), with the last answered check
/// (`lattice.tex-package-check.v1`); milliseconds since the epoch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(default)]
    pub shown_at: u64,
    #[serde(default)]
    pub snoozed_until: u64,
    #[serde(default)]
    pub checked_at: u64,
}

impl Record {
    /// At most one reminder a day, and none while Later holds.
    pub fn due(&self, now: u64) -> bool {
        now >= self.snoozed_until && now.saturating_sub(self.shown_at) >= DAY.as_millis() as u64
    }

    /// The weekly check has not run this week.
    pub fn check_due(&self, now: u64) -> bool {
        now.saturating_sub(self.checked_at) >= CHECK_INTERVAL.as_millis() as u64
    }
}

/// How many packages a check found outdated; 0 when it could not ask.
fn outdated(report: Option<&TexPackageUpdates>) -> usize {
    report
        .filter(|report| report.error.is_none())
        .map_or(0, |report| report.packages.len())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// What a check that found updates waits to do once no build runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pending {
    Remind,
    /// Update silently: the writer owns the tree, so no password is needed.
    Install,
}

pub struct Reminder {
    file: Option<PathBuf>,
    /// A weekly check found updates and waits for its moment.
    pending: Option<Pending>,
    /// A silent update is running; a failure brings the reminder instead.
    installing: bool,
    /// The reminder is on screen, or was this launch.
    shown: bool,
    /// The daily check is waiting for the center's answer.
    checking: bool,
    /// The update the writer started from the reminder, followed to its end.
    following: bool,
    /// The last stage the following notice said.
    stage: Option<String>,
    /// The windows whose builds are running.
    building: HashSet<EntityId>,
    _observe: Subscription,
    _check: Option<Task<()>>,
}

struct ReminderGlobal(Entity<Reminder>);

impl Global for ReminderGlobal {}

/// Start the daily check, once, beside the center it asks.
pub fn install(center: &Entity<TexSetupCenter>, cx: &mut App) {
    if cx.has_global::<ReminderGlobal>() {
        return;
    }
    let file = crate::shell::workspaces::state_dir(crate::settings::scripted(cx))
        .map(|dir| dir.join("tex-update-reminder.json"));
    let center = center.clone();
    let reminder = cx.new(|cx| {
        let observe = cx.observe(&center, |this: &mut Reminder, center, cx| {
            this.center_changed(&center, cx)
        });
        let mut reminder = Reminder {
            file,
            pending: None,
            installing: false,
            shown: false,
            checking: false,
            following: false,
            stage: None,
            building: HashSet::new(),
            _observe: observe,
            _check: None,
        };
        // A scripted run has no state folder and checks nothing by itself.
        if reminder.file.is_some() && reminder.record().check_due(now_ms()) {
            reminder._check = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(CHECK_DELAY).await;
                this.update(cx, |this, cx| this.weekly_check(cx)).ok();
            }));
        }
        reminder
    });
    cx.set_global(ReminderGlobal(reminder));
}

/// A window's build started or ended; the reminder waits out every build.
pub fn building(window: EntityId, running: bool, cx: &mut App) {
    let Some(reminder) = cx
        .try_global::<ReminderGlobal>()
        .map(|global| global.0.clone())
    else {
        return;
    };
    reminder.update(cx, |this, cx| {
        let changed = if running {
            this.building.insert(window)
        } else {
            this.building.remove(&window)
        };
        if changed && !running {
            this.show_when_due(cx);
        }
    });
}

impl Reminder {
    fn record(&self) -> Record {
        self.file
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write(&self, change: impl FnOnce(&mut Record)) {
        let Some(file) = &self.file else {
            return;
        };
        let mut record = self.record();
        change(&mut record);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if let Ok(text) = serde_json::to_string(&record) {
            std::fs::write(file, text).ok();
        }
    }

    fn weekly_check(&mut self, cx: &mut Context<Self>) {
        let Some(center) = super::center::center(cx) else {
            return;
        };
        self.checking = true;
        center.update(cx, |center, cx| center.check_package_updates(false, cx));
    }

    /// The center moved: a check answered, or an update moved on.
    fn center_changed(&mut self, center: &Entity<TexSetupCenter>, cx: &mut Context<Self>) {
        let packages = center.read(cx).packages();
        if self.checking && !packages.checking {
            self.checking = false;
            // Only an answer counts; offline, the next launch asks again.
            if let Some(report) = packages.report.as_ref().filter(|r| r.error.is_none()) {
                let found = outdated(Some(report)) > 0;
                self.write(|record| record.checked_at = now_ms());
                if found && report.managed && report.passwordless {
                    self.pending = Some(Pending::Install);
                } else if found && self.record().due(now_ms()) && !self.shown {
                    self.pending = Some(Pending::Remind);
                }
            }
        }
        let running = packages.run.as_ref().is_some_and(|run| run.running);
        if self.installing && !running {
            self.installing = false;
            let failed = packages.run.as_ref().is_some_and(|run| run.error.is_some());
            if failed && !self.shown {
                self.pending = Some(Pending::Remind);
            }
        }
        let count = outdated(packages.report.as_ref());
        // Updating, or nothing left to update: the reminder has said its piece.
        if self.shown
            && (running
                || (packages.report.as_ref().is_some_and(|r| r.error.is_none()) && count == 0))
        {
            notices::dismiss(REMINDER_KEY, cx);
        }
        self.follow(center, cx);
        self.show_when_due(cx);
    }

    /// Show the pending reminder, or start the silent update, unless a build
    /// or an update is running.
    fn show_when_due(&mut self, cx: &mut Context<Self>) {
        let Some(pending) = self.pending else {
            return;
        };
        if !self.building.is_empty() {
            return;
        }
        let Some(center) = super::center::center(cx) else {
            return;
        };
        let packages = center.read(cx).packages();
        if packages.run.as_ref().is_some_and(|run| run.running) {
            return;
        }
        let count = outdated(packages.report.as_ref());
        // An update elsewhere (the doctor) may have left nothing to do.
        let Some(report) = packages.report.clone().filter(|_| count > 0) else {
            self.pending = None;
            return;
        };
        self.pending = None;
        if pending == Pending::Install {
            self.installing = true;
            center.update(cx, |center, cx| center.update_packages(cx));
            return;
        }
        self.shown = true;
        self.write(|record| record.shown_at = now_ms());
        notices::show(reminder_notice(&report, cx.entity()), cx);
    }

    /// Say where an update started from the reminder stands.
    fn follow(&mut self, center: &Entity<TexSetupCenter>, cx: &mut Context<Self>) {
        if !self.following {
            return;
        }
        let Some(run) = center.read(cx).packages().run.clone() else {
            return;
        };
        if run.running {
            let share = ToastProgress::Fraction(run.progress.progress as f32);
            // Progress moves the bar without a new notice; only stages make one.
            if self.stage.as_deref() == Some(run.progress.stage.as_str()) {
                notices::update_progress(UPDATE_KEY, share, cx);
                return;
            }
            self.stage = Some(run.progress.stage.clone());
            let authorizing = run.progress.stage == "authorizing";
            let (title, detail) = if authorizing {
                (
                    t!("Waiting for administrator approval…"),
                    t!("Approve the macOS prompt to continue"),
                )
            } else {
                (
                    t!("Updating LaTeX packages…"),
                    t!("Can take up to 15 minutes"),
                )
            };
            notices::show(
                Notice::new(ToastLevel::Info, title)
                    .source(t!("LaTeX setup"))
                    .detail(detail)
                    .progress(share)
                    .key(UPDATE_KEY),
                cx,
            );
            return;
        }
        self.following = false;
        self.stage = None;
        let notice = match &run.error {
            Some(error) => {
                let (summary, detail) = update_failure(error);
                Notice::new(ToastLevel::Error, summary).detail(detail)
            }
            None => Notice::new(
                ToastLevel::Success,
                t!("TeX packages updated. Build again to use them."),
            ),
        };
        notices::show(notice.source(t!("LaTeX setup")).key(UPDATE_KEY), cx);
    }

    fn snooze(&mut self) {
        self.write(|record| record.snoozed_until = now_ms() + SNOOZE.as_millis() as u64);
    }

    fn update(&mut self, cx: &mut Context<Self>) {
        let Some(center) = super::center::center(cx) else {
            return;
        };
        self.following = true;
        self.stage = None;
        center.update(cx, |center, cx| center.update_packages(cx));
    }

    /// Show the reminder for `report` now, as a daily check that found it
    /// would once nothing holds it back, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn remind(&mut self, cx: &mut Context<Self>) {
        self.pending = Some(Pending::Remind);
        self.show_when_due(cx);
    }
}

/// The reminder itself.
fn reminder_notice(report: &TexPackageUpdates, reminder: Entity<Reminder>) -> Notice {
    let count = report.packages.len();
    let later = {
        let reminder = reminder.clone();
        NoticeAction::new(t!("Later"), move |_, cx| {
            reminder.update(cx, |this, _| this.snooze());
        })
    };
    let notice = Notice::new(ToastLevel::Warning, t!("Your TeX packages are out of date"))
        .source(t!("LaTeX setup"))
        .key(REMINDER_KEY)
        .persistent();
    if report.managed {
        let detail = if report.passwordless {
            t!(
                "Updates available ({count}). Updating can take a few minutes.",
                count = count
            )
        } else {
            t!(
                "Updates available ({count}). Updating asks for your password once; after that, Lattice keeps TeX up to date without asking.",
                count = count
            )
        };
        notice
            .detail(detail)
            .action(NoticeAction::new(
                t!("Update TeX packages"),
                move |_, cx| {
                    reminder.update(cx, |this, cx| this.update(cx));
                },
            ))
            .action(later)
    } else {
        notice
            .detail(t!(
                "Updates available ({count}). In Terminal: {TEX_PACKAGE_UPDATE_COMMAND}",
                count = count,
                TEX_PACKAGE_UPDATE_COMMAND = UPDATE_COMMAND
            ))
            .copy(UPDATE_COMMAND)
            .action(later)
    }
}

/// The reminder, once a center has made it, for a scenario.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn reminder(cx: &App) -> Option<Entity<Reminder>> {
    cx.try_global::<ReminderGlobal>()
        .map(|global| global.0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    #[test]
    fn it_reminds_at_most_daily_and_not_while_later_holds() {
        let now = 10 * DAY_MS;
        assert!(Record::default().due(now));
        let shown = Record {
            shown_at: now - DAY_MS / 2,
            ..Record::default()
        };
        assert!(!shown.due(now));
        assert!(shown.due(now + DAY_MS));
        let snoozed = Record {
            snoozed_until: now + 3 * DAY_MS,
            ..Record::default()
        };
        assert!(!snoozed.due(now + 2 * DAY_MS));
        assert!(snoozed.due(now + 3 * DAY_MS));
    }

    #[test]
    fn the_check_runs_once_a_week() {
        let now = 10 * DAY_MS;
        assert!(Record::default().check_due(now));
        let checked = Record {
            checked_at: now - 7 * DAY_MS + 1,
            ..Record::default()
        };
        assert!(!checked.check_due(now));
        assert!(checked.check_due(now + 1));
    }

    #[test]
    fn the_record_reads_the_tauri_apps_field_names() {
        let record: Record = serde_json::from_str(r#"{"shownAt":5,"snoozedUntil":7}"#).unwrap();
        assert_eq!(
            (record.shown_at, record.snoozed_until, record.checked_at),
            (5, 7, 0)
        );
    }

    #[test]
    fn a_check_that_could_not_ask_finds_nothing() {
        let report = TexPackageUpdates {
            managed: true,
            passwordless: false,
            packages: Vec::new(),
            error: Some("offline".into()),
        };
        assert_eq!(outdated(Some(&report)), 0);
        assert_eq!(outdated(None), 0);
    }
}
