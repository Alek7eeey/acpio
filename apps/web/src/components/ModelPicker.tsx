import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  modelDisplayName,
  modelParamFamily,
  modelParamLabel,
  modelParamSectionName,
  type ModelParamDto,
} from "@acprocess/shared";
import { useT } from "../lib/i18n";
import styles from "./ModelPicker.module.css";

function shortModelName(value: string, name: string | undefined, defaultLabel: string) {
  const raw = modelDisplayName(value, name, defaultLabel);
  const tail = raw.includes("/") ? raw.split("/").pop()! : raw;
  return tail.length > 22 ? `${tail.slice(0, 20)}…` : tail;
}

function optionLabel(
  param: ModelParamDto,
  value: string,
  name: string | undefined,
  labels: { yes: string; no: string },
) {
  return modelParamLabel(param.id, value, name, labels);
}

function shortEffortChip(label: string): string {
  const map: Record<string, string> = {
    none: "Off",
    нет: "Off",
    low: "Low",
    низкий: "Low",
    medium: "Med",
    средний: "Med",
    high: "High",
    высокий: "High",
    "extra high": "XHigh",
    "очень высокий": "XHigh",
    max: "Max",
    макс: "Max",
    minimal: "Min",
    минимальный: "Min",
    default: "Def",
    "по умолчанию": "Def",
  };
  return map[label.toLowerCase()] ?? (label.length > 6 ? `${label.slice(0, 5)}…` : label);
}

type ParamChip = { key: string; label: string; title: string; kind: "fast" | "effort" | "other" };

function activeParamChips(
  params: ModelParamDto[],
  values: Record<string, string>,
  labels: { yes: string; no: string },
  effortPrefix: string,
  contextPrefix: string,
): ParamChip[] {
  const chips: ParamChip[] = [];
  for (const param of params) {
    const value = values[param.id] ?? param.currentValue ?? "";
    if (!value) continue;
    const family = modelParamFamily(param.id);
    if (family === "fast") {
      const on = value === "true" || value === "1" || value.toLowerCase() === "yes";
      if (!on) continue;
      chips.push({ key: param.id, label: "Fast", title: "Fast", kind: "fast" });
      continue;
    }
    const opt = param.options.find((o) => o.value === value);
    const full = optionLabel(param, value, opt?.name, labels);
    if (family === "effort") {
      chips.push({
        key: param.id,
        label: shortEffortChip(full),
        title: `${effortPrefix}: ${full}`,
        kind: "effort",
      });
      continue;
    }
    if (family === "context") {
      chips.push({
        key: param.id,
        label: full.length > 5 ? full.slice(0, 4).toUpperCase() : full.toUpperCase(),
        title: `${contextPrefix}: ${full}`,
        kind: "other",
      });
    }
  }
  return chips;
}

function activeParamSummary(
  params: ModelParamDto[],
  values: Record<string, string>,
  labels: { yes: string; no: string },
  effortPrefix: string,
  contextPrefix: string,
): string {
  return activeParamChips(params, values, labels, effortPrefix, contextPrefix)
    .map((c) => c.title)
    .join(" · ");
}

function resolveParamValues(
  params: ModelParamDto[],
  values: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const param of params) {
    const value =
      values[param.id] ??
      param.currentValue ??
      param.options[0]?.value ??
      "";
    if (value !== "") next[param.id] = value;
  }
  return next;
}

type AnchorRect = { top: number; left: number; bottom: number; right: number };

/** Place flyout outside the model menu so the selected row stays visible. */
function flyoutStyle(
  btn: AnchorRect,
  menu: AnchorRect | null,
  flyoutHeight: number,
): { top: number; left: number; width: number; maxHeight: number } {
  const margin = 12;
  const gap = 8;
  const width = Math.min(280, window.innerWidth - margin * 2);
  const maxHeight = Math.min(360, window.innerHeight - margin * 2);
  const measured = Math.min(Math.max(flyoutHeight, 120), maxHeight);
  const height = measured;
  const box = menu ?? btn;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const candidates = [
    box.left - gap - width,
    box.right + gap,
    btn.left - gap - width,
    btn.right + gap,
    (vw - width) / 2,
  ];

  let left = Math.max(margin, Math.min(candidates[0], vw - width - margin));
  for (const candidate of candidates) {
    if (candidate >= margin && candidate + width <= vw - margin) {
      left = candidate;
      break;
    }
  }
  left = Math.max(margin, Math.min(left, vw - width - margin));

  const rowMid = (btn.top + btn.bottom) / 2;
  let top = rowMid - height / 2;
  if (top + height > vh - margin) {
    top = vh - margin - height;
  }
  top = Math.max(margin, Math.min(top, vh - height - margin));

  return { top, left, width, maxHeight };
}

type ModelPickerProps = {
  model: string;
  models: Array<{ value: string; name: string }>;
  onChange: (value: string) => void;
  params?: ModelParamDto[];
  paramValues?: Record<string, string>;
  onParamsChange?: (params: Record<string, string>) => void;
  /**
   * Load Fast/Effort for a model before showing them.
   * While this promise runs, the popup shows a loader (no stale flicker).
   */
  onParamsOpen?: (model: string) => void | Promise<void>;
  /** True while parent is fetching params for the open ⋯ model. */
  paramsLoading?: boolean;
  /** Called when the dropdown opens — use to refresh params for the current agent. */
  onOpen?: () => void;
  /**
   * Show the per-model ⋯ menu even before params have loaded.
   * Defaults to visible whenever `params` has options.
   */
  showParamsMenu?: boolean;
  placement?: "up" | "down";
  variant?: "compact" | "block";
  className?: string;
  disabled?: boolean;
  loading?: boolean;
};

export function ModelPicker({
  model,
  models,
  onChange,
  params = [],
  paramValues = {},
  onParamsChange,
  onParamsOpen,
  paramsLoading = false,
  onOpen,
  showParamsMenu,
  placement = "up",
  variant = "compact",
  className,
  disabled = false,
  loading = false,
}: ModelPickerProps) {
  const t = useT();
  const paramLabels = { yes: t("models.yes"), no: t("models.no") };
  const defaultModelLabel = t("models.auto");
  const effortPrefix = t("models.effort");
  const contextPrefix = t("models.context");
  const [open, setOpen] = useState(false);
  /** Filter typed into the model list. */
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  /** ⋯ popup open for this model value. */
  const [paramsFor, setParamsFor] = useState<string | null>(null);
  const [localParamsBusy, setLocalParamsBusy] = useState(false);
  const [paramsAnchor, setParamsAnchor] = useState<AnchorRect | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<AnchorRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const paramsPopupRef = useRef<HTMLDivElement>(null);
  const moreBtnRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const paramsReqRef = useRef(0);
  const paramsBusy = paramsLoading || localParamsBusy;
  const resolvedParams = useMemo(
    () => resolveParamValues(params, paramValues),
    [params, paramValues],
  );
  const visibleParams = useMemo(
    () => params.filter((p) => p.options.length > 0),
    [params],
  );
  const options = useMemo(
    () =>
      models.map((m) => ({
        ...m,
        name: modelDisplayName(m.value, m.name, defaultModelLabel),
      })),
    [models, defaultModelLabel],
  );
  const q = query.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!q) return options;
    return options.filter(
      (m) => m.name.toLowerCase().includes(q) || m.value.toLowerCase().includes(q),
    );
  }, [options, q]);
  const paramSummary = activeParamSummary(visibleParams, resolvedParams, paramLabels, effortPrefix, contextPrefix);
  const paramChips = useMemo(
    () => (paramsBusy ? [] : activeParamChips(visibleParams, resolvedParams, paramLabels, effortPrefix, contextPrefix)),
    [visibleParams, resolvedParams, paramsBusy, paramLabels, effortPrefix, contextPrefix],
  );
  const baseLabel = loading
    ? t("common.loading")
    : !model
      ? t("common.selectModel")
      : shortModelName(model, models.find((m) => m.value === model)?.name, defaultModelLabel);
  const triggerLabel =
    variant === "block" && paramSummary && !loading && !paramsBusy
      ? `${baseLabel} · ${paramSummary}`
      : baseLabel;
  const paramsPopupOpen = paramsFor != null && paramsAnchor != null;

  const closeParams = () => {
    setParamsFor(null);
    setParamsAnchor(null);
    setMenuAnchor(null);
  };

  const syncParamsAnchor = () => {
    if (!paramsFor) {
      setParamsAnchor(null);
      setMenuAnchor(null);
      return;
    }
    const btn = moreBtnRefs.current.get(paramsFor);
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const clipEl = listRef.current ?? menuRef.current;
    const clip = clipEl?.getBoundingClientRect();
    // Button scrolled out of the visible list — drop the flyout instead of chasing it.
    if (clip) {
      const visible =
        r.bottom > clip.top + 4 &&
        r.top < clip.bottom - 4 &&
        r.right > clip.left + 2 &&
        r.left < clip.right - 2;
      if (!visible) {
        closeParams();
        return;
      }
    }
    setParamsAnchor({ top: r.top, left: r.left, bottom: r.bottom, right: r.right });
    const menu = menuRef.current?.getBoundingClientRect();
    if (menu) {
      setMenuAnchor({ top: menu.top, left: menu.left, bottom: menu.bottom, right: menu.right });
    }
  };

  useEffect(() => {
    // Hard-disabled pickers close; merely loading keeps the menu open so it
    // can show the loading state and then the populated list.
    if (disabled) {
      setOpen(false);
      closeParams();
      setLocalParamsBusy(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      closeParams();
      setLocalParamsBusy(false);
      setQuery("");
    }
  }, [open]);

  // Focus the filter when the dropdown opens, and drop the params flyout
  // while the user types (its row may be filtered out from under it).
  useEffect(() => {
    if (!open) return;
    if (options.length > 0) searchRef.current?.focus();
  }, [open, options.length]);

  useEffect(() => {
    if (q) closeParams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // On phones, pin the menu to the viewport with side padding so it doesn't hug the left edge.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const root = rootRef.current;
    if (!open || !menu || !root) return;

    const clear = () => {
      menu.style.position = "";
      menu.style.left = "";
      menu.style.right = "";
      menu.style.top = "";
      menu.style.bottom = "";
      menu.style.width = "";
      menu.style.maxWidth = "";
    };

    const place = () => {
      const narrow = window.matchMedia("(max-width: 700px)").matches;
      if (!narrow) {
        clear();
        if (placement === "down") {
          const rootRect = root.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          if (menuRect.right > window.innerWidth - 12 && menuRect.width > rootRect.width + 1) {
            menu.style.left = "auto";
            menu.style.right = "0";
          }
        }
        return;
      }
      const trigger = root.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left = "max(12px, env(safe-area-inset-left, 0px))";
      menu.style.right = "max(12px, env(safe-area-inset-right, 0px))";
      menu.style.width = "auto";
      menu.style.maxWidth = "none";
      if (placement === "down") {
        menu.style.top = `${Math.min(trigger.bottom + 8, window.innerHeight - 80)}px`;
        menu.style.bottom = "auto";
      } else {
        menu.style.bottom = `${Math.max(12, window.innerHeight - trigger.top + 10)}px`;
        menu.style.top = "auto";
      }
    };

    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      clear();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, placement, disabled]);

  useLayoutEffect(() => {
    if (!open || !model || !listRef.current) return;
    const row = rowRefs.current.get(model);
    if (!row) return;
    row.scrollIntoView({ block: "center", inline: "nearest" });
  }, [open, model, visibleOptions.length]);

  useLayoutEffect(() => {
    if (!paramsFor) return;
    syncParamsAnchor();
    const list = listRef.current;
    const onResize = () => syncParamsAnchor();
    const onListScroll = () => closeParams();
    const onWinScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && paramsPopupRef.current?.contains(t)) return;
      if (t === list || (t instanceof Node && list?.contains(t))) {
        closeParams();
        return;
      }
      syncParamsAnchor();
    };
    window.addEventListener("resize", onResize);
    list?.addEventListener("scroll", onListScroll, { passive: true });
    window.addEventListener("scroll", onWinScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      list?.removeEventListener("scroll", onListScroll);
      window.removeEventListener("scroll", onWinScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsFor, open, options.length]);

  const refineFlyoutPosition = () => {
    const el = paramsPopupRef.current;
    if (!el || !paramsAnchor) return;
    const layout = flyoutStyle(paramsAnchor, menuAnchor, el.offsetHeight);
    el.style.top = `${layout.top}px`;
    el.style.left = `${layout.left}px`;
    el.style.width = `${layout.width}px`;
    el.style.maxHeight = `${layout.maxHeight}px`;
  };

  useLayoutEffect(() => {
    if (!paramsPopupOpen) return;
    refineFlyoutPosition();
    const onResize = () => refineFlyoutPosition();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsPopupOpen, paramsAnchor, menuAnchor, paramsBusy, visibleParams.length, resolvedParams]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (paramsPopupRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (paramsFor) closeParams();
        else setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, paramsFor]);

  // After load: if this model has nothing to configure — close flyout.
  useEffect(() => {
    if (paramsBusy || !paramsFor) return;
    if (visibleParams.length === 0) closeParams();
  }, [paramsBusy, paramsFor, visibleParams.length]);

  const openParamsFor = async (modelValue: string, btn: HTMLButtonElement) => {
    const req = ++paramsReqRef.current;
    const r = btn.getBoundingClientRect();
    setParamsAnchor({ top: r.top, left: r.left, bottom: r.bottom, right: r.right });
    const menu = menuRef.current?.getBoundingClientRect();
    if (menu) {
      setMenuAnchor({ top: menu.top, left: menu.left, bottom: menu.bottom, right: menu.right });
    }
    setParamsFor(modelValue);
    setLocalParamsBusy(true);
    try {
      await onParamsOpen?.(modelValue);
    } finally {
      if (paramsReqRef.current === req) setLocalParamsBusy(false);
    }
  };

  const renderParamSections = () => {
    if (paramsBusy) {
      return (
        <div className={styles.paramsLoader} aria-busy="true">
          <span className={styles.paramsSpinner} aria-hidden />
          <span>{t("common.loading")}</span>
        </div>
      );
    }
    return visibleParams.map((param) => {
      const current =
        resolvedParams[param.id] ??
        param.currentValue ??
        param.options[0]?.value ??
        "";
      const family = modelParamFamily(param.id);
      const title =
        family === "fast" ? t("models.auto") : modelParamSectionName(param.id, param.name);

      if (family === "fast") {
        const onValues = new Set(
          param.options
            .filter((o) => /^(true|1|yes)$/i.test(o.value))
            .map((o) => o.value),
        );
        const offValues = new Set(
          param.options
            .filter((o) => /^(false|0|no)$/i.test(o.value))
            .map((o) => o.value),
        );
        const onValue = [...onValues][0] ?? "true";
        const offValue = [...offValues][0] ?? "false";
        const isOn =
          onValues.has(current) ||
          (!offValues.has(current) && /^(true|1|yes)$/i.test(current));
        return (
          <div key={param.id} className={styles.paramSection} role="group" aria-label={title}>
            <div className={styles.fastToggleRow}>
              <span className={styles.fastToggleLabel}>{title}</span>
              <button
                type="button"
                role="switch"
                aria-checked={isOn}
                aria-label={title}
                className={`${styles.fastSwitch} ${isOn ? styles.fastSwitchOn : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!onParamsChange) return;
                  onParamsChange({
                    ...resolvedParams,
                    [param.id]: isOn ? offValue : onValue,
                  });
                }}
              >
                <span className={styles.fastSwitchThumb} aria-hidden />
              </button>
            </div>
          </div>
        );
      }

      return (
        <div key={param.id} className={styles.paramSection} role="group" aria-label={title}>
          <div className={styles.modelMenuHead}>{title}</div>
          {param.options.map((opt) => {
            const selected = opt.value === current;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`${styles.modelOption} ${selected ? styles.modelOptionActive : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!onParamsChange) return;
                  onParamsChange({ ...resolvedParams, [param.id]: opt.value });
                }}
              >
                <span className={styles.modelOptionName}>
                  {optionLabel(param, opt.value, opt.name, paramLabels)}
                </span>
              </button>
            );
          })}
        </div>
      );
    });
  };

  const paramsLabel = visibleParams
    .map((p) => modelParamSectionName(p.id, p.name))
    .join(", ");
  const showMore = showParamsMenu ?? visibleParams.length > 0;

  return (
    <div
      className={`${styles.modelPicker} ${variant === "block" ? styles.block : ""} ${
        open ? styles.modelPickerOpen : ""
      } ${className ?? ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className={`${styles.modelTrigger} ${variant === "block" ? styles.modelTriggerBlock : ""} ${
          open ? styles.modelTriggerOpen : ""
        } ${disabled ? styles.modelTriggerDisabled : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={loading || undefined}
        disabled={disabled}
        title={
          loading
            ? t("common.loadingModelsList")
            : [model || t("common.model"), paramSummary].filter(Boolean).join(" · ")
        }
        onClick={() => {
          if (disabled) return;
          setOpen((v) => {
            const next = !v;
            if (next) onOpen?.();
            else {
              closeParams();
            }
            return next;
          });
        }}
      >
        <span className={styles.modelBot} aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect x="5" y="8" width="14" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="9.5" cy="13" r="1.2" fill="currentColor" />
            <circle cx="14.5" cy="13" r="1.2" fill="currentColor" />
            <path d="M12 4v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="12" cy="3.2" r="1.1" fill="currentColor" />
          </svg>
        </span>
        {variant === "compact" ? (
          <>
            <span className={styles.modelTriggerName}>{baseLabel}</span>
            {paramChips.length > 0 && (
              <span className={styles.modelTriggerChips} aria-hidden={false}>
                {paramChips.map((chip) => (
                  <span
                    key={chip.key}
                    className={`${styles.paramChip} ${
                      chip.kind === "fast"
                        ? styles.paramChipFast
                        : chip.kind === "effort"
                          ? styles.paramChipEffort
                          : ""
                    }`}
                    title={chip.title}
                  >
                    {chip.label}
                  </span>
                ))}
              </span>
            )}
          </>
        ) : (
          <span className={styles.modelTriggerText}>{triggerLabel}</span>
        )}
        <span className={styles.modelChevron} aria-hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && !disabled && (
        <div
          ref={menuRef}
          className={`${styles.modelMenu} ${placement === "down" ? styles.modelMenuDown : ""}`}
          role="listbox"
        >
          <div className={styles.modelMenuHead}>{t("common.model")}</div>
          {options.length === 0 ? (
            loading ? (
              <div className={`${styles.modelEmpty} ${styles.modelEmptyLoading}`} aria-busy="true">
                <span className={styles.paramsSpinner} aria-hidden />
                <span>{t("common.loadingModels")}</span>
              </div>
            ) : (
              <div className={styles.modelEmpty}>{t("common.emptyList")}</div>
            )
          ) : (
            <div className={styles.modelSearch}>
              <svg className={styles.modelSearchIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                className={styles.modelSearchInput}
                type="text"
                value={query}
                placeholder={t("common.modelSearchPlaceholder")}
                aria-label={t("common.modelSearchPlaceholder")}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              {query && (
                <button
                  type="button"
                  className={styles.modelSearchClear}
                  aria-label={t("common.modelSearchClear")}
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {options.length > 0 && q && visibleOptions.length === 0 && (
            <div className={styles.modelEmpty}>{t("common.modelSearchEmpty")}</div>
          )}
          <div className={styles.modelList} ref={listRef}>
            {visibleOptions.map((m) => {
              const selected = m.value === model;
              const rowActive = paramsFor === m.value;
              return (
                <div
                  key={m.value}
                  ref={(el) => {
                    if (el) rowRefs.current.set(m.value, el);
                    else rowRefs.current.delete(m.value);
                  }}
                  className={`${styles.modelRow} ${selected ? styles.modelRowActive : ""} ${
                    rowActive ? styles.modelRowExpanded : ""
                  }`}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    title={m.name}
                    className={styles.modelRowMain}
                    onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                      onChange(m.value);
                      closeParams();
                      setOpen(false);
                    }}
                  >
                    <span className={styles.modelOptionName}>{m.name}</span>
                  </button>
                  {showMore && (
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) moreBtnRefs.current.set(m.value, el);
                        else moreBtnRefs.current.delete(m.value);
                      }}
                      className={`${styles.rowMore} ${rowActive ? styles.rowMoreOpen : ""}`}
                      aria-label={paramsLabel || t("common.params")}
                      aria-expanded={rowActive}
                      aria-haspopup="dialog"
                      title={paramsLabel || t("common.params")}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (paramsFor === m.value) {
                          closeParams();
                          return;
                        }
                        void openParamsFor(m.value, e.currentTarget);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <circle cx="5" cy="12" r="1.7" />
                        <circle cx="12" cy="12" r="1.7" />
                        <circle cx="19" cy="12" r="1.7" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {paramsPopupOpen &&
        createPortal(
          <div
            ref={paramsPopupRef}
            className={styles.paramsFlyout}
            style={flyoutStyle(paramsAnchor, menuAnchor, 240)}
            role="dialog"
            aria-label={paramsLabel || t("common.params")}
          >
            {renderParamSections()}
          </div>,
          document.body,
        )}
    </div>
  );
}
