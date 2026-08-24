import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "scripts/i18n-unlocalized-baseline.txt");
const ruleId = "lingui/no-unlocalized-strings";

function sourceOffset(source, line, column) {
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    offset = source.indexOf("\n", offset) + 1;
  }
  return offset + column - 1;
}

function diagnosticFingerprint(result, message) {
  const source = result.source ?? "";
  const start = sourceOffset(source, message.line, message.column);
  const end = message.endLine && message.endColumn
    ? sourceOffset(source, message.endLine, message.endColumn)
    : start;
  const relativePath = path.relative(root, result.filePath);
  return `${relativePath}\0${source.slice(start, end)}`;
}

// Scoped to shipping code. Development-only pages under `tools/` (the
// animated-icon playground) are never a build input and their labels are never
// translated, so holding them to this inventory would only add noise. Note the
// fingerprint below includes the file path: moving a file that has findings
// changes the digest even when no string changed.
const eslint = new ESLint({
  cwd: root,
  overrideConfig: [{
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/platform/test-setup.ts"],
    rules: {
      [ruleId]: ["warn", {
        ignore: [
          "^[^\\p{L}]+$",
          "^(?:Vim|Emacs|MCP|Overleaf|BasicTeX|pdfLaTeX|XeLaTeX|LuaLaTeX)$",
          "^[a-z][a-z0-9:+./_-]*$",
          // The loopback and Agent host bridges run before a saved locale is
          // available (or in a hidden host), so these are bootstrap diagnostics
          // and protocol constants rather than localized app UI.
          "^(?:The local Lattice app disconnected\\.|Could not connect to the local Lattice app\\.|The local Lattice app did not finish the browser handoff\\.|This workspace is open in your browser\\. It will return here when that browser tab closes\\.|This Lattice workspace is open in another browser tab\\.|This workspace is now open in the Lattice desktop app\\. If this tab did not close automatically, you can close it\\.|与本地 Lattice 应用的连接已断开。|本地 Lattice 应用未能完成浏览器切换。|此工作区已在浏览器中打开。关闭浏览器标签页后，它会自动返回这里。|此 Lattice 工作区已在另一个浏览器标签页中打开。|此工作区现已在 Lattice 桌面应用中打开。如果此标签页没有自动关闭，你可以手动关闭它。|The local Lattice entry returned .*|Open this page from the installed Lattice app to use its local tools\\.|Open a Lattice project before creating a document\\.|This shared project is read-only, so it cannot create documents\\.|The canvas did not open before the request expired:.*|The spreadsheet did not open before the request expired:.*|\\[Lattice browser host\\].*|__CHANNEL__:|plugin:event\\|unlisten|min-height:100vh;.*|position:fixed;inset:0;z-index:2147483647;.*)$",
        ],
      }],
    },
  }],
});
const results = await eslint.lintFiles(["src/**/*.{ts,tsx}"]);
const fingerprints = results.flatMap((result) => result.messages
  .filter((message) => message.ruleId === ruleId)
  .map((message) => diagnosticFingerprint(result, message)));
fingerprints.sort();
const digest = createHash("sha256").update(fingerprints.join("\n")).digest("hex");
const expected = (await readFile(baselinePath, "utf8")).trim();

if (digest !== expected) {
  console.error("Unlocalized string inventory changed.");
  console.error("Wrap new user-facing text in a Lingui macro and translate it in every catalog.");
  console.error("If this change intentionally migrates existing text, review the ESLint findings and update:");
  console.error(`  ${path.relative(root, baselinePath)} -> ${digest}`);
  process.exitCode = 1;
} else {
  console.log(`i18n coverage guard: ${fingerprints.length} legacy findings unchanged`);
}
