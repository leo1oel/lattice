//! The TeX side of a journal export: a file read before the document that
//! boxes each editable figure's entry file, records which float (Scheme 1,
//! Figure 2) holds it, and, after the paper's last page, ships each box again
//! as a page of its own, sized to the box. Those pages hold nothing but the
//! figure, at its own size even where the paper scales it (`\resizebox`), so
//! the export takes them as they are. Nothing in the project changes: the run
//! writes to a scratch folder.

use std::collections::BTreeMap;

/// A figure as the export run boxed it, in TeX points.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Placed {
    /// 1-based, in the order the document read the entries; figure `n` of
    /// `count` is page `pages - count + n` of the PDF.
    pub index: u32,
    /// The float that holds it, numbered from 1 in the order floats begin; 0 for none.
    pub float: u32,
    /// The float type it is in (`figure`, `scheme`, …), or `none`.
    pub kind: String,
    /// The entry file as TeX opened it: the folder as written in `\input`, and the file name.
    pub folder: String,
    pub file: String,
    pub width: f64,
    pub height: f64,
    pub depth: f64,
}

impl Placed {
    /// The entry as the document named it, `figures/scheme.tex`.
    pub fn path(&self) -> String {
        let folder = self.folder.trim_end_matches('/');
        if folder.is_empty() {
            self.file.clone()
        } else {
            format!("{folder}/{}", self.file)
        }
    }
}

/// What a run recorded: the figures in the order it read them, and each
/// captioned float's number as the document prints it (`\thefigure`).
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Record {
    pub figures: Vec<Placed>,
    pub numbers: BTreeMap<u32, String>,
    /// How many pages of figures follow the paper's own, the last of the PDF.
    pub shipped: u32,
}

/// The hook, for entry files named `entries` (`scheme.tex`). It writes
/// `\jobname.figures` beside the PDF, the one folder TeX writes to here.
///
/// A float's number is taken when its box closes, after its `\caption`, as
/// `\the<type>` prints it, so `1.1`, `S1` and `IV` stay apart. Each entry's box
/// is copied before it goes into the paper; after the last page the copies are
/// shipped with `\RawShipout`, so no page hook (a header, a watermark, a
/// background) draws on them, one page each, the page as large as the box with
/// a 1 pt margin.
pub(super) fn hook(entries: &[String]) -> String {
    let list: Vec<String> = entries
        .iter()
        .map(|name| name.chars().filter(|c| !"{}\\%#\r\n,;".contains(*c)).collect())
        .collect();
    let list = list.join(",");
    format!(
        r"% Lattice: the journal export's record of figures, read before the document
\makeatletter
\newcount\ljx@depth \global\ljx@depth=0
\newcount\ljx@open \global\ljx@open=-1000
\newcount\ljx@index \global\ljx@index=0
\newcount\ljx@floats \global\ljx@floats=0
\newcount\ljx@n
\newbox\ljx@box
\newwrite\ljx@out
\immediate\openout\ljx@out=\jobname.figures
\edef\ljx@list{{\detokenize{{,{list},}}}}
\def\ljx@fid{{0}}
\AtBeginDocument{{%
  \let\ljx@xfloat\@xfloat
  \def\@xfloat#1{{%
    \global\advance\ljx@floats\@ne
    \edef\ljx@fid{{\the\ljx@floats}}%
    \edef\ljx@fstart{{\ifcsname c@#1\endcsname\the\value{{#1}}\else 0\fi}}%
    \ljx@xfloat{{#1}}}}%
  \let\ljx@endfloatbox\@endfloatbox
  \def\@endfloatbox{{\ljx@floatend\ljx@endfloatbox}}%
}}
\def\ljx@floatend{{%
  \ifnum\ljx@fid>\z@
    \ifcsname c@\@captype\endcsname
      \ifnum\value{{\@captype}}>\ljx@fstart\relax
        \protected@edef\ljx@num{{\csname the\@captype\endcsname}}%
        \immediate\write\ljx@out{{float;\ljx@fid;\@captype;\detokenize\expandafter{{\ljx@num}}}}%
      \fi
    \fi
  \fi}}
\AddToHook{{file/before}}{{%
  \global\advance\ljx@depth\@ne
  \ifnum\ljx@open=-1000
    \edef\ljx@cur{{\noexpand\in@{{,\detokenize\expandafter{{\CurrentFile}},}}{{\ljx@list}}}}%
    \ljx@cur
    \ifin@
      \global\ljx@open=\ljx@depth
      \xdef\ljx@file{{\detokenize\expandafter{{\CurrentFile}}}}%
      \xdef\ljx@folder{{\detokenize\expandafter{{\CurrentFilePath}}}}%
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
  \immediate\write\ljx@out{{fig;\the\ljx@index;\ljx@fid;\ljx@type;\ljx@folder;\ljx@file;\the\wd\ljx@box;\the\ht\ljx@box;\the\dp\ljx@box}}%
  \expandafter\newbox\csname ljx@fig\the\ljx@index\endcsname
  \global\setbox\csname ljx@fig\the\ljx@index\endcsname\copy\ljx@box
  \box\ljx@box}}
\def\ljx@ship{{%
  \begingroup
  \setbox\z@\hbox{{\kern\p@\vbox{{\kern\p@\box\csname ljx@fig\the\ljx@n\endcsname\kern\p@}}\kern\p@}}%
  \hoffset-1in \voffset-1in
  \ifdefined\pdfpagewidth \pdfpagewidth\wd\z@ \pdfpageheight\ht\z@ \fi
  \ifdefined\pagewidth \pagewidth\wd\z@ \pageheight\ht\z@ \fi
  \ifdefined\XeTeXversion
    \setbox\z@\hbox{{\special{{pdf:pagesize width \the\wd\z@\space height \the\ht\z@}}\box\z@}}%
  \fi
  \RawShipout\box\z@
  \endgroup}}
\AddToHook{{enddocument/afterlastpage}}{{%
  \ljx@n=\z@
  \loop\ifnum\ljx@n<\ljx@index
    \advance\ljx@n\@ne
    \ljx@ship
  \repeat
  \immediate\write\ljx@out{{shipped;\the\ljx@index}}}}
\makeatother
"
    )
}

fn points(value: &str) -> Option<f64> {
    value.trim().trim_end_matches("pt").parse().ok().filter(|v: &f64| v.is_finite())
}

/// What a run recorded. A line that does not read as the hook writes it is
/// skipped: the document can write to the same file.
pub(super) fn parse(text: &str) -> Record {
    let mut record = Record::default();
    for line in text.lines() {
        let parts: Vec<&str> = line.split(';').collect();
        match parts.as_slice() {
            ["fig", index, float, kind, folder, file, wd, ht, dp] => {
                let figure = (|| {
                    Some(Placed {
                        index: index.trim().parse().ok().filter(|index| *index > 0)?,
                        float: float.trim().parse().ok()?,
                        kind: kind.trim().to_string(),
                        folder: folder.trim().to_string(),
                        file: file.trim().to_string(),
                        width: points(wd)?,
                        height: points(ht)?,
                        depth: points(dp)?,
                    })
                })();
                if let Some(figure) = figure.filter(|figure| figure.width > 0.0) {
                    record.figures.push(figure);
                }
            }
            ["float", float, _kind, number] => {
                if let Ok(float) = float.trim().parse::<u32>() {
                    record.numbers.insert(float, number.trim().to_string());
                }
            }
            ["shipped", count] => record.shipped = count.trim().parse().unwrap_or(0),
            _ => {}
        }
    }
    record
}

/// A float's number as a file name takes it: `1.1` → `1-1`, `S1` → `S1`.
fn number_for_name(number: &str) -> String {
    let mut name = String::new();
    for c in number.chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c);
        } else if !name.is_empty() && !name.ends_with('-') {
            name.push('-');
        }
    }
    name.trim_end_matches('-').chars().take(32).collect()
}

/// File names a journal expects, by function and as the paper numbers them:
/// `Scheme1`, `Figure2`, `Figure1-1`, `FigureS1`. Figures that share one float
/// are `Scheme1a` and `Scheme1b`. A figure in no captioned float keeps its
/// entry's name. Any name still taken (two `scheme.tex` in different folders)
/// gets `-2`, `-3`, compared without case, as macOS compares file names.
pub(super) fn submission_names(record: &Record) -> Vec<String> {
    let figures = &record.figures;
    let base: Vec<String> = figures
        .iter()
        .map(|figure| {
            let kind = match figure.kind.trim_end_matches('*') {
                "figure" => "Figure",
                "scheme" => "Scheme",
                "chart" => "Chart",
                "graph" => "Graph",
                "table" => "Table",
                _ => return file_stem(&figure.file),
            };
            match record.numbers.get(&figure.float).map(|number| number_for_name(number)) {
                Some(number) if figure.float > 0 && !number.is_empty() => format!("{kind}{number}"),
                _ => file_stem(&figure.file),
            }
        })
        .collect();
    let mut lettered = Vec::with_capacity(base.len());
    let mut letters = BTreeMap::<u32, u8>::new();
    for (figure, name) in figures.iter().zip(&base) {
        let shared = figure.float > 0
            && figures.iter().filter(|other| other.float == figure.float).count() > 1;
        if shared && record.numbers.contains_key(&figure.float) {
            let n = letters.entry(figure.float).or_insert(0);
            lettered.push(format!("{name}{}", char::from(b'a' + (*n).min(25))));
            *n += 1;
        } else {
            lettered.push(name.clone());
        }
    }
    let mut taken = std::collections::BTreeSet::new();
    lettered
        .into_iter()
        .map(|name| {
            let mut unique = name.clone();
            let mut n = 1;
            while !taken.insert(unique.to_ascii_lowercase()) {
                n += 1;
                unique = format!("{name}-{n}");
            }
            unique
        })
        .collect()
}

/// A figure in no float is named after its entry file. The record is a file
/// the document's own run writes, which the document could write to as well,
/// so the name is cut to a plain file name: never a path, never hidden.
fn file_stem(file: &str) -> String {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
    let stem: String = base
        .trim_end_matches(".tex")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        .take(64)
        .collect();
    if stem.is_empty() {
        "figure".to_string()
    } else {
        stem
    }
}
