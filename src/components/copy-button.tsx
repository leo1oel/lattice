import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy } from "lucide-react";

type CopyButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  text?: string;
  onCopy?: () => void | Promise<void>;
  onCopied?: () => void;
  iconSize?: number;
  copiedLabel?: string;
  children?: ReactNode;
};

/** One copy interaction everywhere: copy icon, brief green confirmation, reset. */
export function CopyButton({
  text,
  onCopy,
  onCopied,
  iconSize = 13,
  copiedLabel = "Copied",
  children,
  title = "Copy",
  "aria-label": ariaLabel,
  className = "",
  ...buttonProps
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const copy = async () => {
    if (onCopy) await onCopy();
    else if (text !== undefined) await writeText(text);
    setCopied(true);
    onCopied?.();
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
      title={title}
      aria-label={ariaLabel ?? title}
      data-copy-state={copied ? copiedLabel.toLowerCase() : "idle"}
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
