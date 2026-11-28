import React from 'react';
import type { EditorTool } from '../types';
import { TOOL_LABELS } from '../types';
import type { RenderResult, PDFDocumentData } from '@/engine';

interface StatusBarProps {
  renderResult: RenderResult | null;
  activeTool: EditorTool;
  /** Full text of the selected line (all of its runs). */
  selectedText: string | null;
  doc: PDFDocumentData | null;
  totalPages: number;
}

/** First `max` user-perceived characters, so a Devanagari syllable is never cut. */
function preview(text: string, max: number): string {
  const chars = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    : Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function StatusBar({
  renderResult,
  activeTool,
  selectedText,
  doc,
  totalPages
}: StatusBarProps) {
  return (
    <footer className="hidden md:flex items-center justify-between px-4 h-7 bg-panel border-t border-app shrink-0 select-none">
      <span className="text-[10px] font-medium tracking-wider text-app-faint">
        {renderResult
          ? `${renderResult.pageWidth.toFixed(0)} × ${renderResult.pageHeight.toFixed(0)} PT`
          : ''}
      </span>
      <span className="text-[10px] font-medium tracking-wider text-app-faint flex items-center gap-2">
        <span>TOOL: <span className="text-app">{TOOL_LABELS[activeTool].toUpperCase()}</span></span>
        {selectedText && (
          <>
            <span className="w-1 h-1 rounded-full bg-[var(--border-strong)]" />
            <span>SELECTED: <span className="text-app">&quot;{preview(selectedText, 30)}&quot;</span></span>
          </>
        )}
      </span>
      <span className="text-[10px] font-medium tracking-wider text-app-faint">
        {[
          renderResult ? plural(renderResult.textLines.length, 'LINE ON THIS PAGE', 'LINES ON THIS PAGE') : null,
          doc ? plural(totalPages, 'PAGE', 'PAGES') : null,
          doc ? `PDF ${doc.version}` : null,
        ].filter(Boolean).join(' • ')}
      </span>
    </footer>
  );
}
