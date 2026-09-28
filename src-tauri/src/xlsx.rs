use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

const MAX_XLSX_BYTES: usize = 100 * 1024 * 1024;

fn xlsx_destination(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("Choose where to export the Excel workbook.".to_string());
    }
    match path.extension().and_then(|extension| extension.to_str()) {
        None => Ok(path.with_extension("xlsx")),
        Some(extension) if extension.eq_ignore_ascii_case("xlsx") => Ok(path.to_path_buf()),
        Some(_) => Err("The exported workbook must use the .xlsx extension.".to_string()),
    }
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

pub fn save_xlsx(path: &Path, bytes: &[u8]) -> Result<String, String> {
    let destination = xlsx_destination(path)?;
    validate_xlsx(bytes)?;
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
    fn saves_a_valid_workbook_and_adds_the_extension() {
        let directory = TempDir::new("xlsx-export");
        let bytes = test_workbook();

        let destination = save_xlsx(&directory.join("results"), &bytes).unwrap();

        assert_eq!(Path::new(&destination).extension().unwrap(), "xlsx");
        assert_eq!(fs::read(&destination).unwrap(), bytes);
    }

    #[test]
    fn rejects_wrong_extensions_and_non_excel_archives() {
        let directory = TempDir::new("xlsx-export-invalid");

        assert!(save_xlsx(&directory.join("results.csv"), &test_workbook()).is_err());
        assert!(save_xlsx(&directory.join("results.xlsx"), b"PK not a workbook").is_err());
        assert!(!directory.join("results.xlsx").exists());
    }
}
