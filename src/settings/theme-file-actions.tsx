/**
 * Settings › Appearance › Theme: installing a theme file, showing the
 * themes folder, and removing the chosen theme when it was installed (the
 * ones that come with Lattice stay). See `docs/themes.md`.
 */
import { useLingui } from "@lingui/react/macro";
import { open } from "@tauri-apps/plugin-dialog";
import { useReducer } from "react";
import { confirmAction, hostErrorMessage } from "../app-utils";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import type { ThemePreference } from "./app-settings";
import { BrowseThemesSheet } from "./theme-browse";
import { type ThemeInfo, installThemeFile, removeTheme, revealThemesFolder } from "./themes";

type ActionState = { busy: boolean; error: string | null };

export function ThemeFileActions(props: {
  /** The chosen theme, when there is one. */
  chosen: ThemeInfo | undefined;
  /** Every theme installed here, and the appearance the tiles draw. */
  themes: readonly ThemeInfo[] | null;
  mode: ThemePreference;
  /** A theme was installed: choose it. */
  onInstalled: (id: string) => void;
  /** The chosen theme was removed: go back to Lattice's own colors. */
  onRemoved: () => void;
}) {
  const { t } = useLingui();
  const [state, setState] = useReducer((_: ActionState, next: ActionState) => next, { busy: false, error: null });
  const [browsing, setBrowsing] = useReducer((_: boolean, next: boolean) => next, false);

  async function run(action: () => Promise<void>) {
    setState({ busy: true, error: null });
    try {
      await action();
      setState({ busy: false, error: null });
    } catch (reason) {
      setState({ busy: false, error: hostErrorMessage(reason) });
    }
  }

  const install = () => run(async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: t`Lattice theme`, extensions: ["json"] }] });
    if (typeof path !== "string") return;
    props.onInstalled((await installThemeFile(path)).id);
  });

  const chosen = props.chosen?.source === "installed" ? props.chosen : undefined;
  const remove = () => {
    if (!chosen) return;
    const name = chosen.name;
    void confirmAction({
      title: t`Remove ${name}?`,
      message: t`Lattice goes back to its own colors. Installing the file again brings the theme back.`,
      confirmLabel: t`Remove`,
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) void run(async () => {
        await removeTheme(chosen.id);
        props.onRemoved();
      });
    });
  };

  return (
    <div className="theme-file-actions">
      <div className="theme-file-buttons">
        <Button size="compact" variant="secondary" disabled={state.busy} onClick={() => setBrowsing(true)}>{t`Browse themes…`}</Button>
        {chosen && <Button size="compact" variant="ghost" disabled={state.busy} onClick={remove}>{t`Remove theme`}</Button>}
        <Button size="compact" variant="ghost" disabled={state.busy} onClick={() => void run(revealThemesFolder)}>{t`Show themes folder`}</Button>
        <Button size="compact" variant="secondary" disabled={state.busy} onClick={() => void install()}>{t`Install from file…`}</Button>
      </div>
      {state.error && <InlineMessage level="error">{state.error}</InlineMessage>}
      {browsing && (
        <BrowseThemesSheet mode={props.mode} themes={props.themes} onInstalled={props.onInstalled} onClose={() => setBrowsing(false)} />
      )}
    </div>
  );
}
