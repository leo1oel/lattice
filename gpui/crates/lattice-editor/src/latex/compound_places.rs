//! Where a chemnum compound is drawn, as the Tauri app's
//! `compound-places.ts` finds it for the compound list: the float (figure,
//! scheme, chart, graph, table) holding the editable-figure entry file that
//! names the key, and the short line the completion shows for it
//! ("Scheme 1: Reduction of…").
//!
//! Sources are untrusted: scans are bounded (uses per source, entries per
//! project, caption length), and Rust's regexes run in linear time.

use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

use regex::Regex;

use super::{
    compiled_labels::CompiledLabel,
    compounds::{compound_keys_on_line, numbered_key},
};

static FLOAT_EDGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(begin|end)\{(figure|scheme|chart|graph|table)\*?\}")
        .expect("the float edge pattern compiles")
});
static INCLUDE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:(?:sub)?import\{([^{}]*)\}\{([^{}]*)\}|(?:input|include)\{([^{}]*)\})")
        .expect("the include pattern compiles")
});
static CAPTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\caption(?:\[[^\]\[{}]*\])?\{").expect("the caption pattern compiles")
});
static LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\label\{([^{}]*)\}").expect("the label pattern compiles"));
static CAPTION_COMPOUND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:cmpd\*?|refcmpd)(?:\[[^\]\[{}]*\])?\{([^{}]*)\}")
        .expect("the caption compound pattern compiles")
});
static CAPTION_MARK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\rcmpd\{([^{}]*)\}").expect("the caption mark pattern compiles")
});
static CAPTION_DROPPED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:label|cite[a-z]*|ref)\{[^{}]*\}").expect("the dropped pattern compiles")
});
static CAPTION_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\[A-Za-z@]+\*?").expect("the command pattern compiles"));
static CAPTION_PUNCTUATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[{}$~]").expect("the punctuation pattern compiles"));
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("the spaces pattern compiles"));

const FIGURE_ENTRY: &str = "% editable-figure source: ";
const CAPTION_LENGTH: usize = 48;
/// Enough of a caption for its short line.
const CAPTION_SCAN: usize = 2000;
/// The uses of one entry file looked at in one source.
const MAX_USES: usize = 20;
/// The figure entries a project's list reads.
const MAX_ENTRIES: usize = 500;

/// The float a compound's figure sits in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompoundFloat {
    pub environment: String,
    pub label: Option<String>,
    /// Its place among the floats of its kind in the including file, from 1.
    pub ordinal: usize,
    pub caption: Option<String>,
}

/// Where a compound is drawn: its entry file's name, and the float that
/// includes it, when one does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompoundPlace {
    pub file: String,
    pub float: Option<CompoundFloat>,
}

/// `text` with its comments blanked, every offset unchanged.
fn without_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let (body, newline) = match line.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (line, ""),
        };
        let bytes = body.as_bytes();
        let comment =
            (0..bytes.len()).find(|&at| bytes[at] == b'%' && (at == 0 || bytes[at - 1] != b'\\'));
        match comment {
            Some(at) => {
                out.push_str(&body[..at]);
                out.extend(std::iter::repeat_n(' ', body.len() - at));
            }
            None => out.push_str(body),
        }
        out.push_str(newline);
    }
    out
}

/// The balanced group opening at byte `open`: its content, or `None` when it
/// never closes (`bracedGroup`).
pub fn braced_group(text: &str, open: usize) -> Option<&str> {
    let bytes = text.as_bytes();
    if bytes.get(open) != Some(&b'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut at = open;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 1,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[open + 1..at]);
                }
            }
            _ => {}
        }
        at += 1;
    }
    None
}

/// A source with its comments blanked and its float edges, read once.
struct Scanned {
    text: String,
    /// Each edge: its offset, whether it begins, and its environment.
    edges: Vec<(usize, bool, String)>,
}

fn scanned(text: &str) -> Scanned {
    let blank = without_comments(text);
    let edges = FLOAT_EDGE
        .captures_iter(&blank)
        .map(|found| {
            (
                found.get(0).map_or(0, |m| m.start()),
                &found[1] == "begin",
                found[2].to_string(),
            )
        })
        .collect();
    Scanned { text: blank, edges }
}

/// The float open at `position` in `text` (`enclosingFloat`).
pub fn enclosing_float(text: &str, position: usize) -> Option<CompoundFloat> {
    float_at(&scanned(text), position)
}

fn float_at(source: &Scanned, position: usize) -> Option<CompoundFloat> {
    let mut open: Vec<&(usize, bool, String)> = Vec::new();
    for edge in &source.edges {
        if edge.0 >= position {
            break;
        }
        if edge.1 {
            open.push(edge);
        } else {
            open.pop();
        }
    }
    let begin = *open.last()?;
    let environment = begin.2.clone();
    let after = source
        .edges
        .iter()
        .find(|edge| edge.0 > position && !edge.1 && edge.2 == environment)
        .map_or(source.text.len(), |edge| edge.0);
    let body = &source.text[begin.0..after];
    let caption = CAPTION
        .find(body)
        .and_then(|found| braced_group(body, found.end() - 1))
        .map(str::to_string);
    Some(CompoundFloat {
        label: LABEL.captures(body).map(|found| found[1].to_string()),
        ordinal: source
            .edges
            .iter()
            .filter(|edge| edge.1 && edge.2 == environment && edge.0 <= begin.0)
            .count(),
        caption,
        environment,
    })
}

fn directory_of(path: &str) -> &str {
    path.rfind('/').map_or("", |at| &path[..=at])
}

fn normalized(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            ".." => {
                parts.pop();
            }
            "" | "." => {}
            part => parts.push(part),
        }
    }
    parts.join("/")
}

fn stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".tex") {
        name[..name.len() - 4].to_string()
    } else {
        name.to_string()
    }
}

/// The distinct compound keys `text` names, in order.
fn keys_in(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    text.lines()
        .flat_map(compound_keys_on_line)
        .filter(|key| seen.insert(key.clone()))
        .collect()
}

/// Each key drawn in a figure entry, placed by the first float that
/// includes the entry, or by its file when none does (`compoundPlaces`).
/// `sources` are the project's TeX files, project-relative.
pub fn compound_places(sources: &[(String, String)]) -> HashMap<String, CompoundPlace> {
    let scans: Vec<Scanned> = sources.iter().map(|(_, text)| scanned(text)).collect();
    // Every include of every source, by the project path it may name: as
    // written, and beside the source.
    let mut uses: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    for (index, (path, _)) in sources.iter().enumerate() {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for found in INCLUDE.captures_iter(&scans[index].text) {
            let name = match found.get(3) {
                Some(name) => name.as_str().to_string(),
                None => format!("{}/{}", &found[1], &found[2]),
            };
            let file = if name.to_ascii_lowercase().ends_with(".tex") {
                name
            } else {
                format!("{name}.tex")
            };
            let mut targets = vec![normalized(&file)];
            let beside = normalized(&format!("{}{file}", directory_of(path)));
            if beside != targets[0] {
                targets.push(beside);
            }
            let at = found.get(0).map_or(0, |m| m.start());
            for target in targets {
                let count = counts.entry(target.clone()).or_default();
                if *count >= MAX_USES {
                    continue;
                }
                *count += 1;
                uses.entry(target).or_default().push((index, at));
            }
        }
    }
    let mut places: HashMap<String, (CompoundPlace, usize)> = HashMap::new();
    for (path, text) in sources
        .iter()
        .filter(|(_, text)| text.starts_with(FIGURE_ENTRY))
        .take(MAX_ENTRIES)
    {
        let found: Vec<(usize, Option<CompoundFloat>)> = uses
            .get(&normalized(path))
            .map(|list| {
                list.iter()
                    .map(|(index, at)| (*at, float_at(&scans[*index], *at)))
                    .collect()
            })
            .unwrap_or_default();
        let chosen = found
            .iter()
            .find(|(_, float)| float.is_some())
            .or(found.first());
        let place = CompoundPlace {
            file: stem(path),
            float: chosen.and_then(|(_, float)| float.clone()),
        };
        let position = chosen.map_or(usize::MAX, |(at, _)| *at);
        for key in keys_in(text) {
            let better = match places.get(&key) {
                None => true,
                Some((known, known_at)) => {
                    if place.float.is_some() != known.float.is_some() {
                        place.float.is_some()
                    } else {
                        position < *known_at
                    }
                }
            };
            if better {
                places.insert(key, (place.clone(), position));
            }
        }
    }
    places
        .into_iter()
        .map(|(key, (place, _))| (key, place))
        .collect()
}

/// A caption as plain text: compounds as their numbers, markup gone, cut to
/// a short line (`captionLine`).
pub fn caption_line(caption: &str, numbers: &HashMap<String, String>) -> String {
    let scan: String = caption.chars().take(CAPTION_SCAN).collect();
    let line = CAPTION_COMPOUND.replace_all(&scan, |found: &regex::Captures| {
        found[1]
            .split(',')
            .map(|key| {
                let key = key.trim();
                numbers.get(key).cloned().unwrap_or_else(|| key.to_string())
            })
            .collect::<Vec<_>>()
            .join(", ")
    });
    let line = CAPTION_MARK.replace_all(&line, |found: &regex::Captures| {
        let mark = found[1].trim();
        numbers
            .get(numbered_key(mark))
            .cloned()
            .unwrap_or_else(|| mark.to_string())
    });
    let line = CAPTION_DROPPED.replace_all(&line, "");
    let line = CAPTION_COMMAND.replace_all(&line, "");
    let line = CAPTION_PUNCTUATION.replace_all(&line, " ");
    let line = SPACES.replace_all(&line, " ");
    let line = line.trim();
    if line.chars().count() > CAPTION_LENGTH {
        let cut: String = line.chars().take(CAPTION_LENGTH).collect();
        format!("{}…", cut.trim_end())
    } else {
        line.to_string()
    }
}

/// "Scheme 1: Reduction of…" for a compound's place (`placeLine`): the
/// float's number from the last build's labels, else its count among
/// floats of its kind; without a build, the kind and the file's name.
pub fn place_line(
    place: &CompoundPlace,
    labels: Option<&HashMap<String, CompiledLabel>>,
    numbers: &HashMap<String, String>,
) -> String {
    let Some(float) = &place.float else {
        return place.file.clone();
    };
    let mut kind = float.environment.clone();
    if let Some(first) = kind.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    let Some(labels) = labels else {
        return format!("{kind} · {}", place.file);
    };
    let number = float
        .label
        .as_ref()
        .and_then(|label| labels.get(label))
        .map(|label| label.number.clone())
        .filter(|number| !number.is_empty())
        .unwrap_or_else(|| float.ordinal.to_string());
    let head = format!("{kind} {number}");
    match &float.caption {
        Some(caption) => format!("{head}: {}", caption_line(caption, numbers)),
        None => head,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(path: &str, text: &str) -> (String, String) {
        (path.to_string(), text.to_string())
    }

    /// `compound-places.test.ts`'s shape: an editable figure entry names
    /// its keys, a float in the chapter inputs it, and the place is that
    /// float with its label, ordinal and caption.
    #[test]
    fn a_drawn_key_is_placed_by_the_float_that_inputs_its_figure() {
        let sources = [
            source(
                "chapters/results.tex",
                "\\begin{scheme}\\input{figures/first}\\end{scheme}\n\
                 \\begin{scheme}\n\\input{figures/route}\n\\caption{Reduction of \\cmpd{ketone} to the alcohol}\\label{sch:route}\n\\end{scheme}\n",
            ),
            source(
                "chapters/figures/route.tex",
                "% editable-figure source: route.cdxml\n\\cmpd{ketone} \\rcmpd{alcohol.num}\n",
            ),
        ];
        let places = compound_places(&sources);
        let place = &places["ketone"];
        assert_eq!(place.file, "route");
        let float = place.float.as_ref().expect("in a scheme");
        assert_eq!(float.environment, "scheme");
        assert_eq!(float.ordinal, 2);
        assert_eq!(float.label.as_deref(), Some("sch:route"));
        assert!(places.contains_key("alcohol.num"));
        let numbers = HashMap::from([("ketone".to_string(), "1".to_string())]);
        let labels = HashMap::from([(
            "sch:route".to_string(),
            CompiledLabel {
                number: "3".into(),
                page: "4".into(),
            },
        )]);
        assert_eq!(
            place_line(place, Some(&labels), &numbers),
            "Scheme 3: Reduction of 1 to the alcohol"
        );
        assert_eq!(place_line(place, None, &numbers), "Scheme · route");
        // Without its label numbered, its ordinal.
        assert_eq!(
            place_line(place, Some(&HashMap::new()), &numbers),
            "Scheme 2: Reduction of 1 to the alcohol"
        );
    }

    #[test]
    fn a_figure_no_float_inputs_is_placed_by_its_file() {
        let sources = [source(
            "fig.tex",
            "% editable-figure source: fig.cdxml\n\\cmpd{a}\n",
        )];
        let places = compound_places(&sources);
        assert_eq!(places["a"].float, None);
        assert_eq!(place_line(&places["a"], None, &HashMap::new()), "fig");
    }

    #[test]
    fn a_caption_reads_as_a_short_plain_line() {
        let numbers = HashMap::from([
            ("a".to_string(), "1".to_string()),
            ("b.x".to_string(), "2a".to_string()),
        ]);
        assert_eq!(
            caption_line(
                "Synthesis of \\cmpd{a, c} and \\rcmpd{b.x.num}\\label{f}~\\cite{k}",
                &numbers
            ),
            "Synthesis of 1, c and 2a"
        );
        let long = "word ".repeat(20);
        let line = caption_line(&long, &numbers);
        assert!(line.ends_with('…') && line.chars().count() <= CAPTION_LENGTH + 1);
    }

    #[test]
    fn comments_are_blanked_in_place() {
        assert_eq!(without_comments("a % b\n50\\% c\n"), "a    \n50\\% c\n");
        assert_eq!(braced_group("{a{b}\\}c}d", 0), Some("a{b}\\}c"));
        assert_eq!(braced_group("{open", 0), None);
    }
}
