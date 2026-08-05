import { invoke, isTauri } from "@tauri-apps/api/core";

export interface CollabCredentialStore {
  put(ref: string, secret: string, projectInstanceId: string, deployment: string): Promise<void>;
  get(ref: string, projectInstanceId: string, deployment: string): Promise<string | null>;
  delete(ref: string, projectInstanceId: string, deployment: string): Promise<void>;
  readonly persistent: boolean;
}

export function createCredentialRef(): string {
  return `cred_${crypto.randomUUID().replaceAll("-", "")}`;
}

export class NativeCollabCredentialStore implements CollabCredentialStore {
  readonly persistent = true;
  put(ref: string, secret: string, projectInstanceId: string, deployment: string): Promise<void> {
    return invoke("put_collab_credential", { credentialRef: ref, secret, projectInstanceId, deployment });
  }
  get(ref: string, projectInstanceId: string, deployment: string): Promise<string | null> {
    return invoke("get_collab_credential", { credentialRef: ref, projectInstanceId, deployment });
  }
  delete(ref: string, projectInstanceId: string, deployment: string): Promise<void> {
    return invoke("delete_collab_credential", { credentialRef: ref, projectInstanceId, deployment });
  }
}

export class MemoryCollabCredentialStore implements CollabCredentialStore {
  readonly persistent = false;
  private values = new Map<string, string>();
  private key(ref: string, project: string, deployment: string) { return `${deployment}\0${project}\0${ref}`; }
  async put(ref: string, secret: string, project: string, deployment: string) { this.values.set(this.key(ref, project, deployment), secret); }
  async get(ref: string, project: string, deployment: string) { return this.values.get(this.key(ref, project, deployment)) ?? null; }
  async delete(ref: string, project: string, deployment: string) { this.values.delete(this.key(ref, project, deployment)); }
}

const webSessionStore = new MemoryCollabCredentialStore();
export function collabCredentialStore(): CollabCredentialStore {
  return isTauri() ? new NativeCollabCredentialStore() : webSessionStore;
}
