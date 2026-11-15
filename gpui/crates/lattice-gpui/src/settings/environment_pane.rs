//! Settings › Agent › Environment (`agent-environment-settings.tsx`): the
//! proxy and provider variables the agent receives, from the login shell
//! and the system proxy, and a restart that makes it read them again.
//!
//! The report is lattice-core's (`SynaraRuntime::agent_environment`, as the
//! Tauri app's `synara_agent_environment` returns it): values arrive
//! redacted, so a key never reaches the page. Reading it runs the login
//! shell, which can take seconds, so it runs off the main thread, and a read
//! that finishes after a newer one started is dropped.

use gpui::{
    AnyElement, AppContext as _, Context, IntoElement, ParentElement as _, SharedString, Styled as _, Task, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _, TypeScale, components::Button,
};
use serde_json::Value;

use super::{
    controls::{self, Level, PageWidth, Row},
    dialog::SettingsDialog,
};
use crate::agent::runtime::AgentRuntime;

/// Settings › Environment, its report read the first time it is drawn.
pub fn render(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let marks = super::pages::marks(dialog);
    let pane = dialog
        .pages
        .environment
        .get_or_insert_with(|| cx.new(EnvironmentPane::new))
        .clone();
    pane.update(cx, |pane, cx| pane.render_page(width, &marks, cx))
}

pub struct EnvironmentPane {
    report: Option<Value>,
    reading: bool,
    restarting: bool,
    error: Option<String>,
    /// Bumped by each read, so only the newest one lands.
    generation: u64,
    _task: Option<Task<()>>,
}

impl EnvironmentPane {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let mut pane = Self {
            report: None,
            reading: false,
            restarting: false,
            error: None,
            generation: 0,
            _task: None,
        };
        pane.read(cx);
        pane
    }

    /// Read the report again.
    fn read(&mut self, cx: &mut Context<Self>) {
        self.reading = true;
        self.error = None;
        self.generation += 1;
        let generation = self.generation;
        let supervisor = AgentRuntime::get(cx).supervisor().clone();
        let read = cx.background_spawn(async move {
            serde_json::to_value(supervisor.agent_environment()).map_err(|error| error.to_string())
        });
        self._task = Some(cx.spawn(async move |this, cx| {
            let report = read.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.reading = false;
                match report {
                    Ok(report) => this.report = Some(report),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Restart the agent, then read what the new one received.
    fn restart(&mut self, cx: &mut Context<Self>) {
        if self.restarting {
            return;
        }
        self.restarting = true;
        self.error = None;
        let restart = AgentRuntime::get(cx).restart(cx);
        self._task = Some(cx.spawn(async move |this, cx| {
            restart.await;
            this.update(cx, |this, cx| {
                this.restarting = false;
                this.read(cx);
            })
            .ok();
        }));
        cx.notify();
    }

    pub fn render_page(
        &mut self,
        width: PageWidth,
        marks: &controls::Marks,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let report = self.report.clone();
        let flag = |key: &str| {
            report
                .as_ref()
                .and_then(|report| report.get(key))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        let running = flag("running");
        let stale = flag("stale");
        let shell = report
            .as_ref()
            .and_then(|report| report.get("shell"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let shell_notice: Option<SharedString> = match report
            .as_ref()
            .and_then(|report| report.get("shellError"))
            .and_then(Value::as_str)
        {
            Some("timeout") => Some(
                t!(
                    "{shell} did not finish starting within 5 seconds, so its settings are missing. Check your shell startup files.",
                    shell = &shell
                )
                .into(),
            ),
            Some("failed") => Some(
                t!(
                    "Couldn’t read the settings {shell} exports, so they are missing.",
                    shell = &shell
                )
                .into(),
            ),
            _ => None,
        };

        let mut groups = Vec::new();
        if let Some(error) = &self.error {
            groups.push(controls::inline_message(Level::Error, error.clone(), cx));
        }

        let service_description = if !running {
            t!("The agent reads these each time it starts.")
        } else if stale {
            t!("The running agent started with different values. Restarting it stops any running turns.")
        } else {
            t!("Restarting the agent stops any running turns.")
        };
        let busy = self.reading || self.restarting;
        let this = cx.entity();
        let restart = running.then(|| {
            Button::new("agent-restart", t!("Restart agent"))
                .compact()
                .variant(if stale {
                    lattice_ui::components::ButtonVariant::Primary
                } else {
                    lattice_ui::components::ButtonVariant::Secondary
                })
                .disabled(self.restarting)
                .on_click(move |_, _, cx| this.update(cx, |pane, cx| pane.restart(cx)))
        });
        let service = Row::new("agent-restart", t!("Agent service"))
            .description(service_description, cx)
            .control(
                div()
                    .w(controls::CONTROL_WIDTH)
                    .max_w_full()
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap(px(8.))
                    .when(busy, |this| {
                        this.child(crate::build::chip_mark::infinity_loader(
                            "agent-environment-loading",
                            px(14.),
                            &palette,
                        ))
                    })
                    .children(restart),
            );
        groups.push(controls::first_group(None, vec![marks.row(service, width, cx)], cx));

        let mut rows: Vec<AnyElement> = Vec::new();
        if let Some(notice) = shell_notice {
            rows.push(controls::block(
                controls::inline_message(Level::Warning, notice, cx),
                false,
            ));
        }
        let variables = report
            .as_ref()
            .and_then(|report| report.get("variables"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if report.is_some() && variables.is_empty() {
            rows.push(
                Row::new("agent-environment-none", t!("None found"))
                    .description(
                        t!("Set HTTPS_PROXY or ANTHROPIC_BASE_URL in your shell startup file, or turn on a proxy in macOS, then restart the agent."),
                        cx,
                    )
                    .render(width, cx),
            );
        }
        let mono = cx.lattice().fonts.editor.clone();
        for variable in &variables {
            let field = |key: &str| {
                variable
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            let name = field("name");
            let value = field("value");
            let source = match field("source").as_str() {
                "shell" => t!("From your login shell"),
                "systemProxy" => t!("From the macOS proxy settings"),
                _ => t!("From the environment Lattice was opened with"),
            };
            rows.push(
                variable_row(&name, &value, source.into(), mono.clone(), cx),
            );
        }
        groups.push(controls::group(
            Some(t!("Variables the agent receives").into()),
            rows,
            cx,
        ));
        controls::described_page(
            t!("Environment"),
            Some(t!("Proxy settings and provider endpoints and keys, read from your login shell and the macOS network settings as a terminal would see them. Keys are shown shortened.").into()),
            width,
            groups,
            cx,
        )
    }
}

/// A variable's row: its name in the editor's face over where it came from,
/// its (redacted) value at the right, cut to the control column with an
/// ellipsis (`.agent-environment-value`).
fn variable_row(
    name: &str,
    value: &str,
    source: SharedString,
    mono: SharedString,
    cx: &mut Context<EnvironmentPane>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let copy = div()
        .flex_1()
        .min_w_0()
        .child(
            div()
                .font_family(mono.clone())
                .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                .text_color(palette.text)
                .child(name.to_string()),
        )
        .child(
            div()
                .mt(px(2.))
                .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                .text_color(palette.text_secondary)
                .child(source),
        );
    let value = div()
        .flex_none()
        .max_w(controls::CONTROL_WIDTH)
        .overflow_hidden()
        .text_ellipsis()
        .whitespace_nowrap()
        .font_family(mono)
        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
        .text_color(palette.text_secondary)
        .child(value.to_string());
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap_x(px(16.))
        .min_h(px(52.))
        .px(px(16.))
        .py(px(10.))
        .child(copy)
        .child(value)
        .into_any_element()
}
