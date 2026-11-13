//! A Project tree row, drawn as the content of GPUI Kit's tree item.
//!
//! Measured on the Main window: rows 28px tall with control corners (6px);
//! a file's 14px glyph 8px in, 6px to its 13px label in secondary ink; a
//! folder's 12px filled chevron 9.5px in, 6.5px to its glyph, so a file's
//! glyph at the top level stands in the chevron's column. The open file's
//! row is the selected-row wash with its label a step under the primary ink
//! at medium weight.
//!
//! The name is two runs of text, as the app's tree (Pierre's
//! `MiddleTruncate`) draws it: the head truncates with an ellipsis and the
//! tail stays whole, so a long name keeps its extension in view
//! ([`split_name`]). A row being renamed shows its field in the name's place.
//!
//! A file Git sees changed takes its status's colour on its name, with the
//! status's letter in a 12px lane at the row's end (Pierre's tree: A, D, M,
//! R, U, semibold); an ignored one dims its glyph and takes the quiet
//! grey; a folder holding changes shows a 6px dot in the modified colour at
//! half strength in the same lane.

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, SharedString, Styled as _,
    Transformation, div, prelude::FluentBuilder as _, px, radians, svg,
};
use gpui_kit::component::list::ListItem;

use crate::{
    ActiveLattice as _, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    icons::{ICON, ICON_SMALL, file_glyph},
    parity,
    tokens::FONT_WEIGHT_MEDIUM,
};

/// How far each level of nesting moves a row in.
const INDENT: f32 = 14.;

/// What Git says of a row's file (Pierre's `GitStatusEntry`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GitMark {
    Added,
    Deleted,
    Ignored,
    Modified,
    Renamed,
    Untracked,
}

impl GitMark {
    /// lattice-core's status word, as the Tauri app maps it for the tree
    /// (`toPierreGitStatus`): a copy reads as added, anything else unknown
    /// as modified.
    pub fn from_status(status: &str) -> GitMark {
        match status {
            "added" | "copied" => GitMark::Added,
            "deleted" => GitMark::Deleted,
            "ignored" => GitMark::Ignored,
            "renamed" => GitMark::Renamed,
            "untracked" => GitMark::Untracked,
            _ => GitMark::Modified,
        }
    }

    fn letter(self) -> Option<&'static str> {
        match self {
            GitMark::Added => Some("A"),
            GitMark::Deleted => Some("D"),
            GitMark::Ignored => None,
            GitMark::Modified => Some("M"),
            GitMark::Renamed => Some("R"),
            GitMark::Untracked => Some("U"),
        }
    }

    /// Pierre's own colours, which the app keeps.
    fn color(self, dark: bool) -> gpui::Hsla {
        let hex = match (self, dark) {
            (GitMark::Added | GitMark::Untracked, false) => 0x16a994,
            (GitMark::Added | GitMark::Untracked, true) => 0x00cab1,
            (GitMark::Deleted, false) => 0xff2e3f,
            (GitMark::Deleted, true) => 0xff6762,
            (GitMark::Ignored, false) => 0xadadb1,
            (GitMark::Ignored, true) => 0x4a4a4e,
            (GitMark::Modified, false) => 0x1ca1c7,
            (GitMark::Modified, true) => 0x08c0ef,
            (GitMark::Renamed, false) => 0xd5a910,
            (GitMark::Renamed, true) => 0xffd452,
        };
        gpui::rgb(hex).into()
    }
}

pub struct TreeRow {
    id: ElementId,
    name: SharedString,
    depth: usize,
    /// `Some(expanded)` for a folder.
    folder: Option<bool>,
    selected: bool,
    parity: Option<SharedString>,
    /// The rename field, drawn in the name's place.
    editing: Option<AnyElement>,
    git: Option<GitMark>,
    /// A folder with a changed file somewhere under it.
    contains_change: bool,
    /// The list's fluid hover probe (`FluidHover::probe`): the row records
    /// its bounds for the tree's one gliding fill and draws none of its own.
    fluid: Option<AnyElement>,
}

impl TreeRow {
    pub fn file(id: impl Into<ElementId>, name: impl Into<SharedString>, depth: usize) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            depth,
            folder: None,
            selected: false,
            parity: None,
            editing: None,
            git: None,
            contains_change: false,
            fluid: None,
        }
    }

    pub fn folder(
        id: impl Into<ElementId>,
        name: impl Into<SharedString>,
        depth: usize,
        expanded: bool,
    ) -> Self {
        Self {
            folder: Some(expanded),
            ..Self::file(id, name, depth)
        }
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// What Git says of this row's file.
    pub fn git(mut self, mark: Option<GitMark>) -> Self {
        self.git = mark;
        self
    }

    /// A folder with a changed file under it.
    pub fn contains_change(mut self, contains: bool) -> Self {
        self.contains_change = contains;
        self
    }

    /// Leave the hover fill to the tree's fluid hover, recording the row
    /// through `probe` (`FluidHover::probe`).
    pub fn fluid(mut self, probe: AnyElement) -> Self {
        self.fluid = Some(probe);
        self
    }

    /// Draw `field` (a rename's text field) in the name's place.
    pub fn editing(mut self, field: impl IntoElement) -> Self {
        self.editing = Some(field.into_any_element());
        self
    }

    /// Name this row as a parity-harness region (`crate::parity`): its
    /// bounds and its label's text style are recorded under `name`.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    /// The Kit list item the tree draws, with this row as its content.
    pub fn into_list_item(self, cx: &App) -> ListItem {
        let palette = cx.palette().clone();
        let indent = px(self.depth as f32 * INDENT);
        let dark = palette.appearance == crate::Appearance::Dark;
        let git_ink = self.git.map(|mark| mark.color(dark));
        let label_ink = match git_ink {
            Some(ink) => ink,
            None if self.selected => palette.nav_text_strong,
            None => palette.text_secondary,
        };
        let lane = match (self.git, self.contains_change) {
            (Some(mark), _) => mark.letter().map(|letter| {
                div()
                    .w(px(12.))
                    .flex_none()
                    .flex()
                    .justify_center()
                    .text_role(TextRole::Caption, cx)
                    .font_weight(crate::tokens::FONT_WEIGHT_SEMIBOLD)
                    .text_color(mark.color(dark))
                    .child(letter)
                    .into_any_element()
            }),
            (None, true) => Some(
                div()
                    .w(px(12.))
                    .flex_none()
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .size(px(6.))
                            .rounded(px(3.))
                            .bg(GitMark::Modified.color(dark))
                            .opacity(0.5),
                    )
                    .into_any_element(),
            ),
            (None, false) => None,
        };
        let dim_glyph = self.git == Some(GitMark::Ignored);
        let lead = match self.folder {
            Some(expanded) => div()
                .flex()
                .items_center()
                .pl(px(9.5) + indent)
                .child(
                    svg()
                        .path(Icon::DISCLOSURE.path())
                        .size(ICON_SMALL)
                        .flex_none()
                        .text_color(palette.text_secondary)
                        .when(!expanded, |chevron| {
                            chevron.with_transformation(Transformation::rotate(radians(
                                -std::f32::consts::FRAC_PI_2,
                            )))
                        }),
                )
                .child(
                    div()
                        .ml(px(6.5))
                        .child(file_glyph(GlyphKind::Folder, ICON, &palette)),
                ),
            None => div()
                .pl(px(8.) + indent)
                .when(dim_glyph, |lead| lead.opacity(0.5))
                .child(file_glyph(GlyphKind::for_name(&self.name), ICON, &palette)),
        };
        // Kit's tree marks its own keyboard selection on the item after this
        // returns, so the open file's wash is set as the item's background.
        ListItem::new(self.id)
            .h(px(28.))
            .py_0()
            .px_0()
            .rounded(px(6.))
            .when(self.selected, |item| item.bg(palette.row_selected))
            // Kit's item fills itself under the pointer unless it counts as
            // active; with the tree's fluid hover drawing the fill, it is
            // marked so (it draws no check: none is set).
            .when(self.fluid.is_some(), |item| item.confirmed(true))
            .children(self.fluid)
            .children(self.parity.clone().and_then(parity::probe))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(28.))
                    .pr(px(8.))
                    .child(lead)
                    .child(match self.editing {
                        Some(field) => div().flex_1().min_w_0().child(field),
                        None => label(self.name, self.parity, cx)
                            .text_color(label_ink)
                            .when(self.selected, |label| label.font_weight(FONT_WEIGHT_MEDIUM)),
                    })
                    .children(lane),
            )
    }
}

/// The name's two runs: the head ellipsizes, the tail stays whole. A
/// folder row that stands for a chain of folders each holding only the next
/// (`slides/understanding-attention`, as the app's tree flattens them) shows
/// each name with a "/" between, 2px either side; only the last name gives
/// way to a narrow panel. A real name never holds a "/", so one in `name`
/// always marks such a chain.
fn label(name: SharedString, parity: Option<SharedString>, cx: &App) -> gpui::Div {
    if name.contains('/') {
        let segments: Vec<&str> = name.split('/').collect();
        let last = segments.len() - 1;
        let mut chain = div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(2.))
            .overflow_hidden()
            .whitespace_nowrap()
            .text_role(TextRole::Body, cx)
            .line_height(px(28.));
        for (ix, segment) in segments.into_iter().enumerate() {
            if ix > 0 {
                chain = chain.child(div().flex_none().child("/"));
            }
            let name = SharedString::from(segment.to_string());
            chain = chain.child(if ix == last {
                one_name(name, None, cx)
            } else {
                one_name(name, None, cx).flex_none()
            });
        }
        return chain;
    }
    one_name(name, parity, cx)
}

fn one_name(name: SharedString, parity: Option<SharedString>, cx: &App) -> gpui::Div {
    let (head, tail) = split_name(&name);
    let run = |slot: usize, text: String| {
        let text = SharedString::from(text);
        div()
            .children(
                parity
                    .clone()
                    .and_then(|name| parity::text_probe(name, slot, text.clone())),
            )
            .child(text)
    };
    let mut label = div()
        .flex()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_role(TextRole::Body, cx)
        .line_height(px(28.))
        .child(run(0, head).min_w_0().overflow_hidden().text_ellipsis());
    if !tail.is_empty() {
        label = label.child(run(1, tail).flex_none());
    }
    label
}

/// Where the app's tree splits a name into its two runs (Pierre's
/// `MiddleTruncate` with `split: "extension"` and `minimumLength: 5`): a
/// name under five characters stays whole; otherwise the tail is its
/// extension, dot and all ("main" · ".tex"), unless it has none or one over
/// ten characters, when the name splits at its middle, off any whitespace
/// ("figu" · "res"). A dotfile keeps its leading dot in the head.
pub fn split_name(name: &str) -> (String, String) {
    let chars: Vec<char> = name.chars().collect();
    let length = chars.len();
    if length < 5 {
        return (name.to_string(), String::new());
    }
    let extension = chars
        .iter()
        .rposition(|&c| c == '.')
        .map_or(0, |dot| dot + 1);
    let too_long = length - extension > 10;
    let split = if extension >= 1 && !too_long {
        extension
    } else {
        center_split(&chars)
    };
    let keep_dot = usize::from(split == extension && extension > 1);
    let at = split - keep_dot;
    (chars[..at].iter().collect(), chars[at..].iter().collect())
}

/// The middle of `chars`, moved off a whitespace boundary.
fn center_split(chars: &[char]) -> usize {
    let whitespace = |ix: usize| chars.get(ix).is_some_and(|c| c.is_whitespace());
    let on_boundary = |ix: usize| (ix > 0 && whitespace(ix - 1)) || whitespace(ix);
    let center = chars.len().div_ceil(2);
    if !on_boundary(center) {
        return center;
    }
    for offset in 1..chars.len() {
        if center > offset && !on_boundary(center - offset) {
            return center - offset;
        }
        let after = center + offset;
        if after < chars.len() && !on_boundary(after) {
            return after;
        }
    }
    center
}

#[cfg(test)]
mod tests {
    use super::split_name;

    fn split(name: &str) -> (String, String) {
        split_name(name)
    }

    fn runs(head: &str, tail: &str) -> (String, String) {
        (head.to_string(), tail.to_string())
    }

    #[test]
    fn names_split_as_the_apps_tree_splits_them() {
        // As the parity report read the Main window's rows.
        assert_eq!(split("main.tex"), runs("main", ".tex"));
        assert_eq!(split("references.bib"), runs("references", ".bib"));
        assert_eq!(
            split("attention-demo.html"),
            runs("attention-demo", ".html")
        );
        assert_eq!(split("figures"), runs("figu", "res"));
        // Under five characters a name is one run.
        assert_eq!(split("a.md"), runs("a.md", ""));
        assert_eq!(split("res"), runs("res", ""));
        // A dotfile keeps its dot in the head; an extension over ten
        // characters is not an extension.
        assert_eq!(split(".latexmkrc"), runs(".", "latexmkrc"));
        assert_eq!(
            split("table.verylongextension"),
            runs("table.verylo", "ngextension")
        );
        // The middle moves off whitespace.
        assert_eq!(split("my notes"), runs("my n", "otes"));
        assert_eq!(split("abc defg"), runs("abc d", "efg"));
    }
}
