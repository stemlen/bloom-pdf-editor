'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GripHorizontal } from 'lucide-react';
import { useWindowPointerDrag } from '../hooks/usePointerDrag';

/** One styled fragment inside the line editor (mirrors PDF runs). */
export interface OverlaySegmentStyle {
  text: string;
  fontFamily: string;
  /** Optional per-segment size (CSS px). Falls back to box fontSizeCss. */
  fontSizeCss?: number;
  fontWeight: string;
  fontStyle: string;
  underline: boolean;
  color: string;
}

export interface EditableLineBoxProps {
  left: number;
  top: number;
  /** Natural content width at current scale (PDF glyph span in CSS px). */
  naturalWidth: number;
  /** Natural content height at current scale (matches on-canvas font size). */
  naturalHeight: number;
  fontSizeCss: number;
  /** Fallback single-style props when segments are empty. */
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  underline?: boolean;
  color: string;
  /** Per-run styles so mixed bold/underline render like the PDF. */
  segments?: OverlaySegmentStyle[];
  text: string;
  /** Controlled caret / selection (Acrobat/Sejda: click places caret in the string). */
  caretStart: number;
  caretEnd: number;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  onTextInput: (e: React.FormEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelect?: (start: number, end: number) => void;
  onBlur: () => void;
  /** Called when the box is moved (delta in CSS pixels from session start). */
  onOffsetChange: (cssDx: number, cssDy: number) => void;
  /** Called when the user manually resizes (CSS px). */
  onSizeChange: (width: number, height: number) => void;
  /** Current drag offset from original position (CSS px). */
  offsetCssX: number;
  offsetCssY: number;
  /** Manual size override (CSS px); null = auto from content. */
  manualWidth: number | null;
  manualHeight: number | null;
}

type DragMode = 'move' | 'resize-e' | 'resize-s' | 'resize-se' | null;

/**
 * Sejda/Acrobat-style line editor:
 * - Visible text uses real per-run styles
 * - Clicks map to character index via measured glyph spans (not textarea metrics)
 * - Hidden textarea only handles keyboard / IME
 * - Custom caret drawn at the measured X so it matches what you clicked
 */
export function EditableLineBox(props: EditableLineBoxProps) {
  const {
    left, top, naturalWidth, naturalHeight,
    fontSizeCss, fontFamily, fontWeight, fontStyle, underline, color,
    segments, text, caretStart, caretEnd,
    textRef, onTextInput, onKeyDown, onSelect, onBlur,
    onOffsetChange, onSizeChange,
    offsetCssX, offsetCssY, manualWidth, manualHeight,
  } = props;

  const [autoWidth, setAutoWidth] = useState(naturalWidth);
  const [scaleX, setScaleX] = useState(1);
  const [caretPx, setCaretPx] = useState(0);
  const [selLeftPx, setSelLeftPx] = useState(0);
  const [selWidthPx, setSelWidthPx] = useState(0);
  const [caretBlink, setCaretBlink] = useState(true);

  const measureRef = useRef<HTMLSpanElement>(null);
  const visibleRef = useRef<HTMLDivElement>(null);
  const charEndsRef = useRef<number[]>([]);
  const dragMode = useRef<DragMode>(null);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0, w: 0, h: 0 });
  const selectDrag = useRef<{ anchor: number } | null>(null);
  const frozenScaleX = useRef<number | null>(null);
  const sessionKeyRef = useRef(`${left},${top},${naturalWidth},${naturalHeight}`);

  const hasSegments = !!(segments && segments.length > 0);
  const caretColor = hasSegments
    ? (segments.find(s => s.text.length > 0)?.color || color)
    : color;

  const focusInput = useCallback(() => {
    const el = textRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
  }, [textRef]);

  const applyCaret = useCallback((start: number, end: number) => {
    const s = Math.max(0, Math.min(start, text.length));
    const e = Math.max(s, Math.min(end, text.length));
    const el = textRef.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(s, e);
    }
    onSelect?.(s, e);
    setCaretBlink(true);
  }, [text.length, textRef, onSelect]);

  /** Build cumulative unscaled CSS widths for each UTF-16 index. */
  const rebuildCharEnds = useCallback(() => {
    const host = measureRef.current;
    if (!host) {
      charEndsRef.current = [];
      return;
    }
    // Per-index font size for min space advances (large typing-size spaces).
    const fsAt: number[] = new Array(text.length).fill(fontSizeCss);
    if (hasSegments) {
      let pos = 0;
      for (const seg of segments!) {
        const fs = seg.fontSizeCss ?? fontSizeCss;
        for (let k = 0; k < seg.text.length && pos + k < text.length; k++) {
          fsAt[pos + k] = fs;
        }
        pos += seg.text.length;
      }
    }
    const ends: number[] = [];
    const hostLeft = host.getBoundingClientRect().left;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let globalOffset = 0;
    while (node) {
      const value = node.textContent || '';
      for (let i = 0; i < value.length; i++) {
        const gi = globalOffset + i;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        const end = Math.max(0, rect.right - hostLeft);
        ends[gi] = end;
      }
      globalOffset += value.length;
      node = walker.nextNode();
    }
    while (ends.length < text.length) {
      const last = ends.length > 0 ? ends[ends.length - 1] : 0;
      ends.push(last + fontSizeCss * 0.5);
    }
    // Enforce non-decreasing ends after min-space bumps
    for (let i = 1; i < ends.length; i++) {
      if (ends[i] < ends[i - 1]) ends[i] = ends[i - 1];
    }
    charEndsRef.current = ends.slice(0, Math.max(text.length, 0));
  }, [text, fontSizeCss, hasSegments, segments]);

  const xToIndex = useCallback((localX: number) => {
    const ends = charEndsRef.current;
    if (ends.length === 0 || text.length === 0) return 0;
    // Box X is visually scaled; ends are unscaled → convert click into measure space.
    const sx = scaleX !== 1 && scaleX > 0 ? scaleX : 1;
    const unscaledX = localX / sx;
    let prev = 0;
    for (let i = 0; i < ends.length; i++) {
      const mid = (prev + ends[i]) / 2;
      if (unscaledX < mid) return i;
      prev = ends[i];
    }
    return text.length;
  }, [scaleX, text.length]);

  const indexToX = useCallback((index: number) => {
    const ends = charEndsRef.current;
    const i = Math.max(0, Math.min(index, text.length));
    const unscaled = i <= 0 ? 0 : (ends[i - 1] ?? ends[ends.length - 1] ?? 0);
    const sx = scaleX !== 1 && scaleX > 0 ? scaleX : 1;
    return unscaled * sx;
  }, [scaleX, text.length]);

  // Match PDF glyph width like the canvas renderer (ctx.scale(ratio, 1)).
  // Grow the box as the user types / changes font size.
  useLayoutEffect(() => {
    // Freeze horizontal scale once per edit session (position + initial natural width).
    // Font-size changes recalculate content width but keep the same scaleX.
    const sessionKey = `${left},${top},${Math.round(naturalWidth)}`;
    if (sessionKeyRef.current !== sessionKey) {
      sessionKeyRef.current = sessionKey;
      frozenScaleX.current = null;
    }

    const el = measureRef.current;
    if (!el) return;
    rebuildCharEnds();
    const measured = el.offsetWidth;
    if (measured < 0.5) {
      setAutoWidth(Math.max(naturalWidth, fontSizeCss * 0.6, 40));
      return;
    }

    if (frozenScaleX.current == null && naturalWidth > 0.5) {
      const ratio = naturalWidth / measured;
      frozenScaleX.current = Math.max(0.55, Math.min(1.85, ratio));
    }
    // Mixed sizes (large mid-line insert vs original condensed run): keep scaleX=1
    // so oversized glyphs aren't crushed into the old PDF advance and look like
    // they skip through neighbors when typing spaces.
    const mixedSize = !!(
      hasSegments
      && segments!.some(s => (s.fontSizeCss ?? fontSizeCss) > fontSizeCss * 0.95)
      && segments!.some(s => (s.fontSizeCss ?? fontSizeCss) < fontSizeCss * 0.85)
    );
    const sx = mixedSize ? 1 : (frozenScaleX.current ?? 1);
    setScaleX(Math.abs(sx - 1) > 0.005 ? sx : 1);

    const contentCss = measured * sx;
    // Always track typed content; pad so the caret isn't flush against the border.
    const grown = Math.ceil(contentCss + Math.max(6, fontSizeCss * 0.25));
    setAutoWidth(Math.max(grown, naturalWidth, 40));

    // Recompute ends after scale settles
    requestAnimationFrame(() => rebuildCharEnds());
  }, [text, fontSizeCss, fontFamily, fontWeight, fontStyle, segments, hasSegments, naturalWidth, naturalHeight, left, top, rebuildCharEnds]);

  // Sync custom caret / selection highlight to controlled indices
  useLayoutEffect(() => {
    rebuildCharEnds();
    const a = Math.max(0, Math.min(caretStart, text.length));
    const b = Math.max(a, Math.min(caretEnd, text.length));
    // Caret / selection geometry comes from measuring the rendered glyphs
    // (rebuildCharEnds reads the DOM), so it can only be computed after layout.
    // Updating state in a layout effect is the intended pattern for this.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCaretPx(indexToX(b));
    setSelLeftPx(indexToX(Math.min(a, b)));
    setSelWidthPx(Math.abs(indexToX(b) - indexToX(a)));
  }, [caretStart, caretEnd, text, indexToX, rebuildCharEnds, scaleX]);

  // Blink caret
  useEffect(() => {
    const id = setInterval(() => setCaretBlink(v => !v), 530);
    return () => clearInterval(id);
  }, [caretStart, caretEnd, text]);

  // Keep hidden textarea selection in sync (for IME / copy)
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const a = Math.max(0, Math.min(caretStart, text.length));
    const b = Math.max(a, Math.min(caretEnd, text.length));
    if (el.selectionStart !== a || el.selectionEnd !== b) {
      try {
        el.setSelectionRange(a, b);
      } catch {
        /* ignore */
      }
    }
  }, [caretStart, caretEnd, text, textRef]);

  // Manual resize sets a floor; content can still grow past it while typing.
  const width = Math.max(autoWidth, manualWidth ?? naturalWidth);
  const height = Math.max(naturalHeight, manualHeight ?? 0);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const mode = dragMode.current;
    if (!mode) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;

    if (mode === 'move') {
      onOffsetChange(dragStart.current.ox + dx, dragStart.current.oy + dy);
    } else if (mode === 'resize-e') {
      onSizeChange(Math.max(40, dragStart.current.w + dx), height);
    } else if (mode === 'resize-s') {
      onSizeChange(width, Math.max(fontSizeCss, dragStart.current.h + dy));
    } else if (mode === 'resize-se') {
      onSizeChange(
        Math.max(40, dragStart.current.w + dx),
        Math.max(fontSizeCss, dragStart.current.h + dy),
      );
    }
  }, [onOffsetChange, onSizeChange, width, height, fontSizeCss]);

  const endDrag = useCallback(() => {
    dragMode.current = null;
  }, []);

  const attachDragListeners = useWindowPointerDrag(onPointerMove, endDrag);

  const startDrag = useCallback((mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragMode.current = mode;
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      ox: offsetCssX,
      oy: offsetCssY,
      w: width,
      h: height,
    };
    attachDragListeners();
  }, [offsetCssX, offsetCssY, width, height, attachDragListeners]);

  const hitLocalX = (e: React.PointerEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientX - box.left;
  };

  const onHitPointerDown = (e: React.PointerEvent) => {
    if (e.altKey || e.metaKey) {
      startDrag('move', e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    rebuildCharEnds();
    const idx = xToIndex(hitLocalX(e));
    selectDrag.current = { anchor: idx };
    applyCaret(idx, idx);

    const onMove = (ev: PointerEvent) => {
      if (!selectDrag.current) return;
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const localX = ev.clientX - box.left;
      const cur = xToIndex(localX);
      const a = selectDrag.current.anchor;
      applyCaret(Math.min(a, cur), Math.max(a, cur));
    };
    const onUp = () => {
      selectDrag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const stretchStyle: React.CSSProperties = {
    transform: scaleX !== 1 ? `scaleX(${scaleX})` : undefined,
    transformOrigin: 'left center',
    width: scaleX !== 1 && scaleX > 0 ? `${100 / scaleX}%` : '100%',
  };

  const renderSegmentSpans = (forMeasure: boolean) => {
    if (hasSegments) {
      return segments!.map((seg, i) => {
        const segFs = seg.fontSizeCss ?? fontSizeCss;
        return (
          <span
            key={i}
            style={{
              fontFamily: seg.fontFamily,
              fontSize: segFs,
              fontWeight: seg.fontWeight,
              fontStyle: seg.fontStyle,
              color: forMeasure ? 'transparent' : seg.color,
              borderBottom: !forMeasure && seg.underline
                ? `${Math.max(1, Math.round(segFs * 0.06))}px solid ${seg.color}`
                : 'none',
              paddingBottom: !forMeasure && seg.underline ? 1 : 0,
            }}
          >
            {seg.text}
          </span>
        );
      });
    }
    return (
      <span
        style={{
          fontFamily,
          fontWeight,
          fontStyle,
          color: forMeasure ? 'transparent' : color,
          borderBottom: !forMeasure && underline
            ? `${Math.max(1, Math.round(fontSizeCss * 0.06))}px solid ${color}`
            : 'none',
          paddingBottom: !forMeasure && underline ? 1 : 0,
        }}
      >
        {text || ' '}
      </span>
    );
  };

  return (
    <div
      className="absolute z-20"
      style={{
        left: left + offsetCssX,
        top: top + offsetCssY,
        width,
        height,
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Hidden measure row — unscaled fonts matching visible segments */}
      <span
        ref={measureRef}
        aria-hidden
        className="absolute pointer-events-none whitespace-pre"
        style={{
          fontSize: fontSizeCss,
          lineHeight: 1,
          left: 0,
          top: 0,
          opacity: 0,
          zIndex: -1,
        }}
      >
        {renderSegmentSpans(true)}
      </span>

      {/* Selection chrome */}
      <div
        className="absolute inset-0 border border-dashed border-primary rounded-sm pointer-events-none shadow-[0_0_0_1px_rgba(232,96,122,0.3)]"
      />

      {/* Move hit targets (positioned outside text bounds so text click/caret positioning is unimpeded) */}
      <div
        className="absolute -top-2.5 left-0 right-0 h-2.5 cursor-grab active:cursor-grabbing z-30"
        onPointerDown={(e) => startDrag('move', e)}
        title="Drag to move text"
      />
      <div
        className="absolute -bottom-2.5 left-0 right-0 h-2.5 cursor-grab active:cursor-grabbing z-30"
        onPointerDown={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          if (e.clientX > rect.right - 16) return;
          startDrag('move', e);
        }}
        title="Drag to move text"
      />
      <div
        className="absolute top-0 bottom-0 -left-2.5 w-2.5 cursor-grab active:cursor-grabbing z-30"
        onPointerDown={(e) => startDrag('move', e)}
        title="Drag to move text"
      />
      <div
        className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-0.5 bg-primary hover:bg-bloom-600 text-white text-[9px] font-semibold rounded shadow-md cursor-grab active:cursor-grabbing z-40 select-none whitespace-nowrap border border-white/30 transition-colors"
        onPointerDown={(e) => startDrag('move', e)}
        title="Drag to move text"
      >
        <GripHorizontal size={10} className="opacity-90" />
        <span>Drag</span>
      </div>

      {/* Selection highlight */}
      {selWidthPx > 0.5 && (
        <div
          aria-hidden
          className="absolute top-0 bottom-0 pointer-events-none z-[5]"
          style={{
            left: selLeftPx,
            width: selWidthPx,
            background: 'rgba(232, 96, 122, 0.30)',
            borderBottom: '2px solid #E8607A',
          }}
        />
      )}

      {/* Visible mixed-style text — overflow visible so underlines aren't clipped.
          Use pre (not nowrap): nowrap collapses consecutive spaces so caret
          advances through the next word while gaps never appear. */}
      <div
        ref={visibleRef}
        aria-hidden
        className="absolute inset-0 m-0 p-0 whitespace-pre pointer-events-none z-[6]"
        style={{
          fontSize: fontSizeCss,
          lineHeight: `${fontSizeCss}px`,
          overflow: 'visible',
          ...stretchStyle,
        }}
      >
        {renderSegmentSpans(false)}
      </div>

      {/* Custom caret — positioned from measured glyph widths */}
      {caretEnd === caretStart && caretBlink && (
        <div
          aria-hidden
          className="absolute pointer-events-none z-[8]"
          style={{
            left: caretPx,
            top: 1,
            width: 1.5,
            height: Math.max(fontSizeCss - 2, 10),
            background: caretColor,
          }}
        />
      )}

      {/* Hit layer — Sejda/Acrobat click-to-caret */}
      <div
        className="absolute inset-0 z-10 cursor-text"
        onPointerDown={onHitPointerDown}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          rebuildCharEnds();
          const idx = xToIndex(hitLocalX(e as unknown as React.PointerEvent));
          // Select word under caret
          let a = idx;
          let b = idx;
          while (a > 0 && /\S/.test(text[a - 1]!)) a--;
          while (b < text.length && /\S/.test(text[b]!)) b++;
          applyCaret(a, b);
        }}
      />

      {/* Hidden textarea: keyboard + IME only (no mouse hit-testing) */}
      <textarea
        ref={textRef as React.RefObject<HTMLTextAreaElement>}
        value={text}
        onInput={onTextInput}
        onKeyDown={onKeyDown}
        onSelect={(e) => {
          const el = e.currentTarget;
          onSelect?.(el.selectionStart ?? 0, el.selectionEnd ?? 0);
        }}
        onBlur={onBlur}
        rows={1}
        aria-label="Edit line"
        spellCheck={false}
        className="absolute inset-0 m-0 border-none outline-none bg-transparent p-0 overflow-hidden resize-none whitespace-nowrap opacity-0"
        style={{
          fontSize: fontSizeCss,
          lineHeight: `${fontSizeCss}px`,
          fontFamily,
          fontWeight: 'normal',
          fontStyle: 'normal',
          caretColor: 'transparent',
          color: 'transparent',
          pointerEvents: 'none',
          zIndex: 0,
        }}
        onFocus={focusInput}
      />

      {/* Resize handles */}
      <div
        className="absolute top-0 -right-1.5 w-3 h-full cursor-ew-resize z-30"
        onPointerDown={(e) => startDrag('resize-e', e)}
        title="Resize width"
      />
      <div
        className="absolute -bottom-1.5 left-0 h-3 w-full cursor-ns-resize z-30"
        onPointerDown={(e) => startDrag('resize-s', e)}
        title="Resize height"
      />
      <div
        className="absolute -right-1.5 -bottom-1.5 w-3.5 h-3.5 bg-primary border-2 border-white rounded-sm cursor-se-resize z-40 shadow"
        onPointerDown={(e) => startDrag('resize-se', e)}
        title="Resize"
      />
    </div>
  );
}
