// Executed from the workflow's trusted commit, never from the downloaded artifact.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { checkWindowsPackage, releaseSource } from "./lib/windows-package.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const source = releaseSource(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), repository);
const directory = resolve(process.argv[2]);
const names = checkWindowsPackage(directory, source);
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) throw new Error(`GitHub ${options.method ?? "GET"} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const release = await api(`releases/tags/${encodeURIComponent(source.tag)}`);
if (release.draft || release.tag_name !== source.tag) throw new Error("Expected an already published release");
let object = (await api(`git/ref/tags/${encodeURIComponent(source.tag)}`)).object;
for (let depth = 0; object.type === "tag" && depth < 5; depth++) object = (await api(`git/tags/${object.sha}`)).object;
if (object.type !== "commit" || object.sha !== source.sha) throw new Error("Release tag no longer matches the checked source commit");

for (const name of Object.values(names)) {
  // These four exact versioned names can never overwrite latest.json or a Mac/Linux asset.
  const previous = release.assets.filter((asset) => asset.name === name);
  for (const asset of previous) await api(`releases/assets/${asset.id}`, { method: "DELETE" });
  const label = name === names.installer ? "Experimental Windows x64 installer (unsigned)" : `Experimental Windows x64 — ${name}`;
  const url = new URL(release.upload_url.replace(/\{.*$/, ""));
  if (url.origin !== "https://uploads.github.com") throw new Error("Unexpected GitHub upload host");
  url.searchParams.set("name", name);
  url.searchParams.set("label", label);
  const response = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: readFileSync(join(directory, name)) });
  if (!response.ok) throw new Error(`Upload ${name}: ${response.status}`);
  console.log(`Attached ${name} to ${source.tag}`);
}
