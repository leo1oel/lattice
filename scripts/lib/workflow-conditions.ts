// GitHub Actions job and step conditions, evaluated in tests. The release
// workflows that only ever run for a tag (linux-appimage.yml, macos-intel.yml)
// cannot be exercised by a pull request, so their tests run the workflow's own
// conditions against the events GitHub sends it and check which jobs and steps
// would run.
type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps?: Step[] };
export type Workflow = { name: string; on: Record<string, { workflows?: string[]; types?: string[] } | null>; permissions?: Record<string, string>; env?: Record<string, string>; jobs: Record<string, Job> };

export type Value = string | number | boolean | null | { [key: string]: Value };

/**
 * GitHub Actions expressions, as far as these workflows use them: property
 * paths, single-quoted strings, integers, `!`, `==`, `!=`, `&&`, `||`,
 * parentheses and `startsWith`. As GitHub documents it, `&&` and `||` yield an operand, a
 * missing property is null, and strings compare ignoring case.
 */
function evaluate(source: string, context: Record<string, Value>): Value {
  const tokens = source.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .match(/'(?:[^']|'')*'|&&|\|\||==|!=|[()!,]|[\w.-]+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (expected !== undefined && token !== expected) throw new Error(`expected ${expected} in ${source}, found ${token}`);
    return token;
  };
  const truthy = (value: Value) => value !== null && value !== false && value !== 0 && value !== "";
  const fold = (value: Value) => (typeof value === "string" ? value.toLowerCase() : value);
  const primary = (): Value => {
    const token = take();
    if (token === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token === "!") return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    if (/^\d+$/.test(token)) return Number(token);
    if (token === "startsWith") {
      take("(");
      const text = or();
      take(",");
      const prefix = or();
      take(")");
      return String(fold(text)).startsWith(String(fold(prefix)));
    }
    return token.split(".").reduce<Value>((value, key) => (value !== null && typeof value === "object" ? value[key] ?? null : null), context);
  };
  const equality = (): Value => {
    let left = primary();
    while (peek() === "==" || peek() === "!=") {
      const negate = take() === "!=";
      left = (fold(left) === fold(primary())) !== negate;
    }
    return left;
  };
  const and = (): Value => {
    let left = equality();
    while (peek() === "&&") {
      take();
      const right = equality();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const or = (): Value => {
    let left = and();
    while (peek() === "||") {
      take();
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`could not read ${source} past ${tokens[at]}`);
  return value;
}

/** An `env` value: an expression interpolated into a string, as GitHub writes one. */
const interpolate = (value: string, context: Record<string, Value>) =>
  value.includes("${{") ? String(evaluate(value, context)) : value;

/**
 * The jobs and steps of `workflow` that run for one event. A job runs when
 * every job it needs ran and its `if` holds, GitHub's default for a job
 * without a status function.
 */
export function runWorkflow(workflow: Workflow, github: Record<string, Value>, secrets: Record<string, string>) {
  const base = { github, secrets };
  const env = Object.fromEntries(Object.entries(workflow.env ?? {}).map(([key, value]) => [key, interpolate(value, base)]));
  const context = { ...base, env };
  const ran = new Set<string>();
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const needs = [job.needs ?? []].flat();
    if (needs.every((need) => ran.has(need)) && (job.if === undefined || evaluate(job.if, context))) ran.add(name);
  }
  const step = (job: string, name: string) => {
    const found = workflow.jobs[job].steps?.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`${job} has no step named ${name}`);
    const runs = ran.has(job) && (found.if === undefined || Boolean(evaluate(found.if, context)));
    return { runs, env: Object.fromEntries(Object.entries(found.env ?? {}).map(([key, value]) => [key, interpolate(value, context)])) };
  };
  return { jobs: [...ran], env, step };
}
