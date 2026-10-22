import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Clock, Pencil } from "lucide-react";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { Input } from "../components/ui/input";
import { SegmentedControl } from "../components/ui/segmented-control";
import type { ProjectDeadline } from "../app-types";
import { aoeWallClock, deadlineDraftFrom, deadlineInstant, deadlineUrgency, durationParts } from "./deadline-time";

// eslint-disable-next-line lingui/no-unlocalized-strings -- Intl options, not interface text
const WHEN: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/** The clock the countdown reads, refreshed often enough for a minute-level count. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The writer's own clock for the deadline, and its zone named once, apart
 * from the date: Intl would put a zh-CN zone name between the date and the
 * hour ("5月16日周日 GMT+8 19:59").
 */
function localWhen(instant: number, locale: string, year: boolean) {
  const options = { ...WHEN, year: year ? "numeric" : undefined } as const;
  const when = new Date(instant).toLocaleString(locale, options);
  const zone = new Intl.DateTimeFormat(locale, { timeZoneName: "short" })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value ?? "";
  return { when, zone };
}

/**
 * The deadline above the checks, as Fiverr puts its "Time left to deliver"
 * above its checklist: how long is left in words, then the AoE time the call
 * for papers gives, then the same moment on the writer's clock. Colour sits
 * on the clock icon alone (Linear's restraint) until a day is left, when the
 * countdown turns red too. AoE is pinned rather than offered as a zone choice:
 * every ML venue publishes its deadlines in it, and no zone picker lists it.
 */
export function DeadlineCard(props: {
  deadline: ProjectDeadline | null;
  /** Suggests a name for a new deadline from the project's template. */
  venue: string;
  onSave: (deadline: ProjectDeadline | null) => void;
}) {
  const { t, i18n } = useLingui();
  const [editing, setEditing] = useState(false);
  const now = useNow(30_000);
  const locale = i18n.locale || "en";
  const kindLabel = (kind: ProjectDeadline["kind"]) =>
    kind === "abstract" ? t`abstract` : kind === "rebuttal" ? t`rebuttal` : t`full paper`;

  if (editing) {
    return (
      <DeadlineForm
        deadline={props.deadline}
        venue={props.venue}
        locale={locale}
        onCancel={() => setEditing(false)}
        onSave={(deadline) => {
          props.onSave(deadline);
          setEditing(false);
        }}
      />
    );
  }

  const wall = props.deadline ? aoeWallClock(props.deadline.due) : null;
  const instant = props.deadline ? deadlineInstant(props.deadline.due) : null;
  if (!props.deadline || !wall || instant == null) {
    return (
      <button type="button" className="deadline-add" onClick={() => setEditing(true)}>
        <Clock size={14} aria-hidden="true" />
        <span>
          <b>{t`Add the submission deadline`}</b>
        </span>
      </button>
    );
  }

  const remaining = instant - now;
  const { days, hours, minutes } = durationParts(remaining);
  const unit = (count: number, one: string, many: string) => (count === 1 ? one : many);
  const span = [
    days ? unit(days, t`1 day`, t`${days} days`) : null,
    hours ? unit(hours, t`1 hour`, t`${hours} hours`) : null,
    minutes ? unit(minutes, t`1 minute`, t`${minutes} minutes`) : null,
  ].filter(Boolean).join(" ");
  const left = remaining <= 0
    ? span ? t`Closed ${span} ago` : t`Closed just now`
    : span ? t`${span} left` : t`Less than a minute left`;
  const otherYear = wall.getUTCFullYear() !== new Date(now).getUTCFullYear();
  // eslint-disable-next-line lingui/no-unlocalized-strings -- the stored AoE clock reads as UTC (deadline-time.ts)
  const aoe = wall.toLocaleString(locale, { ...WHEN, timeZone: "UTC", year: otherYear ? "numeric" : undefined });
  const { when, zone } = localWhen(instant, locale, otherYear);

  return (
    <section className="deadline-card" data-urgency={deadlineUrgency(remaining)} aria-label={t`Deadline`}>
      <div className="deadline-card-head">
        <span className="deadline-card-venue">
          <Clock size={13} aria-hidden="true" />
          <span title={props.deadline.venue}>{`${props.deadline.venue} · ${kindLabel(props.deadline.kind)}`}</span>
        </span>
        <IconButton label={t`Edit deadline`} size="compact" onClick={() => setEditing(true)}>
          <Pencil size={12} aria-hidden="true" />
        </IconButton>
      </div>
      <p className="deadline-card-left">{left}</p>
      <p className="deadline-card-when"><b>{aoe}</b> {t`AoE (UTC−12)`}</p>
      <p className="deadline-card-local">{t`${when} your time · ${zone}`}</p>
    </section>
  );
}

function DeadlineForm(props: {
  deadline: ProjectDeadline | null;
  venue: string;
  locale: string;
  onCancel: () => void;
  onSave: (deadline: ProjectDeadline | null) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => deadlineDraftFrom(props.deadline, props.venue));
  // eslint-disable-next-line lingui/no-unlocalized-strings -- the stored "YYYY-MM-DDTHH:MM" form
  const due = `${draft.date}T${draft.time}`;
  const instant = deadlineInstant(due);
  const valid = draft.venue.trim() !== "" && instant != null;
  const { when, zone } = instant == null ? { when: null, zone: null } : localWhen(instant, props.locale, true);
  return (
    <form
      className="deadline-card deadline-form"
      aria-label={t`Deadline`}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) props.onSave({ venue: draft.venue.trim(), kind: draft.kind, due });
      }}
    >
      <label>
        {t`Deadline for`}
        <Input
          controlSize="compact"
          value={draft.venue}
          maxLength={80}
          placeholder={t`e.g. NeurIPS 2027`}
          autoFocus
          onChange={(event) => setDraft({ ...draft, venue: event.target.value })}
        />
      </label>
      <SegmentedControl<ProjectDeadline["kind"]>
        ariaLabel={t`What is due`}
        value={draft.kind}
        onChange={(kind) => setDraft({ ...draft, kind })}
        items={[
          { value: "abstract", label: t`Abstract` },
          { value: "paper", label: t`Paper` },
          { value: "rebuttal", label: t`Rebuttal` },
        ]}
      />
      <div className="deadline-form-when">
        <label>
          {t`Date`}
          <Input
            controlSize="compact"
            type="date"
            value={draft.date}
            onChange={(event) => setDraft({ ...draft, date: event.target.value })}
          />
        </label>
        <label>
          {t`Time, AoE (UTC−12)`}
          <Input
            controlSize="compact"
            type="time"
            value={draft.time}
            onChange={(event) => setDraft({ ...draft, time: event.target.value })}
          />
        </label>
      </div>
      {/* Empty until a date is set, its line held so the actions don't jump. */}
      <p className="deadline-card-local">{when && t`${when} your time · ${zone}`}</p>
      <div className="deadline-form-actions">
        {props.deadline && (
          <Button variant="ghost" size="compact" className="deadline-form-remove" onClick={() => props.onSave(null)}>
            {t`Remove`}
          </Button>
        )}
        <Button variant="ghost" size="compact" onClick={props.onCancel}>{t`Cancel`}</Button>
        <Button variant="primary" size="compact" type="submit" disabled={!valid}>{t`Save deadline`}</Button>
      </div>
    </form>
  );
}
