#![cfg(windows)]
// Exercise the exact platform implementations without compiling Unix-only
// upstream unit-test fixtures into this Windows integration-test executable.
#[path = "../src/platform_fs.rs"]
mod platform_fs;
#[path = "../src/platform_windows.rs"]
mod platform_windows;
#[path = "../src/project_fs_windows.rs"]
mod project_fs;
mod util {
    pub fn err(error: impl std::fmt::Display) -> String {
        error.to_string()
    }
}
use std::fs;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("Lattice test é 中文 {}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn saves_replace_existing_bytes_and_refuse_traversal_and_windows_aliases() {
    let root = Fixture::new();
    let project = project_fs::ProjectDir::open(&root.0).unwrap();
    project.atomic_write("chapitres/été.tex", b"old").unwrap();
    project.atomic_write("chapitres/été.tex", b"new complete document").unwrap();
    assert_eq!(fs::read(root.0.join("chapitres/été.tex")).unwrap(), b"new complete document");
    for path in [
        "../escape",
        "C:\\escape",
        "\\\\server\\share\\file",
        "file.tex:stream",
        "NUL.tex",
        "COM1",
        "file.tex.",
        "file.tex ",
    ] {
        assert!(project.atomic_write(path, b"bad").is_err(), "accepted {path}");
    }
    assert!(project.rename("chapitres/été.tex", "chapitres/été.tex").is_err());
    project.rename("chapitres/été.tex", "chapitres/final.tex").unwrap();
    assert!(root.0.join("chapitres/final.tex").is_file());
    project.remove("chapitres").unwrap();
    assert!(!root.0.join("chapitres").exists());
}

#[test]
fn file_identity_follows_renames_and_pdf_versions_detect_replacements() {
    let root = Fixture::new();
    let path = root.0.join("paper.pdf");
    fs::write(&path, b"%PDF-original").unwrap();
    let file = platform_fs::open_resolved(&path).unwrap();
    let original = platform_fs::identity(&file).unwrap();
    let version = platform_fs::version(&file, &file.metadata().unwrap()).unwrap();
    fs::rename(&path, root.0.join("renamed.pdf")).unwrap();
    assert_eq!(original, platform_fs::path_identity(&root.0.join("renamed.pdf")).unwrap());
    fs::write(&path, b"%PDF-replaced").unwrap();
    let replacement = platform_fs::open_resolved(&path).unwrap();
    assert_ne!(original, platform_fs::identity(&replacement).unwrap());
    assert_ne!(
        version,
        platform_fs::version(&replacement, &replacement.metadata().unwrap()).unwrap()
    );
    let mut bytes = [0; 4];
    platform_fs::read_exact_at(&file, &mut bytes, 5).unwrap();
    assert_eq!(&bytes, b"orig");
    assert!(platform_fs::read_exact_at(&file, &mut bytes, 100).is_err());
}

#[test]
fn junctions_cannot_escape_the_project_capability() {
    let root = Fixture::new();
    let outside = Fixture::new();
    let project = project_fs::ProjectDir::open(&root.0).unwrap();
    let junction = root.0.join("linked");
    let result = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert!(project.atomic_write("linked/escape.tex", b"bad").is_err());
    assert!(!outside.0.join("escape.tex").exists());
    fs::remove_dir(&junction).unwrap();
}

#[test]
fn history_pruning_keeps_latest_json_and_unrelated_files() {
    let root = Fixture::new();
    let project = project_fs::ProjectDir::open(&root.0).unwrap();
    for index in 0..5 {
        project.atomic_write(&format!("history/{index:02}.json"), b"{}").unwrap();
    }
    project.atomic_write("history/keep.txt", b"kept").unwrap();
    project.prune_json_files("history", 2).unwrap();
    assert_eq!(fs::read_dir(root.0.join("history")).unwrap().count(), 3);
    assert!(root.0.join("history/03.json").is_file());
    assert!(root.0.join("history/04.json").is_file());
}

#[test]
fn closing_a_terminal_job_terminates_its_descendants() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    let root = Fixture::new();
    let marker = root.0.join("child-pid.txt");
    let script = format!("Start-Sleep -Milliseconds 500; $child = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText('{}', [string]$child.Id); Start-Sleep 60", marker.display().to_string().replace('\'', "''"));
    let mut command = std::process::Command::new("powershell.exe");
    platform_windows::configure(&mut command);
    let mut child = command.args(["-NoProfile", "-Command", &script]).spawn().unwrap();
    let job = platform_windows::ProcessJob::for_process(child.id()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let pid = loop {
        if let Ok(Some(pid)) =
            fs::read_to_string(&marker).map(|value| value.trim().parse::<u32>().ok())
        {
            break pid;
        }
        assert!(std::time::Instant::now() < deadline, "PowerShell did not start the descendant");
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    // Keep the descendant handle open so PID reuse cannot make the check lie.
    let descendant = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!descendant.is_null());
    let descendant = unsafe { OwnedHandle::from_raw_handle(descendant) };
    drop(job);
    assert_eq!(unsafe { WaitForSingleObject(descendant.as_raw_handle(), 5000) }, WAIT_OBJECT_0);
    let _ = child.wait();
}
