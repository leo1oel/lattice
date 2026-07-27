import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // src/thinking-orbs is vendored verbatim from a third-party package; hold it
  // to upstream's conventions, not ours, so it stays a clean drop-in on update.
  // Agent Elements is installed from its official shadcn registry. Keep the
  // copied source aligned with upstream instead of rewriting it for local lint
  // preferences; our adapter in agent-panel.tsx remains fully linted.
  { ignores: ["dist", "src-tauri/target", "src/thinking-orbs/**", "src/components/agent-elements/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        crypto: "readonly",
        URL: "readonly",
        Blob: "readonly",
        Uint8Array: "readonly",
        atob: "readonly",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // The react-compiler-era hooks lints flag many common, working patterns
      // (ref access, setState in effects, deps completeness). Keep them visible
      // as warnings rather than failing CI; the classic rules-of-hooks — the one
      // that actually catches broken code — stays an error.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
