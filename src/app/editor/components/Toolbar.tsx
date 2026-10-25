import React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ZoomOut, ZoomIn, X, Undo2, Redo2, Search, FileOutput } from 'lucide-react';
import type { DrawnPath } from '../types';
import type { PDFDocumentData } from '@/engine';
import { DownloadDropdown } from './DownloadDropdown';
import { Logo, LogoMark } from '@/components/art/Logo';
import { ThemeToggle } from '@/components/layout/ThemeToggle';

interface ToolbarProps {
  fileName: string;
  /** True when there are edits that have not been downloaded yet. */
  isDirty?: boolean;
  currentPage: number;
  totalPages: number;
  scale: number;
  drawnPaths: DrawnPath[];
  isSaving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onClose: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearPaths: () => void;
  onDownload: () => void;
  saveMode?: 'quick' | 'optimized';
  onSaveModeChange?: (mode: 'quick' | 'optimized') => void;
  onToggleSearch?: () => void;
  isSearchOpen?: boolean;
  /** Open the export panel */
  onExport?: () => void;
  /** PDF document for size estimation */
  doc?: PDFDocumentData | null;
  /** Compressed download handler */
  onCompressedDownload?: (opts: import('./DownloadDropdown').CompressedDownloadOptions) => void;
}

export function Toolbar({
  fileName,
  isDirty = false,
  currentPage,
  totalPages,
  scale,
  drawnPaths,
  isSaving,
  canUndo,
  canRedo,
  onClose,
  onPrevPage,
  onNextPage,
  onZoomIn,
  onZoomOut,
  onUndo,
  onRedo,
  onClearPaths,
  onDownload,
  saveMode,
  onSaveModeChange,
  onToggleSearch,
  isSearchOpen,
  onExport,
  doc,
  onCompressedDownload,
}: ToolbarProps) {
  /** Ask before leaving the editor while there are edits not yet downloaded. */
  const confirmLeave = () =>
    !isDirty || window.confirm('You have unsaved changes. Leave without downloading them?');

  return (
    <header className="flex items-center justify-between gap-2 px-2 md:px-4 h-12 md:h-[58px] bg-background/85 backdrop-blur-xl border-b border-border shrink-0 z-40">
      {/* ── Left: close + logo + filename ── */}
      <div className="flex items-center gap-1 md:gap-2 min-w-0 shrink">
        <button
          onClick={() => {
            if (confirmLeave()) onClose();
          }}
          className="w-8 h-8 md:w-9 md:h-9 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors shrink-0"
          title="Close file & return home"
          aria-label="Close file & return home"
        >
          <X size={18} />
        </button>
        <Link
          href="/"
          onClick={(e) => {
            if (!confirmLeave()) e.preventDefault();
          }}
          aria-label="BloomPDF Editor home"
          className="hidden sm:flex items-center shrink-0 overflow-visible md:mr-5">
          <LogoMark size={26} className="md:hidden" />
          <span className="hidden md:flex -ml-1">
            <Logo variant="nav" />
          </span>
        </Link>
        <div className="w-px h-5 bg-border hidden lg:block shrink-0" />
        <span className="hidden lg:inline text-foreground/90 font-semibold text-[13px] truncate max-w-[220px]" title={fileName}>{fileName}</span>
        {isDirty && (
          <span
            data-testid="unsaved-badge"
            className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[11px] font-semibold whitespace-nowrap shrink-0"
            title="You have changes that haven't been downloaded yet"
          >
            <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-current" />
            Unsaved
          </span>
        )}
      </div>

      {/* ── Center: undo/redo, page nav, zoom ── */}
      <div className="flex items-center gap-0.5 md:gap-1.5 bg-card px-1 md:px-2 py-1 rounded-xl border border-border shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-x-auto scrollbar-hide min-w-0">
        <button onClick={onUndo} disabled={!canUndo} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors shrink-0" title="Undo (Ctrl+Z)" aria-label="Undo">
          <Undo2 size={16} />
        </button>
        <button onClick={onRedo} disabled={!canRedo} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors shrink-0" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Redo2 size={16} />
        </button>

        <div className="w-px h-4 bg-border mx-0.5 md:mx-1 hidden sm:block shrink-0" />

        <button onClick={onPrevPage} disabled={currentPage === 0} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors shrink-0" title="Previous page" aria-label="Previous page">
          <ChevronLeft size={18} />
        </button>
        <span data-testid="page-indicator" className="text-foreground/80 text-xs font-semibold w-10 sm:w-12 md:w-16 text-center tabular-nums shrink-0">
          {currentPage + 1} / {totalPages}
        </span>
        <button onClick={onNextPage} disabled={currentPage >= totalPages - 1} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors shrink-0" title="Next page" aria-label="Next page">
          <ChevronRight size={18} />
        </button>

        <div className="hidden sm:flex items-center gap-0.5 md:gap-1.5 shrink-0">
          <div className="w-px h-4 bg-border mx-0.5 md:mx-1 shrink-0" />
          <button onClick={onZoomOut} disabled={scale <= 0.5} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors shrink-0" title="Zoom out" aria-label="Zoom out">
            <ZoomOut size={16} />
          </button>
          <span data-testid="zoom-level" className="text-foreground/80 text-xs font-semibold w-10 md:w-12 text-center tabular-nums shrink-0">
            {Math.round(scale * 100)}%
          </span>
          <button onClick={onZoomIn} disabled={scale >= 4} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors shrink-0" title="Zoom in" aria-label="Zoom in">
            <ZoomIn size={16} />
          </button>
        </div>
      </div>

      {/* ── Right: actions ── */}
      <div className="flex items-center gap-1 md:gap-2 shrink-0">
        <ThemeToggle className="hidden sm:flex" />

        {onToggleSearch && (
          <button
            onClick={onToggleSearch}
            className={`w-8 h-8 md:w-9 md:h-9 flex items-center justify-center rounded-lg transition-colors ${isSearchOpen ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
            title="Toggle Find & Replace"
            aria-label="Toggle Find & Replace"
            aria-pressed={!!isSearchOpen}
          >
            <Search size={16} />
          </button>
        )}

        {drawnPaths.length > 0 && (
          <button
            onClick={onClearPaths}
            className="hidden sm:block text-xs font-semibold px-3 py-1.5 text-destructive bg-destructive/10 hover:bg-destructive/15 rounded-lg transition-colors"
          >
            Clear
          </button>
        )}

        {onExport && (
          <>
            <div className="w-[1px] h-6 bg-border hidden md:block" />
            <button
              onClick={onExport}
              className="flex items-center gap-1.5 h-8 md:h-9 px-2.5 md:px-3 text-[13px] font-semibold bg-card text-foreground border border-border hover:border-primary/40 hover:text-primary rounded-xl transition-colors"
              title="Export to Word, PNG, Markdown, etc."
            >
              <FileOutput size={14} />
              <span className="hidden sm:inline">Export</span>
            </button>
          </>
        )}

        <div className="w-[1px] h-6 bg-border hidden sm:block" />

        <DownloadDropdown
          isSaving={isSaving}
          onDownload={onDownload}
          saveMode={saveMode ?? 'optimized'}
          onSaveModeChange={onSaveModeChange ?? (() => {})}
          doc={doc ?? null}
          onCompressedDownload={onCompressedDownload}
        />
      </div>
    </header>
  );
}
