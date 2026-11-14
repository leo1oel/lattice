//! Taking a project across: opening it (the folder already linked here, or
//! a download into Overleaf Projects), uploading this one as a new Overleaf
//! project, and what the picker shows of either in flight.

use super::*;

impl OverleafPicker {
    /// Open `project`: the folder on this Mac already linked to it when there
    /// is one (a second copy would sync too and drift from the first), else
    /// a download. The copy first takes the role the dashboard reports now.
    pub(super) fn open_project(
        &mut self,
        project: OverleafProject,
        here: bool,
        cx: &mut Context<Self>,
    ) {
        if self.working() {
            return;
        }
        if self.copies_loading {
            self.opening = Some(project.clone());
            self.transfer_error = None;
            self.parked_open = Some((project, here));
            cx.notify();
            return;
        }
        let Some(copy) = self.local_copies.get(&project.id).cloned() else {
            self.clone_project(project, here, cx);
            return;
        };
        self.opening = Some(project.clone());
        self.transfer_error = None;
        cx.notify();
        let path = PathBuf::from(&copy.path);
        let reopen = {
            let path = path.clone();
            let id = project.id.clone();
            let access = project.access_level.clone();
            cx.background_spawn(
                async move { sync::reopen_local_copy(&path, &id, access.as_deref()) },
            )
        };
        self.task = Some(cx.spawn(async move |this, cx| {
            let reopened = reopen.await;
            this.update(cx, |this, cx| {
                this.opening = None;
                match reopened {
                    Ok(()) => cx.emit(PickerEvent::Open { root: path, here }),
                    Err(error) => {
                        this.transfer_error = Some(error.clone().into());
                        notices::error(t!("Could not open the Overleaf project"), error, cx);
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Download `project` into its folder. A folder of that name already
    /// holding files with no link (what Stop syncing leaves) is asked about
    /// rather than chosen for: link it, or download a separate copy.
    pub(super) fn clone_project(
        &mut self,
        project: OverleafProject,
        here: bool,
        cx: &mut Context<Self>,
    ) {
        let target = {
            let (id, name) = (project.id.clone(), project.name.clone());
            cx.background_spawn(async move { sync::clone_target(&id, &name).ok() })
        };
        self.opening = Some(project.clone());
        cx.notify();
        self.task = Some(cx.spawn(async move |this, cx| {
            let target = target.await;
            this.update(cx, |this, cx| {
                this.opening = None;
                match target.filter(|target| target.kind == "occupied") {
                    Some(target) => {
                        let (title, body) = split_question(&t!("“{0}” already has files and isn’t linked to Overleaf\n\nFiles that differ are kept side by side. Nothing is overwritten", &target.folder));
                        let adopt = cx.entity().downgrade();
                        let fresh = adopt.clone();
                        let (adopted, separate) = (project.clone(), project.clone());
                        confirm::ask(
                            Confirm::new(title)
                                .body(body)
                                .confirm_label(t!("Link this folder"))
                                .cancel_label(t!("Download a new copy"))
                                .on_confirm(move |_, cx| {
                                    let project = adopted.clone();
                                    adopt
                                        .update(cx, |this, cx| this.download(project, here, true, cx))
                                        .ok();
                                })
                                .on_cancel(move |cx| {
                                    fresh
                                        .update(cx, |this, cx| this.download(separate, here, false, cx))
                                        .ok();
                                }),
                            cx,
                        );
                    }
                    None => this.download(project, here, false, cx),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub(super) fn download(
        &mut self,
        project: OverleafProject,
        here: bool,
        adopt: bool,
        cx: &mut Context<Self>,
    ) {
        if self.transferring() {
            return;
        }
        self.cloning = Some(project.clone());
        self.downloaded = Some((DownloadTrack::new(), Instant::now()));
        self.transfer_error = None;
        self.clock = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    return;
                }
            }
        }));
        cx.notify();
        let (sender, mut steps) = futures::channel::mpsc::unbounded();
        let run = cx.background_spawn(async move {
            sync::clone(
                &project.id,
                &project.name,
                project.access_level.as_deref(),
                adopt,
                move |step| {
                    sender.unbounded_send(step).ok();
                },
            )
        });
        self.task = Some(cx.spawn(async move |this, cx| {
            let progress = cx.spawn({
                let this = this.clone();
                async move |cx| {
                    use futures::StreamExt as _;
                    while let Some(step) = steps.next().await {
                        let landed = this.update(cx, |this, cx| {
                            // Late progress from a download that ended is dropped.
                            if let Some((track, started)) = &mut this.downloaded {
                                track.record(step, started.elapsed().as_secs_f64() * 1_000.);
                                cx.notify();
                            }
                        });
                        if landed.is_err() {
                            break;
                        }
                    }
                }
            });
            let (root, expired) = run.await;
            drop(progress);
            this.update(cx, |this, cx| {
                this.cloning = None;
                this.downloaded = None;
                this.clock = None;
                match root {
                    Ok(root) => cx.emit(PickerEvent::Open { root, here }),
                    Err(error) => this.failed(error, expired, cx, |this, error, cx| {
                        this.transfer_error = Some(error.clone().into());
                        notices::error(t!("Could not open the Overleaf project"), error, cx);
                    }),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Upload the open project as a new Overleaf project, after asking.
    pub(super) fn publish(&mut self, cx: &mut Context<Self>) {
        let name = self.publish_name.read(cx).value().trim().to_string();
        if name.is_empty() || self.setup.current_project.is_none() || self.working() {
            return;
        }
        let (title, body) = split_question(&t!(
            "Upload “{name}” to Overleaf and connect this folder?\n\nLattice will create a new Overleaf project from the files that normally sync. Lattice app data, saved account credentials, build output and Git history stay on this Mac.",
            name = &name
        ));
        let this = cx.entity().downgrade();
        confirm::ask(
            Confirm::new(title).body(body).on_confirm(move |_, cx| {
                let name = name.clone();
                this.update(cx, |this, cx| {
                    this.publishing = true;
                    this.transfer_error = None;
                    cx.emit(PickerEvent::Publish(name));
                    cx.notify();
                })
                .ok();
            }),
            cx,
        );
    }

    /// The window's answer to [`PickerEvent::Publish`]: linked, cancelled
    /// (saving did not finish), or why the upload failed.
    pub fn published(&mut self, result: Result<bool, (String, bool)>, cx: &mut Context<Self>) {
        self.publishing = false;
        match result {
            Ok(true) => {
                notices::show(
                    notices::Notice::new(
                        lattice_ui::components::ToastLevel::Success,
                        t!("Project uploaded and connected to Overleaf."),
                    ),
                    cx,
                );
                cx.emit(PickerEvent::Dismiss);
            }
            Ok(false) => {}
            Err((error, expired)) => self.failed(error, expired, cx, |this, error, cx| {
                this.transfer_error = Some(error.clone().into());
                notices::error(t!("Could not upload the project to Overleaf"), error, cx);
            }),
        }
        cx.notify();
    }

    pub(super) fn open_invitation(&mut self, invite: &OverleafInvite, cx: &mut Context<Self>) {
        self.invitation_opened = true;
        cx.open_url(&invite.url);
        cx.notify();
    }

    /// The upload offer (`.overleaf-publish-card`).
    pub(super) fn publish_card(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let working = self.working();
        let ready = !self.publish_name.read(cx).value().trim().is_empty();
        let button = Button::new(
            "overleaf-publish",
            if self.publishing {
                t!("Uploading…")
            } else {
                t!("Upload and connect")
            },
        )
        .variant(ButtonVariant::Primary)
        .icon(Icon::CLOUD)
        .disabled(working || !ready)
        .on_click(cx.listener(|this, _, _, cx| this.publish(cx)));
        div()
            .relative()
            .children(parity::bordered_probe(
                "overleaf/picker/publish",
                gpui::Edges::all(px(1.)),
            ))
            .mt(px(16.))
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(12.))
            .border_1()
            .border_color(palette.line)
            .rounded(RADIUS_PANEL)
            .bg(palette.panel)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(glyph(Icon::CLOUD_UPLOAD, Tone::Neutral, false, cx))
                    .child(
                        div()
                            .relative()
                            .text_role(TextRole::BodyCompact, cx)
                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                            .line_height(relative(1.25))
                            .text_color(palette.text)
                            .children(parity::probe("overleaf/picker/publish/title"))
                            .children(parity::text_probe(
                                "overleaf/picker/publish/title",
                                0,
                                t!("Upload this project to Overleaf"),
                            ))
                            .child(t!("Upload this project to Overleaf")),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(160.))
                            .child(Field::new(&self.publish_name).disabled(working)),
                    )
                    .child(button),
            )
            .into_any_element()
    }

    /// A transfer in progress: the quiet footer line, or the download's bar.
    pub(super) fn progress(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        let footer = || {
            div()
                .flex_none()
                .mt(px(12.))
                .py(px(10.))
                .px(px(12.))
                .rounded(RADIUS_CONTROL)
                .bg(palette.accent_soft)
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text)
        };
        if let (Some(project), Some((track, started))) = (&self.cloning, &self.downloaded) {
            let summary = summarize(track, 0., started.elapsed().as_secs_f64() * 1_000.);
            let track_bar = div()
                .relative()
                .h(px(4.))
                .rounded(RADIUS_PILL)
                .bg(wash(palette.text, 0.12))
                .overflow_hidden();
            let bar = match summary.fraction {
                Some(fraction) => track_bar.child(
                    div()
                        .h_full()
                        .w(relative(fraction as f32))
                        .rounded(RADIUS_PILL)
                        .bg(palette.accent),
                ),
                None => track_bar.child(
                    div()
                        .absolute()
                        .top_0()
                        .h_full()
                        .w(relative(0.35))
                        .rounded(RADIUS_PILL)
                        .bg(palette.accent)
                        .with_animation(
                            "overleaf-download-sweep",
                            gpui::Animation::new(Duration::from_millis(1_400))
                                .repeat()
                                .with_easing(gpui::ease_in_out),
                            |this, t| this.left(relative(-0.35 + 1.35 * t)),
                        ),
                ),
            };
            return Some(
                footer()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .min_w_0()
                            .child(infinity_loader(
                                "overleaf-download-loader",
                                px(15.),
                                &palette,
                            ))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .child(t!("Downloading {0}…", &project.name).to_string()),
                            )
                            .children(summary.percent.map(|percent| {
                                div()
                                    .flex_none()
                                    .text_color(palette.text_secondary)
                                    .child(percent)
                            })),
                    )
                    .child(bar)
                    .child(
                        div()
                            .text_color(palette.text_secondary)
                            .child(summary.detail),
                    )
                    .into_any_element(),
            );
        }
        let text = if let Some(opening) = &self.opening {
            t!("Opening {name}…", name = &opening.name).to_string()
        } else if self.publishing {
            t!("Uploading {0}…", self.publish_name.read(cx).value().trim()).to_string()
        } else {
            return None;
        };
        Some(
            footer()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(infinity_loader(
                    "overleaf-progress-loader",
                    px(15.),
                    &palette,
                ))
                .child(div().min_w_0().child(text))
                .into_any_element(),
        )
    }
}
