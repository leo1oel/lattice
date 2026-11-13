//! What the reference's form does to the file (`bib-entry-detail.tsx`):
//! rename the key, change the type, write, remove and add fields. Each is
//! a splice through `BibEditor::edit_entry`, which finds the entry again in
//! the text as it is now; a value that cannot be written is refused with
//! why, and nothing is spliced.

use gpui::{Context, Window};
use lattice_core::bib_document::{self, BibValueStyle};
use lattice_i18n::t;

use super::{BibEditor, model};

impl BibEditor {
    pub(super) fn front(&self) -> Option<(String, usize)> {
        self.selected_row()
            .map(|row| (row.entry.key.clone(), row.index))
    }

    pub(super) fn rename_key(&mut self, value: String, cx: &mut Context<Self>) {
        let Some((current, index)) = self.front() else {
            return;
        };
        let key = value.trim().to_string();
        let error = if key == current {
            None
        } else if !bib_document::valid_citation_key(&key) {
            Some(
                t!(
                    "A citation key cannot be empty or contain spaces, commas, braces, quotes or %."
                )
                .to_string(),
            )
        } else if self
            .rows
            .iter()
            .any(|row| row.index != index && row.entry.key.eq_ignore_ascii_case(&key))
        {
            Some(t!("Another reference already uses “{key}”.", key = key))
        } else {
            let renamed = key.clone();
            if self
                .edit_entry(
                    &current,
                    index,
                    |_, entry| Some(bib_document::rename_key_edit(entry, &renamed)),
                    cx,
                )
                .is_some()
            {
                self.selected = Some(key);
            }
            None
        };
        if let Some(detail) = &mut self.detail {
            detail.key_error = error;
        }
        cx.notify();
    }

    pub(super) fn commit_field(&mut self, at: usize, cx: &mut Context<Self>) {
        let Some((key, index)) = self.front() else {
            return;
        };
        let Some(field) = self
            .detail
            .as_ref()
            .and_then(|detail| detail.fields.get(at))
        else {
            return;
        };
        let value = field.input.value(cx);
        let (name, field_index, style) = (field.name.clone(), field.index, field.style);
        if value == field.text {
            self.set_invalid(at, false, cx);
            return;
        }
        let Some(raw) = bib_document::encode_value(&value, style, &self.macros) else {
            self.set_invalid(at, true, cx);
            return;
        };
        self.set_invalid(at, false, cx);
        self.edit_entry(
            &key,
            index,
            |_, entry| {
                let field = entry
                    .fields
                    .get(field_index)
                    .filter(|field| field.name == name)?;
                Some(bib_document::replace_value_edit(field, &raw))
            },
            cx,
        );
    }

    fn set_invalid(&mut self, at: usize, invalid: bool, cx: &mut Context<Self>) {
        if let Some(field) = self
            .detail
            .as_mut()
            .and_then(|detail| detail.fields.get_mut(at))
        {
            field.invalid = invalid;
            cx.notify();
        }
    }

    pub(super) fn remove_field(&mut self, at: usize, cx: &mut Context<Self>) {
        let Some((key, index)) = self.front() else {
            return;
        };
        let Some((name, field_index)) = self
            .detail
            .as_ref()
            .and_then(|detail| detail.fields.get(at))
            .map(|field| (field.name.clone(), field.index))
        else {
            return;
        };
        self.edit_entry(
            &key,
            index,
            |source, entry| {
                let field = entry
                    .fields
                    .get(field_index)
                    .filter(|field| field.name == name)?;
                Some(bib_document::remove_field_edit(source, entry, field))
            },
            cx,
        );
    }

    pub(super) fn change_type(&mut self, kind: String, cx: &mut Context<Self>) {
        let Some((key, index)) = self.front() else {
            return;
        };
        self.edit_entry(
            &key,
            index,
            |_, entry| Some(bib_document::change_type_edit(entry, &kind)),
            cx,
        );
    }

    pub(super) fn add_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some((key, index)), Some(detail)) = (self.front(), self.detail.as_ref()) else {
            return;
        };
        let name = detail.new_name.read(cx).value().trim().to_string();
        let value = detail.new_value.read(cx).value().to_string();
        let entry_fields: Vec<String> = self
            .selected_row()
            .map(|row| {
                row.entry
                    .fields
                    .iter()
                    .map(|field| field.name.to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        let error = if name.is_empty() {
            return;
        } else if !model::valid_field_name(&name) {
            Some(t!("Field names start with a letter and have no spaces.").to_string())
        } else if entry_fields.contains(&name.to_lowercase()) {
            Some(t!(
                "This reference already has a “{name}” field.",
                name = name
            ))
        } else {
            match bib_document::encode_value(&value, BibValueStyle::Brace, &self.macros) {
                None => Some(t!("Braces in the value must be balanced.").to_string()),
                Some(raw) => {
                    let field = name.clone();
                    self.edit_entry(
                        &key,
                        index,
                        |source, entry| {
                            Some(bib_document::add_field_edit(source, entry, &field, &raw))
                        },
                        cx,
                    );
                    None
                }
            }
        };
        let Some(detail) = self.detail.as_mut() else {
            return;
        };
        if error.is_none() {
            detail
                .new_name
                .update(cx, |input, cx| input.set_value("", window, cx));
            detail
                .new_value
                .update(cx, |input, cx| input.set_value("", window, cx));
        }
        detail.new_error = error;
        cx.notify();
    }
}
