import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { appTestUtilsFirst } from "./eslint-app-test-utils-first.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { sourceType: "module", parserOptions: { lang: "tsx" } } });
const error = { messageId: "notFirst" };

tester.run("lattice/app-test-utils-first", appTestUtilsFirst, {
  valid: [
    `import { projectCommands } from "./app-test-utils"; import { screen } from "@testing-library/react";`,
    // A type-only import evaluates nothing.
    `import type { ComponentProps } from "react"; import { projectCommands } from "./app-test-utils";`,
  ],
  invalid: [
    { code: `import { screen } from "@testing-library/react"; import { projectCommands } from "./app-test-utils";`, errors: [error] },
    { code: `import "./app.css"; import { projectCommands } from "./app-test-utils";`, errors: [error] },
    // A suite that never loads the shared mocks.
    { code: `import { screen } from "@testing-library/react";`, errors: [error] },
    { code: `it("renders", () => {});`, errors: [error] },
  ],
});
