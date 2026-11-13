//! The setup dialogs, as the Tauri app draws them (`tex-install-dialog.tsx`,
//! `tex-setup-wizard.tsx`, `tex-dependency-installer.tsx`, `.tex-setup-*` in
//! dialogs.css): a dialog card with the title, the install's progress bar
//! and stage, the failure in plain words with the installer's own folded
//! under it, and the actions; and the TeX doctor's report in a sheet.

use gpui::{
    AnimationExt as _, AnyElement, App, Context, Entity, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Transformation, Window, div, percentage, prelude::*, px,
};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{Button, IconButton, LayerPlacement, ModalLayer, Sheet, rise_in},
    elevation::Elevation,
    tokens::CONTAINER_DIALOG,
};

use super::{
    TEX_INSTALL_SIZE_HINT,
    center::{InstallProgress, TexSetupCenter},
    only_paper_tools_missing, package_updates, required_setup_missing, stage_copy,
};
use crate::build::{doctor, icons};
use lattice_i18n::{t, tc};

/// The dialog card's frame, its title and what goes under it.
fn dialog(
    id: (&'static str, usize),
    title: String,
    description: Option<String>,
    body: Vec<AnyElement>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let card = div()
        .w(CONTAINER_DIALOG)
        .max_w(px(440.))
        .flex()
        .flex_col()
        .pt(px(20.))
        .px(px(20.))
        .pb(px(16.))
        .rounded(px(14.))
        .bg(palette.raised)
        .shadow(Elevation::Dialog.shadows(&palette))
        .child(
            div()
                .text_role(TextRole::Title, cx)
                .text_color(palette.text)
                .child(title),
        )
        .children(description.map(|description| {
            div()
                .pt(px(4.))
                .pb(px(16.))
                .text_role(TextRole::Body, cx)
                .text_color(palette.text_secondary)
                .child(description)
        }))
        .child(div().pt(px(16.)).flex().flex_col().children(body));
    rise_in(
        gpui::ElementId::NamedInteger(id.0.into(), id.1 as u64),
        card,
    )
}

/// The bar, then "Downloading BasicTeX… 42%" and what to expect.
fn progress(progress: &InstallProgress, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let percent = progress.percent();
    let (stage, detail) = stage_copy(&progress.stage);
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .mb(px(16.))
        .child(
            div()
                .h(px(6.))
                .w_full()
                .overflow_hidden()
                .rounded_full()
                .bg(palette.line)
                .child(
                    div()
                        .h_full()
                        .w(gpui::relative(percent as f32 / 100.))
                        .rounded_full()
                        .bg(palette.accent),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(format!("{stage} {percent}%")),
                )
                .when(!detail.is_empty(), |copy| {
                    copy.child(
                        div()
                            .text_role(TextRole::Micro, cx)
                            .text_color(palette.text_secondary)
                            .child(detail),
                    )
                }),
        )
        .into_any_element()
}

/// The failure in plain words, and the installer's own folded under it.
fn failure(
    summary: String,
    detail: Option<String>,
    center: &Entity<TexSetupCenter>,
    open: bool,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let toggle = center.clone();
    div()
        .flex()
        .flex_col()
        .mb(px(16.))
        .child(
            div()
                .py(px(8.))
                .px(px(10.))
                .rounded(px(6.))
                .bg(palette.danger_soft)
                .text_role(TextRole::Body, cx)
                .text_color(palette.danger)
                .child(summary),
        )
        .children(detail.filter(|detail| !detail.is_empty()).map(|detail| {
            let disclosure = div()
                .id("tex-setup-error-details")
                .flex()
                .items_center()
                .gap(px(2.))
                .mt(px(4.))
                .py(px(2.))
                .px(px(6.))
                .rounded(px(4.))
                .cursor_pointer()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(
                    icons::CHEVRON_RIGHT
                        .element(px(12.), palette.text_secondary)
                        .when(open, |chevron| {
                            chevron.with_transformation(Transformation::rotate(percentage(0.25)))
                        }),
                )
                .child(tc!("error disclosure", "Details"))
                .on_click(move |_, _, cx| {
                    toggle.update(cx, |center, cx| {
                        center.details_open = !center.details_open;
                        cx.notify();
                    });
                });
            div()
                .flex()
                .flex_col()
                .child(div().flex().child(disclosure))
                .when(open, |details| {
                    details.child(
                        div()
                            .mt(px(6.))
                            .max_h(px(132.))
                            .py(px(8.))
                            .px(px(10.))
                            .border_1()
                            .border_color(palette.line)
                            .rounded(px(6.))
                            .bg(palette.panel)
                            .font_family(cx.lattice().fonts.editor.clone())
                            .text_size(px(11.))
                            .line_height(px(16.5))
                            .text_color(palette.text_secondary)
                            .child(SharedString::from(detail)),
                    )
                })
        }))
        .into_any_element()
}

fn actions(children: Vec<AnyElement>) -> AnyElement {
    div()
        .flex()
        .justify_end()
        .gap(px(8.))
        .children(children)
        .into_any_element()
}

fn spinner() -> AnyElement {
    icons::LOADER
        .element(px(16.), gpui::white())
        .with_animation(
            "tex-setup-install-loader",
            gpui::Animation::new(std::time::Duration::from_secs(1)).repeat(),
            |mark, t| mark.with_transformation(Transformation::rotate(percentage(t))),
        )
        .into_any_element()
}

impl TexSetupCenter {
    fn wizard_dialog(&self, center: &Entity<TexSetupCenter>, cx: &App) -> AnyElement {
        let windows = cfg!(windows);
        let paper_only = only_paper_tools_missing(self.report());
        let ready = self.report().is_some() && !required_setup_missing(self.report());
        let installing = self.wizard.installing;
        let busy = self.busy() || installing;
        let label = if paper_only {
            t!("Install paper tools").to_string()
        } else if windows {
            t!(
                "Install TeX Live ({TEX_INSTALL_SIZE_HINT})",
                TEX_INSTALL_SIZE_HINT = TEX_INSTALL_SIZE_HINT
            )
        } else {
            t!(
                "Install Basic TeX ({TEX_INSTALL_SIZE_HINT})",
                TEX_INSTALL_SIZE_HINT = TEX_INSTALL_SIZE_HINT
            )
        };
        let can_put_off = paper_only || windows;
        // Alone, it spans the dialog, as the Tauri app's `.tex-setup-install`.
        let alone = !can_put_off && !(windows && installing);
        let install = {
            let center = center.clone();
            div()
                .flex()
                .items_center()
                .justify_center()
                .gap(px(6.))
                .when(alone, |row| row.w_full())
                // Spanning the dialog, the button leaves the progress bar to
                // say it is working.
                .children((installing && !alone).then(spinner))
                .child(
                    Button::new(("tex-setup-install", self.serial), label)
                        .primary()
                        .disabled(busy || ready)
                        .when(alone, |button| button.w_full())
                        .on_click(move |_, _, cx| {
                            center.update(cx, |center, cx| center.start_install(cx));
                        }),
                )
                .into_any_element()
        };
        // Only a Windows install can be stopped: the macOS one is a single
        // prompted script.
        let cancel = (windows && installing).then(|| {
            let center = center.clone();
            Button::new(("tex-setup-cancel", self.serial), t!("Cancel installation"))
                .ghost()
                .on_click(move |_, _, cx| center.update(cx, |center, cx| center.cancel_install(cx)))
                .into_any_element()
        });
        // Writing and reading work without TeX, so on Windows even the full
        // install may be put off; a failed install must not leave the
        // dialog unclosable.
        let later = can_put_off.then(|| {
            let center = center.clone();
            Button::new(("tex-setup-later", self.serial), t!("Install later"))
                .ghost()
                .disabled(installing)
                .on_click(move |_, _, cx| center.update(cx, |center, cx| center.close_wizard(cx)))
                .into_any_element()
        });
        let mut body = Vec::new();
        if installing && let Some(at) = &self.wizard.progress {
            body.push(progress(at, cx));
        }
        if let Some(error) = &self.wizard.error {
            body.push(failure(error.clone(), None, center, self.details_open, cx));
        }
        body.push(actions(
            later.into_iter().chain(cancel).chain([install]).collect(),
        ));
        dialog(
            ("tex-setup-wizard", self.serial),
            if paper_only { t!("Install required paper tools") } else { t!("Install LaTeX to compile") }.into(),
            paper_only.then(|| {
                t!("Adding papers and looking up citations run on uv, a 45 MB Python tool. Writing and compiling work without it.")
                    .to_string()
            }),
            body,
            cx,
        )
    }

    fn dependency_dialog(&self, center: &Entity<TexSetupCenter>, cx: &App) -> Option<AnyElement> {
        let install = self.dependency.as_ref()?;
        let packages = install
            .packages
            .as_ref()
            .filter(|_| !install.installing && install.error.is_none());
        let mut body = Vec::new();
        if packages.is_none() {
            body.push(progress(&install.progress, cx));
        }
        if let Some((summary, detail)) = Self::dependency_failure(install) {
            body.push(failure(
                summary,
                Some(detail),
                center,
                self.details_open,
                cx,
            ));
        }
        let cancel = |id: &'static str| {
            let center = center.clone();
            Button::new((id, self.serial), t!("Cancel"))
                .ghost()
                .on_click(move |_, _, cx| {
                    center.update(cx, |center, cx| center.close_dependency(cx))
                })
                .into_any_element()
        };
        if !install.installing && install.error.is_some() {
            let center = center.clone();
            let file = install.missing_file.clone();
            body.push(actions(vec![
                cancel("tex-dependency-cancel"),
                Button::new(("tex-dependency-retry", self.serial), t!("Try again"))
                    .primary()
                    .on_click(move |_, _, cx| {
                        let file = file.clone();
                        center.update(cx, |center, cx| center.install_dependency(file, None, cx));
                    })
                    .into_any_element(),
            ]));
        }
        if let Some(packages) = packages {
            let mut row = vec![cancel("tex-dependency-cancel")];
            for (ix, name) in packages.iter().enumerate() {
                let center = center.clone();
                let (file, name) = (install.missing_file.clone(), name.clone());
                row.push(
                    Button::new(("tex-dependency-package", ix), name.clone())
                        .on_click(move |_, _, cx| {
                            let (file, name) = (file.clone(), name.clone());
                            center.update(cx, |center, cx| {
                                center.install_dependency(file, Some(name), cx)
                            });
                        })
                        .into_any_element(),
                );
            }
            body.push(actions(row));
        }
        Some(dialog(
            ("tex-dependency", self.serial),
            t!("Install package for {0}", install.missing_file),
            packages.map(|_| {
                t!(
                    "Several TeX Live packages provide {0}. Choose the one to install.",
                    install.missing_file
                )
            }),
            body,
            cx,
        ))
    }

    /// The doctor's "TeX packages" check, once the repository has answered.
    fn package_tile(&self) -> Option<doctor::Tile> {
        let report = self.packages.report.as_ref()?;
        let detail = package_updates::check_detail(report);
        let mut details: Vec<String> = detail.iter().cloned().collect();
        if let Some(error) = &report.error {
            let (_, words) = package_updates::check_problem(error);
            details.extend((!words.is_empty()).then_some(words));
        } else if !report.packages.is_empty() && !report.managed {
            // A TeX Lattice did not install is the writer's to update.
            details.push(format!(
                "{} {}",
                t!("In Terminal:"),
                package_updates::UPDATE_COMMAND
            ));
        }
        Some(doctor::Tile {
            state: if detail.is_some() {
                doctor::TileState::Warn
            } else {
                doctor::TileState::Ready
            },
            label: t!("TeX packages").into(),
            details,
        })
    }

    /// Under the checklist, for the BasicTeX Lattice installed: the
    /// one-click update, its progress and its result.
    fn package_actions(&self, center: &Entity<TexSetupCenter>, cx: &App) -> AnyElement {
        let palette = cx.palette().clone();
        let updates = &self.packages;
        let mut parts: Vec<AnyElement> = Vec::new();
        if updates.offer() {
            let center = center.clone();
            parts.push(
                div()
                    .flex()
                    .child(
                        Button::new(
                            ("tex-packages-update", self.serial),
                            t!("Update TeX packages"),
                        )
                        .disabled(self.busy())
                        .on_click(move |_, _, cx| {
                            center.update(cx, |center, cx| center.update_packages(cx));
                        }),
                    )
                    .into_any_element(),
            );
        }
        if let Some(run) = &updates.run {
            if run.running {
                parts.push(progress(&run.progress, cx));
            } else if let Some(error) = &run.error {
                let (summary, detail) = package_updates::update_failure(error);
                parts.push(failure(
                    summary,
                    Some(detail),
                    center,
                    self.details_open,
                    cx,
                ));
            } else {
                parts.push(
                    div()
                        .py(px(8.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .bg(palette.success_soft)
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.success)
                        .child(t!("TeX packages updated. Build again to use them."))
                        .into_any_element(),
                );
            }
        }
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .children(parts)
            .into_any_element()
    }

    /// The doctor's header (its title and the rerun button) and its report,
    /// as the sheet and Settings › TeX doctor both show them.
    fn doctor_parts(&self, center: &Entity<TexSetupCenter>, cx: &App) -> (AnyElement, AnyElement) {
        let palette = cx.palette().clone();
        let busy = self.busy();
        let install = {
            let center = center.clone();
            div()
                .flex()
                .child(
                    Button::new(
                        ("tex-doctor-install", self.serial),
                        t!("Install required tools"),
                    )
                    .disabled(busy)
                    .on_click(move |_, _, cx| {
                        center.update(cx, |center, cx| center.open_wizard(cx))
                    }),
                )
                .into_any_element()
        };
        let rerun = {
            let center = center.clone();
            IconButton::new(("tex-doctor-run", self.serial), icons::REFRESH)
                .frame(px(28.), px(28.))
                .icon_size(px(14.))
                .disabled(busy)
                .tooltip(t!("Run TeX doctor"))
                .on_click(move |_, _, cx| {
                    center.update(cx, |center, cx| center.run_doctor(false, cx).detach());
                })
        };
        let content = match self.report() {
            Some(report) => {
                let mut actions = vec![self.package_actions(center, cx)];
                if !report.ok {
                    actions.push(install);
                }
                doctor::report_view(report, self.package_tile(), actions, cx)
            }
            None if !busy => doctor::not_checked(install, cx),
            None => div()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(t!("Checking the LaTeX tools…"))
                .into_any_element(),
        };
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(palette.text)
                    .child(t!("Environment")),
            )
            .child(rerun)
            .into_any_element();
        (header, content)
    }

    /// Settings › TeX doctor: the same header and report, on the page.
    pub fn doctor_page(&self, center: &Entity<TexSetupCenter>, cx: &App) -> AnyElement {
        let (header, content) = self.doctor_parts(center, cx);
        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(header)
            .child(content)
            .into_any_element()
    }

    fn doctor_sheet(&self, center: &Entity<TexSetupCenter>, cx: &App) -> AnyElement {
        let (header, content) = self.doctor_parts(center, cx);
        let close = center.clone();
        Sheet::new(("tex-doctor", self.serial), t!("TeX doctor"))
            .size(px(560.), px(520.))
            .on_close(move |_, cx| close.update(cx, |center, cx| center.close_doctor(cx)))
            .child(header)
            .child(content)
            .into_any_element()
    }
}

impl Render for TexSetupCenter {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let center = cx.entity();
        let mut layers: Vec<AnyElement> = Vec::new();
        if self.doctor_open {
            let close = center.clone();
            layers.push(
                ModalLayer::new(
                    ("tex-doctor-layer", self.serial),
                    LayerPlacement::Center,
                    self.doctor_sheet(&center, cx),
                    move |_, cx| close.update(cx, |center, cx| center.close_doctor(cx)),
                )
                .into_any_element(),
            );
        }
        if self.wizard_open {
            let paper_only = only_paper_tools_missing(self.report());
            let can_close = (paper_only || cfg!(windows)) && !self.wizard.installing;
            let close = center.clone();
            layers.push(
                ModalLayer::new(
                    ("tex-setup-layer", self.serial),
                    LayerPlacement::Center,
                    self.wizard_dialog(&center, cx),
                    move |_, cx| {
                        if can_close {
                            close.update(cx, |center, cx| center.close_wizard(cx));
                        }
                    },
                )
                .closable_by_scrim(can_close)
                .into_any_element(),
            );
        }
        if let Some(dialog) = self.dependency_dialog(&center, cx) {
            let installing = self
                .dependency
                .as_ref()
                .is_some_and(|install| install.installing);
            let close = center.clone();
            layers.push(
                ModalLayer::new(
                    ("tex-dependency-layer", self.serial),
                    LayerPlacement::Center,
                    dialog,
                    move |_, cx| close.update(cx, |center, cx| center.close_dependency(cx)),
                )
                .closable_by_scrim(!installing)
                .into_any_element(),
            );
        }
        div().children(layers)
    }
}
