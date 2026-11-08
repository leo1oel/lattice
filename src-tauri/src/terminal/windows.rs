//! Windows terminal sessions backed by ConPTY (Windows 10 1809 and later).
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};

pub(crate) fn login_shell() -> PathBuf {
    let powershell = crate::commands::resolve("pwsh.exe");
    if powershell.is_file() { return powershell; }
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

pub(crate) struct Session {
    window: String,
    root: PathBuf,
    name: String,
    pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    input: mpsc::Sender<Vec<u8>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    stop: Arc<AtomicBool>,
    unread: Arc<AtomicUsize>,
    exit: Arc<(Mutex<bool>, Condvar)>,
}

pub(crate) struct Hangup {
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    exit: Arc<(Mutex<bool>, Condvar)>,
    pid: Option<u32>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.clamp(2, 1000), rows: rows.clamp(1, 500), pixel_width: 0, pixel_height: 0 }
}

impl Session {
    pub(crate) fn spawn(window: String, root: PathBuf, cols: u16, rows: u16, output: Channel<InvokeResponseBody>) -> Result<Self, String> {
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|error| error.to_string())?;
        let shell = login_shell();
        let name = shell.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let mut command = CommandBuilder::new(&shell);
        command.args(["-NoLogo", "-NoExit"]);
        command.cwd(&root);
        command.env("PATH", crate::commands::child_path());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Lattice");
        let mut child = pair.slave.spawn_command(command).map_err(|error| format!("Could not start a shell: {error}"))?;
        drop(pair.slave);
        let pid = child.process_id();
        let killer = Arc::new(Mutex::new(child.clone_killer()));
        let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let unread = Arc::new(AtomicUsize::new(0));
        let exit = Arc::new((Mutex::new(false), Condvar::new()));
        let (input, keys) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(bytes) = keys.recv() {
                if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() { break; }
            }
        });
        let (reader_stop, reader_unread) = (Arc::clone(&stop), Arc::clone(&unread));
        let reader_output = output.clone();
        let read_thread = std::thread::spawn(move || {
            let mut bytes = vec![0; 64 * 1024];
            while !reader_stop.load(Ordering::Acquire) {
                while reader_unread.load(Ordering::Acquire) > 2 * 1024 * 1024 && !reader_stop.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        reader_unread.fetch_add(count, Ordering::AcqRel);
                        if reader_output.send(InvokeResponseBody::Raw(bytes[..count].to_vec())).is_err() { break; }
                    }
                }
            }
        });
        let (child_exit, child_stop) = (Arc::clone(&exit), Arc::clone(&stop));
        std::thread::spawn(move || {
            let status = child.wait().ok().map(|status| status.exit_code());
            *child_exit.0.lock().unwrap_or_else(PoisonError::into_inner) = true;
            child_exit.1.notify_all();
            child_stop.store(true, Ordering::Release);
            let _ = read_thread.join();
            let _ = output.send(InvokeResponseBody::Json(serde_json::json!({"exit": status}).to_string()));
        });
        Ok(Self { window, root, name, pid, master: Mutex::new(pair.master), input, killer, stop, unread, exit })
    }

    pub(crate) fn window(&self) -> &str { &self.window }
    pub(crate) fn root(&self) -> &Path { &self.root }
    pub(crate) fn name(&self) -> &str { &self.name }
    pub(crate) fn write(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.input.send(bytes).map_err(|_| "This terminal has closed.".into())
    }
    pub(crate) fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master.lock().unwrap_or_else(PoisonError::into_inner).resize(size(cols, rows)).map_err(|error| error.to_string())
    }
    pub(crate) fn acknowledge(&self, bytes: usize) {
        let _ = self.unread.fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| Some(count.saturating_sub(bytes)));
    }
    pub(crate) fn running_command(&self) -> Option<String> {
        if *self.exit.0.lock().unwrap_or_else(PoisonError::into_inner) { return None; }
        self.pid.and_then(crate::platform_windows::child_process_name)
    }
    pub(crate) fn hang_up(self) -> Hangup {
        self.stop.store(true, Ordering::Release);
        let hangup = Hangup { killer: self.killer, exit: self.exit, pid: self.pid };
        hangup.kill();
        hangup
    }
    pub(crate) fn end(self, grace: Duration) {
        let hangup = self.hang_up();
        std::thread::spawn(move || hangup.finish(grace));
    }
}

impl Hangup {
    fn kill(&self) {
        if !*self.exit.0.lock().unwrap_or_else(PoisonError::into_inner) {
            if let Some(pid) = self.pid { crate::platform_windows::terminate_tree(pid); }
            let _ = self.killer.lock().unwrap_or_else(PoisonError::into_inner).kill();
        }
    }
    pub(crate) fn finish(self, grace: Duration) {
        let exited = self.exit.0.lock().unwrap_or_else(PoisonError::into_inner);
        let (exited, _) = self.exit.1.wait_timeout_while(exited, grace, |exited| !*exited).unwrap_or_else(PoisonError::into_inner);
        let done = *exited;
        drop(exited);
        if !done { self.kill(); }
    }
}
