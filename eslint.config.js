import js from "@eslint/js";
import stylex from "@stylexjs/eslint-plugin";
import lingui from "eslint-plugin-lingui";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri/target"] },
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
      "@stylexjs": stylex,
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
      "@stylexjs/enforce-extension": ["error", { themeFileExtension: ".stylex.ts" }],
      "@stylexjs/no-conflicting-props": "error",
      "@stylexjs/no-legacy-contextual-styles": "error",
      "@stylexjs/no-lookahead-selectors": "error",
      "@stylexjs/no-nonstandard-styles": "error",
      "@stylexjs/no-unused": "error",
      "@stylexjs/valid-shorthands": "error",
      "@stylexjs/valid-styles": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
    },
  },
  {
    // Every visible string in shipping code goes through Lingui, so a zh-CN
    // interface never falls back to English. Lingui's strict catalog
    // compilation catches missing Chinese entries; this rule catches visible
    // strings that were never added to a catalog in the first place.
    //
    // The options below only exempt text that is not interface copy: product
    // and format names, implementation syntax (selectors, CSS, SVG paths,
    // shortcut glyphs), and the arguments of APIs that never render text. A
    // string that really is not UI but fits none of these (an Agent-facing
    // protocol message, a LaTeX template written into the user's document)
    // carries an `eslint-disable-next-line lingui/no-unlocalized-strings -- why`
    // at the site, so each exemption is reviewed where it lives.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/*.test.{ts,tsx}",
      "src/platform/test-setup.ts",
      "src/locales/**",
    ],
    rules: {
      // The Lingui rule trusts every attribute of a native DOM element except
      // `placeholder`, `alt`, `aria-label`, and `value`, so these other
      // user-visible attributes need their own check.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name=/^(?:title|label|aria-description|aria-roledescription|aria-valuetext|aria-placeholder)$/] > Literal[value=/[A-Za-z]{2}/]",
          message: "Visible attribute text must be translated: use t`…` from useLingui().",
        },
        {
          selector: "JSXAttribute[name.name=/^(?:title|label|aria-description|aria-roledescription|aria-valuetext|aria-placeholder)$/] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2}/]",
          message: "Visible attribute text must be translated: use t`…` from useLingui().",
        },
      ],
      "lingui/no-unlocalized-strings": [
        "error",
        {
          ignore: [
            // Product, service, and format names read the same in every locale.
            "^(?:Lattice|LATTICE|Overleaf|Synara|TexLab|Harper|Vim|Emacs|MCP|BasicTeX|TeX Live|MacTeX|pdfLaTeX|XeLaTeX|LuaLaTeX|BibTeX|biber|LaTeX|TeX|PDF|HTML|URL|DOI|arXiv|NeurIPS|ICML|ICLR|OpenAlex|Crossref|DBLP|Unpaywall|Semantic Scholar|Google Scholar|Firecrawl|Open Slide|Mermaid|KaTeX|Markdown|GitHub|Git)$",
            // Identifiers (including camelCase keys and ids), event names, MIME
            // types, and relative paths.
            "^[a-z][a-z0-9:+./_-]*$",
            "^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+[-_:.]?$",
            // CSS: custom properties, functions, values with units, media queries.
            "^--[\\w-]+$",
            "^(?:var|calc|min|max|clamp|translate|translate3d|translateX|translateY|scale|rotate|minmax|repeat|rgb|rgba|hsl|hsla|color-mix|url|cubic-bezier|steps)\\(.*\\)$",
            "^(?=.*\\d(?:px|ms|fr|rem|deg|vh|vw)\\b)!?(?:[-+]?[\\d.]+(?:px|ms|fr|rem|em|deg|vh|vw|%|s)?|[a-z][a-z-]*(?:\\([^)]*\\))?)(?:[\\s,/]+!?(?:[-+]?[\\d.]+(?:px|ms|fr|rem|em|deg|vh|vw|%|s)?|[a-z][a-z-]*(?:\\([^)]*\\))?))*$",
            "^(?:@media |\\((?:prefers-|pointer|hover|any-pointer|min-|max-|orientation))",
            // DOM selectors: class, id, attribute, and pseudo-class selectors.
            "^(?:[.#][\\w-]+|::?[a-z-]+(?:\\([^)]*\\))?|\\[[^\\]]+\\]|\\*|>)(?:[.#][\\w-]+|::?[a-z-]+(?:\\([^)]*\\))?|\\[[^\\]]+\\]|(?:\\s*[>+~,]\\s*|\\s+)(?:[a-z][\\w-]*|\\*|[.#][\\w-]+|::?[a-z-]+(?:\\([^)]*\\))?|\\[[^\\]]+\\]))*$",
            // SVG path data.
            "^[Mm][\\s,]*[-+.\\d][\\d\\s.,+\\-MmLlHhVvCcSsQqTtAaZz]*$",
            // LaTeX source: commands, environments, and templates written into
            // the user's document rather than shown as interface copy.
            "^\\\\(?:[a-zA-Z@]+\\*?|[\\\\,;:!{}\\[\\]()])",
            // Lone glyphs: Greek letters, accented letters, math and arrow symbols.
            "^[^\\x00-\\x7F\\u3000-\\u9fff\\uff00-\\uffef]{1,3}$",
            // Keyboard shortcut glyphs such as ⌘⇧L or ⌥↵.
            "^[⌘⇧⌥⌃]+(?:[\\w,./;'`=\\[\\]\\\\-]|F\\d{1,2}|[^\\x00-\\x7F\\u3000-\\u9fff]{1,2})$",
            // Absolute URLs and file globs.
            "^(?:https?://|mailto:)\\S*$",
            "^\\*?\\.[\\w.]+$",
          ],
          ignoreNames: [
            { regex: { pattern: "^(?:className|class|style|key|id|htmlFor|role|type|path|variant|size|side|align|href|src|rel|method|accept|autoComplete|inputMode|enterKeyHint|lang|dir|mode|layoutId|insert|template|mathPreview|codePreview|glyph|preview|snippet)$" } },
            { regex: { pattern: "^data-" } },
            { regex: { pattern: "(?:[cC]lass(?:Name)?(?:es|s)?|[sS]elector|[sS]tyles?|CSS|Css|Transform|_PATH|_SOURCE|Path)$" } },
            "HTML_PREVIEW_SCROLLBAR_STYLES",
            "PIERRE_TREE_CSS",
            "roundedSpotlightPath",
            "updatePaperBlogSpotlight",
            "renderPdfPageCanvas",
            "refineContinuousPageCanvas",
          ],
          ignoreFunctions: [
            "cn",
            "clsx",
            "cva",
            "twMerge",
            "console.*",
            "EditorView.theme",
            "EditorView.baseTheme",
            "invoke",
            "listen",
            "emit",
            "matchMedia",
            "window.matchMedia",
            "Symbol",
            "Symbol.for",
            "URL",
            "RegExp",
            "CustomEvent",
            "Event",
            "KeyboardEvent",
            "MouseEvent",
            "*.querySelector",
            "*.querySelectorAll",
            "*.closest",
            "*.matches",
            "*.setProperty",
            "*.getPropertyValue",
            "*.removeProperty",
            "*.setAttribute",
            "*.getAttribute",
            "*.hasAttribute",
            "*.removeAttribute",
            "*.toggleAttribute",
            "*.addEventListener",
            "*.removeEventListener",
            "*.createElement",
            "*.createElementNS",
            "*.getItem",
            "*.setItem",
            "*.removeItem",
            "*.startsWith",
            "*.endsWith",
            "*.indexOf",
            "*.lastIndexOf",
            "*.searchParams.set",
            "*.searchParams.get",
            "*.searchParams.append",
            "performance.mark",
            "performance.measure",
          ],
        },
      ],
    },
  },
  {
    // The visual Markdown editor is Lattice's own clean-room engine. Code from
    // Open Knowledge (inkeep/open-knowledge), which the earlier editor was
    // built on, must not come back in through an import; the repository guard
    // in src/platform/clean-room-guard.test.ts covers files and packages.
    files: ["**/*.{ts,tsx,js,mjs}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/open-knowledge*", "**/open-knowledge*/**", "@ok-app", "@ok-app/**", "@ok-core", "@ok-core/**", "@inkeep/**"],
          message: "Open Knowledge code must not return to Lattice (see docs/visual-editor-spec.md).",
        }],
      }],
    },
  },
);
