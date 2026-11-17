//! What tells two open documents with the same file name apart in their
//! tabs (`src/trellis/tab-names.ts`): the shortest run of parent folders, the
//! same length across the files that share the name, that differs between
//! every one of them ("chapters" and "appendix" for two `intro.tex`), as VS
//! Code and Zed draw it after the name. A file whose folders run out before
//! that keeps what it has: one at the project's top has no detail, and its
//! siblings' details set it apart.

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap, HashSet},
    rc::Rc,
};

use trellis::model::LayoutDocument;

use super::{papers::is_reader_key, trellis_layout::file_key, views::documents_of};

/// Each document view's tab text beyond its title ([`tab_text`]), kept by
/// the shell between frames. The skin draws a tab while the workspace is
/// being updated, when it cannot read the workspace's layout, so the shell
/// works these out whenever it can and the skin only looks them up.
#[derive(Clone, Default)]
pub struct TabTexts(Rc<RefCell<HashMap<String, TabText>>>);

/// A tab's detail and tooltip ([`tab_text`]).
type TabText = (Option<String>, Option<String>);

impl TabTexts {
    /// Work every view's text out again from `doc`; `title` names a view's
    /// tab. Whether anything changed, so a frame drawn with the old ones
    /// can be drawn again.
    pub fn refresh(&self, doc: &LayoutDocument, title: impl Fn(&str) -> String) -> bool {
        let texts: HashMap<String, TabText> = doc
            .views
            .keys()
            .map(|view| (view.clone(), tab_text(doc, view, &title(view))))
            .filter(|(_, text)| text.0.is_some() || text.1.is_some())
            .collect();
        let mut current = self.0.borrow_mut();
        if *current == texts {
            return false;
        }
        *current = texts;
        true
    }

    /// The detail and tooltip of view `view_id`'s tab, as last worked out.
    pub fn get(&self, view_id: &str) -> (Option<String>, Option<String>) {
        self.0.borrow().get(view_id).cloned().unwrap_or_default()
    }
}

/// What document view `view_id`'s tab draws beyond its title: the folders
/// that set it apart (across every panel, as two panels side by side are as
/// easy to mix up as two tabs), and its tooltip, the document's path in the
/// project or a Paper's whole title, which the tab may cut short. `None`s for
/// any other view.
pub fn tab_text(
    doc: &LayoutDocument,
    view_id: &str,
    title: &str,
) -> (Option<String>, Option<String>) {
    let key = file_key(doc.views.get(view_id));
    if key.is_empty() {
        return (None, None);
    }
    if is_reader_key(&key) {
        return (None, Some(title.to_string()));
    }
    let open = documents_of(doc);
    let details = tab_details(
        open.iter()
            .map(String::as_str)
            .filter(|key| !is_reader_key(key)),
    );
    (details.get(&key).cloned(), Some(key))
}

/// Each of `paths` that shares its file name with another, mapped to the
/// folders that set it apart.
pub fn tab_details<'a>(paths: impl IntoIterator<Item = &'a str>) -> HashMap<String, String> {
    let mut by_name: BTreeMap<&str, Vec<(&str, Vec<&str>)>> = BTreeMap::new();
    let mut seen = HashSet::new();
    for path in paths {
        if !seen.insert(path) {
            continue;
        }
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        let Some(name) = parts.last().copied() else {
            continue;
        };
        by_name.entry(name).or_default().push((path, parts));
    }
    let mut details = HashMap::new();
    for group in by_name.values().filter(|group| group.len() > 1) {
        let folders: Vec<&[&str]> = group
            .iter()
            .map(|(_, parts)| &parts[..parts.len() - 1])
            .collect();
        let deepest = folders.iter().map(|dirs| dirs.len()).max().unwrap_or(0);
        for depth in 1..=deepest {
            let suffixes: Vec<String> = folders
                .iter()
                .map(|dirs| dirs[dirs.len().saturating_sub(depth)..].join("/"))
                .collect();
            let distinct: HashSet<&String> = suffixes.iter().collect();
            if depth < deepest && distinct.len() < suffixes.len() {
                continue;
            }
            for ((path, _), suffix) in group.iter().zip(suffixes) {
                if !suffix.is_empty() {
                    details.insert((*path).to_string(), suffix);
                }
            }
            break;
        }
    }
    details
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details(paths: &[&str]) -> BTreeMap<String, String> {
        tab_details(paths.iter().copied()).into_iter().collect()
    }

    fn expected(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(path, detail)| (path.to_string(), detail.to_string()))
            .collect()
    }

    #[test]
    fn documents_whose_file_names_differ_have_none() {
        assert!(details(&["main.tex", "chapters/intro.tex", "refs.bib"]).is_empty());
    }

    #[test]
    fn two_same_named_documents_show_the_folder_that_sets_them_apart() {
        assert_eq!(
            details(&["chapters/intro.tex", "appendix/intro.tex", "main.tex"]),
            expected(&[
                ("chapters/intro.tex", "chapters"),
                ("appendix/intro.tex", "appendix"),
            ])
        );
    }

    #[test]
    fn it_goes_up_as_many_folders_as_it_takes_the_same_number_for_each() {
        assert_eq!(
            details(&["a/sec/intro.tex", "b/sec/intro.tex", "c/intro.tex"]),
            expected(&[
                ("a/sec/intro.tex", "a/sec"),
                ("b/sec/intro.tex", "b/sec"),
                ("c/intro.tex", "c"),
            ])
        );
    }

    #[test]
    fn a_document_at_the_projects_top_has_none_its_namesake_has_one() {
        assert_eq!(
            details(&["main.tex", "old/main.tex"]),
            expected(&[("old/main.tex", "old")])
        );
    }

    #[test]
    fn a_document_open_twice_counts_once() {
        assert!(details(&["sec/intro.tex", "sec/intro.tex"]).is_empty());
    }
}
