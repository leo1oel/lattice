export const LATTICE_COMPOSER_FILES = "lattice:composer-files";

/** Mirrors the caps the embedded panel enforces when validating the message. */
export const MAX_AGENT_COMPOSER_FILES = 20;
export const MAX_AGENT_COMPOSER_FILE_BYTES = 64 * 1024 * 1024;

/** Shape returned by the `read_agent_composer_files` Tauri command. */
export interface AgentComposerFilePayload {
  name: string;
  mimeType: string;
  bytesBase64: string;
}

export interface AgentComposerFileEntry {
  name: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

export interface AgentComposerFilesMessage {
  type: typeof LATTICE_COMPOSER_FILES;
  version: 1;
  files: AgentComposerFileEntry[];
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function buildAgentComposerFilesMessage(
  payloads: readonly AgentComposerFilePayload[],
): AgentComposerFilesMessage {
  return {
    type: LATTICE_COMPOSER_FILES,
    version: 1,
    files: payloads.slice(0, MAX_AGENT_COMPOSER_FILES).map((payload) => ({
      name: payload.name,
      mimeType: payload.mimeType,
      bytes: base64ToArrayBuffer(payload.bytesBase64),
    })),
  };
}
