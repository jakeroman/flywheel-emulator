import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

const STORAGE_KEY = "fw-panel-width";
const MIN = 320;
const KEY_STEP = 24;

function clampWidth(w: number): number {
  const max = Math.round(window.innerWidth * 0.75);
  return Math.max(MIN, Math.min(w, max));
}

export interface ResizerProps {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

/**
 * Width state for a right-hand panel resized by a vertical divider. The divider
 * sits at the panel's left edge, so dragging it left widens the panel; Left/
 * Right arrows nudge it when focused. The chosen width persists to localStorage.
 */
export function useResizableWidth(defaultWidth = 460): {
  width: number;
  resizerProps: ResizerProps;
} {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved >= MIN ? saved : defaultWidth;
  });
  const dragging = useRef(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width));
  }, [width]);

  const onPointerDown = useCallback((e: PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current) return;
    setWidth(clampWidth(window.innerWidth - e.clientX));
  }, []);

  const onPointerUp = useCallback((e: PointerEvent) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth((w) => clampWidth(w + KEY_STEP)); // wider panel
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth((w) => clampWidth(w - KEY_STEP)); // narrower panel
    }
  }, []);

  return {
    width,
    resizerProps: { onPointerDown, onPointerMove, onPointerUp, onKeyDown },
  };
}
