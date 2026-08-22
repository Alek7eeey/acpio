import { useCallback, useState, type ReactNode, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import styles from "./HoverTip.module.css";

type HoverTipProps = {
  text?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: "button" | "div" | "span";
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  /** Wrap long copy instead of clipping (native `title` is truncated on Windows). */
  wrap?: boolean;
  "aria-label"?: string;
  "aria-disabled"?: boolean | "true" | "false";
};

export function HoverTip({
  text,
  children,
  className,
  style,
  as = "div",
  type = "button",
  disabled,
  wrap = false,
  ...rest
}: HoverTipProps) {
  const t = useT();
  const tipText = text ?? t("common.notImplemented");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const onMove = useCallback((e: MouseEvent) => {
    setPos({ x: e.clientX, y: e.clientY });
  }, []);

  const onLeave = useCallback(() => setPos(null), []);

  const Tip =
    pos &&
    createPortal(
      <div
        className={`${styles.tip} ${wrap ? styles.tipWrap : ""}`}
        style={{ left: pos.x, top: pos.y }}
        role="tooltip"
      >
        {tipText}
      </div>,
      document.body,
    );

  const shared = {
    className: `${styles.host} ${wrap ? styles.hostLabel : ""} ${className ?? ""}`,
    style,
    onMouseMove: onMove,
    onMouseEnter: onMove,
    onMouseLeave: onLeave,
    ...rest,
  };

  if (as === "button") {
    return (
      <>
        <button type={type} disabled={disabled} {...shared}>
          {children}
        </button>
        {Tip}
      </>
    );
  }

  if (as === "span") {
    return (
      <>
        <span {...shared}>{children}</span>
        {Tip}
      </>
    );
  }

  return (
    <>
      <div {...shared}>{children}</div>
      {Tip}
    </>
  );
}
