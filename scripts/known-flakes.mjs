#!/usr/bin/env node
// Records a CI flake in the "Known flakes" issue, the one place a worker looks
// a red check up before investigating it (docs/agent-validation.md, "A failed
// check"). Two workflows call it:
//
//   flake-rerun.yml  a CI run on main failed, its failed jobs were re-run once
//                    and passed; `--kind rerun` records what failed the first
//                    time. A run that fails twice is not recorded: it is red.
//   flake-hunt.yml   the nightly stress pass failed; `--kind hunt`.
//
//   node scripts/known-flakes.mjs --run <run id> --attempt <n> --kind rerun|hunt [--dry-run]
//
// Needs GH_TOKEN and GITHUB_REPOSITORY (owner/name). --dry-run prints the
// comment instead of posting it. Each event is one comment, so concurrent
// runs never overwrite each other, and a test recorded twice within a week is
// flagged for quarantine as the issue's policy asks.
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const LABEL = "known-flakes";
const TITLE = "Known flakes";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A failed job whose log names more checks than this broke for a reason no
// flake explains (a broken install, a bad merge); list the first few.
const MAX_PER_JOB = 5;

/**
 * The failing checks a job log names, in order and without repeats: Vitest
 * test ids, Rust test paths, perf-bench layout checks and ceilings. GitHub
 * prefixes every log line with a timestamp, and the runners colour their
 * output, so both are stripped first.
 */
export function failuresInLog(log) {
  const found = new Set();
  for (const raw of log.split("\n")) {
    // eslint-disable-next-line no-control-regex -- matches ANSI colour codes (ESC [ … m)
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "").trimEnd();
    const match =
      // Vitest's summary: ` FAIL  src/a.test.tsx > suite > test`
      /^\s*FAIL\s+(\S+\.test\.\S+(?: > .+)?)$/.exec(line) ??
      // cargo test: `test synara::tests::name ... FAILED`
      /^test (\S+) \.\.\. FAILED$/.exec(line) ??
      // perf-bench --layout: `pdf-live-drag-copy: FAILED, the drag …`
      /^([\w-]+): FAILED, /.exec(line);
    if (match) found.add(match[1]);
    // perf-bench --check: `  <scenario> <count>: 13003 exceeds ceiling 12910`
    const ceiling = /^\s+(.+): \d+ exceeds ceiling \d+$/.exec(line);
    if (ceiling) found.add(`perf-bench ceiling: ${ceiling[1]}`);
  }
  return [...found];
}

/** Times `check` was recorded in the issue's comments within the last week. */
export function recentSightings(comments, check, now) {
  return comments.filter((comment) =>
    now - Date.parse(comment.created_at) < WEEK_MS && comment.body.includes(`\`${check}\``)).length;
}

function api(repo, token) {
  const request = async (path, init = {}) => {
    const response = await fetch(path.startsWith("https://") ? path : `https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
    return response;
  };
  const all = async (path, key) => {
    const items = [];
    for (let url = path; url;) {
      const response = await request(url);
      const page = await response.json();
      items.push(...(key ? page[key] : page));
      url = /<([^>]+)>; rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    }
    return items;
  };
  return { request, all };
}

async function findOrCreateIssue(gh, dryRun) {
  const [issue] = await gh.all(`/issues?state=open&labels=${LABEL}&per_page=100`);
  if (issue) return issue;
  if (dryRun) return { number: 0, html_url: "(would create the Known flakes issue)" };
  const response = await gh.request("/issues", {
    method: "POST",
    body: JSON.stringify({ title: TITLE, labels: [LABEL], body: "Flakes recorded by flake-rerun.yml and flake-hunt.yml." }),
  });
  return response.json();
}

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      attempt: { type: "string", default: "1" },
      kind: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const { run, attempt, kind } = values;
  const dryRun = values["dry-run"];
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!run || !repo || !token || (kind !== "rerun" && kind !== "hunt")) {
    throw new Error("usage: GH_TOKEN=… GITHUB_REPOSITORY=owner/name known-flakes.mjs --run <id> --attempt <n> --kind rerun|hunt [--dry-run]");
  }
  const gh = api(repo, token);

  const details = await (await gh.request(`/actions/runs/${run}`)).json();
  const jobs = await gh.all(`/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`, "jobs");
  // A sharded check's reporting job (`perf-bench` for `perf-bench (1/2)`)
  // fails only because a shard did, and its log names nothing.
  const failed = jobs.filter((job, _, all) => job.conclusion === "failure" &&
    !all.some((shard) => shard.conclusion === "failure" && shard.name.startsWith(`${job.name} (`)));
  if (failed.length === 0) {
    console.log(`run ${run} attempt ${attempt} has no failed job; nothing to record`);
    return;
  }

  const issue = await findOrCreateIssue(gh, dryRun);
  const comments = issue.number ? await gh.all(`/issues/${issue.number}/comments?per_page=100`) : [];
  const now = Date.now();
  const lines = [];
  for (const job of failed) {
    // A log is only readable once its job finished, which a failed job has.
    const log = await (await gh.request(`/actions/jobs/${job.id}/logs`)).text();
    const checks = failuresInLog(log);
    if (checks.length === 0) {
      lines.push(`- \`${job.name}\`: no test named in [the log](${job.html_url}); read it from the first error`);
      continue;
    }
    for (const check of checks.slice(0, MAX_PER_JOB)) {
      const seen = recentSightings(comments, check, now) + 1;
      const flag = seen >= 2 ? ` — **seen ${seen} times in 7 days: quarantine it** (policy above)` : "";
      lines.push(`- \`${job.name}\`: \`${check}\`${flag}`);
    }
    if (checks.length > MAX_PER_JOB) lines.push(`- \`${job.name}\`: ${checks.length - MAX_PER_JOB} more in [the log](${job.html_url})`);
  }

  const what = kind === "rerun"
    ? `**Flaky on main**: attempt ${attempt} failed, the re-run of its failed jobs passed`
    : "**Failed in the nightly flake hunt**";
  const body = `${what} · [run ${run}](${details.html_url}/attempts/${attempt}) · \`${details.head_sha.slice(0, 7)}\`\n\n${lines.join("\n")}\n`;

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\nRecorded in ${issue.html_url}\n`);
  if (dryRun) {
    console.log(`would comment on ${issue.html_url}:\n\n${body}`);
    return;
  }
  const comment = await (await gh.request(`/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body }) })).json();
  console.log(`recorded: ${comment.html_url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
