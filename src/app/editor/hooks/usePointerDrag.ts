'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Keeps a ref pointing at the latest value without writing to the ref during
 * render. Read it from event handlers, never during render.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Window-level pointer tracking for drag / resize gestures.
 *
 * Returns an `attach` function to call from a pointerdown handler. The move and
 * end handlers are read through a ref, so the latest closures are always used,
 * the exact listeners that were added are the ones removed, and nothing is left
 * attached if the component unmounts mid-drag.
 */
export function useWindowPointerDrag(
  onMove: (e: PointerEvent) => void,
  onEnd: (e: PointerEvent) => void,
) {
  const handlers = useLatestRef({ onMove, onEnd });
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => () => detachRef.current?.(), []);

  return useCallback(() => {
    detachRef.current?.();
    const move = (e: PointerEvent) => handlers.current.onMove(e);
    const up = (e: PointerEvent) => {
      detachRef.current?.();
      handlers.current.onEnd(e);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    detachRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      detachRef.current = null;
    };
  }, [handlers]);
}
