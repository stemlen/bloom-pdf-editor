import React, { MutableRefObject, useEffect, useState } from 'react';
import {
  Type, TextCursorInput, Image, PenTool, Highlighter, Eraser, MousePointer2,
  X, Trash2, Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, Minus, Plus, Stamp, Link2,
  PenLine, Star, Copy, Lock, Unlock, RotateCw, KeyRound, ShieldCheck,
  ArrowRight, Square, Circle, PanelLeftClose, RotateCcw, Download, History, ChevronDown, ChevronRight, Archive, Sparkles, ScanText,
} from 'lucide-react';
import type { DrawMode, EditorTool, RemovedImageRecord } from '../types';
import type { TextRun, ImageItem, PathItem, AcroFormWidget, VisualSignature, SignatureLibraryEntry, SignatureField, ManagedIdentity, ValidationReport, LtvStatus, ManagedSignature, RevisionViewEntry, WatermarkPosition } from '@/engine';

interface PropertiesSidebarProps {
  onClose?: () => void;
  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;
  selectedRun: TextRun | null;

  textFontFamily: string;
  setTextFontFamily: (v: string) => void;
  textFontSize: number;
  setTextFontSize: (v: number | ((prev: number) => number)) => void;
  textBold: boolean;
  setTextBold: (v: boolean | ((prev: boolean) => boolean)) => void;
  textItalic: boolean;
  setTextItalic: (v: boolean | ((prev: boolean) => boolean)) => void;
  textUnderline: boolean;
  setTextUnderline: (v: boolean | ((prev: boolean) => boolean)) => void;
  textColor: string;
  setTextColor: (v: string) => void;
  textAlign: 'left' | 'center' | 'right';
  setTextAlign: (v: 'left' | 'center' | 'right') => void;

  replacingImageIdRef: MutableRefObject<string | null>;
  fileInputRef: MutableRefObject<HTMLInputElement | null>;

  drawColor: string;
  setDrawColor: (v: string) => void;
  drawSize: number;
  setDrawSize: (v: number) => void;
  drawMode?: DrawMode;
  setDrawMode?: (v: DrawMode) => void;

  highlightColor: string;
  setHighlightColor: (v: string) => void;
  highlightSize: number;
  setHighlightSize: (v: number) => void;

  eraserSize: number;
  setEraserSize: (v: number) => void;

  /** Add a URI link to the current text selection / line (Acrobat-like). */
  onAddLink?: () => void;
  /** Scan/highlight links on the PDF page (hover popovers live on the canvas). */
  onScanLinks?: () => void;
  linksHighlighted?: boolean;
  pageLinkCount?: number;
  linkCreatePending?: boolean;
  selectedLinkUrl?: string;
  onSelectedLinkUrlChange?: (url: string) => void;
  onSaveSelectedLink?: () => void;
  onRemoveSelectedLink?: () => void;
  hasSelectedLink?: boolean;

  selectedDisplayItem: ImageItem | PathItem | null;
  setSelectedDisplayItem: (item: ImageItem | PathItem | null) => void;
  onDeleteSelectedDisplayItem?: () => void;
  onReplaceSelectedImage?: () => void;
  onCopySelectedImage?: () => void;
  onClearImageReplaceMode?: () => void;
  displayItems: (ImageItem | PathItem)[];
  removedImages?: RemovedImageRecord[];
  onRestoreRemovedImage?: (img: RemovedImageRecord) => void;
  onInsertRemovedImage?: (img: RemovedImageRecord) => void;
  onDeleteRemovedImage?: (id: string) => void;
  onClearRemovedImages?: () => void;

  formFields?: AcroFormWidget[];
  selectedFormField?: AcroFormWidget | null;
  formFieldDraft?: string;
  onFormFieldSelect?: (field: AcroFormWidget) => void;
  onFormFieldChange?: (value: string) => void;
  onFlattenForms?: () => void;
  /** Duplicate the selected/editing text line one row below (table-like). */
  onDuplicateLineBelow?: () => void;
  /** Run OCR on the current page and insert the recognized text. */
  onRecognizeText?: () => void;
  /** Active cell inside an auto-detected PDF table. */
  tableInfo?: { rows: number; cols: number; row: number; col: number } | null;
  onAddTableRow?: () => void;
  onAddTableColumn?: () => void;

  watermarkText?: string;
  setWatermarkText?: (v: string) => void;
  watermarkFontName?: string;
  setWatermarkFontName?: (v: string) => void;
  watermarkOpacity?: number;
  setWatermarkOpacity?: (v: number) => void;
  watermarkRotation?: number;
  setWatermarkRotation?: (v: number) => void;
  watermarkSize?: number;
  setWatermarkSize?: (v: number) => void;
  watermarkPosition?: WatermarkPosition;
  setWatermarkPosition?: (v: WatermarkPosition) => void;
  watermarkMosaic?: boolean;
  setWatermarkMosaic?: (v: boolean) => void;
  watermarkPageFrom?: number;
  setWatermarkPageFrom?: (v: number) => void;
  watermarkPageTo?: number;
  setWatermarkPageTo?: (v: number) => void;
  watermarkLayer?: 'above' | 'below';
  setWatermarkLayer?: (v: 'above' | 'below') => void;
  watermarkColor?: string;
  setWatermarkColor?: (v: string) => void;
  watermarkType?: 'text' | 'image' | 'shape';
  setWatermarkType?: (v: 'text' | 'image' | 'shape') => void;
  watermarkShapeType?: 'rectangle' | 'circle' | 'pill';
  setWatermarkShapeType?: (v: 'rectangle' | 'circle' | 'pill') => void;
  watermarkShapeColor?: string;
  setWatermarkShapeColor?: (v: string) => void;
  watermarkImageFile?: File | null;
  onWatermarkImageUpload?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onWatermarkImageClear?: () => void;
  hasScannedWatermarks?: boolean;
  detectedWatermarksCount?: number;
  onScanWatermarks?: () => void;
  onApplyWatermark?: () => void;
  onRemoveWatermarks?: () => void;
  onCancelScan?: () => void;
  watermarkLivePreview?: boolean;
  setWatermarkLivePreview?: (v: boolean) => void;
  watermarkBlendMode?: string;
  setWatermarkBlendMode?: (v: string) => void;

  // Visual signatures
  signatureLibraryEntries?: SignatureLibraryEntry[];
  activeLibraryId?: string | null;
  setActiveLibraryId?: (id: string | null) => void;
  selectedSignatureId?: string | null;
  selectedSignature?: VisualSignature | null;
  onOpenSignatureCreate?: () => void;
  onSignatureDelete?: (id: string) => void;
  onSignatureOpacity?: (id: string, opacity: number) => void;
  onSignatureLockToggle?: (id: string) => void;
  onSignatureRotate?: (id: string, degrees: number) => void;
  onLibraryRename?: (id: string, name: string) => void;
  onLibraryDelete?: (id: string) => void;
  onLibraryDuplicate?: (id: string) => void;
  onLibraryFavorite?: (id: string) => void;
  pdfSignatureFields?: SignatureField[];
  selectedPdfSigFieldId?: string | null;
  setSelectedPdfSigFieldId?: (id: string | null) => void;
  onPlaceIntoSelectedField?: () => void;
  // Phase 9 — certificates / crypto sign
  certificateIdentities?: ManagedIdentity[];
  selectedCertificateId?: string | null;
  onOpenCertificateImport?: () => void;
  onSelectCertificate?: (id: string | null) => void;
  onCryptographicSign?: () => void;
  cryptoSignBusy?: boolean;
  // Phase 10–14
  enableTimestamp?: boolean;
  setEnableTimestamp?: (v: boolean) => void;
  onValidateSignatures?: () => void;
  validationBusy?: boolean;
  validationReport?: ValidationReport | null;
  onEnableLtv?: () => void;
  ltvStatus?: LtvStatus | null;
  managedSignatures?: ManagedSignature[];
  revisionEntries?: RevisionViewEntry[];
  isMobile?: boolean;
}

export function PropertiesSidebar(props: PropertiesSidebarProps) {
  const {
    onClose,
    activeTool, setActiveTool, selectedRun,
    textFontFamily, setTextFontFamily, textFontSize, setTextFontSize,
    textBold, setTextBold, textItalic, setTextItalic, textUnderline, setTextUnderline, textColor, setTextColor,
    textAlign, setTextAlign,
    replacingImageIdRef, fileInputRef,
    drawColor, setDrawColor, drawSize, setDrawSize,
    drawMode = 'freehand', setDrawMode,
    highlightColor, setHighlightColor, highlightSize, setHighlightSize,
    eraserSize, setEraserSize,
    onAddLink, onScanLinks, linksHighlighted = false, pageLinkCount = 0,
    selectedLinkUrl = '', onSelectedLinkUrlChange, onSaveSelectedLink, onRemoveSelectedLink,
    hasSelectedLink = false, linkCreatePending = false,
    selectedDisplayItem, setSelectedDisplayItem, onDeleteSelectedDisplayItem, onReplaceSelectedImage, onCopySelectedImage, onClearImageReplaceMode, displayItems,
    removedImages = [], onRestoreRemovedImage, onInsertRemovedImage, onDeleteRemovedImage, onClearRemovedImages,
    formFields = [], selectedFormField, formFieldDraft = '',
    onFormFieldSelect, onFormFieldChange, onFlattenForms,
    onDuplicateLineBelow,
  onRecognizeText,
    tableInfo = null,
    onAddTableRow,
    onAddTableColumn,
    watermarkType = 'text', setWatermarkType,
    watermarkShapeType = 'circle', setWatermarkShapeType,
    watermarkShapeColor = '#000000', setWatermarkShapeColor,
    watermarkImageFile = null, onWatermarkImageUpload, onWatermarkImageClear,
    watermarkText = 'Bloom PDF', setWatermarkText,
    watermarkFontName = 'Arial', setWatermarkFontName,
    watermarkOpacity = 25, setWatermarkOpacity,
    watermarkRotation = 45, setWatermarkRotation,
    watermarkSize = 100, setWatermarkSize,
    watermarkPosition = 'center', setWatermarkPosition,
    watermarkMosaic = false, setWatermarkMosaic,
    watermarkPageFrom = 1, setWatermarkPageFrom,
    watermarkPageTo = 1, setWatermarkPageTo,
    watermarkLayer = 'above', setWatermarkLayer,
    watermarkColor = '#000000', setWatermarkColor,
    hasScannedWatermarks, detectedWatermarksCount = 0, onScanWatermarks,
    onApplyWatermark, onRemoveWatermarks, onCancelScan,
    watermarkLivePreview = true, setWatermarkLivePreview,
    watermarkBlendMode = 'Normal', setWatermarkBlendMode,
    signatureLibraryEntries = [],
    activeLibraryId = null, setActiveLibraryId,
    selectedSignatureId = null, selectedSignature = null,
    onOpenSignatureCreate,
    onSignatureDelete, onSignatureOpacity, onSignatureLockToggle, onSignatureRotate,
    onLibraryRename, onLibraryDelete, onLibraryDuplicate, onLibraryFavorite,
    pdfSignatureFields = [],
    selectedPdfSigFieldId = null, setSelectedPdfSigFieldId,
    onPlaceIntoSelectedField,
    certificateIdentities = [],
    selectedCertificateId = null,
    onOpenCertificateImport,
    onSelectCertificate,
    onCryptographicSign,
    cryptoSignBusy = false,
    enableTimestamp = false,
    setEnableTimestamp,
    onValidateSignatures,
    validationBusy = false,
    validationReport = null,
    onEnableLtv,
    ltvStatus = null,
    managedSignatures = [],
    revisionEntries = [],
  } = props;

  // Hooks first: the early return below must not change the hook order.
  const [previewImage, setPreviewImage] = useState<RemovedImageRecord | null>(null);
  const [isRemovedImagesOpen, setIsRemovedImagesOpen] = useState(true);

  // Clock for relative timestamps ("5m ago"); ticks once a minute so the
  // render itself stays pure.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (!['text', 'addtext', 'draw', 'highlight', 'erase', 'select', 'watermark', 'sign'].includes(activeTool)) return null;

  const FONT_FAMILIES = [
    'Helvetica',
    'Arial',
    'Arial Black',
    'Times-Roman',
    'Times New Roman',
    'Georgia',
    'Courier',
    'Courier New',
    'Verdana',
    'Trebuchet MS',
    'Palatino',
    'Garamond',
    'Comic Sans MS',
    'Impact',
    'Lucida Console',
    'Lucida Sans Unicode',
    'Tahoma',
    'Calibri',
    'Cambria',
    'Candara',
    'Consolas',
    'Franklin Gothic Medium',
    'Gill Sans',
    'Optima',
    'Segoe UI',
    'Roboto',
    'Open Sans',
    'Lato',
    'Montserrat',
    'Inter',
  ];

  const isMobile = props.isMobile ?? false;

  const formatRelativeTime = (timestamp: number): string => {
    const diff = Math.max(0, now - timestamp);
    if (diff < 60_000) return 'Just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const handleDownloadImage = (img: RemovedImageRecord) => {
    const a = document.createElement('a');
    a.href = img.dataUrl;
    a.download = `${(img.fileName || 'document').replace(/\.pdf$/i, '')}-page-${img.originalPage + 1}-img.jpg`;
    a.click();
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isMobile && (
        <div
          className="fixed inset-0 z-40 mobile-backdrop"
          onClick={onClose}
        />
      )}
      <div
        className={isMobile
          ? 'fixed bottom-0 left-0 right-0 z-50 bg-card rounded-t-2xl border-t border-border flex flex-col overflow-y-auto mobile-sheet-up shadow-[0_-8px_40px_rgba(0,0,0,0.15)]'
          : 'w-64 bg-card border-r border-border flex flex-col shrink-0 z-10 overflow-y-auto min-h-0 h-full'
        }
        style={isMobile ? { maxHeight: '65vh' } : undefined}
        data-keep-text-edit
        data-testid="options-panel"
      >
        {/* Mobile drag handle */}
        {isMobile && <div className="sheet-handle" />}
        {/* Top Bar with Hide Panel Button */}
        {onClose && (
          <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border text-xs text-muted-foreground">
            <span className="font-hand text-[19px] leading-none text-primary normal-case">options</span>
          <button
            onClick={onClose}
            title="Hide panel"
            className="p-1 rounded-lg text-app-muted hover:text-app hover:bg-panel-elevated transition-colors"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      )}
      {/* TEXT TOOL PROPERTIES */}
      {(activeTool === 'text' || activeTool === 'addtext') && (
        <div className="p-4 space-y-4 animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
            <Type size={14} />
            Text Properties
          </div>

          {/* Selected run info */}
          {selectedRun && (
            <div className="bg-panel-elevated rounded-lg p-2.5 text-[11px] text-app-muted border border-app">
              <span className="text-app font-medium">Editing:</span>{' '}
              &quot;{selectedRun.text.substring(0, 40)}{selectedRun.text.length > 40 ? '…' : ''}&quot;
            </div>
          )}

          {/* Font Family */}
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Font</label>
            {(() => {
              const isResourceId = !textFontFamily || /^F\d+$/i.test(textFontFamily);
              const fontValue = isResourceId
                ? 'Helvetica'
                : textFontFamily;
              const showCurrent = !isResourceId && !FONT_FAMILIES.includes(fontValue);
              return (
                <select
                  value={fontValue}
                  onChange={(e) => setTextFontFamily(e.target.value)}
                  onFocus={(e) => e.stopPropagation()}
                  className="w-full bg-panel-elevated border border-app rounded-lg px-3 py-2 text-xs text-app outline-none focus:border-primary transition-colors cursor-pointer"
                >
                  {showCurrent && (
                    <option value={fontValue}>{fontValue}</option>
                  )}
                  {FONT_FAMILIES.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              );
            })()}
          </div>

          {/* Font Size */}
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Size</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTextFontSize(s => Math.max(4, s - 1))}
                onMouseDown={(e) => e.preventDefault()}
                className="p-1.5 bg-panel-elevated hover:bg-panel-elevated/80 rounded-md text-app-muted transition-colors border border-app"
              >
                <Minus size={12} />
              </button>
              <input
                type="number"
                value={textFontSize}
                onChange={(e) => setTextFontSize(Math.max(4, Math.min(200, parseInt(e.target.value) || 12)))}
                onMouseDown={(e) => e.preventDefault()}
                className="w-16 bg-panel-elevated border border-app rounded-lg px-2 py-1.5 text-xs text-app text-center outline-none focus:border-primary"
              />
              <button
                onClick={() => setTextFontSize(s => Math.min(200, s + 1))}
                onMouseDown={(e) => e.preventDefault()}
                className="p-1.5 bg-panel-elevated hover:bg-panel-elevated/80 rounded-md text-app-muted transition-colors border border-app"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {[8, 10, 12, 14, 16, 18, 24, 36, 48, 72].map(s => (
                <button
                  key={s}
                  onClick={() => setTextFontSize(s)}
                  onMouseDown={(e) => e.preventDefault()}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${textFontSize === s ? 'bg-primary text-white shadow-sm' : 'bg-panel-elevated text-app-muted hover:text-app hover:bg-panel-elevated/80 border border-app'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Style */}
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Style</label>
            <div className="flex gap-2">
              <button
                onClick={() => setTextBold(b => !b)}
                onMouseDown={(e) => e.preventDefault()}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${textBold ? 'bg-primary/20 text-primary border border-primary/50' : 'bg-panel-elevated text-app-muted border border-app hover:text-app hover:bg-panel-elevated/80'}`}
                title="Bold"
              >
                <Bold size={16} />
              </button>
              <button
                onClick={() => setTextItalic(i => !i)}
                onMouseDown={(e) => e.preventDefault()}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${textItalic ? 'bg-primary/20 text-primary border border-primary/50' : 'bg-panel-elevated text-app-muted border border-app hover:text-app hover:bg-panel-elevated/80'}`}
                title="Italic"
              >
                <Italic size={16} />
              </button>
              <button
                onClick={() => setTextUnderline(u => !u)}
                onMouseDown={(e) => e.preventDefault()}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${textUnderline ? 'bg-primary/20 text-primary border border-primary/50' : 'bg-panel-elevated text-app-muted border border-app hover:text-app hover:bg-panel-elevated/80'}`}
                title="Underline"
              >
                <Underline size={16} />
              </button>
            </div>
          </div>

          {/* Color */}
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={textColor}
                onChange={(e) => setTextColor(e.target.value)}
                className="w-8 h-8 rounded-lg border border-app cursor-pointer bg-transparent"
              />
              <input
                type="text"
                value={textColor.toUpperCase()}
                onChange={(e) => {
                  let val = e.target.value;
                  if (!val.startsWith('#')) val = '#' + val;
                  setTextColor(val);
                }}
                className="w-16 bg-transparent border-b border-app text-[11px] text-app font-mono focus:outline-none focus:border-primary uppercase pb-0.5"
                maxLength={7}
              />
            </div>
            <div className="flex gap-1.5 mt-1">
              {['#000000', '#ffffff', '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#6b7280'].map(c => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Text colour ${c}`}
                  aria-pressed={textColor.toLowerCase() === c}
                  onClick={() => setTextColor(c)}
                  onMouseDown={(e) => e.preventDefault()}
                  className={`w-5 h-5 rounded-full border-2 transition-transform ${textColor.toLowerCase() === c ? 'scale-125 border-bloom-300' : 'border-app hover:scale-110'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {/* Alignment */}
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Alignment</label>
            <div className="flex gap-1 bg-panel-elevated p-1 rounded-lg border border-app">
              {([
                { val: 'left' as const, icon: <AlignLeft size={14} /> },
                { val: 'center' as const, icon: <AlignCenter size={14} /> },
                { val: 'right' as const, icon: <AlignRight size={14} /> },
              ]).map(a => (
                <button
                  key={a.val}
                  type="button"
                  aria-label={`Align ${a.val}`}
                  aria-pressed={textAlign === a.val}
                  onClick={() => setTextAlign(a.val)}
                  onMouseDown={(e) => e.preventDefault()}
                  className={`flex-1 py-1.5 rounded-md flex items-center justify-center transition-all ${textAlign === a.val ? 'bg-primary text-white shadow-sm' : 'text-app-muted hover:text-app'}`}
                >
                  {a.icon}
                </button>
              ))}
            </div>
          </div>

          {/* Links — scan highlights on the PDF; edit/open via page hover popover */}
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">
              Links {pageLinkCount > 0 ? `(${pageLinkCount})` : ''}
            </label>

            {onScanLinks && (
              <button
                type="button"
                onClick={onScanLinks}
                onMouseDown={(e) => e.preventDefault()}
                className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-colors border ${
                  linksHighlighted
                    ? 'bg-primary/25 text-primary border-primary/40'
                    : 'bg-panel-elevated text-app border-app hover:bg-panel-elevated/80'
                }`}
              >
                <Link2 size={14} />
                {linksHighlighted ? 'Links highlighted' : 'Scan for links'}
              </button>
            )}

            {linkCreatePending ? (
              <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
                <p className="text-[10px] text-primary font-medium">New link URL</p>
                <input
                  type="url"
                  value={selectedLinkUrl}
                  onChange={(e) => onSelectedLinkUrlChange?.(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full bg-panel-elevated border border-app rounded-lg px-3 py-2 text-xs text-app outline-none focus:border-primary"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onSaveSelectedLink}
                    onMouseDown={(e) => e.preventDefault()}
                    className="flex-1 py-1.5 rounded-lg bg-primary text-white text-[11px] font-semibold hover:bg-bloom-600"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={onRemoveSelectedLink}
                    onMouseDown={(e) => e.preventDefault()}
                    className="flex-1 py-1.5 rounded-lg bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30 text-[11px] font-semibold hover:bg-red-500/25"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                {onAddLink && (
                  <button
                    type="button"
                    onClick={onAddLink}
                    onMouseDown={(e) => e.preventDefault()}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-primary/15 text-primary border border-primary/30 hover:bg-bloom-600/25 text-xs font-semibold transition-colors"
                  >
                    <Link2 size={14} />
                    Add link to selection
                  </button>
                )}
                <p className="text-[10px] text-app-faint leading-relaxed">
                  {linksHighlighted
                    ? 'Hover a highlighted link on the page to edit or open it.'
                    : 'Click Scan for links to highlight them on the PDF. Select text to add a new one.'}
                </p>
              </>
            )}
          </div>

          {/* Add Content */}
          <div className="pt-4 mt-4 border-t border-app space-y-2">
            <div className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase mb-2">
              Add Content
            </div>
            <button
              onClick={() => setActiveTool('addtext')}
              className={`w-full flex items-center justify-center gap-2 py-2 rounded-md transition-colors text-xs font-semibold ${activeTool === 'addtext' ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-panel-elevated text-app hover:bg-panel-elevated/80'}`}
            >
              <TextCursorInput size={14} />
              Add Text Box
            </button>
            {onRecognizeText && (
              <button
                type="button"
                onClick={onRecognizeText}
                className="w-full flex items-center justify-center gap-2 py-2 bg-panel-elevated hover:bg-panel-elevated/80 text-app rounded-md transition-colors text-xs font-semibold border border-app"
                title="Recognize text on this page with OCR, for scanned pages"
              >
                <ScanText size={14} />
                Recognize Text (OCR)
              </button>
            )}
            {onDuplicateLineBelow && selectedRun && (
              <button
                onClick={onDuplicateLineBelow}
                className="w-full flex items-center justify-center gap-2 py-2 bg-panel-elevated hover:bg-panel-elevated/80 text-app rounded-md transition-colors text-xs font-semibold border border-app"
                title="Copy this line one row below (table / form rows)"
              >
                <Plus size={14} />
                Duplicate Line Below
              </button>
            )}
            {tableInfo && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5 space-y-2">
                <div className="text-[10px] font-bold tracking-widest text-emerald-600 dark:text-emerald-400 uppercase">
                  Table {tableInfo.rows}×{tableInfo.cols}
                </div>
                <p className="text-[10px] text-app-faint leading-relaxed">
                  Cell r{tableInfo.row + 1}, c{tableInfo.col + 1}. Green boxes mark detected cells — click one cell to edit it.
                </p>
                {onAddTableRow && (
                  <button
                    type="button"
                    onClick={onAddTableRow}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-emerald-600/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600/25 text-xs font-semibold"
                  >
                    <Plus size={14} />
                    Add Row Below
                  </button>
                )}
                {onAddTableColumn && (
                  <button
                    type="button"
                    onClick={onAddTableColumn}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-emerald-600/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600/25 text-xs font-semibold"
                  >
                    <Plus size={14} />
                    Add Column Right
                  </button>
                )}
              </div>
            )}
            <button
              onClick={() => {
                replacingImageIdRef.current = null;
                onClearImageReplaceMode?.();
                if (fileInputRef.current) {
                  fileInputRef.current.click();
                }
              }}
              className="w-full flex items-center justify-center gap-2 py-2 bg-panel-elevated hover:bg-panel-elevated/80 text-app rounded-md transition-colors text-xs font-semibold border border-app"
            >
              <Image size={14} />
              Add Image
            </button>
          </div>
        </div>
      )}

      {/* DRAW TOOL PROPERTIES */}
      {activeTool === 'draw' && (
        <div className="p-4 space-y-4 animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
            <PenTool size={14} />
            Draw Properties
          </div>
          {setDrawMode && (
            <div className="space-y-1.5">
              <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Shape</label>
              <div className="grid grid-cols-5 gap-1.5">
                {([
                  { id: 'freehand' as DrawMode, icon: PenTool, title: 'Freehand' },
                  { id: 'line' as DrawMode, icon: Minus, title: 'Line' },
                  { id: 'arrow' as DrawMode, icon: ArrowRight, title: 'Arrow' },
                  { id: 'rectangle' as DrawMode, icon: Square, title: 'Rectangle' },
                  { id: 'ellipse' as DrawMode, icon: Circle, title: 'Ellipse' },
                ]).map(({ id, icon: Icon, title }) => (
                  <button
                    key={id}
                    type="button"
                    title={title}
                    onClick={() => setDrawMode(id)}
                    className={`flex items-center justify-center h-9 rounded-lg border transition-colors ${
                      drawMode === id
                        ? 'bg-primary/20 text-primary border-primary/50'
                        : 'bg-panel-elevated text-app-muted border-app hover:text-app hover:bg-panel-elevated/80'
                    }`}
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={drawColor}
                onChange={(e) => setDrawColor(e.target.value)}
                className="w-8 h-8 rounded-lg border border-app cursor-pointer bg-transparent"
              />
              <input
                type="text"
                value={drawColor.toUpperCase()}
                onChange={(e) => {
                  let val = e.target.value;
                  if (!val.startsWith('#')) val = '#' + val;
                  setDrawColor(val);
                }}
                className="w-16 bg-transparent border-b border-app text-[11px] text-app font-mono focus:outline-none focus:border-primary uppercase pb-0.5"
                maxLength={7}
              />
            </div>
            <div className="grid grid-cols-4 gap-2 p-2 bg-panel-elevated rounded-lg border border-app">
              {['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f4f4f5'].map(color => (
                <button
                  key={color}
                  onClick={() => setDrawColor(color)}
                  className={`w-6 h-6 rounded-full mx-auto transition-transform ${drawColor.toLowerCase() === color.toLowerCase() ? 'scale-125 ring-2 ring-bloom-500 ring-offset-2 ring-offset-panel' : 'hover:scale-110'}`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Brush Size</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="1" max="20"
                value={drawSize}
                onChange={(e) => setDrawSize(parseInt(e.target.value))}
                className="flex-1 accent-primary"
              />
              <span className="text-[11px] text-app-muted w-8 text-right font-mono">{drawSize}px</span>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] text-app-faint">Preview:</span>
            <div
              className="rounded-full"
              style={{ width: drawSize + 4, height: drawSize + 4, backgroundColor: drawColor }}
            />
          </div>
        </div>
      )}

      {/* HIGHLIGHT TOOL PROPERTIES */}
      {activeTool === 'highlight' && (
        <div className="p-4 space-y-4 animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
            <Highlighter size={14} />
            Highlight Properties
          </div>
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={highlightColor}
                onChange={(e) => setHighlightColor(e.target.value)}
                className="w-8 h-8 rounded-lg border border-app cursor-pointer bg-transparent"
              />
              <input
                type="text"
                value={highlightColor.toUpperCase()}
                onChange={(e) => {
                  let val = e.target.value;
                  if (!val.startsWith('#')) val = '#' + val;
                  setHighlightColor(val);
                }}
                className="w-16 bg-transparent border-b border-app text-[11px] text-app font-mono focus:outline-none focus:border-primary uppercase pb-0.5"
                maxLength={7}
              />
            </div>
            <div className="grid grid-cols-4 gap-2 p-2 bg-panel-elevated rounded-lg border border-app">
              {['#fffb00', '#00ff00', '#00e5ff', '#ff00ff', '#ff8c00', '#ff6b6b', '#a78bfa', '#67e8f9'].map(color => (
                <button
                  key={color}
                  onClick={() => setHighlightColor(color)}
                  className={`w-6 h-6 rounded-full mx-auto transition-transform ${highlightColor.toLowerCase() === color.toLowerCase() ? 'scale-125 ring-2 ring-amber-400 ring-offset-2 ring-offset-panel' : 'hover:scale-110'}`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Thickness</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="5" max="40"
                value={highlightSize}
                onChange={(e) => setHighlightSize(parseInt(e.target.value))}
                className="flex-1 accent-yellow-400"
              />
              <span className="text-[11px] text-app-muted w-8 text-right font-mono">{highlightSize}px</span>
            </div>
          </div>
          <p className="text-[10px] text-app-faint leading-relaxed">
            Click a line to highlight it. Drag to freehand highlight.
          </p>
        </div>
      )}

      {/* ERASER PROPERTIES */}
      {activeTool === 'erase' && (
        <div className="p-4 space-y-4 animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
            <Eraser size={14} />
            Eraser Properties
          </div>
          <div className="space-y-1.5">
            <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Eraser Size</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="5" max="50"
                value={eraserSize}
                onChange={(e) => setEraserSize(parseInt(e.target.value))}
                className="flex-1 accent-rose-400"
              />
              <span className="text-[11px] text-app-muted w-8 text-right font-mono">{eraserSize}px</span>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] text-app-faint">Preview:</span>
            <div
              className="rounded-full border-2 border-app-strong"
              style={{ width: eraserSize, height: eraserSize, backgroundColor: 'rgba(232,96,122,0.15)' }}
            />
          </div>
        </div>
      )}

      {/* SELECT TOOL — SELECTED IMAGE/SIGNATURE INFO */}
      {activeTool === 'select' && selectedDisplayItem && (
        <div className="p-4 space-y-4 animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
            {selectedDisplayItem.type === 'image' ? <Image size={14} /> : <PenTool size={14} />}
            {selectedDisplayItem.type === 'image' ? 'Image Properties' : 'Drawing / Signature'}
          </div>
          <div className="space-y-2 text-[11px]">
            <div className="flex justify-between bg-panel-elevated rounded-md px-3 py-2 border border-app">
              <span className="text-app-faint">Type</span>
              <span className="text-app font-medium capitalize">{selectedDisplayItem.type}</span>
            </div>
            <div className="flex justify-between bg-panel-elevated rounded-md px-3 py-2 border border-app">
              <span className="text-app-faint">Position</span>
              <span className="text-app font-mono">{Math.round(selectedDisplayItem.x)}, {Math.round(selectedDisplayItem.y)}</span>
            </div>
            <div className="flex justify-between bg-panel-elevated rounded-md px-3 py-2 border border-app">
              <span className="text-app-faint">Size</span>
              <span className="text-app font-mono">{Math.round(selectedDisplayItem.width)} × {Math.round(selectedDisplayItem.height)} pt</span>
            </div>
          </div>
          <div className="space-y-2 pt-2">
            {selectedDisplayItem.type === 'image' && (
              <>
                <button
                  onClick={() => onReplaceSelectedImage?.()}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary border border-primary/30 hover:bg-bloom-600/20 transition-colors"
                >
                  <Image size={12} /> Replace Image
                </button>
                {onCopySelectedImage && (
                  <button
                    onClick={() => onCopySelectedImage()}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium bg-muted text-foreground border border-border hover:bg-border transition-colors"
                  >
                    <Copy size={12} /> Copy Image
                  </button>
                )}
              </>
            )}
            <button
              onClick={() => setSelectedDisplayItem(null)}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium bg-panel-elevated text-app border border-app hover:bg-panel-elevated/80 transition-colors"
            >
              <X size={12} /> Deselect
            </button>
            <button
              onClick={() => onDeleteSelectedDisplayItem?.()}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={12} /> Delete (Save to Bin)
            </button>
          </div>

          {/* Collapsible Removed Images Drawer */}
          {removedImages.length > 0 && (
            <div className="pt-3 border-t border-app">
              <button
                type="button"
                onClick={() => setIsRemovedImagesOpen(!isRemovedImagesOpen)}
                className="w-full flex items-center justify-between text-[11px] font-bold tracking-wider text-foreground uppercase hover:text-app transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <History size={13} className="text-[#38BDF8]" />
                  <span>Removed Images ({removedImages.length})</span>
                </div>
                {isRemovedImagesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>

              {isRemovedImagesOpen && (
                <div className="mt-3 space-y-2 max-h-56 overflow-y-auto pr-0.5">
                  {removedImages.map((img) => (
                    <div
                      key={img.id}
                      className="bg-panel-elevated/80 border border-app rounded-lg p-2 flex items-center justify-between gap-2 hover:border-app-strong transition-all"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <img
                          src={img.dataUrl}
                          alt="Thumbnail"
                          className="w-8 h-8 object-contain rounded bg-black/40 border border-app shrink-0 cursor-pointer"
                          onClick={() => setPreviewImage(img)}
                        />
                        <div className="min-w-0">
                          <div className="text-[10px] font-medium text-app truncate">Page {img.originalPage + 1}</div>
                          <div className="text-[9px] text-app-faint">{Math.round(img.originalBounds.width)}×{Math.round(img.originalBounds.height)} pt</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => onRestoreRemovedImage?.(img)}
                          className="p-1 rounded bg-[#38BDF8]/15 text-[#38BDF8] hover:bg-[#38BDF8]/30 transition-colors"
                          title={`Restore to Page ${img.originalPage + 1}`}
                        >
                          <RotateCcw size={11} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDownloadImage(img)}
                          className="p-1 rounded bg-panel-elevated text-app-muted hover:text-app transition-colors"
                          title="Download"
                        >
                          <Download size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* SELECT TOOL — NO SELECTION */}
      {activeTool === 'select' && !selectedDisplayItem && (
        <div className="p-4 space-y-4 animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
            <MousePointer2 size={14} />
            Select Tool
          </div>
          <p className="text-[11px] text-app-faint leading-relaxed">
            Click on images or drawings to select them. Double-click text to edit.
          </p>
          {displayItems.length > 0 && (
            <div className="bg-panel-elevated rounded-lg p-2.5 border border-app">
              <span className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Detected</span>
              <div className="flex gap-3 mt-2">
                <span className="text-[11px] text-primary">
                  {displayItems.filter(d => d.type === 'image').length} images
                </span>
                <span className="text-[11px] text-emerald-500">
                  {displayItems.filter(d => d.type === 'path').length} drawings
                </span>
              </div>
            </div>
          )}

          {/* REMOVED IMAGES SECTION */}
          <div className="pt-2 border-t border-app space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-foreground uppercase">
                <History size={14} className="text-[#38BDF8]" />
                <span>Removed Images</span>
                {removedImages.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-[#38BDF8]/20 text-[#38BDF8] text-[9px] font-bold">
                    {removedImages.length}
                  </span>
                )}
              </div>
              {removedImages.length > 0 && onClearRemovedImages && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm('Clear all removed images history?')) {
                      onClearRemovedImages();
                    }
                  }}
                  className="text-[10px] font-medium text-app-faint hover:text-red-400 transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>

            {removedImages.length === 0 ? (
              <div className="rounded-xl bg-panel-elevated/50 border border-dashed border-app/80 p-3.5 text-center space-y-1.5">
                <div className="w-8 h-8 rounded-full bg-panel-elevated mx-auto flex items-center justify-center text-app-faint">
                  <Archive size={16} />
                </div>
                <div className="text-[11px] font-medium text-app-muted">No removed images</div>
                <div className="text-[10px] text-app-faint leading-relaxed">
                  When you delete images from the PDF, they will be kept here so you can restore them anytime, even after refreshing the page.
                </div>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-0.5">
                {removedImages.map((img) => (
                  <div
                    key={img.id}
                    className="bg-panel-elevated/90 border border-app hover:border-app-strong rounded-xl p-2.5 space-y-2 transition-all shadow-xs"
                  >
                    <div className="flex gap-2.5 items-start">
                      <div
                        className="w-13 h-13 rounded-lg bg-black/40 border border-app overflow-hidden shrink-0 flex items-center justify-center cursor-pointer group relative"
                        onClick={() => setPreviewImage(img)}
                        title="Click to zoom preview"
                      >
                        <img src={img.dataUrl} alt="Removed thumbnail" className="w-full h-full object-contain" />
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white text-[9px] font-medium">
                          Zoom
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-semibold text-app truncate">
                            Page {img.originalPage + 1}
                          </span>
                          <span className="text-[9px] text-app-faint shrink-0">
                            {formatRelativeTime(img.deletedAt)}
                          </span>
                        </div>
                        <div className="text-[10px] text-app-faint mt-0.5">
                          {Math.round(img.originalBounds.width)} × {Math.round(img.originalBounds.height)} pt
                        </div>
                        <div className="text-[9px] text-[#38BDF8] font-medium mt-0.5">
                          {img.sourceType === 'embedded' ? 'PDF Embedded' : 'Overlay Image'}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-app/60">
                      <button
                        type="button"
                        onClick={() => onRestoreRemovedImage?.(img)}
                        className="flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[10px] font-semibold bg-[#38BDF8]/15 text-[#38BDF8] hover:bg-[#38BDF8]/25 border border-[#38BDF8]/30 transition-colors shadow-xs"
                        title={`Restore to Page ${img.originalPage + 1} at original position`}
                      >
                        <RotateCcw size={11} /> Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => onInsertRemovedImage?.(img)}
                        className="flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[10px] font-medium bg-panel-elevated hover:bg-panel-elevated/80 text-app border border-app transition-colors shadow-xs"
                        title="Insert as movable image on current page"
                      >
                        <Plus size={11} /> Insert Here
                      </button>
                    </div>

                    <div className="flex items-center justify-between pt-0.5 px-0.5 text-[10px]">
                      <button
                        type="button"
                        onClick={() => handleDownloadImage(img)}
                        className="flex items-center gap-1 text-app-muted hover:text-app transition-colors"
                        title="Download image"
                      >
                        <Download size={10} /> Download
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteRemovedImage?.(img.id)}
                        className="flex items-center gap-1 text-app-faint hover:text-red-400 transition-colors"
                        title="Delete permanently from bin"
                      >
                        <Trash2 size={10} /> Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* FORM FIELDS — Select + Text tools */}
      {(activeTool === 'select' || activeTool === 'text' || activeTool === 'addtext') && (
      <div className="p-4 space-y-3 border-t border-app animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold tracking-wider text-foreground uppercase">
              Form Fields {formFields.length > 0 ? `(${formFields.length})` : ''}
            </span>
            {onFlattenForms && formFields.length > 0 && (
              <button
                onClick={onFlattenForms}
                className="text-[10px] font-medium px-2 py-1 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
              >
                Flatten All
              </button>
            )}
          </div>

          {formFields.length === 0 ? (
            <p className="text-[11px] text-app-faint leading-relaxed">
              No AcroForm fields on this page. Open a fillable PDF to edit text, checkbox, and dropdown fields here. Amber boxes appear on the page when fields are detected.
            </p>
          ) : (
          <>
          <p className="text-[10px] text-app-faint leading-relaxed">
            Click an amber box on the page or a field below to edit its value.
          </p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {formFields.map((field) => (
              <button
                key={field.ref.toKey()}
                onClick={() => onFormFieldSelect?.(field)}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-[11px] transition-colors ${
                  selectedFormField?.ref.toKey() === field.ref.toKey()
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : 'bg-panel-elevated text-app-muted border border-app hover:bg-panel-elevated/80'
                }`}
              >
                <div className="font-medium truncate">{field.fieldName || 'Unnamed'}</div>
                <div className="text-[10px] text-app-faint">{field.fieldType}</div>
              </button>
            ))}
          </div>

          {selectedFormField && selectedFormField.fieldType === 'Tx' && onFormFieldChange && (
            <div className="space-y-2">
              <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Value</label>
              <input
                type="text"
                value={formFieldDraft}
                aria-label="Field value"
                onChange={(e) => onFormFieldChange(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-panel-elevated border border-app rounded-lg text-app focus:outline-none focus:border-primary"
              />
            </div>
          )}

          {selectedFormField && selectedFormField.fieldType === 'Btn' && onFormFieldChange && (
            <div className="space-y-2">
              <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Checkbox / Radio</label>
              <button
                onClick={() => {
                  const checked = !(selectedFormField.value === true || selectedFormField.value === 'Yes' || selectedFormField.value === 'On');
                  onFormFieldChange(checked ? 'Yes' : 'Off');
                }}
                className="w-full py-2 rounded-lg text-xs font-semibold bg-panel-elevated border border-app text-app hover:bg-panel-elevated/80"
              >
                {(selectedFormField.value === true || selectedFormField.value === 'Yes' || selectedFormField.value === 'On')
                  ? 'Checked — click to uncheck'
                  : 'Unchecked — click to check'}
              </button>
            </div>
          )}

          {selectedFormField && selectedFormField.fieldType === 'Ch' && onFormFieldChange && (
            <div className="space-y-2">
              <label className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Choice value</label>
              <input
                type="text"
                value={formFieldDraft}
                onChange={(e) => onFormFieldChange(e.target.value)}
                aria-label="Choice value"
                placeholder="Enter option value"
                className="w-full px-3 py-2 text-sm bg-panel-elevated border border-app rounded-lg text-app focus:outline-none focus:border-primary"
              />
            </div>
          )}
          </>
          )}
        </div>
      )}

      {/* WATERMARK PROPERTIES */}
      {activeTool === 'watermark' && (
        <div className="flex flex-col h-full bg-panel/95 animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="p-4 pb-2">
            <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
              <Stamp size={14} />
              Watermark options
            </div>
          </div>
          
          <div className="flex border-b border-app mt-2">
            <button
              onClick={() => setWatermarkType?.('text')}
              className={`flex-1 py-3 flex flex-col items-center gap-2 text-[11px] font-medium transition-colors ${watermarkType === 'text' ? 'text-app bg-panel-elevated' : 'text-app-muted hover:text-app'}`}
            >
              <div className={`text-xl font-serif ${watermarkType === 'text' ? 'border-b-2 border-app text-app' : 'border-b-2 border-app-faint text-app-faint'}`}>A</div>
              Text
            </button>
            <button
              onClick={() => setWatermarkType?.('image')}
              className={`flex-1 py-3 flex flex-col items-center gap-2 text-[11px] font-medium relative transition-colors ${watermarkType === 'image' ? 'text-app bg-panel-elevated' : 'text-app-muted hover:text-app'}`}
            >
              <Image size={20} className={watermarkType === 'image' ? 'text-app' : 'text-app-faint'} />
              Image
            </button>
            <button
              onClick={() => setWatermarkType?.('shape')}
              className={`flex-1 py-3 flex flex-col items-center gap-2 text-[11px] font-medium transition-colors ${watermarkType === 'shape' ? 'text-app bg-panel-elevated' : 'text-app-muted hover:text-app'}`}
            >
              <div className={`w-5 h-5 rounded border-2 ${watermarkType === 'shape' ? 'border-app' : 'border-app-faint'}`} />
              Shape
            </button>
          </div>
          
          {/* Live Preview Toggle */}
          <div className="p-4 border-b border-app flex items-center justify-between bg-panel/80">
            <span className="text-xs font-semibold text-app">Live Preview</span>
            <button
              type="button"
              role="switch"
              aria-checked={!!watermarkLivePreview}
              aria-label="Live preview"
              onClick={() => setWatermarkLivePreview?.(!watermarkLivePreview)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${watermarkLivePreview ? 'bg-primary' : 'bg-panel-elevated border border-app'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${watermarkLivePreview ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <div className="p-4 space-y-5 overflow-y-auto flex-1">
            {watermarkType === 'text' ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-app">Text:</label>
                  <input
                    type="text"
                    value={watermarkText}
                    aria-label="Watermark text"
                    onChange={(e) => setWatermarkText?.(e.target.value)}
                    className="w-full bg-panel-elevated border border-app rounded px-3 py-2 text-xs text-app outline-none focus:border-primary transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-app">Text format:</label>
                  <select
                    value={watermarkFontName}
                    onChange={(e) => setWatermarkFontName?.(e.target.value)}
                    className="w-full bg-panel-elevated border border-app rounded px-3 py-2 text-xs text-app outline-none focus:border-primary transition-colors appearance-none cursor-pointer"
                  >
                    <option value="Arial">Arial</option>
                    <option value="Helvetica">Helvetica</option>
                    <option value="Times-Roman">Times Roman</option>
                    <option value="Courier">Courier</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-app">Color:</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={watermarkColor}
                      onChange={(e) => setWatermarkColor?.(e.target.value)}
                      className="w-8 h-8 cursor-pointer rounded overflow-hidden"
                    />
                    <span className="text-[11px] text-app-muted font-mono uppercase">{watermarkColor}</span>
                  </div>
                </div>
              </>
            ) : watermarkType === 'shape' ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-app">Shape:</label>
                  <select
                    value={watermarkShapeType}
                    onChange={(e) => setWatermarkShapeType?.(e.target.value as 'rectangle' | 'circle' | 'pill')}
                    className="w-full bg-panel-elevated border border-app rounded px-3 py-2 text-xs text-app outline-none focus:border-primary transition-colors appearance-none cursor-pointer"
                  >
                    <option value="rectangle">Rectangle</option>
                    <option value="circle">Circle</option>
                    <option value="pill">Pill</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-app">Text (inside shape):</label>
                  <input
                    type="text"
                    value={watermarkText}
                    aria-label="Watermark text"
                    onChange={(e) => setWatermarkText?.(e.target.value)}
                    className="w-full bg-panel-elevated border border-app rounded px-3 py-2 text-xs text-app outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div className="flex gap-4">
                  <div className="space-y-1.5 flex-1">
                    <label className="text-[11px] font-medium text-app">Text Color:</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        value={watermarkColor}
                        onChange={(e) => setWatermarkColor?.(e.target.value)}
                        className="w-8 h-8 cursor-pointer rounded overflow-hidden"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5 flex-1">
                    <label className="text-[11px] font-medium text-app">Border Color:</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        value={watermarkShapeColor}
                        onChange={(e) => setWatermarkShapeColor?.(e.target.value)}
                        className="w-8 h-8 cursor-pointer rounded overflow-hidden"
                      />
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex justify-center relative">
                  <button 
                    onClick={() => {
                      const fileInput = document.createElement('input');
                      fileInput.type = 'file';
                      fileInput.accept = 'image/png, image/jpeg';
                      fileInput.onchange = (e) =>
                        onWatermarkImageUpload?.(e as unknown as React.ChangeEvent<HTMLInputElement>);
                      fileInput.click();
                    }}
                    className="flex items-center gap-2 bg-primary hover:brightness-105 text-primary-foreground px-8 py-3 rounded-xl text-xs font-bold transition-all"
                  >
                    <Image size={16} /> ADD IMAGE
                  </button>
                  {watermarkImageFile && (
                    <p className="text-[10px] text-emerald-500 mt-2 truncate w-full text-center absolute top-12">
                      Loaded: {watermarkImageFile.name}
                    </p>
                  )}
                </div>
                {watermarkImageFile && (
                  <button 
                    onClick={onWatermarkImageClear}
                    className="w-full py-1.5 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/30 rounded text-[11px] hover:bg-red-500/20 transition-colors"
                  >
                    Remove Image
                  </button>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-app">Position:</label>
              <div className="flex items-start gap-4">
                <div className="grid grid-cols-3 grid-rows-3 gap-0 border border-app w-16 h-16 relative">
                  {(['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const).map((pos) => (
                    <button
                      key={pos}
                      onClick={() => setWatermarkPosition?.(pos)}
                      className="border border-app flex items-center justify-center hover:bg-panel-elevated transition-colors"
                    >
                      {(watermarkPosition === pos || watermarkMosaic) && <div className="w-3 h-3 bg-primary rounded-full" />}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-[11px] text-app cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={watermarkMosaic}
                    onChange={(e) => setWatermarkMosaic?.(e.target.checked)}
                    className="rounded border-app bg-panel-elevated text-primary cursor-pointer"
                  />
                  Mosaic
                </label>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="space-y-1.5 flex-1">
                <label className="text-[11px] font-medium text-app">Transparency:</label>
                <select
                  value={watermarkOpacity === 100 ? 'No transparency' : `${100 - watermarkOpacity}%`}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'No transparency') setWatermarkOpacity?.(100);
                    else setWatermarkOpacity?.(100 - parseInt(val));
                  }}
                  className="w-full bg-panel-elevated border border-app rounded px-2 py-2 text-[11px] text-app outline-none focus:border-primary transition-colors appearance-none cursor-pointer"
                >
                  <option value="No transparency">No transparency</option>
                  <option value="25%">25%</option>
                  <option value="50%">50%</option>
                  <option value="75%">75%</option>
                </select>
              </div>
              <div className="space-y-1.5 flex-1">
                <label className="text-[11px] font-medium text-app">Rotation:</label>
                <select
                  value={watermarkRotation === 0 ? 'Do not rotate' : `${watermarkRotation} degrees`}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'Do not rotate') setWatermarkRotation?.(0);
                    else setWatermarkRotation?.(parseInt(val));
                  }}
                  className="w-full bg-panel-elevated border border-app rounded px-2 py-2 text-[11px] text-app outline-none focus:border-primary transition-colors appearance-none cursor-pointer"
                >
                  <option value="Do not rotate">Do not rotate</option>
                  <option value="45 degrees">45 degrees</option>
                  <option value="90 degrees">90 degrees</option>
                  <option value="180 degrees">180 degrees</option>
                  <option value="270 degrees">270 degrees</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-app">Blend Mode:</label>
              <select
                value={watermarkBlendMode}
                onChange={(e) => setWatermarkBlendMode?.(e.target.value)}
                className="w-full bg-panel-elevated border border-app rounded px-2 py-2 text-[11px] text-app outline-none focus:border-primary transition-colors appearance-none cursor-pointer"
              >
                <option value="Normal">Normal (source-over)</option>
                <option value="Multiply">Multiply</option>
                <option value="Screen">Screen</option>
                <option value="Overlay">Overlay</option>
                <option value="Darken">Darken</option>
                <option value="Lighten">Lighten</option>
                <option value="ColorDodge">Color Dodge</option>
                <option value="ColorBurn">Color Burn</option>
                <option value="HardLight">Hard Light</option>
                <option value="SoftLight">Soft Light</option>
                <option value="Difference">Difference</option>
                <option value="Exclusion">Exclusion</option>
                <option value="Hue">Hue</option>
                <option value="Saturation">Saturation</option>
                <option value="Color">Color</option>
                <option value="Luminosity">Luminosity</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="flex items-center justify-between text-[11px] font-medium text-app">
                Size
                <span className="text-app-muted font-mono">{watermarkSize}%</span>
              </label>
              <input
                type="range"
                min="10"
                max="300"
                value={watermarkSize}
                onChange={(e) => setWatermarkSize?.(parseInt(e.target.value))}
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-app">Pages:</label>
              <div className="flex items-center gap-2">
                <div className="flex items-center border border-app rounded bg-panel-elevated">
                  <span className="px-2 text-[11px] text-app-muted border-r border-app">from page</span>
                  <input
                    type="number"
                    min="1"
                    value={watermarkPageFrom}
                    onChange={(e) => setWatermarkPageFrom?.(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-12 bg-transparent py-1.5 text-xs text-center text-app outline-none"
                  />
                </div>
                <div className="flex items-center border border-app rounded bg-panel-elevated">
                  <span className="px-2 text-[11px] text-app-muted border-r border-app">to</span>
                  <input
                    type="number"
                    min="1"
                    value={watermarkPageTo}
                    onChange={(e) => setWatermarkPageTo?.(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-12 bg-transparent py-1.5 text-xs text-center text-app outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-app">Layer</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setWatermarkLayer?.('above')}
                  className={`flex-1 py-6 flex flex-col items-center justify-center gap-2 rounded border transition-colors ${watermarkLayer === 'above' ? 'bg-primary/15 border-primary/50 text-primary' : 'bg-panel-elevated border-app text-app-muted hover:text-app'}`}
                >
                  <div className="rotate-45 w-4 h-4 bg-current" />
                  <span className="text-[10px] text-center px-2">Over the PDF content</span>
                </button>
                <button
                  onClick={() => setWatermarkLayer?.('below')}
                  className={`flex-1 py-6 flex flex-col items-center justify-center gap-2 rounded border transition-colors ${watermarkLayer === 'below' ? 'bg-primary/15 border-primary/50 text-primary' : 'bg-panel-elevated border-app text-app-muted hover:text-app'}`}
                >
                  <div className="rotate-45 w-4 h-4 border-2 border-current" />
                  <span className="text-[10px] text-center px-2">Below the PDF content</span>
                </button>
              </div>
            </div>

            <div className="pt-2 flex flex-col gap-2 pb-4">
              <button
                onClick={onApplyWatermark}
                className="w-full h-10 bg-primary hover:brightness-105 text-primary-foreground rounded-xl text-[13px] font-bold shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)] transition-all"
              >
                Add watermark
              </button>
              
              {!hasScannedWatermarks ? (
                <button
                  onClick={onScanWatermarks}
                  className="w-full bg-panel-elevated text-app border border-app hover:bg-panel-elevated/80 rounded py-2 text-xs font-semibold transition-colors"
                >
                  Scan for Watermarks
                </button>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <button
                      onClick={onCancelScan}
                      className="flex-1 bg-panel-elevated text-app border border-app rounded py-2 text-xs font-semibold transition-colors"
                    >
                      Cancel
                    </button>
                    {detectedWatermarksCount > 0 && (
                      <button
                        onClick={onRemoveWatermarks}
                        className="flex-1 bg-red-600 hover:bg-red-700 text-white rounded py-2 text-xs font-semibold transition-colors"
                      >
                        Remove Selected
                      </button>
                    )}
                  </div>
                  {detectedWatermarksCount === 0 && (
                    <div className="text-center p-3 bg-amber-500/10 border border-amber-500/20 rounded-md">
                      <p className="text-amber-600 dark:text-amber-400 text-xs font-medium mb-1">no watermark found in scan process</p>
                      <p className="text-app-faint text-[10px]">if you are seeing any watermark, it may be image, so please go to image section to remove</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SIGNATURE PROPERTIES */}
      {activeTool === 'sign' && (
        <div className="flex flex-col h-full bg-panel/95 animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="p-4 pb-2">
            <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
              <PenLine size={14} />
              Signature
            </div>
            <p className="text-[10px] text-app-faint mt-1">
              Create a signature, then drag it from the library onto the page.
            </p>
          </div>

          <div className="px-4 pb-3 space-y-2">
            <button
              type="button"
              onClick={onOpenSignatureCreate}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-primary hover:bg-bloom-600 text-white text-xs font-semibold transition-colors"
            >
              <PenLine size={14} /> Create signature
            </button>
          </div>

          {pdfSignatureFields.length > 0 && (
            <div className="px-4 pb-3 space-y-2 border-b border-app">
              <div className="text-[11px] font-bold tracking-wider text-foreground uppercase">
                PDF fields on page
              </div>
              {pdfSignatureFields.map((field) => {
                const active = selectedPdfSigFieldId === field.id;
                return (
                  <button
                    key={field.id}
                    type="button"
                    onClick={() => setSelectedPdfSigFieldId?.(field.id)}
                    className={`w-full text-left rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
                      active
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500'
                        : 'border-app text-app hover:border-app-strong'
                    }`}
                  >
                    <div className="font-medium truncate">{field.fieldName}</div>
                    <div className="text-[10px] text-app-faint">
                      {field.signed ? 'Signed' : 'Unsigned'}
                      {field.hasAppearance ? ' · has /AP' : ''}
                    </div>
                  </button>
                );
              })}
              {selectedPdfSigFieldId && (
                <button
                  type="button"
                  onClick={onPlaceIntoSelectedField}
                  className="w-full py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold"
                >
                  Place library signature into field
                </button>
              )}
            </div>
          )}

          <div className="px-4 pb-3 space-y-2 border-b border-app">
            <div className="text-[11px] font-bold tracking-wider text-foreground uppercase flex items-center gap-1.5">
              <KeyRound size={12} /> Certificate
            </div>
            <button
              type="button"
              onClick={onOpenCertificateImport}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-panel-elevated border border-app text-app hover:bg-panel-elevated/80 text-xs font-semibold"
            >
              <KeyRound size={14} /> Import / manage certificates
            </button>
            {certificateIdentities.length === 0 ? (
              <p className="text-[11px] text-app-faint">
                Import a PEM/P12 identity before digitally signing.
              </p>
            ) : (
              <div className="space-y-1.5">
                {certificateIdentities.map((id) => {
                  const active = selectedCertificateId === id.id;
                  return (
                    <button
                      key={id.id}
                      type="button"
                      onClick={() => onSelectCertificate?.(id.id)}
                      className={`w-full text-left rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-app text-app hover:border-app-strong'
                      }`}
                    >
                      <div className="font-medium truncate">{id.label}</div>
                      <div className="text-[10px] text-app-faint">
                        {id.hasPrivateKey ? 'Ready to sign' : 'Cert only — re-import key'}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {certificateIdentities.length > 0 && (
              <button
                type="button"
                disabled={cryptoSignBusy}
                onClick={onCryptographicSign}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
              >
                <ShieldCheck size={14} />
                {cryptoSignBusy ? 'Signing…' : 'Digitally sign document'}
              </button>
            )}
            <label className="flex items-center gap-2 text-[11px] text-app-muted cursor-pointer">
              <input
                type="checkbox"
                checked={enableTimestamp}
                onChange={(e) => setEnableTimestamp?.(e.target.checked)}
                className="rounded border-app"
              />
              Request RFC 3161 timestamp (TSA)
            </label>
          </div>

          <div className="px-4 pb-3 space-y-2 border-b border-app">
            <div className="text-[11px] font-bold tracking-wider text-foreground uppercase flex items-center gap-1.5">
              <ShieldCheck size={12} /> Validation & LTV
            </div>
            <button
              type="button"
              disabled={validationBusy}
              onClick={onValidateSignatures}
              className="w-full py-1.5 rounded-md bg-panel-elevated border border-app hover:bg-panel-elevated/80 disabled:opacity-50 text-app text-[11px] font-semibold"
            >
              {validationBusy ? 'Validating…' : 'Validate all signatures'}
            </button>
            {validationReport && (
              <div className="rounded-md border border-app bg-panel-elevated p-2 space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-app-muted">Document</span>
                  <span
                    data-testid="validation-status"
                    className={
                      validationReport.documentStatus === 'Valid'
                        ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                        : validationReport.documentStatus === 'Modified'
                          ? 'text-red-500 font-semibold'
                          : 'text-amber-600 dark:text-amber-400 font-semibold'
                    }
                  >
                    {validationReport.documentStatus}
                  </span>
                </div>
                <div className="text-[10px] text-app-faint">
                  {validationReport.signatures.length} signature(s) · {validationReport.revisionCount} revision(s)
                </div>
                {validationReport.signatures.map((s) => (
                  <div key={s.fieldId} className="text-[10px] border-t border-app pt-1">
                    <div className="flex justify-between gap-2">
                      <span className="text-app truncate">{s.fieldName}</span>
                      <span
                        className={
                          s.status === 'Valid'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : s.status === 'Modified' || s.status === 'Revoked'
                              ? 'text-red-500'
                              : 'text-amber-600 dark:text-amber-400'
                        }
                      >
                        {s.status}
                      </span>
                    </div>
                    <div className="text-app-faint truncate">{s.summary}</div>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={onEnableLtv}
              className="w-full py-1.5 rounded-md bg-panel-elevated border border-app hover:bg-panel-elevated/80 text-app text-[11px] font-semibold"
            >
              Enable LTV (embed DSS)
            </button>
            {ltvStatus && (
              <p className="text-[10px] text-app-faint">{ltvStatus.summary}</p>
            )}
          </div>

          {(managedSignatures.length > 0 || revisionEntries.length > 0) && (
            <div className="px-4 pb-3 space-y-2 border-b border-app">
              <div className="text-[11px] font-bold tracking-wider text-foreground uppercase">
                Signatures & revisions
              </div>
              {managedSignatures.map((m) => (
                <button
                  key={m.field.id}
                  type="button"
                  onClick={() => setSelectedPdfSigFieldId?.(m.field.id)}
                  className="w-full text-left rounded-md border border-app px-2 py-1.5 text-[11px] text-app hover:border-app-strong"
                >
                  <div className="font-medium truncate">
                    #{m.index + 1} {m.signerName || m.field.fieldName}
                  </div>
                  <div className="text-[10px] text-app-faint truncate">
                    {m.signingTime || 'No time'} · {m.reason || 'No reason'}
                    {m.validation ? ` · ${m.validation.status}` : ''}
                  </div>
                </button>
              ))}
              {revisionEntries.length > 0 && (
                <div className="text-[10px] text-app-faint space-y-0.5">
                  {revisionEntries.map((r) => (
                    <div key={r.revision.index}>
                      Rev {r.revision.index + 1}: xref @{r.revision.xrefOffset}
                      {r.signatureFieldIds.length
                        ? ` · ${r.signatureFieldIds.length} sig`
                        : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {selectedSignature && (
            <div className="px-4 pb-4 space-y-3 border-b border-app">
              <div className="text-[11px] font-bold tracking-wider text-foreground uppercase">Selected</div>
              <div className="space-y-1.5">
                <label className="text-[11px] text-app">Opacity</label>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={Math.round(selectedSignature.opacity * 100)}
                  onChange={(e) =>
                    onSignatureOpacity?.(selectedSignature.id, Number(e.target.value) / 100)
                  }
                  className="w-full accent-primary"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] rounded bg-panel-elevated border border-app text-app hover:bg-panel-elevated/80"
                  onClick={() =>
                    onSignatureRotate?.(
                      selectedSignature.id,
                      (selectedSignature.rotation + 15) % 360,
                    )
                  }
                >
                  <RotateCw size={12} /> Rotate
                </button>
                <button
                  type="button"
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] rounded bg-panel-elevated border border-app text-app hover:bg-panel-elevated/80"
                  onClick={() => onSignatureLockToggle?.(selectedSignature.id)}
                >
                  {selectedSignature.locked ? <Unlock size={12} /> : <Lock size={12} />}
                  {selectedSignature.locked ? 'Unlock' : 'Lock'}
                </button>
                <button
                  type="button"
                  className="flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] rounded bg-red-500/20 border border-red-500/40 text-red-500 hover:bg-red-500/30"
                  onClick={() => onSignatureDelete?.(selectedSignature.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          )}

          <div className="p-4 flex-1 overflow-y-auto space-y-2">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-bold tracking-wider text-foreground uppercase">
                Library
              </div>
              <div className="text-[10px] text-app-faint">
                Drag to page
              </div>
            </div>
            {signatureLibraryEntries.length === 0 && (
              <p className="text-[11px] text-app-faint">No saved signatures yet.</p>
            )}
            {signatureLibraryEntries.map((entry) => {
              const active = activeLibraryId === entry.id;
              return (
                <div
                  key={entry.id}
                  draggable={true}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-signature-id', entry.id);
                    e.dataTransfer.setData('text/plain', entry.id);
                    e.dataTransfer.effectAllowed = 'copy';
                    setActiveLibraryId?.(entry.id);
                  }}
                  className={`rounded-lg border p-2 cursor-grab active:cursor-grabbing transition-colors ${
                    active
                      ? 'border-primary bg-primary/10'
                      : 'border-app hover:border-app-strong bg-panel-elevated/60'
                  }`}
                  onClick={() => setActiveLibraryId?.(entry.id)}
                >
                  <div className="h-12 rounded bg-white flex items-center justify-center overflow-hidden mb-2 border border-app">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={entry.imageDataUrl}
                      alt={entry.name}
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                  <input
                    value={entry.name}
                    aria-label="Signature name"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onLibraryRename?.(entry.id, e.target.value)}
                    className="w-full bg-transparent text-[11px] text-app outline-none border-b border-transparent focus:border-app-strong"
                  />
                  <div className="flex items-center gap-1 mt-1.5">
                    <button
                      type="button"
                      title="Favorite"
                      aria-pressed={entry.favorite}
                      className={`p-1 rounded ${entry.favorite ? 'text-amber-600 dark:text-amber-400' : 'text-app-faint hover:text-app'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onLibraryFavorite?.(entry.id);
                      }}
                    >
                      <Star size={12} fill={entry.favorite ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      type="button"
                      title="Duplicate"
                      className="p-1 rounded text-app-faint hover:text-app"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLibraryDuplicate?.(entry.id);
                      }}
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      className="p-1 rounded text-app-faint hover:text-red-500 ml-auto"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLibraryDelete?.(entry.id);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>

    {/* Lightbox Preview Modal for Removed Image */}
    {previewImage && (
      <div
        className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-200"
        onClick={() => setPreviewImage(null)}
      >
        <div
          className="bg-panel border border-app rounded-2xl p-4 max-w-sm w-full space-y-3 shadow-2xl animate-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-app flex items-center gap-1.5">
              <History size={14} className="text-[#38BDF8]" />
              Removed Image Preview
            </span>
            <button
              onClick={() => setPreviewImage(null)}
              className="text-app-faint hover:text-app p-1 rounded-lg hover:bg-panel-elevated transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="max-h-64 overflow-hidden rounded-xl bg-black/50 border border-app flex items-center justify-center p-2">
            <img
              src={previewImage.dataUrl}
              alt="Removed image preview"
              className="max-h-56 max-w-full object-contain rounded"
            />
          </div>
          <div className="text-[11px] text-app-faint space-y-1 bg-panel-elevated/70 p-2.5 rounded-lg border border-app">
            <div className="flex justify-between">
              <span>Original Page:</span>
              <span className="text-app font-medium">Page {previewImage.originalPage + 1}</span>
            </div>
            <div className="flex justify-between">
              <span>Dimensions:</span>
              <span className="text-app font-medium">{Math.round(previewImage.originalBounds.width)} × {Math.round(previewImage.originalBounds.height)} pt</span>
            </div>
            <div className="flex justify-between">
              <span>Deleted:</span>
              <span className="text-app font-medium">{formatRelativeTime(previewImage.deletedAt)}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={() => {
                onRestoreRemovedImage?.(previewImage);
                setPreviewImage(null);
              }}
              className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold bg-[#38BDF8] text-white hover:bg-[#0ea5e9] transition-colors shadow-xs"
            >
              <RotateCcw size={13} /> Restore
            </button>
            <button
              onClick={() => {
                handleDownloadImage(previewImage);
              }}
              className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-medium bg-panel-elevated text-app hover:bg-panel-elevated/80 border border-app transition-colors shadow-xs"
            >
              <Download size={13} /> Download
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
