/**
 * License texts recovered from a package's upstream repository, for packages
 * whose published artifact declares a license but omits its text.
 *
 * Most of them are crates: `cargo package` only includes a LICENSE file that
 * sits in the crate's own directory, so every crate in a workspace whose
 * license lives at the repository root publishes without one. The text exists
 * — it is just one directory up, in Git, at the commit the crate was published
 * from.
 *
 * `pnpm notices --fetch-upstream` fetches those files once and writes them
 * under `licenses/upstream/<registry>/<name>@<version>/`, together with a
 * `source.json` recording where each came from. From then on the generator
 * reads them off disk like any other notice, so `--check` stays offline and
 * gives the same answer on every machine. Nothing here invents a text: a file
 * is only ever the verbatim content of the upstream repository.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

const UPSTREAM_ROOT = "licenses/upstream";

/** Which registry a closure's packages come from; the sidecar and Open Slide runtimes are npm trees. */
export const registryOf = (closure) => (closure === "crates" ? "crates" : "npm");

/** `licenses/upstream/npm/@scope/name@1.0.0`, `licenses/upstream/crates/ndk-sys@0.6.0+11769913`. */
const upstreamDir = (registry, name, version) => posix.join(UPSTREAM_ROOT, registry, `${name}@${version}`);

/**
 * Broader than the generator's own pattern because a repository is not a
 * package root: `MIT-License.txt` and `LICENSE_APACHE` are common there.
 */
const UPSTREAM_NOTICE_FILE = /^([a-z0-9]+[-_.])?(licen[cs]e|copying|copyright|notice|unlicen[cs]e)([-._ ].*)?$/i;

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * What --fetch-upstream recorded for one package, or null when it was never
 * looked up. `source.unresolved` is the reason a lookup found no text; else
 * `files` are the absolute paths of the texts it fetched.
 */
export function readUpstream(projectRoot, registry, name, version) {
  const dir = join(projectRoot, upstreamDir(registry, name, version));
  const source = readJsonFile(join(dir, "source.json"));
  if (!source) return null;
  const files = (source.files ?? []).map((file) => join(dir, posix.basename(file)));
  return { source, files };
}

const listDirectories = (dir) => {
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
  } catch {
    return [];
  }
};

/** Every package recorded on disk, as `registry/name@version`, for spotting stale entries. */
export function listUpstream(projectRoot) {
  const ids = [];
  for (const registry of ["crates", "npm"]) {
    const root = join(projectRoot, UPSTREAM_ROOT, registry);
    for (const name of listDirectories(root)) {
      if (!name.startsWith("@")) ids.push(`${registry}/${name}`);
      else for (const child of listDirectories(join(root, name))) ids.push(`${registry}/${name}/${child}`);
    }
  }
  return ids.sort();
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** owner/repo and an optional path from any of the URL shapes package manifests use. */
function parseGitHubRepository(url) {
  if (typeof url !== "string") return null;
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/, ""), path: "" };
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/[^/]+\/(.+?))?\/?(?:#.*)?$/.exec(url.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], path: match[3] ?? "" };
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function createGitHub() {
  const token = githubToken();
  const headers = { accept: "application/vnd.github+json", "user-agent": "lattice-generate-notices" };
  if (token) headers.authorization = `Bearer ${token}`;
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/${path}`, { headers });
    if (response.status === 404 || response.status === 422) return null;
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
    return response.json();
  };
  return {
    /** The commit a ref names, or null when the repository has no such ref. */
    async commit(owner, repo, ref) {
      const result = await api(`repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
      return result?.sha ?? null;
    },
    async defaultBranch(owner, repo) {
      return (await api(`repos/${owner}/${repo}`))?.default_branch ?? null;
    },
    async list(owner, repo, path, sha) {
      const result = await api(`repos/${owner}/${repo}/contents/${path}?ref=${sha}`);
      return Array.isArray(result) ? result : null;
    },
    async raw(owner, repo, path, sha) {
      const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`);
      if (!response.ok) throw new Error(`raw ${owner}/${repo}@${sha}/${path}: HTTP ${response.status}`);
      return response.text();
    },
  };
}

/**
 * Crates that name no repository anywhere — not in their manifest, not on
 * crates.io — but whose `.cargo_vcs_info.json` commit exists in this one.
 */
const KNOWN_REPOSITORIES = new Map([
  // The -sys half of libappindicator, published from the `sys/` directory of its repository.
  ["libappindicator-sys", "https://github.com/tauri-apps/libappindicator-rs"],
]);

/** crates.io knows a repository for some crates whose own manifest omits it. */
async function cratesIoRepository(name) {
  const response = await fetch(`https://crates.io/api/v1/crates/${name}`, { headers: { "user-agent": "lattice-generate-notices" } });
  return response.ok ? (await response.json()).crate?.repository ?? null : null;
}

async function npmManifest(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`);
  if (!response.ok) throw new Error(`npm registry ${name}@${version}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Where a package's source lives and which commit it was published from.
 * Published metadata pins the commit for most packages — `.cargo_vcs_info.json`
 * for crates, `gitHead` for npm — and a release tag for the rest. Only when
 * neither exists does it fall back to the default branch, and that is recorded
 * so the notices can say the text is not from the exact release.
 */
async function locate(github, task) {
  let repositoryUrl = task.repository;
  let path = "";
  let sha = null;
  let via = "";
  if (task.registry === "crates") {
    const vcs = task.dir ? readJsonFile(join(task.dir, ".cargo_vcs_info.json")) : null;
    if (vcs?.git?.sha1) {
      sha = vcs.git.sha1;
      path = vcs.path_in_vcs ?? "";
      via = "the commit recorded in the crate's .cargo_vcs_info.json";
    }
    repositoryUrl ||= KNOWN_REPOSITORIES.get(task.name) ?? await cratesIoRepository(task.name);
  } else {
    const manifest = await npmManifest(task.name, task.version);
    repositoryUrl = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    path = manifest.repository?.directory ?? "";
    if (manifest.gitHead) {
      sha = manifest.gitHead;
      via = "the gitHead recorded in the npm package";
    }
  }
  const repository = parseGitHubRepository(repositoryUrl);
  if (!repository) return { error: `repository ${repositoryUrl ? `\`${repositoryUrl}\` is not on GitHub` : "is not declared"}` };
  const { owner, repo } = repository;
  path ||= repository.path;

  if (sha && !(await github.commit(owner, repo, sha))) {
    sha = null; // a gitHead from an unpushed commit, or history rewritten since.
  }
  if (!sha) {
    const shortName = task.name.replace(/^@[^/]+\//, "");
    const tags = [`v${task.version}`, task.version, `${task.name}@${task.version}`, `${shortName}@${task.version}`, `${shortName}-v${task.version}`, `${shortName}-${task.version}`];
    for (const tag of [...new Set(tags)]) {
      sha = await github.commit(owner, repo, tag);
      if (sha) {
        via = `the release tag \`${tag}\``;
        break;
      }
    }
  }
  return { owner, repo, path: path.replace(/^\/+|\/+$/g, ""), sha, via };
}

/** The nearest directory on the path from `start` to the root that holds license files. */
async function findLicenseFiles(github, owner, repo, start, sha) {
  for (let dir = start; ; dir = posix.dirname(dir) === "." ? "" : posix.dirname(dir)) {
    const listing = await github.list(owner, repo, dir, sha);
    const matches = (listing ?? []).filter((entry) => entry.type === "file" && UPSTREAM_NOTICE_FILE.test(entry.name));
    if (matches.length > 0) return matches.sort((a, b) => a.name.localeCompare(b.name, "en"));
    if (!dir) return [];
  }
}

/**
 * Fetch the license files for one package: those in its own directory of the
 * repository, else the nearest parent directory that has any, up to the root.
 *
 * The release's own commit comes first. Only when that has no license file, or
 * nothing identifies the release, is the default branch read — a LICENSE added
 * after the release is still the author's statement of the terms — and the
 * result is marked unpinned so the notices say so.
 */
async function fetchOne(github, task) {
  const location = await locate(github, task);
  if (location.error) return location;
  const { owner, repo } = location;
  let { sha, via } = location;
  let pinned = Boolean(sha);
  let matches = sha ? await findLicenseFiles(github, owner, repo, location.path, sha) : [];
  if (matches.length === 0) {
    const branch = await github.defaultBranch(owner, repo);
    const head = branch ? await github.commit(owner, repo, branch) : null;
    if (!head) return { error: `https://github.com/${owner}/${repo} could not be read`, transient: true };
    matches = await findLicenseFiles(github, owner, repo, location.path, head);
    if (matches.length === 0) {
      return { error: `https://github.com/${owner}/${repo} has no license file on the path to \`${location.path || "/"}\`${sha ? ", at the release or on its default branch" : " of its default branch, and no commit or tag identifies the release"}` };
    }
    via = sha
      ? `the default branch \`${branch}\` at fetch time — the release commit (${via}) has no license file`
      : `the default branch \`${branch}\` at fetch time — no commit or tag identifies this release`;
    sha = head;
    pinned = false;
  }
  const files = [];
  for (const entry of matches) files.push({ path: entry.path, text: await github.raw(owner, repo, entry.path, sha) });
  return { owner, repo, sha, pinned, via, files };
}

/**
 * Fetch and write the recovered texts for `tasks`
 * (`{ registry, name, version, dir?, repository? }`). Returns the failures,
 * each with the reason, so the caller can report what stays unresolved.
 */
export async function fetchUpstream(projectRoot, tasks, { log }) {
  const github = createGitHub();
  const failures = [];
  const queue = [...tasks];
  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      const id = `${task.name}@${task.version}`;
      let result;
      try {
        result = await fetchOne(github, task);
      } catch (error) {
        result = { error: error.message, transient: true };
      }
      const dir = join(projectRoot, upstreamDir(task.registry, task.name, task.version));
      if (result.error) {
        failures.push({ ...task, reason: result.error });
        log(`  not found   ${id} (${task.registry}) — ${result.error}`);
        // A definite answer is recorded so the notices can give the reason and
        // the next fetch does not ask again; a network failure is not.
        if (!result.transient) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "source.json"), `${JSON.stringify({ unresolved: result.error }, null, 2)}\n`);
        }
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const file of result.files) writeFileSync(join(dir, posix.basename(file.path)), file.text);
      const source = {
        repository: `https://github.com/${result.owner}/${result.repo}`,
        commit: result.sha,
        pinned: result.pinned,
        via: result.via,
        files: result.files.map((file) => file.path),
      };
      writeFileSync(join(dir, "source.json"), `${JSON.stringify(source, null, 2)}\n`);
      log(`  fetched     ${id} (${task.registry}) — ${source.files.join(", ")}${result.pinned ? "" : " [default branch]"}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return failures.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
}
