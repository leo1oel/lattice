//! Settings › About › Acknowledgements (`acknowledgements-settings.tsx`): the
//! open-source work Lattice is built on and ships. The major components come
//! first (`credits.rs`), then every package of every shipped closure, read
//! from the THIRD_PARTY_NOTICES.md this build embeds (`notices.rs`), folded
//! by closure and searchable; a package opens its license texts in a sheet,
//! and Third-party notices opens the whole file.
//!
//! In a build that embeds the Timeless fonts their credit leads the type
//! group, with the license that came with them shown in the app's own PDF
//! viewer, since the license lets the fonts go to no one without it.

mod credits;
mod notices;
mod sheets;

use std::collections::BTreeSet;

use gpui::{
    AnyElement, AppContext as _, ClickEvent, Context, ElementId, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, Field, IconButton},
};

use super::{
    controls::{self, PageWidth, Row},
    dialog::SettingsDialog,
};
use credits::{CORE_SOFTWARE, Credit, DESIGN_CREDITS, ORIGIN_CREDITS};
use notices::{Closure, Package};
pub use sheets::Sheet;

/// A search narrows the list to this many rows; a longer query narrows it
/// further.
const SEARCH_RESULT_LIMIT: usize = 200;

fn closure_label(closure: Closure) -> SharedString {
    match closure {
        Closure::Npm => t!("Interface"),
        Closure::Crates => t!("Native app"),
        Closure::Sidecar => t!("Agent runtime"),
        Closure::PresentationRuntime => t!("Presentation runtime"),
    }
    .into()
}

pub struct Acknowledgements {
    search: Entity<InputState>,
    /// The closures unfolded.
    open: BTreeSet<Closure>,
    /// The sheet over Settings, if one is open.
    pub(super) sheet: Option<Sheet>,
    _subscription: Subscription,
}

/// Settings › Acknowledgements, its search made the first time it is drawn.
pub fn render(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let pane = dialog
        .pages
        .acknowledgements
        .get_or_insert_with(|| cx.new(|cx| Acknowledgements::new(window, cx)))
        .clone();
    pane.update(cx, |pane, cx| pane.render_page(width, cx))
}

impl Acknowledgements {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder(t!("Search by name or license")));
        let subscription = cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                cx.notify();
            }
        });
        Self {
            search,
            open: BTreeSet::new(),
            sheet: None,
            _subscription: subscription,
        }
    }

    fn open_sheet(&mut self, sheet: Sheet, cx: &mut Context<Self>) {
        self.sheet = Some(sheet);
        cx.notify();
    }

    /// Third-party notices: the whole file.
    pub(super) fn open_whole_notices(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let sheet = Sheet::notices(None, window, cx);
        self.open_sheet(sheet, cx);
    }

    pub(super) fn close_sheet(&mut self, cx: &mut Context<Self>) {
        self.sheet = None;
        cx.notify();
    }

    fn render_page(&mut self, width: PageWidth, cx: &mut Context<Self>) -> AnyElement {
        let notices = notices::shipped();
        let this = cx.entity();
        let mut groups = vec![controls::first_group(
            Some(t!("Core components").into()),
            CORE_SOFTWARE
                .iter()
                .map(|credit| credit_row(credit, width, cx))
                .collect(),
            cx,
        )];
        let mut design: Vec<AnyElement> = Vec::new();
        if lattice_ui::fonts::font_license().is_some() {
            let view = {
                let this = this.clone();
                Button::new("acknowledgements-font-license", t!("View license"))
                    .compact()
                    .ghost()
                    .on_click(move |_, window, cx| {
                        this.update(cx, |pane, cx| {
                            if let Some(sheet) = Sheet::font_license(window, cx) {
                                pane.open_sheet(sheet, cx)
                            }
                        })
                    })
            };
            let site = Button::new("acknowledgements-font-site", credits::TIMELESS_SITE)
                .compact()
                .ghost()
                .trailing_icon(Icon::EXTERNAL_LINK)
                .on_click(|_, _, cx| cx.open_url(credits::TIMELESS_URL));
            design.push(
                Row::new("acknowledgements-timeless", credits::TIMELESS_NAME)
                    .description(
                        t!(
                            "Type family by Timeless Ventures Private Limited, Chennai, used under the {license}. Get the fonts from timeless.co",
                            license = credits::TIMELESS_LICENSE
                        ),
                        cx,
                    )
                    .control(div().flex().gap(px(4.)).child(view).child(site))
                    .render(width, cx),
            );
        }
        design.extend(
            DESIGN_CREDITS
                .iter()
                .map(|credit| credit_row(credit, width, cx)),
        );
        groups.push(controls::group(
            Some(t!("Type, icons and sound").into()),
            design,
            cx,
        ));
        groups.push(controls::group(
            Some(t!("Origins and adapted work").into()),
            ORIGIN_CREDITS
                .iter()
                .map(|credit| credit_row(credit, width, cx))
                .collect(),
            cx,
        ));
        groups.push(self.dependency_list(cx));

        let notices_button = Button::new("acknowledgements-notices", t!("Third-party notices"))
            .compact()
            .icon(Icon::FILE_TEXT)
            .disabled(notices.packages.is_empty())
            .on_click(move |_, window, cx| {
                this.update(cx, |pane, cx| {
                    pane.open_sheet(Sheet::notices(None, window, cx), cx)
                })
            });
        // The header's action sits at the right of the title
        // (`SettingsSectionHeader`'s `actions`).
        let page = controls::page(t!("Acknowledgements"), width, groups, cx);
        div()
            .relative()
            .child(page)
            .child(
                div()
                    .absolute()
                    .top(if width.narrow_dialog { px(8.) } else { px(32.) })
                    .right(width.inset() + (width.width - controls::CONTENT_MAX_WIDTH).max(px(0.)))
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .child(notices_button),
            )
            .into_any_element()
    }

    /// Every package the shipped closures hold, searchable (`DependencyList`).
    fn dependency_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let notices = notices::shipped();
        let total = notices.packages.len();
        let query = self.search.read(cx).value().trim().to_string();
        let needle = query.to_lowercase();
        let lead = |text: SharedString, cx: &Context<Self>| {
            div()
                .my(px(4.))
                .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                .text_color(cx.palette().text_secondary)
                .child(text)
                .into_any_element()
        };
        let mut body: Vec<AnyElement> = vec![
            div()
                .mt(px(6.))
                .mb(px(4.))
                .child(Field::new(&self.search).search().compact())
                .into_any_element(),
        ];
        if !needle.is_empty() {
            let matches: Vec<&Package> = notices
                .packages
                .iter()
                .filter(|package| {
                    format!("{} {}", package.name, package.license)
                        .to_lowercase()
                        .contains(&needle)
                })
                .collect();
            let shown = &matches[..matches.len().min(SEARCH_RESULT_LIMIT)];
            if shown.is_empty() {
                body.push(lead(t!("Nothing matches “{0}”.", &query).into(), cx));
            }
            for closure in Closure::ORDER {
                let rows: Vec<&Package> = shown
                    .iter()
                    .copied()
                    .filter(|package| package.closure == closure)
                    .collect();
                if rows.is_empty() {
                    continue;
                }
                body.push(
                    div()
                        .mt(px(8.))
                        .mb(px(2.))
                        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                        .text_color(palette.text_secondary)
                        .child(closure_label(closure))
                        .into_any_element(),
                );
                body.extend(
                    rows.into_iter()
                        .map(|package| self.package_row(package, false, cx)),
                );
            }
            if matches.len() > shown.len() {
                body.push(lead(
                    t!("Showing {0} of {1}", shown.len(), matches.len()).into(),
                    cx,
                ));
            }
        } else {
            for closure in Closure::ORDER {
                let rows: Vec<&Package> = notices
                    .packages
                    .iter()
                    .filter(|package| package.closure == closure)
                    .collect();
                if rows.is_empty() {
                    continue;
                }
                let expanded = self.open.contains(&closure);
                body.push(self.closure_toggle(closure, rows.len(), expanded, cx));
                if expanded {
                    body.extend(
                        rows.into_iter()
                            .map(|package| self.package_row(package, true, cx)),
                    );
                }
            }
        }
        let title = t!("All third-party software ({total})", total = total);
        controls::group(
            Some(title.into()),
            vec![controls::block(
                div().flex().flex_col().children(body),
                false,
            )],
            cx,
        )
    }

    /// A closure folded to one row, its chevron turning as it opens.
    fn closure_toggle(
        &self,
        closure: Closure,
        count: usize,
        expanded: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .id(ElementId::Name(
                format!("acknowledgements-closure-{closure:?}").into(),
            ))
            .w_full()
            .px(px(4.))
            .py(px(6.))
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(6.))
            .hover(|this| this.bg(palette.settings_control_hover))
            .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
            .text_color(palette.text)
            .child(
                div().flex_none().child(
                    Icon::CHEVRON_RIGHT
                        .element(px(14.), palette.text_secondary)
                        .with_transformation(gpui::Transformation::rotate(gpui::percentage(
                            if expanded { 0.25 } else { 0. },
                        ))),
                ),
            )
            .child(div().flex_1().min_w_0().child(closure_label(closure)))
            .child(
                div()
                    .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("{0} packages", count)),
            )
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                if !this.open.remove(&closure) {
                    this.open.insert(closure);
                }
                cx.notify();
            }))
            .into_any_element()
    }

    /// One package: its name, version and license, opening its texts.
    fn package_row(&self, package: &Package, indented: bool, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let opened = package.clone();
        let license: SharedString = if package.license.is_empty() {
            t!("No license declared").into()
        } else {
            package.license.clone().into()
        };
        div()
            .id(ElementId::Name(
                format!(
                    "acknowledgements-package-{:?}-{}@{}",
                    package.closure, package.name, package.version
                )
                .into(),
            ))
            .w_full()
            .py(px(2.))
            .pr(px(4.))
            .pl(if indented { px(16.) } else { px(4.) })
            .flex()
            .items_baseline()
            .gap(px(6.))
            .rounded(px(6.))
            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
            .text_color(palette.text_secondary)
            .hover(|this| {
                this.bg(palette.settings_control_hover)
                    .text_color(palette.text)
            })
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(package.name.clone()),
            )
            .child(div().flex_none().child(package.version.clone()))
            .child(
                div()
                    .ml_auto()
                    .flex_none()
                    .max_w(gpui::relative(0.45))
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(license),
            )
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                let sheet = Sheet::notices(Some(opened.clone()), window, cx);
                this.open_sheet(sheet, cx)
            }))
            .into_any_element()
    }
}

/// A credited work: its name and who made it, its license and version, and
/// a way to its site.
fn credit_row(credit: &Credit, width: PageWidth, cx: &mut Context<Acknowledgements>) -> AnyElement {
    let palette = cx.palette().clone();
    let notices = notices::shipped();
    let mut row = Row::new(
        controls::row_id("acknowledgements-credit", credit.name),
        credit.name,
    );
    if let Some(description) = credit.description() {
        row = row.description(description, cx);
    }
    let terms = credit.terms(notices).map(|terms| {
        div()
            .whitespace_nowrap()
            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
            .text_color(palette.text_secondary)
            .child(terms)
    });
    let site = credit.url.map(|url| {
        IconButton::new(
            ElementId::Name(format!("acknowledgements-site-{}", credit.name).into()),
            Icon::EXTERNAL_LINK,
        )
        .tooltip(t!("Open the {0} website", credit.name))
        .on_click(move |_, _, cx| cx.open_url(url))
    });
    if terms.is_some() || site.is_some() {
        row = row.control(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .children(terms)
                .children(site),
        );
    }
    row.render(width, cx)
}
