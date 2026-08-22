import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SlashCommandDto } from "@acprocess/shared";
import { useT } from "../lib/i18n";
import { isSlashSkill } from "../lib/slashCommands";
import styles from "./SlashCommandMenu.module.css";

type SlashCommandMenuProps = {
  open: boolean;
  commands: SlashCommandDto[];
  activeIndex: number;
  scrollActiveIntoView?: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (command: SlashCommandDto) => void;
  onActiveIndexChange: (index: number) => void;
};

function SlashCommandMenuInner({
  open,
  commands,
  activeIndex,
  scrollActiveIntoView = false,
  anchorRef,
  onSelect,
  onActiveIndexChange,
}: SlashCommandMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) return;
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(420, window.innerWidth - 24);
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.7, rect.top - 12));
      menu.style.left = `${left}px`;
      menu.style.width = `${width}px`;
      menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      menu.style.maxHeight = `${maxH}px`;
      menu.scrollTop = 0;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchorRef]);

  useLayoutEffect(() => {
    if (!open || !scrollActiveIntoView || !menuRef.current) return;
    const menu = menuRef.current;
    const active = menu.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    if (!active) return;
    const menuRect = menu.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < menuRect.top) {
      menu.scrollTop -= menuRect.top - activeRect.top;
    } else if (activeRect.bottom > menuRect.bottom) {
      menu.scrollTop += activeRect.bottom - menuRect.bottom;
    }
  }, [activeIndex, open, scrollActiveIntoView]);

  if (!open || commands.length === 0) return null;

  const items: ReactNode[] = [];
  let skillsHeading = false;
  commands.forEach((cmd, idx) => {
    if (isSlashSkill(cmd) && !skillsHeading) {
      skillsHeading = true;
      items.push(
        <div key="section-skills" className={styles.section} role="presentation">
          {t("common.skills")}
        </div>,
      );
    }
    items.push(
      <button
        key={cmd.name}
        type="button"
        role="option"
        data-idx={idx}
        aria-selected={idx === activeIndex}
        className={`${styles.item}${idx === activeIndex ? ` ${styles.itemActive}` : ""}`}
        onMouseEnter={() => onActiveIndexChange(idx)}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelect(cmd);
        }}
      >
        <span className={styles.name}>/{cmd.name}</span>
        <span className={styles.description}>{cmd.description}</span>
        {cmd.inputHint ? <span className={styles.hint}>{cmd.inputHint}</span> : null}
      </button>,
    );
  });

  return createPortal(
    <div ref={menuRef} className={styles.menu} role="listbox" aria-label={t("common.skills")}>
      {items}
    </div>,
    document.body,
  );
}

export const SlashCommandMenu = memo(SlashCommandMenuInner);
