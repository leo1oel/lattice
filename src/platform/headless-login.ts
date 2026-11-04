import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { serverRequest, type HeadlessSession } from "./headless-runtime";

/** Keep the access token in the form only; the server issues an HttpOnly session cookie. */
export function showServerLogin(): Promise<HeadlessSession> {
  return new Promise((resolve) => {
    const root = document.getElementById("root")!;
    const form = document.createElement("form");
    form.className = "headless-login";
    const title = document.createElement("h1");
    title.textContent = i18n._(msg`Connect to Lattice server`);
    const label = document.createElement("label");
    label.textContent = i18n._(msg`Server access token`);
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.required = true;
    input.spellcheck = false;
    label.append(input);
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = i18n._(msg`Connect`);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    form.append(title, label, button, status);
    root.replaceChildren(form);
    input.focus();
    form.onsubmit = async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        // eslint-disable-next-line lingui/no-unlocalized-strings -- HTTP endpoint, never interface copy
        const session = await serverRequest<HeadlessSession>("/api/session", { token: input.value });
        if (!session.authenticated) throw new Error(i18n._(msg`Could not authenticate with this server.`));
        input.value = "";
        root.replaceChildren();
        resolve(session);
      } catch {
        input.value = "";
        status.textContent = i18n._(msg`Connection failed. Check the server access token and try again.`);
        input.focus();
      } finally {
        button.disabled = false;
      }
    };
  });
}
