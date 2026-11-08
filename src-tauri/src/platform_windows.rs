//! Windows process and path conventions shared by the host.
use std::ffi::OsStr;
use std::process::Command;

/// A terminal and all of its descendants die when the app exits, including
/// an abnormal exit. Windows automatically closes our last job handle.
pub(crate) struct ProcessJob(std::os::windows::io::OwnedHandle);

impl ProcessJob {
    pub(crate) fn for_process(pid: u32) -> std::io::Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        // SAFETY: each non-null kernel handle is immediately placed in an
        // OwnedHandle, and the information buffer matches its declared class.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = OwnedHandle::from_raw_handle(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let process = OwnedHandle::from_raw_handle(process);
            if AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self(job))
        }
    }

    pub(crate) fn terminate(&self) {
        use std::os::windows::io::AsRawHandle;
        // SAFETY: this is a live job owned by this object.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

pub(crate) fn valid_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    if name.is_empty()
        || name.ends_with(['.', ' '])
        || name.chars().any(|ch| ch < ' ' || "<>:\"|?*".contains(ch))
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CONIN$"
            | "CONOUT$"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    ) && !(stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

pub(crate) fn configure(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // GUI-launched builds must not flash a console for each tool invocation.
    command.creation_flags(0x08000000 | 0x00000200);
}

/// Kept by a build/export until capture and reaping finish, even if its
/// original leader has exited. Cancellation can still reach grandchildren.
pub(crate) struct TrackedGroup {
    pid: u32,
    job: std::sync::Arc<ProcessJob>,
}
static GROUPS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u32, std::sync::Weak<ProcessJob>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

pub(crate) fn track_group(pid: u32) -> std::io::Result<TrackedGroup> {
    let job = std::sync::Arc::new(ProcessJob::for_process(pid)?);
    GROUPS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(pid, std::sync::Arc::downgrade(&job));
    Ok(TrackedGroup { pid, job })
}
impl Drop for TrackedGroup {
    fn drop(&mut self) {
        let mut groups = GROUPS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if groups
            .get(&self.pid)
            .is_some_and(|job| job.ptr_eq(&std::sync::Arc::downgrade(&self.job)))
        {
            groups.remove(&self.pid);
        }
        // The final job handle closes here and kills any remaining descendants.
    }
}

pub(crate) fn terminate_tree(pid: u32) {
    let job = GROUPS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&pid)
        .and_then(std::sync::Weak::upgrade);
    if let Some(job) = job {
        job.terminate();
        return;
    }
    let mut command = Command::new("taskkill.exe");
    configure(&mut command);
    let _ = command.args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}

fn processes() -> Vec<(u32, u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut result = Vec::new();
    // SAFETY: each API writes into a correctly sized structure and the
    // snapshot handle is closed after enumeration.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return result;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = Process32FirstW(snapshot, &mut entry);
        while found != 0 {
            let length =
                entry.szExeFile.iter().position(|ch| *ch == 0).unwrap_or(entry.szExeFile.len());
            result.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..length]),
            ));
            found = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }
    result
}

pub(crate) fn child_process_name(pid: u32) -> Option<String> {
    processes()
        .into_iter()
        .find(|(_, parent, name)| *parent == pid && !name.eq_ignore_ascii_case("conhost.exe"))
        .map(|(_, _, name)| name)
}

pub(crate) fn tree_memory(pid: u32) -> u64 {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    let snapshot = processes();
    let mut pids = vec![pid];
    let mut index = 0;
    while index < pids.len() {
        let parent = pids[index];
        for (child, parent_id, _) in &snapshot {
            if *parent_id == parent && !pids.contains(child) {
                pids.push(*child);
            }
        }
        index += 1;
    }
    pids.into_iter()
        .map(|pid| unsafe {
            let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if process.is_null() {
                return 0;
            }
            let mut info: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            let length = std::mem::size_of_val(&info) as u32;
            let found = GetProcessMemoryInfo(process, &mut info, length);
            CloseHandle(process);
            if found == 0 {
                0
            } else {
                info.WorkingSetSize as u64
            }
        })
        .sum()
}
