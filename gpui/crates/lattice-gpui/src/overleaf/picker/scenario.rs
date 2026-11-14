//! What the scenarios ask of the picker and set on it.

use super::*;

impl OverleafPicker {
    /// The account's state as the picker last read it: signed out, signed
    /// in, or not known yet.
    pub fn scenario_connected(&self) -> Option<bool> {
        self.known().map(|status| status.connected)
    }

    /// The projects the list shows, in its order, once it has loaded.
    pub fn scenario_projects(&self, cx: &App) -> Option<Vec<String>> {
        self.list.as_ref().map(|_| {
            self.rows(cx)
                .into_iter()
                .map(|project| project.name)
                .collect()
        })
    }

    /// The folder here that Open would open for the project named `name`
    /// (as its row reads it, with the home folder as `~`), once the lookup
    /// has answered; `None` while it runs or when Open would download.
    pub fn scenario_local_copy(&self, name: &str, cx: &App) -> Option<String> {
        if self.copies_loading {
            return None;
        }
        let project = self
            .rows(cx)
            .into_iter()
            .find(|project| project.name == name)?;
        self.local_copies
            .get(&project.id)
            .map(|copy| copy.display.clone())
    }

    /// Whether the list has loaded and the lookup of the folders already
    /// here has answered for it.
    pub fn scenario_copies_read(&self, cx: &App) -> bool {
        self.list.is_some()
            && !self.copies_loading
            && !self.copies_for.is_empty()
            && !self.rows(cx).is_empty()
    }

    /// Close the picker, as Escape does.
    pub fn scenario_dismiss(&mut self, cx: &mut Context<Self>) {
        self.dismiss(cx);
    }

    /// Show `list` for the account `status` at once, the first row chosen,
    /// with nothing asked of the network: the parity harness's picker.
    pub fn scenario_stage(
        &mut self,
        status: OverleafStatus,
        list: OverleafProjectList,
        cx: &mut Context<Self>,
    ) {
        self.status_task = None;
        self.projects_task = None;
        self.status_loading = None;
        self.projects_loading = None;
        self.status = Some(status);
        self.list = Some(list);
        self.selected = self.rows(cx).first().map(|project| project.id.clone());
        cx.notify();
    }

    /// Connect, as the sign-in button does.
    pub fn scenario_sign_in(&mut self, cx: &mut Context<Self>) {
        self.login.update(cx, |login, cx| login.begin(cx));
    }

    /// Choose the project named `name` and open it, as its row's Open does.
    pub fn scenario_open(&mut self, name: &str, here: bool, cx: &mut Context<Self>) -> bool {
        let Some(project) = self
            .rows(cx)
            .into_iter()
            .find(|project| project.name == name)
        else {
            return false;
        };
        self.select(project.id.clone(), cx);
        self.open_project(project, here, cx);
        true
    }
}
