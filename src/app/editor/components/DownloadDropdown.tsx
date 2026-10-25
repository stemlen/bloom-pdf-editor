'use client';

import React, { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  ChevronDown,
  Loader2,
  Gauge,
  Target,
  HardDrive,
  Info,
} from 'lucide-react';
import type { PDFDocumentData } from '@/engine';
import {
  estimateDocumentSize,
  formatFileSize,
  type SizeEstimation,
} from '../export-formats';

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface CompressedDownloadOptions {
  /** JPEG quality 0–1. Used when targetBytes is not set. */
  quality: number;
  /** Target image DPI (downsamples denser images). */
  dpi: number;
  /** Optional max file size in bytes — binary-searches quality to fit. */
  targetBytes?: number;
}

interface DownloadDropdownProps {
  isSaving: boolean;
  onDownload: () => void;
  saveMode: 'quick' | 'optimized';
  onSaveModeChange: (mode: 'quick' | 'optimized') => void;
  doc: PDFDocumentData | null;
  /** Custom download with compression / DPI / target size. */
  onCompressedDownload?: (opts: CompressedDownloadOptions) => void;
}

// ─── DPI Presets ────────────────────────────────────────────────────────────────

const DPI_PRESETS = [
  { value: 72, label: 'Screen', desc: '72 DPI — Smallest file' },
  { value: 150, label: 'Standard', desc: '150 DPI — Good balance' },
  { value: 300, label: 'Print', desc: '300 DPI — Print quality' },
  { value: 600, label: 'Maximum', desc: '600 DPI — Maximum detail' },
];

const COMPRESSION_PRESETS = [
  { value: 20, label: 'Strongest', desc: 'Smallest file (20% image quality)' },
  { value: 50, label: 'Strong', desc: 'Good balance (50% image quality)' },
  { value: 75, label: 'Light', desc: 'Better quality (75% image quality)' },
  { value: 100, label: 'Minimal', desc: 'Highest quality (100% image quality)' },
];

const MOBILE_QUERY = '(max-width: 767px)';

function subscribeMobile(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** True below the md breakpoint, where the menu becomes a bottom sheet. */
function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function DownloadDropdown({
  isSaving,
  onDownload,
  onSaveModeChange,
  doc,
  onCompressedDownload,
  saveMode,
}: DownloadDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedDpi, setSelectedDpi] = useState(150);
  const [compressionQuality, setCompressionQuality] = useState(75);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  const sizeEstimation = useMemo<SizeEstimation | null>(
    () => (isOpen && doc ? estimateDocumentSize(doc) : null),
    [isOpen, doc],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (dropdownRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen]);

  const handleOptionsDownload = useCallback(() => {
    if (!onCompressedDownload) {
      onDownload();
      setIsOpen(false);
      return;
    }
    // Dropdown Download always runs the compressor with current settings
    onCompressedDownload({
      quality: compressionQuality / 100,
      dpi: selectedDpi,
    });
    setIsOpen(false);
  }, [
    onCompressedDownload,
    onDownload,
    compressionQuality,
    selectedDpi,
  ]);

  const currentSize = sizeEstimation?.currentSizeBytes ?? 0;

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="flex items-stretch shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)] rounded-xl">
        <button
          onClick={onDownload}
          disabled={isSaving}
          title="Download original / edited PDF (no recompression)"
          className="flex items-center gap-2 text-xs font-semibold pl-3 md:pl-4 pr-2 md:pr-3 py-2 bg-primary text-primary-foreground hover:brightness-105 disabled:opacity-50 rounded-l-xl transition-all duration-200 ease-out active:scale-[0.98]"
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          <span className="hidden sm:inline">Download</span>
        </button>

        <button
          onClick={() => setIsOpen(!isOpen)}
          disabled={isSaving}
          title="Download options"
          className="flex items-center px-2 py-2 bg-primary text-primary-foreground hover:brightness-105 disabled:opacity-50 rounded-r-xl border-l border-white/25 transition-all duration-200 ease-out active:scale-[0.98]"
        >
          <ChevronDown
            size={14}
            className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {isOpen && (() => {
        // On narrow screens the toolbar clips fixed children (it creates a
        // containing block), so the bottom sheet is rendered into <body>.
        const menu = (
        <div
          ref={menuRef}
          className="fixed inset-x-0 bottom-0 md:absolute md:inset-auto md:right-0 md:top-full md:mt-2 w-full md:w-[380px] bg-popover border border-border md:rounded-2xl rounded-t-2xl shadow-[0_12px_32px_-8px_rgba(0,0,0,0.22)] animate-scale-in md:origin-top-right overflow-hidden z-50 text-app max-h-[80vh] md:max-h-none overflow-y-auto"
          style={{ animation: 'dropdownIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}
        >
          <div className="px-5 pt-4 pb-3 border-b border-app">
            <div className="flex items-center gap-2 mb-1">
              <HardDrive size={13} className="text-app-muted" />
              <span className="text-[11px] font-medium text-app-muted uppercase tracking-wider">Current File</span>
            </div>
            <div className="text-lg font-semibold text-app tracking-tight">
              {currentSize > 0 ? formatFileSize(currentSize) : '—'}
            </div>
            {sizeEstimation && sizeEstimation.imageCount > 0 && (
              <p className="text-[10px] text-app-faint mt-1">
                {sizeEstimation.imageCount} image{sizeEstimation.imageCount > 1 ? 's' : ''} · {sizeEstimation.pageCount} page{sizeEstimation.pageCount > 1 ? 's' : ''}
              </p>
            )}
          </div>

          <div className="px-5 py-3 border-b border-app">
            <div className="flex items-center gap-1.5 mb-2">
              <label className="text-[11px] font-medium text-app-muted uppercase tracking-wider block">
                Save Mode
              </label>
              <div className="group relative flex items-center justify-center">
                <Info size={12} className="text-app-muted hover:text-app cursor-help transition-colors" />
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-56 p-2.5 bg-panel-elevated border border-app rounded-xl shadow-xl text-[10.5px] text-app opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-[60] leading-relaxed">
                  <strong className="text-app font-semibold">Save Mode</strong> determines how changes are saved.
                  <ul className="mt-1.5 space-y-1 list-disc pl-3.5 text-app-muted">
                    <li><strong className="text-app">Optimized:</strong> Rebuilds the file and removes unused data. Slower, but results in a smaller file.</li>
                    <li><strong className="text-app">Quick:</strong> Appends changes to the end. Faster, but file size grows over time.</li>
                  </ul>
                  <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-app" />
                </div>
              </div>
            </div>
            <div className="flex gap-1.5 p-1 bg-panel-elevated rounded-xl border border-app">
              {[
                { value: 'optimized' as const, label: 'Optimized', desc: 'Smaller: drops unused objects and duplicates' },
                { value: 'quick' as const, label: 'Quick', desc: 'Faster: appends your changes to the original' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => onSaveModeChange(opt.value)}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
                    saveMode === opt.value
                      ? 'bg-primary text-white shadow-sm font-semibold'
                      : 'text-app-muted hover:text-app'
                  }`}
                >
                  {opt.label}
                  <span className="block text-[9px] opacity-70 mt-0.5">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="px-5 py-3 border-b border-app">
            <div className="flex items-center gap-2 mb-2">
              <Gauge size={13} className="text-app-muted" />
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] font-medium text-app-muted uppercase tracking-wider">
                  Resolution
                </label>
                <div className="group relative flex items-center justify-center">
                  <Info size={12} className="text-app-muted hover:text-app cursor-help transition-colors" />
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-56 p-2.5 bg-panel-elevated border border-app rounded-xl shadow-xl text-[10.5px] text-app opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-[60] leading-relaxed">
                    <strong className="text-app font-semibold">DPI (Dots Per Inch)</strong> controls image clarity. Higher DPI looks better but makes the file bigger.
                    <ul className="mt-1.5 space-y-1 list-disc pl-3.5 text-app-muted">
                      <li><strong className="text-app">72:</strong> Good for sharing on web/email.</li>
                      <li><strong className="text-app">150:</strong> Good balance for viewing on screens.</li>
                      <li><strong className="text-app">300:</strong> Standard for high-quality printing.</li>
                      <li><strong className="text-app">600:</strong> Maximum detail (very large file).</li>
                    </ul>
                    <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-app" />
                  </div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {DPI_PRESETS.map(preset => (
                <button
                  key={preset.value}
                  onClick={() => setSelectedDpi(preset.value)}
                  className={`px-2 py-2 rounded-lg text-center transition-all duration-200 ${
                    selectedDpi === preset.value
                      ? 'bg-primary/15 text-primary border border-primary/40 ring-1 ring-primary/20 font-semibold'
                      : 'bg-panel-elevated text-app-muted border border-app hover:text-app'
                  }`}
                >
                  <div className="text-xs font-medium">{preset.label}</div>
                  <div className="text-[9px] opacity-60 mt-0.5">{preset.value}</div>
                </button>
              ))}
            </div>
            <p className="text-[9px] text-app-faint mt-2">
              Downsamples embedded images denser than the selected DPI.
            </p>
          </div>

          <div className="px-5 py-3 border-b border-app">
            <div className="flex items-center gap-2 mb-2">
              <Target size={13} className="text-app-muted" />
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] font-medium text-app-muted uppercase tracking-wider">
                  Compression
                </label>
                <div className="group relative flex items-center justify-center">
                  <Info size={12} className="text-app-muted hover:text-app cursor-help transition-colors" />
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-56 p-2.5 bg-panel-elevated border border-app rounded-xl shadow-xl text-[10.5px] text-app opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-[60] leading-relaxed">
                    <strong className="text-app font-semibold">Compression</strong> shrinks the file size.
                    <p className="mt-1.5 text-app-muted">Lower quality makes images smaller but slightly blurrier. We also remove unused fonts to save space.</p>
                    <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-app" />
                  </div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {COMPRESSION_PRESETS.map(preset => (
                <button
                  key={preset.value}
                  onClick={() => setCompressionQuality(preset.value)}
                  className={`px-2 py-2 rounded-lg text-center transition-all duration-200 ${
                    compressionQuality === preset.value
                      ? 'bg-primary/15 text-primary border border-primary/40 ring-1 ring-primary/20 font-semibold'
                      : 'bg-panel-elevated text-app-muted border border-app hover:text-app'
                  }`}
                >
                  <div className="text-xs font-medium">{preset.label}</div>
                  <div className="text-[9px] opacity-60 mt-0.5">{preset.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="px-5 py-3">
            <p className="text-[10px] text-app-faint mb-2 leading-relaxed">
              Use this button to apply compression. The left “Download” saves without recompressing.
            </p>
            <button
              onClick={handleOptionsDownload}
              disabled={isSaving}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground hover:brightness-105 disabled:opacity-50 font-medium text-sm rounded-xl shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)] transition-all duration-200 ease-out active:scale-[0.98]"
            >
              {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {`Download (${compressionQuality}% · ${selectedDpi} DPI)`}
            </button>
          </div>
        </div>
        );
        return isMobile ? createPortal(menu, document.body) : menu;
      })()}

      <style>{`
        @keyframes dropdownIn {
          from { opacity: 0; transform: translateY(-8px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
