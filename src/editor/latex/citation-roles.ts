import { msg } from "@lingui/core/macro";
import { i18n } from "../../i18n";
import type { CitationRole } from "../comments/editor-comment-data";

/** A citation role's name, as its chip shows it. */
export function citationRoleLabel(role: CitationRole): string {
  switch (role) {
    case "supporting": return i18n._(msg({ message: "Supporting", context: "why a passage cites a paper" }));
    case "counterexample": return i18n._(msg({ message: "Counterexample", context: "why a passage cites a paper" }));
    case "method": return i18n._(msg({ message: "Method", context: "why a passage cites a paper" }));
    case "comparison": return i18n._(msg({ message: "Comparison", context: "why a passage cites a paper" }));
    case "background": return i18n._(msg({ message: "Background", context: "why a passage cites a paper" }));
  }
}
