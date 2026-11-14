//! What fills the list's place: the skeleton while the connection is
//! checked and the projects load, a pasted link's answer, and the messages
//! for signed out, failed and empty.

use super::*;

/// Placeholder name widths (%) of the skeleton's rows, varied so they read
/// as titles.
const SKELETON_ROWS: [f32; 5] = [0.62, 0.44, 0.70, 0.52, 0.38];

impl OverleafPicker {
    /// The list's placeholder while the connection is checked and the
    /// projects load: the group heading and five 52px rows, revealed after
    /// 150 ms so a quick load shows nothing.
    pub(super) fn skeleton(
        &self,
        started: Instant,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let opacity = loading_opacity("overleaf-skeleton", started, window, cx);
        let bone = |width: gpui::DefiniteLength, height: f32, strong: bool| {
            div()
                .w(width)
                .h(px(height))
                .rounded(RADIUS_PILL)
                .bg(if strong {
                    palette.line_strong
                } else {
                    palette.line
                })
        };
        div()
            .flex_1()
            .opacity(opacity)
            .child(
                div()
                    .h(px(31.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .border_b_1()
                    .border_color(palette.line)
                    .bg(palette.panel)
                    .child(bone(px(84.).into(), 8., true)),
            )
            .children(SKELETON_ROWS.iter().enumerate().map(|(ix, width)| {
                div()
                    .h(px(52.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .when(ix + 1 < SKELETON_ROWS.len(), |row| {
                        row.border_b_1().border_color(palette.line)
                    })
                    .child(
                        div()
                            .size(px(28.))
                            .flex_none()
                            .rounded(RADIUS_CONTROL)
                            .bg(palette.line),
                    )
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(10.))
                            .child(bone(relative(*width), 8., false))
                            .child(bone(relative(width * 0.55), 6., false)),
                    )
            }))
            .relative()
            .overflow_hidden()
            .child(parts::sheen("overleaf-skeleton-sheen", palette.input))
            .into_any_element()
    }

    /// What a pasted link opens, when it is not a project to list.
    pub(super) fn pasted_message(&self, answer: &PastedLink, cx: &mut Context<Self>) -> AnyElement {
        let account = self
            .known()
            .and_then(|status| status.email.clone().or_else(|| status.name.clone()))
            .unwrap_or_else(|| t!("This Overleaf account").into());
        let host = self
            .known()
            .map(|status| status.host.clone())
            .unwrap_or_default();
        let browse = |url: String, label: SharedString, cx: &mut Context<Self>| {
            Button::new("overleaf-pasted-browse", label)
                .variant(ButtonVariant::Tinted)
                .size(ButtonSize::Compact)
                .icon(Icon::EXTERNAL_LINK)
                .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url)))
                .into_any_element()
        };
        let link_off = Icon("icons/link-2-off.svg");
        let shield_x = Icon("icons/shield-x.svg");
        let (icon, title, hint, action): (Icon, String, String, Option<AnyElement>) = match answer {
            PastedLink::NeedsJoin { project_name, url } => (
                link_off,
                match project_name {
                    Some(name) => t!("This account hasn’t joined “{0}” yet", name).into(),
                    None => t!("This account hasn’t joined this shared project yet").into(),
                },
                t!("Open the link in your browser and choose Join project on Overleaf, then paste it here again.").into(),
                Some(browse(url.clone(), t!("Open link in browser").into(), cx)),
            ),
            PastedLink::Invited { project_name, url } => (
                Icon::MAIL_OPEN,
                match project_name {
                    Some(name) => t!("Your invitation to “{0}” is waiting on Overleaf", name).into(),
                    None => t!("This invitation is waiting on Overleaf").into(),
                },
                t!("Accept it on Overleaf, then paste the link here again.").into(),
                Some(browse(url.clone(), t!("Open invitation").into(), cx)),
            ),
            PastedLink::NoAccess => (
                shield_x,
                t!("{0} can’t open this project", &account).into(),
                t!("If someone shared it with you, accept their invitation or open their share link once on Overleaf. If they shared it with another account, sign in with that one in Settings → Overleaf.").into(),
                None,
            ),
            PastedLink::NotFound => (
                link_off,
                t!("Overleaf doesn’t recognize this link").into(),
                t!("Its owner may have turned link sharing off or reset the link. Ask them for a new one.").into(),
                None,
            ),
            PastedLink::OtherHost { host: other } => (
                shield_x,
                t!("This link is for {0}", other).into(),
                t!("Lattice is signed in to {0}. To open projects from another Overleaf server, sign in to it in Settings → Overleaf.", &host).into(),
                None,
            ),
            PastedLink::Unrecognized => (
                link_off,
                t!("That isn’t an Overleaf project link").into(),
                t!("Copy the link from the project’s address bar or its Share menu.").into(),
                None,
            ),
            PastedLink::Project { .. } => return div().into_any_element(),
        };
        stage_message(
            Some(glyph(icon, Tone::Warning, true, cx)),
            [
                Some(stage_text(title, true, cx)),
                Some(parts::hint(hint, cx)),
                action,
            ]
            .into_iter()
            .flatten()
            .collect(),
        )
    }

    /// What the list frame holds now.
    pub(super) fn stage(&self, window: &mut Window, cx: &mut Context<Self>) -> (AnyElement, bool) {
        let retry = |id: &'static str,
                     error: SharedString,
                     busy: bool,
                     reload: fn(&mut Self, &mut Context<Self>),
                     cx: &mut Context<Self>| {
            let this = cx.entity().downgrade();
            stage_message(
                Some(glyph(Icon::CLOUD_OFF, Tone::Danger, true, cx)),
                vec![parts::retry_row(
                    id,
                    error,
                    busy,
                    t!("Retry").into(),
                    move |_, cx| {
                        this.update(cx, |this, cx| reload(this, cx)).ok();
                    },
                    true,
                    cx,
                )],
            )
        };
        if self.pasted.link.is_some() {
            if let Some(error) = self.pasted.error.clone() {
                return (
                    retry(
                        "overleaf-pasted-retry",
                        error,
                        self.pasted.checking,
                        |this, cx| {
                            let link = this.pasted.link.clone();
                            this.look_up(link, cx)
                        },
                        cx,
                    ),
                    false,
                );
            }
            return match &self.pasted.answer {
                None => (
                    self.skeleton(Instant::now() - Duration::from_secs(1), window, cx),
                    false,
                ),
                Some(PastedLink::Project { .. }) => (self.list(window, cx), true),
                Some(answer) => (self.pasted_message(answer, cx), false),
            };
        }
        if let Some(error) = self.projects_error.clone() {
            return (
                retry(
                    "overleaf-projects-retry",
                    error,
                    self.projects_loading.is_some(),
                    |this, cx| this.load_projects(cx),
                    cx,
                ),
                false,
            );
        }
        let Some(list) = &self.list else {
            let started = self.projects_loading.unwrap_or_else(Instant::now);
            return (self.skeleton(started, window, cx), false);
        };
        let rows = self.rows(cx);
        if rows.is_empty() && self.invites(cx).is_empty() {
            let query = self.query(cx);
            let (icon, text) = if list.projects.is_empty() {
                (Icon::FILE_TEXT, t!("No projects in this account yet"))
            } else if !query.trim().is_empty() {
                (Icon::SEARCH_X, t!("No projects match your search"))
            } else {
                (
                    Icon::FILE_TEXT,
                    t!("All your projects are archived or trashed"),
                )
            };
            return (
                stage_message(
                    Some(glyph(icon, Tone::Neutral, true, cx)),
                    vec![stage_text(text, false, cx)],
                ),
                false,
            );
        }
        (self.list(window, cx), true)
    }
}
