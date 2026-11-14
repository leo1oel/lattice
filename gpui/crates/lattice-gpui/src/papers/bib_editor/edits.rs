//! What the reference's form does to the file (`bib-entry-detail.tsx`):
//! rename the key, change the type, write, remove and add fields. Each is
//! a splice through `BibEditor::edit_entry`, which finds the entry again in
//! the text as it is now; a value that cannot be written is refused with
//! why, and nothing is spliced.

use gpui::{Context, Window};
use lattice_core::bib_document::{self, BibEntry, BibField, BibValueStyle};
use lattice_i18n::t;

use super::{BibEditor, model};

/// The field `name` of `entry`: the one at `index` when it still has that
/// name, else the first so named, as fields before it come and go.
fn field_named<'a>(entry: &'a BibEntry, name: &str, index: usize) -> Option<&'a BibField> {
    entry
        .fields
        .get(index)
        .filter(|field| field.name == name)
        .or_else(|| entry.fields.iter().find(|field| field.name == name))
}

impl BibEditor {
    /// The reference the form was built for, by key, and its place as last
    /// read: a box left as another row comes to the front still writes
    /// into the reference it showed.
    pub(super) fn front(&self) -> Option<(String, usize)> {
        let key = &self.detail.as_ref()?.key;
        let index = self
            .rows
            .iter()
            .find(|row| &row.entry.key == key)
            .map_or(usize::MAX, |row| row.index);
        Some((key.clone(), index))
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
            .any(|row| row.index != index && row.entry.key.to_lowercase() == key.to_lowercase())
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
                if self
                    .selected
                    .as_deref()
                    .is_some_and(|selected| selected.eq_ignore_ascii_case(&current))
                {
                    self.selected = Some(key.clone());
                }
                // The same reference under its new key: its form is kept.
                if let Some(detail) = &mut self.detail {
                    detail.key = key;
                }
            }
            None
        };
        if let Some(detail) = &mut self.detail {
            detail.key_error = error;
        }
        cx.notify();
    }

    /// Write every box of the form as it stands: its fields, then its key.
    pub(super) fn commit_form(&mut self, cx: &mut Context<Self>) {
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        let (count, key) = (
            detail.fields.len(),
            detail.key_input.read(cx).value().to_string(),
        );
        for at in 0..count {
            self.commit_field(at, cx);
        }
        self.rename_key(key, cx);
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
        // Nothing typed since the box was last filled: whatever the file
        // holds now (a source edit, say) stays.
        if value == field.filled {
            self.set_invalid(at, false, cx);
            return;
        }
        let Some(raw) = bib_document::encode_value(&value, style, &self.macros) else {
            self.set_invalid(at, true, cx);
            return;
        };
        self.set_invalid(at, false, cx);
        let written = self.edit_entry(
            &key,
            index,
            |_, entry| {
                let field = field_named(entry, &name, field_index)?;
                Some(bib_document::replace_value_edit(field, &raw))
            },
            cx,
        );
        // Written: typing the earlier value back is a change again.
        if written.is_some()
            && let Some(field) = self
                .detail
                .as_mut()
                .and_then(|detail| detail.fields.get_mut(at))
        {
            field.filled = value;
        }
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
                let field = field_named(entry, &name, field_index)?;
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
            .rows
            .iter()
            .find(|row| row.entry.key == key)
            .map(|row| {
                row.entry
                    .fields
                    .iter()
                    .map(|field| field.name.to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        let error = if !model::valid_field_name(&name) {
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
