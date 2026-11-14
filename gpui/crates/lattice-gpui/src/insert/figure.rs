//! What inserting figures writes (`figure-insertion.ts`): a LaTeX `figure`
//! block per image, or a Markdown image (or link) per file, each set off
//! from the text around it by a blank line, and where the caret lands after.

/// The figure block's options (`FigureInsertOptions`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FigureOptions {
    pub width: String,
    pub placement: String,
    pub caption: String,
    /// The first figure's label; the default derives one from the file.
    pub label: Option<String>,
}

/// The caption a figure gets until the writer gives one.
pub const DEFAULT_CAPTION: &str = "Describe the figure.";

impl Default for FigureOptions {
    fn default() -> Self {
        Self {
            width: "\\linewidth".into(),
            placement: "t".into(),
            caption: DEFAULT_CAPTION.into(),
            label: None,
        }
    }
}

/// Text to insert at a position, and where the caret goes in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Insertion {
    pub text: String,
    pub cursor: usize,
}

/// `blocks` with the blank lines that set them off from `source` at
/// `position` (`blockInsertionText`).
fn block_insertion(source: &str, position: usize, blocks: &str) -> String {
    let (before, after) = source.split_at(position.min(source.len()));
    let prefix = if before.is_empty() || before.ends_with("\n\n") {
        ""
    } else if before.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    let suffix = if after.is_empty() {
        "\n"
    } else if after.starts_with("\n\n") {
        ""
    } else if after.starts_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    format!("{prefix}{blocks}{suffix}")
}

/// A label from the file's name: lowercase, runs of anything else dashed,
/// a converted copy's suffix dropped (`figureLabelFromPath`).
fn label_from_path(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or("figure");
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    };
    let stem = stem.strip_suffix("-converted").unwrap_or(stem);
    let mut label = String::new();
    for c in stem.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            label.push(c);
        } else if !label.ends_with('-') {
            label.push('-');
        }
    }
    let label = label.trim_matches('-');
    if label.is_empty() {
        "figure".into()
    } else {
        label.into()
    }
}

/// A `figure` block for each of `paths` at `position`
/// (`latexFigureInsertion`): the caret lands after the caption.
pub fn latex_figures(
    source: &str,
    position: usize,
    paths: &[String],
    options: &FigureOptions,
) -> Insertion {
    let pick = |value: &str, fallback: &str| {
        let value = value.trim();
        if value.is_empty() {
            fallback.to_string()
        } else {
            value.to_string()
        }
    };
    let width = pick(&options.width, "\\linewidth");
    let placement = pick(&options.placement, "t");
    let caption = pick(&options.caption, DEFAULT_CAPTION);
    let blocks = paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let path = path.replace('\\', "/");
            let base = options
                .label
                .as_deref()
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("fig:{}", label_from_path(&path)));
            let label = if index > 0 {
                format!("{base}-{}", index + 1)
            } else {
                base
            };
            [
                format!("\\begin{{figure}}[{placement}]"),
                "  \\centering".into(),
                format!("  \\includegraphics[width={width}]{{\\detokenize{{{path}}}}}"),
                format!("  \\caption{{{caption}}}"),
                format!("  \\label{{{label}}}"),
                "\\end{figure}".into(),
            ]
            .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let text = block_insertion(source, position, &blocks);
    let cursor = text
        .find(&caption)
        .map_or(text.len(), |at| at + caption.len());
    Insertion { text, cursor }
}

/// `target` (project-relative) as a path from `from`'s folder
/// (`projectRelativePath`).
pub fn relative_to(from: &str, target: &str) -> String {
    let from = from.replace('\\', "/");
    let target = target.replace('\\', "/");
    let mut from: Vec<&str> = from.split('/').filter(|part| !part.is_empty()).collect();
    let mut target: Vec<&str> = target.split('/').filter(|part| !part.is_empty()).collect();
    from.pop();
    while !from.is_empty() && !target.is_empty() && from[0] == target[0] {
        from.remove(0);
        target.remove(0);
    }
    let parts: Vec<&str> = from.iter().map(|_| "..").chain(target).collect();
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

const MARKDOWN_IMAGES: [&str; 5] = ["png", "jpg", "jpeg", "svg", "webp"];

/// An image (or, for another file, a link) for each of `paths` in the
/// Markdown file `markdown` at `position` (`markdownAssetInsertion`): the
/// caret lands after them.
pub fn markdown_assets(
    source: &str,
    position: usize,
    paths: &[String],
    markdown: &str,
) -> Insertion {
    let blocks = paths
        .iter()
        .map(|path| {
            let path = path.replace('\\', "/");
            let name = path.rsplit('/').next().unwrap_or("asset").to_string();
            let destination = relative_to(markdown, &path);
            let extension = name.rsplit_once('.').map(|(_, ext)| ext.to_lowercase());
            if !extension.is_some_and(|ext| MARKDOWN_IMAGES.contains(&ext.as_str())) {
                return format!("[{name}](<{destination}>)");
            }
            let stem = match name.rfind('.') {
                Some(dot) if dot > 0 => &name[..dot],
                _ => name.as_str(),
            };
            // `replace(/[-_]+/g, " ")`: each run of dashes and underscores
            // becomes one space.
            let mut label = String::new();
            let mut in_run = false;
            for c in stem.chars() {
                if c == '-' || c == '_' {
                    if !in_run {
                        label.push(' ');
                    }
                    in_run = true;
                } else {
                    label.push(c);
                    in_run = false;
                }
            }
            let label = label.trim();
            let label = if label.is_empty() { "asset" } else { label };
            format!("![{label}](<{destination}>)")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let text = block_insertion(source, position, &blocks);
    let cursor = text.len();
    Insertion { text, cursor }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn a_figure_block_is_set_off_by_blank_lines_and_the_caret_lands_after_its_caption() {
        let source = "Intro.\nMore.";
        let edit = latex_figures(
            source,
            7,
            &paths(&["figures/My Plot-converted.pdf"]),
            &FigureOptions::default(),
        );
        assert_eq!(
            edit.text,
            "\n\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{\\detokenize{figures/My Plot-converted.pdf}}\n  \\caption{Describe the figure.}\n  \\label{fig:my-plot}\n\\end{figure}\n\n"
        );
        // The Tauri app's latexFigureInsertion gives the same text, its
        // cursorOffset 144: just after the caption.
        assert_eq!(edit.cursor, 144);
    }

    #[test]
    fn several_figures_number_their_labels_after_the_first() {
        let options = FigureOptions {
            width: " 0.5\\linewidth ".into(),
            placement: "".into(),
            caption: "Results".into(),
            label: Some("fig:results".into()),
        };
        let edit = latex_figures("", 0, &paths(&["a.png", "b.png"]), &options);
        assert!(edit.text.starts_with("\\begin{figure}[t]"));
        assert!(edit.text.contains("[width=0.5\\linewidth]"));
        assert!(edit.text.contains("\\label{fig:results}\n"));
        assert!(edit.text.contains("\\label{fig:results-2}\n"));
        assert!(edit.text.ends_with("\\end{figure}\n"));
        assert_eq!(edit.cursor, 109);
    }

    #[test]
    fn a_markdown_file_links_its_assets_relative_to_itself() {
        let edit = markdown_assets(
            "# Notes\n",
            8,
            &paths(&["figures/loss_curve-v2.png", "data/table.csv"]),
            "notes/week1.md",
        );
        assert_eq!(
            edit.text,
            "\n![loss curve v2](<../figures/loss_curve-v2.png>)\n\n[table.csv](<../data/table.csv>)\n"
        );
        assert_eq!(relative_to("README.md", "figures/a.png"), "figures/a.png");
        assert_eq!(relative_to("notes/a.md", "notes/b.png"), "b.png");
    }
}
