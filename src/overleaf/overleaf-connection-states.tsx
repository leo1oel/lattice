import type { ReactNode } from "react";
import { ReloadButton, InfinityLoader } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";
import { SettingsRow } from "../components/ui/settings-row";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

/** An error line with a button to try the failed load again. */
export function RetryRow(props: { error: string; busy: boolean; label: string; onRetry: () => void }) {
  return (
    <>
      <InlineMessage level="error" className="overleaf-inline">{props.error}</InlineMessage>
      <div className="overleaf-retry-row">
        <ReloadButton size="compact" busy={props.busy} disabled={props.busy} onClick={props.onRetry}>
          {props.label}
        </ReloadButton>
      </div>
    </>
  );
}

export function Progress(props: { className?: string; text: string }) {
  return (
    <div className={props.className ?? "overleaf-loading"}>
      <InfinityLoader size={15} />
      <span>{props.text}</span>
    </div>
  );
}

/**
 * A small tinted tile holding an icon: the one visual anchor every Overleaf
 * card, empty state and prompt shares, so they read as one family.
 */
export function Glyph(props: { tone?: "accent" | "success" | "warning" | "danger" | "neutral"; size?: "compact" | "large"; children: ReactNode }) {
  return (
    <span className="overleaf-glyph" data-tone={props.tone ?? "accent"} data-size={props.size ?? "compact"} aria-hidden="true">
      {props.children}
    </span>
  );
}

/**
 * The centered state of the picker's list frame when there is no list to
 * show: not connected yet, a session that expired, nothing found, or a load
 * that failed. One layout, so switching between them never jumps.
 */
export function StageMessage(props: { glyph: ReactNode; tone?: "accent" | "warning" | "danger" | "neutral"; children: ReactNode }) {
  return (
    <div className="overleaf-stage-message">
      <Glyph tone={props.tone} size="large">{props.glyph}</Glyph>
      {props.children}
    </div>
  );
}

/** A status tile, what it means, the detail beneath it, and an optional action. */
export function StatusRow(props: { dot: "connected" | "paused"; icon: ReactNode; title: ReactNode; detail: ReactNode; children?: ReactNode }) {
  return (
    <div className="overleaf-status-row">
      <span className="overleaf-status-glyph">
        <Glyph tone="neutral">{props.icon}</Glyph>
        <span className={`overleaf-dot ${props.dot}`} aria-hidden="true" />
      </span>
      <div className="overleaf-status-text"><strong>{props.title}</strong><small>{props.detail}</small></div>
      {props.children}
    </div>
  );
}

/** A settings row whose control is a dropdown over `options`, in their listed order. */
export function SelectRow<T extends string>({ label, description, value, onChange, options, setting }: {
  label: string; description?: ReactNode; value: T; onChange: (value: T) => void; options: Record<T, string>;
  /** What Settings search reveals this row by. */
  setting: string;
}) {
  return (
    <SettingsRow label={label} description={description} data-setting={setting}>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent data-settings-control="true" position="popper" align="end">
          {(Object.entries(options) as [T, string][]).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

