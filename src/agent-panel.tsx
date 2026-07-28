import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatStatus, UIMessage } from "ai";
import { invoke } from "@tauri-apps/api/core";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  FileText,
  LoaderCircle,
  Pencil,
  Paperclip,
  Plus,
  Search,
  Send,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { applySlashCommand, filterSlashCommands, slashAtCaret, type AgentCommand, type SlashState } from "./slash-commands";
import { Tip } from "./components/icon-tip";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { MessageList } from "./components/agent-elements/message-list";
import { UserMessage as AgentElementsUserMessage } from "./components/agent-elements/user-message";
import { FileAttachment } from "./components/agent-elements/input/file-attachment";
import { GenericTool } from "./components/agent-elements/tools/generic-tool";
import { BashTool } from "./components/agent-elements/tools/bash-tool";
import { EditTool } from "./components/agent-elements/tools/edit-tool";
import type {
  AgentToolStep,
  ChatMessage,
  AgentSession,
  AgentSessionSummary,
  AgentSessionSearchResult,
  AgentMention,
  MentionState,
  ModelOption,
  ReasoningEffort,
  AgentAttachmentDescriptor,
} from "./app-types";
import {
  isConversationWelcome,
  defaultModel,
  modelLabel,
  compactConversationTitle,
  relativeTime,
  mentionAtCaret,
} from "./app-utils";
import { clamp } from "./app-settings";

function toolDetailLabel(step: AgentToolStep): string {
  if (!step.detail) return step.phase === "start" ? "Working…" : "";
  if (step.phase === "end" && step.detail.trim().toLowerCase() === "done") return "";
  return step.detail
    .replace(/^(Reading|Editing|Matching|Running|Searching for)\s+/, "")
    .replace(new RegExp(`^Using ${step.name} on\\s+`, "i"), "")
    .replace(/…$/, "");
}

function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type AgentElementsToolPart = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
};

function AgentElementsTool({ part }: { part: AgentElementsToolPart }) {
  const input = typeof part.input === "object" && part.input !== null
    ? part.input as { name?: string; detail?: string }
    : undefined;
  const name = part.toolName ?? input?.name ?? part.type.replace(/^tool-/, "");
  const normalizedName = name.toLocaleLowerCase();
  const ToolIcon = normalizedName.includes("edit") || normalizedName.includes("write")
    ? Pencil
    : normalizedName.includes("bash") || normalizedName.includes("shell") || normalizedName.includes("command")
      ? TerminalSquare
      : normalizedName.includes("search") || normalizedName.includes("find") || normalizedName.includes("grep") || normalizedName.includes("glob")
        ? Search
        : normalizedName.includes("read") || normalizedName.includes("file")
          ? FileText
          : Bot;
  const state = part.state ?? "input-available";
  if (normalizedName.includes("bash") || normalizedName.includes("shell") || normalizedName.includes("command")) {
    return (
      <div className={`agent-elements-tool-step specialized ${state === "output-available" ? "end" : "start"}`} data-tool-name={name}>
        <strong className="tool-step-name">{name}</strong>
        <BashTool part={{ ...part, type: "tool-Bash", state, input: { command: input?.detail ?? "" } }} />
      </div>
    );
  }
  if (normalizedName.includes("edit") || normalizedName.includes("write")) {
    return (
      <div className={`agent-elements-tool-step specialized ${state === "output-available" ? "end" : "start"}`} data-tool-name={name}>
        <strong className="tool-step-name">{name}</strong>
        <EditTool part={{ ...part, type: normalizedName.includes("write") ? "tool-Write" : "tool-Edit", state, input: { file_path: input?.detail ?? "" } }} />
      </div>
    );
  }
  return (
    <div className={`agent-elements-tool-step ${part.state === "output-available" ? "end" : "start"}`} data-tool-name={name}>
      <GenericTool
        icon={ToolIcon}
        title={name}
        subtitle={input?.detail}
        isPending={part.state !== "output-available" && part.state !== "output-error"}
        isError={part.state === "output-error"}
      />
    </div>
  );
}

function toAgentElementsMessages(messages: ChatMessage[]): UIMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      id: message.id,
      role: message.role === "agent" ? "assistant" : "user",
      latticeSkills: message.skills,
      latticeFiles: message.files,
      latticeCopyDisabled: message.role === "agent"
        && isConversationWelcome(message, messages.indexOf(message)),
      parts: (message.parts?.length ? message.parts : [{ kind: "text" as const, text: message.text }]).map((part) => (
        part.kind === "text"
          ? { type: "text" as const, text: part.text }
          : {
              type: "dynamic-tool" as const,
              toolCallId: part.id,
              toolName: part.name,
              state: part.phase === "start" ? "input-available" as const : "output-available" as const,
              input: { name: part.name, detail: toolDetailLabel(part) },
              output: part.phase === "end" ? { detail: part.detail } : undefined,
            }
      )),
    })) as UIMessage[];
}

function effortLabel(effort: ReasoningEffort): string {
  return effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1);
}

function AgentConfigPicker(props: {
  modelOptions: ModelOption[];
  model: string;
  onModelChange: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  onEffortChange: (value: ReasoningEffort) => void;
  disabled: boolean;
  unavailable: boolean;
  unavailableTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [effortsOpen, setEffortsOpen] = useState(false);
  const selectedModel = props.modelOptions.find((option) => option.value === props.model);
  const efforts = selectedModel?.efforts ?? ["high"];
  const chooseModel = (value: string) => {
    const nextEfforts = props.modelOptions.find((option) => option.value === value)?.efforts ?? ["high"];
    props.onModelChange(value);
    if (!nextEfforts.includes(props.reasoningEffort)) {
      props.onEffortChange(nextEfforts.includes("high") ? "high" : nextEfforts[0]);
    }
    setModelsOpen(false);
    setOpen(false);
  };
  const chooseEffort = (value: ReasoningEffort) => {
    props.onEffortChange(value);
    setEffortsOpen(false);
    setOpen(false);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setModelsOpen(false);
      setEffortsOpen(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="agent-config-trigger"
          aria-label="Model and reasoning effort"
          disabled={props.disabled || props.unavailable}
          title={props.unavailable ? props.unavailableTitle : undefined}
        >
          <span>{selectedModel?.label ?? "No models"}</span>
          {!props.unavailable && <small>{effortLabel(props.reasoningEffort)}</small>}
          <ChevronDown aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={7} className="agent-config-menu">
        <button type="button" className="agent-config-row" aria-label="Choose model" aria-expanded={modelsOpen} onClick={() => { setModelsOpen((value) => !value); setEffortsOpen(false); }}>
          <strong>Model</strong><span>{selectedModel?.label ?? "No models"}</span><ChevronRight aria-hidden="true" />
        </button>
        {modelsOpen && (
          <div className="agent-config-options model-options" role="listbox" aria-label="Models">
            {props.modelOptions.map((option) => (
              <button type="button" role="option" aria-selected={option.value === props.model} key={option.value} className={option.value === props.model ? "selected" : ""} onClick={() => chooseModel(option.value)}>
                <span>{option.label}</span>{option.value === props.model && <Check aria-hidden="true" />}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="agent-config-row" aria-label="Choose reasoning effort" aria-expanded={effortsOpen} onClick={() => { setEffortsOpen((value) => !value); setModelsOpen(false); }}>
          <strong>Reasoning</strong><span>{effortLabel(props.reasoningEffort)}</span><ChevronRight aria-hidden="true" />
        </button>
        {effortsOpen && (
          <div className="agent-config-options effort-options" role="listbox" aria-label="Reasoning efforts">
            {efforts.map((effort) => (
              <button type="button" role="option" aria-selected={effort === props.reasoningEffort} key={effort} className={effort === props.reasoningEffort ? "selected" : ""} onClick={() => chooseEffort(effort)}>
                <span>{effortLabel(effort)}</span>{effort === props.reasoningEffort && <Check aria-hidden="true" />}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AgentPanel({
  modelOptions,
  modelUnavailable,
  authMode,
  onConfigureAuth,
  agentCommands,
  katexMacros: _katexMacros,
  messages,
  sessions,
  activeSession,
  sessionMenuOpen,
  setSessionMenuOpen,
  onNewSession,
  showNewButton = true,
  onOpenSession,
  onDeleteSession,
  onEditMessage,
  input,
  setInput,
  model,
  setModel,
  reasoningEffort,
  setReasoningEffort,
  running,
  streaming,
  status,
  cancellable,
  stopping,
  onSend,
  attachments,
  attachmentsInspecting,
  onAddAttachments,
  onRemoveAttachment,
  onStop,
  selection,
  selectionSource,
  onClearSelection,
  branchSource,
  onCancelBranch,
  mentions,
  chatEnd: _chatEnd,
  chatListRef: _chatListRef,
}: {
  agentCommands: AgentCommand[];
  katexMacros: Record<string, string>;
  messages: ChatMessage[];
  sessions: AgentSessionSummary[];
  activeSession: AgentSession | null;
  sessionMenuOpen: boolean;
  setSessionMenuOpen: (value: boolean) => void;
  onNewSession: () => void;
  showNewButton?: boolean;
  onOpenSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onEditMessage: (message: ChatMessage) => void;
  input: string;
  setInput: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  running: boolean;
  streaming: boolean;
  status: string;
  cancellable: boolean;
  stopping: boolean;
  onSend: () => void;
  attachments: AgentAttachmentDescriptor[];
  attachmentsInspecting: boolean;
  onAddAttachments: () => void;
  onRemoveAttachment: (path: string) => void;
  onStop: () => void;
  selection: string;
  selectionSource: "editor" | "pdf" | null;
  onClearSelection: () => void;
  branchSource: { sessionId: string; messageId: string } | null;
  onCancelBranch: () => void;
  mentions: AgentMention[];
  chatEnd: React.RefObject<HTMLDivElement | null>;
  chatListRef: React.RefObject<HTMLDivElement | null>;
  modelOptions: ModelOption[];
  modelUnavailable: boolean;
  authMode: "subscription" | "api";
  onConfigureAuth: () => void;
}) {
  void _katexMacros;
  void _chatEnd;
  void _chatListRef;
  const options = modelOptions;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [searchResults, setSearchResults] = useState<AgentSessionSearchResult[] | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  // The conversation history is a Radix Popover now, which handles outside-click
  // and Escape dismissal itself — no manual window listeners needed.
  useEffect(() => {
    const query = sessionSearch.trim();
    if (!sessionMenuOpen || !query) return;
    const timer = window.setTimeout(() => {
      void invoke<AgentSessionSearchResult[]>("search_agent_sessions", { query })
        .then(setSearchResults)
        .catch(() => setSearchResults([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [sessionMenuOpen, sessionSearch]);
  const visibleSessions: AgentSessionSearchResult[] = sessionSearch.trim() && searchResults
    ? searchResults
    : sessions.map((session) => ({ ...session, snippet: "" }));
  const mentionSuggestions = mention
    ? mentions
      .filter((item) => `${item.label} ${item.path}`.toLowerCase().includes(mention.query.toLowerCase()))
      .slice(0, 8)
    : [];
  const slashSuggestions = slash ? filterSlashCommands(agentCommands, slash.query).slice(0, 8) : [];
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const height = clamp(composer.scrollHeight, 44, 160);
    composer.style.height = `${height}px`;
    composer.style.overflowY = composer.scrollHeight > 160 ? "auto" : "hidden";
  }, [input]);
  const agentElementsMessages = useMemo(() => toAgentElementsMessages(messages), [messages]);
  const messageById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const AgentElementsUser = useCallback(({ message }: { message: UIMessage; className?: string; enableImagePreview?: boolean }) => {
    const original = messageById.get(message.id);
    return (
      <div className="agent-elements-user-turn">
        <AgentElementsUserMessage message={message} />
        {!!original?.attachments?.length && (
          <div className="message-attachments">
            {original.attachments.map((attachment, index) => (
              <span key={`${attachment.name}-${index}`}><Paperclip size={10} />{attachment.name}<small>{attachment.kind} · {attachmentSize(attachment.size)}</small></span>
            ))}
          </div>
        )}
      </div>
    );
  }, [messageById]);
  const chatStatus: ChatStatus = running ? (streaming ? "streaming" : "submitted") : "ready";
  const insertSlashCommand = (command: AgentCommand) => {
    if (!slash) return;
    const { value, caret } = applySlashCommand(input, slash, command);
    setInput(value);
    setSlash(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(caret, caret);
    });
  };
  const insertMention = (item: AgentMention) => {
    if (!mention) return;
    const inserted = `@${item.path}`;
    const next = `${input.slice(0, mention.start)}${inserted} ${input.slice(mention.end)}`;
    const caret = mention.start + inserted.length + 1;
    setInput(next);
    setMention(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(caret, caret);
    });
  };
  return (
    <section className="agent-panel">
      <div className="agent-header">
        <div className="agent-conversation-controls">
          <Popover open={sessionMenuOpen} onOpenChange={setSessionMenuOpen}>
            <PopoverTrigger asChild>
              <button className="agent-title" title="Conversation history">
                <Bot size={16} /><span>{compactConversationTitle(activeSession?.title ?? "Writing agent")}</span><ChevronDown size={12} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="session-popover">
              <div className="session-menu-heading"><span>Conversations</span><button onClick={onNewSession}><Plus size={13} /> New</button></div>
              <label className="session-search"><Search size={12} /><input aria-label="Search conversations" value={sessionSearch} onChange={(event) => { setSessionSearch(event.target.value); setSearchResults(null); }} placeholder="Search conversations…" /></label>
              <div className="session-list">
                {visibleSessions.map((session) => (
                  <div key={session.id} className={session.id === activeSession?.id ? "active" : ""}>
                    <button className="session-open" onClick={() => onOpenSession(session.id)}>
                      <strong>{compactConversationTitle(session.title)}</strong>
                      <small>{modelLabel(session.provider, session.model || defaultModel(session.provider))} · {session.messageCount} messages · {relativeTime(session.updatedAt)}</small>
                      {session.snippet && <small className="session-snippet">{session.snippet}</small>}
                    </button>
                    <button className="session-delete" title="Delete conversation" disabled={running} onClick={() => onDeleteSession(session.id)}><Trash2 size={12} /></button>
                  </div>
                ))}
                {!visibleSessions.length && <p className="session-empty">No conversations found.</p>}
              </div>
            </PopoverContent>
          </Popover>
          {showNewButton && (
            <Tip label="New conversation">
              <button className="new-conversation-button" disabled={running} onClick={onNewSession}><Plus size={14} /></button>
            </Tip>
          )}
        </div>
      </div>
      <MessageList
        messages={agentElementsMessages}
        status={chatStatus}
        className="agent-elements-message-list"
        slots={{ UserMessage: AgentElementsUser, ToolRenderer: AgentElementsTool }}
        renderUserAction={(message) => {
          const original = messageById.get(message.id);
          return original ? (
            <button className="agent-elements-edit" title="Edit and branch from this message" disabled={running} onClick={() => onEditMessage(original)}>
              <Pencil size={11} />
            </button>
          ) : null;
        }}
        showCopyToolbar
      />
      <div className="composer-wrap">
        {branchSource && <div className="context-chip branch-chip"><Pencil size={11} /> Editing an earlier message creates a new branch <button title="Cancel conversation branch" onClick={onCancelBranch}><X size={11} /></button></div>}
        {selection && (
          <div className="context-chip">
            {selectionSource === "pdf" ? <FileText size={12} /> : <Code2 size={12} />}
            {selectionSource === "pdf" ? "PDF selection" : "Selection"} · {selection.length} chars
            <button type="button" title="Clear selection context" onClick={onClearSelection}><X size={11} /></button>
          </div>
        )}
        {slash && (
          <div className="mention-menu" role="listbox" aria-label="Agent commands">
            <div className="mention-heading"><span>Agent commands</span><small>{slashSuggestions.length ? "↑↓ to navigate · Enter to insert" : "No matches"}</small></div>
            {slashSuggestions.map((command, index) => (
              <button
                key={command.name}
                role="option"
                aria-selected={index === slashIndex}
                className={index === slashIndex ? "active" : ""}
                onMouseDown={(event) => { event.preventDefault(); insertSlashCommand(command); }}
              >
                <TerminalSquare size={13} />
                <span><strong>/{command.name}{command.hint ? ` ${command.hint}` : ""}</strong><small>{command.description}</small></span>
              </button>
            ))}
          </div>
        )}
        {mention && (
          <div className="mention-menu" role="listbox" aria-label="Project references">
            <div className="mention-heading"><span>Reference project context</span><small>{mentionSuggestions.length ? "↑↓ to navigate · Enter to insert" : "No matches"}</small></div>
            {mentionSuggestions.map((item, index) => (
              <button
                key={item.key}
                role="option"
                aria-selected={index === mentionIndex}
                className={index === mentionIndex ? "active" : ""}
                onMouseDown={(event) => { event.preventDefault(); insertMention(item); }}
              >
                {item.kind === "paper" ? <BookOpen size={13} /> : <FileCode2 size={13} />}
                <span><strong>{item.label}</strong><small>{item.path}</small></span>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          {!!attachments.length && (
            <div className="staged-attachments">
              {attachments.map((attachment) => (
                <FileAttachment
                  key={attachment.path}
                  id={attachment.path}
                  filename={attachment.name}
                  size={attachment.size}
                  isImage={attachment.kind === "image"}
                  url={attachment.previewUrl ?? undefined}
                  display={attachment.kind === "image" ? "image-only" : "chip"}
                  onRemove={running ? undefined : () => onRemoveAttachment(attachment.path)}
                  className="staged-attachment-preview"
                />
              ))}
            </div>
          )}
          <textarea
            ref={composerRef}
            rows={1}
            placeholder="Ask the agent to write, revise, or reason…"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setMention(mentionAtCaret(event.target.value, event.target.selectionStart));
              setMentionIndex(0);
              setSlash(slashAtCaret(event.target.value, event.target.selectionStart));
              setSlashIndex(0);
            }}
            onSelect={(event) => {
              setMention(mentionAtCaret(event.currentTarget.value, event.currentTarget.selectionStart));
              setSlash(slashAtCaret(event.currentTarget.value, event.currentTarget.selectionStart));
            }}
            onBlur={() => { setMention(null); setSlash(null); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") return;
              if (slash && slashSuggestions.length) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((index) => (index + 1) % slashSuggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
                  return;
                }
                // Enter still sends: a fully typed command should not need a
                // second keystroke just because the menu is open.
                if (event.key === "Tab") {
                  event.preventDefault();
                  insertSlashCommand(slashSuggestions[Math.min(slashIndex, slashSuggestions.length - 1)]);
                  return;
                }
              }
              if (event.key === "Escape" && slash) {
                event.preventDefault();
                setSlash(null);
                return;
              }
              if (mention && mentionSuggestions.length) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((index) => (index - 1 + mentionSuggestions.length) % mentionSuggestions.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  insertMention(mentionSuggestions[Math.min(mentionIndex, mentionSuggestions.length - 1)]);
                  return;
                }
              }
              if (event.key === "Escape" && mention) {
                event.preventDefault();
                setMention(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                setMention(null);
                setSlash(null);
                if (!modelUnavailable) onSend();
              }
            }}
          />
          <div className="composer-footer">
            <div className="composer-footer-left">
              <button className="attach-button" title={attachmentsInspecting ? "Inspecting attachments" : "Add attachments"} aria-label="Add attachments" disabled={running || attachmentsInspecting} onClick={onAddAttachments}>
                {attachmentsInspecting ? <LoaderCircle className="attachment-spinner" size={13} /> : <Paperclip size={13} />}
              </button>
              <div className="footer-selectors">
                <AgentConfigPicker
                  modelOptions={options}
                  model={model}
                  onModelChange={setModel}
                  reasoningEffort={reasoningEffort}
                  onEffortChange={setReasoningEffort}
                  disabled={running}
                  unavailable={modelUnavailable}
                  unavailableTitle={`Connect a ${authMode} account in Settings`}
                />
              </div>
              {modelUnavailable && <button type="button" className="agent-auth-prompt" onClick={onConfigureAuth}>Connect</button>}
              {running && <span>{status || "Agent is working…"}</span>}
            </div>
            {running
              ? <button className="stop-agent-button" title={stopping ? "Stopping agent" : "Stop agent"} onClick={onStop} disabled={!cancellable || stopping}><Square size={12} fill="currentColor" /></button>
              : <button title="Send message" onClick={() => { setMention(null); setSlash(null); onSend(); }} disabled={attachmentsInspecting || modelUnavailable || (!input.trim() && !attachments.length)}><Send size={14} /></button>}
          </div>
        </div>
      </div>
    </section>
  );
}
