//! The table generator (`table-generator-dialog.tsx`, `table-generator.css`):
//! a sheet over the window that inserts a table at the caret, or edits the
//! managed table the caret is in. Data pasted as CSV or TSV replaces the
//! grid; rows, columns and decimal places, booktabs rules and the float
//! with its caption and label are set beside it; each column's alignment
//! heads it and each cell is plain text or LaTeX. Review source changes
//! shows the diff the table makes before Insert table or Update table
//! writes it. A table edited by hand, or the caret in a table Lattice did
//! not write, is left to the source editor.

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState, TextareaState};
use lattice_i18n::{t, tc};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{
        Button, CheckState, Checkbox, Field, LayerPlacement, ModalLayer, Segmented, Sheet,
        Textarea, rise_in,
    },
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_CONTROL},
};

use super::table::{self, Cell, MAX, TableAt, TableData};
use crate::history::diff_view::{FileChange, LoadedDiff, history_diff};

/// What the generator asks of the window: write `insert` over
/// `from..to` of the source it was opened on.
pub enum TableEvent {
    Apply {
        from: usize,
        to: usize,
        insert: String,
    },
    Close,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Delimiter {
    Auto,
    Csv,
    Tsv,
}

pub struct TableGenerator {
    /// The document as it was when the generator opened, and the caret.
    source: String,
    cursor: usize,
    block: Option<TableAt>,
    data: TableData,
    decimals_typed: bool,
    paste: Entity<TextareaState>,
    delimiter: Delimiter,
    rows: Entity<InputState>,
    columns: Entity<InputState>,
    decimals: Entity<InputState>,
    caption: Entity<InputState>,
    label: Entity<InputState>,
    cells: Vec<Vec<Entity<InputState>>>,
    review: Option<LoadedDiff>,
    error: Option<SharedString>,
    _fields: Vec<Subscription>,
    _cells: Vec<Subscription>,
}

impl EventEmitter<TableEvent> for TableGenerator {}

impl TableGenerator {
    pub fn new(source: String, cursor: usize, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let block = table::table_at(&source, cursor);
        let data = block
            .as_ref()
            .and_then(|block| block.data.clone())
            .unwrap_or_else(table::new_table);
        let field =
            |value: String, placeholder: String, window: &mut Window, cx: &mut Context<Self>| {
                cx.new(|cx| {
                    InputState::new(window, cx)
                        .default_value(value)
                        .placeholder(placeholder)
                })
            };
        let rows = field(data.cells.len().to_string(), String::new(), window, cx);
        let columns = field(data.align.len().to_string(), String::new(), window, cx);
        let decimals = field(
            data.decimals.map(|d| d.to_string()).unwrap_or_default(),
            tc!("decimal places left blank", "Keep").into(),
            window,
            cx,
        );
        let caption = field(data.caption.clone(), String::new(), window, cx);
        let label = field(data.label.clone(), String::new(), window, cx);
        let paste =
            cx.new(|cx| TextareaState::new(window, cx).placeholder(t!("Paste cells or CSV")));
        let mut fields = vec![cx.subscribe(&paste, |_, _, _: &InputEvent, cx| cx.notify())];
        let on_change = |field: &Entity<InputState>,
                         apply: fn(&mut Self, String, &mut Window, &mut Context<Self>),
                         window: &mut Window,
                         cx: &mut Context<Self>| {
            cx.subscribe_in(field, window, move |this, field, event, window, cx| {
                if let InputEvent::Change = event {
                    let value = field.read(cx).value().to_string();
                    apply(this, value, window, cx);
                    this.changed(cx);
                }
            })
        };
        fields.push(on_change(
            &rows,
            |this, value, window, cx| {
                if let Ok(rows) = value.trim().parse::<usize>() {
                    let columns = this.data.align.len();
                    this.resize(rows, columns, window, cx);
                }
            },
            window,
            cx,
        ));
        fields.push(on_change(
            &columns,
            |this, value, window, cx| {
                if let Ok(columns) = value.trim().parse::<usize>() {
                    let rows = this.data.cells.len();
                    this.resize(rows, columns, window, cx);
                }
            },
            window,
            cx,
        ));
        fields.push(on_change(
            &decimals,
            |this, value, _, _| {
                let value = value.trim();
                // `Number("")` keeps the numbers as typed; anything not a whole
                // number is the invalid message's to name.
                this.decimals_typed = !value.is_empty() && value.parse::<u8>().is_err();
                this.data.decimals = value.parse::<u8>().ok();
            },
            window,
            cx,
        ));
        fields.push(on_change(
            &caption,
            |this, value, _, _| this.data.caption = value,
            window,
            cx,
        ));
        fields.push(on_change(
            &label,
            |this, value, _, _| this.data.label = value,
            window,
            cx,
        ));
        let mut this = Self {
            source,
            cursor,
            block,
            data,
            decimals_typed: false,
            paste,
            delimiter: Delimiter::Auto,
            rows,
            columns,
            decimals,
            caption,
            label,
            cells: Vec::new(),
            review: None,
            error: None,
            _fields: fields,
            _cells: Vec::new(),
        };
        this.rebuild_cells(window, cx);
        this
    }

    /// Whether the generator can write this table: a new one, or a managed
    /// table whose source still matches its grid.
    pub fn supported(&self) -> bool {
        self.block.as_ref().is_none_or(|block| block.data.is_some())
    }

    pub fn data(&self) -> &TableData {
        &self.data
    }

    /// What the generator says went wrong, if anything.
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn reviewing(&self) -> bool {
        self.review.is_some()
    }

    fn valid(&self) -> bool {
        !self.decimals_typed && table::is_valid(&self.data)
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        self.review = None;
        self.error = None;
        cx.notify();
    }

    /// A field per cell, holding its text; typing in one is its cell's.
    fn rebuild_cells(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cells.clear();
        self._cells.clear();
        for (r, row) in self.data.cells.clone().into_iter().enumerate() {
            let mut fields = Vec::new();
            for (c, cell) in row.into_iter().enumerate() {
                let field = cx.new(|cx| InputState::new(window, cx).default_value(cell.text));
                self._cells
                    .push(cx.subscribe(&field, move |this, field, event, cx| {
                        if let InputEvent::Change = event
                            && let Some(cell) =
                                this.data.cells.get_mut(r).and_then(|row| row.get_mut(c))
                        {
                            cell.text = field.read(cx).value().to_string();
                            this.changed(cx);
                        }
                    }));
                fields.push(field);
            }
            self.cells.push(fields);
        }
    }

    /// The grid at `rows` by `columns`, keeping what fits (`resize`).
    pub fn resize(
        &mut self,
        rows: usize,
        columns: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !(1..=MAX).contains(&rows) || !(1..=MAX).contains(&columns) {
            return;
        }
        let empty = Cell {
            text: String::new(),
            latex: false,
        };
        self.data.cells = (0..rows)
            .map(|r| {
                (0..columns)
                    .map(|c| {
                        self.data
                            .cells
                            .get(r)
                            .and_then(|row| row.get(c))
                            .cloned()
                            .unwrap_or_else(|| empty.clone())
                    })
                    .collect()
            })
            .collect();
        self.data.align = (0..columns)
            .map(|c| self.data.align.get(c).copied().unwrap_or('l'))
            .collect();
        self.rebuild_cells(window, cx);
    }

    /// Replace grid from data: the pasted CSV or TSV, tab-separated when
    /// it holds a tab and nothing was chosen.
    pub fn import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.paste.read(cx).value().to_string();
        let tab = match self.delimiter {
            Delimiter::Tsv => true,
            Delimiter::Csv => false,
            Delimiter::Auto => text.contains('\t'),
        };
        let Some(matrix) = table::parse_data(&text, if tab { '\t' } else { ',' }) else {
            self.error =
                Some(t!("Use valid CSV or TSV with at most 20 rows and 20 columns.").into());
            cx.notify();
            return;
        };
        let columns = matrix.first().map_or(0, Vec::len);
        self.data.align = (0..columns)
            .map(|c| self.data.align.get(c).copied().unwrap_or('l'))
            .collect();
        self.data.cells = matrix
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|text| Cell { text, latex: false })
                    .collect()
            })
            .collect();
        let (rows, columns) = (self.data.cells.len(), self.data.align.len());
        self.rows.update(cx, |field, cx| {
            field.set_value(rows.to_string(), window, cx)
        });
        self.columns.update(cx, |field, cx| {
            field.set_value(columns.to_string(), window, cx)
        });
        self.rebuild_cells(window, cx);
        self.changed(cx);
    }

    /// Review source changes: the table's source before (the managed
    /// table's, or none) and after.
    pub fn open_review(&mut self, cx: &mut Context<Self>) {
        if !self.valid() {
            return;
        }
        let before = self
            .block
            .as_ref()
            .and_then(|block| block.data.as_ref())
            .map(table::source);
        let change = FileChange {
            path: "table.tex".into(),
            before,
            after: Some(table::source(&self.data)),
        };
        self.review = Some(LoadedDiff::new(change, cx));
        cx.notify();
    }

    /// What writing the table puts where: over the managed table, else at
    /// the caret on a line of its own.
    pub fn edit(&self) -> (usize, usize, String) {
        let from = self.block.as_ref().map_or(self.cursor, |block| block.from);
        let to = self.block.as_ref().map_or(self.cursor, |block| block.to);
        let fresh_line = self.block.is_none()
            && from > 0
            && self.source.as_bytes().get(from - 1) != Some(&b'\n');
        let insert = format!(
            "{}{}",
            if fresh_line { "\n" } else { "" },
            table::managed_source(&self.data)
        );
        (from, to, insert)
    }

    pub fn apply(&mut self, cx: &mut Context<Self>) {
        if !self.supported() || !self.valid() {
            return;
        }
        let (from, to, insert) = self.edit();
        cx.emit(TableEvent::Apply { from, to, insert });
    }

    /// The window could not write it: the document changed under it.
    pub fn failed(&mut self, cx: &mut Context<Self>) {
        self.error =
            Some(t!("The document changed. Close and reopen the table before applying.").into());
        cx.notify();
    }

    fn set_cell_latex(&mut self, r: usize, c: usize, latex: bool, cx: &mut Context<Self>) {
        if let Some(cell) = self.data.cells.get_mut(r).and_then(|row| row.get_mut(c)) {
            cell.latex = latex;
        }
        self.changed(cx);
    }
}

fn checked(on: bool) -> CheckState {
    if on { CheckState::On } else { CheckState::Off }
}

/// A labelled field (`.table-generator-form > label`).
fn labelled(name: SharedString, control: AnyElement, cx: &App) -> AnyElement {
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(6.))
        .text_role(TextRole::Caption, cx)
        .font_weight(FONT_WEIGHT_MEDIUM)
        .text_color(cx.palette().text)
        .child(name)
        .child(control)
        .into_any_element()
}

impl TableGenerator {
    fn render_form(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let palette = cx.palette().clone();
        let caption = |text: SharedString, cx: &App| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(text)
                .into_any_element()
        };
        let mut delimiter = Segmented::new("table-delimiter").filled();
        for (value, label) in [
            (Delimiter::Auto, t!("Auto-detect")),
            (Delimiter::Csv, t!("CSV (comma)")),
            (Delimiter::Tsv, t!("TSV (tab)")),
        ] {
            delimiter = delimiter.label(
                label,
                self.delimiter == value,
                cx.listener(move |this, _, _, cx| {
                    this.delimiter = value;
                    cx.notify();
                }),
            );
        }
        let pasted = !self.paste.read(cx).value().is_empty();
        let two = |a: AnyElement, b: AnyElement| {
            div()
                .flex()
                .flex_wrap()
                .gap(px(12.))
                .child(div().flex_1().min_w(px(160.)).child(a))
                .child(div().flex_1().min_w(px(160.)).child(b))
                .into_any_element()
        };
        let data = &self.data;
        let mut out = vec![
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(caption(t!("Paste data").into(), cx))
                .child(Textarea::new(&self.paste))
                .into_any_element(),
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .child(delimiter)
                .child(
                    Button::new("table-import", t!("Replace grid from data"))
                        .disabled(!pasted)
                        .on_click(cx.listener(|this, _, window, cx| this.import(window, cx))),
                )
                .into_any_element(),
            two(
                labelled(
                    t!("Rows").into(),
                    Field::new(&self.rows).into_any_element(),
                    cx,
                ),
                labelled(
                    t!("Columns").into(),
                    Field::new(&self.columns).into_any_element(),
                    cx,
                ),
            ),
            two(
                labelled(
                    t!("Decimal places").into(),
                    Field::new(&self.decimals).into_any_element(),
                    cx,
                ),
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        Checkbox::new("table-booktabs", checked(data.booktabs))
                            .label(t!("Booktabs rules"))
                            .on_toggle(cx.listener(|this, on: &bool, _, cx| {
                                this.data.booktabs = *on;
                                this.changed(cx);
                            })),
                    )
                    .child(
                        Checkbox::new("table-float", checked(data.float))
                            .label(t!("Wrap in table float"))
                            .on_toggle(cx.listener(|this, on: &bool, _, cx| {
                                this.data.float = *on;
                                this.changed(cx);
                            })),
                    )
                    .into_any_element(),
            ),
        ];
        if data.float {
            out.push(two(
                labelled(
                    t!("Caption").into(),
                    Field::new(&self.caption).into_any_element(),
                    cx,
                ),
                labelled(
                    t!("Label").into(),
                    Field::new(&self.label).into_any_element(),
                    cx,
                ),
            ));
        }
        // Lattice does not add the package, so a build would fail without it.
        if data.booktabs {
            out.push(caption(
                t!("Booktabs rules need the booktabs package").into(),
                cx,
            ));
        }
        out.push(self.render_grid(window, cx));
        out
    }

    /// The grid (`.table-data-grid`): each column's alignment over its
    /// cells, a cell's text over its LaTeX switch, scrolling both ways
    /// within 320px.
    fn render_grid(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let cell_box = || {
            div()
                .flex_none()
                .w(px(160.))
                .p(px(6.))
                .border_r_1()
                .border_b_1()
                .border_color(palette.line)
        };
        let mut head = div().flex();
        for (c, align) in self.data.align.clone().into_iter().enumerate() {
            let mut segmented = Segmented::new(SharedString::from(format!("table-align-{c}")));
            for (value, label) in [('l', t!("Left")), ('c', t!("Center")), ('r', t!("Right"))] {
                segmented = segmented.label(
                    label,
                    align == value,
                    cx.listener(move |this, _, _, cx| {
                        if let Some(slot) = this.data.align.get_mut(c) {
                            *slot = value;
                        }
                        this.changed(cx);
                    }),
                );
            }
            head = head.child(cell_box().child(segmented));
        }
        let mut rows = div().flex().flex_col().child(head);
        for (r, fields) in self.cells.iter().enumerate() {
            let mut row = div().flex();
            for (c, field) in fields.iter().enumerate() {
                let latex = self
                    .data
                    .cells
                    .get(r)
                    .and_then(|row| row.get(c))
                    .is_some_and(|cell| cell.latex);
                row = row.child(
                    cell_box()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(Field::new(field).compact())
                        .child(
                            Checkbox::new(
                                SharedString::from(format!("table-latex-{r}-{c}")),
                                checked(latex),
                            )
                            .label(t!("LaTeX"))
                            .on_toggle(cx.listener(
                                move |this, on: &bool, _, cx| this.set_cell_latex(r, c, *on, cx),
                            )),
                        ),
                );
            }
            rows = rows.child(row);
        }
        div()
            .id("table-data-grid")
            .flex_none()
            .max_h(px(320.))
            .min_w_0()
            .overflow_scroll()
            .rounded(RADIUS_CONTROL)
            .border_1()
            .border_color(palette.line)
            .child(rows)
            .into_any_element()
    }
}

impl Render for TableGenerator {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let supported = self.supported();
        let valid = self.valid();
        let editing = self.block.is_some();
        let reviewing = self.review.is_some();
        let title = if reviewing {
            t!("Review source changes")
        } else if editing {
            t!("Edit table")
        } else {
            t!("Insert table")
        };
        // The role's measures read once, so the closure holds no `cx`.
        let size = TextRole::BodyCompact.font_size(lattice_ui::TypeScale::Interface, cx);
        let leading = TextRole::BodyCompact.leading(lattice_ui::TypeScale::Interface);
        let alert = move |text: SharedString| {
            div()
                .text_size(size)
                .line_height(leading)
                .text_color(palette.danger)
                .child(text)
        };
        let this = cx.entity().downgrade();
        let mut sheet = Sheet::new("table-generator", title).on_close({
            let this = this.clone();
            move |_, cx| {
                this.update(cx, |_, cx| cx.emit(TableEvent::Close)).ok();
            }
        });
        if !supported {
            sheet = sheet.child(alert(
                t!("This table has source edits or unsupported structure. Continue editing it in the source editor.").into(),
            ));
        } else {
            if !reviewing {
                sheet = sheet.children(self.render_form(window, cx));
            }
            if !valid {
                sheet = sheet.child(alert(
                    t!("Check decimal places (0–8), label (letters, digits, colon, dot, dash or underscore), and LaTeX cells (no table structure, line breaks, & or %).").into(),
                ));
            }
            if valid && let Some(review) = &self.review {
                sheet = sheet.child(history_diff(
                    "table-generator-diff",
                    review,
                    false,
                    None,
                    None,
                    window,
                    cx,
                ));
            }
        }
        sheet = sheet.children(self.error.clone().map(alert));
        sheet = sheet.action(
            Button::new("table-cancel", t!("Cancel"))
                .ghost()
                .on_click(cx.listener(|_, _, _, cx| cx.emit(TableEvent::Close))),
        );
        if reviewing {
            sheet = sheet.action(Button::new("table-back", t!("Back")).on_click(cx.listener(
                |this, _, _, cx| {
                    this.review = None;
                    cx.notify();
                },
            )));
        }
        if supported {
            sheet = sheet.action(if reviewing {
                Button::new(
                    "table-apply",
                    if editing {
                        t!("Update table")
                    } else {
                        t!("Insert table")
                    },
                )
                .primary()
                .disabled(!valid)
                .on_click(cx.listener(|this, _, _, cx| this.apply(cx)))
            } else {
                Button::new("table-review", t!("Review source changes"))
                    .primary()
                    .disabled(!valid)
                    .on_click(cx.listener(|this, _, _, cx| this.open_review(cx)))
            });
        }
        ModalLayer::new(
            "table-generator",
            LayerPlacement::Center,
            rise_in("table-generator-rise", sheet),
            move |_, cx| {
                this.update(cx, |_, cx| cx.emit(TableEvent::Close)).ok();
            },
        )
        .when(supported, |layer| {
            layer.initial_focus(gpui::Focusable::focus_handle(self.paste.read(cx), cx))
        })
    }
}
