'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  X,
  Image as ImageIcon,
  Camera,
  Pencil,
  AlignLeft,
  Download,
  ChevronRight,
  Check,
  Loader2,
  FileText,
  AlertCircle,
} from 'lucide-react';
import type { PDFDocumentData } from '@/engine';
import {
  checkBloomHealth,
  convertAndDownload,
  BLOOM_JOB_STATE_LABELS,
  type BloomJob,
  type ConvertTarget,
} from '@/lib/bloom-api';
import {
  EXPORT_FORMATS,
  CONVERT_FORMATS,
  CONVERT_GROUP_LABELS,
  exportDocument,
  type ExportFormat,
  type ExportOptions,
  type ConvertFormatGroup,
  type ConvertFormatInfo,
} from '../export-formats';

// ─── Icon mapping ───────────────────────────────────────────────────────────────

const FORMAT_ICONS: Record<ExportFormat, React.ReactNode> = {
  png: <ImageIcon size={22} />,
  jpeg: <Camera size={22} />,
  svg: <Pencil size={22} />,
  txt: <AlignLeft size={22} />,
};

const FORMAT_GRADIENTS: Record<ExportFormat, string> = {
  png: 'from-sky-500/20 to-sky-600/5',
  jpeg: 'from-amber-500/20 to-amber-600/5',
  svg: 'from-cyan-500/20 to-cyan-600/5',
  txt: 'from-stone-400/20 to-stone-500/5',
};

const FORMAT_ACCENT: Record<ExportFormat, string> = {
  png: 'text-sky-600 dark:text-sky-400',
  jpeg: 'text-amber-600 dark:text-amber-400',
  svg: 'text-cyan-600 dark:text-cyan-400',
  txt: 'text-muted-foreground',
};

const FORMAT_RING: Record<ExportFormat, string> = {
  png: 'ring-sky-500/40',
  jpeg: 'ring-amber-500/40',
  svg: 'ring-cyan-500/40',
  txt: 'ring-stone-500/40',
};

type ExportMode = 'render' | 'convert';

// ─── Props ──────────────────────────────────────────────────────────────────────

interface ExportPanelProps {
  isOpen: boolean;
  onClose: () => void;
  doc: PDFDocumentData | null;
  engine: typeof import('@/engine') | null;
  fileName: string;
  totalPages: number;
  currentPage: number;
  /** Current edited PDF bytes (after committing drawings). */
  getPdfBytes?: () => Promise<Uint8Array>;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function ExportPanel({
  isOpen,
  onClose,
  doc,
  engine,
  fileName,
  totalPages,
  currentPage,
  getPdfBytes,
}: ExportPanelProps) {
  const [mode, setMode] = useState<ExportMode>('render');
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('png');
  const [selectedConvert, setSelectedConvert] = useState<ConvertTarget>('docx');
  const [pageRange, setPageRange] = useState<'all' | 'current' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState(1);
  const [customTo, setCustomTo] = useState(totalPages);
  const [dpi, setDpi] = useState(150);
  const [jpegQuality, setJpegQuality] = useState(92);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportTotal, setExportTotal] = useState(0);
  const [jobLabel, setJobLabel] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState(0);
  const [exportDone, setExportDone] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);
  const [enginePhase, setEnginePhase] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const convertInfo =
    CONVERT_FORMATS.find((f) => f.id === selectedConvert) ?? CONVERT_FORMATS[0]!;
  const formatInfo = EXPORT_FORMATS.find((f) => f.id === selectedFormat)!;

  // Reset when the panel opens (or the page count changes while open).
  // Done during render rather than in an effect to avoid a cascading render.
  const openKey = isOpen ? `open|${totalPages}` : 'closed';
  const [lastOpenKey, setLastOpenKey] = useState(openKey);
  if (openKey !== lastOpenKey) {
    setLastOpenKey(openKey);
    if (isOpen) {
      setExportDone(false);
      setExportError(null);
      setExportProgress(0);
      setJobLabel(null);
      setJobProgress(0);
      setCustomTo(totalPages);
      setEngineOnline(null);
    }
  }

  // Health check while the panel is open
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void checkBloomHealth().then((h) => {
      if (cancelled) return;
      setEngineOnline(h.ok);
      setEnginePhase(h.phase ?? null);
    });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [isOpen, totalPages]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const getPageIndices = useCallback((): number[] | null => {
    if (pageRange === 'all') return null;
    if (pageRange === 'current') return [currentPage];
    const from = Math.max(0, customFrom - 1);
    const to = Math.min(totalPages - 1, customTo - 1);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }, [pageRange, currentPage, customFrom, customTo, totalPages]);

  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleRenderExport = useCallback(async () => {
    if (!doc || !engine) return;

    setIsExporting(true);
    setExportDone(false);
    setExportError(null);
    setExportProgress(0);
    setJobLabel(null);

    try {
      const title = fileName.replace(/\.pdf$/i, '') || 'export';
      const options: ExportOptions = {
        format: selectedFormat,
        pages: getPageIndices(),
        dpi,
        quality: jpegQuality / 100,
        title,
      };

      const result = await exportDocument(doc, engine, options, (current, total) => {
        setExportProgress(current);
        setExportTotal(total);
      });

      triggerDownload(result.blob, result.filename);
      setExportDone(true);
    } catch (err) {
      console.error('[Export] Failed:', err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [doc, engine, fileName, selectedFormat, getPageIndices, dpi, jpegQuality, triggerDownload]);

  const handleConvertExport = useCallback(async () => {
    if (!getPdfBytes) {
      setExportError('PDF bytes unavailable — reload the document and try again.');
      return;
    }
    if (engineOnline === false) {
      setExportError('Convert API unavailable — restart the Next.js app (npm run dev).');
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setIsExporting(true);
    setExportDone(false);
    setExportError(null);
    setJobProgress(0);
    setJobLabel('Preparing…');

    try {
      const bytes = await getPdfBytes();
      if (bytes.byteLength < 5) {
        throw new Error('PDF is empty or not ready');
      }
      const name = fileName.endsWith('.pdf') ? fileName : `${fileName || 'document'}.pdf`;
      const onProgress = (job: BloomJob) => {
        setJobLabel(BLOOM_JOB_STATE_LABELS[job.state] ?? job.state);
        setJobProgress(Math.max(0, Math.min(100, job.progress ?? 0)));
      };

      const { blob, filename } = await convertAndDownload(
        bytes,
        name,
        selectedConvert,
        getPageIndices(),
        { onProgress, signal: ac.signal },
      );
      triggerDownload(blob, filename);
      setExportDone(true);
      setJobLabel(BLOOM_JOB_STATE_LABELS.Completed);
      setJobProgress(100);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[Convert] Failed:', err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [
    getPdfBytes,
    engineOnline,
    fileName,
    selectedConvert,
    getPageIndices,
    triggerDownload,
  ]);

  const handleExport = mode === 'render' ? handleRenderExport : handleConvertExport;

  if (!isOpen) return null;

  const progressPct =
    mode === 'convert'
      ? jobProgress
      : exportTotal > 0
        ? Math.round((exportProgress / exportTotal) * 100)
        : 0;

  const groups: ConvertFormatGroup[] = ['office', 'web', 'data'];
  const convertDisabled = engineOnline === false || !getPdfBytes;
  const primaryDisabled =
    mode === 'render' ? !doc || !engine : convertDisabled || isExporting;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-[var(--scrim)] backdrop-blur-sm"
        style={{ animation: 'fadeIn 0.2s ease-out' }}
        onClick={onClose}
      />

      <div
        ref={panelRef}
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-[520px] flex flex-col"
        style={{
          animation: 'slideInRight 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div data-testid="export-panel" role="dialog" aria-label="Export document" className="flex flex-col h-full bg-popover border-l border-border shadow-[0_12px_48px_-8px_rgba(0,0,0,0.25)]">
          <div className="flex items-center justify-between px-6 py-5 border-b border-border">
            <div>
              <h2 className="text-lg font-extrabold text-foreground tracking-tight">Export document</h2>
              <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[360px]">
                {fileName} · {totalPages} page{totalPages !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Close export panel"
            >
              <X size={18} />
            </button>
          </div>

          <div
            className="flex-1 overflow-y-auto px-6 py-5 space-y-6"
            style={{ scrollbarWidth: 'thin' }}
          >
            {/* Mode tabs */}
            <div className="flex gap-1.5 p-1 bg-muted rounded-xl border border-border">
              {(
                [
                  { value: 'render' as const, label: 'Images & text' },
                  { value: 'convert' as const, label: 'Document convert' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    setMode(opt.value);
                    setExportDone(false);
                    setExportError(null);
                  }}
                  className={`
                    flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-all duration-200
                    ${
                      mode === opt.value
                        ? 'bg-card text-foreground shadow-sm font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    }
                  `}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {mode === 'render' ? (
              <div>
                <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-3 block">
                  Render format
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {EXPORT_FORMATS.map((fmt) => (
                    <button
                      key={fmt.id}
                      onClick={() => setSelectedFormat(fmt.id)}
                      className={`
                        group relative flex items-center gap-3 px-4 py-3.5 rounded-xl border text-left
                        transition-all duration-200 ease-out
                        ${
                          selectedFormat === fmt.id
                            ? `bg-gradient-to-br ${FORMAT_GRADIENTS[fmt.id]} border-border ring-2 ${FORMAT_RING[fmt.id]} shadow-sm`
                            : 'bg-card border-border hover:bg-muted/60 hover:border-border-strong'
                        }
                      `}
                    >
                      <div
                        className={`
                        flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center
                        transition-all duration-200
                        ${
                          selectedFormat === fmt.id
                            ? `${FORMAT_ACCENT[fmt.id]} bg-card/70`
                            : 'text-muted-foreground bg-muted group-hover:text-foreground'
                        }
                      `}
                      >
                        {FORMAT_ICONS[fmt.id]}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className={`text-sm font-semibold truncate ${selectedFormat === fmt.id ? 'text-foreground' : 'text-foreground/80'}`}
                        >
                          {fmt.label}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate leading-snug mt-0.5">
                          {fmt.extension}
                        </div>
                      </div>
                      {selectedFormat === fmt.id && (
                        <div
                          className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${FORMAT_ACCENT[fmt.id]} bg-card`}
                        >
                          <Check size={12} strokeWidth={3} />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground leading-relaxed">{formatInfo.description}</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start gap-2">
                  {engineOnline === null ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" />
                      Checking Bloom engine…
                    </p>
                  ) : engineOnline ? (
                    <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                      <Check size={12} />
                      Converts on your device — nothing is uploaded
                    </p>
                  ) : (
                    <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                      <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                      <span>Document conversion needs a browser with Web Worker support.</span>
                    </p>
                  )}
                </div>

                {groups.map((group) => {
                  const items = CONVERT_FORMATS.filter((f) => f.group === group);
                  return (
                    <div key={group}>
                      <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2 block">
                        {CONVERT_GROUP_LABELS[group]}
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {items.map((fmt) => (
                          <ConvertFormatButton
                            key={fmt.id}
                            fmt={fmt}
                            selected={selectedConvert === fmt.id}
                            disabled={engineOnline === false}
                            onSelect={() => setSelectedConvert(fmt.id)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground leading-relaxed">{convertInfo.description}</p>
              </div>
            )}

            {/* Page Range */}
            <div>
              <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-3 block">
                Pages
              </label>
              <div className="flex gap-1.5 p-1 bg-muted rounded-xl border border-border">
                {[
                  { value: 'all' as const, label: 'All Pages' },
                  { value: 'current' as const, label: `Page ${currentPage + 1}` },
                  { value: 'custom' as const, label: 'Range' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setPageRange(opt.value)}
                    className={`
                      flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-all duration-200
                      ${
                        pageRange === opt.value
                          ? 'bg-card text-foreground shadow-sm font-semibold'
                          : 'text-muted-foreground hover:text-foreground'
                      }
                    `}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {pageRange === 'custom' && (
                <div className="flex items-center gap-3 mt-3">
                  <div className="flex-1">
                    <label className="text-[10px] text-muted-foreground mb-1 block">From</label>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      value={customFrom}
                      aria-label="From"
                      onChange={(e) =>
                        setCustomFrom(Math.max(1, Math.min(totalPages, Number(e.target.value))))
                      }
                      className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 outline-none transition-all"
                    />
                  </div>
                  <span className="text-muted-foreground text-xs mt-4">to</span>
                  <div className="flex-1">
                    <label className="text-[10px] text-muted-foreground mb-1 block">To</label>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      value={customTo}
                      aria-label="To"
                      onChange={(e) =>
                        setCustomTo(Math.max(1, Math.min(totalPages, Number(e.target.value))))
                      }
                      className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 outline-none transition-all"
                    />
                  </div>
                </div>
              )}
            </div>

            {mode === 'render' && (formatInfo.supportsDpi || formatInfo.supportsQuality) && (
              <div className="space-y-4">
                <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider block">
                  Quality Settings
                </label>

                {formatInfo.supportsDpi && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground">Resolution (DPI)</span>
                      <span className="text-xs font-mono text-foreground bg-muted px-2 py-0.5 rounded">
                        {dpi}
                      </span>
                    </div>
                    <div className="flex gap-1.5 p-1 bg-muted rounded-xl border border-border">
                      {[
                        { value: 72, label: 'Screen' },
                        { value: 150, label: 'Standard' },
                        { value: 300, label: 'Print' },
                        { value: 600, label: 'High' },
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setDpi(opt.value)}
                          className={`
                            flex-1 px-2 py-2 text-xs font-medium rounded-lg transition-all duration-200
                            ${
                              dpi === opt.value
                                ? 'bg-card text-foreground shadow-sm font-semibold'
                                : 'text-muted-foreground hover:text-foreground'
                            }
                          `}
                        >
                          <div>{opt.label}</div>
                          <div className="text-[9px] opacity-60 mt-0.5">{opt.value} DPI</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {formatInfo.supportsQuality && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground">JPEG Quality</span>
                      <span className="text-xs font-mono text-foreground bg-muted px-2 py-0.5 rounded">
                        {jpegQuality}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={jpegQuality}
                      onChange={(e) => setJpegQuality(Number(e.target.value))}
                      className="w-full accent-primary"
                      style={{ height: '4px' }}
                    />
                    <div className="flex justify-between mt-1">
                      <span className="text-[10px] text-muted-foreground">Smaller file</span>
                      <span className="text-[10px] text-muted-foreground">Best quality</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {exportError && (
              <div role="alert" data-testid="export-error" className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs">
                {exportError}
              </div>
            )}

            {exportDone && (
              <div data-testid="export-done" className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 text-xs flex items-center gap-2">
                <Check size={14} />
                {mode === 'convert' ? 'Conversion complete — file downloaded!' : 'Export complete — file downloaded!'}
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-border bg-muted/40">
            {isExporting ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    {mode === 'convert' ? (jobLabel ?? 'Converting…') : 'Exporting…'}
                  </span>
                  <span className="text-foreground font-mono">
                    {mode === 'convert'
                      ? `${jobProgress}%`
                      : `${exportProgress}/${exportTotal}`}
                  </span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-bloom-300 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            ) : (
              <button
                onClick={() => void handleExport()}
                disabled={primaryDisabled}
                data-testid="export-submit"
                className="w-full h-12 flex items-center justify-center gap-2.5 px-4 rounded-xl font-bold text-[14px] bg-primary text-primary-foreground shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)] hover:brightness-105 active:scale-[0.99] disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed transition-all"
              >
                {mode === 'convert' ? <FileText size={16} /> : <Download size={16} />}
                {mode === 'convert'
                  ? `Convert to ${convertInfo.label}`
                  : `Export as ${formatInfo.label}`}
                <ChevronRight size={14} className="opacity-50" />
              </button>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}

function ConvertFormatButton({
  fmt,
  selected,
  disabled,
  onSelect,
}: {
  fmt: ConvertFormatInfo;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`
        group relative flex items-center gap-2.5 px-3 py-3 rounded-xl border text-left
        transition-all duration-200 ease-out disabled:opacity-40 disabled:cursor-not-allowed
        ${
          selected
            ? 'bg-gradient-to-br from-primary/15 to-bloom-600/5 border-primary/40 ring-2 ring-primary/30 shadow-sm'
            : 'bg-card border-border hover:bg-muted/60 hover:border-border-strong'
        }
      `}
    >
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold truncate ${selected ? 'text-foreground' : 'text-foreground/80'}`}>
          {fmt.label}
        </div>
        <div className="text-[10px] text-muted-foreground truncate mt-0.5">{fmt.extension}</div>
      </div>
      {selected && (
        <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-primary bg-card">
          <Check size={12} strokeWidth={3} />
        </div>
      )}
    </button>
  );
}
