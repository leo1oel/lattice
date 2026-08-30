import js from "@eslint/js";
import lingui from "eslint-plugin-lingui";
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
    files: ["scripts/**/*.mjs", "tools/open-slide-runtime/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
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
      lingui,
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
  {
    // Start strict enforcement at each migrated UI boundary. Lingui's strict
    // catalog compilation catches missing Chinese entries; this rule catches
    // visible strings that were never added to a catalog in the first place.
    files: [
      "src/settings/settings-dialog.tsx",
      "src/project/project-dialogs.tsx",
      "src/project/navigator.tsx",
      "src/canvas/canvas-toolbar.tsx",
      "src/canvas/document-canvas.tsx",
      "src/editor/editor-languages.ts",
      "src/editor/presentation/open-slide-workspace.tsx",
      "src/onboarding/onboarding-tour.tsx",
      "src/collab/collab-dialog.tsx",
      "src/build/tex-setup-wizard.tsx",
      "src/pdf/pdf-viewer.tsx",
    ],
    rules: {
      "lingui/no-unlocalized-strings": [
        "error",
        {
          ignore: [
            "^(?:LATTICE|NeurIPS|ICML|ICLR|Vim|Emacs|MCP|Overleaf|BasicTeX|pdfLaTeX|XeLaTeX|LuaLaTeX)$",
            "^[a-z][a-z0-9:+./_-]*$",
            // Stable implementation syntax: selectors/CSS, LaTeX insertion
            // templates, CSS transforms, and generated local paper paths.
            "^(?:[.#:\\[].*|.*\\[.*\\].*|@media .*|document\\..*|\\(\\(\\)=>.*|<!doctype html>.*|\\(prefers-reduced-motion: reduce\\)|\\\\(?:textbf|textit|underline|sout|colorbox|begin|end|href).*|%(?:5C|7B|7D)|(?:translate|scale|minmax)\\(.*|.*(?:px|ms|fr) .*|opacity 60ms ease-out|box-shadow 60ms ease-out|\\.research/papers/.*|/(?:paper|blog)\\.md|figure\\.pdf|data:.*|markdown-preview secondary-markdown-preview|@replit/codemirror-vim|F8|⇧F8|⌘F|⌘/|⌘⇧I)$",
            "^(?:M .*|H .*|Q .*|V .*|Z|viewBox|Escape|var\\(--(?:surface-panel-raised|control-active|text-primary)\\)|rgb\\(8 10 14 / 0\\.48\\)|2d|pdf-search disabled|modal tex-setup-modal)$",
          ],
          ignoreNames: [
            "path",
            "source",
            "HTML_PREVIEW_SCROLLBAR_STYLES",
            "PIERRE_TREE_CSS",
            "nextTransform",
            "PDF_SOURCE",
            "TEX_SETUP_SOURCE",
            "roundedSpotlightPath",
            "updatePaperBlogSpotlight",
            "renderPdfPageCanvas",
            "refineContinuousPageCanvas",
            "trace",
            "mode",
            "backdropClassName",
          ],
        },
      ],
    },
  },
);
