#!/usr/bin/env node
/**
 * The user guide (docs/guide/): English pages at its root, the same pages in
 * Simplified Chinese under zh-CN/, and the screenshots both use in images/.
 * The Markdown reads as it is on GitHub; this script also renders it to the
 * static pages the website serves at https://leo1oel.github.io/lattice/guide/
 * (published by .github/workflows/user-guide.yml), which Help ▸ User Guide
 * opens in both apps.
 *
 * Usage:
 *   node scripts/user-guide.mjs --check
 *       Every English page has its Chinese page and the other way round, and
 *       every link and image a page names exists. scripts/user-guide.test.ts
 *       runs the same check.
 *   node scripts/user-guide.mjs --out DIR
 *       Check, then render the site into DIR: README.md becomes index.html,
 *       every other page NAME.md becomes NAME.html, and images/ is copied.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { Marked } from "marked";
import { isMain, projectRoot } from "./lib/util.mjs";

export const GUIDE_DIR = join(projectRoot, "docs/guide");
const LANGUAGES = [
  { code: "en", dir: "", name: "English", title: "Lattice User Guide" },
  { code: "zh-CN", dir: "zh-CN", name: "简体中文", title: "Lattice 使用指南" },
];
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

const pagesIn = (dir) => readdirSync(join(GUIDE_DIR, dir)).filter((name) => name.endsWith(".md")).sort();

/** The file a page path becomes on the website: README.md is the folder's index. */
const htmlName = (path) => path.replace(/(^|\/)README\.md$/, "$1index.html").replace(/\.md$/, ".html");

/** Relative link and image targets as written, anchors dropped. */
function localTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (EXTERNAL.test(target) || target.startsWith("#")) continue;
    targets.push(target.split("#")[0]);
  }
  return targets;
}

/** What would break the guide on GitHub or on the website; empty when nothing would. */
export function checkGuide() {
  const problems = [];
  const [english, chinese] = LANGUAGES.map((language) => pagesIn(language.dir));
  for (const page of english) if (!chinese.includes(page)) problems.push(`zh-CN/${page} is missing (the Chinese page of ${page})`);
  for (const page of chinese) if (!english.includes(page)) problems.push(`${page} is missing (the English page of zh-CN/${page})`);
  const usedImages = new Set();
  for (const language of LANGUAGES) {
    for (const page of pagesIn(language.dir)) {
      const path = posix.join(language.dir, page);
      for (const target of localTargets(readFileSync(join(GUIDE_DIR, path), "utf8"))) {
        const resolved = join(GUIDE_DIR, language.dir, target);
        const inGuide = relative(GUIDE_DIR, resolved);
        if (inGuide.startsWith("..")) problems.push(`${path} links to ${target}, outside the guide, which the website does not carry`);
        else if (!existsSync(resolved)) problems.push(`${path} links to ${target}, which does not exist`);
        else if (inGuide.startsWith("images/")) usedImages.add(inGuide);
      }
    }
  }
  for (const image of readdirSync(join(GUIDE_DIR, "images"))) {
    if (!usedImages.has(`images/${image}`)) problems.push(`images/${image} is not used by any page`);
  }
  return problems;
}

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** GitHub's heading anchors, so a link to page.md#section works in both places. */
const slug = (html) => html.replace(/<[^>]+>/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");

function renderer() {
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if ((token.type === "link" || token.type === "image") && !EXTERNAL.test(token.href) && !token.href.startsWith("#")) {
        const [path, hash] = token.href.split("#");
        token.href = htmlName(path) + (hash ? `#${hash}` : "");
      }
    },
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${slug(inner)}">${inner}</h${depth}>\n`;
      },
    },
  });
  return marked;
}

/** The contents page's links in order: the navigation every page in that language shows. */
function contents(language) {
  const readme = readFileSync(join(GUIDE_DIR, language.dir, "README.md"), "utf8");
  const pages = [...readme.matchAll(/^\s*(?:\d+\.|-)\s+\[([^\]]+)\]\(([^)#\s]+\.md)\)/gm)].map((match) => ({ title: match[1], page: match[2] }));
  return [{ title: language.title, page: "README.md" }, ...pages];
}

function pageHtml({ language, page, body, nav }) {
  const heading = body.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, "") ?? language.title;
  const title = heading === language.title ? heading : `${heading} · ${language.title}`;
  const other = LANGUAGES.find((candidate) => candidate !== language);
  const toRoot = language.dir ? "../" : "";
  const otherHref = `${toRoot}${other.dir ? `${other.dir}/` : ""}${htmlName(page)}`;
  const links = nav.map((entry) => {
    const current = entry.page === page ? ' aria-current="page"' : "";
    return `<li><a href="${htmlName(entry.page)}"${current}>${escapeHtml(entry.title)}</a></li>`;
  }).join("");
  return `<!doctype html>
<html lang="${language.code}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><a class="home" href="${toRoot}../">Lattice</a><a class="language" href="${otherHref}" hreflang="${other.code}" lang="${other.code}">${other.name}</a></header>
<div class="layout">
<nav><ol>${links}</ol></nav>
<main>
${body}</main>
</div>
</body>
</html>
`;
}

const STYLE = `
:root { color-scheme: light dark; --text: #1f2328; --muted: #59636e; --line: #d8dbd2; --surface: #f4f5f0; --accent: #556324; --background: #fff; }
@media (prefers-color-scheme: dark) { :root { --text: #e6e6e3; --muted: #9a9a95; --line: #3a3a37; --surface: #252523; --accent: #b5c47a; --background: #181817; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--background); color: var(--text); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
header { display: flex; gap: 20px; align-items: baseline; padding: 14px 28px; border-bottom: 1px solid var(--line); }
header a { color: var(--text); text-decoration: none; }
header .home { font-weight: 650; }
header .language { margin-left: auto; color: var(--muted); }
.layout { display: grid; grid-template-columns: 220px minmax(0, 800px); gap: 44px; padding: 28px; }
nav ol { list-style: none; margin: 0; padding: 0; position: sticky; top: 28px; }
nav a { display: block; padding: 4px 10px; border-radius: 6px; color: var(--muted); text-decoration: none; }
nav a:hover { color: var(--text); }
nav a[aria-current] { background: var(--surface); color: var(--text); font-weight: 600; }
main h1 { font-size: 30px; line-height: 1.25; margin: 0 0 18px; }
main h2 { font-size: 21px; margin: 36px 0 10px; padding-top: 10px; border-top: 1px solid var(--line); }
main h3 { font-size: 17px; margin: 26px 0 8px; }
main a { color: var(--accent); }
main img { max-width: 100%; border: 1px solid var(--line); border-radius: 10px; margin: 8px 0; }
main code, main kbd { font: 13.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--surface); border-radius: 4px; padding: 1px 5px; }
main pre { background: var(--surface); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
main pre code { padding: 0; }
main table { border-collapse: collapse; margin: 12px 0; }
main th, main td { border: 1px solid var(--line); padding: 6px 12px; text-align: left; vertical-align: top; }
main blockquote { margin: 12px 0; padding: 2px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
@media (max-width: 860px) { .layout { grid-template-columns: 1fr; gap: 20px; } nav ol { position: static; } }
`;

/** Render the guide into `out`, replacing whatever is there. */
export function renderGuide(out) {
  rmSync(out, { recursive: true, force: true });
  const marked = renderer();
  for (const language of LANGUAGES) {
    const nav = contents(language);
    mkdirSync(join(out, language.dir), { recursive: true });
    for (const page of pagesIn(language.dir)) {
      const body = marked.parse(readFileSync(join(GUIDE_DIR, language.dir, page), "utf8"));
      writeFileSync(join(out, language.dir, htmlName(page)), pageHtml({ language, page, body, nav }));
    }
  }
  cpSync(join(GUIDE_DIR, "images"), join(out, "images"), { recursive: true });
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  if (outIndex < 0 && !args.includes("--check")) {
    console.error("Usage: node scripts/user-guide.mjs --check | --out DIR");
    process.exit(2);
  }
  const problems = checkGuide();
  if (problems.length > 0) {
    console.error(`The user guide has ${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  if (outIndex >= 0) {
    const out = args[outIndex + 1];
    if (!out) throw new Error("--out needs a directory");
    renderGuide(out);
    console.log(`Rendered the user guide into ${out}.`);
  } else {
    console.log("The user guide's pages, translations, links and images check out.");
  }
}
