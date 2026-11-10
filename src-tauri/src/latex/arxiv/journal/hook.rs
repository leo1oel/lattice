//! The TeX side of a journal export: a file read before the document that
//! boxes each editable figure's entry file, records where that box lands in
//! the PDF and which float (Scheme 1, Figure 2) holds it, and the reading of
//! that record. Nothing in the project changes: the run writes to a scratch
//! folder.

/// A figure as the export run placed it: its float and its box on a page, in
/// TeX points.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Placed {
    /// The float type it is in (`figure`, `scheme`, …), or `none`.
    pub kind: String,
    /// The float's number, if it has a caption.
    pub number: u32,
    /// The entry file's name, as TeX opened it.
    pub file: String,
    /// 1-based page of the PDF.
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub depth: f64,
}

const SP_PER_PT: f64 = 65536.0;

/// The hook, for entry files named `entries` (`scheme.tex`). It writes
/// `\jobname.figures` beside the PDF, the one folder TeX writes to here.
pub(super) fn hook(entries: &[String]) -> String {
    let list: Vec<String> = entries
        .iter()
        .map(|name| name.chars().filter(|c| !"{}\\%#\r\n,".contains(*c)).collect())
        .collect();
    let list = list.join(",");
    format!(
        r"% Lattice: the journal export's record of figures, read before the document
\makeatletter
\newcount\ljx@depth \global\ljx@depth=0
\newcount\ljx@open \global\ljx@open=-1000
\newcount\ljx@index \global\ljx@index=0
\newcount\ljx@page \global\ljx@page=0
\newbox\ljx@box
\newwrite\ljx@out
\immediate\openout\ljx@out=\jobname.figures
\edef\ljx@list{{\detokenize{{,{list},}}}}
\xdef\ljx@start{{0}}
\ifdefined\pdfsavepos\else\ifdefined\savepos
  \let\pdfsavepos\savepos \let\pdflastxpos\lastxpos \let\pdflastypos\lastypos
\fi\fi
\AddToHook{{shipout/before}}{{\global\advance\ljx@page\@ne}}
\AtBeginDocument{{%
  \let\ljx@xfloat\@xfloat
  \def\@xfloat#1{{\xdef\ljx@start{{\ifcsname c@#1\endcsname\the\value{{#1}}\else 0\fi}}\ljx@xfloat{{#1}}}}%
}}
\AddToHook{{file/before}}{{%
  \global\advance\ljx@depth\@ne
  \ifnum\ljx@open=-1000
    \edef\ljx@cur{{\noexpand\in@{{,\detokenize\expandafter{{\CurrentFile}},}}{{\ljx@list}}}}%
    \ljx@cur
    \ifin@
      \global\ljx@open=\ljx@depth
      \xdef\ljx@file{{\detokenize\expandafter{{\CurrentFile}}}}%
      \leavevmode\setbox\ljx@box\hbox\bgroup
    \fi
  \fi}}
\AddToHook{{file/after}}{{%
  \ifnum\ljx@open=\ljx@depth
    \egroup
    \global\ljx@open=-1000
    \ljx@emit
  \fi
  \global\advance\ljx@depth\m@ne}}
\def\ljx@emit{{%
  \global\advance\ljx@index\@ne
  \edef\ljx@type{{\ifx\@captype\@undefined none\else\@captype\fi}}%
  \edef\ljx@do{{\write\ljx@out{{fig;\the\ljx@index;\ljx@type;\ljx@start;\ljx@file;\the\wd\ljx@box;\the\ht\ljx@box;\the\dp\ljx@box;\noexpand\the\ljx@page;\noexpand\the\pdflastxpos;\noexpand\the\pdflastypos}}}}%
  \pdfsavepos\ljx@do\box\ljx@box}}
\makeatother
"
    )
}

fn points(value: &str) -> Option<f64> {
    value.trim().trim_end_matches("pt").parse().ok().filter(|v: &f64| v.is_finite())
}

/// The figures a run recorded, in the order the document placed them.
pub(super) fn parse(text: &str) -> Vec<Placed> {
    text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(';').collect();
            let [tag, _, kind, start, file, wd, ht, dp, page, x, y] = parts.as_slice() else {
                return None;
            };
            if *tag != "fig" {
                return None;
            }
            let placed = Placed {
                kind: kind.trim().to_string(),
                number: start.trim().parse::<u32>().ok()?.checked_add(1)?,
                file: file.trim().to_string(),
                page: page.trim().parse().ok()?,
                x: x.trim().parse::<f64>().ok()? / SP_PER_PT,
                y: y.trim().parse::<f64>().ok()? / SP_PER_PT,
                width: points(wd)?,
                height: points(ht)?,
                depth: points(dp)?,
            };
            (placed.width > 0.0 && placed.page > 0).then_some(placed)
        })
        .collect()
}

/// File names a journal expects, by function: `Scheme1`, `Figure2`; two
/// figures in one float are `Scheme1a` and `Scheme1b`. A figure in no float
/// keeps its entry's name.
pub(super) fn submission_names(figures: &[Placed]) -> Vec<String> {
    let base: Vec<String> = figures
        .iter()
        .map(|figure| {
            let kind = match figure.kind.trim_end_matches('*') {
                "figure" => "Figure",
                "scheme" => "Scheme",
                "chart" => "Chart",
                "graph" => "Graph",
                "table" => "Table",
                _ => return figure.file.trim_end_matches(".tex").to_string(),
            };
            format!("{kind}{}", figure.number)
        })
        .collect();
    let mut seen = std::collections::BTreeMap::<&str, u8>::new();
    base.iter()
        .map(|name| {
            if base.iter().filter(|other| *other == name).count() < 2 {
                return name.clone();
            }
            let n = seen.entry(name).or_insert(0);
            let letter = char::from(b'a' + (*n).min(25));
            *n += 1;
            format!("{name}{letter}")
        })
        .collect()
}

/// The box on its page in PDF points (1/72 in), with a 1 pt margin: TeX's
/// points are 1/72.27 in.
pub(super) fn crop_box(figure: &Placed) -> [f64; 4] {
    let bp = |pt: f64| pt * 72.0 / 72.27;
    [
        bp(figure.x) - 1.0,
        bp(figure.y - figure.depth) - 1.0,
        bp(figure.x + figure.width) + 1.0,
        bp(figure.y + figure.height) + 1.0,
    ]
}
