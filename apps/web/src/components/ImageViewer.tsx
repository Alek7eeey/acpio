import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useT } from "../lib/i18n";
import { setMessageHotkeyHover } from "../lib/messageHotkeys";
import styles from "./ImageViewer.module.css";

/** One picture under the loupe: the very URL the message already renders. */
export type ViewerPicture = {
  src: string;
  /** The markdown `alt` — the caption, "" when the text gave none. */
  alt: string;
};

type ImageViewerProps = {
  pictures: ViewerPicture[];
  startIndex?: number;
  onClose: () => void;
};

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
/** One click of a zoom control / one wheel notch. */
const ZOOM_STEP = 1.25;
/** A click that turned into a drag must not also toggle the zoom. */
const DRAG_SLOP_PX = 4;
/** Fingers have to travel this far before a pinch counts as a pinch. */
const PINCH_SLOP_PX = 6;

type ViewTransform = {
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  x: number;
  y: number;
};

const FIT: ViewTransform = { scale: 1, rotation: 0, x: 0, y: 0 };

/** One finger dragging the picture, or two of them pinching it apart. */
type Gesture =
  | { kind: "pan"; id: number; x: number; y: number; from: ViewTransform; moved: boolean }
  | {
      kind: "pinch";
      distance: number;
      midX: number;
      midY: number;
      from: ViewTransform;
      moved: boolean;
    };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function Icon({ path, size = 17 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d={path} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={styles.tool} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * Full-screen look at the pictures an agent showed: zoom (buttons, wheel,
 * clicks, two fingers on a touch screen), rotation, and ← / → walk the rest of
 * the message's pictures.
 *
 * The overlay owns the picture it was opened on — the message behind it keeps
 * its own scroll position, and nothing here re-fetches the bytes: the `src` is
 * the URL the message's `<img>` already resolved, so it comes from the cache.
 */
export function ImageViewer({ pictures, startIndex = 0, onClose }: ImageViewerProps) {
  const t = useT();
  const total = pictures.length;
  const [index, setIndex] = useState(() => clamp(startIndex, 0, Math.max(0, total - 1)));
  const [view, setView] = useState<ViewTransform>(FIT);
  const stageRef = useRef<HTMLDivElement>(null);
  /** Every finger currently down in the viewer, by pointer id. */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<Gesture | null>(null);
  /** A gesture is not a tap: the click the browser sends after it is swallowed. */
  const tapIgnoredRef = useRef(false);
  const picture = pictures[index];
  const hasNav = total > 1;

  const go = useCallback(
    (delta: number) => {
      if (total < 2) return;
      setIndex((cur) => (cur + delta + total) % total);
      setView(FIT);
    },
    [total],
  );

  const zoomBy = useCallback((factor: number) => {
    setView((v) => {
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      // A shifted picture keeps its place through the zoom, small ones included.
      const ratio = scale / v.scale;
      return { ...v, scale, x: v.x * ratio, y: v.y * ratio };
    });
  }, []);

  const rotateBy = useCallback((degrees: number) => {
    setView((v) => ({ ...v, rotation: (v.rotation + degrees + 360) % 360 }));
  }, []);

  useEffect(() => {
    // The overlay is on top, so the message under it must not answer the keys
    // the viewer takes (see the capture listener in lib/messageHotkeys).
    setMessageHotkeyHover(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        consume();
        onClose();
        return;
      }
      if (hasNav && (e.key === "ArrowRight" || e.key === "PageDown")) {
        consume();
        go(1);
        return;
      }
      if (hasNav && (e.key === "ArrowLeft" || e.key === "PageUp")) {
        consume();
        go(-1);
        return;
      }
      if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") {
        consume();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") {
        consume();
        zoomBy(1 / ZOOM_STEP);
        return;
      }
      if (e.key === "0") {
        consume();
        setView(FIT);
        return;
      }
      // Physical key: the layout that spells "к" still holds the same key down.
      if (e.code === "KeyR") {
        consume();
        rotateBy(e.shiftKey ? -90 : 90);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [go, zoomBy, rotateBy, onClose, hasNav]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // React binds `wheel` passively, so preventDefault needs its own listener —
    // otherwise the chat behind the overlay scrolls while the reader zooms.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.0015));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  /** Start from the fingers that are down right now: two of them pinch, one of
   *  them drags the picture at any scale (a shrunk one is dragged too), and a
   *  drag that never passes the slop turns out to be a tap. */
  const startGesture = () => {
    const entries = Array.from(pointersRef.current.entries());
    const [first, second] = entries;
    if (first && second) {
      const mid = midpoint(first[1], second[1]);
      gestureRef.current = {
        kind: "pinch",
        distance: Math.max(1, distanceBetween(first[1], second[1])),
        midX: mid.x,
        midY: mid.y,
        from: view,
        moved: false,
      };
      // Two fingers are never a tap on the backdrop, however little they move.
      tapIgnoredRef.current = true;
      return;
    }
    gestureRef.current = first
      ? { kind: "pan", id: first[0], x: first[1].x, y: first[1].y, from: view, moved: false }
      : null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // The toolbar, the arrows and the close button are controls, not a surface.
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    tapIgnoredRef.current = false;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === "pinch") {
      const [a, b] = Array.from(pointers.values());
      if (!a || !b) return;
      const distance = Math.max(1, distanceBetween(a, b));
      const mid = midpoint(a, b);
      const dx = mid.x - gesture.midX;
      const dy = mid.y - gesture.midY;
      if (
        !gesture.moved &&
        Math.abs(distance - gesture.distance) < PINCH_SLOP_PX &&
        Math.abs(dx) < DRAG_SLOP_PX &&
        Math.abs(dy) < DRAG_SLOP_PX
      ) {
        return;
      }
      gesture.moved = true;
      tapIgnoredRef.current = true;
      setView({
        ...gesture.from,
        scale: clamp(gesture.from.scale * (distance / gesture.distance), MIN_SCALE, MAX_SCALE),
        x: gesture.from.x + dx,
        y: gesture.from.y + dy,
      });
      return;
    }

    const point = pointers.get(gesture.id);
    if (!point) return;
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (!gesture.moved && Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return;
    gesture.moved = true;
    tapIgnoredRef.current = true;
    setView({ ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    // A finger left: what is still down carries on (a pinch becomes a drag).
    startGesture();
  };

  const transform: CSSProperties = {
    transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale}) rotate(${view.rotation}deg)`,
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={t("imageViewer.title")}
      onContextMenu={(e) => {
        // The viewer is a portal drawn by the message it was opened from, and a
        // portal bubbles through its React parents — the right click on a big
        // picture is the browser's (copy, save), not the message's own menu.
        e.stopPropagation();
      }}
      onMouseDown={(e) => {
        // Only a left press is a click on the surface: a right one belongs to
        // the browser's menu, which a dismissed overlay has taken away.
        if (e.button !== 0) return;
        if (tapIgnoredRef.current) {
          tapIgnoredRef.current = false;
          return;
        }
        // The empty space around the picture is the way out, the picture itself is not.
        if (e.target === e.currentTarget || e.target === stageRef.current) onClose();
      }}
    >
      <div
        ref={stageRef}
        className={styles.stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {picture ? (
          <img
            className={styles.image}
            style={transform}
            src={picture.src}
            alt={picture.alt}
            draggable={false}
            onClick={() => {
              if (tapIgnoredRef.current) {
                tapIgnoredRef.current = false;
                return;
              }
              setView((v) => (v.scale > 1 ? { ...v, scale: 1, x: 0, y: 0 } : { ...v, scale: 2 }));
            }}
          />
        ) : null}
      </div>

      {hasNav ? (
        <button
          type="button"
          className={`${styles.nav} ${styles.navPrev}`}
          title={t("imageViewer.prev")}
          aria-label={t("imageViewer.prev")}
          onClick={() => go(-1)}
        >
          <Icon path="M14.5 5 8 12l6.5 7" size={22} />
        </button>
      ) : null}
      {hasNav ? (
        <button
          type="button"
          className={`${styles.nav} ${styles.navNext}`}
          title={t("imageViewer.next")}
          aria-label={t("imageViewer.next")}
          onClick={() => go(1)}
        >
          <Icon path="M9.5 5 16 12l-6.5 7" size={22} />
        </button>
      ) : null}

      <button
        type="button"
        className={styles.close}
        title={t("imageViewer.close")}
        aria-label={t("imageViewer.close")}
        onClick={onClose}
      >
        <Icon path="M6 6l12 12M18 6L6 18" />
      </button>

      <div className={styles.bar}>
        <ToolButton title={t("imageViewer.zoomOut")} onClick={() => zoomBy(1 / ZOOM_STEP)}>
          <Icon path="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 21 21M7.5 10.5h6" />
        </ToolButton>
        <span className={styles.zoomLabel}>{Math.round(view.scale * 100)}%</span>
        <ToolButton title={t("imageViewer.zoomIn")} onClick={() => zoomBy(ZOOM_STEP)}>
          <Icon path="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 21 21M7.5 10.5h6M10.5 7.5v6" />
        </ToolButton>
        <span className={styles.barGap} />
        <ToolButton title={t("imageViewer.rotateLeft")} onClick={() => rotateBy(-90)}>
          <Icon path="M4 9h9a5 5 0 0 1 0 10H8M4 9l3.5-3.5M4 9l3.5 3.5" />
        </ToolButton>
        <ToolButton title={t("imageViewer.rotateRight")} onClick={() => rotateBy(90)}>
          <Icon path="M20 9h-9a5 5 0 0 0 0 10h5M20 9l-3.5-3.5M20 9l-3.5 3.5" />
        </ToolButton>
        <ToolButton title={t("imageViewer.reset")} onClick={() => setView(FIT)}>
          <Icon path="M5 9V5h4M19 15v4h-4M19 9V5h-4M5 15v4h4" />
        </ToolButton>
      </div>

      <div className={styles.footer}>
        <div className={styles.meta}>
          {hasNav ? (
            <span className={styles.counter}>
              {t("imageViewer.counter", { current: index + 1, total })}
            </span>
          ) : null}
          {picture?.alt ? (
            <span className={styles.caption} title={picture.alt}>
              {picture.alt}
            </span>
          ) : null}
        </div>
        <span className={styles.hint}>{t("imageViewer.hint")}</span>
      </div>
    </div>
  );
}
