// This mode runs before Tauri initialization and inherits the sidecar's
// bibliography sandbox. The tiny shell launcher only selects this mode; the
// executable remains in the signed app bundle, with no copied system binaries.
pub(crate) const FLAG: &str = "--lattice-process-snapshot";

unsafe extern "C" {
    fn lattice_process_snapshot(with_parent: i32, pids: *const i32, pid_count: usize) -> i32;
}

fn query(args: &[String]) -> Result<(bool, Vec<i32>), &'static str> {
    if args == ["-eo", "pid=,ppid=,command="] {
        return Ok((true, Vec::new()));
    }
    if args.len() == 4 && args[0] == "-p" && args[2] == "-o" && args[3] == "pid=,command=" {
        let pids = args[1]
            .split(',')
            .map(|pid| pid.parse::<i32>().ok().filter(|pid| *pid > 0))
            .collect::<Option<Vec<_>>>()
            .ok_or("Invalid process IDs")?;
        return Ok((false, pids));
    }
    Err("Unsupported process snapshot arguments")
}

pub(crate) fn run_if_requested() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(FLAG) {
        return;
    }
    let (with_parent, pids) = match query(&args.collect::<Vec<_>>()) {
        Ok(query) => query,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    // SAFETY: the native function reads exactly pid_count entries, borrows the
    // slice only for this call, and uses SDK definitions for the kernel ABI.
    let error =
        unsafe { lattice_process_snapshot(i32::from(with_parent), pids.as_ptr(), pids.len()) };
    if error != 0 {
        eprintln!(
            "Process snapshot failed: {}",
            std::io::Error::from_raw_os_error(error)
        );
        std::process::exit(1);
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::query;

    #[test]
    fn accepts_only_the_two_synara_snapshot_formats() {
        let args = |values: &[&str]| values.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            query(&args(&["-eo", "pid=,ppid=,command="])),
            Ok((true, vec![]))
        );
        assert_eq!(
            query(&args(&["-p", "31,72", "-o", "pid=,command="])),
            Ok((false, vec![31, 72]))
        );
        for pids in ["", "0", "-1", "31,", "31,abc", "2147483648"] {
            assert!(query(&args(&["-p", pids, "-o", "pid=,command="])).is_err());
        }
        assert!(query(&args(&["-eo", "pid="])).is_err());
        assert!(query(&[]).is_err());
    }
}
