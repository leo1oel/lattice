import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { serverRequest } from "./headless-runtime";

/** The filesystem belongs to the server; a native/client file picker would return the wrong paths. */
export async function chooseServerProject(): Promise<string | null> {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- HTTP endpoint, never interface copy
  const projects = await serverRequest<Array<{ path: string; name: string }>>("/api/projects");
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "headless-project-picker";
    dialog.setAttribute("aria-label", i18n._(msg`Open server project`));
    const heading = document.createElement("h2");
    heading.textContent = i18n._(msg`Open server project`);
    const list = document.createElement("div");
    for (const project of projects) {
      const button = document.createElement("button");
      button.textContent = project.name;
      button.title = project.path;
      button.onclick = () => { resolve(project.path); dialog.close(); };
      list.append(button);
    }
    const cancel = document.createElement("button");
    cancel.textContent = i18n._(msg`Cancel`);
    cancel.onclick = () => dialog.close();
    dialog.append(heading, list, cancel);
    dialog.onclose = () => { dialog.remove(); resolve(null); };
    document.body.append(dialog);
    dialog.showModal();
  });
}
