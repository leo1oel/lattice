import { beforeEach, describe, expect, it } from "vitest";
import { createCredentialRef, MemoryCollabCredentialStore } from "./collab-credentials";

describe("v2 secure credential adapter", () => {
  beforeEach(() => localStorage.clear());

  it("keeps web credentials in memory and never localStorage", async () => {
    const store = new MemoryCollabCredentialStore();
    const ref = createCredentialRef();
    await store.put(ref, "host-secret", "project_0123456789", "production");
    expect(await store.get(ref, "project_0123456789", "production")).toBe("host-secret");
    expect(JSON.stringify(localStorage)).not.toContain("host-secret");
    await store.delete(ref, "project_0123456789", "production");
    expect(await store.get(ref, "project_0123456789", "production")).toBeNull();
    expect(store.persistent).toBe(false);
  });

  it("binds a credential ref to project and deployment", async () => {
    const store = new MemoryCollabCredentialStore();
    await store.put("cred_ref", "secret", "project-a", "prod");
    expect(await store.get("cred_ref", "project-b", "prod")).toBeNull();
    expect(await store.get("cred_ref", "project-a", "staging")).toBeNull();
  });
});
