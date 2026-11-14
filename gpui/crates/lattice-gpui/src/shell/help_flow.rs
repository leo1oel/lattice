//! Help's surfaces in the window (`crate::help`): What's new over the window
//! (Help ▸ What's New in Lattice, the palette, the notice after an update)
//! and Report a problem (Help ▸ Report a Problem…, the palette), which files
//! the report and needs no window of its own.

use gpui::{AppContext as _, Context, Window, actions};

use super::Shell;
use crate::help::whats_new::{WhatsNewEvent, WhatsNewSheet};

actions!(lattice, [WhatsNew, ReportProblem]);

impl Shell {
    /// The release notes sheet, at the running version; asked for again
    /// while open, it stays as it is.
    pub(crate) fn open_whats_new(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sheets.whats_new.is_some() {
            return;
        }
        // The notice that offered it has done its work.
        crate::notices::dismiss("whats-new", cx);
        let sheet = cx.new(|_| WhatsNewSheet::new());
        let subscription =
            cx.subscribe_in(&sheet, window, |this, _, event, window, cx| match event {
                WhatsNewEvent::Close => {
                    this.sheets.whats_new = None;
                    this.focus_front(window, cx);
                    cx.notify();
                }
            });
        self.sheets.whats_new = Some((sheet, subscription));
        cx.notify();
    }

    pub(crate) fn report_problem(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        crate::help::report::report_problem(cx);
    }
}
