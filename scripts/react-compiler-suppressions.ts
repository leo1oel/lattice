// The React Compiler skips a function whose hooks lint is disabled inside it
// (`eslint-disable-next-line <rule>`). Oxlint runs eslint-plugin-react-hooks
// under the `react-hooks-js` name (see .oxlintrc.json), so the disable comments
// use that name, and the build and the test suite must both match it or they
// compile functions the comments meant to leave alone. vite.config.ts and
// vitest.config.ts pass this list; scripts/react-compiler-report.mjs restates it.
export const reactCompilerSuppressionRules = ["react-hooks-js/exhaustive-deps", "react-hooks-js/rules-of-hooks"];
