//! The Windows terminal's actual ConPTY and ownership boundary.
use super::{Session, Terminals};
use crate::test_support::TempDir;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

fn wait_for(
    path: &std::path::Path, session: &Session, output: &Mutex<Vec<u8>>,
) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut answered = 0;
    loop {
        // PSReadLine asks the terminal for its cursor position while starting
        // up. An actual xterm replies; this headless client must do so too.
        let requests =
            output.lock().unwrap().windows(4).filter(|bytes| *bytes == b"\x1b[6n").count();
        while answered < requests {
            session.write(b"\x1b[1;1R".to_vec()).unwrap();
            answered += 1;
        }
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str(&text) {
                return value;
            }
        }
        assert!(
            Instant::now() < deadline,
            "PowerShell did not write {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.lock().unwrap())
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn conpty_executes_in_the_project_resizes_and_obeys_window_ownership() {
    let root = TempDir::new("ConPTY été 中文");
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&bytes);
    let output = Channel::<InvokeResponseBody>::new(move |body| {
        if let InvokeResponseBody::Raw(chunk) = body {
            captured.lock().unwrap().extend_from_slice(&chunk);
        }
        Ok(())
    });
    let session = Session::spawn("main".into(), root.to_path_buf(), 80, 24, output).unwrap();
    let ready = root.join("ready.json");
    let command = format!(
        "[IO.File]::WriteAllText('{}', '{{}}')\r",
        ready.display().to_string().replace('\'', "''")
    );
    session.write(command.into_bytes()).unwrap();
    wait_for(&ready, &session, &bytes);
    session.resize(101, 33).unwrap();
    let proof = root.join("proof.json");
    let command = format!("[IO.File]::WriteAllText('{}', (@{{ folder=$PWD.ProviderPath; cols=[Console]::WindowWidth; rows=[Console]::WindowHeight }} | ConvertTo-Json -Compress))\r", proof.display().to_string().replace('\'', "''"));
    session.write(command.into_bytes()).unwrap();
    bytes.lock().unwrap().clear();
    let actual = wait_for(&proof, &session, &bytes);
    assert_eq!(
        std::path::Path::new(actual["folder"].as_str().unwrap()).canonicalize().unwrap(),
        root.canonicalize().unwrap()
    );
    assert_eq!(actual["cols"], 101);
    assert_eq!(actual["rows"], 33);
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, session.pid.unwrap()) };
    assert!(!process.is_null());
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let terminals = Terminals::default();
    let id = terminals.insert(session);
    assert!(terminals.with("other", id, |_| ()).is_err());
    terminals.close_window("other");
    assert_eq!(terminals.len(), 1);
    terminals.close_window("main");
    assert_eq!(terminals.len(), 0);
    assert_eq!(unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) }, WAIT_OBJECT_0);
}
