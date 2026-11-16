//! The network coming back, as the browser's `online` event tells the Tauri
//! app's live channel (`use-overleaf-realtime-connection.ts`), which then
//! joins again at once rather than at the end of its backoff, up to 30
//! seconds away. On macOS the system's reachability of the internet is
//! watched (`SCNetworkReachability`, on a thread running its own run loop),
//! and each time it turns reachable every window's bridge hears it; the
//! window coming forward stays the other prompt, as it is there.

use std::sync::{Mutex, OnceLock};

use futures::channel::mpsc;

/// Each listener's sender; one watcher thread serves them all.
static LISTENERS: Mutex<Vec<mpsc::UnboundedSender<()>>> = Mutex::new(Vec::new());

/// A stream of the network coming back, from now on.
pub fn returns() -> mpsc::UnboundedReceiver<()> {
    static WATCHING: OnceLock<()> = OnceLock::new();
    WATCHING.get_or_init(watch);
    let (sender, receiver) = mpsc::unbounded();
    if let Ok(mut listeners) = LISTENERS.lock() {
        listeners.push(sender);
    }
    receiver
}

/// The network is reachable again: every listener hears it (also what a
/// scenario calls, as the system would).
pub fn announce_return() {
    if let Ok(mut listeners) = LISTENERS.lock() {
        listeners.retain(|listener| listener.unbounded_send(()).is_ok());
    }
}

#[cfg(target_os = "macos")]
fn watch() {
    use std::{
        net::{Ipv4Addr, SocketAddr},
        sync::atomic::{AtomicBool, Ordering},
    };

    use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes};
    use system_configuration::network_reachability::{ReachabilityFlags, SCNetworkReachability};

    let spawned = std::thread::Builder::new()
        .name("network-reachability".into())
        .spawn(|| {
            // The internet at large, not one host: what `online` means.
            let mut reachability =
                SCNetworkReachability::from(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)));
            let reachable = |flags: ReachabilityFlags| {
                flags.contains(ReachabilityFlags::REACHABLE)
                    && !flags.contains(ReachabilityFlags::CONNECTION_REQUIRED)
            };
            let was = AtomicBool::new(reachability.reachability().is_ok_and(reachable));
            let callback = reachability.set_callback(move |flags| {
                let now = reachable(flags);
                if now && !was.swap(now, Ordering::SeqCst) {
                    announce_return();
                } else {
                    was.store(now, Ordering::SeqCst);
                }
            });
            if callback.is_err() {
                return;
            }
            // SAFETY: the current thread's run loop, in its common modes,
            // which this thread then runs for the app's lifetime.
            let scheduled = unsafe {
                reachability.schedule_with_runloop(&CFRunLoop::get_current(), kCFRunLoopCommonModes)
            };
            if scheduled.is_ok() {
                CFRunLoop::run_current();
            }
        });
    // Without the thread the window coming forward still rejoins.
    drop(spawned);
}

#[cfg(not(target_os = "macos"))]
fn watch() {}
