//! One paper in the list, as the Tauri app draws it (`paper-row.tsx`,
//! `.paper-row` in `app-shell.css`): its glyph on the Project tree's icon
//! gutter, the title (two lines before the ellipsis in a narrow panel), and
//! the times the manuscript cites it at the end; under them the byline of
//! who, when and where, then a search's matching lines and any
//! citation-health notice.
//!
//! - The row stands 8px in on a 6px corner with 10px over and under; rows
//!   are 2px apart with a hairline between them at rest, which a lit or
//!   open row hides on both sides.
//! - The fill under the pointer is the list's fluid hover; the open (or, in
//!   a wide panel, selected) row keeps the tree's selected fill instead.
//! - Hovered or open, the row's citation key (a button that copies it) and
//!   its actions join the byline's line at its end, fading in on the fast
//!   tier; the line stays one line tall, so the rows below never move. A
//!   narrow row (under 300px) shows them in the byline's place; under 200px
//!   the key keeps only its copy icon.
//! - A wide panel lays the rows out as a table (Title, Authors, Year,
//!   Venue, Cited), one line each, the actions over the end of the title's
//!   line.

use lattice_i18n::t;
use std::{ops::Range, sync::Arc};

use gpui::{
    AnyElement, AnyView, App, ClickEvent, Context, Div, ElementId, HighlightStyle, Hsla,
    InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledText, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use lattice_core::papers::PaperSummary;
use lattice_ui::{
    ActiveLattice as _, Icon, Palette, TextRole, TextRoleStyle as _,
    components::LatticeTooltip,
    icons::{ICON, ICON_SMALL},
    interaction::{fade, mix, track_pointer, use_interaction},
    motion::Motion,
    tokens::FONT_WEIGHT_REGULAR,
};

use super::{FetchState, PapersPanel, model};

#[cfg(target_os = "macos")]
const REVEAL_LABEL: &str = lattice_i18n::n!("Show in Finder");
#[cfg(target_os = "windows")]
const REVEAL_LABEL: &str = lattice_i18n::n!("Show in Explorer");
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const REVEAL_LABEL: &str = lattice_i18n::n!("Show in file manager");

/// The table's columns after the glyph and title: Authors, Year, Venue,
/// Cited (`--paper-table-columns`).
pub const TABLE_AUTHORS: f32 = 200.;
pub const TABLE_YEAR: f32 = 52.;
pub const TABLE_VENUE: f32 = 170.;
pub const TABLE_CITED: f32 = 52.;
/// The table's gap between columns, and its rows' inset.
pub const TABLE_GAP: f32 = 12.;

/// What one row draws, gathered by the list.
pub struct RowFacts {
    pub venue: String,
    pub uses: Option<usize>,
    pub fetch: Option<FetchState>,
    /// The open paper's row.
    pub current: bool,
    /// The selected row of a wide panel.
    pub selected: bool,
    /// Added from this window: the row keeps its key out to copy.
    pub recent: bool,
    /// The fluid hover lights this row, or the one before it: either hides
    /// the hairline above it.
    pub lit: bool,
    pub lit_before: bool,
    /// The row before it is lit as current or selected.
    pub held_before: bool,
    /// A row above it in the same list: it draws the hairline over itself.
    pub after_row: bool,
    /// The row's own width.
    pub width: f32,
    pub table: bool,
    pub hits: Option<(Vec<model::LineHit>, bool)>,
}

fn glyph(paper: &PaperSummary, fetch: Option<FetchState>, palette: &Palette) -> AnyElement {
    let icon = match fetch {
        Some(FetchState::Loading) => Icon::LOADER,
        _ if model::is_web_page(paper) => Icon::GLOBE,
        Some(FetchState::Fetched) => Icon::FILE_TEXT,
        None => match model::reading_state(paper) {
            model::ReadingState::FullText => Icon::FILE_TEXT,
            model::ReadingState::Downloadable => Icon::FILE_DOWN,
            model::ReadingState::Citation => Icon::FILE,
        },
    };
    let size = if fetch == Some(FetchState::Loading) {
        ICON_SMALL
    } else {
        ICON
    };
    div()
        .flex_none()
        .w(px(16.))
        .h(px(18.))
        .flex()
        .items_center()
        .justify_center()
        .child(icon.element(size, palette.text_secondary))
        .into_any_element()
}

/// `text` with its matched ranges marked, as the Find dialog marks them.
pub fn marked(text: &str, highlights: &[Range<usize>], palette: &Palette) -> StyledText {
    let mark = HighlightStyle {
        background_color: Some(palette.search_match),
        ..Default::default()
    };
    let mut at = 0;
    let mut ranges: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    for range in highlights {
        if range.start >= at
            && range.start < range.end
            && range.end <= text.len()
            && text.is_char_boundary(range.start)
            && text.is_char_boundary(range.end)
        {
            ranges.push((range.clone(), mark));
            at = range.end;
        }
    }
    StyledText::new(SharedString::from(text.to_string())).with_highlights(ranges)
}

pub fn tooltip(
    text: impl Into<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_, cx| LatticeTooltip::view(text.clone(), None, cx)
}

/// A control inside a row: a press there is the control's, not the row's.
fn inside_row(element: gpui::Stateful<Div>) -> gpui::Stateful<Div> {
    element.on_mouse_down(MouseButton::Left, |_, window, cx| {
        window.prevent_default();
        cx.stop_propagation();
    })
}

/// A row's small action: 24px square on the compact corner, the secondary
/// ink, lit in the accent wash (the danger wash for Remove) on the fast tier.
fn action(
    id: ElementId,
    icon: Icon,
    label: &'static str,
    danger: bool,
    window: &mut Window,
    cx: &mut App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let palette = cx.palette().clone();
    let (interaction, pointer) = use_interaction(id.clone(), window, cx);
    let (wash, ink) = if danger {
        (palette.danger_soft, palette.danger)
    } else {
        (palette.accent_soft, palette.accent)
    };
    inside_row(track_pointer(div().id(id), pointer))
        .flex_none()
        .size(px(24.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .bg(mix(Hsla::transparent_black(), wash, interaction.hover))
        .cursor_pointer()
        .tooltip(tooltip(label))
        .on_click(move |event, window, cx| {
            cx.stop_propagation();
            on_click(event, window, cx);
        })
        .child(icon.element(ICON, mix(palette.text_secondary, ink, interaction.hover)))
        .into_any_element()
}

fn child_id(id: &ElementId, name: &'static str) -> ElementId {
    ElementId::NamedChild(Arc::new(id.clone()), name.into())
}

impl PapersPanel {
    /// The row's key (a button that copies it) and its actions.
    fn row_actions(
        &self,
        paper: &PaperSummary,
        row_id: &ElementId,
        facts: &RowFacts,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let palette = cx.palette().clone();
        let view = cx.entity().downgrade();
        let tiny = facts.width < 200.;
        let mut actions: Vec<AnyElement> = Vec::new();
        if let Some(key_text) = paper.citation_key.clone() {
            let copy_view = view.clone();
            let copied = key_text.clone();
            let id = child_id(row_id, "key");
            let (interaction, pointer) = use_interaction(id.clone(), window, cx);
            let editor_font = cx.lattice().fonts.editor.clone();
            let rest = if facts.current || facts.selected {
                palette.text_secondary
            } else {
                palette.line_number
            };
            let ink = mix(rest, palette.text, interaction.hover);
            actions.push(
                inside_row(track_pointer(div().id(id), pointer))
                    .flex()
                    .min_w_0()
                    .items_center()
                    .gap(px(4.))
                    .h(px(24.))
                    .mr_auto()
                    .when(!tiny, |key| key.px(px(4.)))
                    .when(tiny, |key| key.flex_none().w(px(24.)).justify_center())
                    .rounded(px(4.))
                    .bg(mix(
                        Hsla::transparent_black(),
                        palette.hover,
                        interaction.hover,
                    ))
                    .cursor_pointer()
                    .tooltip(tooltip(t!("Copy citation key")))
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        copy_view
                            .update(cx, |this, cx| this.copy(copied.clone(), cx))
                            .ok();
                    })
                    .when(!tiny, |key| {
                        key.child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(editor_font)
                                .text_size(px(11.))
                                .line_height(px(16.))
                                .text_color(ink)
                                .child(key_text),
                        )
                    })
                    .child(div().flex_none().child(Icon::COPY.element(px(11.), ink)))
                    .into_any_element(),
            );
        }
        if let Some(link) = model::link_url(paper) {
            actions.push(action(
                child_id(row_id, "link"),
                Icon::EXTERNAL_LINK,
                t!("Open link in browser"),
                false,
                window,
                cx,
                move |_, _, cx| model::open_link(&link, cx),
            ));
        }
        let remove_view = view;
        let removed = paper.clone();
        actions.push(action(
            child_id(row_id, "remove"),
            Icon::TRASH,
            t!("Remove from the bibliography"),
            true,
            window,
            cx,
            move |_, _, cx| {
                remove_view
                    .update(cx, |this, cx| this.remove(&removed, cx))
                    .ok();
            },
        ));
        actions
    }

    pub(super) fn render_row(
        &mut self,
        paper: &PaperSummary,
        facts: RowFacts,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let key = model::paper_key(paper);
        let row_id = ElementId::Name(SharedString::from(format!("paper-row:{key}")));
        let (interaction, pointer) = use_interaction(row_id.clone(), window, cx);
        // The key and actions show under the pointer, on the open row and on
        // a row just added; the selected row of a wide panel leaves them to
        // its inspector.
        let reveal =
            interaction.pointer.hovered || (!facts.selected && (facts.current || facts.recent));
        let shown = fade(
            child_id(&row_id, "actions"),
            reveal,
            Motion::Fast,
            window,
            cx,
        );
        let hairline = fade(
            child_id(&row_id, "hairline"),
            facts.after_row
                && !(facts.lit
                    || facts.lit_before
                    || facts.current
                    || facts.selected
                    || facts.held_before),
            Motion::Fast,
            window,
            cx,
        );
        let authors = model::short_authors(paper);
        let year = paper
            .year
            .as_deref()
            .map(str::trim)
            .filter(|year| !year.is_empty())
            .map(str::to_string);
        // A row names its paper by title, authors and year alone; where it
        // came from stands in only when the entry records neither.
        let source = if authors.is_none() && year.is_none() {
            model::source_label(paper)
        } else {
            None
        };
        let narrow = facts.width < 300.;
        let (pad_x, pad_y) = if facts.table { (12., 8.) } else { (8., 10.) };

        let title = div()
            .flex_1()
            .min_w_0()
            .text_role(TextRole::Body, cx)
            .line_height(px(18.))
            .font_weight(FONT_WEIGHT_REGULAR)
            .text_color(palette.text)
            .map(|title| {
                if facts.table {
                    title.truncate()
                } else {
                    title.line_clamp(2)
                }
            })
            .child(paper.title.clone());
        let uses = facts.uses.map(|uses| {
            div()
                .flex_none()
                .h(px(18.))
                .flex()
                .items_center()
                .when(facts.table, |cell| cell.w(px(TABLE_CITED)).justify_end())
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(if uses > 0 {
                    format!("{uses}×")
                } else {
                    "—".to_string()
                })
        });

        let actions = (shown > 0.).then(|| {
            div()
                .flex()
                .min_w_0()
                .items_center()
                .justify_end()
                .opacity(shown)
                .children(self.row_actions(paper, &row_id, &facts, window, cx))
        });

        let mut row = track_pointer(div().id(row_id.clone()), pointer)
            .relative()
            .flex()
            .flex_col()
            .min_w_0()
            .when(facts.after_row, |row| row.mt(px(2.)))
            .px(px(pad_x))
            .py(px(pad_y))
            .rounded(px(6.))
            .when(facts.current || facts.selected, |row| {
                row.bg(palette.row_selected)
            })
            .when(model::can_activate(paper) || self.wide(), |row| {
                row.cursor_pointer()
            })
            // Hairlines part the rows at rest, under the text.
            .child(
                div()
                    .absolute()
                    .top(px(-2.))
                    .left(px(pad_x))
                    .right(px(pad_x))
                    .h(px(1.))
                    .bg(palette.line)
                    .opacity(hairline),
            );
        {
            let view = cx.entity().downgrade();
            let opened = paper.clone();
            let wide = self.wide();
            let select_key = key.clone();
            row = row.on_click(move |event, window, cx| {
                view.update(cx, |this, cx| {
                    // Wide, a click selects and a double click opens;
                    // narrower, a click opens.
                    if wide && event.click_count() == 1 {
                        this.select(Some(select_key.clone()), cx);
                    } else {
                        this.activate(&opened, None, window, cx);
                    }
                })
                .ok();
            });
        }

        let mut first_line = div()
            .flex()
            .items_start()
            .gap(px(6.))
            .min_w_0()
            .child(glyph(paper, facts.fetch, &palette))
            .child(title);
        if facts.table {
            let cell = |text: Option<String>, width: f32| {
                div()
                    .flex_none()
                    .w(px(width))
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::Caption, cx)
                    .line_height(px(18.))
                    .text_color(palette.text_secondary)
                    .children(text)
            };
            first_line = first_line
                .gap(px(TABLE_GAP))
                .child(cell(authors.clone().or(source.clone()), TABLE_AUTHORS))
                .child(cell(year.clone(), TABLE_YEAR))
                .child(cell(Some(facts.venue.clone()), TABLE_VENUE))
                .child(div().flex_none().w(px(TABLE_CITED)).children(uses));
            row = row.child(first_line);
            // The actions surface over the end of the title's line, on a
            // backing as opaque as the row.
            if let Some(actions) = actions {
                let backing = if facts.current || facts.selected {
                    palette.row_selected
                } else {
                    Hsla::transparent_black()
                };
                row = row.child(
                    div()
                        .absolute()
                        .top(px(pad_y - 3.))
                        .right(px(8.))
                        .h(px(24.))
                        .pl(px(16.))
                        .rounded(px(4.))
                        .bg(palette.chrome)
                        .child(div().absolute().inset_0().rounded(px(4.)).bg(backing))
                        .child(actions),
                );
            }
        } else {
            row = row.child(first_line.children(uses));
            let byline: Vec<(String, bool)> = [
                authors.clone().map(|text| (text, false)),
                year.clone().map(|text| (text, true)),
                (!facts.venue.is_empty() && facts.width >= 260.)
                    .then(|| (facts.venue.clone(), false)),
                source.clone().map(|text| (text, false)),
            ]
            .into_iter()
            .flatten()
            .collect();
            // Lit, a narrow row shows its key and actions in the byline's
            // place; a wider one adds them at its end, where the venue and
            // the key give way first. The year never gives way.
            let show_byline = !byline.is_empty() && !(narrow && shown >= 1.);
            let byline = div()
                .flex()
                .min_w_0()
                .overflow_hidden()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .children(byline.into_iter().enumerate().map(|(ix, (text, fixed))| {
                    div()
                        .flex()
                        .min_w_0()
                        .when(fixed || ix == 0, |part| part.flex_none())
                        .when(ix > 0, |part| part.child(div().flex_none().w(px(12.))))
                        .child(div().min_w_0().truncate().child(text))
                }));
            let meta = div()
                .flex()
                .items_center()
                .gap(px(6.))
                .h(px(16.))
                .min_w_0()
                .mt(px(4.))
                .pl(px(22.))
                .when(show_byline, |meta| meta.child(byline))
                .when_some(actions, |meta, actions| {
                    meta.child(actions.flex_1().when(!narrow, |actions| actions.ml_auto()))
                });
            row = row.child(meta);
        }
        if let Some((hits, expanded)) = facts.hits.filter(|(hits, _)| !hits.is_empty()) {
            row = row.child(self.render_hits(&key, paper, hits, expanded, facts.table, window, cx));
        }
        if let Some((kind, detail)) = model::health_parts(paper.citation_health.as_ref()) {
            row = row.child(self.render_health(
                paper,
                &row_id,
                kind,
                detail,
                facts.table,
                window,
                cx,
            ));
        }

        // The right-click menu opens its web page, and a paper with a local
        // file reveals it as a tree file's menu does; a paper with neither
        // stays bare.
        let link = model::link_url(paper);
        let readable = model::readable(paper);
        if !readable && link.is_none() {
            return row.into_any_element();
        }
        let view = cx.entity().downgrade();
        let menu_paper = paper.clone();
        row.context_menu(move |menu, _, _| {
            let mut menu = menu;
            if let Some(link) = link.clone() {
                menu = menu.item(
                    PopupMenuItem::new(t!("Open link in browser"))
                        .icon(Icon::EXTERNAL_LINK.kit())
                        .on_click(move |_, _, cx| model::open_link(&link, cx)),
                );
            }
            if readable {
                let (view, paper) = (view.clone(), menu_paper.clone());
                menu = menu.item(
                    PopupMenuItem::new(lattice_i18n::tr(REVEAL_LABEL))
                        .icon(Icon::FOLDER_OPEN.kit())
                        .on_click(move |_, _, cx| {
                            view.update(cx, |this, cx| this.reveal(&paper, cx)).ok();
                        }),
                );
            }
            menu
        })
        .into_any_element()
    }

    /// The lines of a paper that matched a search, best first: each opens
    /// the paper at that line. Three show at once; the rest the index
    /// returned come on request.
    #[allow(clippy::too_many_arguments)]
    fn render_hits(
        &self,
        key: &str,
        paper: &PaperSummary,
        hits: Vec<model::LineHit>,
        expanded: bool,
        table: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        const SHOWN: usize = 3;
        let palette = cx.palette().clone();
        let reading = cx.lattice().fonts.ui.clone();
        let more = if expanded {
            0
        } else {
            hits.len().saturating_sub(SHOWN)
        };
        let shown = if expanded {
            hits.len()
        } else {
            hits.len().min(SHOWN)
        };
        let view = cx.entity().downgrade();
        let mut list = div()
            .flex()
            .flex_col()
            .min_w_0()
            .mt(px(2.))
            .pl(px(if table { 22. } else { 16. }));
        for (ix, hit) in hits.into_iter().take(shown).enumerate() {
            let id: ElementId = SharedString::from(format!("paper-hit:{key}:{ix}")).into();
            let (interaction, pointer) = use_interaction(id.clone(), window, cx);
            let (view, paper, open) = (view.clone(), paper.clone(), hit.clone());
            list = list.child(
                inside_row(track_pointer(div().id(id), pointer))
                    .min_w_0()
                    .h(px(24.))
                    .flex()
                    .items_center()
                    .px(px(6.))
                    .rounded(px(4.))
                    .bg(mix(
                        Hsla::transparent_black(),
                        palette.text_secondary.opacity(0.08),
                        interaction.hover,
                    ))
                    .cursor_pointer()
                    .on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        view.update(cx, |this, cx| {
                            this.activate(&paper, Some(&open), window, cx)
                        })
                        .ok();
                    })
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .font_family(reading.clone())
                            .italic()
                            .text_role(TextRole::Caption, cx)
                            .text_color(mix(
                                palette.text_secondary,
                                palette.text,
                                interaction.hover,
                            ))
                            .child(marked(&hit.text, &hit.highlights, &palette)),
                    ),
            );
        }
        if more > 0 {
            let id: ElementId = SharedString::from(format!("paper-hits-more:{key}")).into();
            let (interaction, pointer) = use_interaction(id.clone(), window, cx);
            let expand = key.to_string();
            let view = cx.entity().downgrade();
            list = list.child(
                inside_row(track_pointer(div().id(id), pointer))
                    .h(px(24.))
                    .flex()
                    .items_center()
                    .px(px(6.))
                    .rounded(px(4.))
                    .bg(mix(
                        Hsla::transparent_black(),
                        palette.text_secondary.opacity(0.08),
                        interaction.hover,
                    ))
                    .cursor_pointer()
                    .text_role(TextRole::Caption, cx)
                    .text_color(mix(palette.text_secondary, palette.text, interaction.hover))
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        view.update(cx, |this, cx| {
                            this.expanded_hits.insert(expand.clone());
                            cx.notify();
                        })
                        .ok();
                    })
                    .child(t!("{count} more", count = more)),
            );
        }
        list.into_any_element()
    }

    /// A citation-health notice: the chip, then who reported it and when.
    /// One that links out is a control of its own above the row.
    #[allow(clippy::too_many_arguments)]
    fn render_health(
        &self,
        paper: &PaperSummary,
        row_id: &ElementId,
        kind: String,
        detail: String,
        table: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let health = paper.citation_health.as_ref();
        let retracted = health.is_some_and(|health| health.kind == "retracted");
        let (wash, ink) = if retracted {
            (palette.danger_soft, mix(palette.danger, palette.text, 0.2))
        } else {
            (
                palette.warning_soft,
                mix(palette.warning, palette.text, 0.22),
            )
        };
        let link = health
            .and_then(|health| health.link.clone())
            .filter(|link| model::openable_link(link));
        let title = model::health_title(health).unwrap_or_default();
        let id = child_id(row_id, "health");
        let (interaction, pointer) = use_interaction(id.clone(), window, cx);
        let chip = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(2.))
            .h(px(16.))
            .px(px(6.))
            .rounded(px(4.))
            .bg(mix(
                wash,
                mix(wash, palette.text.opacity(0.4), 0.15),
                if link.is_some() {
                    interaction.hover
                } else {
                    0.
                },
            ))
            .text_role(TextRole::Micro, cx)
            .font_weight(lattice_ui::tokens::FONT_WEIGHT_MEDIUM)
            .text_color(ink)
            .child(kind)
            .when(link.is_some(), |chip| {
                chip.child(Icon::ARROW_UP_RIGHT.element(px(11.), ink))
            });
        let notice = track_pointer(div().id(id), pointer)
            .flex()
            .items_center()
            .gap(px(6.))
            .min_w_0()
            .max_w_full()
            .child(chip)
            .when(!detail.is_empty(), |notice| {
                notice.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_role(TextRole::Micro, cx)
                        .text_color(palette.text_secondary)
                        .child(detail),
                )
            })
            .tooltip(move |_, cx| LatticeTooltip::view(title.clone(), None, cx));
        let notice = match link {
            Some(link) => inside_row(notice)
                .cursor_pointer()
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    model::open_link(&link, cx);
                })
                .into_any_element(),
            None => notice.into_any_element(),
        };
        div()
            .flex()
            .min_w_0()
            .mt(px(6.))
            .pl(px(22.))
            .when(table, |tags| tags.pl(px(22.)))
            .child(notice)
            .into_any_element()
    }
}
