//! What the viewer's host sets on it (its toolbar's offers) and reads back
//! from it (its place, its page, its zoom, for a scenario or a window).

use super::*;

impl PdfView {
    // ---- What the host sets -------------------------------------------------

    pub fn set_action(&mut self, action: Option<ToolbarAction>, cx: &mut Context<Self>) {
        self.action = action;
        cx.notify();
    }

    /// The control at the toolbar's start, before the page controls, which
    /// emits [`PdfViewEvent::Start`] (`toolbarStart`). It never folds into
    /// the narrow toolbar's menu, and it stays while the host is still
    /// getting the PDF.
    pub fn set_toolbar_start(&mut self, start: Option<ToolbarAction>, cx: &mut Context<Self>) {
        self.start = start;
        cx.notify();
    }

    /// The PDF the host is still getting, or that it could not get; a
    /// later [`PdfView::open`] shows the PDF it got.
    pub fn set_host_load(&mut self, load: HostLoad, cx: &mut Context<Self>) {
        if load == HostLoad::Fetching && !self.loading {
            // The first load's skeleton waits on its clock from here.
            self.loading_since = Instant::now();
        }
        self.loading = load == HostLoad::Fetching;
        self.host_load = load;
        cx.notify();
    }

    /// What the host is still getting, for scripted checks.
    pub fn host_load(&self) -> &HostLoad {
        &self.host_load
    }

    /// Whether Reveal cursor in PDF can jump now, and whether a jump is
    /// being located (`canForwardSync`, `locatingPdf`).
    pub fn set_reveal(&mut self, enabled: bool, locating: bool, cx: &mut Context<Self>) {
        if (self.reveal_disabled, self.locating) != (!enabled, locating) {
            self.reveal_disabled = !enabled;
            self.locating = locating;
            cx.notify();
        }
    }

    /// The status line over the pages, or none.
    pub fn set_notice(&mut self, notice: Option<SharedString>, cx: &mut Context<Self>) {
        if self.notice != notice {
            self.notice = notice;
            cx.notify();
        }
    }

    /// Offer Reveal cursor in PDF (the live PDF and a root document's tab).
    pub fn set_can_reveal(&mut self, can: bool, cx: &mut Context<Self>) {
        self.can_reveal = can;
        cx.notify();
    }

    /// Offer Build project while there is no PDF, and show a build running.
    pub fn set_build(&mut self, offers: bool, building: bool, cx: &mut Context<Self>) {
        if (self.offers_build, self.building) != (offers, building) {
            self.offers_build = offers;
            self.building = building;
            cx.notify();
        }
    }

    /// The pages' scroll area on screen, as of the last frame.
    pub fn viewport_bounds(&self) -> Bounds<Pixels> {
        self.viewport
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    /// The page in view, 0-based.
    pub fn current_page(&self) -> usize {
        self.current_page
    }

    pub fn scale(&self) -> f32 {
        self.scale
    }

    pub fn fit(&self) -> Option<FitMode> {
        self.fit
    }

    pub fn stats(&self) -> &RenderStats {
        &self.stats
    }

    /// Whether a place the viewer was given still waits for the pages to be
    /// laid out at the viewport's size.
    /// The vertical scrollbar's thumb opacity as last drawn: 0 while it
    /// hides.
    pub fn scrollbar_opacity(&self) -> f32 {
        self.scrollbar_drawn.get()
    }

    /// The vertical scrollbar's thumb as last drawn, `None` while it hides.
    pub fn scrollbar_thumb(&self) -> Option<lattice_ui::scrollbar::DrawnThumb> {
        self.scrollbar_thumb.get()
    }

    pub fn has_pending_scroll(&self) -> bool {
        self.pending_scroll.is_some()
    }

    /// Reveal cursor in PDF's state as the toolbar draws it: (disabled,
    /// locating), for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn reveal_state(&self) -> (bool, bool) {
        (self.reveal_disabled || self.locating, self.locating)
    }

    /// The load failure shown and whether it offers a build, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn load_failure(&self) -> (Option<SharedString>, bool) {
        (self.message.clone(), self.offers_build)
    }
}
