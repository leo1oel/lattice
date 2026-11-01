/**
 * The selection toolbar's Rewrite menu: the writer types what the agent should
 * do with the selection ("translate into academic English", "cut to 100
 * words") and gets the proofread card's reviewable suggestion. Loaded only
 * when the menu opens, so the toolbar's startup cost stays one button.
 *
 * The last few instructions are kept for reuse. They are the writer's, not a
 * project's, as the highlighter preferences are (`highlighters.ts`).
 */
import { useReducer } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Input } from "../../components/ui/input";
import { persistSetting } from "../../settings/app-settings";

const RECENT_KEY = "lattice.selection-instructions.v1";
const RECENT_MAX = 5;
/** An instruction is a sentence or two; past this it is a pasted excerpt. */
const INSTRUCTION_MAX_LENGTH = 400;

/** Starting points while the writer has no instructions of their own yet. */
const SUGGESTIONS: readonly MessageDescriptor[] = [
  msg`Translate into academic English`,
  msg`Translate into Chinese`,
  msg`Shorten to about 100 words`,
  msg`Use the passive voice`,
];

const tidy = (instruction: string) => instruction.replace(/\s+/g, " ").trim().slice(0, INSTRUCTION_MAX_LENGTH);

/** The writer's recent instructions, newest first; none when storage cannot be read. */
function recentInstructions(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && Boolean(tidy(item))).map(tidy).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Put `instruction` first among the recent ones, once. */
function rememberInstruction(instruction: string) {
  const recent = [instruction, ...recentInstructions().filter((item) => item !== instruction)].slice(0, RECENT_MAX);
  persistSetting(RECENT_KEY, JSON.stringify(recent));
}

type MenuState = { draft: string; recent: readonly string[] };
type MenuAction = { type: "draft"; text: string };

function menuReducer(state: MenuState, action: MenuAction): MenuState {
  switch (action.type) {
    case "draft": return { ...state, draft: action.text };
  }
}

export function SelectionInstructionMenu(props: { onSubmit: (instruction: string) => void }) {
  const { i18n, t } = useLingui();
  const [state, dispatch] = useReducer(menuReducer, null, (): MenuState => ({ draft: "", recent: recentInstructions() }));
  const submit = (text: string) => {
    const instruction = tidy(text);
    if (!instruction) return;
    rememberInstruction(instruction);
    props.onSubmit(instruction);
  };
  const reuse = state.recent.length > 0;
  const choices = reuse ? state.recent : SUGGESTIONS.map((item) => i18n._(item));
  return (
    <>
      <form className="instruction-menu-form" onSubmit={(event) => {
        event.preventDefault();
        submit(state.draft);
      }}>
        <Input
          controlSize="compact"
          autoFocus
          aria-label={t`Instruction`}
          placeholder={t`What should the agent change?`}
          maxLength={INSTRUCTION_MAX_LENGTH}
          value={state.draft}
          onChange={(event) => dispatch({ type: "draft", text: event.target.value })}
        />
        <button type="submit" disabled={!state.draft.trim()}>{t({ message: "Rewrite", context: "selection instruction" })}</button>
      </form>
      <div className="instruction-menu-choices" role="group" aria-label={reuse ? t`Recent instructions` : t`Suggested instructions`}>
        <span className="instruction-menu-heading" aria-hidden="true">{reuse ? t`Recent` : t`Try`}</span>
        {choices.map((choice) => (
          <button key={choice} type="button" title={choice} onClick={() => submit(choice)}>
            <span>{choice}</span>
          </button>
        ))}
      </div>
    </>
  );
}
