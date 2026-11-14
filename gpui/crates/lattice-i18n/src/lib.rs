//! Lattice's interface languages: English, and Simplified Chinese from the
//! Tauri app's own Lingui catalog (`../src/locales/zh-CN/messages.po`), read
//! at build time so the two apps say the same thing in the same words.
//!
//! A message is keyed by its English source string, as Lingui keys it, so the
//! English interface needs no catalog at all: `t!("Build")` is "Build" in
//! English and "编译" in Chinese. Strings only the GPUI app shows are in this
//! crate's `locales/zh-CN.po`, in the same format; a test keeps the two from
//! overlapping and checks every string the app translates has Chinese
//! (`tests/coverage.rs`, the port of `scripts/check-i18n-coverage.mjs`).
//!
//! Placeholders are Lingui's: `{0}`, `{1}` by position, or `{name}`.
//!
//! ```
//! use lattice_i18n::{Locale, set_locale, t};
//! set_locale(Locale::ZhCn);
//! assert_eq!(t!("Build"), "编译");
//! set_locale(Locale::En);
//! assert_eq!(t!("Version {0}", "1.2"), "Version 1.2");
//! ```

mod format;
pub mod po;

use std::{
    collections::HashMap,
    fmt::Display,
    sync::{
        LazyLock,
        atomic::{AtomicU8, Ordering},
    },
};

pub use format::{
    comma, format_count, join_conjunction, join_list, join_phrases, space_mixed_script,
};

/// The Tauri app's catalog, shared word for word.
pub const APP_CATALOG: &str = include_str!("../../../../src/locales/zh-CN/messages.po");
/// The strings only the GPUI app shows, in the same format.
pub const GPUI_CATALOG: &str = include_str!("../locales/zh-CN.po");

/// An interface language.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Locale {
    #[default]
    En,
    ZhCn,
}

impl Locale {
    /// The BCP 47 tag, as the Tauri app stores it (`AppLocale`).
    pub fn tag(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::ZhCn => "zh-CN",
        }
    }

    pub fn is_chinese(self) -> bool {
        self == Locale::ZhCn
    }
}

/// The language the interface shows: `fixed` when the writer chose one,
/// else from the system's preferred languages in order
/// (`resolveAppLocale`): only the first decides, so a secondary Chinese
/// reading language never overrides an English system.
pub fn resolve_locale<S: AsRef<str>>(fixed: Option<Locale>, system_languages: &[S]) -> Locale {
    if let Some(locale) = fixed {
        return locale;
    }
    let first = system_languages
        .first()
        .map(|language| language.as_ref().to_ascii_lowercase())
        .unwrap_or_default();
    if first == "zh" || first.starts_with("zh-") || first.starts_with("zh_") {
        Locale::ZhCn
    } else {
        Locale::En
    }
}

static LOCALE: AtomicU8 = AtomicU8::new(0);

/// The language every `t!` answers in from now on. The app redraws its
/// windows after changing it.
pub fn set_locale(locale: Locale) {
    LOCALE.store(
        match locale {
            Locale::En => 0,
            Locale::ZhCn => 1,
        },
        Ordering::Relaxed,
    );
}

pub fn locale() -> Locale {
    match LOCALE.load(Ordering::Relaxed) {
        1 => Locale::ZhCn,
        _ => Locale::En,
    }
}

struct Catalog {
    plain: HashMap<&'static str, &'static str>,
    contextual: HashMap<(&'static str, &'static str), &'static str>,
}

fn leak(text: String) -> &'static str {
    Box::leak(text.into_boxed_str())
}

static ZH_CN: LazyLock<Catalog> = LazyLock::new(|| {
    let mut catalog = Catalog {
        plain: HashMap::new(),
        contextual: HashMap::new(),
    };
    for entry in po::parse(APP_CATALOG)
        .into_iter()
        .chain(po::parse(GPUI_CATALOG))
    {
        // An untranslated entry falls back to the English, as Lingui does.
        if entry.msgstr.is_empty() {
            continue;
        }
        let (msgid, msgstr) = (leak(entry.msgid), leak(entry.msgstr));
        match entry.context {
            Some(context) => {
                catalog.contextual.insert((leak(context), msgid), msgstr);
            }
            None => {
                catalog.plain.insert(msgid, msgstr);
            }
        }
    }
    catalog
});

/// `msgid` in the interface language: the catalog's translation, or the
/// English itself when there is none.
pub fn tr(msgid: &'static str) -> &'static str {
    match locale() {
        Locale::En => msgid,
        Locale::ZhCn => ZH_CN.plain.get(msgid).copied().unwrap_or(msgid),
    }
}

/// `msgid` given Lingui's `context` (`msgctxt`), for a source string that
/// reads differently in two places.
pub fn tr_context(context: &'static str, msgid: &'static str) -> &'static str {
    match locale() {
        Locale::En => msgid,
        Locale::ZhCn => ZH_CN
            .contextual
            .get(&(context, msgid))
            .copied()
            .unwrap_or(msgid),
    }
}

/// The Chinese for `msgid`, whatever the interface language (for tests and
/// the coverage check).
pub fn chinese(context: Option<&str>, msgid: &str) -> Option<&'static str> {
    match context {
        None => ZH_CN.plain.get(msgid).copied(),
        Some(context) => ZH_CN
            .contextual
            .iter()
            .find(|((c, id), _)| *c == context && *id == msgid)
            .map(|(_, text)| *text),
    }
}

/// Put positional values into a message's `{0}`, `{1}`… placeholders.
pub fn fill(message: &str, values: &[&dyn Display]) -> String {
    fill_with(message, |name| {
        name.parse::<usize>()
            .ok()
            .and_then(|index| values.get(index))
            .map(|value| value.to_string())
    })
}

/// Put named values into a message's `{name}` placeholders.
pub fn fill_named(message: &str, values: &[(&str, &dyn Display)]) -> String {
    fill_with(message, |name| {
        values
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.to_string())
    })
}

/// Replace each `{name}` the lookup knows; anything else is left as written.
fn fill_with(message: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(message.len() + 16);
    let mut rest = message;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => match lookup(&after[..close]) {
                Some(value) => {
                    out.push_str(&value);
                    rest = &after[close + 1..];
                }
                None => {
                    out.push('{');
                    rest = after;
                }
            },
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A message in the interface language: `t!("Build")` is a `&'static str`;
/// with values, `t!("Version {0}", version)` or
/// `t!("Signed {name}", name = who)`, a `String`.
#[macro_export]
macro_rules! t {
    ($msgid:literal $(,)?) => {
        $crate::tr($msgid)
    };
    ($msgid:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::fill_named($crate::tr($msgid), &[$((stringify!($name), &$value as &dyn ::std::fmt::Display)),+])
    };
    ($msgid:literal, $($value:expr),+ $(,)?) => {
        $crate::fill($crate::tr($msgid), &[$(&$value as &dyn ::std::fmt::Display),+])
    };
}

/// Mark a message in a static table (a vocabulary, a command list) for
/// translation where it is shown, with [`tr`]: `n!("Bold text command")` is
/// the literal itself, as Lingui's `msg` is a descriptor, and the coverage
/// test asks the catalog for it like any other.
#[macro_export]
macro_rules! n {
    ($msgid:literal) => {
        $msgid
    };
}

/// [`t!`] with Lingui's context: `tc!("tab", "Close")`.
#[macro_export]
macro_rules! tc {
    ($context:literal, $msgid:literal $(,)?) => {
        $crate::tr_context($context, $msgid)
    };
    ($context:literal, $msgid:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::fill_named($crate::tr_context($context, $msgid), &[$((stringify!($name), &$value as &dyn ::std::fmt::Display)),+])
    };
    ($context:literal, $msgid:literal, $($value:expr),+ $(,)?) => {
        $crate::fill($crate::tr_context($context, $msgid), &[$(&$value as &dyn ::std::fmt::Display),+])
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The locale is process-wide; tests that switch it take turns.
    pub(crate) static LOCALE_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn english_is_the_source_and_chinese_comes_from_the_tauri_catalog() {
        let _guard = LOCALE_LOCK.lock().unwrap();
        set_locale(Locale::En);
        assert_eq!(t!("Build"), "Build");
        set_locale(Locale::ZhCn);
        assert_eq!(t!("Build"), "编译");
        assert_eq!(t!("A message nobody wrote"), "A message nobody wrote");
        assert_eq!(
            tc!("tracked changes waiting for review", "{0} changes", 3),
            "3 处改动"
        );
        set_locale(Locale::En);
    }

    #[test]
    fn placeholders_take_positional_and_named_values() {
        let _guard = LOCALE_LOCK.lock().unwrap();
        set_locale(Locale::En);
        assert_eq!(t!("{0} of {1}", 2, 5), "2 of 5");
        assert_eq!(
            fill_named("Hi {name}, {name}", &[("name", &"Ada")]),
            "Hi Ada, Ada"
        );
        // Unknown and unclosed braces stay as written.
        assert_eq!(fill("{x} {0} {", &[&1]), "{x} 1 {");
    }

    #[test]
    fn system_language_resolution_follows_the_first_preference_only() {
        assert_eq!(resolve_locale(None, &["zh-Hans-CN", "en"]), Locale::ZhCn);
        assert_eq!(resolve_locale(None, &["en-US", "zh-Hans"]), Locale::En);
        assert_eq!(resolve_locale(None, &["zh"]), Locale::ZhCn);
        assert_eq!(resolve_locale::<&str>(None, &[]), Locale::En);
        assert_eq!(resolve_locale(Some(Locale::En), &["zh-CN"]), Locale::En);
    }

    #[test]
    fn the_gpui_catalog_adds_only_what_the_tauri_catalog_lacks() {
        let app: std::collections::HashSet<_> = po::parse(APP_CATALOG)
            .into_iter()
            .map(|entry| (entry.context, entry.msgid))
            .collect();
        let doubled: Vec<_> = po::parse(GPUI_CATALOG)
            .into_iter()
            .filter(|entry| app.contains(&(entry.context.clone(), entry.msgid.clone())))
            .map(|entry| entry.msgid)
            .collect();
        assert!(
            doubled.is_empty(),
            "locales/zh-CN.po repeats messages the Tauri catalog already translates: {doubled:?}"
        );
    }
}
