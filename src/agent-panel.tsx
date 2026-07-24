import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  Code2,
  Copy,
  FileCode2,
  FileText,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Send,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { IconSwap } from "./motion";
import { ChatMarkdown } from "./chat-markdown";
import { applySlashCommand, filterSlashCommands, slashAtCaret, type AgentCommand, type SlashState } from "./slash-commands";
import { Tip } from "./components/icon-tip";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { ThinkingOrb } from "./thinking-orbs";
import { clamp } from "./app-settings";
import type {
  AgentToolStep,
  ChatMessage,
  AgentSession,
  AgentSessionSummary,
  AgentSessionSearchResult,
  AgentMention,
  MentionState,
  AgentProvider,
  ReasoningEffort,
} from "./app-types";
import {
  isConversationWelcome,
  modelOptions,
  defaultModel,
  modelLabel,
  compactConversationTitle,
  relativeTime,
  statusToOrbState,
  mentionAtCaret,
} from "./app-utils";

export function AgentToolRow({ step }: { step: AgentToolStep }) {
  return (
    <div className={`agent-tool-step ${step.phase}`}>
      <i aria-hidden="true" />
      <strong>{step.name}</strong>
      <span>{step.detail || (step.phase === "start" ? "running…" : "done")}</span>
    </div>
  );
}

/**
 * One rendered chat turn. Memoized so a streaming reply only re-renders the last
 * row: every prop is stable for the earlier rows (the flags derive per-row from
 * "is this the last message"), so their markdown + KaTeX isn't re-parsed on each
 * streamed frame.
 */
export const MessageRow = memo(function MessageRow(props: {
  message: ChatMessage;
  index: number;
  streamingTail: boolean;
  inFlight: boolean;
  editDisabled: boolean;
  copied: boolean;
  macros: Record<string, string>;
  onCopy: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
}) {
  const { message, index, streamingTail, inFlight, editDisabled, copied, macros, onCopy, onEdit } = props;
  return (
    <div className={`chat-message ${message.role} ${streamingTail && message.role === "agent" ? "streaming" : ""}`}>
      {message.role === "agent" && <div className="message-avatar"><Sparkles size={13} /></div>}
      <div className="message-column">
        <div className="message-body">
          {message.role !== "agent"
            ? <p>{message.text}</p>
            : (message.parts?.length
              ? message.parts.map((part, partIndex) => (part.kind === "text"
                ? <ChatMarkdown
                    key={partIndex}
                    text={part.text}
                    macros={macros}
                    // Only the run being written now shows the caret.
                    className={streamingTail && partIndex === message.parts!.length - 1 ? "streaming-tail" : undefined}
                  />
                : <AgentToolRow key={part.id} step={part} />))
              : <ChatMarkdown text={message.text} macros={macros} />)}
          {!!message.skills?.length && <div className="skills-used"><small>Skills</small>{message.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>}
          {message.role === "agent" && (!isConversationWelcome(message, index) || !!message.files?.length) && <div className="agent-message-meta">
            {!!message.files?.length && <div className="changed-files">{message.files.map((file) => <span key={file}><FileCode2 size={11} />{file}</span>)}</div>}
            {!isConversationWelcome(message, index) && !inFlight && <button className="agent-message-copy" title="Copy agent response" onClick={() => void onCopy(message)}>
              <IconSwap swapKey={copied ? "check" : "copy"}>
                {copied ? <Check size={11} /> : <Copy size={11} />}
              </IconSwap>
            </button>}
          </div>}
        </div>
        {message.role === "user" && <div className="message-actions user-message-actions">
          <button className="message-copy" title="Copy user message" onClick={() => void onCopy(message)}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
          <button className="message-edit" title="Edit and branch from this message" disabled={editDisabled} onClick={() => onEdit(message)}><Pencil size={11} /> Edit</button>
        </div>}
      </div>
    </div>
  );
});

export function AgentPanel({
  agentCommands,
  katexMacros,
  messages,
  sessions,
  activeSession,
  sessionMenuOpen,
  setSessionMenuOpen,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onEditMessage,
  input,
  setInput,
  provider,
  setProvider,
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
  onStop,
  onApiSettings,
  selection,
  selectionSource,
  onClearSelection,
  branchSource,
  onCancelBranch,
  mentions,
  chatEnd,
  chatListRef,
}: {
  agentCommands: AgentCommand[];
  katexMacros: Record<string, string>;
  messages: ChatMessage[];
  sessions: AgentSessionSummary[];
  activeSession: AgentSession | null;
  sessionMenuOpen: boolean;
  setSessionMenuOpen: (value: boolean) => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onEditMessage: (message: ChatMessage) => void;
  input: string;
  setInput: (value: string) => void;
  provider: AgentProvider;
  setProvider: (value: AgentProvider) => void;
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
  onStop: () => void;
  onApiSettings: () => void;
  selection: string;
  selectionSource: "editor" | "pdf" | null;
  onClearSelection: () => void;
  branchSource: { sessionId: string; messageId: string } | null;
  onCancelBranch: () => void;
  mentions: AgentMention[];
  chatEnd: React.RefObject<HTMLDivElement | null>;
  chatListRef: React.RefObject<HTMLDivElement | null>;
}) {
  const options = modelOptions(provider);
  const efforts = options.find((option) => option.value === model)?.efforts ?? ["high"];
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [searchResults, setSearchResults] = useState<AgentSessionSearchResult[] | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyResetTimer = useRef<number | null>(null);
  // Stable identity so a memoized MessageRow isn't invalidated every render.
  const copyMessage = useCallback(async (message: ChatMessage) => {
    try {
      await writeText(message.text);
      setCopiedMessageId(message.id);
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => setCopiedMessageId(null), 1400);
    } catch {
      setCopiedMessageId(null);
    }
  }, []);
  useEffect(() => () => {
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
  }, []);
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const height = clamp(composer.scrollHeight, 44, 160);
    composer.style.height = `${height}px`;
    composer.style.overflowY = composer.scrollHeight > 160 ? "auto" : "hidden";
  }, [input]);
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
          <Tip label="New conversation">
            <button className="new-conversation-button" disabled={running} onClick={onNewSession}><Plus size={14} /></button>
          </Tip>
        </div>
        <div className="provider-controls">
          <Select value={provider} disabled={running} onValueChange={(value) => setProvider(value as AgentProvider)}>
            <SelectTrigger aria-label="Agent provider" className="provider-select"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="end" className="agent-select-menu">
              <SelectItem value="codex">Codex subscription</SelectItem>
              <SelectItem value="claude">Claude subscription</SelectItem>
              <SelectItem value="openai-api">OpenAI API</SelectItem>
              <SelectItem value="anthropic-api">Anthropic API</SelectItem>
            </SelectContent>
          </Select>
          {(provider === "openai-api" || provider === "anthropic-api") && (
            <Tip label="API key settings">
              <button onClick={onApiSettings}><KeyRound size={14} /></button>
            </Tip>
          )}
        </div>
      </div>
      <div className="agent-config-bar">
        <div className="config-pill">
          <span>Model</span>
          <Select value={model} disabled={running} onValueChange={(nextModel) => {
            const nextEfforts = options.find((option) => option.value === nextModel)?.efforts ?? ["high"];
            setModel(nextModel);
            if (!nextEfforts.includes(reasoningEffort)) setReasoningEffort(nextEfforts.includes("high") ? "high" : nextEfforts[0]);
          }}>
            <SelectTrigger aria-label="Agent model" className="config-select"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="start" className="agent-select-menu">
              {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="config-pill">
          <span>Effort</span>
          <Select value={reasoningEffort} disabled={running} onValueChange={(value) => setReasoningEffort(value as ReasoningEffort)}>
            <SelectTrigger aria-label="Reasoning effort" className="config-select"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="start" className="agent-select-menu">
              {efforts.map((effort) => <SelectItem key={effort} value={effort}>{effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="chat-list" ref={chatListRef}>
        {messages.map((message, index) => {
          const isLast = index === messages.length - 1;
          return (
            <MessageRow
              key={message.id}
              message={message}
              index={index}
              // These derive from "is this the last row", so every earlier row
              // gets stable props and the memo skips re-rendering it mid-stream.
              streamingTail={isLast && streaming}
              inFlight={isLast && running && message.role === "agent"}
              editDisabled={running}
              copied={copiedMessageId === message.id}
              macros={katexMacros}
              onCopy={copyMessage}
              onEdit={onEditMessage}
            />
          );
        })}
        {running && !streaming && (
          // At the start of a turn the agent is thinking before it has said a
          // word, so it wears its avatar like any other agent message. Once a
          // reply is already on screen and it pauses to run a tool, it drops the
          // avatar and reads as a continuation of that same message instead.
          <div className="chat-message agent thinking-row">
            {messages[messages.length - 1]?.role === "agent"
              ? <div className="message-avatar-spacer" aria-hidden="true" />
              : <div className="message-avatar"><Sparkles size={13} /></div>}
            <div className="thinking"><ThinkingOrb state={statusToOrbState(status)} size={20} /><em>{status || (provider === "claude" ? "Claude is writing…" : "Agent is writing…")}</em></div>
          </div>
        )}
        <div ref={chatEnd} />
      </div>
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
                onSend();
              }
            }}
          />
          <div className="composer-footer">
            <span>{running ? status || "Agent is working…" : "Enter sends · Shift+Enter adds a line"}</span>
            {running
              ? <button className="stop-agent-button" title={stopping ? "Stopping agent" : "Stop agent"} onClick={onStop} disabled={!cancellable || stopping}><Square size={12} fill="currentColor" /></button>
              : <button title="Send message" onClick={() => { setMention(null); setSlash(null); onSend(); }} disabled={!input.trim()}><Send size={14} /></button>}
          </div>
        </div>
      </div>
    </section>
  );
}
