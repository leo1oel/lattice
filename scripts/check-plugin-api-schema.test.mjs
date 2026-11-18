import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { additiveProblems } from "./check-plugin-api-schema.mjs";

const level1 = JSON.parse(readFileSync("plugin-api/schema/level-1.json", "utf8"));
const copy = () => structuredClone(level1);

describe("check-plugin-api-schema", () => {
  it("accepts the committed schema against itself", () => {
    expect(additiveProblems(level1, copy())).toEqual([]);
  });

  it("accepts additions: a method, an optional field, a result kind, an enum value", () => {
    const next = copy();
    next.methods["project/listFiles"] = { direction: "pluginToHost", since: 2, params: { type: "object" }, result: { type: "object" } };
    next.$defs.Item.properties.icon = { type: "string" };
    next.$defs.CommandResult.oneOf.push({ type: "object", properties: { kind: { type: "string", const: "table" } }, required: ["kind"] });
    next.$defs.Severity.enum?.push("hint");
    expect(additiveProblems(level1, next)).toEqual([]);
  });

  it("rejects a removed method, field, variant or enum value", () => {
    const next = copy();
    delete next.methods["secrets/get"];
    delete next.$defs.Item.properties.subtitle;
    next.$defs.CommandResult.oneOf = next.$defs.CommandResult.oneOf.filter((v) => v.properties.kind.const !== "diagnostics");
    const problems = additiveProblems(level1, next).join("\n");
    expect(problems).toContain("method secrets/get: removed");
    expect(problems).toContain("#/$defs/Item.subtitle: removed");
    expect(problems).toContain("kind=diagnostics");
  });

  it("rejects a new required field and a changed type", () => {
    const next = copy();
    next.$defs.Item.required.push("detail");
    next.$defs.Position.properties.line = { type: "string" };
    const problems = additiveProblems(level1, next).join("\n");
    expect(problems).toContain("Item.detail: became required");
    expect(problems).toContain("Position.line: type integer became string");
  });

  it("rejects a manifest that narrows", () => {
    const next = copy();
    const manifest = next.$defs.Manifest;
    manifest.required.push("repository");
    expect(additiveProblems(level1, next).join("\n")).toContain("repository: became required");
  });
});
