import { Pencil, Plus, Trash2 } from "lucide-react";
import { MotionButton } from "./motion";
import { Button } from "./components/ui/button";
import { buttonClassName } from "./components/ui/button-styles";
import { EmptyState } from "./components/ui/empty-state";
import { Field } from "./components/ui/field";
import { SettingsSectionHeader } from "./components/ui/settings-section-header";
import { Switch } from "./components/ui/switch";
import { SwitchField } from "./components/ui/switch-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import type { McpServer, McpServerDraft, McpTransport } from "./app-types";

function linesToMap(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) entries[key] = value;
  }
  return entries;
}

function mapToLines(entries: Record<string, string> | undefined): string {
  if (!entries) return "";
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function emptyMcpDraft(scope: "application" | "project" = "application"): McpServerDraft {
  return {
    scope,
    name: "",
    enabled: true,
    transport: "stdio",
    command: "npx",
    argsText: "",
    envText: "",
    cwd: "",
    url: "",
    headersText: "",
  };
}

export function draftFromMcpServer(server: McpServer): McpServerDraft {
  return {
    originalName: server.name,
    scope: server.scope === "project" ? "project" : "application",
    name: server.name,
    enabled: server.enabled,
    transport: (server.transport === "http" || server.transport === "sse"
      ? server.transport
      : "stdio") as McpTransport,
    command: server.command ?? "",
    argsText: (server.args ?? []).join("\n"),
    envText: mapToLines(server.env),
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    headersText: mapToLines(server.headers),
  };
}

export function mcpDraftToSaveRequest(draft: McpServerDraft) {
  const transport = draft.transport;
  return {
    originalName: draft.originalName,
    name: draft.name.trim(),
    scope: draft.scope,
    enabled: draft.enabled,
    transport,
    command: transport === "stdio" ? draft.command.trim() || null : null,
    args:
      transport === "stdio"
        ? draft.argsText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    env: transport === "stdio" ? linesToMap(draft.envText) : {},
    cwd: transport === "stdio" ? draft.cwd.trim() || null : null,
    url: transport === "stdio" ? null : draft.url.trim() || null,
    headers: transport === "stdio" ? {} : linesToMap(draft.headersText),
  };
}

export function McpSettingsSection(props: {
  hasProject: boolean;
  servers: McpServer[];
  draft: McpServerDraft | null;
  setDraft: (draft: McpServerDraft | null) => void;
  onSave: (draft: McpServerDraft) => void;
  onSetEnabled: (name: string, enabled: boolean) => void;
  onDelete: (server: McpServer) => void;
}) {
  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="MCP"
        description={(
          <>
            Attach Model Context Protocol servers to Oh My Pi. They become available on the next agent turn.
            Application servers apply to every Lattice project; project servers live in <code>.omp/mcp.json</code>.
          </>
        )}
      />
      <div className="skill-heading">
        <div>
          <strong>Servers</strong>
          <span>stdio, Streamable HTTP, or SSE. Secrets can use <code>{"${VAR}"}</code> placeholders.</span>
        </div>
        <Button
          size="compact"
          onClick={() => props.setDraft(emptyMcpDraft("application"))}
        >
          <Plus size={12} /> Add server
        </Button>
      </div>
      {props.draft ? (
        <div className="skill-editor mcp-editor">
          <Field label="Name">
            <input
              type="text"
              aria-label="MCP server name"
              placeholder="filesystem"
              value={props.draft.name}
              onChange={(event) => props.setDraft({ ...props.draft!, name: event.target.value })}
            />
          </Field>
          <Field label="Availability">
            <Select
              value={props.draft.scope}
              onValueChange={(value) =>
                props.setDraft({
                  ...props.draft!,
                  scope: value as "application" | "project",
                })
              }
            >
              <SelectTrigger aria-label="MCP availability">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="application">All Lattice projects</SelectItem>
                <SelectItem value="project" disabled={!props.hasProject}>
                  This project only
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Transport">
            <Select
              value={props.draft.transport}
              onValueChange={(value) =>
                props.setDraft({
                  ...props.draft!,
                  transport: value as McpTransport,
                })
              }
            >
              <SelectTrigger aria-label="MCP transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="stdio">stdio (local command)</SelectItem>
                <SelectItem value="http">HTTP (Streamable)</SelectItem>
                <SelectItem value="sse">SSE (legacy)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {props.draft.transport === "stdio" ? (
            <>
              <Field label="Command">
                <input
                  type="text"
                  aria-label="MCP command"
                  placeholder="npx"
                  value={props.draft.command}
                  onChange={(event) => props.setDraft({ ...props.draft!, command: event.target.value })}
                />
              </Field>
              <Field label="Arguments">
                <textarea
                  aria-label="MCP arguments"
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/absolute/path"}
                  value={props.draft.argsText}
                  onChange={(event) => props.setDraft({ ...props.draft!, argsText: event.target.value })}
                />
              </Field>
              <Field label="Environment">
                <textarea
                  aria-label="MCP environment"
                  placeholder={"API_KEY=API_KEY\nOTHER=value"}
                  value={props.draft.envText}
                  onChange={(event) => props.setDraft({ ...props.draft!, envText: event.target.value })}
                />
              </Field>
              <Field label="Working directory">
                <input
                  type="text"
                  aria-label="MCP working directory"
                  placeholder="optional absolute path"
                  value={props.draft.cwd}
                  onChange={(event) => props.setDraft({ ...props.draft!, cwd: event.target.value })}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <input
                  type="text"
                  aria-label="MCP URL"
                  placeholder="https://example.com/mcp"
                  value={props.draft.url}
                  onChange={(event) => props.setDraft({ ...props.draft!, url: event.target.value })}
                />
              </Field>
              <Field label="Headers">
                <textarea
                  aria-label="MCP headers"
                  placeholder={"Authorization=Bearer ${TOKEN}"}
                  value={props.draft.headersText}
                  onChange={(event) =>
                    props.setDraft({ ...props.draft!, headersText: event.target.value })
                  }
                />
              </Field>
            </>
          )}
          <SwitchField
            label="Enabled"
            checked={props.draft.enabled}
            onChange={(enabled) => props.setDraft({ ...props.draft!, enabled })}
          />
          <div className="skill-editor-actions">
            <Button size="compact" variant="ghost" onClick={() => props.setDraft(null)}>
              Cancel
            </Button>
            <MotionButton
              className={buttonClassName({ variant: "primary", size: "compact" })}
              onClick={() => props.onSave(props.draft!)}
            >
              Save server
            </MotionButton>
          </div>
        </div>
      ) : (
        <div className="skill-list">
          {props.servers.map((server) => (
            <div className="skill-card" key={`${server.scope}:${server.name}`}>
              <Switch
                checked={server.enabled}
                label={`Enable ${server.name}`}
                onChange={(next) => props.onSetEnabled(server.name, next)}
              />
              <div>
                <strong>{server.name}</strong>
                <small>
                  {server.scope === "application" ? "All projects" : "This project"}
                  {server.overridden ? " · overrides app-wide" : ""}
                  {" · "}
                  {server.transport}
                </small>
                <p>{server.summary}</p>
              </div>
              <div className="skill-actions">
                <button
                  type="button"
                  title={`Edit ${server.name}`}
                  onClick={() => props.setDraft(draftFromMcpServer(server))}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  title={`Delete ${server.name}`}
                  onClick={() => props.onDelete(server)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
          {!props.servers.length && (
            <EmptyState
              align="start"
              density="compact"
              description="No MCP servers are configured in Lattice yet."
            />
          )}
        </div>
      )}
    </div>
  );
}
