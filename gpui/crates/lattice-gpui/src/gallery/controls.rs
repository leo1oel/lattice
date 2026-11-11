//! Page 1: the controls. Paper's Buttons and Fields and selection boards.

use gpui::{AnyElement, Context, IntoElement, ParentElement as _, SharedString, Styled as _, div, px};
use lattice_ui::{
    Icon,
    components::{
        Badge, BadgeTone, Button, CheckState, Checkbox, Field, IconButton, Keycap, SearchField,
        Segmented, Select, Slider, Switch, Textarea,
    },
};

use super::{Gallery, board, labelled, noop};

const CITATION_STYLES: [&str; 4] = [
    "Natbib (author–year)",
    "Natbib (numeric)",
    "BibLaTeX",
    "Plain BibTeX",
];

pub(super) fn boards(gallery: &mut Gallery, cx: &mut Context<Gallery>) -> Vec<AnyElement> {
    vec![
        board(
            "Buttons",
            "primary, tinted, secondary, ghost, danger; disabled; compact; icon buttons",
            buttons(),
            cx,
        ),
        board(
            "Text fields",
            "a field answers with its border, never a ring; the textarea is 88 at least",
            fields(gallery, cx),
            cx,
        ),
        board(
            "Select",
            "the trigger is a field; the list is a menu surface on the popover level, the \
             highlight the accent wash, the chosen value checked",
            selects(gallery, cx),
            cx,
        ),
        board(
            "Checkbox, switch and slider",
            "14px box, 4px corner; 28 × 16 track, moderate tier; a 4px track and 14px thumb",
            toggles(gallery, cx),
            cx,
        ),
        board(
            "Small controls",
            "segmented, badges, keycaps",
            small(cx),
            cx,
        ),
    ]
}

fn buttons() -> Vec<AnyElement> {
    vec![
        Button::new("primary", "Save")
            .primary()
            .on_click(noop)
            .into_any_element(),
        Button::new("tinted", "Undo")
            .tinted()
            .on_click(noop)
            .into_any_element(),
        Button::new("secondary", "Review")
            .on_click(noop)
            .into_any_element(),
        Button::new("ghost", "Cancel")
            .ghost()
            .on_click(noop)
            .into_any_element(),
        Button::new("danger", "Delete")
            .danger()
            .on_click(noop)
            .into_any_element(),
        Button::new("disabled", "Save")
            .primary()
            .disabled(true)
            .into_any_element(),
        Button::new("compact", "Add papers")
            .icon(Icon::PLUS)
            .compact()
            .on_click(noop)
            .into_any_element(),
        Button::new("compact-tinted", "Accept")
            .tinted()
            .compact()
            .on_click(noop)
            .into_any_element(),
        IconButton::new("icon-row", Icon::CLOSE)
            .frame(px(24.), px(24.))
            .tooltip("Close")
            .into_any_element(),
        IconButton::new("icon-compact", Icon::DOTS)
            .tooltip("More")
            .into_any_element(),
        IconButton::new("icon-on", Icon::RECTANGLE_HORIZONTAL)
            .on(true)
            .into_any_element(),
        IconButton::new("icon-disabled", Icon::PLUS)
            .disabled(true)
            .into_any_element(),
    ]
}

fn fields(gallery: &Gallery, cx: &Context<Gallery>) -> Vec<AnyElement> {
    let [rest, filled, invalid, search, disabled] = gallery.fields.clone();
    let w = |child: AnyElement| div().w(px(220.)).child(child);
    vec![
        labelled("rest, placeholder", w(Field::new(&rest).into_any_element()), cx),
        labelled("with text", w(Field::new(&filled).into_any_element()), cx),
        labelled(
            "invalid",
            w(Field::new(&invalid).invalid(true).into_any_element()),
            cx,
        ),
        labelled("search", w(Field::new(&search).search().into_any_element()), cx),
        labelled(
            "disabled",
            w(Field::new(&disabled).disabled(true).into_any_element()),
            cx,
        ),
        labelled(
            "search field",
            SearchField::new("find", "Find in project").width(px(220.)),
            cx,
        ),
        labelled(
            "textarea, 88 min",
            w(Textarea::new(&gallery.note).into_any_element()),
            cx,
        ),
    ]
}

fn selects(gallery: &Gallery, cx: &mut Context<Gallery>) -> Vec<AnyElement> {
    let select = |slot: usize, id: &'static str, cx: &mut Context<Gallery>| {
        Select::new(id, CITATION_STYLES, gallery.choices[slot]).on_change(cx.listener(
            move |this, ix: &usize, _, cx| {
                this.choices[slot] = Some(*ix);
                cx.notify();
            },
        ))
    };
    let rest = select(0, "select-rest", cx);
    let compact = Select::new(
        "select-compact",
        ["Title", "Year", "First author", "Date added"],
        gallery.choices[1],
    )
    .compact()
    .on_change(cx.listener(|this, ix: &usize, _, cx| {
        this.choices[1] = Some(*ix);
        cx.notify();
    }));
    let open = select(2, "select-open", cx).default_open(true);
    let disabled = select(3, "select-disabled", cx).disabled(true);
    vec![
        labelled("select, rest", div().w(px(220.)).child(rest), cx),
        labelled("select, compact", div().w(px(140.)).child(compact), cx),
        labelled("select, disabled", div().w(px(220.)).child(disabled), cx),
        // The open list floats below its trigger; the column keeps its room.
        labelled(
            "select, open",
            div().w(px(220.)).h(px(184.)).child(open),
            cx,
        ),
    ]
}

fn toggles(gallery: &Gallery, cx: &Context<Gallery>) -> Vec<AnyElement> {
    let [plain, sized, disabled] = gallery.sliders.clone();
    vec![
        labelled(
            "off",
            Checkbox::new("cb-off", CheckState::Off).on_toggle(|_, _, _| {}),
            cx,
        ),
        labelled(
            "on",
            Checkbox::new("cb-on", CheckState::On).on_toggle(|_, _, _| {}),
            cx,
        ),
        labelled("mixed", Checkbox::new("cb-mixed", CheckState::Mixed), cx),
        labelled(
            "disabled",
            Checkbox::new("cb-disabled", CheckState::On).disabled(true),
            cx,
        ),
        labelled(
            "switch off",
            Switch::new("sw-off", false).on_toggle(|_, _, _| {}),
            cx,
        ),
        labelled(
            "switch on",
            Switch::new("sw-on", true).on_toggle(|_, _, _| {}),
            cx,
        ),
        labelled(
            "disabled",
            Switch::new("sw-disabled", false).disabled(true),
            cx,
        ),
        labelled(
            "with a label",
            Checkbox::new("cb-label", CheckState::On)
                .label("Include figures folder")
                .description("Images under figures/ go into the ZIP"),
            cx,
        ),
        labelled(
            "slider",
            div()
                .w(px(200.))
                .child(Slider::new("slider", &plain).label("Opacity")),
            cx,
        ),
        labelled(
            "slider, with readout",
            Slider::new("slider-readout", &sized)
                .label("Editor font size")
                .readout(|value| SharedString::from(format!("{value:.0} px"))),
            cx,
        ),
        labelled(
            "slider, disabled",
            div()
                .w(px(200.))
                .child(Slider::new("slider-disabled", &disabled).disabled(true)),
            cx,
        ),
    ]
}

fn small(cx: &Context<Gallery>) -> Vec<AnyElement> {
    vec![
        labelled(
            "segmented",
            Segmented::new("seg")
                .label("Proofread", false, noop)
                .label("Polish", true, noop)
                .label("Translate", false, noop),
            cx,
        ),
        labelled(
            "badges",
            div()
                .flex()
                .gap(px(6.))
                .child(Badge::new("Draft"))
                .child(Badge::new("Synced").tone(BadgeTone::Success))
                .child(Badge::new("3 conflicts").tone(BadgeTone::Warning))
                .child(Badge::new("4×").compact()),
            cx,
        ),
        labelled(
            "keycaps",
            div()
                .flex()
                .gap(px(4.))
                .child(Keycap::new("⌘"))
                .child(Keycap::new("⇧"))
                .child(Keycap::new("K")),
            cx,
        ),
    ]
}
