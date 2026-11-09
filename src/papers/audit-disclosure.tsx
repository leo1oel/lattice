import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** A collapsed section of the reference check, with the drawer's rotating chevron. */
export function Disclosure(props: { className: string; summary: ReactNode; open?: boolean; children: ReactNode }) {
  return <details className={props.className} open={props.open}>
    <summary><ChevronRight size={12} className="bibliography-audit-chevron" />{props.summary}</summary>
    {props.children}
  </details>;
}
