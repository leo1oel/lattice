import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // The open-knowledge trees are vendored upstream code (inkeep/open-knowledge)
  // kept close to its source for diffability; it is not linted with app rules.
  { ignores: ["dist", "src-tauri/target", "src/open-knowledge-core", "src/open-knowledge-app"] },
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
      // This compiler optimization diagnostic duplicates exhaustive-deps at
      // very high volume in App; keep correctness rules authoritative.
      "react-hooks/preserve-manual-memoization": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
    },
  },
);
