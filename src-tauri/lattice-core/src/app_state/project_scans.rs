//! The whole-project scans the editor asks for after every save, run one at a
//! time per project with every request that arrives during a run answered by
//! one rerun.
//!
//! Each `.tex` save asks for the label index, the unused symbols, the edit
//! history, the TODO markers and the word count, and each of those re-reads
//! every `.tex` file. Saving again before they finish used to start a second
//! set beside the first, so on a large project the scans of several saves
//! overlapped while the writer typed (issue 1025). Dropping the stale replies
//! in the frontend kept the display right but did not save the work.

use crate::project::{HistoryItem, ReferenceIndex, TodoHit, UnusedSymbols};
use crate::texcount::WordCount;
use std::future::Future;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// One project's post-save scans, one queue per kind.
#[derive(Default)]
pub struct ProjectScans {
    pub references: SharedScan<ReferenceIndex>,
    pub unused_symbols: SharedScan<UnusedSymbols>,
    pub history: SharedScan<Vec<HistoryItem>>,
    pub todos: SharedScan<Vec<TodoHit>>,
    pub word_count: SharedScan<WordCount>,
}

/// A scan whose runs never overlap and whose callers share them.
///
/// A request that arrives while a run is under way waits for it, then for one
/// more run that starts after every request queued by then; all of those
/// requests get that run's answer. However many saves land during a slow
/// scan, it runs at most twice for them, and every answer was read after the
/// request it serves was made, so it reflects the save that asked for it.
pub struct SharedScan<T> {
    /// Requests made so far; each takes the next number as its ticket.
    requested: AtomicU64,
    /// Requests waiting for the run lock, so the last answer is kept only
    /// while a request it covers still has to collect it.
    waiting: AtomicUsize,
    /// The last run's answer and the newest ticket it covers.
    latest: tokio::sync::Mutex<Option<(u64, Result<T, String>)>>,
}

impl<T> Default for SharedScan<T> {
    fn default() -> Self {
        Self {
            requested: AtomicU64::new(0),
            waiting: AtomicUsize::new(0),
            latest: tokio::sync::Mutex::new(None),
        }
    }
}

impl<T: Clone> SharedScan<T> {
    /// Answer this request with a run that starts after it was made: an
    /// earlier caller's run if one began after this request queued, else a
    /// new run of `scan`.
    pub async fn run<F, Fut>(&self, scan: F) -> Result<T, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        // Counted as waiting before taking a ticket, so a run that reads the
        // tickets it covers also sees this request waiting for its answer.
        self.waiting.fetch_add(1, Ordering::SeqCst);
        let ticket = self.requested.fetch_add(1, Ordering::SeqCst) + 1;
        let mut latest = self.latest.lock().await;
        let still_waiting = self.waiting.fetch_sub(1, Ordering::SeqCst) - 1;
        if latest.as_ref().is_some_and(|(covered, _)| *covered >= ticket) {
            // The last request it covers takes the answer with it.
            return match still_waiting {
                0 => latest.take().map(|(_, answer)| answer),
                _ => latest.as_ref().map(|(_, answer)| answer.clone()),
            }
            .expect("checked above");
        }
        let covers = self.requested.load(Ordering::SeqCst);
        let answer = scan().await;
        // Nobody left to share it with: a request that comes later needs a
        // fresh run anyway, so the answer is not held in memory until then.
        *latest = (self.waiting.load(Ordering::SeqCst) > 0).then(|| (covers, answer.clone()));
        answer
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::oneshot;

    /// Saves that land while a scan runs share one rerun, and none of the
    /// runs overlap.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn requests_during_a_run_share_one_rerun() {
        let scan = Arc::new(SharedScan::<u32>::default());
        let runs = Arc::new(AtomicU64::new(0));
        let running = Arc::new(AtomicUsize::new(0));
        let (release_first, first_released) = oneshot::channel::<()>();
        let (first_started, started) = oneshot::channel::<()>();

        let request = |gate: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>| {
            let (scan, runs, running) =
                (Arc::clone(&scan), Arc::clone(&runs), Arc::clone(&running));
            tokio::spawn(async move {
                scan.run(|| async move {
                    assert_eq!(running.fetch_add(1, Ordering::SeqCst), 0, "two runs overlapped");
                    let run = runs.fetch_add(1, Ordering::SeqCst) as u32 + 1;
                    if let Some((started, release)) = gate {
                        started.send(()).unwrap();
                        release.await.unwrap();
                    }
                    running.fetch_sub(1, Ordering::SeqCst);
                    Ok(run)
                })
                .await
            })
        };

        let first = request(Some((first_started, first_released)));
        started.await.unwrap();
        let later = (0..5).map(|_| request(None)).collect::<Vec<_>>();
        // Every later request has queued before the first run ends.
        while scan.waiting.load(Ordering::SeqCst) < 5 {
            tokio::task::yield_now().await;
        }
        release_first.send(()).unwrap();

        assert_eq!(first.await.unwrap(), Ok(1));
        for request in later {
            assert_eq!(request.await.unwrap(), Ok(2));
        }
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        // The shared answer is not kept once everyone has it.
        assert!(scan.latest.lock().await.is_none());
    }

    /// A request after a run has finished gets a run of its own, not the
    /// earlier answer.
    #[tokio::test]
    async fn a_request_after_a_run_reads_again() {
        let scan = SharedScan::<u32>::default();
        assert_eq!(scan.run(|| async { Ok(1) }).await, Ok(1));
        assert_eq!(
            scan.run(|| async { Err("unreadable".to_string()) }).await,
            Err("unreadable".to_string())
        );
        assert_eq!(scan.run(|| async { Ok(3) }).await, Ok(3));
    }
}
