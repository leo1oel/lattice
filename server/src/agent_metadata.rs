//! Seccomp metadata requests are emulated on held, nofollow descriptors. No
//! CONTINUE flag or tracee pathname is ever handed back to the kernel.
#[cfg(target_os = "linux")]
mod linux {
    use std::{
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::net::UnixStream,
        },
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        thread::JoinHandle,
    };
    #[repr(C)]
    #[derive(Default)]
    struct Data {
        nr: i32,
        arch: u32,
        ip: u64,
        args: [u64; 6],
    }
    #[repr(C)]
    #[derive(Default)]
    struct Request {
        id: u64,
        pid: u32,
        flags: u32,
        data: Data,
    }
    #[repr(C)]
    struct Reply {
        id: u64,
        value: i64,
        error: i32,
        flags: u32,
    }
    pub struct Broker {
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }
    impl Drop for Broker {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
    fn receive(channel: &UnixStream) -> Result<OwnedFd, String> {
        channel
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        let mut byte = [0u8];
        let mut iov = libc::iovec { iov_base: byte.as_mut_ptr().cast(), iov_len: 1 };
        let mut control = [0u64; 4];
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = std::mem::size_of_val(&control);
        unsafe {
            if libc::recvmsg(channel.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) != 1 {
                return Err("Agent metadata listener was not received".into());
            }
            let header = libc::CMSG_FIRSTHDR(&message);
            if header.is_null()
                || (*header).cmsg_level != libc::SOL_SOCKET
                || (*header).cmsg_type != libc::SCM_RIGHTS
                || (*header).cmsg_len != libc::CMSG_LEN(4) as usize
            {
                return Err("Invalid agent metadata listener".into());
            }
            Ok(OwnedFd::from_raw_fd(std::ptr::read(libc::CMSG_DATA(header).cast::<i32>())))
        }
    }
    fn string(pid: u32, address: u64) -> Result<String, ()> {
        let mut bytes = [0u8; 4096];
        let local = libc::iovec { iov_base: bytes.as_mut_ptr().cast(), iov_len: bytes.len() };
        let remote =
            libc::iovec { iov_base: address as usize as *mut libc::c_void, iov_len: bytes.len() };
        let size = unsafe { libc::process_vm_readv(pid as i32, &local, 1, &remote, 1, 0) };
        if size <= 0 {
            return Err(());
        }
        let end = bytes[..size as usize].iter().position(|b| *b == 0).ok_or(())?;
        String::from_utf8(bytes[..end].to_vec()).map_err(|_| ())
    }
    fn contained(path: &Path, roots: &[PathBuf]) -> bool {
        roots.iter().any(|root| path.starts_with(root))
    }
    fn file(request: &Request, roots: &[PathBuf]) -> Result<(std::fs::File, u32), ()> {
        use std::os::unix::fs::OpenOptionsExt;
        let args = &request.data.args;
        let nr = request.data.nr as i64;
        if nr == libc::SYS_fchmod {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                .open(format!("/proc/{}/fd/{}", request.pid, args[0] as i32))
                .map_err(|_| ())?;
            let target = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
                .map_err(|_| ())?;
            if !contained(&target, roots) {
                return Err(());
            }
            return Ok((file, args[1] as u32));
        }
        #[cfg(target_arch = "x86_64")]
        let direct = nr == libc::SYS_chmod;
        #[cfg(not(target_arch = "x86_64"))]
        let direct = false;
        let (dir, address, mode) =
            if direct { (-100, args[0], args[1]) } else { (args[0] as i32, args[1], args[2]) };
        if nr == 452 && args[3] != 0 {
            return Err(());
        }
        let path = PathBuf::from(string(request.pid, address)?);
        if path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
            return Err(());
        }
        let target = if path.is_absolute() {
            path
        } else {
            let base = std::fs::read_link(if dir == libc::AT_FDCWD {
                format!("/proc/{}/cwd", request.pid)
            } else {
                format!("/proc/{}/fd/{dir}", request.pid)
            })
            .map_err(|_| ())?;
            base.join(path)
        };
        let root = roots.iter().find(|root| target.starts_with(root)).ok_or(())?;
        let relative = target.strip_prefix(root).map_err(|_| ())?;
        let file = if relative.as_os_str().is_empty() {
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(root)
                .map_err(|_| ())?
        } else {
            crate::project_fs::ProjectDir::open_nofollow(root)
                .map_err(|_| ())?
                .metadata_file(&relative.to_string_lossy())
                .map_err(|_| ())?
        };
        Ok((file, mode as u32))
    }
    impl Broker {
        pub fn start(channel: UnixStream, roots: Vec<PathBuf>) -> Result<Self, String> {
            let listener = receive(&channel)?;
            unsafe {
                let flags = libc::fcntl(listener.as_raw_fd(), libc::F_GETFL);
                libc::fcntl(listener.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let worker = std::thread::spawn(move || {
                while !stopped.load(Ordering::Acquire) {
                    let mut poll =
                        libc::pollfd { fd: listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                    if unsafe { libc::poll(&mut poll, 1, 100) } <= 0 {
                        continue;
                    }
                    let mut request = Request::default();
                    if unsafe { libc::ioctl(listener.as_raw_fd(), 0xc0502100u64, &mut request) } < 0
                    {
                        continue;
                    }
                    if unsafe { libc::ioctl(listener.as_raw_fd(), 0x40082102u64, &request.id) } < 0
                    {
                        continue;
                    }
                    let result = file(&request, &roots).and_then(|(file, mode)| {
                        if mode & !0o777 != 0 {
                            return Err(());
                        }
                        let metadata = file.metadata().map_err(|_| ())?;
                        if !metadata.is_file() && !metadata.is_dir() {
                            return Err(());
                        }
                        if unsafe { libc::ioctl(listener.as_raw_fd(), 0x40082102u64, &request.id) }
                            < 0
                        {
                            return Err(());
                        }
                        if unsafe { libc::fchmod(file.as_raw_fd(), mode) } < 0 {
                            Err(())
                        } else {
                            Ok(())
                        }
                    });
                    let reply = Reply {
                        id: request.id,
                        value: 0,
                        error: if result.is_ok() { 0 } else { -libc::EPERM },
                        flags: 0,
                    };
                    unsafe {
                        libc::ioctl(listener.as_raw_fd(), 0xc0182101u64, &reply);
                    }
                }
            });
            Ok(Self { stop, worker: Some(worker) })
        }
    }
}
#[cfg(target_os = "linux")]
pub use linux::Broker;
#[cfg(not(target_os = "linux"))]
pub struct Broker;
