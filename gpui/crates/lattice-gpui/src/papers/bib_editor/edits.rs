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
        let detail = self.detail.as_ref()?;
        let row = model::form_row(
            &self.rows,
            &self.text,
            &detail.key,
            detail.index,
            &detail.signature,
        )?;
        Some((detail.key.clone(), row.index))
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
            .any(|row| row.index != index && model::same_key(&row.entry.key, &key))
        {
            Some(t!("Another reference already uses “{key}”.", key = key))
        } else {
            // Whether the list has this reference in front, read before the
            // splice parses the text again: the stored place can be stale
            // (an undo put an entry back before it), and `selected_row`
            // still resolves it by key.
            let front = self.selected_row().map(|row| row.index);
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
                follow_rename(&mut self.selected, front, index, &key);
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
    pub(super) fn commit_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        let (count, key) = (
            detail.fields.len(),
            detail.key_input.read(cx).value().to_string(),
        );
        for at in 0..count {
            self.commit_field(at, window, cx);
        }
        self.rename_key(key, cx);
    }

    pub(super) fn commit_field(&mut self, at: usize, window: &mut Window, cx: &mut Context<Self>) {
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
        // holds now (a source edit, say) stays, and the box shows it.
        if value == field.filled {
            let written = self
                .row_at(&key, index)
                .and_then(|row| field_named(&row.entry, &name, field_index))
                .and_then(|field| self.text.get(field.value_from..field.value_to))
                .map(|raw| bib_document::editable_value(raw).0)
                .filter(|written| *written != value);
            if let Some(written) = written
                && let Some(field) = self
                    .detail
                    .as_mut()
                    .and_then(|detail| detail.fields.get_mut(at))
            {
                field.input.set_value(written, window, cx);
                field.filled = field.input.value(cx);
            }
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
        // The type already checked is no change: rewriting `@Article` as
        // `@article` would touch the file and the history for nothing, and
        // the Tauri app's Select never reports its current value.
        self.edit_entry(
            &key,
            index,
            |_, entry| {
                (!entry.kind.eq_ignore_ascii_case(&kind))
                    .then(|| bib_document::change_type_edit(entry, &kind))
            },
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
            .row_at(&key, index)
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

/// The reference at `index` now goes by `key`: a selection of it follows,
/// one of another entry under the old key stays where it is. `front` is the
/// place of the row the selection resolved to before the rename, not the
/// place it stored, which can lag behind entries coming and going; the
/// selection takes the renamed entry's place as well, as the Tauri app's
/// `onRenamed` puts the new key in front.
fn follow_rename(
    selected: &mut Option<(String, usize)>,
    front: Option<usize>,
    index: usize,
    key: &str,
) {
    if selected.is_some() && front == Some(index) {
        *selected = Some((key.to_string(), index));
    }
}

#[cfg(test)]
mod tests {
    use super::follow_rename;

    /// Two `smith2020` entries: the first renamed while the second is
    /// picked leaves the second picked, under its own key.
    #[test]
    fn a_rename_moves_only_the_renamed_entrys_selection() {
        let mut picked = Some(("smith2020".to_string(), 1));
        follow_rename(&mut picked, Some(1), 0, "smith2020a");
        assert_eq!(picked, Some(("smith2020".to_string(), 1)));
        let mut renamed = Some(("smith2020".to_string(), 0));
        follow_rename(&mut renamed, Some(0), 0, "smith2020a");
        assert_eq!(renamed, Some(("smith2020a".to_string(), 0)));
    }

    /// Entries `a`, `b`, `c`: delete `a` (the selection becomes `("b", 0)`),
    /// undo it (`b` is back at place 1, the selection still says 0 and
    /// resolves to `b` by key), then rename `b` to `b2`. The selection
    /// follows to `("b2", 1)` rather than being lost.
    #[test]
    fn a_rename_follows_a_selection_whose_stored_place_is_stale() {
        let mut selected = Some(("b".to_string(), 0));
        follow_rename(&mut selected, Some(1), 1, "b2");
        assert_eq!(selected, Some(("b2".to_string(), 1)));
    }
}
