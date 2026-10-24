import { useMemo } from "react";
import type { SharedDeckProps } from "./open-slide-deck-pool";

/** The canvas's deck settings and callbacks as SharedDeckProps, a new object only when one of them changes. */
export function useSharedDeckProps(
  { projectRoot, locale, theme }: Pick<SharedDeckProps, "projectRoot" | "locale" | "theme">,
  { onOpenSlideMutation, onOpenSlideContext, onOpenSlideError, onOpenSlideAgentRequest }: {
    onOpenSlideMutation: SharedDeckProps["onMutation"];
    onOpenSlideContext?: SharedDeckProps["onContext"];
    onOpenSlideError?: SharedDeckProps["onError"];
    onOpenSlideAgentRequest?: SharedDeckProps["onAgentRequest"];
  },
): SharedDeckProps {
  return useMemo(() => ({
    projectRoot, locale, theme, onMutation: onOpenSlideMutation, onContext: onOpenSlideContext, onError: onOpenSlideError,
    onAgentRequest: onOpenSlideAgentRequest,
  }), [locale, onOpenSlideAgentRequest, onOpenSlideContext, onOpenSlideError, onOpenSlideMutation, projectRoot, theme]);
}
