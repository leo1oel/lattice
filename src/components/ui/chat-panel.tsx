/**
 * The conversation surface of Overleaf's project chat and a Share room's chat:
 * newest at the bottom, and a composer that sends on Enter. Messages are
 * bubbles (theirs on the left, yours on the right), or, when the host gives
 * each speaker a face, rows the way a team chat reads: the face, name and
 * time on the first of a run, and a divider where the day changes.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { SendHorizontal } from "lucide-react";
import { InfinityLoader } from "./activity-icons";
import { resizeTextareaToContent } from "./auto-resize-textarea";
import { Button } from "./button";
import { IconButton } from "./icon-button";
import { Textarea } from "./textarea";
import "./chat-panel.css";

export type ChatPanelMessage = {
  id: string;
  /** Who a run of messages belongs to; consecutive ones with the same key share one header. */
  authorKey: string;
  authorName: string;
  body: string;
  /** Milliseconds since the epoch. */
  at: number;
  mine: boolean;
};

/** "14:32" for today, "12 Mar 14:32" for anything older. */
// eslint-disable-next-line react-refresh/only-export-components
export function formatStamp(timestamp: number, locale?: string) {
  if (!timestamp) return "";
  const when = new Date(timestamp);
  const sameDay = when.toDateString() === new Date().toDateString();
  /* eslint-disable lingui/no-unlocalized-strings -- Intl.DateTimeFormat option values */
  return when.toLocaleString(locale, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  /* eslint-enable lingui/no-unlocalized-strings */
}

/** "Today", "Yesterday", else the date with its weekday, for a day divider. */
function dayLabel(timestamp: number, locale: string) {
  const day = new Date(timestamp);
  const today = new Date();
  const days = Math.round(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())) / 86_400_000,
  );
  if (days === 0 || days === 1) {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day");
    return relative.charAt(0).toLocaleUpperCase(locale) + relative.slice(1);
  }
  return day.toLocaleDateString(locale, days < 7
    ? { weekday: "long", month: "short", day: "numeric" }
    : { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

/** While an input method is composing, Enter is choosing a candidate, not sending. */
// eslint-disable-next-line react-refresh/only-export-components
export function isComposingEnter(event: React.KeyboardEvent) {
  return event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process";
}

export function ChatPanel(props: {
  /** Explanatory copy (and any error) above the list. */
  header: ReactNode;
  messages: ChatPanelMessage[];
  /** Sizing differs by host: a flexible drawer column or a fixed-height card. */
  listClassName: string;
  listLabel: string;
  loading?: boolean;
  loadingText?: string;
  /** Omitted when there is nothing to say, such as while an error explains the gap. */
  emptyText?: string;
  /** Drawn in place of `emptyText`, for a host with an empty state of its own. */
  emptyState?: ReactNode;
  /** The speaker's face; given, messages read as rows with day dividers rather than bubbles. */
  avatar?: (message: ChatPanelMessage) => ReactNode;
  placeholder: string;
  /** Resolve to clear the draft; reject to keep it, while the caller shows why. */
  onSend: (body: string) => Promise<void> | void;
}) {
  const { i18n, t } = useLingui();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [hasMessagesBelow, setHasMessagesBelow] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const nearBottomRef = useRef(true);
  const previousMessageCountRef = useRef(0);

  // Grow with the text instead of scrolling inside a fixed box, the way the
  // agent composer does.
  useEffect(() => {
    if (composerRef.current) resizeTextareaToContent(composerRef.current);
  }, [draft]);

  // Anchor the initial history to the newest message. Realtime updates only
  // follow while the reader is already near the bottom; reading older history
  // must remain stable when a collaborator sends something new.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const count = props.messages.length;
    const previousCount = previousMessageCountRef.current;
    if (count < previousCount || count === 0) {
      nearBottomRef.current = true;
      setHasMessagesBelow(false);
      list.scrollTop = count > 0 ? list.scrollHeight : 0;
    } else if (nearBottomRef.current || previousCount === 0) {
      list.scrollTop = list.scrollHeight;
      nearBottomRef.current = true;
      setHasMessagesBelow(false);
    } else if (count > previousCount) {
      setHasMessagesBelow(true);
    }
    previousMessageCountRef.current = count;
  }, [props.messages]);

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const submit = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await props.onSend(content);
      setDraft("");
    } catch {
      // The caller surfaces the reason; keep the text so nothing is lost.
    }
    setSending(false);
    composerRef.current?.focus();
  };

  const scrollToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    nearBottomRef.current = true;
    setHasMessagesBelow(false);
    list.focus({ preventScroll: true });
  };

  return (
    <>
      {props.header}
      <div
        className={`chat-list ${props.listClassName}`}
        ref={listRef}
        role="region"
        aria-label={props.listLabel}
        tabIndex={0}
        onScroll={(event) => {
          const list = event.currentTarget;
          const nearBottom = list.scrollHeight - list.clientHeight - list.scrollTop <= 32;
          nearBottomRef.current = nearBottom;
          if (nearBottom) setHasMessagesBelow(false);
        }}
      >
        {props.loading && !props.messages.length && (
          <p className="git-empty"><InfinityLoader size={13} /> {props.loadingText}</p>
        )}
        {!props.loading && !props.messages.length && (
          props.emptyState ?? (props.emptyText && <p className="git-empty">{props.emptyText}</p>)
        )}
        {props.messages.map((message, index) => {
          // One name above a run of messages reads as a conversation rather
          // than a log; repeat it only when the speaker changes.
          const previous = props.messages[index - 1];
          const newDay = !previous || new Date(previous.at).toDateString() !== new Date(message.at).toDateString();
          const grouped = previous
            && previous.authorKey === message.authorKey
            && message.at - previous.at < 5 * 60_000;
          const name = message.mine ? t`You` : message.authorName;
          if (props.avatar) {
            const opensRun = !grouped || newDay;
            const day = newDay ? dayLabel(message.at, i18n.locale) : null;
            // The divider above says which day; the row needs only the clock.
            // eslint-disable-next-line lingui/no-unlocalized-strings -- Intl.DateTimeFormat option values
            const clock = new Date(message.at).toLocaleTimeString(i18n.locale, { hour: "2-digit", minute: "2-digit" });
            return (
              <Fragment key={message.id}>
                {day && <div className="chat-day" role="separator" aria-label={day}>{day}</div>}
                <article className={`chat-row${opensRun ? "" : " grouped"}`}>
                  <span className="chat-row-avatar">{opensRun && props.avatar(message)}</span>
                  <div className="chat-row-body">
                    {opensRun && (
                      <div className="chat-row-meta">
                        <span>{name}</span>
                        <time dateTime={new Date(message.at).toISOString()} title={formatStamp(message.at, i18n.locale)}>
                          {clock}
                        </time>
                      </div>
                    )}
                    <p>{message.body}</p>
                  </div>
                </article>
              </Fragment>
            );
          }
          return (
            <article className={`chat-message${message.mine ? " mine" : ""}${grouped ? " grouped" : ""}`} key={message.id}>
              {!grouped && (
                <div className="chat-meta">
                  <span>{name}</span>
                  <time>{formatStamp(message.at, i18n.locale)}</time>
                </div>
              )}
              <p>{message.body}</p>
            </article>
          );
        })}
      </div>

      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {hasMessagesBelow ? t`New messages are available.` : ""}
      </span>
      {hasMessagesBelow && (
        <Button size="compact" variant="secondary" className="chat-latest-button" onClick={scrollToLatest}>
          {t`New messages · Jump to latest`}
        </Button>
      )}

      <div className="chat-composer">
        <Textarea
          ref={composerRef}
          rows={1}
          value={draft}
          placeholder={props.placeholder}
          aria-label={t`Message`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Sending mid-composition would cut a Chinese word in half.
            if (isComposingEnter(event)) return;
            // Enter sends, Shift+Enter breaks the line — what every chat does.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <IconButton
          label={t`Send message`}
          tooltip={false}
          tone="primary"
          disabled={!draft.trim() || sending}
          onClick={() => void submit()}
        >
          {sending ? <InfinityLoader size={14} /> : <SendHorizontal size={14} />}
        </IconButton>
      </div>
    </>
  );
}
