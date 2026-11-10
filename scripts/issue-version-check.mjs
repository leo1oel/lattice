#!/usr/bin/env node
// A new issue filed from an older Lattice than the latest release gets one
// comment asking the reporter to update first, with what changed since: people
// often report a problem a newer release already fixed. Run by
// .github/workflows/issue-version-check.yml on `issues: opened`.
//
//   node scripts/issue-version-check.mjs [--dry-run]
//
// Reads ISSUE_NUMBER, ISSUE_TITLE and ISSUE_BODY, GITHUB_REPOSITORY
// (owner/name) and GH_TOKEN. It never closes or labels anything, and says
// nothing when the issue names no version, or names the latest or a later one
// (a build from source). --dry-run prints the comment instead of posting it.
//
// The issue's text is the reporter's; only a version number is taken from it.
// Release notes are ours, but quoted on another page, so their @mentions and
// #references are defused: they would notify people and cross-link pull
// requests from every outdated report.
import { parseArgs } from "node:util";
import { isMain } from "./lib/util.mjs";

const VERSION = /\bv?(\d+\.\d+\.\d+)\b/;
/** Releases listed before the rest become one link to the releases page. */
const MAX_RELEASES = 5;
const MAX_ITEMS = 6;

/**
 * The Lattice version an issue states: the bug form's "Lattice version" field
 * (which Help ▸ Report a Problem… fills in), or else "Lattice 0.16.9" /
 * "Lattice version: v0.16.9" written anywhere in the title or body. Null when
 * there is none, so the workflow stays silent.
 */
export function statedVersion(title = "", body = "") {
  const field = /^###\s*Lattice version\s*$([\s\S]*?)(?=^###\s|(?![\s\S]))/im.exec(body);
  if (field) {
    const match = VERSION.exec(field[1]);
    return match ? match[1] : null;
  }
  const loose = /(?:\blattice|版本)\s*(?:version\s*)?[:：]?\s*v?(\d+\.\d+\.\d+)\b/i.exec(`${title}\n${body}`);
  return loose ? loose[1] : null;
}

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` ("0.16.10" > "0.16.9"). */
export function compareVersions(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const difference = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

const defuse = (text) => text
  .replace(/\s*Thanks to [^.]*\./g, "")
  .replace(/@(?=[\w-])/g, "@\u200b")
  .replace(/#(?=\d)/g, "#\u200b");

/** The lines of one release's notes worth quoting: its notable fixes, or else its highlights' headlines. */
export function releaseItems(body = "") {
  const section = (heading) => {
    const match = new RegExp(`^##\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im").exec(body);
    return match ? match[1].split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).map((line) => line.replace(/^\s*[-*]\s+/, "").trim()) : [];
  };
  const fixes = section("Notable fixes");
  const items = fixes.length ? fixes : section("Highlights").map((line) => /^\*\*(.+?)\*\*/.exec(line)?.[1] ?? line);
  return items.slice(0, MAX_ITEMS).map(defuse);
}

/**
 * The comment for an issue stating `stated`, or null when it should get none.
 * `releases` is GitHub's list (newest first); drafts and prereleases are skipped.
 */
export function updateComment(stated, releases, repo) {
  const published = releases.filter((release) => !release.draft && !release.prerelease && VERSION.test(release.tag_name));
  const latest = published[0];
  if (!stated || !latest || compareVersions(stated, latest.tag_name) >= 0) return null;
  const newer = published.filter((release) => compareVersions(release.tag_name, stated) > 0);
  const listed = newer.slice(0, MAX_RELEASES).map((release) => {
    const items = releaseItems(release.body ?? "").map((item) => `  - ${item}`);
    return [`- [${release.tag_name}](${release.html_url})`, ...items].join("\n");
  });
  if (newer.length > MAX_RELEASES) {
    listed.push(`- …and ${newer.length - MAX_RELEASES} more in [all releases](https://github.com/${repo}/releases)`);
  }
  return [
    `Thanks for the report! It says Lattice **v${stated}**, and the latest release is **${latest.tag_name}**.`,
    "A newer release may already fix this, so please update first (Lattice ▸ Check for Updates…, or download it from the [latest release](" + latest.html_url + ")) and tell us here whether it still happens.",
    "",
    `Changed since v${stated}:`,
    "",
    ...listed,
    "",
    "<sub>This comment is automatic, posted once on issues filed from an older version.</sub>",
  ].join("\n");
}

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function main() {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
  const { ISSUE_NUMBER: number, ISSUE_TITLE: title, ISSUE_BODY: body, GITHUB_REPOSITORY: repo } = process.env;
  const stated = statedVersion(title ?? "", body ?? "");
  if (!stated) return console.log("No Lattice version stated; nothing to say.");
  const comment = updateComment(stated, await github(`repos/${repo}/releases?per_page=30`), repo);
  if (!comment) return console.log(`v${stated} is current (or newer); nothing to say.`);
  if (values["dry-run"]) return console.log(comment);
  await github(`repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body: comment }) });
  console.log(`Asked #${number} (v${stated}) to update first.`);
}

if (isMain(import.meta.url)) await main();
