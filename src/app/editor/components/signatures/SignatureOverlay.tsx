'use client';

import React, { useCallback, useRef, useState } from 'react';
import { PenLine, Lock, Trash2, RotateCw, X } from 'lucide-react';
import type { VisualSignature } from '@/engine';
import { useLatestRef, useWindowPointerDrag } from '../../hooks/usePointerDrag';

export interface SignatureOverlayProps {
  signature: VisualSignature;
  /** Resolved appearance image (PNG/SVG data URL). */
  imageDataUrl: string | null;
  scale: number;
  selected: boolean;
  toCss: (pdf: { x: number; y: number; width: number; height: number }) => {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  onSelect: (id: string) => void;
  onCommitMove: (id: string, dx: number, dy: number) => void;
  onCommitResize: (id: string, width: number, height: number) => void;
  onCommitRotate: (id: string, degrees: number) => void;
  onDelete: (id: string) => void;
  onDeselect: () => void;
}

type DragMode = 'move' | 'resize-se' | 'rotate' | null;

/**
 * Interactive signature overlay — select, move, resize, rotate, delete.
 * Renders above page contents; mutations commit on pointer-up.
 */
export function SignatureOverlay(props: SignatureOverlayProps) {
  const {
    signature: sig,
    imageDataUrl,
    scale,
    selected,
    toCss,
    onSelect,
    onCommitMove,
    onCommitResize,
    onCommitRotate,
    onDelete,
    onDeselect,
  } = props;

  const [live, setLive] = useState({
    x: sig.x,
    y: sig.y,
    width: sig.width,
    height: sig.height,
    rotation: sig.rotation,
  });
  const liveRef = useLatestRef(live);

  // Re-sync the live frame whenever the signature changes
  // (adjusting state during render instead of in an effect).
  const sigKey = `${sig.id}|${sig.x}|${sig.y}|${sig.width}|${sig.height}|${sig.rotation}`;
  const [syncedSigKey, setSyncedSigKey] = useState(sigKey);
  if (syncedSigKey !== sigKey) {
    setSyncedSigKey(sigKey);
    setLive({
      x: sig.x,
      y: sig.y,
      width: sig.width,
      height: sig.height,
      rotation: sig.rotation,
    });
  }

  const dragMode = useRef<DragMode>(null);
  const origin = useRef({
    clientX: 0,
    clientY: 0,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
  });

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const mode = dragMode.current;
      if (!mode || sig.locked) return;
      const dxCss = e.clientX - origin.current.clientX;
      const dyCss = e.clientY - origin.current.clientY;
      const dx = dxCss / scale;
      const dy = -dyCss / scale;

      if (mode === 'move') {
        setLive({
          ...liveRef.current,
          x: origin.current.x + dx,
          y: origin.current.y + dy,
        });
      } else if (mode === 'resize-se') {
        const newW = Math.max(24, origin.current.width + dxCss / scale);
        const newH = Math.max(16, origin.current.height + dyCss / scale);
        const top = origin.current.y + origin.current.height;
        setLive({
          ...liveRef.current,
          x: origin.current.x,
          y: top - newH,
          width: newW,
          height: newH,
        });
      } else if (mode === 'rotate') {
        const box = toCss({
          x: origin.current.x,
          y: origin.current.y,
          width: origin.current.width,
          height: origin.current.height,
        });
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        // Approximate: use viewport coords from page wrapper — angle from center
        const angle =
          (Math.atan2(e.clientY - (origin.current as { cy?: number }).cy! , e.clientX - (origin.current as { cx?: number }).cx!) *
            180) /
            Math.PI +
          90;
        void cx;
        void cy;
        setLive({
          ...liveRef.current,
          rotation: ((angle % 360) + 360) % 360,
        });
      }
    },
    [liveRef, scale, sig.locked, toCss],
  );

  const endDrag = useCallback(() => {
    const mode = dragMode.current;
    dragMode.current = null;
    if (!mode || sig.locked) return;

    const cur = liveRef.current;
    if (mode === 'move') {
      const dx = cur.x - origin.current.x;
      const dy = cur.y - origin.current.y;
      if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) {
        onCommitMove(sig.id, dx, dy);
      }
    } else if (mode === 'resize-se') {
      if (
        Math.abs(cur.width - origin.current.width) > 0.25 ||
        Math.abs(cur.height - origin.current.height) > 0.25
      ) {
        onCommitResize(sig.id, cur.width, cur.height);
      }
    } else if (mode === 'rotate') {
      if (Math.abs(cur.rotation - origin.current.rotation) > 0.5) {
        onCommitRotate(sig.id, cur.rotation);
      }
    }
  }, [onCommitMove, onCommitResize, onCommitRotate, liveRef, sig.id, sig.locked]);

  const attachDragListeners = useWindowPointerDrag(onPointerMove, endDrag);

  const begin = useCallback(
    (mode: DragMode, e: React.PointerEvent) => {
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect(sig.id);
      if (sig.locked && mode !== null) return;
      dragMode.current = mode;
      const box = toCss(liveRef.current);
      // Store screen center for rotate (page-relative → use event target parent)
      const parent = (e.currentTarget as HTMLElement).offsetParent as HTMLElement | null;
      const prect = parent?.getBoundingClientRect();
      origin.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        x: liveRef.current.x,
        y: liveRef.current.y,
        width: liveRef.current.width,
        height: liveRef.current.height,
        rotation: liveRef.current.rotation,
        ...( {
          cx: (prect?.left ?? 0) + box.left + box.width / 2,
          cy: (prect?.top ?? 0) + box.top + box.height / 2,
        } as object),
      };
      attachDragListeners();
    },
    [attachDragListeners, liveRef, onSelect, sig.id, sig.locked, toCss],
  );

  const box = toCss(live);

  return (
    <div
      className={`absolute z-40 ${selected ? 'pointer-events-auto' : 'pointer-events-auto'}`}
      style={{
        left: box.left + box.width / 2,
        top: box.top + box.height / 2,
        width: box.width,
        height: box.height,
        transform: `translate(-50%, -50%) rotate(${-live.rotation}deg)`,
        opacity: sig.opacity,
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect(sig.id);
        if (!sig.locked) begin('move', e);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {imageDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageDataUrl}
          alt="Signature"
          draggable={false}
          className="w-full h-full object-contain pointer-events-none select-none"
        />
      ) : (
        <div className="w-full h-full border border-dashed border-muted-foreground/60 bg-muted/40 flex items-center justify-center">
          <PenLine size={16} className="text-muted-foreground" />
        </div>
      )}

      {selected && (
        <>
          <div
            className={`absolute inset-0 border-2 ${sig.locked ? 'border-amber-500' : 'border-primary'} border-dashed pointer-events-none`}
          />
          <div className="absolute -top-8 left-0 flex items-center gap-1 whitespace-nowrap">
            <span className="flex items-center gap-1 px-1.5 py-0.5 bg-primary text-white text-[10px] rounded shadow">
              <PenLine size={10} /> Signature
              {sig.locked && <Lock size={10} />}
            </span>
            <button
              type="button"
              title="Rotate 15°"
              className="p-0.5 bg-muted text-foreground rounded border border-border-strong hover:bg-border shadow"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (!sig.locked) onCommitRotate(sig.id, (sig.rotation + 15) % 360);
              }}
            >
              <RotateCw size={10} />
            </button>
            <button
              type="button"
              title="Delete"
              className="p-0.5 bg-red-600 text-white rounded border border-red-500 hover:bg-red-500 shadow"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(sig.id);
              }}
            >
              <Trash2 size={10} />
            </button>
            <button
              type="button"
              title="Deselect"
              className="p-0.5 bg-muted text-foreground/90 rounded border border-border-strong hover:bg-border shadow"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onDeselect();
              }}
            >
              <X size={10} />
            </button>
          </div>

          {!sig.locked && (
            <>
              <div
                className="absolute w-2.5 h-2.5 bg-primary border border-white rounded-sm cursor-se-resize z-50"
                style={{ right: -5, bottom: -5 }}
                onPointerDown={(e) => begin('resize-se', e)}
              />
              <div
                className="absolute w-2.5 h-2.5 bg-emerald-500 border border-white rounded-full cursor-grab z-50"
                style={{ left: '50%', top: -18, transform: 'translateX(-50%)' }}
                onPointerDown={(e) => begin('rotate', e)}
                title="Drag to rotate"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
