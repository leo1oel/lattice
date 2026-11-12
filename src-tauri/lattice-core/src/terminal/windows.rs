//! Windows terminal sessions backed by ConPTY (Windows 10 1809 and later).
use crate::host::{Sink, StreamBody};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

pub(crate) fn login_shell() -> PathBuf {
    let powershell = crate::commands::resolve("pwsh.exe");
    if powershell.is_file() {
        return powershell;
    }
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

pub struct Session {
    window: String,
    root: PathBuf,
    name: String,
    pub(super) pid: Option<u32>,
    job: Arc<crate::platform_windows::ProcessJob>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    input: mpsc::Sender<Vec<u8>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    stop: Arc<AtomicBool>,
    unread: Arc<AtomicUsize>,
    exit: Arc<(Mutex<bool>, Condvar)>,
}

pub(crate) struct Hangup {
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    exit: Arc<(Mutex<bool>, Condvar)>,
    job: Arc<crate::platform_windows::ProcessJob>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.clamp(2, 1000), rows: rows.clamp(1, 500), pixel_width: 0, pixel_height: 0 }
}

impl Session {
    pub fn spawn(
        window: String, root: PathBuf, cols: u16, rows: u16, output: Arc<dyn Sink<StreamBody>>,
    ) -> Result<Self, String> {
        let pair =
            native_pty_system().openpty(size(cols, rows)).map_err(|error| error.to_string())?;
        let shell = login_shell();
        let name = shell.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let mut command = CommandBuilder::new(&shell);
        command.args(["-NoLogo", "-NoExit"]);
        command.cwd(&root);
        command.env("PATH", crate::commands::child_path());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Lattice");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Could not start a shell: {error}"))?;
        drop(pair.slave);
        let pid = child.process_id();
        let job =
            match pid.and_then(|pid| crate::platform_windows::ProcessJob::for_process(pid).ok()) {
                Some(job) => Arc::new(job),
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Could not supervise the Windows terminal process tree.".into());
                }
            };
        let killer = Arc::new(Mutex::new(child.clone_killer()));
        let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let unread = Arc::new(AtomicUsize::new(0));
        let exit = Arc::new((Mutex::new(false), Condvar::new()));
        let (input, keys) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(bytes) = keys.recv() {
                if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        });
        let (reader_stop, reader_unread) = (Arc::clone(&stop), Arc::clone(&unread));
        let reader_output = output.clone();
        let read_thread = std::thread::spawn(move || {
            let mut bytes = vec![0; 64 * 1024];
            let mut page_alive = true;
            loop {
                while page_alive
                    && reader_unread.load(Ordering::Acquire) > 2 * 1024 * 1024
                    && !reader_stop.load(Ordering::Acquire)
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if page_alive {
                            reader_unread.fetch_add(count, Ordering::AcqRel);
                            page_alive = reader_output
                                .send(StreamBody::Raw(bytes[..count].to_vec()))
                                .is_ok();
                        }
                    }
                }
            }
        });
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let child_master = Arc::clone(&master);
        let child_job = Arc::clone(&job);
        let (child_exit, child_stop) = (Arc::clone(&exit), Arc::clone(&stop));
        std::thread::spawn(move || {
            let status = child.wait().ok().map(|status| status.exit_code());
            *child_exit.0.lock().unwrap_or_else(PoisonError::into_inner) = true;
            child_exit.1.notify_all();
            child_stop.store(true, Ordering::Release);
            child_job.terminate();
            drop(child_master.lock().unwrap_or_else(PoisonError::into_inner).take());
            let _ = read_thread.join();
            let _ = output.send(StreamBody::Json(serde_json::json!({"exit": status}).to_string()));
        });
        Ok(Self { window, root, name, pid, job, master, input, killer, stop, unread, exit })
    }

    pub(crate) fn window(&self) -> &str {
        &self.window
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn write(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.input.send(bytes).map_err(|_| "This terminal has closed.".into())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .ok_or_else(|| "This terminal has closed.".to_string())?
            .resize(size(cols, rows))
            .map_err(|error| error.to_string())
    }
    pub fn acknowledge(&self, bytes: usize) {
        let _ = self.unread.try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            Some(count.saturating_sub(bytes))
        });
    }
    pub fn running_command(&self) -> Option<String> {
        if *self.exit.0.lock().unwrap_or_else(PoisonError::into_inner) {
            return None;
        }
        self.pid.and_then(crate::platform_windows::child_process_name)
    }
    pub(crate) fn hang_up(self) -> Hangup {
        self.stop.store(true, Ordering::Release);
        let hangup = Hangup { killer: self.killer, exit: self.exit, job: self.job };
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
        self.job.terminate();
        if !*self.exit.0.lock().unwrap_or_else(PoisonError::into_inner) {
            let _ = self.killer.lock().unwrap_or_else(PoisonError::into_inner).kill();
        }
    }
    pub(crate) fn finish(self, grace: Duration) {
        let exited = self.exit.0.lock().unwrap_or_else(PoisonError::into_inner);
        let (exited, _) = self
            .exit
            .1
            .wait_timeout_while(exited, grace, |exited| !*exited)
            .unwrap_or_else(PoisonError::into_inner);
        let done = *exited;
        drop(exited);
        if !done {
            self.kill();
        }
    }
}
