import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { awaitChangedAlert } from "./eslint-await-changed-alert.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { sourceType: "module" } });
const error = { messageId: "awaitChangedAlert" };

tester.run("lattice/await-changed-alert", awaitChangedAlert, {
  valid: [
    // The replacement: wait for the content, not for any alert.
    `await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not resolve"));`,
    // Presence alone is what findByRole is for.
    `expect(await screen.findByRole("alert")).toBeInTheDocument();`,
    // Other roles are out of scope until a reproduced flake says otherwise.
    `expect(await screen.findByRole("status")).toHaveTextContent("Saved");`,
    // A synchronous query asserts the current alert on purpose.
    `expect(screen.getByRole("alert")).toHaveTextContent("An earlier save failed.");`,
  ],
  invalid: [
    { code: `expect(await screen.findByRole("alert")).toHaveTextContent("could not resolve");`, errors: [error] },
    { code: `expect(await screen.findByRole("alert", { name: "Lookup" })).toHaveTextContent(/failed/);`, errors: [error] },
    // The query from a render result rather than the screen.
    { code: `expect(await view.findByRole("alert")).toHaveTextContent("x");`, errors: [error] },
    { code: `expect(await findByRole("alert")).toHaveTextContent("x");`, errors: [error] },
  ],
});
