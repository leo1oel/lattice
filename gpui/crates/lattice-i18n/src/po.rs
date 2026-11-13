//! Reading a Lingui `.po` catalog: each entry's context, source string and
//! translation. The same reading as the Tauri app's `scripts/lib/po-catalog.mjs`
//! (CRLF lines accepted, the header entry skipped), plus `msgctxt`, which
//! Lingui writes for a message given a context.

/// One translated message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub context: Option<String>,
    pub msgid: String,
    pub msgstr: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Context,
    Id,
    Str,
}

/// The entries of a catalog, header excluded.
pub fn parse(text: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut entry: Option<Entry> = None;
    let mut pending_context: Option<String> = None;
    let mut field: Option<Field> = None;
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let start = [
            ("msgctxt ", Field::Context),
            ("msgid ", Field::Id),
            ("msgstr ", Field::Str),
        ]
        .into_iter()
        .find_map(|(prefix, field)| line.strip_prefix(prefix).map(|rest| (field, rest)));
        if let Some((started, rest)) = start {
            let value = unquote(rest).unwrap_or_default();
            match started {
                Field::Context => {
                    entries.extend(entry.take());
                    pending_context = Some(value);
                }
                Field::Id => {
                    entries.extend(entry.take());
                    entry = Some(Entry {
                        context: pending_context.take(),
                        msgid: value,
                        msgstr: String::new(),
                    });
                }
                Field::Str => {
                    if let Some(entry) = entry.as_mut() {
                        entry.msgstr = value;
                    }
                }
            }
            field = Some(started);
        } else if line.starts_with('"') {
            let value = unquote(line).unwrap_or_default();
            match field {
                Some(Field::Context) => {
                    if let Some(context) = pending_context.as_mut() {
                        context.push_str(&value);
                    }
                }
                Some(Field::Id) => {
                    if let Some(entry) = entry.as_mut() {
                        entry.msgid.push_str(&value);
                    }
                }
                Some(Field::Str) => {
                    if let Some(entry) = entry.as_mut() {
                        entry.msgstr.push_str(&value);
                    }
                }
                None => {}
            }
        } else {
            field = None;
        }
    }
    entries.extend(entry);
    entries.retain(|entry| !entry.msgid.is_empty());
    entries
}

/// A quoted `.po` string's text, its C escapes undone.
fn unquote(quoted: &str) -> Option<String> {
    let inner = quoted.trim_end().strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_entries_contexts_continuations_and_escapes() {
        let text = "msgid \"\"\r\nmsgstr \"\"\r\n\"Language: zh-CN\\n\"\r\n\r\n\
                    #: src/a.tsx\r\nmsgid \"Build\"\r\nmsgstr \"编译\"\r\n\r\n\
                    msgctxt \"tracked changes\"\nmsgid \"{0} changes\"\nmsgstr \"{0} 处改动\"\n\n\
                    msgid \"\"\n\"Say \\\"hi\\\"\\n\"\n\"again\"\nmsgstr \"说\\\"你好\\\"\"\n";
        assert_eq!(
            parse(text),
            vec![
                Entry {
                    context: None,
                    msgid: "Build".into(),
                    msgstr: "编译".into(),
                },
                Entry {
                    context: Some("tracked changes".into()),
                    msgid: "{0} changes".into(),
                    msgstr: "{0} 处改动".into(),
                },
                Entry {
                    context: None,
                    msgid: "Say \"hi\"\nagain".into(),
                    msgstr: "说\"你好\"".into(),
                },
            ]
        );
    }
}
