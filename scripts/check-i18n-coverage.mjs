import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = path.join(root, "scripts/i18n-unlocalized-baseline.txt");
const catalogPath = path.join(root, "src/locales/zh-CN/messages.po");
const ruleId = "lingui/no-unlocalized-strings";
const failures = [];

// 1. Strings that bypass Lingui are caught by ESLint (`pnpm lint`), which runs
// `lingui/no-unlocalized-strings` as an error over all shipping code. Guard the
// guard: a config edit that narrows the rule's `files` or downgrades it would
// silently let English back into the zh-CN interface.
const eslint = new ESLint({ cwd: root });
const shippingFiles = (await readdir(path.join(root, "src"), { recursive: true }))
  .map((file) => path.posix.join("src", file.split(path.sep).join("/")))
  .filter((file) => /\.tsx?$/.test(file)
    && !/\.test\.tsx?$/.test(file)
    && file !== "src/platform/test-setup.ts"
    && !file.startsWith("src/locales/")
    && !file.startsWith("src/open-knowledge-app/")
    && !file.startsWith("src/open-knowledge-core/"));
for (const file of shippingFiles) {
  const config = await eslint.calculateConfigForFile(path.join(root, file));
  const severity = [config?.rules?.[ruleId]].flat()[0];
  if (severity !== 2 && severity !== "error") {
    failures.push(`${file}: ${ruleId} is not enforced as an error`);
  }
}

// 2. Strings that reach the catalog but were never really translated: a zh-CN
// entry must contain Chinese unless its source text is genuinely the same in
// every language (a product or format name). Those are listed, one source
// string per line, in the allowlist; an entry that no longer exists fails too,
// so the list only ever shrinks to what is still needed.
function parsePo(text) {
  const entries = [];
  let entry = null;
  let field = null;
  for (const line of text.split("\n")) {
    const start = line.match(/^(msgid|msgstr) (".*")$/);
    if (start) {
      if (start[1] === "msgid") entries.push(entry = { msgid: "", msgstr: "" });
      field = start[1];
      entry[field] = JSON.parse(start[2]);
    } else if (entry && field && line.startsWith("\"")) {
      entry[field] += JSON.parse(line);
    } else {
      field = null;
    }
  }
  return entries.filter((item) => item.msgid);
}

const allowed = new Set((await readFile(allowlistPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#")));
const entries = parsePo(await readFile(catalogPath, "utf8"));
const chinese = /[㐀-鿿]/;
for (const { msgid, msgstr } of entries) {
  // Placeholders and markup alone (`{count}`, `<0/>`) need no translation.
  if (allowed.has(msgid) || !/[A-Za-z]/.test(msgid.replace(/\{[^}]*\}|<\/?\d+\/?>/g, ""))) continue;
  if (!chinese.test(msgstr)) failures.push(`zh-CN has no Chinese translation for ${JSON.stringify(msgid)}`);
}
const catalogIds = new Set(entries.map((item) => item.msgid));
for (const msgid of allowed) {
  if (!catalogIds.has(msgid)) failures.push(`Allowlisted message is no longer in the catalog: ${JSON.stringify(msgid)}`);
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  console.error(`\n${failures.length} i18n coverage problem(s).`);
  console.error("Wrap user-facing text in a Lingui macro and translate it in src/locales/zh-CN/messages.po.");
  console.error(`Only text that reads the same in every language belongs in ${path.relative(root, allowlistPath)}.`);
  process.exitCode = 1;
} else {
  console.log(`i18n coverage guard: ${shippingFiles.length} files enforce ${ruleId}; ${entries.length} zh-CN messages translated (${allowed.size} allowlisted)`);
}
