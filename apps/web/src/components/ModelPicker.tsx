import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  modelDisplayName,
  modelParamFamily,
  modelParamLabel,
  modelParamSectionName,
  type ModelOption,
  type ModelParamDto,
} from "@acpio/shared";
import { useT } from "../lib/i18n";
import styles from "./ModelPicker.module.css";

/** Chip text: the resolved label capped to the trigger width; the tooltip keeps it whole. */
function shortLabel(label: string) {
  return label.length > 22 ? `${label.slice(0, 20)}…` : label;
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

/** Show effort/context/fast from stored values before per-model options arrive. */
function fallbackParamChipsFromValues(
  values: Record<string, string>,
  effortPrefix: string,
  contextPrefix: string,
): ParamChip[] {
  const chips: ParamChip[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of Object.entries(values)) {
    const value = raw?.trim() ?? "";
    if (!value) continue;
    const family = modelParamFamily(key);
    if (!family) continue;
    if (seen.has(family)) continue;
    if (family === "fast") {
      const on = value === "true" || value === "1" || value.toLowerCase() === "yes";
      if (!on) continue;
      seen.add(family);
      chips.push({ key, label: "Fast", title: "Fast", kind: "fast" });
      continue;
    }
    seen.add(family);
    if (family === "effort") {
      const full = value.charAt(0).toUpperCase() + value.slice(1);
      chips.push({
        key,
        label: shortEffortChip(full),
        title: `${effortPrefix}: ${full}`,
        kind: "effort",
      });
      continue;
    }
    chips.push({
      key,
      label: value.length > 5 ? value.slice(0, 4).toUpperCase() : value.toUpperCase(),
      title: `${contextPrefix}: ${value}`,
      kind: "other",
    });
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
  if (params.length === 0) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
  }
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
  models: ModelOption[];
  onChange: (value: string) => void;
  params?: ModelParamDto[];
  paramValues?: Record<string, string>;
  /** Per-model params for the ⋯ flyout, keyed by model value. The current model
   *  falls back to `params`; an uncached model shows the loader until filled. */
  paramsByModel?: Record<string, ModelParamDto[]>;
  /** Params picked in a flyout, tagged with the model the flyout was opened for. */
  onParamsChange?: (targetModel: string, params: Record<string, string>) => void;
  /**
   * Load Fast/Effort for a model before showing them.
   * While this promise runs, the popup shows a loader (no stale flicker).
   */
  onParamsOpen?: (model: string) => void | Promise<unknown>;
  /** True while parent is fetching params for the open ⋯ model. */
  paramsLoading?: boolean;
  /** Model value currently being fetched (composer trigger + row ⋯). */
  paramsLoadingFor?: string;
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
  /** Recent models per harness, newest first (settings.recentModelsByProvider). */
  recentModels?: string[];
  /** Starred models per harness (settings.favoriteModelsByProvider). */
  favoriteModels?: string[];
  /** Right-click on a row → add/remove from favorites. Omit to hide the menu. */
  onToggleFavorite?: (modelValue: string) => void;
};

export function ModelPicker({
  model,
  models,
  onChange,
  params = [],
  paramValues = {},
  paramsByModel,
  onParamsChange,
  onParamsOpen,
  paramsLoading = false,
  paramsLoadingFor,
  onOpen,
  showParamsMenu,
  placement = "up",
  variant = "compact",
  className,
  disabled = false,
  loading = false,
  recentModels,
  favoriteModels,
  onToggleFavorite,
}: ModelPickerProps) {
  const t = useT();
  const paramLabels = { yes: t("models.yes"), no: t("models.no") };
  const defaultModelLabel = t("models.auto");
  const effortPrefix = t("models.effort");
  const contextPrefix = t("models.context");
  const [open, setOpen] = useState(false);
  const [menuReady, setMenuReady] = useState(false);
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
  const resolvedParams = useMemo(
    () => resolveParamValues(params, paramValues),
    [params, paramValues],
  );
  const visibleParams = useMemo(
    () => params.filter((p) => p.options.length > 0),
    [params],
  );
  /** The flyout belongs to `paramsFor`, not to the session's model: render that
   *  model's schema so the options match what the row's ⋯ promises to configure. */
  const flyoutParams = useMemo(() => {
    if (!paramsFor || paramsFor === model) return visibleParams;
    const list = paramsByModel?.[paramsFor];
    return list ? list.filter((p) => p.options.length > 0) : [];
  }, [paramsFor, model, paramsByModel, visibleParams]);
  /** Saved values exist only for the session model; other models report their
   *  current pick through `param.currentValue` from the agent probe. */
  const flyoutValues = useMemo(
    () => (paramsFor && paramsFor !== model ? {} : resolvedParams),
    [paramsFor, model, resolvedParams],
  );
  const flyoutBusy =
    localParamsBusy ||
    (paramsLoading && paramsLoadingFor != null && paramsLoadingFor === paramsFor);
  /** The trigger chip reflects the session model only — a background fetch for
   *  another model must not spin it. */
  const showTriggerParamLoader =
    (paramsLoading && (paramsLoadingFor == null || paramsLoadingFor === model)) ||
    (localParamsBusy && (paramsFor == null || paramsFor === model));
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
  /** Rows for the pinned sections, in settings order; unknown ids are dropped. */
  const pickSection = (ids: string[] | undefined) => {
    if (!ids || ids.length === 0) return [];
    const byId: Record<string, (typeof options)[number]> = {};
    for (const m of options) byId[m.value] = m;
    return ids.map((id) => byId[id]).filter(Boolean);
  };
  /** Pinned sections show only without an active filter — search hits the full list. */
  const favoriteOptions = useMemo(
    () => (q ? [] : pickSection(favoriteModels)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [favoriteModels, options, q],
  );
  const recentOptions = useMemo(() => {
    if (q) return [];
    const favs = favoriteModels ?? [];
    return pickSection(recentModels).filter((m) => !favs.includes(m.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentModels, favoriteModels, options, q]);
  /** Right-click menu open for this model value, anchored at the cursor. */
  const [ctxMenu, setCtxMenu] = useState<{ modelValue: string; x: number; y: number } | null>(
    null,
  );
  const paramSummary = activeParamSummary(visibleParams, resolvedParams, paramLabels, effortPrefix, contextPrefix);
  const paramChips = useMemo(() => {
    const fromSchema = activeParamChips(
      visibleParams,
      resolvedParams,
      paramLabels,
      effortPrefix,
      contextPrefix,
    );
    if (fromSchema.length > 0) return fromSchema;
    return fallbackParamChipsFromValues(resolvedParams, effortPrefix, contextPrefix);
  }, [visibleParams, resolvedParams, paramLabels, effortPrefix, contextPrefix]);
  const triggerChips = paramChips;
  const selectedModelName = models.find((m) => m.value === model)?.name;
  // Agent ids can be opaque (ZCode's JSON tuple), so the label comes from the
  // agent's own title — the wire id itself is never shown to the user.
  const fullLabel = model ? modelDisplayName(model, selectedModelName, defaultModelLabel) : "";
  const baseLabel = loading
    ? t("common.loading")
    : !model
      ? t("common.selectModel")
      : shortLabel(fullLabel);
  const triggerLabel =
    variant === "block" && paramSummary && !loading && !showTriggerParamLoader
      ? `${baseLabel} · ${paramSummary}`
      : baseLabel;
  const paramsPopupOpen = paramsFor != null && paramsAnchor != null;

  const closeParams = () => {
    paramsReqRef.current += 1;
    setParamsFor(null);
    setParamsAnchor(null);
    setMenuAnchor(null);
    setLocalParamsBusy(false);
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
    // Skip when layout hasn't been measured yet (jsdom / first frame zeros).
    if (clip && (r.width > 0 || r.height > 0) && (clip.width > 0 || clip.height > 0)) {
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
      setMenuReady(false);
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

  // Portal the menu to document.body (like OptionPicker) so parent overflow:hidden
  // and display:contents wrappers in the composer cannot clip or block it.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const root = rootRef.current;
    if (!open || !menu || !root) return;

    const pad = 12;
    const gap = placement === "down" ? 8 : 10;

    const place = () => {
      const trigger = root.getBoundingClientRect();
      const narrow = window.matchMedia("(max-width: 700px)").matches;

      menu.style.position = "fixed";
      menu.style.zIndex = "1100";
      menu.style.margin = "0";
      menu.style.right = "auto";

      if (placement === "down") {
        menu.style.top = `${trigger.bottom + gap}px`;
        menu.style.bottom = "auto";
        menu.style.left = `${trigger.left}px`;
        menu.style.width = "max-content";
        menu.style.minWidth = `${Math.max(trigger.width, 0)}px`;
        menu.style.maxWidth = `${Math.min(420, window.innerWidth - pad * 2)}px`;
      } else if (narrow) {
        menu.style.top = "auto";
        menu.style.bottom = `${Math.max(pad, window.innerHeight - trigger.top + gap)}px`;
        menu.style.left = "max(12px, env(safe-area-inset-left, 0px))";
        menu.style.right = "max(12px, env(safe-area-inset-right, 0px))";
        menu.style.width = "auto";
        menu.style.maxWidth = "none";
      } else {
        menu.style.top = "auto";
        menu.style.bottom = `${window.innerHeight - trigger.top + gap}px`;
        menu.style.left = `${trigger.left}px`;
        menu.style.width = `${Math.min(320, window.innerWidth - pad * 2)}px`;
        menu.style.maxWidth = `${Math.min(320, window.innerWidth - pad * 2)}px`;
      }

      let left = menu.getBoundingClientRect().left;
      const width = menu.getBoundingClientRect().width;
      if (!(placement === "up" && narrow)) {
        if (left + width > window.innerWidth - pad) {
          left = Math.max(pad, window.innerWidth - pad - width);
        }
        if (left < pad) left = pad;
        menu.style.left = `${left}px`;
      }

      if (placement === "up" && !narrow) {
        const menuWidth = menu.getBoundingClientRect().width;
        let aligned = trigger.right - menuWidth;
        if (aligned < pad) aligned = pad;
        if (aligned + menuWidth > window.innerWidth - pad) {
          aligned = Math.max(pad, window.innerWidth - pad - menuWidth);
        }
        menu.style.left = `${aligned}px`;
      }

      const rect = menu.getBoundingClientRect();
      if (placement === "down" && rect.bottom > window.innerHeight - pad) {
        menu.style.top = "auto";
        menu.style.bottom = `${window.innerHeight - trigger.top + gap}px`;
      } else if (placement !== "down" && rect.top < pad) {
        menu.style.bottom = "auto";
        menu.style.top = `${trigger.bottom + gap}px`;
      }

      const menuRect = menu.getBoundingClientRect();
      setMenuAnchor({
        top: menuRect.top,
        left: menuRect.left,
        bottom: menuRect.bottom,
        right: menuRect.right,
      });
      setMenuReady(true);
    };

    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, placement, disabled, options.length, visibleOptions.length]);

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
    // Scrolling re-anchors the flyout; syncParamsAnchor drops it once the ⋯
    // button leaves the visible list. Closing on ANY scroll killed the flyout
    // on the programmatic scrollIntoView that centers the selected row — and
    // on the momentum scroll a tap leaves behind on touch ("click does nothing").
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && paramsPopupRef.current?.contains(t)) return;
      syncParamsAnchor();
    };
    window.addEventListener("resize", onResize);
    list?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      list?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll, true);
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
  }, [paramsPopupOpen, paramsAnchor, menuAnchor, flyoutBusy, flyoutParams.length, flyoutValues]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
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
  useEffect(() => {
    if (!ctxMenu) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      // Clicks inside the context menu are handled by its own buttons.
      if (t instanceof Element && t.closest("[data-model-ctx-menu]")) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // After load: if the flyout's model has nothing to configure — close it.
  useEffect(() => {
    if (flyoutBusy || !paramsFor) return;
    if (flyoutParams.length === 0) closeParams();
  }, [flyoutBusy, paramsFor, flyoutParams.length]);

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
    const shown = flyoutBusy
      ? flyoutParams.filter((p) => modelParamFamily(p.id) === "fast")
      : flyoutParams;
    const target = paramsFor ?? model;
    const sections = shown.map((param) => {
      const current =
        flyoutValues[param.id] ??
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
                  onParamsChange(target, {
                    ...flyoutValues,
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
                  onParamsChange(target, { ...flyoutValues, [param.id]: opt.value });
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
    return (
      <>
        {sections}
        {flyoutBusy ? (
          <div className={styles.paramsLoader} aria-busy="true">
            <span className={styles.paramsSpinner} aria-hidden />
            <span>{t("common.loadingParams")}</span>
          </div>
        ) : null}
      </>
    );
  };

  const paramsLabel = (paramsFor ? flyoutParams : visibleParams)
    .map((p) => modelParamSectionName(p.id, p.name))
    .join(", ");
  const showMore = showParamsMenu ?? visibleParams.length > 0;
  const rowParamsBusy = (modelValue: string) =>
    (paramsLoading && paramsLoadingFor === modelValue) ||
    (localParamsBusy && paramsFor === modelValue);
  const renderModelRow = (m: (typeof options)[number], key?: string) => {
    const selected = m.value === model;
    const rowActive = paramsFor === m.value;
    return (
      <div
        key={key ?? m.value}
        ref={(el) => {
          if (el) rowRefs.current.set(m.value, el);
          else rowRefs.current.delete(m.value);
        }}
        className={`${styles.modelRow} ${selected ? styles.modelRowActive : ""} ${
          rowActive ? styles.modelRowExpanded : ""
        }`}
        onContextMenu={
          onToggleFavorite
            ? (e) => {
                e.preventDefault();
                setParamsFor(null);
                setCtxMenu({ modelValue: m.value, x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      >
        <button
          type="button"
          role="option"
          aria-selected={selected}
          title={[m.name, m.provider].filter(Boolean).join(" · ")}
          className={styles.modelRowMain}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange(m.value);
            closeParams();
            setOpen(false);
          }}
        >
          <span className={styles.modelOptionName}>
            {(favoriteModels ?? []).includes(m.value) ? (
              <svg
                className={styles.rowStar}
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden
              >
                <path d="M12 2.5l2.9 6.2 6.6.7-4.9 4.5 1.3 6.6L12 17.2 6.1 20.5l1.3-6.6-4.9-4.5 6.6-.7z" />
              </svg>
            ) : null}
            {m.name}
          </span>
          {m.provider ? (
            <span
              className={styles.modelOptionProvider}
              title={`${t("models.provider")}: ${m.provider}`}
            >
              {m.provider}
            </span>
          ) : null}
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
            {rowParamsBusy(m.value) ? (
              <span className={`${styles.paramsSpinner} ${styles.rowMoreSpinner}`} aria-hidden />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.7" />
                <circle cx="12" cy="12" r="1.7" />
                <circle cx="19" cy="12" r="1.7" />
              </svg>
            )}
          </button>
        )}
      </div>
    );
  };

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
        aria-busy={loading || showTriggerParamLoader || undefined}
        disabled={disabled}
        title={
          loading
            ? t("common.loadingModelsList")
            : showTriggerParamLoader
              ? [fullLabel || t("common.model"), t("common.loadingParams")]
                  .filter(Boolean)
                  .join(" · ")
              : [fullLabel || t("common.model"), paramSummary].filter(Boolean).join(" · ")
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
            {showTriggerParamLoader || triggerChips.length > 0 ? (
              <span
                className={styles.modelTriggerChips}
                aria-busy={showTriggerParamLoader || undefined}
                aria-label={showTriggerParamLoader ? t("common.loadingParams") : undefined}
              >
                {triggerChips.map((chip) => (
                  <span
                    key={chip.key}
                    className={`${styles.paramChip} ${
                      chip.kind === "fast"
                        ? styles.paramChipFast
                        : chip.kind === "effort"
                          ? styles.paramChipEffort
                          : styles.paramChipContext
                    }`}
                    title={chip.title}
                  >
                    {chip.label}
                  </span>
                ))}
                {showTriggerParamLoader ? (
                  <span className={`${styles.paramChip} ${styles.paramChipLoading}`} aria-hidden>
                    <span className={styles.paramChipLoader} />
                  </span>
                ) : null}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className={styles.modelTriggerText}>{triggerLabel}</span>
            {showTriggerParamLoader && (
              <span
                className={styles.triggerParamsSpinner}
                aria-label={t("common.loadingParams")}
              />
            )}
          </>
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

      {open &&
        !disabled &&
        createPortal(
          <div
            ref={menuRef}
            className={`${styles.modelMenu} ${styles.modelMenuPortal} ${
              placement === "down" ? styles.modelMenuDown : ""
            }`}
            style={{ visibility: menuReady ? "visible" : "hidden" }}
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
              {favoriteOptions.length > 0 ? (
                <>
                  <div className={styles.sectionHead}>{t("models.favorites")}</div>
                  {favoriteOptions.map((m) => renderModelRow(m, `fav-${m.value}`))}
                </>
              ) : null}
              {recentOptions.length > 0 ? (
                <>
                  <div className={styles.sectionHead}>{t("models.recent")}</div>
                  {recentOptions.map((m) => renderModelRow(m, `rec-${m.value}`))}
                </>
              ) : null}
              {visibleOptions.map((m) => renderModelRow(m))}
            </div>
          </div>,
          document.body,
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

      {ctxMenu && onToggleFavorite
        ? createPortal(
            <div
              data-model-ctx-menu
              className={styles.ctxMenu}
              style={{
                top: Math.min(ctxMenu.y, window.innerHeight - 90),
                left: Math.min(ctxMenu.x, window.innerWidth - 190),
              }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className={styles.ctxMenuItem}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(ctxMenu.modelValue);
                  setCtxMenu(null);
                }}
              >
                {(favoriteModels ?? []).includes(ctxMenu.modelValue)
                  ? t("models.unfavorite")
                  : t("models.favorite")}
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
