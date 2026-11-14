//! Settings › Model endpoint's page, drawn as `model-endpoint-settings.tsx`
//! lays it out: Before you start, the endpoint, the models' table, the
//! actions, then what a test or an action found.

use gpui::{
    AnyElement, Context, ElementId, Entity, IntoElement, ParentElement as _, Pixels,
    SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::InputState;
use lattice_i18n::t;
use lattice_settings::SettingsTab;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, CheckState, Checkbox, Field, IconButton},
};
use serde_json::{Value, json};

use super::{
    Busy, MAX_MODELS, ModelEndpointPane,
    protocol::{ADVANCED_NAMES, Protocol, describe_probe, probe_checks},
};
use crate::settings::controls::{self, Level, PageWidth, Row, Wrap};

/// `.model-endpoint-model`'s columns: the name takes the slack, the two
/// limits are short numbers, then the images box and the remove button.
const LIMIT_COLUMN: Pixels = px(112.);
const IMAGES_COLUMN: Pixels = px(56.);
const REMOVE_COLUMN: Pixels = px(32.);
const NAME_MIN: Pixels = px(128.);

impl ModelEndpointPane {
    pub fn render_page(
        &mut self,
        width: PageWidth,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let disabled = self.busy.is_some();
        let this = cx.entity();
        for input in [&self.base_url, &self.key] {
            input.update(cx, |input, cx| input.set_disabled(disabled, cx));
        }
        self.base_url.update(cx, |input, cx| {
            input.set_placeholder(self.protocol.placeholder(), window, cx)
        });
        let key_saved = self.key_saved();
        self.key.update(cx, |input, cx| {
            input.set_placeholder(
                if key_saved {
                    t!("Enter a replacement key")
                } else {
                    t!("Paste your API key")
                },
                window,
                cx,
            )
        });

        let mut groups: Vec<AnyElement> = Vec::new();
        if self.busy == Some(Busy::Load) {
            groups.push(crate::build::chip_mark::infinity_loader(
                "model-endpoint-loading",
                px(16.),
                &palette,
            ));
        }

        // Before you start.
        let open_providers = {
            let dialog = self.dialog.clone();
            Button::new("model-endpoint-open-providers", t!("Open Providers"))
                .compact()
                .on_click(move |_, _, cx| {
                    dialog
                        .update(cx, |dialog, cx| dialog.open_tab(SettingsTab::Agent, cx))
                        .ok();
                })
        };
        groups.push(controls::first_group(
            Some(t!("Before you start").into()),
            vec![
                controls::block(
                    controls::inline_message(
                        Level::Info,
                        t!("In “Ask before outside edits and network”, Pi asks before it edits a file or runs a command; in “Never ask” it doesn’t. Each edit is checkpointed so you can undo it, and .bib files stay protected."),
                        cx,
                    ),
                    false,
                ),
                controls::block(
                    controls::inline_message(
                        Level::Info,
                        t!("Proofread, Polish and revision requests use the endpoint once you choose one of its models under Providers › Proofreading model. It isn’t chosen automatically."),
                        cx,
                    ),
                    false,
                ),
                Row::new("model-endpoint-runtime", t!("Pi runtime"))
                    .description(
                        t!("Pi is a one-time download of about 150 MB. Install it under Providers › Pi."),
                        cx,
                    )
                    .control(open_providers)
                    .render(width, cx),
            ],
            cx,
        ));

        // Endpoint.
        let mut protocols: Vec<(Protocol, SharedString)> = vec![
            (Protocol::OpenAiCompletions, t!("OpenAI-compatible").into()),
            (Protocol::AnthropicMessages, t!("Anthropic-compatible").into()),
        ];
        if self.advanced {
            protocols.extend(ADVANCED_NAMES.map(|(protocol, name)| (protocol, name.into())));
        }
        let protocol_select = {
            let this = this.clone();
            controls::select("model-endpoint-protocol", protocols, self.protocol, move |protocol, _, cx| {
                this.update(cx, |pane, cx| {
                    pane.protocol = protocol;
                    pane.notice = None;
                    pane.report = None;
                    cx.notify();
                })
            })
        };
        let more = {
            let this = this.clone();
            controls::switch(
                "model-endpoint-advanced",
                self.advanced,
                self.protocol.advanced(),
                move |on, _, cx| {
                    this.update(cx, |pane, cx| {
                        pane.advanced = on;
                        cx.notify();
                    })
                },
            )
        };
        let remove_key = key_saved.then(|| {
            let this = this.clone();
            Button::new("model-endpoint-remove-key", t!("Remove key"))
                .compact()
                .ghost()
                .disabled(disabled)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| {
                        pane.save(json!({ "action": "remove" }), window, cx)
                    })
                })
        });
        let mut key_row = Row::new("model-endpoint-key", t!("API key")).description(
            if key_saved {
                t!("Saved in the keychain. Enter a new one to replace it.")
            } else {
                t!("Kept in the macOS keychain. Leave it empty for a local server that needs none.")
            },
            cx,
        );
        if let Some(remove_key) = remove_key {
            key_row = key_row.control(remove_key);
        }
        groups.push(controls::group(
            Some(t!("Endpoint").into()),
            vec![
                Row::new("model-endpoint-protocol", t!("Protocol"))
                    .description(t!("How the endpoint expects requests."), cx)
                    .control(protocol_select)
                    .render(width, cx),
                Row::new("model-endpoint-advanced", t!("More protocols"))
                    .description(
                        ADVANCED_NAMES.map(|(_, name)| name).join(", "),
                        cx,
                    )
                    .control(more)
                    .wrap(Wrap::Never)
                    .render(width, cx),
                Row::new("model-endpoint-address", t!("Address"))
                    .description(self.protocol.address_help(), cx)
                    .render(width, cx),
                controls::block(Field::new(&self.base_url).disabled(disabled), true),
                key_row.render(width, cx),
                controls::block(Field::new(&self.key).disabled(disabled), true),
            ],
            cx,
        ));

        // Models.
        let add = {
            let this = this.clone();
            Button::new("model-endpoint-add-model", t!("Add model"))
                .compact()
                .icon(Icon::PLUS)
                .disabled(disabled || self.models.len() >= MAX_MODELS)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| pane.add_model(window, cx))
                })
        };
        groups.push(controls::group(
            Some(t!("Models").into()),
            vec![
                Row::new("model-endpoint-models", t!("Models to offer"))
                    .description(
                        t!("Names as the endpoint spells them. Test connection tries the first."),
                        cx,
                    )
                    .control(add)
                    .render(width, cx),
                controls::block(self.models_grid(disabled, cx), true),
            ],
            cx,
        ));

        // Save, test, remove.
        let base_url_empty = self.base_url.read(cx).value().trim().is_empty();
        let save = {
            let this = this.clone();
            Button::new("model-endpoint-save", t!("Save"))
                .compact()
                .primary()
                .disabled(disabled || base_url_empty)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| pane.save_typed_key(window, cx))
                })
        };
        let test = {
            let this = this.clone();
            Button::new("model-endpoint-test", t!("Test connection"))
                .compact()
                .disabled(disabled || base_url_empty)
                .on_click(move |_, window, cx| this.update(cx, |pane, cx| pane.test(window, cx)))
        };
        let remove = self.has_saved_endpoint().then(|| {
            let this = this.clone();
            Button::new("model-endpoint-remove", t!("Remove endpoint"))
                .compact()
                .ghost()
                .disabled(disabled)
                .on_click(move |_, window, cx| this.update(cx, |pane, cx| pane.remove(window, cx)))
        });
        let working = self.busy.filter(|busy| *busy != Busy::Load).is_some();
        groups.push(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(4.))
                .child(save)
                .child(test)
                .children(remove)
                .when(working, |this| {
                    this.child(crate::build::chip_mark::infinity_loader(
                        "model-endpoint-working",
                        px(14.),
                        &palette,
                    ))
                })
                .into_any_element(),
        );

        // What a test or an action found: under the actions, 4px apart
        // (the page's children after the form sit in its flow).
        let mut tail: Vec<AnyElement> = Vec::new();
        if self.busy == Some(Busy::Test) {
            tail.push(
                div()
                    .py(px(4.))
                    .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("Asking the first model to call a tool. This can take up to 45 seconds."))
                    .into_any_element(),
            );
        }
        if let Some(report) = &self.report {
            tail.push(self.report_view(report, cx));
        }
        if let Some(notice) = &self.notice {
            let restart = notice.restart.then(|| {
                let this = this.clone();
                Button::new("model-endpoint-restart", t!("Restart agent"))
                    .compact()
                    .disabled(disabled)
                    .on_click(move |_, _, cx| this.update(cx, |pane, cx| pane.restart(cx)))
            });
            tail.push(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .child(controls::inline_message(notice.level, notice.text.clone(), cx))
                    .children(restart)
                    .into_any_element(),
            );
        }
        let mut page = controls::described_page(
            t!("Model endpoint"),
            Some(t!("Use your own OpenAI- or Anthropic-compatible API with an address, a key and model names. The agent runs it through Pi, with no command-line tool to install.").into()),
            width,
            groups,
            cx,
        );
        if !tail.is_empty() {
            // The report and the notice follow the actions without the
            // groups' 28px rhythm.
            page = div()
                .w_full()
                .child(page)
                .child(
                    div()
                        .max_w(controls::CONTENT_MAX_WIDTH)
                        .mt(px(-48.))
                        .px(width.inset())
                        .pb(px(48.))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .children(tail),
                )
                .into_any_element();
        }
        page
    }

    /// The models' table: a header of captions, then one line per model.
    fn models_grid(&self, disabled: bool, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let this = cx.entity();
        let line = |cells: [AnyElement; 5]| {
            let [name, context, max, images, remove] = cells;
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(div().flex_1().min_w(NAME_MIN).child(name))
                .child(div().w(LIMIT_COLUMN).flex_none().child(context))
                .child(div().w(LIMIT_COLUMN).flex_none().child(max))
                .child(
                    div()
                        .w(IMAGES_COLUMN)
                        .flex_none()
                        .flex()
                        .justify_center()
                        .child(images),
                )
                .child(div().w(REMOVE_COLUMN).flex_none().child(remove))
                .into_any_element()
        };
        let caption = |text: SharedString| {
            div()
                .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                .text_color(palette.text_secondary)
                .child(text)
                .into_any_element()
        };
        let mut rows = vec![line([
            caption(t!("Model name").into()),
            caption(t!("Context window").into()),
            caption(t!("Max output").into()),
            caption(t!("Images").into()),
            div().into_any_element(),
        ])];
        let only = self.models.len() == 1;
        for (index, model) in self.models.iter().enumerate() {
            for input in [&model.id, &model.context_window, &model.max_tokens] {
                input.update(cx, |input, cx| input.set_disabled(disabled, cx));
            }
            let images = {
                let this = this.clone();
                Checkbox::new(
                    ElementId::Name(format!("model-endpoint-images-{index}").into()),
                    if model.images {
                        CheckState::On
                    } else {
                        CheckState::Off
                    },
                )
                .disabled(disabled)
                .on_toggle(move |on, _, cx| {
                    let on = *on;
                    this.update(cx, |pane, cx| {
                        if let Some(model) = pane.models.get_mut(index) {
                            model.images = on;
                        }
                        pane.notice = None;
                        pane.report = None;
                        cx.notify();
                    })
                })
                .into_any_element()
            };
            let remove = {
                let this = this.clone();
                IconButton::new(
                    ElementId::Name(format!("model-endpoint-remove-{index}").into()),
                    Icon::TRASH,
                )
                .tooltip(t!("Remove model"))
                .disabled(disabled || only)
                .on_click(move |_, _, cx| {
                    this.update(cx, |pane, cx| {
                        if pane.models.len() > 1 && index < pane.models.len() {
                            pane.models.remove(index);
                            cx.notify();
                        }
                    })
                })
                .into_any_element()
            };
            rows.push(line([
                Field::new(&model.id).disabled(disabled).into_any_element(),
                Field::new(&model.context_window)
                    .disabled(disabled)
                    .into_any_element(),
                Field::new(&model.max_tokens)
                    .disabled(disabled)
                    .into_any_element(),
                images,
                remove,
            ]));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .pb(px(4.))
            .children(rows)
            .into_any_element()
    }

    /// The connection test's checklist, its sentence and the endpoint's own
    /// words (`.model-endpoint-report`).
    fn report_view(&self, report: &Value, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let passed: Vec<String> = report
            .get("passed")
            .and_then(Value::as_array)
            .map(|passed| {
                passed
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let (ok, message) = describe_probe(report);
        let checks = div()
            .flex()
            .flex_wrap()
            .gap_x(px(8.))
            .gap_y(px(4.))
            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
            .children(probe_checks().into_iter().map(|(id, label)| {
                let done = passed.iter().any(|passed| passed == id);
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .text_color(if done {
                        palette.text
                    } else {
                        palette.text_secondary
                    })
                    .child(
                        if done { Icon::CHECK } else { Icon::X }.element(
                            px(13.),
                            if done {
                                palette.success
                            } else {
                                palette.text_secondary
                            },
                        ),
                    )
                    .child(label)
            }));
        let detail = report
            .get("detail")
            .and_then(Value::as_str)
            .filter(|detail| !detail.is_empty())
            .map(|detail| {
                div()
                    .py(px(4.))
                    .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("The endpoint said: {detail}", detail = detail).to_string())
            });
        div()
            .py(px(6.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(checks)
            .child(controls::inline_message(
                if ok { Level::Success } else { Level::Warning },
                message,
                cx,
            ))
            .children(detail)
            .into_any_element()
    }
}
