import React from 'react';
import type { EditorTool } from '../types';
import { TOOL_LABELS } from '../types';
import type { TextRun, RenderResult, PDFDocumentData } from '@/engine';

interface StatusBarProps {
  renderResult: RenderResult | null;
  activeTool: EditorTool;
  selectedRun: TextRun | null;
  doc: PDFDocumentData | null;
  totalPages: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function StatusBar({
  renderResult,
  activeTool,
  selectedRun,
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
        {selectedRun && (
          <>
            <span className="w-1 h-1 rounded-full bg-[var(--border-strong)]" />
            <span>SELECTED: <span className="text-app">&quot;{selectedRun.text.substring(0, 30)}{selectedRun.text.length > 30 ? '…' : ''}&quot;</span></span>
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
