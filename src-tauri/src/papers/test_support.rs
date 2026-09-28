//! Fixtures shared by the papers tests.

use super::bundle::PaperMetadata;
use crate::project;
use crate::test_support::TempDir;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;

/// A new project whose primary bibliography holds `bibliography`. Its scratch
/// parent directory doubles as a place for fixture tools.
pub(super) struct TestProject {
    pub(super) root: PathBuf,
    pub(super) parent: TempDir,
}

impl TestProject {
    pub(super) fn new(bibliography: &str) -> Self {
        let parent = TempDir::new("papers");
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("references.bib"), bibliography).unwrap();
        Self { root, parent }
    }

    /// Write a project file, creating its directories; returns its path.
    pub(super) fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }

    pub(super) fn bibliography(&self) -> String {
        fs::read_to_string(self.root.join("references.bib")).unwrap()
    }

    /// A complete bundle under `metadata`'s key: `markdown` as its paper, an
    /// empty asset manifest, and the metadata itself.
    pub(super) fn write_bundle(&self, markdown: &str, metadata: &PaperMetadata) {
        let dir = format!(".research/papers/{}", metadata.arxiv_id);
        self.write(&format!("{dir}/paper.md"), markdown);
        self.write(
            &format!("{dir}/paper_assets/manifest.json"),
            r#"{"schema_version":1,"assets":[]}"#,
        );
        self.write(&format!("{dir}/metadata.json"), &serde_json::to_string(metadata).unwrap());
    }
}

/// Tool binary overrides are process-wide environment variables. Serialize
/// the tests that invoke bibcite with the ones that replace it with a fixture
/// binary, or parallel test execution can edit an unrelated bibliography
/// through a fixture's deliberately narrow CLI contract.
static TOOL_OVERRIDE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn tool_lock() -> MutexGuard<'static, ()> {
    TOOL_OVERRIDE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs `tool` from `path` instead of uvx until dropped.
#[cfg(unix)]
pub(super) struct ToolOverride {
    name: &'static str,
    previous: Option<std::ffi::OsString>,
}

#[cfg(unix)]
impl ToolOverride {
    pub(super) fn set(tool: &crate::commands::UvTool, path: &Path) -> Self {
        let previous = std::env::var_os(tool.override_env);
        std::env::set_var(tool.override_env, path);
        Self { name: tool.override_env, previous }
    }
}

#[cfg(unix)]
impl Drop for ToolOverride {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.name, value),
            None => std::env::remove_var(self.name),
        }
    }
}

#[cfg(unix)]
pub(super) fn write_test_tool(path: &Path, contents: &str) {
    use std::os::unix::fs::PermissionsExt;
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// `bibcite` is an integration boundary, not the behavior under test in the
/// project-transaction cases. Keep those tests hermetic while preserving the
/// exact add/remove/tidy command shapes production uses.
#[cfg(unix)]
pub(super) fn fake_bibcite(parent: &Path) -> PathBuf {
    let path = parent.join("fake-bibcite");
    write_test_tool(
        &path,
        concat!(
            "#!/bin/sh\n",
            "set -eu\n",
            "case \"$1\" in\n",
            "  add)\n",
            "    cat >> \"$3\" <<'BIB'\n",
            "@article{stub2024,\n",
            "  title = {A Paper Without A Rendering},\n",
            "  eprint = {2401.99999},\n",
            "  doi = {10.1234/example},\n",
            "}\n",
            "BIB\n",
            "    printf '{\"key\": \"stub2024\"}\\n'\n",
            "    ;;\n",
            // Fixture entries sit on one line, so dropping the entry is
            // dropping the line that opens it.
            "  remove)\n",
            "    grep -iv \"^@[a-z]*{$4,\" \"$3\" > \"$3.tmp\" || true\n",
            "    mv \"$3.tmp\" \"$3\"\n",
            "    printf '{\"key\": \"%s\"}\\n' \"$4\"\n",
            "    ;;\n",
            "  tidy) ;;\n",
            "  *) exit 2 ;;\n",
            "esac\n",
        ),
    );
    path
}

/// A bibcite that accepts only `add --no-tidy <file> --bibtex <entry>` and
/// writes the supplied entry back verbatim.
#[cfg(unix)]
pub(super) fn fake_raw_bibcite(parent: &Path) -> PathBuf {
    let path = parent.join("bibcite-raw");
    write_test_tool(
        &path,
        concat!(
            "#!/bin/sh\nset -eu\n",
            "[ \"$1\" = add ] && [ \"$2\" = --no-tidy ] && [ \"$4\" = --bibtex ] || exit 23\n",
            "printf '%s\\n' \"$5\" > \"$3\"\n",
            "printf '{\"key\":\"fixture\"}\\n'\n",
        ),
    );
    path
}

/// Serve `body` as a PDF to exactly one request, at a `.PDF` URL with a query
/// string.
pub(super) fn serve_once(body: Vec<u8>) -> (String, JoinHandle<()>) {
    let (base, server) = crate::literature_service::serve_once(move |request| {
        let pdf = tiny_http::Header::from_bytes(b"Content-Type", b"application/pdf").unwrap();
        request.respond(tiny_http::Response::from_data(body).with_header(pdf)).unwrap();
    });
    (format!("{base}/report.PDF?download=1"), server)
}
