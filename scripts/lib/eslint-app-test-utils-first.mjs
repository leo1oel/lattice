// `lattice/app-test-utils-first`: an App integration suite
// (src/app/app-*.test.tsx) must import ./app-test-utils before any other
// module. That module's `vi.mock` calls are hoisted only within itself, so
// they register when it is evaluated, and ES modules evaluate in import order:
// a module imported ahead of it loads the real dependencies the suite meant to
// mock (docs/architecture.md §6). Type-only imports evaluate nothing, so they
// may come first.

const SOURCE = "./app-test-utils";
const MESSAGE =
  "Import ./app-test-utils first: its vi.mock calls must register before any other module loads (docs/architecture.md §6).";

export const appTestUtilsFirst = {
  meta: {
    type: "problem",
    docs: { description: "Require App integration suites to import ./app-test-utils before any other module" },
    messages: { notFirst: MESSAGE },
    schema: [],
  },
  create(context) {
    return {
      Program(program) {
        const first = program.body.find((node) => node.type === "ImportDeclaration" && node.importKind !== "type");
        if (first?.source.value === SOURCE) return;
        context.report({ node: first ?? program, messageId: "notFirst" });
      },
    };
  },
};
