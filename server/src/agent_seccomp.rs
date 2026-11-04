//! Native-ABI syscall filter. Path metadata changes are brokered, never continued.
#[cfg(target_os = "linux")]
mod linux {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    const RET: u16 = 6;
    const LOAD: u16 = 0x20;
    const EQ: u16 = 0x15;
    fn statement(code: u16, k: u32) -> libc::sock_filter {
        libc::sock_filter { code, jt: 0, jf: 0, k }
    }
    fn jump(k: u32, jt: u8, jf: u8) -> libc::sock_filter {
        libc::sock_filter { code: EQ, jt, jf, k }
    }
    pub fn install() -> Result<OwnedFd, String> {
        #[repr(C)]
        struct Sizes {
            request: u16,
            reply: u16,
            data: u16,
        }
        let mut sizes = Sizes { request: 0, reply: 0, data: 0 };
        if unsafe { libc::syscall(libc::SYS_seccomp, 3, 0, &mut sizes) } < 0
            || sizes.request != 80
            || sizes.reply != 24
            || sizes.data != 64
        {
            return Err("Unsupported seccomp notification layout".into());
        }
        #[cfg(target_arch = "x86_64")]
        let arch = 0xc000003e;
        #[cfg(target_arch = "aarch64")]
        let arch = 0xc00000b7;
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        return Err("Unsupported agent syscall ABI".into());
        let mut filter = vec![
            statement(LOAD, 4),
            jump(arch, 1, 0),
            statement(RET, 0x80000000),
            statement(LOAD, 0),
            libc::sock_filter { code: 0x35, jt: 0, jf: 1, k: 0x40000000 },
            statement(RET, 0x80000000),
        ];
        let denied = 0x00050000 | libc::EPERM as u32;
        for number in [
            libc::SYS_ptrace,
            libc::SYS_process_vm_readv,
            libc::SYS_process_vm_writev,
            libc::SYS_pidfd_getfd,
            libc::SYS_mount,
            libc::SYS_umount2,
            libc::SYS_pivot_root,
            libc::SYS_chroot,
            libc::SYS_setns,
            libc::SYS_unshare,
            libc::SYS_setsid,
            libc::SYS_bpf,
            libc::SYS_perf_event_open,
            libc::SYS_keyctl,
            libc::SYS_io_uring_setup,
            libc::SYS_fchown,
            libc::SYS_fchownat,
            libc::SYS_setxattr,
            libc::SYS_lsetxattr,
            libc::SYS_fsetxattr,
            libc::SYS_removexattr,
            libc::SYS_lremovexattr,
            libc::SYS_fremovexattr,
            libc::SYS_utimensat,
        ] {
            filter.extend([jump(number as u32, 0, 1), statement(RET, denied)]);
        }
        #[cfg(target_arch = "x86_64")]
        for number in [
            libc::SYS_chown,
            libc::SYS_lchown,
            libc::SYS_utime,
            libc::SYS_utimes,
            libc::SYS_futimesat,
        ] {
            filter.extend([jump(number as u32, 0, 1), statement(RET, denied)]);
        }
        // Inode flags/project IDs can otherwise mutate a host-owned inode through
        // an O_RDONLY fd; unrelated terminal/Node ioctls remain available.
        filter.extend([
            jump(libc::SYS_ioctl as u32, 0, 5),
            statement(LOAD, 24),
            jump(0x40086602, 1, 0), // FS_IOC_SETFLAGS (native 64-bit ABI)
            jump(0x401c5820, 0, 1), // FS_IOC_FSSETXATTR
            statement(RET, denied),
            statement(LOAD, 0),
        ]);
        // New pathname Unix sockets are forbidden. Anonymous connected STREAM pairs
        // remain available for Node child stdio; datagram pairs cannot be repurposed.
        filter.extend([
            jump(libc::SYS_socket as u32, 0, 3),
            statement(LOAD, 16),
            jump(libc::AF_UNIX as u32, 0, 1),
            statement(RET, denied),
            statement(LOAD, 0),
        ]);
        filter.extend([
            jump(libc::SYS_socketpair as u32, 0, 7),
            statement(LOAD, 16),
            jump(libc::AF_UNIX as u32, 1, 0),
            statement(RET, denied),
            statement(LOAD, 24),
            statement(0x54, 15),
            jump(libc::SOCK_STREAM as u32, 1, 0),
            statement(RET, denied),
            statement(LOAD, 0),
        ]);
        // Landlock ABI 6 signal scope protects the host while permitting child lifecycle signals.
        let mut metadata = vec![libc::SYS_fchmod, libc::SYS_fchmodat, 452];
        #[cfg(target_arch = "x86_64")]
        metadata.push(libc::SYS_chmod);
        for number in metadata {
            filter.extend([jump(number as u32, 0, 1), statement(RET, 0x7fc00000)]);
        }
        filter.push(statement(RET, 0x7fff0000));
        let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
        let descriptor = unsafe { libc::syscall(libc::SYS_seccomp, 1, 8, &program) };
        if descriptor < 0 {
            return Err(format!(
                "Cannot install agent syscall filter: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(descriptor as i32) })
    }
    pub fn send(fd: i32, listener: i32) -> Result<(), String> {
        let mut byte = [0u8];
        let mut iov = libc::iovec { iov_base: byte.as_mut_ptr().cast(), iov_len: 1 };
        let mut control = [0u64; 4];
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = unsafe { libc::CMSG_SPACE(4) } as usize;
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(4) as usize;
            std::ptr::write(libc::CMSG_DATA(header).cast::<i32>(), listener);
            if libc::sendmsg(fd, &message, libc::MSG_NOSIGNAL) != 1 {
                return Err("Could not attach agent metadata broker".into());
            }
        }
        Ok(())
    }
}
#[cfg(target_os = "linux")]
pub use linux::{install, send};
