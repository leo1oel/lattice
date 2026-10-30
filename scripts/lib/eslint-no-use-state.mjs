// `lattice/no-use-state`: new React state goes through `useReducer` (or a
// shared store when components share it), so every transition is a named
// action instead of a setter called from wherever. Files that used
// `useState` when the rule landed are listed in the `.oxlintrc.json`
// override that turns this rule off; scripts/check-use-state-allowlist.mjs
// keeps that list from growing. See CODING_STANDARDS.md, "Component state".
//
// One rule covers both spellings, the named import and `React.useState`, so
// the allowlist can turn it off without restating the per-scope
// `no-restricted-imports` options, which a later override would replace.
const MESSAGE =
  "Don't add useState: use useReducer for component state, or a shared store for state several components read (CODING_STANDARDS.md, \"Component state\").";

export const noUseState = {
  meta: {
    type: "problem",
    docs: { description: "Forbid useState in new code" },
    messages: { useState: MESSAGE },
    schema: [],
  },
  create(context) {
    const reactNamespaces = new Set();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "react") return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.imported.name === "useState") {
            context.report({ node: specifier, messageId: "useState" });
          } else if (specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier") {
            reactNamespaces.add(specifier.local.name);
          }
        }
      },
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          reactNamespaces.has(node.object.name) &&
          !node.computed &&
          node.property.name === "useState"
        ) {
          context.report({ node, messageId: "useState" });
        }
      },
    };
  },
};
