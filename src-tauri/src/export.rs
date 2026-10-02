//! Saving a file the writer exports (the compiled PDF, an Excel workbook) to
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

const MAX_XLSX_BYTES: usize = 100 * 1024 * 1024;

fn validate_pdf(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a valid PDF.".to_string());
    }
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
}
