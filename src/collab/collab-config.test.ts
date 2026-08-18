import { describe, expect, it } from "vitest";
import { collabDeploymentOrigin, isLocalCollabHost } from "./collab-config";

describe("collab deployment origins", () => {
  it("addresses a local sync host over plain HTTP, matching the ws:// the Yjs transport picks", () => {
    expect(collabDeploymentOrigin("localhost:8787")).toBe("http://localhost:8787");
    expect(collabDeploymentOrigin("127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(collabDeploymentOrigin("192.168.1.20:8787")).toBe("http://192.168.1.20:8787");
  });

  it("keeps every deployed host on HTTPS", () => {
    expect(collabDeploymentOrigin("lattice-collab.example.workers.dev")).toBe("https://lattice-collab.example.workers.dev");
    expect(collabDeploymentOrigin(" lattice-collab.example.workers.dev ")).toBe("https://lattice-collab.example.workers.dev");
    // A hostname that merely starts with a local-looking label is remote.
    expect(collabDeploymentOrigin("localhost.evil.example")).toBe("https://localhost.evil.example");
    expect(isLocalCollabHost("localhost.evil.example")).toBe(false);
  });

  it("honors an explicit scheme instead of overriding it", () => {
    expect(collabDeploymentOrigin("https://collab.example/")).toBe("https://collab.example");
    expect(collabDeploymentOrigin("http://localhost:8787/")).toBe("http://localhost:8787");
  });
});
