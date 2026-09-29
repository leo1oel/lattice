import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy } from "lucide-react";
import { useLingui } from "@lingui/react/macro";

type CopyButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  text: string;
  iconSize?: number;
  children?: ReactNode;
};

/** One copy interaction everywhere: copy icon, brief green confirmation, reset. */
export function CopyButton({
  text,
  iconSize = 13,
  children,
  title,
  "aria-label": ariaLabel,
  className = "",
  ...buttonProps
}: CopyButtonProps) {
  const { t } = useLingui();
  const resolvedTitle = title ?? t`Copy`;
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const copy = async () => {
    await writeText(text);
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, 1600);
  };

  return (
    <button
      type="button"
      {...buttonProps}
      className={`copy-button ${copied ? "copied" : ""} ${className}`.trim()}
      title={resolvedTitle}
      aria-label={ariaLabel ?? resolvedTitle}
      data-copy-state={copied ? "copied" : "idle"}
      onClick={() => void copy()}
    >
      <span className="copy-button-icon" aria-hidden="true">
        <Copy className="copy-icon-idle" size={iconSize} />
        <Check className="copy-icon-success" size={iconSize} />
      </span>
      {children}
    </button>
  );
}
