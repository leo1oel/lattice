import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** `test_model_endpoint` (`src-tauri/src/model_endpoint/probe.rs`). */
type ProbeCheck = "reach" | "key" | "model" | "stream" | "tools";
type ProbeProblem =
  | "unreachable" | "timeout" | "wrongAddress" | "keyRejected" | "modelNotFound" | "rateLimited"
  | "serverError" | "refused" | "toolsRejected" | "noStream" | "noToolCall" | "badResponse";

export type ProbeReport = {
  passed: ProbeCheck[];
  problem: ProbeProblem | null;
  status: number | null;
  /** The endpoint's own message, with the key taken out. */
  detail: string | null;
};

/** The steps the test ticks off, in the order a request reaches them. */
export const PROBE_CHECKS: ReadonlyArray<{ id: ProbeCheck; label: MessageDescriptor }> = [
  { id: "reach", label: msg`Reached the address` },
  { id: "key", label: msg`Key accepted` },
  { id: "model", label: msg`Model found` },
  { id: "stream", label: msg`Streams replies` },
  { id: "tools", label: msg`Calls tools` },
];

const PROBLEMS: Record<ProbeProblem, MessageDescriptor> = {
  unreachable: msg`Couldn’t reach the address. Check it, and your network or proxy.`,
  timeout: msg`The endpoint didn’t answer within 45 seconds.`,
  wrongAddress: msg`Nothing answers at that address. Check the address and the protocol.`,
  keyRejected: msg`The endpoint refused the key.`,
  modelNotFound: msg`The endpoint doesn’t know that model name.`,
  rateLimited: msg`The endpoint is rate-limiting this key. Try again later.`,
  serverError: msg`The endpoint had an error of its own. Try again later.`,
  refused: msg`The endpoint refused the request.`,
  toolsRejected: msg`The endpoint refused tool calls, which the agent needs to edit files.`,
  noStream: msg`The endpoint answered without streaming, which the agent needs.`,
  noToolCall: msg`The model answered but didn’t call the test tool. The agent may not manage to edit files with it.`,
  badResponse: msg`The endpoint’s answer wasn’t one the agent can read. Check the protocol.`,
};

/** What the test found, as one sentence. */
export function describeProbe(report: ProbeReport): { ok: boolean; message: MessageDescriptor } {
  if (!report.problem) return { ok: true, message: msg`Connected. The agent can use this model. Testing doesn’t save anything.` };
  return { ok: false, message: PROBLEMS[report.problem] };
}
