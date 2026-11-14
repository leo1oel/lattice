//! The picker's list: a row per project (its Open buttons once chosen),
//! pending invitations, and the group headings over them.

use super::*;

impl OverleafPicker {
    /// One project's row: its tile, name and badges, owner and update, the
    /// local copy it opens, and on the chosen row its Open buttons.
    pub(super) fn project_row(
        &self,
        project: &OverleafProject,
        chosen: bool,
        hover: &FluidHover,
        ix: usize,
        probed: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let copy = self.local_copies.get(&project.id).cloned();
        let row_name = if chosen {
            "overleaf/picker/row/chosen"
        } else {
            "overleaf/picker/row"
        };
        let working = self.working();
        let owner = project
            .owner_name
            .clone()
            .filter(|name| !name.is_empty())
            .or_else(|| project.owner_email.clone())
            .unwrap_or_else(|| t!("Unknown owner").into());
        let updated = project
            .last_updated
            .as_deref()
            .map(|at| t!("updated {0}", relative_time(at)).to_string())
            .unwrap_or_else(|| t!("last update unknown").into());
        let badge = if project.trashed {
            Some(t!("Trashed"))
        } else if project.archived {
            Some(t!("Archived"))
        } else {
            None
        };
        let tile = div()
            .flex_none()
            .size(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(RADIUS_CONTROL)
            .bg(palette.panel)
            .border_1()
            .border_color(if chosen {
                palette.control_active_border
            } else {
                palette.line
            })
            .child(Icon::FILE_TEXT.element(
                px(15.),
                if chosen {
                    palette.accent
                } else {
                    palette.text_secondary
                },
            ));
        let select_id = project.id.clone();
        let main = div()
            .id(SharedString::from(format!(
                "overleaf-project-{}",
                project.id
            )))
            .flex_1()
            .min_w_0()
            .py(px(10.))
            .px(px(12.))
            .flex()
            .items_center()
            .gap(px(12.))
            .when(!working, |this| {
                this.on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                    if event.click_count() >= 2 {
                        if let Some(project) = this.rows(cx).into_iter().find(|p| p.id == select_id)
                        {
                            this.open_project(project, false, cx);
                        }
                    } else {
                        this.select(select_id.clone(), cx);
                    }
                }))
            })
            .child(tile)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .relative()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .when(probed && !chosen, |this| {
                                this.children(parity::probe("overleaf/picker/row/name"))
                            })
                            .child(
                                div()
                                    .relative()
                                    .min_w_0()
                                    .truncate()
                                    .text_role(TextRole::BodyCompact, cx)
                                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                                    // `.overleaf-project-name` sets the size
                                    // only, so the line is the row's 1.25.
                                    .line_height(relative(1.25))
                                    .text_color(palette.text)
                                    .when(probed && !chosen, |this| {
                                        this.children(parity::text_probe(
                                            "overleaf/picker/row/name",
                                            0,
                                            project.name.clone(),
                                        ))
                                    })
                                    .child(project.name.clone()),
                            )
                            .children(badge.map(|label| Badge::new(label).compact())),
                    )
                    .child({
                        let meta = join_phrases(&[owner, updated]);
                        div()
                            .relative()
                            .min_w_0()
                            .truncate()
                            .text_role(TextRole::Micro, cx)
                            .font_weight(FontWeight::NORMAL)
                            .text_color(palette.text_secondary)
                            .when(probed && !chosen, |this| {
                                this.children(parity::probe("overleaf/picker/row/meta"))
                                    .children(parity::text_probe(
                                        "overleaf/picker/row/meta",
                                        0,
                                        meta.clone(),
                                    ))
                            })
                            .child(meta)
                    })
                    .children(copy.map(|copy| {
                        div()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_role(TextRole::Micro, cx)
                            .text_color(palette.text_secondary)
                            .child(Icon::HARD_DRIVE.element(px(11.), palette.text_secondary))
                            .child(div().min_w_0().truncate().child(
                                t!("Opens your local copy at {0}", &copy.display).to_string(),
                            ))
                    })),
            );
        let downloading_this = self
            .cloning
            .as_ref()
            .is_some_and(|cloning| cloning.id == project.id);
        let buttons = (chosen && !downloading_this).then(|| {
            let (here_project, open_project) = (project.clone(), project.clone());
            let buttons = div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(8.))
                .when(self.setup.can_open_here, |this| {
                    this.child(
                        Button::new(("overleaf-open-here", ix), t!("Open in this window"))
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Compact)
                            .disabled(working)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_project(here_project.clone(), true, cx)
                            })),
                    )
                })
                .child(
                    Button::new(("overleaf-open", ix), t!("Open"))
                        .parity("overleaf/picker/open")
                        .variant(ButtonVariant::Tinted)
                        .size(ButtonSize::Compact)
                        .disabled(working)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_project(open_project.clone(), false, cx)
                        })),
                );
            reveal(
                ("overleaf-open-in", ix),
                Arrival {
                    motion: Motion::Moderate,
                    rise: 4.,
                    index: 0,
                },
                buttons,
                cx,
            )
        });
        let row = div()
            .relative()
            .when(probed || chosen, |this| {
                this.children(parity::bordered_probe(
                    row_name,
                    gpui::Edges {
                        bottom: px(1.),
                        ..Default::default()
                    },
                ))
            })
            .flex()
            .items_center()
            .gap(px(8.))
            .pr(px(12.))
            .border_b_1()
            .border_color(palette.line)
            .when(chosen, |this| this.bg(palette.accent_soft))
            .child(main)
            .children(buttons);
        hover.item_as(
            ix,
            if chosen {
                ItemKind::skip()
            } else {
                ItemKind::target()
            },
            row,
        )
    }

    pub(super) fn invite_row(
        &self,
        invite: &OverleafInvite,
        ix: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let meta = match &invite.inviter_name {
            Some(name) => {
                t!("{0} invited you. Accept on Overleaf to open it here", name).to_string()
            }
            None => t!("Accept the invitation on Overleaf to open it here").into(),
        };
        let opened = invite.clone();
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .pr(px(12.))
            .border_b_1()
            .border_color(palette.line)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .py(px(10.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex_none()
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_CONTROL)
                            .bg(palette.panel)
                            .border_1()
                            .border_color(palette.line)
                            .child(Icon::MAIL_OPEN.element(px(15.), palette.text_secondary)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .text_role(TextRole::BodyCompact, cx)
                                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                                            .text_color(palette.text)
                                            .child(invite.project_name.clone()),
                                    )
                                    .child(Badge::new(t!("Invitation")).compact()),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_role(TextRole::Micro, cx)
                                    .text_color(palette.text_secondary)
                                    .child(meta),
                            ),
                    ),
            )
            .child(
                Button::new(("overleaf-invite", ix), t!("Open invitation"))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Compact)
                    .icon(Icon::EXTERNAL_LINK)
                    .disabled(self.working())
                    .on_click(cx.listener(move |this, _, _, cx| this.open_invitation(&opened, cx))),
            )
            .into_any_element()
    }

    /// A group's sticky heading (`.overleaf-project-group h3`).
    pub(super) fn group_heading(
        &self,
        label: SharedString,
        trailing: Option<AnyElement>,
        cx: &App,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .py(px(8.))
            .px(px(12.))
            .border_b_1()
            .border_color(palette.line)
            .bg(palette.panel)
            .text_role(TextRole::Micro, cx)
            .font_weight(FONT_WEIGHT_SEMIBOLD)
            .text_color(palette.text_secondary)
            .child(label)
            .children(trailing)
            .into_any_element()
    }

    /// The list itself: invitations, then the projects.
    pub(super) fn list(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let rows = self.rows(cx);
        let invites = self.invites(cx);
        let current = self
            .selected
            .as_ref()
            .and_then(|id| rows.iter().position(|row| &row.id == id));
        let hover = FluidHover::new("overleaf-projects", window, cx).fill(palette.hover);
        let pasted = self.pasted.link.is_some();
        let mut children: Vec<AnyElement> = Vec::new();
        if !invites.is_empty() {
            let reload = self.invitation_opened.then(|| {
                Button::new("overleaf-reload-list", t!("Reload list"))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Compact)
                    .icon(Icon::REFRESH)
                    .disabled(self.projects_loading.is_some())
                    .on_click(cx.listener(|this, _, _, cx| this.load_projects(cx)))
                    .into_any_element()
            });
            children.push(self.group_heading(t!("Invitations").into(), reload, cx));
            for (ix, invite) in invites.iter().enumerate() {
                children.push(self.invite_row(invite, ix, cx));
            }
            if !rows.is_empty() {
                children.push(self.group_heading(t!("Projects").into(), None, cx));
            }
        }
        let first_other = (0..rows.len()).find(|ix| !(pasted || current == Some(*ix)));
        for (ix, project) in rows.iter().enumerate() {
            let chosen = pasted || current == Some(ix);
            children.push(self.project_row(
                project,
                chosen,
                &hover,
                ix,
                first_other == Some(ix),
                cx,
            ));
        }
        // The fill and the scrollbar are laid over the list's viewport, so
        // the scroll's own children are the rows `step` scrolls to.
        div()
            .relative()
            .flex_1()
            .min_h_0()
            .child(hover.highlight())
            .child(
                div()
                    .id("overleaf-project-list")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .children(children),
            )
            .child(FluidScrollbar::vertical(
                "overleaf-project-scroll",
                &self.scroll,
            ))
            .into_any_element()
    }
}
