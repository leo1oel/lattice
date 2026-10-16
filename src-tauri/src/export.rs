//! Saving a file the writer exports (the compiled PDF, an Excel workbook, an
//! Agent visual's HTML, a copy of a file that could not be saved in place) to
//! the path they chose. A path without an extension gains the format's own,
//! any other extension is refused, and the bytes must be that format.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

pub(crate) struct Format {
    extension: &'static str,
    /// The refusal for an empty path.
    no_destination: &'static str,
    /// The refusal for a path with another format's extension.
    wrong_extension: &'static str,
    validate: fn(&[u8]) -> Result<(), String>,
}

pub(crate) const PDF: Format = Format {
    extension: "pdf",
    no_destination: "Choose where to save the PDF.",
    wrong_extension: "The exported paper must use the .pdf extension.",
    validate: validate_pdf,
};

pub(crate) const XLSX: Format = Format {
    extension: "xlsx",
    no_destination: "Choose where to export the Excel workbook.",
    wrong_extension: "The exported workbook must use the .xlsx extension.",
    validate: validate_xlsx,
};

pub(crate) const HTML: Format = Format {
    extension: "html",
    no_destination: "Choose where to save the visual.",
    wrong_extension: "The saved visual must use the .html extension.",
    validate: validate_html,
};

const MAX_XLSX_BYTES: usize = 100 * 1024 * 1024;
/// The bundled agent runtime refuses a visual's source above this.
const MAX_HTML_BYTES: usize = 256 * 1024;

fn validate_pdf(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a valid PDF.".to_string());
    }
    Ok(())
}

fn validate_html(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_HTML_BYTES {
        return Err("The visual is too large to save.".to_string());
    }
    std::str::from_utf8(bytes).map_err(|_| "The visual is not UTF-8 text.".to_string())?;
    Ok(())
}

fn validate_xlsx(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_XLSX_BYTES {
        return Err("The Excel workbook is too large to export.".to_string());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "The exported data is not a valid Excel workbook.".to_string())?;
    for required in ["[Content_Types].xml", "xl/workbook.xml"] {
        archive
            .by_name(required)
            .map_err(|_| "The exported data is not a valid Excel workbook.".to_string())?;
    }
    Ok(())
}

/// Where a file of `format` saved to `path` is written.
pub(crate) fn destination(path: &Path, format: &Format) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err(format.no_destination.to_string());
    }
    match path.extension().and_then(|extension| extension.to_str()) {
        None => Ok(path.with_extension(format.extension)),
        Some(extension) if extension.eq_ignore_ascii_case(format.extension) => {
            Ok(path.to_path_buf())
        }
        Some(_) => Err(format.wrong_extension.to_string()),
    }
}

/// Write `bytes` of `format` to `path`; returns where they went.
pub fn save(path: &Path, bytes: &[u8], format: &Format) -> Result<String, String> {
    let destination = destination(path, format)?;
    (format.validate)(bytes)?;
    fs::write(&destination, bytes).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}

/// The names a copy of an open file may take: the text the editor saves,
/// never something that runs.
const TEXT_COPY_EXTENSIONS: [&str; 12] =
    ["tex", "bib", "md", "txt", "sty", "cls", "bst", "bbx", "cbx", "ltx", "csv", "tsv"];
const MAX_TEXT_COPY_BYTES: usize = 64 * 1024 * 1024;

/// A copy of the open file the writer could not save in place (a full disk, a
/// project folder that went away), written where they chose. UTF-8 text only,
/// under a text file's name; a name without an extension becomes `.txt`.
pub fn save_text_copy(path: &Path, bytes: &[u8]) -> Result<String, String> {
    if path.as_os_str().is_empty() {
        return Err("Choose where to save the copy.".to_string());
    }
    let destination = match path.extension().and_then(|extension| extension.to_str()) {
        None => path.with_extension("txt"),
        Some(extension)
            if TEXT_COPY_EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(extension)) =>
        {
            path.to_path_buf()
        }
        Some(_) => {
            return Err(
                "A copy must keep a text file's extension, such as .tex or .txt.".to_string()
            )
        }
    };
    if bytes.len() > MAX_TEXT_COPY_BYTES {
        return Err("The text is too large to save as a copy.".to_string());
    }
    std::str::from_utf8(bytes).map_err(|_| "The copy is not UTF-8 text.".to_string())?;
    fs::write(&destination, bytes).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn test_workbook() -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut archive = ZipWriter::new(Cursor::new(&mut bytes));
        for (name, contents) in
            [("[Content_Types].xml", "<Types/>"), ("xl/workbook.xml", "<workbook/>")]
        {
            archive.start_file(name, SimpleFileOptions::default()).unwrap();
            archive.write_all(contents.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
        bytes
    }

    #[test]
    fn saves_a_compiled_pdf_to_the_chosen_path() {
        let directory = TempDir::new("latex");
        let bytes = b"%PDF-1.7\ntest";
        let destination = save(&directory.join("paper"), bytes, &PDF).unwrap();
        assert_eq!(Path::new(&destination).extension().unwrap(), "pdf");
        assert_eq!(fs::read(destination).unwrap(), b"%PDF-1.7\ntest");
        assert!(save(&directory.join("paper.txt"), bytes, &PDF).is_err());
        assert!(save(&directory.join("other.pdf"), b"not a pdf", &PDF).is_err());
        assert!(!directory.join("other.pdf").exists());
    }

    #[test]
    fn saves_only_valid_workbooks_under_an_xlsx_name() {
        let directory = TempDir::new("xlsx-export");
        let bytes = test_workbook();
        let destination = save(&directory.join("results"), &bytes, &XLSX).unwrap();
        assert_eq!(Path::new(&destination).extension().unwrap(), "xlsx");
        assert_eq!(fs::read(&destination).unwrap(), bytes);

        assert!(save(&directory.join("other.csv"), &bytes, &XLSX).is_err());
        assert!(save(&directory.join("other.xlsx"), b"PK not a workbook", &XLSX).is_err());
        assert!(!directory.join("other.xlsx").exists());
    }

    #[test]
    fn saves_a_text_copy_only_under_a_text_name() {
        let directory = TempDir::new("text-copy");
        let text = "\\section{Intro}\n".as_bytes();
        let destination = save_text_copy(&directory.join("main.tex"), text).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), text);
        let bare = save_text_copy(&directory.join("notes"), text).unwrap();
        assert_eq!(Path::new(&bare).extension().unwrap(), "txt");

        assert!(save_text_copy(&directory.join("run.sh"), text).is_err());
        assert!(save_text_copy(&directory.join("other.tex"), &[0xff, 0xfe]).is_err());
        assert!(!directory.join("run.sh").exists());
        assert!(!directory.join("other.tex").exists());
    }
}
