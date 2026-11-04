//! Closed, discoverable commands over the same domain functions as desktop IPC.
use crate::{doctor, git, latex, literature, overleaf, papers, project};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const COMMANDS: &[&str] = &[
    "initial_project",
    "open_project",
    "refresh_project",
    "create_project",
    "list_project_tree_with_hidden",
    "read_project_file",
    "stat_project_file",
    "read_project_asset",
    "read_project_asset_range",
    "write_project_file",
    "create_project_entry",
    "delete_project_entry",
    "rename_project_entry",
    "move_project_entry",
    "search_project",
    "list_todos",
    "list_references",
    "list_unused_symbols",
    "set_compile_root",
    "build_project",
    "abort_build",
    "clean_project",
    "read_compiled_pdf",
    "run_doctor",
    "git_status",
    "git_init",
    "git_log",
    "list_history",
    "get_history_entry",
    "list_papers",
    "read_paper",
    "read_paper_blog_local",
    "search_literature",
    "search_paper_library",
    "literature_request",
    "import_reference",
    "fetch_paper",
    "fetch_web_reference",
    "overleaf_status",
    "overleaf_connect_session",
    "overleaf_disconnect",
    "overleaf_list_projects",
    "overleaf_link",
    "overleaf_preview",
    "overleaf_sync",
    "overleaf_publish_project",
    "overleaf_clone_project",
    "list_annotations",
    "list_citations",
    "read_bib_entry",
    "save_bib_entry",
    "revert_history",
    "delete_history",
    "update_project_manifest",
    "get_project_manifest",
    "get_app_locale",
    "native_theme",
    "list_local_templates",
];

pub fn capabilities() -> Value {
    json!({"protocolVersion":1,"headless":true,"commands":COMMANDS,
        "events":["build-progress","project-fs-changed"],
        "unavailable":["native_windows","native_file_dialogs","system_keychain","embedded_login_webview","agent_sidecar","texlab","terminal","synara"],
        "projectModel":"workspace-confined projects; independent active project per browser session; projectRoot pins mutations"})
}

pub struct Core {
    pub root: PathBuf,
    pub state_dir: PathBuf,
    pub active: latex::ActiveBuild,
    pub mutations: std::sync::Mutex<()>,
    pub events: tokio::sync::broadcast::Sender<Value>,
}
impl Core {
    pub fn new(root: &Path, state_dir: &Path) -> Result<Arc<Self>, String> {
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(state_dir).map_err(|e| e.to_string())?;
        let state_dir = state_dir.canonicalize().map_err(|e| e.to_string())?;
        if state_dir.starts_with(&root) {
            return Err("Keep the private state directory outside the project workspace.".into());
        }
        let (events, _) = tokio::sync::broadcast::channel(256);
        Ok(Arc::new(Self {
            root,
            state_dir,
            active: Default::default(),
            mutations: Default::default(),
            events,
        }))
    }
    pub fn confined(&self, path: &str) -> Result<PathBuf, String> {
        let path = Path::new(path);
        let absolute = if path.is_absolute() { path.to_path_buf() } else { self.root.join(path) };
        let canonical = absolute.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&self.root) {
            return Err("Path is outside the configured workspace.".into());
        }
        Ok(canonical)
    }
    pub fn invoke(self: &Arc<Self>, command: &str, args: Value) -> Result<Value, String> {
        let result = self.invoke_inner(command, args);
        if command.starts_with("overleaf_")
            && !result.as_ref().err().is_some_and(|error| error.starts_with("unsupported_command:"))
        {
            result.map_err(|_|"The Overleaf operation failed. Check the connection, account permissions and session in your browser.".to_string())
        } else {
            result
        }
    }
    fn invoke_inner(self: &Arc<Self>, command: &str, args: Value) -> Result<Value, String> {
        if !COMMANDS.contains(&command) {
            return Err(format!("unsupported_command: {command} is unavailable in headless mode. See /api/capabilities."));
        }
        if let Some(root) = args.get("projectRoot").and_then(Value::as_str) {
            if self.confined(root)? != self.root {
                return Err("This service is bound to a different project.".into());
            }
        }
        let _mutation = if matches!(
            command,
            "write_project_file"
                | "create_project_entry"
                | "delete_project_entry"
                | "rename_project_entry"
                | "move_project_entry"
                | "overleaf_sync"
                | "overleaf_publish_project"
                | "create_project"
                | "set_compile_root"
                | "update_project_manifest"
                | "save_bib_entry"
                | "revert_history"
                | "delete_history"
                | "import_reference"
                | "fetch_paper"
                | "fetch_web_reference"
                | "literature_request"
        ) {
            Some(
                self.mutations
                    .lock()
                    .map_err(|_| "Project mutation state unavailable".to_string())?,
            )
        } else {
            None
        };
        let root = &self.root;
        let string = |key: &str| -> Result<&str, String> {
            args.get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Missing string argument: {key}"))
        };
        let opt = |key: &str| args.get(key).and_then(Value::as_str);
        let flag = |key: &str| args.get(key).and_then(Value::as_bool).unwrap_or(false);
        let value = match command {
            "initial_project" | "refresh_project" => value(project::open(root))?,
            "create_project" => {
                let parent = self.confined(string("parent")?)?;
                let created = project::create_with_venue(&parent, string("name")?, project::Venue::parse(opt("venue").unwrap_or("neurips"))?)?;
                value(project::open(&created))?
            }
            "open_project" => {
                if self.confined(string("path")?)? != *root { return Err("Start a separate service to open another project.".into()); }
                value(project::open(root))?
            }
            "list_project_tree_with_hidden" => value(project::scan_tree(root, project::TreeView::ProjectWithHidden))?,
            "update_project_manifest" => value(project::update_manifest_settings(root,project::ManifestSettings {
                engine:opt("engine").map(str::to_owned),keep_engine:args.get("keepEngine").and_then(Value::as_bool),trusted:args.get("trusted").and_then(Value::as_bool),stop_on_first_error:args.get("stopOnFirstError").and_then(Value::as_bool),
                word_budget:if flag("clearWordBudget"){Some(None)}else{args.get("wordBudget").and_then(Value::as_u64).map(|v|Some(v as u32))},
                page_budget:if flag("clearPageBudget"){Some(None)}else{args.get("pageBudget").and_then(Value::as_u64).map(|v|Some(v as u32))},
            }))?,
            "list_citations" => value(project::citations(root))?,
            "read_bib_entry" => value(project::read_bib_entry(root,string("key")?))?,
            "save_bib_entry" => value(project::save_bib_entry(root,string("key")?,string("bibtex")?))?,
            "revert_history" => value(project::revert(root,string("transactionId")?,opt("path")))?,
            "delete_history" => value(project::delete_history(root,string("transactionId")?))?,
            "get_project_manifest" => value(project::read_manifest(root))?,
            "read_project_file" => value(project::read_file(root, string("path")?))?,
            "read_project_asset" => value(project::read_asset(root,string("path")?))?,
            "read_project_asset_range" => value(project::read_asset_range(root,string("path")?,string("version")?,args.get("start").and_then(Value::as_u64).ok_or("Missing start")?,args.get("end").and_then(Value::as_u64).ok_or("Missing end")?))?,
            "stat_project_file" => value(project::stat_file(root, string("path")?))?,
            "write_project_file" => value(project::apply_editor_transaction(root, string("path")?.into(), string("content")?.into(), opt("baseContent").map(str::to_owned), opt("expectedContent").map(str::to_owned)))?,
            "create_project_entry" => value(project::create_entry(root, string("path")?, string("kind")?))?,
            "delete_project_entry" => value(project::delete_entry(root, string("path")?))?,
            "rename_project_entry" => value(project::rename_entry(root, string("path")?, string("newName")?))?,
            "move_project_entry" => value(project::move_entry(root, string("path")?, string("targetDirectory")?))?,
            "search_project" => value(project::search_files(root, string("query")?))?,
            "list_todos" => value(project::list_todos(root))?,
            "list_references" => value(project::references(root))?,
            "list_unused_symbols" => value(project::unused_symbols(root))?,
            "set_compile_root" => value(project::set_compile_root(root, string("path")?))?,
            "build_project" => {
                let events = self.events.clone();
                let project_root = root.to_string_lossy().into_owned();
                let progress_id = args.get("progressId").cloned().unwrap_or(Value::Null);
                let steps = latex::BuildSteps::new(move |elapsed_ms, steps| { let _ = events.send(json!({"event":"build-progress","payload":{"projectRoot":project_root,"progressId":progress_id,"elapsedMs":elapsed_ms,"steps":steps}})); });
                value(latex::build(root, flag("force"), &self.active, opt("documentPath"), &steps))?
            }
            "abort_build" => value(latex::abort(&self.active))?,
            "clean_project" => value(latex::clean(root))?,
            "read_compiled_pdf" => value(latex::read_compiled_pdf(root))?,
            "run_doctor" => serde_json::to_value(doctor::run(Some(root))).map_err(|e| e.to_string())?,
            "git_status" => value(git::status(root))?,
            "git_init" => value(git::init(root))?,
            "git_log" => value(git::log(root, args.get("limit").and_then(Value::as_u64).unwrap_or(50).min(500) as usize))?,
            "list_history" => value(project::history(root))?,
            "get_history_entry" => value(project::get_history_entry(root, string("transactionId")?))?,
            "list_annotations" => value(project::read_annotations(root))?,
            "list_papers" => value(papers::list_papers(root))?,
            "read_paper" => value(papers::read_paper(root, string("arxivId")?))?,
            "read_paper_blog_local" => value(papers::read_paper_blog_local(root, string("arxivId")?))?,
            "search_literature" => value(literature::search(string("query")?, flag("precise"), args.get("page").and_then(Value::as_u64).unwrap_or(0) as u32))?,
            "search_paper_library" => value(papers::search_library(root, string("query")?))?,
            "import_reference" => value(papers::import_reference(root,string("input")?,papers::HistoryMode::Record,&|_|{},&std::sync::atomic::AtomicBool::new(false)))?,
            "fetch_paper" => value(papers::fetch_paper(root,string("arxivId")?,&|_|{},&std::sync::atomic::AtomicBool::new(false)))?,
            "fetch_web_reference" => value(papers::fetch_web_reference(root,string("url")?,&std::sync::atomic::AtomicBool::new(false)))?,
            "literature_request" => serde_json::from_value::<crate::agent_literature::LiteratureRequest>(args).map_err(|e|e.to_string())?.run(root)?,
            "overleaf_status" => value(overleaf::session_status(&self.state_dir))?,
            "overleaf_connect_session" => value(overleaf::store_session_cookie(&self.state_dir, string("host")?, string("cookie")?).map_err(|_| "Could not validate the Overleaf session. Check the host and cookie in your browser.".to_string()))?,
            "overleaf_disconnect" => value(overleaf::disconnect(&self.state_dir))?,
            "overleaf_list_projects" => value(overleaf::list_projects(&self.state_dir))?,
            "overleaf_link" => value(overleaf::project_link(root))?,
            "overleaf_preview" => value(overleaf::preview(&self.state_dir, root, &Default::default()))?,
            "overleaf_sync" => value(overleaf::sync(&self.state_dir, root, &Default::default(), None))?,
            "overleaf_publish_project" => value(overleaf::publish_project(&self.state_dir, root, string("name")?))?,
            "overleaf_clone_project" => {
                // The shared clone implementation validates project names and refuses existing targets.
                value(overleaf::clone_project(&self.state_dir, string("projectId")?, string("projectName")?, root, opt("accessLevel")))?
            }
            "get_app_locale" => json!("en"),
            "native_theme" => json!(null),
            "list_local_templates" => value(project::templates::list(&self.state_dir.join("templates")))?,
            _ => unreachable!(),
        };
        if matches!(
            command,
            "write_project_file"
                | "create_project_entry"
                | "delete_project_entry"
                | "rename_project_entry"
                | "move_project_entry"
                | "overleaf_sync"
        ) {
            let _ = self
                .events
                .send(json!({"event":"project-fs-changed","payload":{"root":root,"paths":null}}));
        }
        Ok(value)
    }
}
fn value<T: Serialize>(value: Result<T, String>) -> Result<Value, String> {
    value.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}
