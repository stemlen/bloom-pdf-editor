'use client';

import { joinParts } from '@/lib/format';
import { Fragment, useEffect, useLayoutEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  loadPdfFromStorage,
  clearPdfFromStorage,
  loadEditorSession,
  saveEditorSession,
  clearEditorSession,
  saveRemovedImages,
  loadRemovedImages,
  clearRemovedImages,
} from '@/lib/pdfStorage';
import { X, Loader2, ChevronLeft, Image, Type, Copy, RotateCw } from 'lucide-react';

// We import types only — the engine modules are loaded dynamically
// because they require browser APIs (canvas, DecompressionStream)
import type { PDFDocumentData, PDFObject, PDFPageInfo, RenderResult, TextRun, TextLine, ImageItem, PathItem, DisplayItem, TextWatermark, ImageWatermark, Watermark, WatermarkPosition, DetectedWatermark, AcroFormWidget, BloomPage, DetectedTable, VisualSignature, SignatureLibraryEntry, SignatureField, ManagedIdentity, ValidationReport, LtvStatus, ManagedSignature, RevisionViewEntry } from '@/engine';

import type { EditorTool, ToolDef, PathType, DrawnPath, FloatingText, FloatingImage, DrawMode, RemovedImageRecord } from './types';
import { TOOLS } from './types';
import {
  canvasToPdf, pdfToCanvas, hexToRGB,
  hitTestTextLine, findNearestTextLine, caretIndexFromLineX,
  getLineBounds, getOverlayFontFamily, getOverlayFontStyle, getDisplayFontFamily,
  extractImageItemDataUrl,
} from './utils';
import { PDFRef, getPageContentBytes, interpretPage, buildDisplayListIndex, hitTestDisplayList, isSelectableDisplayItem, EditorHistory, captureHistoryEntry, restoreAnnotSnapshot, parseOverlaySnapshot, deleteObject, visualFontSize, resolveRunStyleFlags, transformObject, applyObjectTransform, distributeTextChangeToSegments, segmentAtIndex, createVisualSignature, hitTestSignature, moveSignature, resizeSignature, rotateSignature, setSignatureOpacity, setSignatureLocked, deleteSignature, updateSignature, getSignatureLibrary, DEFAULT_SIGNATURE_SIZE, detectSignatureFieldsOnPage, hitTestSignatureField, createSignatureFieldAtPoint, applySignatureFieldAppearanceAsync, getCertificateManager, signDocumentCryptographic, validateDocumentSignatures, enableLongTermValidation, getLtvStatus, listManagedSignatures, buildRevisionViewer, lockSignaturesAfterSigning, pushRecentSignatureId, orderLibraryByRecent, SIGNATURE_SHORTCUTS } from '@/engine';
import type { QuadTree, SelectableItem, EditableObject } from '@/engine';
import { findMatchingFlowLine } from './flowLineMatch';

import { Toolbar } from './components/Toolbar';
import { ToolsSidebar } from './components/ToolsSidebar';
import { PropertiesSidebar } from './components/PropertiesSidebar';
import { EditableLineBox, type OverlaySegmentStyle } from './components/EditableLineBox';
import { LinkPopover, type LinkPopoverMode } from './components/LinkPopover';
import { EmbeddedImageOverlay } from './components/EmbeddedImageOverlay';
import { SignatureOverlay } from './components/signatures/SignatureOverlay';
import { SignatureCreateDialog, type SignatureCreateResult } from './components/signatures/SignatureCreateDialog';
import { CertificateImportDialog } from './components/signatures/CertificateImportDialog';
import { WatermarkPreview } from './components/WatermarkPreview';
import { hitTestDrawnPath, drawnPathBounds } from './drawingHitTest';
import { watermarkFitScale, watermarkNaturalSize } from '@/lib/watermarkFit';
import { SignedCompressDialog, type SignedCompressChoice } from './components/SignedCompressDialog';
import { ThumbnailsSidebar } from './components/ThumbnailsSidebar';
import { FindReplacePanel } from './components/FindReplacePanel';
import { StatusBar } from './components/StatusBar';
import { ExportPanel } from './components/ExportPanel';
import { PasswordDialog } from './components/PasswordDialog';
import { SecurityPanel } from './components/SecurityPanel';
import { useTextStyleActions, type TextStyleUI } from './hooks/useTextStyleActions';
import { useIsMobile } from './hooks/useIsMobile';
import { Lotus } from '@/components/art/Doodles';
import { LostPageIllustration } from '@/components/art/Illustrations';
import { friendlyPdfError, actionErrorMessage } from '@/lib/pdfErrors';

export interface SearchMatch {
  id: string;
  pageIndex: number;
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
  matchedText: string;
  runText: string;
}


/** True if the run is underlined or a thin stroke path sits under it (certificate labels). */
function runHasPathUnderline(run: TextRun, paths: PathItem[]): boolean {
  if (run.isUnderline) return true;
  const fs = visualFontSize(run);
  const yTarget = run.y - fs * 0.12;
  for (const p of paths) {
    if (p.paintType !== 'stroke' && p.paintType !== 'both') continue;
    if (p.height > fs * 0.5) continue;
    if (p.width < fs * 0.4) continue;
    if (p.lineWidth > fs * 0.4) continue;
    const py = p.y + p.height * 0.5;
    if (Math.abs(py - yTarget) > fs * 0.45 && Math.abs(p.y - yTarget) > fs * 0.45) continue;
    const overlapL = Math.max(p.x, run.x);
    const overlapR = Math.min(p.x + p.width, run.x + Math.max(run.width, fs));
    if (overlapR - overlapL < fs * 0.3) continue;
    return true;
  }
  return false;
}

type TypingStyle = Partial<Pick<TextStyleUI, 'bold' | 'italic' | 'underline' | 'color' | 'fontSize' | 'fontFamily'>>;

/**
 * Map a char index in the *current* edit text to the PDF run that owns it
 * after caret-aware redistribute. Using frozen-anchor indices directly is
 * wrong once inserts push the caret past later original segments (e.g. into
 * an unbold neighbor), which then falsely queues bold patches.
 */
function runAtDistributedEditIndex(
  line: TextLine,
  initialText: string,
  currentText: string,
  charIndex: number,
): TextRun | null {
  if (!currentText) {
    return line.segments[0]?.run ?? null;
  }
  const idx = Math.max(0, Math.min(charIndex, currentText.length - 1));
  const edits = distributeTextChangeToSegments(
    line,
    initialText,
    currentText,
    Math.min(charIndex + 1, currentText.length),
  );
  let pos = 0;
  for (const edit of edits) {
    const end = pos + edit.newText.length;
    if (idx >= pos && idx < end) return edit.run;
    pos = end;
  }
  if (edits.length > 0) return edits[edits.length - 1].run;
  return segmentAtIndex(line, Math.min(idx, line.text.length))?.run ?? null;
}

/**
 * Word-like style at the caret: inherit from the character to the LEFT
 * (or index 0 at line start), including path-drawn underlines and overrides.
 */
function resolveTypingStyleFromCaret(
  line: TextLine,
  caret: number,
  fonts: RenderResult['fonts'] | undefined,
  paths: PathItem[],
  overrides: EditStyleOverride[],
  currentText?: string,
  initialText?: string,
): TypingStyle {
  const styleIndex = caret > 0 ? caret - 1 : 0;
  const text = currentText ?? line.text;
  const initial = initialText ?? line.text;
  const run = runAtDistributedEditIndex(line, initial, text, styleIndex)
    ?? segmentAtIndex(line, Math.min(styleIndex, line.text.length))?.run;
  if (!run) return {};
  const fontData = fonts?.get(run.fontName);
  const flags = resolveRunStyleFlags(run.fontName, fontData);
  let bold = flags.bold;
  let italic = flags.italic;
  let underline = !!run.isUnderline || runHasPathUnderline(run, paths);
  let fontSize = visualFontSize(run);
  let color: string | undefined;
  if (run.fillColor) {
    const [r, g, b] = run.fillColor;
    color = '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
  }
  for (const ov of overrides) {
    if (styleIndex >= ov.start && styleIndex < ov.end) {
      if (ov.bold != null) bold = ov.bold;
      if (ov.italic != null) italic = ov.italic;
      if (ov.underline != null) underline = ov.underline;
      if (ov.fontSize != null) fontSize = ov.fontSize;
      if (ov.color) color = ov.color;
    }
  }
  return {
    bold,
    italic,
    underline,
    fontSize,
    // Intentionally omit fontFamily — display names strip "Bold" and would
    // replace the PDF face with synthetic weight on insert overrides.
    ...(color ? { color } : {}),
  };
}

/**
 * Remap a [start,end) style range across an insert (delta>0) or delete (delta<0).
 * Deletes must collapse points inside the removed span — never shift a range
 * that starts at editAt leftward onto the previous character.
 */
function remapStyleRange(
  start: number,
  end: number,
  editAt: number,
  delta: number,
): { start: number; end: number } | null {
  if (delta > 0) {
    if (end <= editAt) return { start, end };
    if (start >= editAt) return { start: start + delta, end: end + delta };
    return { start, end: end + delta };
  }
  if (delta < 0) {
    const delEnd = editAt - delta;
    const mapPoint = (p: number) => {
      if (p <= editAt) return p;
      if (p >= delEnd) return p + delta;
      return editAt;
    };
    const ns = mapPoint(start);
    const ne = mapPoint(end);
    if (ne <= ns) return null;
    return { start: ns, end: ne };
  }
  return { start, end };
}

/**
 * Merge same fontSize-only patches across whitespace/punctuation gaps.
 * Per-keystroke inserts leave holes on spaces (intentionally not committed),
 * so sequential applies split the same run repeatedly with stale indices and
 * only the first chunk keeps the new size — later typed text looks "unbold"
 * / small and trailing glyphs overlap.
 */
function coalesceFontSizePatches<T extends { start: number; end: number; patch: Partial<TextStyleUI> }>(
  queued: T[],
  commitText: string,
): T[] {
  if (queued.length <= 1) return queued;
  const out: T[] = [];
  for (const item of queued) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...item, patch: { ...item.patch } });
      continue;
    }
    const prevKeys = Object.keys(prev.patch).filter(k => (prev.patch as Record<string, unknown>)[k] != null);
    const itemKeys = Object.keys(item.patch).filter(k => (item.patch as Record<string, unknown>)[k] != null);
    const prevOnlyFs = prevKeys.length === 1 && prevKeys[0] === 'fontSize';
    const itemOnlyFs = itemKeys.length === 1 && itemKeys[0] === 'fontSize';
    const sameFs =
      prevOnlyFs
      && itemOnlyFs
      && prev.patch.fontSize != null
      && prev.patch.fontSize === item.patch.fontSize;
    const gap = commitText.slice(prev.end, item.start);
    const gapOk = prev.end <= item.start && /^[\s.,;:!?…\-–—]*$/.test(gap);
    if (sameFs && gapOk) {
      prev.end = Math.max(prev.end, item.end);
      continue;
    }
    out.push({ ...item, patch: { ...item.patch } });
  }
  return out;
}

/**
 * Spaces are painted large in the overlay but not queued as fontSize commits.
 * Without expanding the range, the separator before the residual word stays
 * small (` nt` at 10pt after `yfuyct fdu` at 16pt) so glyphs look glued and
 * users mash Space.
 */
function expandFontSizePatchesThroughSpaces<T extends { start: number; end: number; patch: Partial<TextStyleUI> }>(
  queued: T[],
  commitText: string,
): T[] {
  return queued.map(item => {
    if (item.patch.fontSize == null) return item;
    let s = item.start;
    let e = item.end;
    // Include at most one separator space (+ trailing punct). Absorbing a
    // whole space-river into the enlarged mid inflates TJ width and can
    // orphan the trailing clause onto another flow line.
    while (s > 0 && /[.,;:!?…]/.test(commitText[s - 1]!)) s--;
    if (s > 0 && commitText[s - 1] === ' ') s--;
    while (e < commitText.length && /[.,;:!?…]/.test(commitText[e]!)) e++;
    if (e < commitText.length && commitText[e] === ' ') e++;
    if (s === item.start && e === item.end) return item;
    return { ...item, start: s, end: e };
  });
}

type EditStyleOverride = {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
};

/** Map sidebar font names to a CSS font-family stack for the edit overlay. */
function cssFontFamilyFromUI(name: string): string {
  const n = name.trim();
  if (!n) return 'Helvetica, Arial, sans-serif';
  const lower = n.toLowerCase();
  if (lower === 'helvetica') return 'Helvetica, Arial, sans-serif';
  if (lower === 'times-roman' || lower === 'times') return '"Times New Roman", Times, serif';
  if (lower === 'courier') return '"Courier New", Courier, monospace';
  if (lower.includes('mono') || lower.includes('consolas') || lower.includes('courier')) {
    return `"${n}", "Courier New", monospace`;
  }
  if (lower.includes('serif') || lower.includes('times') || lower.includes('georgia') || lower.includes('garamond') || lower.includes('palatino') || lower.includes('cambria')) {
    return `"${n}", "Times New Roman", serif`;
  }
  return `"${n}", Helvetica, Arial, sans-serif`;
}

// ─── Component ──────────────────────────────────────────────────────────────


const LINK_NEEDS_SELECTION = 'Select the text you want to link first, then choose Add Link to Selection.';

/** Style a new text box starts with. */
const DEFAULT_TEXT_STYLE = { fontFamily: 'Helvetica', fontSize: 12, color: '#000000' } as const;

export default function EditorPage() {
  const router = useRouter();

  // ── Core state ──
  const [doc, setDoc] = useState<PDFDocumentData | null>(null);
  const [fileName, setFileName] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isVerifyingPassword, setIsVerifyingPassword] = useState(false);
  const pendingEncryptedDocRef = useRef<PDFDocumentData | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [thumbnailKey, setThumbnailKey] = useState(0);
  const [isGeneratingThumbnails, setIsGeneratingThumbnails] = useState(false);

  const [activeTool, setActiveTool] = useState<EditorTool>('text');
  /** Redaction marks placed on the current page and not applied yet. */
  const [redactionMarkCount, setRedactionMarkCount] = useState(0);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const isMobile = useIsMobile();
  const [showMobileThumbnails, setShowMobileThumbnails] = useState(false);
  const [selectedLine, setSelectedLine] = useState<TextLine | null>(null);
  const [editingLineState, setEditingLineState] = useState<TextLine | null>(null);
  const editingLineRef = useRef<TextLine | null>(null);
  const editingLine = editingLineState;
  const setEditingLine = useCallback((line: TextLine | null | ((prev: TextLine | null) => TextLine | null)) => {
    if (typeof line === 'function') {
      setEditingLineState((prev: TextLine | null) => {
        const next = line(prev);
        editingLineRef.current = next;
        return next;
      });
    } else {
      editingLineRef.current = line;
      setEditingLineState(line);
    }
  }, []);
  const initialRunTextRef = useRef<string>('');
  const editAnchorLineRef = useRef<TextLine | null>(null);
  /** Render-safe mirror of editAnchorLineRef (refs must not be read during render). */
  const [editAnchorLine, setEditAnchorLineState] = useState<TextLine | null>(null);
  const setEditAnchorLine = useCallback((line: TextLine | null) => {
    editAnchorLineRef.current = line;
    setEditAnchorLineState(line);
  }, []);
  /** Pending style patches queued while typing, each with a char range. */
  const pendingStylesRef = useRef<Array<{ patch: Partial<TextStyleUI>; start: number; end: number }>>([]);
  /** Word-like typing style: applies to newly typed chars when caret is collapsed. */
  const typingStyleRef = useRef<Partial<Pick<TextStyleUI, 'bold' | 'italic' | 'underline' | 'color' | 'fontSize' | 'fontFamily'>>>({});
  /** True while the pointer is over the link popover (keeps hover open). */
  const linkPopoverHoverRef = useRef(false);
  const editTextRef = useRef('');
  const [editText, setEditText] = useState('');
  const [caretPos, setCaretPos] = useState(0); // character index for caret
  const editSelRef = useRef({ start: 0, end: 0 });
  const [editSel, setEditSel] = useState({ start: 0, end: 0 });
  /** Live style overrides for the edit overlay (selection-scoped). */
  const [editStyleOverrides, setEditStyleOverrides] = useState<EditStyleOverride[]>([]);
  /** CSS-pixel offset of the edit box from its natural position. */
  const [editOffsetCss, setEditOffsetCss] = useState({ x: 0, y: 0 });
  /** Manual size override in CSS px (null = auto-grow from content). */
  const [editManualSize, setEditManualSize] = useState<{ w: number | null; h: number | null }>({ w: null, h: null });
  const [isSaving, setIsSaving] = useState(false);
  const [renderKey, setRenderKey] = useState(0);

  // Bloom Engine — Word-like page model (source of truth for text editing)
  const [bloomPage, setBloomPage] = useState<BloomPage | null>(null);
  const bloomPageRef = useRef<BloomPage | null>(null);
  const editingBlockIdRef = useRef<string | null>(null);
  const setBloomPageBoth = useCallback((page: BloomPage | null) => {
    bloomPageRef.current = page;
    setBloomPage(page);
  }, []);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawnPaths, setDrawnPaths] = useState<DrawnPath[]>([]);
  /** Drawing picked with the Select tool: an unsaved stroke or a saved markup annotation (BE-307). */
  const [selectedDrawing, setSelectedDrawing] = useState<
    | { kind: 'overlay'; id: string }
    | { kind: 'annot'; refKey: string; rect: { x: number; y: number; width: number; height: number } }
    | null
  >(null);
  const [drawMode, setDrawMode] = useState<DrawMode>('freehand');
  const currentDrawPath = useRef<{ x: number; y: number }[]>([]);
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  const shapeEndRef = useRef<{ x: number; y: number } | null>(null);
  /** True after a freehand highlight/draw stroke so click doesn't also add a PDF annotation. */
  const skipNextHighlightClickRef = useRef(false);
  /** True once the pointer moved enough during highlight/draw to count as a drag. */
  const drawDraggedRef = useRef(false);
  /** Last eraser sample point — used to interpolate when the pointer jumps. */
  const lastErasePosRef = useRef<{ x: number; y: number } | null>(null);
  /** True if the current erase gesture removed anything (for one undo step). */
  const eraseChangedRef = useRef(false);
  const [pageLinks, setPageLinks] = useState<import('@/engine').PageLinkInfo[]>([]);
  const [selectedLink, setSelectedLink] = useState<import('@/engine').PageLinkInfo | null>(null);
  const [linkDraftUrl, setLinkDraftUrl] = useState('');
  const [linkDisplayDraft, setLinkDisplayDraft] = useState('');
  /** Only after "Scan for links" — highlights + hover popovers on the PDF. */
  const [linksHighlighted, setLinksHighlighted] = useState(false);
  const [linkPopoverMode, setLinkPopoverMode] = useState<LinkPopoverMode | null>(null);
  const linkHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pending "add link" flow: waiting for URL in the text sidebar. */
  const [linkCreatePending, setLinkCreatePending] = useState(false);


  const [floatingTexts, setFloatingTexts] = useState<FloatingText[]>([]);
  const [activeFloatingTextId, setActiveFloatingTextId] = useState<string | null>(null);

  const [floatingImages, setFloatingImages] = useState<FloatingImage[]>([]);
  const [activeFloatingImageId, setActiveFloatingImageId] = useState<string | null>(null);
  const replacingImageIdRef = useRef<string | null>(null);
  /** When set, next file pick replaces this embedded PDF image in-place. */
  const replacingEmbeddedImageRef = useRef<ImageItem | null>(null);

  /** Removed / deleted images bin for instant restoration */
  const [removedImages, setRemovedImages] = useState<RemovedImageRecord[]>([]);
  const removedImagesRef = useRef<RemovedImageRecord[]>([]);

  const dragInfo = useRef<{ id: string; type: 'text' | 'image'; startX: number; startY: number; startPdfX: number; startPdfY: number } | null>(null);

  /** Viewport grab-to-pan while zoomed (or Space held). */
  const [isPanning, setIsPanning] = useState(false);
  const [spacePanHeld, setSpacePanHeld] = useState(false);
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);

  // Tool properties
  const [drawColor, setDrawColor] = useState('#ff3b30');
  const [drawSize, setDrawSize] = useState(2);
  const [highlightColor, setHighlightColor] = useState('#fffb00');
  const [highlightSize, setHighlightSize] = useState(16);
  const [eraserSize, setEraserSize] = useState(20);

  // Watermark tool properties
  const [watermarkType, setWatermarkType] = useState<'text' | 'image' | 'shape'>('text');
  const [watermarkShapeType, setWatermarkShapeType] = useState<'rectangle' | 'circle' | 'pill'>('circle');
  const [watermarkShapeColor, setWatermarkShapeColor] = useState('#000000');
  const [watermarkText, setWatermarkText] = useState('Bloom PDF');
  const [watermarkFontName, setWatermarkFontName] = useState('Arial');
  const [watermarkOpacity, setWatermarkOpacity] = useState(50);
  const [watermarkRotation, setWatermarkRotation] = useState(45);
  const [watermarkSize, setWatermarkSize] = useState(50);
  const [watermarkPosition, setWatermarkPosition] = useState<WatermarkPosition>('center');
  const [watermarkMosaic, setWatermarkMosaic] = useState(false);
  const [watermarkLivePreview, setWatermarkLivePreview] = useState(true);
  const [showApplySuccessModal, setShowApplySuccessModal] = useState(false);
  const [watermarkPageFrom, setWatermarkPageFrom] = useState(1);
  const [watermarkPageTo, setWatermarkPageTo] = useState(1);
  // Watermark the whole document by default (the range follows the page count).
  const [watermarkRangeTotal, setWatermarkRangeTotal] = useState(totalPages);
  if (watermarkRangeTotal !== totalPages) {
    setWatermarkRangeTotal(totalPages);
    setWatermarkPageFrom(1);
    setWatermarkPageTo(Math.max(1, totalPages));
  }
  const [watermarkLayer, setWatermarkLayer] = useState<'above' | 'below'>('above');
  const [watermarkColor, setWatermarkColor] = useState('#000000');
  const [watermarkImageFile, setWatermarkImageFile] = useState<File | null>(null);
  const [watermarkImageBytes, setWatermarkImageBytes] = useState<Uint8Array | null>(null);
  const [watermarkImageDims, setWatermarkImageDims] = useState<{ width: number; height: number } | null>(null);
  const [watermarkBlendMode, setWatermarkBlendMode] = useState('Normal');

  const [detectedWatermarks, setDetectedWatermarks] = useState<DetectedWatermark[] | null>(null);
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false);

  // Display items (images/paths) for selection overlays
  const [displayItems, setDisplayItems] = useState<(ImageItem | PathItem)[]>([]);
  /** Thin stroke paths (underlines) excluded from selection but needed for edit overlay. */
  const [strokePaths, setStrokePaths] = useState<PathItem[]>([]);
  const [selectedDisplayItem, setSelectedDisplayItem] = useState<ImageItem | PathItem | null>(null);
  const spatialIndexRef = useRef<QuadTree<SelectableItem> | null>(null);

  // AcroForm fields on current page
  const [formFields, setFormFields] = useState<AcroFormWidget[]>([]);
  const [selectedFormField, setSelectedFormField] = useState<AcroFormWidget | null>(null);
  const [formFieldDraft, setFormFieldDraft] = useState('');
  /** Auto-detected PDF tables (grid of text cells). */
  const [detectedTables, setDetectedTables] = useState<DetectedTable[]>([]);
  const [activeTableId, setActiveTableId] = useState<string | null>(null);

  // Unified undo/redo (content + annotations + overlays)
  const historyRef = useRef(new EditorHistory());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const undoSnapshotRef = useRef<{ pageIndex: number; contentBytes: Uint8Array } | null>(null);

  const drawnPathsRef = useRef<DrawnPath[]>([]);
  const floatingTextsRef = useRef<FloatingText[]>([]);
  const floatingImagesRef = useRef<FloatingImage[]>([]);
  const signaturesRef = useRef<VisualSignature[]>([]);
  const committingPromiseRef = useRef<Promise<void> | null>(null);

  const syncTxState = useCallback(() => {
    setCanUndo(historyRef.current.canUndo());
    setCanRedo(historyRef.current.canRedo());
  }, []);

  const [textFontFamily, setTextFontFamily] = useState<string>(DEFAULT_TEXT_STYLE.fontFamily);
  const [textFontSize, setTextFontSize] = useState<number>(DEFAULT_TEXT_STYLE.fontSize);
  const [textColor, setTextColor] = useState<string>(DEFAULT_TEXT_STYLE.color);
  /** Floating text box that should take keyboard focus once it mounts. */
  const focusFloatingTextIdRef = useRef<string | null>(null);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [textUnderline, setTextUnderline] = useState(false);
  const [textAlign, setTextAlign] = useState<'left' | 'center' | 'right'>('left');
  const [saveMode, setSaveMode] = useState<'quick' | 'optimized'>('optimized');
  const [isDirty, setIsDirtyState] = useState(false);
  /**
   * True right after a digital signature (or LTV) is written: doc.rawBytes is
   * then the complete signed file, so a download must hand those bytes back
   * untouched — re-serializing would invalidate the signature.
   */
  const signedPristineRef = useRef(false);
  const setIsDirty = useCallback((dirty: boolean) => {
    if (dirty) signedPristineRef.current = false;
    setIsDirtyState(dirty);
  }, []);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState<number>(0);
  const [searchBusy, setSearchBusy] = useState(false);
  const [showExportPanel, setShowExportPanel] = useState(false);

  // Visual signatures (Phases 1–3) — overlay only, no PDF write
  const [signatures, setSignatures] = useState<VisualSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const [signatureLibraryEntries, setSignatureLibraryEntries] = useState<SignatureLibraryEntry[]>([]);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [signatureCreateOpen, setSignatureCreateOpen] = useState(false);
  const [pdfSignatureFields, setPdfSignatureFields] = useState<SignatureField[]>([]);
  const [selectedPdfSigFieldId, setSelectedPdfSigFieldId] = useState<string | null>(null);
  const [certificateImportOpen, setCertificateImportOpen] = useState(false);
  const [certificateIdentities, setCertificateIdentities] = useState<ManagedIdentity[]>([]);
  const [selectedCertificateId, setSelectedCertificateId] = useState<string | null>(null);
  const [cryptoSignBusy, setCryptoSignBusy] = useState(false);
  const [enableTimestamp, setEnableTimestamp] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [ltvStatus, setLtvStatus] = useState<LtvStatus | null>(null);
  const [managedSignatures, setManagedSignatures] = useState<ManagedSignature[]>([]);
  const [revisionEntries, setRevisionEntries] = useState<RevisionViewEntry[]>([]);

  // Mirror overlay state into refs for event handlers and async callbacks.
  // Runs after every commit (before paint, ahead of the passive effects), so
  // handlers always see the committed values without writing refs during render.
  useLayoutEffect(() => {
    removedImagesRef.current = removedImages;
    drawnPathsRef.current = drawnPaths;
    floatingTextsRef.current = floatingTexts;
    floatingImagesRef.current = floatingImages;
    signaturesRef.current = signatures;
  });

  const refreshSignatureLibrary = useCallback(() => {
    setSignatureLibraryEntries(orderLibraryByRecent(getSignatureLibrary().list()));
  }, []);

  // Auto-close properties panel when the layout switches to mobile
  const [panelLayoutIsMobile, setPanelLayoutIsMobile] = useState(isMobile);
  if (panelLayoutIsMobile !== isMobile) {
    setPanelLayoutIsMobile(isMobile);
    if (isMobile) setIsPanelOpen(false);
  }

  useEffect(() => {
    // The library lives in localStorage, which is only readable in the browser,
    // so it is loaded after mount to keep the prerendered HTML hydration-safe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshSignatureLibrary();
  }, [refreshSignatureLibrary]);

  // ── Refs (declared early for hooks that need them) ──
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const hiddenInputRef = useRef<HTMLTextAreaElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineRef = useRef<typeof import('@/engine') | null>(null);
  const [engineModule, setEngineModule] = useState<typeof import('@/engine') | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const pushEditorHistory = useCallback((
    label: string,
    overlayOverride?: {
      drawnPaths?: DrawnPath[];
      floatingTexts?: FloatingText[];
      floatingImages?: FloatingImage[];
      signatures?: VisualSignature[];
    },
    pageIndexOverride?: number,
    batchId?: string,
  ) => {
    if (!doc || !engineRef.current) return;
    const pageIndex = pageIndexOverride ?? currentPage;
    const page = doc.pages[pageIndex];
    if (!page) return;
    const bytes = engineRef.current.getPageContentBytes(page, doc.objects);
    const entry = captureHistoryEntry(
      doc,
      pageIndex,
      bytes,
      {
        drawnPaths: overlayOverride?.drawnPaths ?? drawnPathsRef.current,
        floatingTexts: overlayOverride?.floatingTexts ?? floatingTextsRef.current,
        floatingImages: overlayOverride?.floatingImages ?? floatingImagesRef.current,
        signatures: overlayOverride?.signatures ?? signaturesRef.current,
      },
      label,
    );
    if (batchId) entry.batchId = batchId;
    historyRef.current.push(entry);
    syncTxState();
  }, [doc, currentPage, syncTxState]);

  /**
   * History entries are per-page snapshots. Before changing a page other than
   * the one the latest entry describes, record that page's current state so
   * Undo can return to it.
   */
  const ensureHistoryBaseline = useCallback((pageIndex: number) => {
    if (historyRef.current.peek()?.pageIndex === pageIndex) return;
    pushEditorHistory('baseline', undefined, pageIndex);
  }, [pushEditorHistory]);

  /**
   * Updates the placed images and keeps the ref in step. With a label the
   * change is also recorded in the unified history (BE-308); drags record one
   * entry on release via recordFloatingImages instead.
   */
  const updateFloatingImages = useCallback((
    updater: (prev: FloatingImage[]) => FloatingImage[],
    label?: string,
  ) => {
    const next = updater(floatingImagesRef.current);
    floatingImagesRef.current = next;
    setFloatingImages(next);
    if (label) {
      pushEditorHistory(label, { floatingImages: next });
      setIsDirty(true);
    }
    return next;
  }, [pushEditorHistory]);

  const recordFloatingImages = useCallback((label: string) => {
    pushEditorHistory(label, { floatingImages: floatingImagesRef.current });
    setIsDirty(true);
  }, [pushEditorHistory]);

  const [selectedDrawingPage, setSelectedDrawingPage] = useState(currentPage);
  if (selectedDrawingPage !== currentPage) {
    setSelectedDrawingPage(currentPage);
    setSelectedDrawing(null);
  }

  const handleDeleteSelectedDrawing = useCallback(() => {
    if (!selectedDrawing || !doc || !engineRef.current) return;
    if (selectedDrawing.kind === 'overlay') {
      const next = drawnPathsRef.current.filter((p) => p.id !== selectedDrawing.id);
      setDrawnPaths(next);
      drawnPathsRef.current = next;
      pushEditorHistory('delete-drawing', { drawnPaths: next });
    } else {
      const page = doc.pages[currentPage];
      const [num, gen] = selectedDrawing.refKey.split('_').map(Number);
      engineRef.current.removeAnnotationFromPage(page.dict, new PDFRef(num, gen), doc.objects);
      pushEditorHistory('delete-drawing');
      setRenderKey((k) => k + 1);
    }
    setSelectedDrawing(null);
    setIsDirty(true);
  }, [selectedDrawing, doc, currentPage, pushEditorHistory]);

  const pushSignatureSnapshot = useCallback((next: VisualSignature[], label: string) => {
    setSignatures(next);
    signaturesRef.current = next;
    pushEditorHistory(label, { signatures: next });
    setIsDirty(true);
  }, [pushEditorHistory]);

  const applyHistoryEntry = useCallback(async (entry: import('@/engine').EditorHistoryEntry) => {
    if (!doc || !engineRef.current) return;
    const engine = engineRef.current;
    const page = doc.pages[entry.pageIndex];
    if (!page) return;
    await engine.updatePageContent(page.contentRefs, entry.contentBytes, doc.objects);
    restoreAnnotSnapshot(page.dict, doc.objects, entry.annotSnapshot);
    setDrawnPaths(parseOverlaySnapshot<DrawnPath[]>(entry.overlays.drawnPathsJson));
    setFloatingTexts(parseOverlaySnapshot<FloatingText[]>(entry.overlays.floatingTextsJson));
    setFloatingImages(parseOverlaySnapshot<FloatingImage[]>(entry.overlays.floatingImagesJson));
    const sigs = parseOverlaySnapshot<VisualSignature[]>(entry.overlays.signaturesJson);
    setSignatures(sigs);
    signaturesRef.current = sigs;
    setSelectedSignatureId(null);
    if (entry.pageIndex !== currentPage) setCurrentPage(entry.pageIndex);
    syncTxState();
    setRenderKey((k) => k + 1);
  }, [doc, currentPage, syncTxState]);

  const bumpRender = useCallback(() => {
    setIsDirty(true);
    setRenderKey(k => k + 1);
  }, []);

  const getEditSelectionRange = useCallback(() => {
    if (!editingLineRef.current) return null;
    return editSelRef.current;
  }, []);

  const resolveEditStyleRange = useCallback((line: TextLine, start: number, end: number) => {
    const s = Math.max(0, Math.min(start, line.text.length));
    const e = Math.max(s, Math.min(end, line.text.length));
    // Collapsed caret is handled as typing-style (no existing-text restyle).
    if (e <= s) return { start: s, end: s };
    return { start: s, end: e };
  }, []);

  const { applyStyle } = useTextStyleActions(
    engineRef,
    doc,
    currentPage,
    selectedLine,
    bumpRender,
    getEditSelectionRange,
  );

  // Apply style changes from properties sidebar to the PDF
  const queueOrApplyStyle = useCallback((patch: Partial<TextStyleUI>) => {
    if (!selectedLine) return;
    if (editingLineRef.current) {
      let sel = editSelRef.current;
      const line = editAnchorLineRef.current ?? selectedLine;
      // Alignment is a property of the whole line. Other styles also apply to
      // the whole line while nothing is selected and nothing has been typed
      // yet (the user clicked a line and pressed Bold); once they type, a
      // collapsed caret sets the typing style instead, like a word processor.
      const untouched = editTextRef.current === (initialRunTextRef.current || line.text);
      if (sel.end <= sel.start && (patch.align != null || untouched)) {
        sel = { start: 0, end: line.text.length };
      }
      if (sel.end <= sel.start) {
        typingStyleRef.current = {
          ...typingStyleRef.current,
          ...(patch.bold != null ? { bold: patch.bold } : {}),
          ...(patch.italic != null ? { italic: patch.italic } : {}),
          ...(patch.underline != null ? { underline: patch.underline } : {}),
          ...(patch.color != null ? { color: patch.color } : {}),
          ...(patch.fontSize != null ? { fontSize: patch.fontSize } : {}),
          ...(patch.fontFamily != null ? { fontFamily: patch.fontFamily } : {}),
        };
        return;
      }
      // Real selection (drag / double-click word / select-all) → style only that range
      const range = resolveEditStyleRange(line, sel.start, sel.end);
      if (range.end <= range.start) return;
      pendingStylesRef.current = [...pendingStylesRef.current, { patch, ...range }];
      setEditStyleOverrides(prev => [
        ...prev,
        {
          start: range.start,
          end: range.end,
          bold: patch.bold,
          italic: patch.italic,
          underline: patch.underline,
          color: patch.color,
          fontSize: patch.fontSize,
          fontFamily: patch.fontFamily,
        },
      ]);
      return;
    }
    void applyStyle(patch);
  }, [selectedLine, applyStyle, resolveEditStyleRange]);

  const handleEditSelection = useCallback((start: number, end: number) => {
    editSelRef.current = { start, end };
    setEditSel({ start, end });
    setCaretPos(start);
    // A real selection clears typing-style (Word-like)
    if (end > start) typingStyleRef.current = {};

    // Sync sidebar toggles from the run under the caret / selection start
    const line = editAnchorLineRef.current;
    if (!line || !renderResult) return;
    const styleIndex = start > 0 ? start - 1 : 0;
    const currentText = editTextRef.current;
    const initialText = initialRunTextRef.current || line.text;
    const run = runAtDistributedEditIndex(line, initialText, currentText, styleIndex)
      ?? segmentAtIndex(line, Math.min(styleIndex, line.text.length))?.run;
    if (!run) {
      return;
    }
    const flags = resolveRunStyleFlags(run.fontName, renderResult.fonts.get(run.fontName));
    let bold = flags.bold;
    let italic = flags.italic;
    let underline = !!run.isUnderline || runHasPathUnderline(run, strokePaths);
    let fontSize = visualFontSize(run);
    const fontData = renderResult.fonts.get(run.fontName);
    let fontFamily = getDisplayFontFamily(run.fontName, fontData);
    for (const ov of editStyleOverrides) {
      if (start >= ov.start && start < ov.end) {
        if (ov.bold != null) bold = ov.bold;
        if (ov.italic != null) italic = ov.italic;
        if (ov.underline != null) underline = ov.underline;
        if (ov.fontSize != null) fontSize = ov.fontSize;
        if (ov.fontFamily) fontFamily = ov.fontFamily;
        if (ov.color) setTextColor(ov.color.startsWith('#') ? ov.color : textColor);
      }
    }
    // Collapsed caret: typing style wins (user just toggled bold off to type normal)
    if (start === end) {
      const ts = typingStyleRef.current;
      if (ts.bold != null) bold = ts.bold;
      if (ts.italic != null) italic = ts.italic;
      if (ts.underline != null) underline = ts.underline;
      if (ts.fontSize != null) fontSize = ts.fontSize;
      if (ts.fontFamily) fontFamily = ts.fontFamily;
      if (ts.color) setTextColor(ts.color);
    }
    setTextBold(bold);
    setTextItalic(italic);
    setTextUnderline(underline);
    setTextFontSize(fontSize);
    setTextFontFamily(fontFamily);
    if (!(start === end && typingStyleRef.current.color != null) && run.fillColor) {
      const hasColorOv = editStyleOverrides.some(
        ov => start >= ov.start && start < ov.end && ov.color,
      );
      if (!hasColorOv) {
        const [r, g, b] = run.fillColor;
        const hex = '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
        setTextColor(hex);
      }
    }
  }, [renderResult, strokePaths, editStyleOverrides, textFontFamily, textColor, textBold]);

  const handleTextBold = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTextBold(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      queueOrApplyStyle({ bold: next });
      return next;
    });
  }, [queueOrApplyStyle]);
  const handleTextItalic = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTextItalic(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      queueOrApplyStyle({ italic: next });
      return next;
    });
  }, [queueOrApplyStyle]);
  const handleTextUnderline = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTextUnderline(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      queueOrApplyStyle({ underline: next });
      return next;
    });
  }, [queueOrApplyStyle]);
  const handleTextFontSize = useCallback((v: number | ((prev: number) => number)) => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setTextFontSize(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      queueOrApplyStyle({ fontSize: next });
      return next;
    });
    // Keep the edit box focused after clicking a size preset in the sidebar
    requestAnimationFrame(() => {
      hiddenInputRef.current?.focus({ preventScroll: true });
    });
  }, [queueOrApplyStyle]);
  const handleTextFontFamily = useCallback((v: string) => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setTextFontFamily(v);
    queueOrApplyStyle({ fontFamily: v });
    requestAnimationFrame(() => {
      hiddenInputRef.current?.focus({ preventScroll: true });
    });
  }, [queueOrApplyStyle]);
  const handleTextColor = useCallback((v: string) => {
    setTextColor(v);
    queueOrApplyStyle({ color: v });
  }, [queueOrApplyStyle]);
  const handleTextAlign = useCallback((v: 'left' | 'center' | 'right') => {
    setTextAlign(v);
    queueOrApplyStyle({ align: v });
  }, [queueOrApplyStyle]);

  // Warn before leaving with unsaved edits
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Debounced IndexedDB session autosave (PDF bytes + overlay JSON)
  useEffect(() => {
    if (!isDirty || !doc || !engineRef.current || isLoading) return;
    const engine = engineRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const bytes = await engine.saveDocument(doc, 'quick');
          const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          await saveEditorSession({
            bytes: copy,
            fileName,
            updatedAt: Date.now(),
            overlays: {
              drawnPathsJson: JSON.stringify(drawnPathsRef.current),
              floatingTextsJson: JSON.stringify(floatingTextsRef.current),
              floatingImagesJson: JSON.stringify(floatingImagesRef.current),
              signaturesJson: JSON.stringify(signaturesRef.current),
              removedImagesJson: JSON.stringify(removedImagesRef.current),
              currentPage,
            },
          });
          await saveRemovedImages(removedImagesRef.current);
        } catch (e) {
          console.warn('[Editor] Session autosave failed:', e);
        }
      })();
    }, 2500);
    return () => clearTimeout(timer);
  }, [isDirty, doc, fileName, currentPage, isLoading, drawnPaths, floatingTexts, floatingImages, signatures, removedImages, renderKey]);

  // Caret blinking
  const caretVisibleRef = useRef(true);
  const caretTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load engine and PDF ──
  useEffect(() => {
    let cancelled = false;

    async function finishLoad(
      parsed: PDFDocumentData,
      engine: NonNullable<typeof engineRef.current>,
      opts?: {
        pageIndex?: number;
        overlays?: {
          drawnPaths: DrawnPath[];
          floatingTexts: FloatingText[];
          floatingImages: FloatingImage[];
          signatures: VisualSignature[];
        };
        dirty?: boolean;
      },
    ) {
      const pageIndex = Math.max(0, Math.min(opts?.pageIndex ?? 0, parsed.pages.length - 1));
      const overlays = opts?.overlays ?? {
        drawnPaths: [],
        floatingTexts: [],
        floatingImages: [],
        signatures: [],
      };
      setDoc(parsed);
      setTotalPages(parsed.pages.length);
      setCurrentPage(pageIndex);
      setDrawnPaths(overlays.drawnPaths);
      drawnPathsRef.current = overlays.drawnPaths;
      setFloatingTexts(overlays.floatingTexts);
      floatingTextsRef.current = overlays.floatingTexts;
      setFloatingImages(overlays.floatingImages);
      floatingImagesRef.current = overlays.floatingImages;
      setSignatures(overlays.signatures);
      signaturesRef.current = overlays.signatures;
      const page = parsed.pages[pageIndex];
      const initialBytes = engine.getPageContentBytes(page, parsed.objects);
      historyRef.current.seed(captureHistoryEntry(
        parsed,
        pageIndex,
        initialBytes,
        overlays,
        'initial',
      ));
      syncTxState();
      setIsDirty(!!opts?.dirty);
      setNeedsPassword(false);
      setPasswordError(null);
      pendingEncryptedDocRef.current = null;
      setIsLoading(false);
    }

    async function init() {
      let openedBytes: Uint8Array | undefined;
      try {
        const stored = await loadPdfFromStorage();
        if (stored) openedBytes = new Uint8Array(stored.bytes);
        if (!stored) { router.push('/'); return; }
        if (cancelled) return;

        const engine = await import('@/engine');
        engineRef.current = engine;
        setEngineModule(engine);

        // Prefer dirty session recovery ONLY when it matches the current document file name
        const session = await loadEditorSession();
        if (session && session.bytes?.byteLength && session.fileName === stored.fileName) {
          try {
            setFileName(session.fileName || stored.fileName);
            if (session.overlays?.removedImagesJson) {
              try {
                const sessionRemoved = parseOverlaySnapshot<RemovedImageRecord[]>(session.overlays.removedImagesJson);
                if (sessionRemoved && Array.isArray(sessionRemoved) && sessionRemoved.length > 0) {
                  setRemovedImages(sessionRemoved);
                  removedImagesRef.current = sessionRemoved;
                }
              } catch {}
            }
            const parsed = await engine.parsePDF(new Uint8Array(session.bytes));
            if (cancelled) return;
            if (!engine.securityEngine.isEncrypted(parsed)) {
              await finishLoad(parsed, engine, {
                pageIndex: session.overlays?.currentPage ?? 0,
                overlays: {
                  drawnPaths: parseOverlaySnapshot(session.overlays?.drawnPathsJson || '[]'),
                  floatingTexts: parseOverlaySnapshot(session.overlays?.floatingTextsJson || '[]'),
                  floatingImages: parseOverlaySnapshot(session.overlays?.floatingImagesJson || '[]'),
                  signatures: parseOverlaySnapshot(session.overlays?.signaturesJson || '[]'),
                },
                dirty: true,
              });
              return;
            }
          } catch (sessErr) {
            console.warn('[Editor] Session restore failed, falling back to upload:', sessErr);
          }
        }

        // Fresh PDF load — clear previous session, removed images, and overlays
        await clearEditorSession();
        await clearRemovedImages();
        setRemovedImages([]);
        removedImagesRef.current = [];
        setDrawnPaths([]);
        drawnPathsRef.current = [];
        setFloatingTexts([]);
        floatingTextsRef.current = [];
        setFloatingImages([]);
        floatingImagesRef.current = [];
        setSignatures([]);
        signaturesRef.current = [];

        setFileName(stored.fileName);
        const pdfBytes = new Uint8Array(stored.bytes);
        const parsed = await engine.parsePDF(pdfBytes);
        if (cancelled) return;

        if (engine.securityEngine.isEncrypted(parsed)) {
          // Try empty password first (common for owner-only protection)
          try {
            const opened = await engine.securityEngine.open(parsed, '');
            if (cancelled) return;
            await finishLoad(opened.doc, engine);
            return;
          } catch {
            pendingEncryptedDocRef.current = parsed;
            setNeedsPassword(true);
            setIsLoading(false);
            return;
          }
        }

        await finishLoad(parsed, engine);
      } catch (e) {
        if (cancelled) return;
        console.error('[Editor] Init failed:', e);
        setError(friendlyPdfError(e, openedBytes));
        setIsLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [router]);

  const handlePasswordSubmit = useCallback(async (password: string) => {
    const engine = engineRef.current;
    const pending = pendingEncryptedDocRef.current;
    if (!engine || !pending) return;

    setIsVerifyingPassword(true);
    setPasswordError(null);
    try {
      const opened = await engine.securityEngine.open(pending, password);
      setDoc(opened.doc);
      setTotalPages(opened.doc.pages.length);
      setCurrentPage(0);
      const page0 = opened.doc.pages[0];
      const initialBytes = engine.getPageContentBytes(page0, opened.doc.objects);
      historyRef.current.seed(captureHistoryEntry(
        opened.doc,
        0,
        initialBytes,
        { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] },
        'initial',
      ));
      syncTxState();
      setNeedsPassword(false);
      pendingEncryptedDocRef.current = null;
    } catch (e) {
      setPasswordError(e instanceof Error ? e.message : 'Incorrect password');
    } finally {
      setIsVerifyingPassword(false);
    }
  }, []);

  // ── Generate thumbnails ──
  useEffect(() => {
    if (!doc || !engineRef.current) return;
    let cancelled = false;

    async function generateThumbnails() {
      setIsGeneratingThumbnails(true);
      const engine = engineRef.current!;
      const thumbs: string[] = [];

      try {
        for (let i = 0; i < doc!.pages.length; i++) {
          if (cancelled) break;
          // Render at 15% scale for a quick thumbnail
          const res = await engine.renderPage(doc!, i, { scale: 0.15, renderText: true, renderPaths: true, renderImages: true });
          if (cancelled) break;
          thumbs.push(res.canvas.toDataURL('image/jpeg', 0.6));
        }
        if (!cancelled) setThumbnails(thumbs);
      } catch (e) {
        console.error('[Editor] Thumbnail generation failed:', e);
      } finally {
        if (!cancelled) setIsGeneratingThumbnails(false);
      }
    }

    generateThumbnails();
    return () => {
      // A superseded run must not leave the spinner on (e.g. when a restored
      // session swaps the document while thumbnails are still rendering).
      cancelled = true;
      setIsGeneratingThumbnails(false);
    };
  }, [doc, thumbnailKey]);

  // Reset edit state when doc or page changes. Both change from many places
  // (load, navigation, page operations), and the reset also clears refs
  // (editingLineRef via setEditingLine, spatialIndexRef), which must not be
  // written during render, so this stays an effect.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on doc/page change, see above */
    setEditingLine(null);
    setSelectedLine(null);
    setEditText('');
    setSelectedDisplayItem(null);
    setDisplayItems([]);
    setRedactionMarkCount(0);
    /* eslint-enable react-hooks/set-state-in-effect */
    spatialIndexRef.current = null;
  }, [doc, currentPage, setEditingLine]);

  // Sync text properties sidebar from selected line (use FontData BaseFont when available).
  // Adjusted during render when the selection (or its fonts) changes, not in an effect.
  const [styleSyncSource, setStyleSyncSource] = useState({ selectedLine, renderResult });
  if (styleSyncSource.selectedLine !== selectedLine || styleSyncSource.renderResult !== renderResult) {
    setStyleSyncSource({ selectedLine, renderResult });
    if (selectedLine && selectedLine.runs.length > 0) {
      const run = selectedLine.runs[0];
      // Keep fractional size so overlay matches canvas (rounding caused a visible jump)
      setTextFontSize(visualFontSize(run));
      const fontData = renderResult?.fonts.get(run.fontName);
      setTextFontFamily(getDisplayFontFamily(run.fontName, fontData));
      const flags = resolveRunStyleFlags(run.fontName, fontData);
      setTextBold(flags.bold);
      setTextItalic(flags.italic);
      setTextUnderline(!!run.isUnderline);
      if (run.fillColor) {
        const [r, g, b] = run.fillColor;
        const hex = '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
        setTextColor(hex);
      }
    }
  }

  // ── Render current page ──
  useEffect(() => {
    if (!doc || !engineRef.current) return;
    let cancelled = false;

    async function render() {
      setIsRendering(true);
      try {
        const engine = engineRef.current!;
        const result = await engine.renderPage(doc!, currentPage, { scale });
        if (cancelled) return;
        setRenderResult(result);

        // Extract display items (images, significant paths) for bounding box overlays
        try {
          const pageData = doc!.pages[currentPage];
          const cBytes = engine.getPageContentBytes(pageData, doc!.objects);
          const interpreted = engine.interpretPage(cBytes, pageData, doc!.objects);
          const pageBounds = {
            x: pageData.mediaBox.x,
            y: pageData.mediaBox.y,
            width: pageData.mediaBox.width,
            height: pageData.mediaBox.height,
          };
          // Skip full-page background fills (0 0 612 792 re f) — they steal every click
          const visItems = interpreted.displayList.filter(
            (di: DisplayItem) => isSelectableDisplayItem(di, pageBounds),
          );
          // Keep thin strokes (form-label underlines) for edit-overlay decoration
          const thinStrokes = interpreted.displayList.filter((di: DisplayItem) => {
            if (di.type !== 'path') return false;
            const p = di as PathItem;
            if (p.paintType !== 'stroke' && p.paintType !== 'both') return false;
            // Horizontal underline: short height, meaningful width
            return (p.height || 0) <= 8 && (p.width || 0) >= 10;
          }) as PathItem[];
          if (!cancelled) setDisplayItems(visItems as (ImageItem | PathItem)[]);
          if (!cancelled) setStrokePaths(thinStrokes);
          if (!cancelled) {
            try {
              const lines = result.documentFlow?.lines ?? result.textLines ?? [];
              const allPaths = interpreted.displayList.filter(
                (di: DisplayItem) => di.type === 'path',
              ) as PathItem[];
              const tables = engine.detectTablesOnPage(lines, [...thinStrokes, ...allPaths]);
              setDetectedTables(tables);
            } catch (tblErr) {
              console.warn('[Editor] Table detect failed:', tblErr);
              setDetectedTables([]);
            }
          }
          if (!cancelled && doc) {
            try {
              setPageLinks(engine.listPageLinks(doc!, currentPage));
            } catch {
              setPageLinks([]);
            }
          }
          if (!cancelled) {
            spatialIndexRef.current = buildDisplayListIndex(
              visItems as DisplayItem[],
              pageBounds,
            );
          }

          // Bloom ingest — skip re-ingest while mid-edit with dirty in-memory page
          if (!cancelled && !(editingBlockIdRef.current && bloomPageRef.current?.dirty)) {
            const flow = result.documentFlow ?? engine.buildDocumentFlow(interpreted.textRuns);
            const ingested = engine.ingestPage(interpreted.textRuns, {
              pageIndex: currentPage,
              width: pageData.mediaBox.width,
              height: pageData.mediaBox.height,
              flow,
              displayList: interpreted.displayList,
            });
            setBloomPageBoth(ingested);
          }
        } catch (dispErr) {
          console.warn('[Editor] Display items extraction failed:', dispErr);
          if (!cancelled) setDisplayItems([]);
          if (!cancelled) setStrokePaths([]);
          if (!cancelled) spatialIndexRef.current = null;
        }

        try {
          const fields = engine.detectFormFieldsOnPage(doc!, currentPage);
          if (!cancelled) {
            setFormFields(fields);
            if (selectedFormField) {
              const still = fields.find(f => f.ref.toKey() === selectedFormField.ref.toKey());
              setSelectedFormField(still ?? null);
              setFormFieldDraft(still && typeof still.value === 'string' ? still.value : '');
            }
          }
        } catch {
          if (!cancelled) setFormFields([]);
        }

        try {
          const sigFields = detectSignatureFieldsOnPage(doc!, currentPage);
          if (!cancelled) {
            setPdfSignatureFields(sigFields);
            if (selectedPdfSigFieldId) {
              const still = sigFields.find((f) => f.id === selectedPdfSigFieldId);
              if (!still) setSelectedPdfSigFieldId(null);
            }
          }
        } catch {
          if (!cancelled) setPdfSignatureFields([]);
        }

        // Re-sync editing line only when not in overlay preview mode
        if (editingLineRef.current && !editAnchorLineRef.current) {
          const oldLine = editingLineRef.current;
          const newLine = result.textLines.find((l: TextLine) =>
            l.id === oldLine.id ||
            (Math.abs(l.baseline - oldLine.baseline) < 5 && Math.abs(l.x - oldLine.x) < 30)
          );
          if (newLine) {
            setEditingLine(newLine);
            setSelectedLine(newLine);
          } else {
            setEditingLine(null);
            setSelectedLine(null);
          }
        }

        // Mount canvas
        if (canvasContainerRef.current) {
          const wrapper = canvasContainerRef.current;
          // Remove old PDF canvas
          const oldCanvas = wrapper.querySelector('canvas.pdf-canvas');
          if (oldCanvas) oldCanvas.remove();

          result.canvas.className = 'pdf-canvas';
          result.canvas.style.display = 'block';
          result.canvas.style.position = 'relative';
          result.canvas.style.zIndex = '1';
          pdfCanvasRef.current = result.canvas;
          wrapper.prepend(result.canvas);

          // Size the overlay canvas to match
          const overlay = overlayRef.current;
          if (overlay) {
            const dpr = window.devicePixelRatio || 1;
            overlay.width = result.canvas.width;
            overlay.height = result.canvas.height;
            overlay.style.width = result.canvas.style.width;
            overlay.style.height = result.canvas.style.height;
          }
        }
      } catch (e) {
        if (cancelled) return;
        console.error('[Editor] Render failed:', e);
        setError(actionErrorMessage('Couldn\'t display this page', e));
      }
      setIsRendering(false);
    }

    render();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, currentPage, scale, renderKey]);

  // ── Draw overlay (caret, freehand paths) — NO boxes or highlights ──
  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay || !renderResult) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const page = doc?.pages[currentPage];
    if (!page) return;
    const { mediaBox } = page;

    // ── Edit: white-out only the active line (HTML input shows typed text) ──
    // Match EditableLineBox placement: baseline-aligned. Keep descent small so
    // native path underlines under form labels stay visible on the canvas.
    if (editingLine && editAnchorLineRef.current) {
      const anchor = editAnchorLineRef.current;
      const bounds = getLineBounds(anchor);
      let maxFs = anchor.runs[0] ? visualFontSize(anchor.runs[0]) : anchor.fontSize;
      for (const run of anchor.runs) maxFs = Math.max(maxFs, visualFontSize(run));
      for (const ov of editStyleOverrides) {
        if (ov.fontSize != null) maxFs = Math.max(maxFs, ov.fontSize);
      }
      if (typingStyleRef.current.fontSize != null) {
        maxFs = Math.max(maxFs, typingStyleRef.current.fontSize);
      }
      if (editSel.end <= editSel.start && textFontSize > 0) {
        maxFs = Math.max(maxFs, textFontSize);
      }
      const fontSizeCss = maxFs * scale;
      const baseline = anchor.baseline;
      const ascent = fontSizeCss * 0.85;
      // Cover path-drawn underlines too — leaving them visible while the HTML
      // overlay clips CSS underlines made new glyphs look non-underlined.
      const hasUnderline = textUnderline || anchor.runs.some(r =>
        !!r.isUnderline || runHasPathUnderline(r, strokePaths),
      );
      const descent = fontSizeCss * (hasUnderline ? 0.45 : 0.25);

      ctx.save();
      ctx.scale(dpr, dpr);

      const leftPt = pdfToCanvas(
        bounds.x,
        baseline,
        scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
      );
      // Cover the original line being edited on canvas so it doesn't show behind
      // the HTML edit box. Never expand across other lines, emblems, or columns.
      const origWPdf = bounds.width;
      const textLen = (editText || '').length;
      const origLen = Math.max(1, (anchor.text || '').length);
      const growRatio = textLen > origLen ? textLen / origLen : 1;
      const coverWPdf = Math.max(origWPdf, Math.min(origWPdf * 2.5, origWPdf * growRatio));
      const growW = coverWPdf * scale;
      const rx = leftPt.cssX + editOffsetCss.x;
      const ry = leftPt.cssY - ascent + editOffsetCss.y;
      const rw = editManualSize.w ?? growW;
      const rh = editManualSize.h ?? (ascent + descent);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(rx - 0.5, ry - 0.5, rw + 1, rh + 1);

      // Path underlines only cover original glyph spans — extend a stroke under
      // underlined runs as the line grows so mid-line inserts stay underlined.
      if (hasUnderline) {
        let ulLeft = Infinity;
        let ulRight = -Infinity;
        for (const run of anchor.runs) {
          if (!(run.isUnderline || runHasPathUnderline(run, strokePaths))) continue;
          ulLeft = Math.min(ulLeft, run.x);
          ulRight = Math.max(ulRight, run.x + Math.max(run.width, maxFs * 0.5));
        }
        if (Number.isFinite(ulLeft) && ulRight > ulLeft) {
          const origLen = (initialRunTextRef.current || anchor.text || '').length;
          const grown = Math.max(0, (editText || '').length - origLen);
          const ulWPdf = (ulRight - ulLeft) + grown * maxFs * 0.55;
          const ulOrigin = pdfToCanvas(
            ulLeft,
            baseline,
            scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
          );
          const ulX = ulOrigin.cssX + editOffsetCss.x;
          const ulY = ulOrigin.cssY + editOffsetCss.y + fontSizeCss * 0.12;
          const canvasUlW = ulWPdf * scale;
          ctx.strokeStyle = textColor.startsWith('#') ? textColor : '#000000';
          ctx.lineWidth = Math.max(1, fontSizeCss * 0.06);
          ctx.beginPath();
          ctx.moveTo(ulX, ulY);
          ctx.lineTo(ulX + canvasUlW, ulY);
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    // ── Display item bounding boxes — hide while typing so blue handles don't appear on words ──
    if ((activeTool === 'select' || activeTool === 'text') && displayItems.length > 0 && !editingLine) {
      ctx.save();
      ctx.scale(dpr, dpr);
      // Display items are in unrotated page space; turn the overlay the same
      // way the renderer turns the page so boxes line up on /Rotate pages
      // instead of streaking across them (BE-208).
      const pageRotate = ((doc.pages[currentPage].rotate % 360) + 360) % 360;
      const unrotatedHeight = pageRotate === 90 || pageRotate === 270 ? renderResult.pageWidth : renderResult.pageHeight;
      if (pageRotate === 90) {
        ctx.translate(renderResult.pageWidth * scale, 0);
        ctx.rotate(Math.PI / 2);
      } else if (pageRotate === 180) {
        ctx.translate(renderResult.pageWidth * scale, renderResult.pageHeight * scale);
        ctx.rotate(Math.PI);
      } else if (pageRotate === 270) {
        ctx.translate(0, renderResult.pageHeight * scale);
        ctx.rotate(-Math.PI / 2);
      }

      for (const item of displayItems) {
        const isImage = item.type === 'image';
        const isSelected = selectedDisplayItem === item;

        const topLeft = pdfToCanvas(
          item.x, item.y + item.height,
          scale, unrotatedHeight, mediaBox.x, mediaBox.y,
        );
        const bottomRight = pdfToCanvas(
          item.x + item.width, item.y,
          scale, unrotatedHeight, mediaBox.x, mediaBox.y,
        );

        const boxX = topLeft.cssX;
        const boxY = topLeft.cssY;
        const boxW = bottomRight.cssX - topLeft.cssX;
        const boxH = bottomRight.cssY - topLeft.cssY;

        if (boxW < 3 || boxH < 3) continue;

        if (isSelected) {
          ctx.strokeStyle = isImage ? '#3b82f6' : '#22c55e';
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.fillStyle = isImage ? 'rgba(59,130,246,0.06)' : 'rgba(34,197,94,0.06)';
          ctx.fillRect(boxX, boxY, boxW, boxH);
          ctx.strokeRect(boxX, boxY, boxW, boxH);

          const hs = 7;
          ctx.fillStyle = isImage ? '#3b82f6' : '#22c55e';
          const corners: [number, number][] = [
            [boxX, boxY], [boxX + boxW, boxY],
            [boxX, boxY + boxH], [boxX + boxW, boxY + boxH],
          ];
          for (const [cx, cy] of corners) {
            ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
          }

          ctx.font = '600 11px Inter, system-ui, sans-serif';
          const label = isImage ? 'Image' : 'Drawing / Signature';
          const labelW = ctx.measureText(label).width;
          const badgePad = 6;
          const badgeH = 20;
          const badgeY2 = boxY - badgeH - 4;
          ctx.fillStyle = isImage ? '#3b82f6' : '#22c55e';
          ctx.beginPath();
          ctx.roundRect(boxX, badgeY2, labelW + badgePad * 2, badgeH, 4);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(label, boxX + badgePad, badgeY2 + 14);
        } else {
          ctx.strokeStyle = isImage ? 'rgba(59,130,246,0.4)' : 'rgba(34,197,94,0.3)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(boxX, boxY, boxW, boxH);
          ctx.setLineDash([]);
        }
      }

      ctx.restore();
    }

    // ── Table cell overlays (auto-detected grids) disabled for cleaner UI ──

    // ── AcroForm field overlays (Select + Text tools) ──
    if ((activeTool === 'select' || activeTool === 'text') && formFields.length > 0 && renderResult && !editingLine) {
      ctx.save();
      ctx.scale(dpr, dpr);
      for (const field of formFields) {
        const r = field.rect;
        if (!r) continue;
        const topLeft = pdfToCanvas(
          r.x, r.y + r.height,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const bottomRight = pdfToCanvas(
          r.x + r.width, r.y,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const boxX = topLeft.cssX;
        const boxY = topLeft.cssY;
        const boxW = bottomRight.cssX - topLeft.cssX;
        const boxH = bottomRight.cssY - topLeft.cssY;
        const selected = selectedFormField?.ref.toKey() === field.ref.toKey();
        ctx.strokeStyle = selected ? '#f59e0b' : 'rgba(245,158,11,0.45)';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.setLineDash(selected ? [] : [4, 3]);
        ctx.fillStyle = selected ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.04)';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeRect(boxX, boxY, boxW, boxH);
        ctx.setLineDash([]);
        if (selected || boxH > 14) {
          ctx.font = '600 10px Inter, system-ui, sans-serif';
          ctx.fillStyle = '#f59e0b';
          const label = field.fieldName || field.fieldType;
          ctx.fillText(label, boxX + 3, boxY + 11);
        }
      }
      ctx.restore();
    }

    // ── Link annotation overlays (only after "Scan for links") ──
    if (
      linksHighlighted
      && (activeTool === 'text' || activeTool === 'select' || activeTool === 'addtext')
      && pageLinks.length > 0
      && !editingLine
    ) {
      ctx.save();
      ctx.scale(dpr, dpr);
      for (const link of pageLinks) {
        const topLeft = pdfToCanvas(
          link.rect.x, link.rect.y + link.rect.height,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const bottomRight = pdfToCanvas(
          link.rect.x + link.rect.width, link.rect.y,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const bx = Math.min(topLeft.cssX, bottomRight.cssX);
        const by = Math.min(topLeft.cssY, bottomRight.cssY);
        const bw = Math.abs(bottomRight.cssX - topLeft.cssX);
        const bh = Math.abs(bottomRight.cssY - topLeft.cssY);
        const active = selectedLink?.ref.toKey() === link.ref.toKey();
        ctx.strokeStyle = active ? '#52525b' : 'rgba(37, 99, 235, 0.9)';
        ctx.lineWidth = active ? 2 : 1.5;
        ctx.setLineDash(active ? [] : [4, 3]);
        ctx.fillStyle = active ? 'rgba(63, 63, 70, 0.28)' : 'rgba(37, 99, 235, 0.16)';
        // Rounded highlight for the active/hovered link
        const r = Math.min(6, bw / 2, bh / 2);
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
        ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
        ctx.arcTo(bx, by + bh, bx, by, r);
        ctx.arcTo(bx, by, bx + bw, by, r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // ── Drawing paths / shapes ──
    if (drawnPaths.length > 0) {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.lineJoin = 'round';
      for (const path of drawnPaths) {
        const kind = path.kind ?? 'freehand';
        if (kind !== 'freehand' && path.start && path.end) {
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
          ctx.strokeStyle = path.color;
          ctx.lineWidth = path.size;
          ctx.lineCap = 'round';
          const { start, end } = path;
          if (kind === 'line' || kind === 'arrow') {
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
            if (kind === 'arrow') {
              const angle = Math.atan2(end.y - start.y, end.x - start.x);
              const head = Math.max(path.size * 4, 10);
              ctx.beginPath();
              ctx.moveTo(end.x, end.y);
              ctx.lineTo(end.x - head * Math.cos(angle - 0.4), end.y - head * Math.sin(angle - 0.4));
              ctx.moveTo(end.x, end.y);
              ctx.lineTo(end.x - head * Math.cos(angle + 0.4), end.y - head * Math.sin(angle + 0.4));
              ctx.stroke();
            }
          } else if (kind === 'rectangle') {
            ctx.strokeRect(
              Math.min(start.x, end.x),
              Math.min(start.y, end.y),
              Math.abs(end.x - start.x),
              Math.abs(end.y - start.y),
            );
          } else if (kind === 'ellipse') {
            const cx = (start.x + end.x) / 2;
            const cy = (start.y + end.y) / 2;
            const rx = Math.abs(end.x - start.x) / 2;
            const ry = Math.abs(end.y - start.y) / 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          continue;
        }

        if (path.points.length < 2) continue;

        ctx.beginPath();
        if (path.type === 'highlight') {
          ctx.globalCompositeOperation = 'multiply';
          ctx.globalAlpha = 0.35;
          ctx.lineCap = 'butt';
        } else {
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1.0;
          ctx.lineCap = 'round';
        }

        ctx.strokeStyle = path.color;
        ctx.lineWidth = path.size;

        ctx.moveTo(path.points[0].x, path.points[0].y);
        for (let i = 1; i < path.points.length; i++) {
          ctx.lineTo(path.points[i].x, path.points[i].y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Drawing picked with the Select tool (BE-307) ──
    if (selectedDrawing && activeTool === 'select') {
      let box: { x: number; y: number; width: number; height: number } | null = null;
      if (selectedDrawing.kind === 'overlay') {
        const path = drawnPaths.find((p) => p.id === selectedDrawing.id);
        box = path ? drawnPathBounds(path) : null;
      } else {
        const r = selectedDrawing.rect;
        const tl = pdfToCanvas(r.x, r.y + r.height, scale, renderResult.pageHeight, mediaBox.x, mediaBox.y);
        const br = pdfToCanvas(r.x + r.width, r.y, scale, renderResult.pageHeight, mediaBox.x, mediaBox.y);
        box = { x: tl.cssX, y: tl.cssY, width: br.cssX - tl.cssX, height: br.cssY - tl.cssY };
      }
      if (box) {
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(box.x - 3, box.y - 3, box.width + 6, box.height + 6);
        ctx.restore();
      }
    }
  }, [selectedDrawing, editingLine, editText, caretPos, renderResult, doc, currentPage, scale, drawnPaths, activeTool, displayItems, selectedDisplayItem, formFields, selectedFormField, editOffsetCss, editManualSize, editStyleOverrides, editSel, textFontSize, textUnderline, textColor, strokePaths, pageLinks, selectedLink, linksHighlighted, detectedTables, activeTableId]);

  // Re-draw overlay whenever edit state changes
  useEffect(() => { drawOverlay(); }, [drawOverlay]);

  // ── Caret blink timer ──
  useEffect(() => {
    if (editingLine) {
      caretVisibleRef.current = true;
      caretTimerRef.current = setInterval(() => {
        caretVisibleRef.current = !caretVisibleRef.current;
        drawOverlay();
      }, 530);
      return () => {
        if (caretTimerRef.current) clearInterval(caretTimerRef.current);
      };
    } else {
      caretVisibleRef.current = false;
      if (caretTimerRef.current) clearInterval(caretTimerRef.current);
    }
  }, [editingLine, drawOverlay]);

  // ── Focus hidden input when entering edit mode (don't collapse selection on caret moves)
  useEffect(() => {
    if (editingLine && hiddenInputRef.current) {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
      hiddenInputRef.current.focus({ preventScroll: true });
      const pos = caretPos;
      const sel = editSelRef.current;
      if (sel.end > sel.start) {
        hiddenInputRef.current.setSelectionRange(sel.start, sel.end);
      } else {
        hiddenInputRef.current.setSelectionRange(pos, pos);
      }
    }
    // Only re-focus when the edit session starts, not on every caret tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLine]);

  // ── Begin an edit session with frozen line anchor + undo snapshot ──
  const beginEditSession = useCallback((line: TextLine, caretAt?: number) => {
    initialRunTextRef.current = line.text;
    setEditAnchorLine({
      ...line,
      runs: line.runs.map(r => ({
        ...r,
        glyphs: r.glyphs.map(g => ({ ...g, tRm: { ...g.tRm } })),
        sourceInstructionIndices: r.sourceInstructionIndices
          ? [...r.sourceInstructionIndices]
          : undefined,
      })),
      segments: line.segments.map(s => ({ ...s, run: s.run })),
    });
    editingBlockIdRef.current = line.id;
    pendingStylesRef.current = [];
    typingStyleRef.current = {};
    setEditStyleOverrides([]);
    setEditOffsetCss({ x: 0, y: 0 });
    setEditManualSize({ w: null, h: null });
    setSelectedDisplayItem(null);
    setActiveTool('text');
    setSelectedLine(line);
    setEditingLine(line);
    // Highlight parent table when editing a cell
    {
      let tableId: string | null = null;
      for (const table of detectedTables) {
        if (table.cells.some(c => c.line.id === line.id || c.line.text === line.text && Math.abs(c.line.baseline - line.baseline) < 2)) {
          tableId = table.id;
          break;
        }
      }
      setActiveTableId(tableId);
    }
    setEditText(line.text);
    editTextRef.current = line.text;
    const caret = caretAt ?? line.text.length;
    setCaretPos(caret);
    editSelRef.current = { start: caret, end: caret };
    setEditSel({ start: caret, end: caret });

    // Sync sidebar + typing style from the character left of the caret
    {
      const seeded = resolveTypingStyleFromCaret(
        line,
        caret,
        renderResult?.fonts,
        strokePaths,
        [],
      );
      typingStyleRef.current = seeded;
      if (seeded.fontSize != null) setTextFontSize(seeded.fontSize);
      if (seeded.bold != null) setTextBold(seeded.bold);
      if (seeded.italic != null) setTextItalic(seeded.italic);
      if (seeded.underline != null) setTextUnderline(seeded.underline);
      if (seeded.color) setTextColor(seeded.color);
      const seg = segmentAtIndex(line, caret > 0 ? caret - 1 : 0) ?? line.segments[0];
      if (seg) {
        const fd = renderResult?.fonts.get(seg.run.fontName);
        setTextFontFamily(getDisplayFontFamily(seg.run.fontName, fd));
      }
    }

    if (doc && engineRef.current) {
      const page = doc.pages[currentPage];
      const contentBytes = engineRef.current.getPageContentBytes(page, doc.objects);
      undoSnapshotRef.current = {
        pageIndex: currentPage,
        contentBytes: new Uint8Array(contentBytes),
      };
    }
  }, [doc, currentPage, setEditingLine, renderResult, strokePaths, detectedTables]);

  // ── Text edit submit — surgical in-place line edit (preserve positions) ──
  const handleEditSubmit = useCallback(async (closeEdit: boolean = true) => {
    if (!editingLine || !doc || !engineRef.current) return;
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }

    const textChanged = editText !== initialRunTextRef.current;
    const pdfDx = editOffsetCss.x / scale;
    const pdfDy = -editOffsetCss.y / scale; // CSS down is PDF down in screen, PDF y up
    const moved = Math.abs(pdfDx) > 0.5 || Math.abs(pdfDy) > 0.5;
    const pendingStyles = pendingStylesRef.current;
    const hasPendingStyles = pendingStyles.length > 0;

    if (!textChanged && !moved && !hasPendingStyles) {
      setEditAnchorLine(null);
      undoSnapshotRef.current = null;
      editingBlockIdRef.current = null;
      pendingStylesRef.current = [];
      typingStyleRef.current = {};
      setEditStyleOverrides([]);
      setEditOffsetCss({ x: 0, y: 0 });
      setEditManualSize({ w: null, h: null });
      if (closeEdit) {
        setEditingLine(null);
        setSelectedLine(null);
      }
      return;
    }

    try {
      setIsSaving(true);
      const engine = engineRef.current;
      const page = doc.pages[currentPage];
      const targetLine = editAnchorLineRef.current ?? editingLine;
      const snapshot = undoSnapshotRef.current;
      let bytes = snapshot?.pageIndex === currentPage
        ? new Uint8Array(snapshot.contentBytes)
        : engine.getPageContentBytes(page, doc.objects);

      const fontSizeOverrides = pendingStyles
        .filter(p => p.patch.fontSize != null && p.end > p.start)
        .map(p => ({
          start: p.start,
          end: p.end,
          fontSize: p.patch.fontSize as number,
        }));

      if (textChanged) {
        const commitText = editTextRef.current || editText;
        const caretAfter = editSelRef.current.end;
        // Do NOT collapse multi-spaces on commit — live overlay gaps were real
        // inserts, and smashing them made spaces vanish on click-away.
        const editResult = engine.applyLineTextEdit(
          bytes,
          page,
          doc.objects,
          targetLine,
          commitText,
          renderResult?.documentFlow,
          {
            oldText: initialRunTextRef.current || targetLine.text,
            caretAfter,
            skipResidualCorrection: pendingStyles.some(p => p.patch.fontSize != null),
            fontSizeOverrides: fontSizeOverrides.length > 0 ? fontSizeOverrides : undefined,
          },
        );

        if (editResult.needsFontAugmentation) {
          try {
            const missing = String.fromCharCode(
              ...editResult.missingCharCodes.filter(c => c < 0x10000),
            );
            engine.augmentFontsForMissingGlyphs(doc, currentPage, missing);
          } catch (augErr) {
            console.warn('[Editor] Font augmentation failed:', augErr);
          }
        }
        bytes = editResult.newContentBytes;
      }

      if (moved) {
        const shifts = targetLine.runs.map(run => ({ run, dx: pdfDx, dy: pdfDy }));
        bytes = engine.applyRunPositionShifts(bytes, shifts);
      }

      await engine.updatePageContent(page.contentRefs, bytes, doc.objects);

      if (hasPendingStyles) {
        const commitText = editTextRef.current || editText;
        // Merge adjacent identical patches so we don't split the same run repeatedly
        const raw = [...pendingStyles]
          .filter(p => p.end > p.start)
          .sort((a, b) => a.start - b.start || a.end - b.end);
        let queued: typeof raw = [];
        for (const item of raw) {
          const prev = queued[queued.length - 1];
          const samePatch = prev && JSON.stringify(prev.patch) === JSON.stringify(item.patch);
          if (samePatch && prev.end >= item.start) {
            prev.end = Math.max(prev.end, item.end);
          } else {
            queued.push({ ...item, patch: { ...item.patch } });
          }
        }
        // Bridge fontSize-only holes left by spaces (not committed as fontSize)
        queued = coalesceFontSizePatches(queued, commitText);
        queued = expandFontSizePatchesThroughSpaces(queued, commitText);
        pendingStylesRef.current = [];
        // Re-interpret so selection ranges map onto the updated line text/runs
        let styleLine: TextLine = targetLine;
        const normalizeDashes = (t: string) => t.replace(/[\u2013\u2014\u2212]/g, '-');
        const commitNorm = normalizeDashes(commitText);
        const refreshStyleLine = () => {
          try {
            const freshBytes = engine.getPageContentBytes(page, doc.objects);
            const interpreted = engine.interpretPage(freshBytes, page, doc.objects);
            const flow = engine.buildDocumentFlow(interpreted.textRuns);
            styleLine =
              flow.lines.find((l: TextLine) => l.text === commitText) ??
              flow.lines.find((l: TextLine) => normalizeDashes(l.text) === commitNorm) ??
              findMatchingFlowLine(targetLine, flow.lines) ??
              styleLine;
          } catch (reErr) {
            console.warn('[Editor] Re-interpret for styles failed:', reErr);
          }
        };
        refreshStyleLine();

        // Path underlines don't move when text grows — expand insert-only
        // underline patches to the full destination run so the stroke covers
        // the whole title after commit.
        for (const item of queued) {
          if (item.patch.underline !== true) continue;
          const onlyUl = Object.keys(item.patch).every(
            k => k === 'underline' || (item.patch as Record<string, unknown>)[k] == null,
          );
          if (!onlyUl) continue;
          for (const seg of styleLine.segments) {
            if (item.end > seg.startIndex && item.start < seg.endIndex) {
              item.start = Math.min(item.start, seg.startIndex);
              item.end = Math.max(item.end, seg.endIndex);
            }
          }
        }

        // Batched fontSize trailing only (no post-style residual). Residual after
        // Tf splits re-chained widths and shoved trailers; batched growth tracks
        // selection enlarge only.
        // Skip when text-edit already reserved large-font width via fontSizeOverrides
        // — stacking both invents a river after the enlarged insert.
        if (textChanged && fontSizeOverrides.length === 0) {
          const fsRanges = queued
            .filter(q => q.patch.fontSize != null)
            .map(q => ({
              start: Math.max(0, Math.min(q.start, styleLine.text.length)),
              end: Math.max(0, Math.min(q.end, styleLine.text.length)),
              fontSize: q.patch.fontSize as number,
            }))
            .filter(r => r.end > r.start);
          if (fsRanges.length > 0) {
            const batched = engine.collectBatchedFontSizeTrailingShifts(styleLine, fsRanges);
            if (batched.shifts.length > 0) {
              let styleBytes = engine.getPageContentBytes(page, doc.objects);
              styleBytes = engine.applyRunPositionShifts(
                styleBytes,
                batched.shifts,
                styleLine.runs,
              );
              await engine.updatePageContent(page.contentRefs, styleBytes, doc.objects);
            }
          }
        }

        for (let qi = 0; qi < queued.length; qi++) {
          const item = queued[qi];
          const style: Record<string, unknown> = {};
          if (item.patch.fontSize != null) style.fontSize = item.patch.fontSize;
          if (item.patch.fontFamily != null) style.fontFamily = item.patch.fontFamily;
          if (item.patch.color != null) style.color = hexToRGB(item.patch.color);
          if (item.patch.bold != null) style.bold = item.patch.bold;
          if (item.patch.italic != null) style.italic = item.patch.italic;
          if (item.patch.underline != null) style.underline = item.patch.underline;
          if (item.patch.align != null) style.align = item.patch.align;
          if (Object.keys(style).length === 0) continue;
          // Clamp to the committed line length
          const start = Math.max(0, Math.min(item.start, styleLine.text.length));
          const end = Math.max(start, Math.min(item.end, styleLine.text.length));
          if (end <= start) continue;
          await engine.applyStyleToSelectionOnPage(
            doc,
            currentPage,
            styleLine,
            start,
            end,
            style,
            textChanged ? { skipTrailingFontSizeShifts: true } : undefined,
          );
          // Splits invalidate sourceInstructionIndices — refresh before next patch
          if (qi < queued.length - 1) refreshStyleLine();
        }
      } else if (textChanged) {
        // No pending styles — pack measured gaps after the text rewrite only.
        // Skip when spaces were inserted: TJ space advances inflate measured
        // widths and residual packing then pulls trailers left, collapsing
        // live gaps and truncating the line.
        const commitText = editTextRef.current || editText;
        const oldTextForPack = initialRunTextRef.current || targetLine.text;
        const packDeltaSpaces =
          (commitText.match(/\s/g) || []).length - (oldTextForPack.match(/\s/g) || []).length;
        if (packDeltaSpaces <= 0) {
          try {
            const packBytes = engine.getPageContentBytes(page, doc.objects);
            const interpreted = engine.interpretPage(packBytes, page, doc.objects);
            const flow = engine.buildDocumentFlow(interpreted.textRuns);
            const normalizeDashes = (t: string) => t.replace(/[\u2013\u2014\u2212]/g, '-');
            const commitNorm = normalizeDashes(commitText);
            const packLine =
              flow.lines.find((l: TextLine) => l.text === commitText) ??
              flow.lines.find((l: TextLine) => normalizeDashes(l.text) === commitNorm) ??
              findMatchingFlowLine(targetLine, flow.lines) ??
              null;
            if (packLine && packLine.segments.length > 1) {
              const packed = engine.correctLineResidualGaps(
                packBytes, page, doc.objects, packLine,
                { gapSourceLine: targetLine },
              );
              if (packed.corrections.length > 0) {
                await engine.updatePageContent(page.contentRefs, packed.bytes, doc.objects);
              }
            }
          } catch (packErr) {
            console.warn('[Editor] Post-text residual pack failed:', packErr);
          }
        }
      }


      pushEditorHistory('text-edit');
      setEditAnchorLine(null);
      undoSnapshotRef.current = null;
      editingBlockIdRef.current = null;
      pendingStylesRef.current = [];
      typingStyleRef.current = {};
      setEditStyleOverrides([]);
      setEditOffsetCss({ x: 0, y: 0 });
      setEditManualSize({ w: null, h: null });
      setIsDirty(true);
      if (closeEdit) {
        setEditingLine(null);
        setSelectedLine(null);
      }
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Edit failed:', e);
      setError(actionErrorMessage('Couldn\'t save that edit', e));
    } finally {
      setIsSaving(false);
    }
  }, [editingLine, editText, editOffsetCss, scale, doc, currentPage, setEditingLine, renderResult, pushEditorHistory, applyStyle]);

  // ── Edit cancel — discard overlay only; PDF untouched until commit ──
  const handleEditCancel = useCallback(async () => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setEditAnchorLine(null);
    undoSnapshotRef.current = null;
    editingBlockIdRef.current = null;
    pendingStylesRef.current = [];
    typingStyleRef.current = {};
    setEditStyleOverrides([]);
    setEditOffsetCss({ x: 0, y: 0 });
    setEditManualSize({ w: null, h: null });
    setEditingLine(null);
    setSelectedLine(null);
    setEditText('');
    setCaretPos(0);
  }, [setEditingLine]);

  // ── Undo ──
  const handleUndo = useCallback(async () => {
    if (!doc || !engineRef.current) return;
    const entries = historyRef.current.undoStep();
    if (!entries) return;
    try {
      for (const entry of entries) await applyHistoryEntry(entry);
    } catch (e) {
      console.error('[Editor] Undo failed:', e);
    }
  }, [doc, applyHistoryEntry]);

  const handleRedo = useCallback(async () => {
    if (!doc || !engineRef.current) return;
    const entries = historyRef.current.redoStep();
    if (!entries) return;
    try {
      for (const entry of entries) await applyHistoryEntry(entry);
    } catch (e) {
      console.error('[Editor] Redo failed:', e);
    }
  }, [doc, applyHistoryEntry]);

  const handleFormFieldSelect = useCallback((field: AcroFormWidget) => {
    setSelectedFormField(field);
    setFormFieldDraft(typeof field.value === 'string' ? field.value : '');
    setActiveTool('select');
  }, []);

  /** Place active library signature into a PDF /FT Sig field (writes /AP). */
  const placeLibrarySignatureIntoField = useCallback(async (field: SignatureField) => {
    if (!doc) return;
    const lib = getSignatureLibrary();
    let entry = activeLibraryId ? lib.get(activeLibraryId) : null;
    if (!entry) {
      const list = lib.list();
      entry = list.find((e) => e.favorite) ?? list[0] ?? null;
    }
    if (!entry) {
      setSignatureCreateOpen(true);
      return;
    }
    try {
      await applySignatureFieldAppearanceAsync(doc, field.ref, {
        width: field.rect.width,
        height: field.rect.height,
        imageDataUrl: entry.imageDataUrl,
        typedName: entry.typedText || entry.name,
        date: new Date().toLocaleDateString(),
        backgroundColor: [1, 1, 1],
        borderWidth: 1,
        borderColor: [0.2, 0.25, 0.35],
      });
      // Also keep a visual overlay aligned to the field for immediate feedback
      const overlay = createVisualSignature({
        pageIndex: field.pageIndex,
        x: field.rect.x + field.rect.width / 2,
        y: field.rect.y + field.rect.height / 2,
        appearanceId: entry.id,
        appearanceType:
          entry.source === 'draw' ? 'drawn' : entry.source === 'typed' ? 'typed' : 'uploaded',
        width: field.rect.width,
        height: field.rect.height,
      });
      const withoutOverlapping = signaturesRef.current.filter(
        (s) =>
          !(
            s.pageIndex === field.pageIndex &&
            Math.abs(s.x - overlay.x) < 2 &&
            Math.abs(s.y - overlay.y) < 2
          ),
      );
      pushSignatureSnapshot([...withoutOverlapping, overlay], 'place-in-field');
      setPdfSignatureFields(detectSignatureFieldsOnPage(doc, currentPage));
      setSelectedPdfSigFieldId(field.id);
      setActiveLibraryId(entry.id);
      setIsDirty(true);
      setRenderKey((k) => k + 1);
    } catch (err) {
      console.error('[Editor] Place signature in field failed:', err);
      setError(actionErrorMessage('Couldn\'t place the signature', err));
    }
  }, [doc, activeLibraryId, currentPage, pushSignatureSnapshot]);

  const refreshCertificateIdentities = useCallback(() => {
    const mgr = getCertificateManager();
    setCertificateIdentities(mgr.list());
    setSelectedCertificateId(mgr.getSelected()?.id ?? null);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(refreshCertificateIdentities, 80);
    return () => window.clearTimeout(t);
  }, [refreshCertificateIdentities]);

  const handleSelectCertificate = useCallback((id: string | null) => {
    getCertificateManager().select(id);
    setSelectedCertificateId(id);
  }, []);

  // The PDF document model is a mutable engine object: engine edits update it in
  // place and a re-render is requested through renderKey. Signing follows the
  // same contract (doc.rawBytes becomes the signed file), hence the exception.
  // eslint-disable-next-line react-hooks/immutability
  const handleCryptographicSign = useCallback(async () => {
    if (!doc) {
      setError('No document loaded.');
      return;
    }
    const mgr = getCertificateManager();
    if (selectedCertificateId) mgr.select(selectedCertificateId);
    const keyMat = mgr.getSelectedKey();
    const identity = mgr.getSelected();
    if (!keyMat?.privateKey) {
      setCertificateImportOpen(true);
      setError('Import a certificate with a private key to digitally sign.');
      return;
    }

    let field = pdfSignatureFields.find((f) => f.id === selectedPdfSigFieldId);
    if (!field) {
      const unsigned = pdfSignatureFields.find((f) => !f.signed);
      if (unsigned) {
        field = unsigned;
      } else {
        const placedSig = signaturesRef.current.find((s) => s.pageIndex === currentPage) ?? signaturesRef.current[0];
        const px = placedSig ? placedSig.x : 100;
        const py = placedSig ? placedSig.y : 100;
        try {
          const created = createSignatureFieldAtPoint(doc, currentPage, px, py, {
            withPlaceholderAppearance: true,
          });
          const fieldsOnPage = detectSignatureFieldsOnPage(doc, currentPage);
          setPdfSignatureFields(fieldsOnPage);
          field = fieldsOnPage.find((f) => f.id === created.id);
        } catch (err) {
          console.error('[Editor] Auto-create sig field failed:', err);
        }
      }
    }

    if (!field) {
      setError('No valid signature field available for digital signing.');
      return;
    }
    if (field.signed) {
      setError('This field is already signed.');
      return;
    }

    setCryptoSignBusy(true);
    setError(null);
    try {
      const leafDer = mgr.getSelectedLeafDer() ?? undefined;
      const result = await signDocumentCryptographic(doc, field.ref, keyMat.privateKey, {
        reason: 'Document approval',
        name: identity?.leaf?.subject.commonName ?? identity?.label ?? 'Signer',
        hashAlgorithm: 'sha256',
        contentsSize: 8192,
        certificateDer: leafDer ?? undefined,
        appearanceText: identity?.leaf?.subject.commonName ?? identity?.label ?? 'Signed',
        enableTimestamp,
      });
      // eslint-disable-next-line react-hooks/immutability -- see note above handleCryptographicSign
      doc.rawBytes = result.bytes;
      setPdfSignatureFields(detectSignatureFieldsOnPage(doc, currentPage));
      pushSignatureSnapshot(
        lockSignaturesAfterSigning(signaturesRef.current, field.pageIndex),
        'lock-after-sign',
      );
      if (activeLibraryId) pushRecentSignatureId(activeLibraryId);
      setManagedSignatures(listManagedSignatures(doc));
      setRevisionEntries(buildRevisionViewer(doc).revisions);
      setLtvStatus(getLtvStatus(doc));
      setIsDirty(true);
      signedPristineRef.current = true;
      setRenderKey((k) => k + 1);
      if (result.timestampError) {
        console.warn('[Editor] Timestamp fallback:', result.timestampError);
      }
    } catch (err) {
      console.error('[Editor] Cryptographic sign failed:', err);
      setError(actionErrorMessage('Couldn\'t sign the document', err));
    } finally {
      setCryptoSignBusy(false);
    }
  }, [doc, selectedPdfSigFieldId, pdfSignatureFields, selectedCertificateId, currentPage, enableTimestamp, pushSignatureSnapshot, activeLibraryId]);

  const refreshMultiSigPanel = useCallback(() => {
    if (!doc) {
      setManagedSignatures([]);
      setRevisionEntries([]);
      setLtvStatus(null);
      return;
    }
    setManagedSignatures(listManagedSignatures(doc));
    setRevisionEntries(buildRevisionViewer(doc).revisions);
    setLtvStatus(getLtvStatus(doc));
  }, [doc]);

  // Refresh the multi-signature panel when the document or its signature
  // fields change (adjusted during render rather than in an effect).
  const [multiSigSource, setMultiSigSource] = useState({ doc, pdfSignatureFields });
  if (multiSigSource.doc !== doc || multiSigSource.pdfSignatureFields !== pdfSignatureFields) {
    setMultiSigSource({ doc, pdfSignatureFields });
    refreshMultiSigPanel();
  }

  // Keep the signature summary current: re-check after opening or signing,
  // instead of showing stale counts until Validate is clicked (BE-512).
  useEffect(() => {
    if (!doc || pdfSignatureFields.length === 0) return;
    let cancelled = false;
    validateDocumentSignatures(doc, { allowSelfSigned: true })
      .then((report) => {
        if (!cancelled) setValidationReport(report);
      })
      .catch(() => {
        /* the Validate button reports errors */
      });
    return () => {
      cancelled = true;
    };
  }, [doc, pdfSignatureFields]);

  const handleValidateSignatures = useCallback(async () => {
    if (!doc) return;
    setValidationBusy(true);
    try {
      const report = await validateDocumentSignatures(doc, { allowSelfSigned: true });
      setValidationReport(report);
      refreshMultiSigPanel();
    } catch (err) {
      setError(actionErrorMessage('Couldn\'t check the signatures', err));
    } finally {
      setValidationBusy(false);
    }
  }, [doc, refreshMultiSigPanel]);

  const handleEnableLtv = useCallback(() => {
    if (!doc) return;
    try {
      const wasPristine = signedPristineRef.current;
      enableLongTermValidation(doc);
      setLtvStatus(getLtvStatus(doc));
      setIsDirty(true);
      // DSS is appended as an incremental update, so a signed file stays intact.
      signedPristineRef.current = wasPristine;
      refreshMultiSigPanel();
    } catch (err) {
      setError(actionErrorMessage('Couldn\'t add long-term validation', err));
    }
  }, [doc, refreshMultiSigPanel]);

  const handleFormFieldChange = useCallback((value: string) => {
    setFormFieldDraft(value);
    if (!doc || !selectedFormField || !engineRef.current) return;
    const engine = engineRef.current;
    if (selectedFormField.readOnly) return;
    if (selectedFormField.fieldType === 'Btn') {
      const checked = value === 'true' || value === 'Yes' || value === 'On';
      engine.setButtonFieldValue(doc, selectedFormField, checked);
      setFormFields(prev => prev.map(f =>
        f.ref.toKey() === selectedFormField.ref.toKey() ? { ...f, value: checked } : f,
      ));
      // Keep the selected field in sync so the toggle label flips each click.
      setSelectedFormField({ ...selectedFormField, value: checked });
    } else if (selectedFormField.fieldType === 'Ch') {
      engine.setChoiceFieldValue(doc, selectedFormField, value);
      setFormFields(prev => prev.map(f =>
        f.ref.toKey() === selectedFormField.ref.toKey() ? { ...f, value } : f,
      ));
    } else {
      engine.setFormFieldValue(doc, selectedFormField, value);
      setFormFields(prev => prev.map(f =>
        f.ref.toKey() === selectedFormField.ref.toKey() ? { ...f, value } : f,
      ));
    }
    // Redraw so the regenerated appearance (and radio siblings) show on the canvas.
    bumpRender();
  }, [doc, selectedFormField, bumpRender]);

  // ── Document-wide search ──
  // Derived from the document during render. Content edits mutate `doc` in
  // place, so `renderKey` (bumped on every edit) is what invalidates the scan.
  const searchResults = useMemo<SearchMatch[]>(() => {
    void renderKey;
    if (!doc || !findText.trim()) return [];

    const query = findText.trim();
    const lowerQuery = caseSensitive ? query : query.toLowerCase();
    const matches: SearchMatch[] = [];

    for (let p = 0; p < doc.pages.length; p++) {
      const page = doc.pages[p];
      try {
        const bytes = getPageContentBytes(page, doc.objects);
        const interpreted = interpretPage(bytes, page, doc.objects);

        for (const run of interpreted.textRuns) {
          const text = run.text;
          const textToSearch = caseSensitive ? text : text.toLowerCase();
          let idx = 0;
          while ((idx = textToSearch.indexOf(lowerQuery, idx)) !== -1) {
            const endIdx = idx + query.length;
            let pdfX = run.x;
            let pdfWidth = run.width;

            if (run.glyphs && run.glyphs.length === run.text.length) {
              const startG = run.glyphs[idx];
              const endG = run.glyphs[endIdx - 1];
              if (startG && endG) {
                pdfX = startG.x;
                pdfWidth = (endG.x + endG.width) - startG.x;
              }
            } else if (run.text.length > 0) {
              const charW = run.width / run.text.length;
              pdfX = run.x + idx * charW;
              pdfWidth = query.length * charW;
            }

            matches.push({
              id: `m-${p}-${idx}-${matches.length}`,
              pageIndex: p,
              pdfX,
              pdfY: run.y,
              pdfWidth: Math.max(pdfWidth, 3),
              pdfHeight: run.height || run.fontSize || 12,
              matchedText: text.substring(idx, endIdx),
              runText: text,
            });

            idx += Math.max(query.length, 1);
          }
        }
      } catch (e) {
        console.warn(`[Search] Error on page ${p}:`, e);
      }
    }

    return matches;
  }, [findText, caseSensitive, doc, renderKey]);

  // When the results change, keep the active match in range and bring its page into view.
  const [seenSearchResults, setSeenSearchResults] = useState(searchResults);
  if (seenSearchResults !== searchResults) {
    setSeenSearchResults(searchResults);
    const nextIdx = activeMatchIndex >= 0 && activeMatchIndex < searchResults.length ? activeMatchIndex : 0;
    if (nextIdx !== activeMatchIndex) setActiveMatchIndex(nextIdx);
    const target = searchResults[nextIdx];
    if (target && target.pageIndex !== currentPage) setCurrentPage(target.pageIndex);
  }

  const handleNextMatch = useCallback(() => {
    if (searchResults.length === 0) return;
    const nextIdx = (activeMatchIndex + 1) % searchResults.length;
    setActiveMatchIndex(nextIdx);
    const targetPage = searchResults[nextIdx].pageIndex;
    if (targetPage !== currentPage) {
      setCurrentPage(targetPage);
    }
  }, [searchResults, activeMatchIndex, currentPage]);

  const handlePrevMatch = useCallback(() => {
    if (searchResults.length === 0) return;
    const prevIdx = (activeMatchIndex - 1 + searchResults.length) % searchResults.length;
    setActiveMatchIndex(prevIdx);
    const targetPage = searchResults[prevIdx].pageIndex;
    if (targetPage !== currentPage) {
      setCurrentPage(targetPage);
    }
  }, [searchResults, activeMatchIndex, currentPage]);

  const handleReplaceCurrent = useCallback(async () => {
    if (!doc || !engineRef.current || searchResults.length === 0 || !findText.trim()) return;
    const currentMatch = searchResults[activeMatchIndex];
    if (!currentMatch) return;

    setSearchBusy(true);
    try {
      const engine = engineRef.current;
      const page = doc.pages[currentMatch.pageIndex];
      const bytes = engine.getPageContentBytes(page, doc.objects);
      // Matches are listed page by page in reading order; find this one's index on its page.
      const occurrence = searchResults
        .slice(0, activeMatchIndex)
        .filter((m) => m.pageIndex === currentMatch.pageIndex).length;
      const result = engine.findAndReplace(bytes, page, doc.objects, findText.trim(), replaceText, caseSensitive, occurrence);
      if (result.newContentBytes && result.newContentBytes !== bytes) {
        ensureHistoryBaseline(currentMatch.pageIndex);
        await engine.updatePageContent(page.contentRefs, result.newContentBytes, doc.objects);
        pushEditorHistory('replace', undefined, currentMatch.pageIndex);
        setIsDirty(true);
        setRenderKey(k => k + 1);
      }
    } catch (err) {
      console.error('[Search] Replace current error:', err);
    } finally {
      setSearchBusy(false);
    }
  }, [doc, searchResults, activeMatchIndex, findText, replaceText, caseSensitive, ensureHistoryBaseline, pushEditorHistory]);

  const handleReplaceAll = useCallback(async () => {
    if (!doc || !engineRef.current || !findText.trim()) return;
    setSearchBusy(true);
    try {
      const engine = engineRef.current;
      // Work out every page's replacement first, then record the batch so a
      // single Undo reverts all pages at once (BE-203).
      const changes: { pageIndex: number; bytes: Uint8Array }[] = [];
      for (let p = 0; p < doc.pages.length; p++) {
        const page = doc.pages[p];
        const bytes = engine.getPageContentBytes(page, doc.objects);
        const result = engine.findAndReplace(bytes, page, doc.objects, findText.trim(), replaceText, caseSensitive);
        if (result.newContentBytes && result.newContentBytes !== bytes) {
          changes.push({ pageIndex: p, bytes: result.newContentBytes });
        }
      }
      for (const { pageIndex } of changes) {
        if (!historyRef.current.hasPage(pageIndex)) pushEditorHistory('baseline', undefined, pageIndex);
      }
      const batchId = `replace-all-${Date.now()}`;
      for (const { pageIndex, bytes } of changes) {
        await engine.updatePageContent(doc.pages[pageIndex].contentRefs, bytes, doc.objects);
        pushEditorHistory('replace-all', undefined, pageIndex, batchId);
      }
      const replacedCount = changes.length;
      if (replacedCount > 0) {
        setIsDirty(true);
        setRenderKey(k => k + 1);
      }
    } catch (err) {
      console.error('[Search] Replace all error:', err);
    } finally {
      setSearchBusy(false);
    }
  }, [doc, findText, replaceText, caseSensitive, pushEditorHistory]);

  const handleRecognizeText = useCallback(async () => {
    if (!doc || !engineRef.current || !pdfCanvasRef.current) return;
    try {
      setIsSaving(true);
      setError(null);
      const { createDefaultOcrAdapter, canvasToImageData, mapOcrWordsToPdf } = await import('@/lib/ocr/adapter');
      const adapter = createDefaultOcrAdapter();
      const canvas = pdfCanvasRef.current;
      const imageData = canvasToImageData(canvas);
      const words = await adapter.recognize(imageData);
      const page = doc.pages[currentPage];
      const dpr = window.devicePixelRatio || 1;
      const mapped = mapOcrWordsToPdf(words, page.mediaBox.height, scale, page.mediaBox.y, dpr);
      if (mapped.length > 0) {
        await engineRef.current.insertInvisibleTextLayer(doc, currentPage, mapped);
        setIsDirty(true);
        setRenderKey(k => k + 1);
        setError(null);
        // Brief success via status — reuse error toast style as info
        console.log(`[OCR] Inserted ${mapped.length} words as invisible text`);
      } else {
        setError('OCR found no text on this page. Try a clearer scan or higher zoom.');
      }
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t recognize text on this page', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, scale]);

  const handleFlattenForms = useCallback(async () => {
    if (!doc || !engineRef.current || formFields.length === 0) return;
    try {
      setIsSaving(true);
      const engine = engineRef.current;
      await engine.flattenFormFieldsOnPage(doc, currentPage, formFields);
      pushEditorHistory('flatten-forms');
      setFormFields([]);
      setSelectedFormField(null);
      setFormFieldDraft('');
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Flatten forms failed:', e);
      setError(actionErrorMessage('Couldn\'t flatten the form', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, formFields, pushEditorHistory]);

  /**
   * Set when Shift+Enter is pressed mid-edit: the edit is committed first, and
   * the duplicate is made from the re-extracted line once the page re-renders.
   * The anchor's instruction indices point at the pre-edit content, so
   * duplicating it directly copied the original text over the edited line.
   */
  const pendingDuplicateRef = useRef<{ baseline: number; x: number } | null>(null);

  const duplicateLine = useCallback(async (line: TextLine) => {
    if (!doc || !engineRef.current) return;
    try {
      setIsSaving(true);
      const engine = engineRef.current;
      const page = doc.pages[currentPage];
      const bytes = engine.getPageContentBytes(page, doc.objects);
      const next = engine.duplicateLineBelow(bytes, line);
      await engine.updatePageContent(page.contentRefs, next, doc.objects);
      pushEditorHistory('duplicate-line');
      setIsDirty(true);
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Duplicate line failed:', e);
      setError(actionErrorMessage('Couldn\'t duplicate the line', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, pushEditorHistory]);

  const handleDuplicateLineBelow = useCallback(async () => {
    const line = editAnchorLineRef.current ?? selectedLine ?? editingLine;
    if (!doc || !engineRef.current || !line) return;
    if (editingLine) {
      pendingDuplicateRef.current = { baseline: line.baseline, x: line.x };
      await handleEditSubmit(false);
      return;
    }
    await duplicateLine(line);
  }, [doc, selectedLine, editingLine, handleEditSubmit, duplicateLine]);

  // Finish a Shift+Enter duplicate once the committed edit has re-rendered.
  useEffect(() => {
    const pending = pendingDuplicateRef.current;
    if (!pending || !renderResult || editingLine) return;
    pendingDuplicateRef.current = null;
    const fresh = renderResult.textLines.find(l =>
      Math.abs(l.baseline - pending.baseline) < 2 && Math.abs(l.x - pending.x) < 4,
    );
    if (fresh) void duplicateLine(fresh);
  }, [renderResult, editingLine, duplicateLine]);

  // Resolve table cell for the current selection (for sidebar actions)
  const selectedTableCell = (() => {
    const line = selectedLine ?? editingLine;
    if (!line) return null;
    for (const table of detectedTables) {
      for (const cell of table.cells) {
        if (
          Math.abs(cell.line.baseline - line.baseline) < 3 &&
          Math.abs(cell.line.x - line.x) < 8
        ) {
          return { table, cell };
        }
      }
    }
    return null;
  })();

  const handleAddTableRow = useCallback(async () => {
    if (!doc || !engineRef.current || !selectedTableCell) return;
    try {
      if (editingLine) await handleEditSubmit(false);
      setIsSaving(true);
      const { table, cell } = selectedTableCell;
      const rowLines = engineRef.current.getTableRowLines(table, cell.row);
      const page = doc.pages[currentPage];
      const bytes = engineRef.current.getPageContentBytes(page, doc.objects);
      // Everything below the row moves down, like inserting a row in a word
      // processor, so the new row doesn't overlap the next one.
      const rowBaseline = Math.min(...rowLines.map(l => l.baseline));
      const linesBelow = (renderResult?.textLines ?? []).filter(l => l.baseline < rowBaseline - 1);
      const pitch = table.rowBaselines.length > 1
        ? Math.abs(table.rowBaselines[0] - table.rowBaselines[table.rowBaselines.length - 1]) / (table.rowBaselines.length - 1)
        : undefined;
      const next = engineRef.current.duplicateTableRowBelow(bytes, rowLines, linesBelow, pitch);
      await engineRef.current.updatePageContent(page.contentRefs, next, doc.objects);
      pushEditorHistory('table-add-row');
      setIsDirty(true);
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Add table row failed:', e);
      setError(actionErrorMessage('Couldn\'t add a row', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, selectedTableCell, editingLine, handleEditSubmit, pushEditorHistory, renderResult]);

  const handleAddTableColumn = useCallback(async () => {
    if (!doc || !engineRef.current || !selectedTableCell) return;
    try {
      if (editingLine) await handleEditSubmit(false);
      setIsSaving(true);
      const { table } = selectedTableCell;
      const rows: TextLine[][] = [];
      for (let r = 0; r < table.rows; r++) {
        rows.push(engineRef.current.getTableRowLines(table, r));
      }
      const page = doc.pages[currentPage];
      const bytes = engineRef.current.getPageContentBytes(page, doc.objects);
      const next = engineRef.current.insertTableColumnRight(bytes, rows);
      await engineRef.current.updatePageContent(page.contentRefs, next, doc.objects);
      pushEditorHistory('table-add-column');
      setIsDirty(true);
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Add table column failed:', e);
      setError(actionErrorMessage('Couldn\'t add a column', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, selectedTableCell, editingLine, handleEditSubmit, pushEditorHistory]);

  // ── Global keyboard shortcuts for undo/redo (skip while editing text) ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inTextEdit =
        !!editingLineRef.current ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'INPUT' ||
        target?.isContentEditable;
      if (inTextEdit) return; // native undo for typing; document undo when not editing
      // Shift turns 'z' into 'Z' on most keyboards, so compare case-insensitively.
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        void handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        void handleRedo();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo]);

  const resolveLinkDisplay = useCallback((link: import('@/engine').PageLinkInfo) => {
    const lines = renderResult?.textLines ?? [];
    if (!lines.length) return { text: '', line: null as TextLine | null, start: 0, end: 0 };
    const cx = link.rect.x + link.rect.width / 2;
    const cy = link.rect.y + link.rect.height / 2;
    const line = hitTestTextLine(cx, cy, lines) || findNearestTextLine(cx, cy, lines, 24);
    if (!line) return { text: '', line: null, start: 0, end: 0 };
    const start = caretIndexFromLineX(link.rect.x, line);
    const end = Math.max(start, caretIndexFromLineX(link.rect.x + link.rect.width, line));
    return { text: line.text.slice(start, end), line, start, end };
  }, [renderResult]);

  // ── Canvas click handler — caret-based, no boxes ──
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (!renderResult || !doc) return;
    const wrapper = canvasContainerRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const page = doc.pages[currentPage];
    const { mediaBox } = page;
    const { pdfX, pdfY } = canvasToPdf(
      cssX, cssY, scale,
      renderResult.pageWidth, renderResult.pageHeight,
      mediaBox.x, mediaBox.y,
    );

    if (activeTool === 'text' || activeTool === 'select') {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }

      // Signature hit-test (above page contents)
      {
        const sigHit = hitTestSignature(signaturesRef.current, currentPage, pdfX, pdfY);
        if (sigHit) {
          if (editingLine) void handleEditSubmit(false);
          setSelectedSignatureId(sigHit.id);
          setSelectedDisplayItem(null);
          setSelectedLine(null);
          setActiveTool('sign');
          return;
        }
      }

      // Select tool: pick a drawing (unsaved stroke first, then saved markup)
      if (activeTool === 'select' && engineRef.current) {
        const pathHit = hitTestDrawnPath(drawnPathsRef.current, cssX, cssY);
        const annotHit = pathHit ? null : engineRef.current.hitTestMarkupAnnotation(page.dict, doc.objects, pdfX, pdfY, 4 / scale);
        if (pathHit || annotHit) {
          if (editingLine) void handleEditSubmit(false);
          setSelectedDrawing(pathHit
            ? { kind: 'overlay', id: pathHit.id }
            : { kind: 'annot', refKey: annotHit!.ref.toKey(), rect: annotHit!.rect });
          setSelectedDisplayItem(null);
          setSelectedLine(null);
          setActiveFloatingImageId(null);
          return;
        }
      }
      setSelectedDrawing(null);

      // Click a form field box → select it for editing
      if (formFields.length > 0 && engineRef.current) {
        const formHit = engineRef.current.hitTestFormField(formFields, pdfX, pdfY);
        if (formHit) {
          if (editingLine) void handleEditSubmit(false);
          handleFormFieldSelect(formHit);
          return;
        }
      }

      // Ctrl/Cmd+click opens an existing link (Acrobat-like)
      if ((e.ctrlKey || e.metaKey) && engineRef.current) {
        const linkHit = engineRef.current.hitTestPageLink(doc, currentPage, pdfX, pdfY);
        if (linkHit?.url) {
          window.open(linkHit.url, '_blank', 'noopener,noreferrer');
          return;
        }
      }

      // Click a highlighted link → open hover/edit popover on the PDF
      if (linksHighlighted && engineRef.current) {
        const linkHit = engineRef.current.hitTestPageLink(doc, currentPage, pdfX, pdfY);
        if (linkHit) {
          if (editingLine) void handleEditSubmit(false);
          setSelectedLine(null);
          setSelectedDisplayItem(null);
          setLinkCreatePending(false);
          setSelectedLink(linkHit);
          setLinkDraftUrl(linkHit.url || '');
          setLinkDisplayDraft(resolveLinkDisplay(linkHit).text);
          setLinkPopoverMode('hover');
          return;
        }
        // Click outside any link while a popover is open → dismiss it
        if (linkPopoverMode) {
          setLinkPopoverMode(null);
          setSelectedLink(null);
          setLinkDraftUrl('');
          setLinkDisplayDraft('');
        }
      }

      // Prefer real flow lines (sourceInstructionIndices) — never edit synthetic Bloom lines
      const startEditOnLine = (line: TextLine, newCaret: number) => {
        const flowLine = findMatchingFlowLine(line, renderResult.textLines) ?? line;
        const caret = Math.min(newCaret, flowLine.text.length);
        if (editingLine?.id === flowLine.id) {
          setCaretPos(caret);
          editSelRef.current = { start: caret, end: caret };
          setEditSel({ start: caret, end: caret });
          caretVisibleRef.current = true;
          setTimeout(() => {
            if (hiddenInputRef.current) {
              hiddenInputRef.current.focus({ preventScroll: true });
              hiddenInputRef.current.setSelectionRange(caret, caret);
            }
          }, 0);
          return;
        }
        const startNew = () => {
          beginEditSession(flowLine, caret);
          setTimeout(() => {
            if (hiddenInputRef.current) {
              hiddenInputRef.current.focus({ preventScroll: true });
              hiddenInputRef.current.setSelectionRange(caret, caret);
            }
          }, 0);
        };
        if (editingLine) {
          void handleEditSubmit(false).then(startNew);
        } else {
          startNew();
        }
      };

      const hit = hitTestTextLine(pdfX, pdfY, renderResult.textLines);
      if (hit) {
        startEditOnLine(hit, caretIndexFromLineX(pdfX, hit));
        return;
      }

      const nearHit = findNearestTextLine(pdfX, pdfY, renderResult.textLines, 12);
      if (nearHit) {
        startEditOnLine(nearHit, caretIndexFromLineX(pdfX, nearHit));
        return;
      }

      {
        const spatialHit = spatialIndexRef.current
          ? hitTestDisplayList(spatialIndexRef.current, pdfX, pdfY)
          : null;
        const itemHit = spatialHit && (spatialHit.data.type === 'image' || spatialHit.data.type === 'path')
          ? spatialHit.data as ImageItem | PathItem
          : null;
        if (itemHit) {
          if (editingLine) handleEditSubmit();
          setSelectedDisplayItem(itemHit);
          setSelectedLine(null);
          setEditingLine(null);
          setActiveTool('select');
          return;
        }
        setSelectedDisplayItem(null);
        if (editingLine) {
          handleEditSubmit();
        } else {
          setEditingLine(null);
          setSelectedLine(null);
        }
        setActiveFloatingTextId(null);
        setActiveFloatingImageId(null);
        setSelectedSignatureId(null);
      }
    } else if (activeTool === 'redact') {
      const hit = hitTestTextLine(pdfX, pdfY, renderResult.textLines);
      if (hit && engineRef.current) {
        const b = getLineBounds(hit);
        try {
          ensureHistoryBaseline(currentPage);
          engineRef.current.markRedaction(doc, currentPage, [
            b.x, b.y + b.height, b.x + b.width, b.y + b.height,
            b.x, b.y, b.x + b.width, b.y,
          ]);
          pushEditorHistory('redact-mark');
          setRedactionMarkCount(n => n + 1);
          setIsDirty(true);
          setRenderKey(k => k + 1);
        } catch (err) {
          console.warn('[Editor] Mark redaction failed:', err);
        }
      }
    } else if (activeTool === 'addtext') {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }

      if (!doc || !renderResult) return;
      const page = doc.pages[currentPage];

      // A new box always starts from the default style, not whatever was last
      // used on another line; the sidebar is reset to match it.
      const newBox: FloatingText = {
        id: Math.random().toString(36).slice(2, 11),
        pdfX,
        pdfY,
        text: 'New text',
        fontSize: DEFAULT_TEXT_STYLE.fontSize,
        fontFamily: DEFAULT_TEXT_STYLE.fontFamily,
        color: DEFAULT_TEXT_STYLE.color,
      };
      setTextFontSize(DEFAULT_TEXT_STYLE.fontSize);
      setTextFontFamily(DEFAULT_TEXT_STYLE.fontFamily);
      setTextColor(DEFAULT_TEXT_STYLE.color);
      setTextBold(false);
      setTextItalic(false);
      setTextUnderline(false);
      setTextAlign('left');

      focusFloatingTextIdRef.current = newBox.id;
      setFloatingTexts(prev => [...prev, newBox]);
      setActiveFloatingTextId(newBox.id);
      setIsDirty(true);
      setActiveTool('text');

    } else if (activeTool === 'highlight') {
      // Freehand drag already created a stroke — don't also add a full-line PDF bar
      if (skipNextHighlightClickRef.current) {
        skipNextHighlightClickRef.current = false;
        return;
      }
      const hit = hitTestTextLine(pdfX, pdfY, renderResult.textLines);
      if (hit && hit.runs[0] && engineRef.current && doc) {
        setSelectedLine(hit);
        try {
          const [r, g, b] = hexToRGB(highlightColor);
          engineRef.current.addHighlightFromLineSelection(
            doc,
            currentPage,
            hit,
            0,
            hit.text.length,
            [r, g, b],
            'Highlight',
          );
          pushEditorHistory('highlight');
          setIsDirty(true);
          setRenderKey(k => k + 1);
        } catch (err) {
          console.warn('[Editor] Highlight annotation failed:', err);
        }
      }
    } else if (activeTool === 'sign') {
      // Click existing PDF signature field → place library signature into /AP
      const pdfSigHit = hitTestSignatureField(pdfSignatureFields, pdfX, pdfY);
      if (pdfSigHit) {
        setSelectedPdfSigFieldId(pdfSigHit.id);
        setSelectedSignatureId(null);
        setSelectedDisplayItem(null);
        void placeLibrarySignatureIntoField(pdfSigHit);
        return;
      }

      // Select existing visual overlay signature
      const hit = hitTestSignature(signaturesRef.current, currentPage, pdfX, pdfY);
      if (hit) {
        setSelectedSignatureId(hit.id);
        setSelectedDisplayItem(null);
        setSelectedPdfSigFieldId(null);
        return;
      }

      // Deselect signature if clicking empty canvas space (signatures are placed via drag & drop from library)
      setSelectedSignatureId(null);
      setSelectedPdfSigFieldId(null);
    }
  }, [renderResult, doc, currentPage, scale, activeTool, editingLine, handleEditSubmit, beginEditSession, displayItems, textFontSize, textColor, textFontFamily, highlightColor, formFields, handleFormFieldSelect, linksHighlighted, linkPopoverMode, resolveLinkDisplay, pdfSignatureFields, placeLibrarySignatureIntoField, pushEditorHistory]);

  // Double-click in select mode → enter text edit
  const handleCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    if (activeTool !== 'select' && activeTool !== 'text') return;
    if (!renderResult || !doc) return;
    const wrapper = canvasContainerRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const page = doc.pages[currentPage];
    const { mediaBox } = page;
    const { pdfX, pdfY } = canvasToPdf(
      cssX, cssY, scale,
      renderResult.pageWidth, renderResult.pageHeight,
      mediaBox.x, mediaBox.y,
    );
    const hit =
      hitTestTextLine(pdfX, pdfY, renderResult.textLines) ??
      findNearestTextLine(pdfX, pdfY, renderResult.textLines, 16);
    if (hit) {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
      const flowLine = findMatchingFlowLine(hit, renderResult.textLines) ?? hit;
      const newCaret = caretIndexFromLineX(pdfX, flowLine);
      if (editingLine && editingLine.id !== flowLine.id) {
        void handleEditSubmit(false).then(() => beginEditSession(flowLine, newCaret));
        return;
      }
      beginEditSession(flowLine, newCaret);
      setTimeout(() => {
        if (hiddenInputRef.current) {
          hiddenInputRef.current.focus({ preventScroll: true });
          hiddenInputRef.current.setSelectionRange(newCaret, newCaret);
        }
      }, 0);
    }
  }, [renderResult, doc, currentPage, scale, activeTool, editingLine, handleEditSubmit, beginEditSession]);

  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // 1. Check for dropped image files (Drag and Drop / "Dragon draw")
    const files = Array.from(e.dataTransfer.files || []);
    const imageFile = files.find(f => f.type.startsWith('image/'));

    if (imageFile && doc) {
      const page = doc.pages[currentPage];
      if (!page) return;

      const canvasContainer = canvasContainerRef.current;
      const rect = canvasContainer?.getBoundingClientRect();
      const clientX = e.clientX;
      const clientY = e.clientY;

      let dropPdfX: number;
      let dropPdfY: number;

      if (rect) {
        const cssX = clientX - rect.left;
        const cssY = clientY - rect.top;
        const pt = canvasToPdf(
          cssX, cssY, scale,
          renderResult?.pageWidth || page.mediaBox.width,
          renderResult?.pageHeight || page.mediaBox.height,
          page.mediaBox.x, page.mediaBox.y
        );
        dropPdfX = pt.pdfX;
        dropPdfY = pt.pdfY;
      } else {
        dropPdfX = page.mediaBox.width / 2;
        dropPdfY = page.mediaBox.height / 2;
      }

      const reader = new FileReader();
      reader.onload = (re) => {
        const dataUrl = re.target?.result as string;
        if (!dataUrl) return;

        const img = new window.Image();
        img.onload = () => {
          let pdfWidth = img.width;
          let pdfHeight = img.height;
          const maxDim = 200;
          if (pdfWidth > maxDim || pdfHeight > maxDim) {
            const ratio = Math.min(maxDim / pdfWidth, maxDim / pdfHeight);
            pdfWidth *= ratio;
            pdfHeight *= ratio;
          }

          // Center the image around the drop location
          const pdfX = Math.max(0, dropPdfX - pdfWidth / 2);
          const pdfY = Math.min(page.mediaBox.height, dropPdfY + pdfHeight / 2);

          let jpegDataUrl = dataUrl;
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || pdfWidth;
            canvas.height = img.naturalHeight || pdfHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(img, 0, 0);
              jpegDataUrl = canvas.toDataURL('image/jpeg', 0.95);
            }
          } catch {}

          const newImg: FloatingImage = {
            id: Math.random().toString(36).substr(2, 9),
            pdfX,
            pdfY,
            pdfWidth,
            pdfHeight,
            dataUrl: jpegDataUrl,
            rotation: 0,
          };
          updateFloatingImages(prev => [...prev, newImg], 'add-image');
          setActiveFloatingImageId(newImg.id);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(imageFile);
      return;
    }

    // 2. Signature drop from library
    const signatureId =
      e.dataTransfer.getData('application/x-signature-id') ||
      e.dataTransfer.getData('text/plain');
    if (!signatureId || !doc || !renderResult) return;

    const lib = getSignatureLibrary();
    const entry = lib.get(signatureId);
    if (!entry) return;

    const canvasContainer = canvasContainerRef.current;
    if (!canvasContainer) return;
    const rect = canvasContainer.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;

    const page = doc.pages[currentPage];
    if (!page) return;
    const { mediaBox } = page;
    const { pdfX, pdfY } = canvasToPdf(
      cssX, cssY, scale,
      renderResult.pageWidth, renderResult.pageHeight,
      mediaBox.x, mediaBox.y,
    );

    const maxW = DEFAULT_SIGNATURE_SIZE.width;
    const scaleFit = Math.min(1, maxW / Math.max(entry.width, 1));
    const w = Math.max(40, entry.width * scaleFit);
    const h = Math.max(24, entry.height * scaleFit);

    const sig = createVisualSignature({
      pageIndex: currentPage,
      x: pdfX,
      y: pdfY,
      appearanceId: entry.id,
      appearanceType:
        entry.source === 'draw' ? 'drawn' : entry.source === 'typed' ? 'typed' : 'uploaded',
      width: w,
      height: h,
    });

    pushSignatureSnapshot([...signaturesRef.current, sig], 'add-signature');
    setSelectedSignatureId(sig.id);
    setActiveLibraryId(entry.id);
    pushRecentSignatureId(entry.id);
  }, [doc, renderResult, currentPage, scale, pushSignatureSnapshot, updateFloatingImages]);

  const applyEraser = useCallback((x: number, y: number, opts?: { deferAnnotRender?: boolean }) => {
    const eraserRadius = eraserSize / 2;

    // 1) Erase ephemeral overlay strokes / shapes
    setDrawnPaths(prev => {
      const newPaths: DrawnPath[] = [];
      let modified = false;
      for (const path of prev) {
        const kind = path.kind ?? 'freehand';
        if (kind !== 'freehand' && path.start && path.end) {
          // Hit-test shapes by proximity to geometry
          let hit = false;
          if (kind === 'line' || kind === 'arrow') {
            const { start, end } = path;
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const len2 = dx * dx + dy * dy;
            let t = len2 < 1e-8 ? 0 : ((x - start.x) * dx + (y - start.y) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const dist = Math.hypot(x - (start.x + t * dx), y - (start.y + t * dy));
            hit = dist <= eraserRadius;
          } else {
            const minX = Math.min(path.start.x, path.end.x) - eraserRadius;
            const maxX = Math.max(path.start.x, path.end.x) + eraserRadius;
            const minY = Math.min(path.start.y, path.end.y) - eraserRadius;
            const maxY = Math.max(path.start.y, path.end.y) + eraserRadius;
            hit = x >= minX && x <= maxX && y >= minY && y <= maxY;
          }
          if (hit) {
            modified = true;
            eraseChangedRef.current = true;
          } else {
            newPaths.push(path);
          }
          continue;
        }

        let currentSubPath: { x: number, y: number }[] = [];
        for (const p of path.points) {
          const dx = p.x - x;
          const dy = p.y - y;
          if (Math.sqrt(dx * dx + dy * dy) > eraserRadius) {
            currentSubPath.push(p);
          } else {
            if (currentSubPath.length > 0) {
              newPaths.push({ ...path, id: Math.random().toString(36).substr(2, 9), points: currentSubPath });
              currentSubPath = [];
              modified = true;
              eraseChangedRef.current = true;
            }
          }
        }
        if (currentSubPath.length > 0) {
          if (currentSubPath.length === path.points.length) {
            newPaths.push(path);
          } else {
            newPaths.push({ ...path, id: Math.random().toString(36).substr(2, 9), points: currentSubPath });
            modified = true;
            eraseChangedRef.current = true;
          }
        }
      }
      if (modified) drawnPathsRef.current = newPaths;
      return modified ? newPaths : prev;
    });

    // 2) Erase committed PDF Highlight / Ink annotations under the cursor
    if (doc && engineRef.current && renderResult) {
      const page = doc.pages[currentPage];
      const { mediaBox } = page;
      const { pdfX, pdfY } = canvasToPdf(
        x, y, scale,
        renderResult.pageWidth, renderResult.pageHeight,
        mediaBox.x, mediaBox.y,
      );
      const pdfRadius = eraserRadius / scale;
      const removed = engineRef.current.eraseAnnotationsAtPoint(
        page.dict,
        doc.objects,
        pdfX,
        pdfY,
        Math.max(pdfRadius, 4),
      );
      if (removed > 0) {
        eraseChangedRef.current = true;
        if (!opts?.deferAnnotRender) {
          setIsDirty(true);
          setRenderKey(k => k + 1);
        }
      }
      return removed;
    }
    return 0;
  }, [eraserSize, doc, currentPage, scale, renderResult]);

  /** Sample eraser along a segment so fast strokes don't skip marks. */
  const applyEraserStroke = useCallback((from: { x: number; y: number } | null, to: { x: number; y: number }) => {
    const eraserRadius = eraserSize / 2;
    const step = Math.max(2, eraserRadius * 0.35);
    let removed = 0;
    if (!from) {
      removed += applyEraser(to.x, to.y, { deferAnnotRender: true }) || 0;
      return removed;
    }
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      removed += applyEraser(x, y, { deferAnnotRender: true }) || 0;
    }
    return removed;
  }, [applyEraser, eraserSize]);

  // ── Commit drawings, texts, and images to PDF ──
  const commitDrawingsToPdf = useCallback(async (pathsToCommit?: DrawnPath[], textsToCommit?: FloatingText[], imagesToCommit?: FloatingImage[]) => {
    if (committingPromiseRef.current) {
      await committingPromiseRef.current;
    }

    const executeCommit = async () => {
      const paths = pathsToCommit ?? drawnPathsRef.current;
      const fTexts = textsToCommit ?? floatingTextsRef.current;
      const fImages = imagesToCommit ?? floatingImagesRef.current;
      if (!doc || !engineRef.current || (paths.length === 0 && fTexts.length === 0 && fImages.length === 0)) return;
      const engine = engineRef.current;
      const page = doc.pages[currentPage];
      if (!page) return;
      let currentObjNum = engine.getNextObjNum(doc);

      const pageHeight = renderResult?.pageHeight || page.mediaBox.height;

      const toPdf = (cx: number, cy: number) => canvasToPdf(
        cx, cy, scale,
        renderResult?.pageWidth || page.mediaBox.width,
        pageHeight,
        page.mediaBox.x, page.mediaBox.y,
      );

      for (const p of paths) {
        const kind = p.kind ?? 'freehand';
        const lw = p.size / scale;
        const rgb = hexToRGB(p.color);

        let annotation: import('@/engine').Annotation | null = null;

        if (kind !== 'freehand' && p.start && p.end) {
          const a = toPdf(p.start.x, p.start.y);
          const b = toPdf(p.end.x, p.end.y);
          if (kind === 'line' || kind === 'arrow') {
            const minX = Math.min(a.pdfX, b.pdfX);
            const minY = Math.min(a.pdfY, b.pdfY);
            const maxX = Math.max(a.pdfX, b.pdfX);
            const maxY = Math.max(a.pdfY, b.pdfY);
            const pad = Math.max(lw * 4, 8);
            annotation = {
              type: 'Line',
              rect: { x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 },
              color: rgb,
              opacity: 1,
              x1: a.pdfX,
              y1: a.pdfY,
              x2: b.pdfX,
              y2: b.pdfY,
              lineWidth: lw,
              startStyle: 'None',
              endStyle: kind === 'arrow' ? 'OpenArrow' : 'None',
            };
          } else if (kind === 'rectangle') {
            const minX = Math.min(a.pdfX, b.pdfX);
            const minY = Math.min(a.pdfY, b.pdfY);
            const maxX = Math.max(a.pdfX, b.pdfX);
            const maxY = Math.max(a.pdfY, b.pdfY);
            annotation = {
              type: 'Square',
              rect: { x: minX, y: minY, width: Math.max(maxX - minX, lw), height: Math.max(maxY - minY, lw) },
              color: rgb,
              opacity: 1,
              lineWidth: lw,
              fillColor: null,
            };
          } else if (kind === 'ellipse') {
            const minX = Math.min(a.pdfX, b.pdfX);
            const minY = Math.min(a.pdfY, b.pdfY);
            const maxX = Math.max(a.pdfX, b.pdfX);
            const maxY = Math.max(a.pdfY, b.pdfY);
            annotation = {
              type: 'Circle',
              rect: { x: minX, y: minY, width: Math.max(maxX - minX, lw), height: Math.max(maxY - minY, lw) },
              color: rgb,
              opacity: 1,
              lineWidth: lw,
              fillColor: null,
            };
          }
        } else {
          if (p.points.length < 2) continue;
          const inkPathsPdf: number[][] = [[]];
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const pt of p.points) {
            const { pdfX, pdfY } = toPdf(pt.x, pt.y);
            inkPathsPdf[0].push(pdfX, pdfY);
            minX = Math.min(minX, pdfX);
            minY = Math.min(minY, pdfY);
            maxX = Math.max(maxX, pdfX);
            maxY = Math.max(maxY, pdfY);
          }
          annotation = {
            type: 'Ink',
            rect: { x: minX - lw, y: minY - lw, width: (maxX - minX) + lw * 2, height: (maxY - minY) + lw * 2 },
            color: rgb,
            opacity: p.type === 'highlight' ? 0.4 : 1.0,
            inkPaths: inkPathsPdf,
            lineWidth: lw,
          };
        }

        if (!annotation) continue;

        // addAnnotationToPage stores the appearance stream as its own object.
        const { dict } = engine.createAnnotationDict(annotation, currentObjNum++);

        const annotRef = new engine.PDFRef(currentObjNum, 0);
        engine.addAnnotationToPage(page.dict, dict, annotRef, doc.objects);
        currentObjNum = engine.getNextObjNum(doc);
      }

      if (fTexts.length > 0 || fImages.length > 0) {
        const contentBytes = engine.getPageContentBytes(page, doc.objects);
        let newContentBytes: Uint8Array = new Uint8Array(contentBytes);

        for (const ft of fTexts) {
          if (!ft.text.trim()) continue;
          const rgb = hexToRGB(ft.color);

          newContentBytes = engine.insertTextRun(
            newContentBytes, page, doc.objects,
            ft.text, ft.pdfX, ft.pdfY, ft.fontSize, rgb
          );
        }

        for (const fi of fImages) {
          const { newContentBytes: b } = await engine.insertImageRun(
            newContentBytes, page, doc.objects,
            fi.dataUrl, fi.pdfX, fi.pdfY, fi.pdfWidth, fi.pdfHeight,
            () => {
              const num = currentObjNum;
              currentObjNum++;
              return num;
            },
            fi.rotation || 0
          );
          newContentBytes = b;
        }

        try {
          await engine.updatePageContent(page.contentRefs, newContentBytes, doc.objects, true, page);
        } catch (e: unknown) {
          console.error('[Editor] Failed to commit content:', e);
        }
      }

      const clearedOverlays = { drawnPaths: [] as DrawnPath[], floatingTexts: [] as FloatingText[], floatingImages: [] as FloatingImage[] };
      setDrawnPaths([]);
      setFloatingTexts([]);
      setFloatingImages([]);
      setActiveFloatingTextId(null);
      setActiveFloatingImageId(null);
      pushEditorHistory('commit-drawings', clearedOverlays);
      setIsDirty(true);
      setRenderKey(k => k + 1);
    };

    const promise = executeCommit();
    committingPromiseRef.current = promise;
    try {
      await promise;
    } finally {
      if (committingPromiseRef.current === promise) {
        committingPromiseRef.current = null;
      }
    }
  }, [doc, currentPage, scale, renderResult, pushEditorHistory]);

  // ── Create an export copy of the document with all overlays applied without clearing them from editor ──
  const createExportDocWithOverlays = useCallback(async (
    targetDoc: PDFDocumentData,
    targetPageIdx: number,
    paths: DrawnPath[],
    texts: FloatingText[],
    images: FloatingImage[]
  ): Promise<PDFDocumentData> => {
    if (!engineRef.current) return targetDoc;
    const engine = engineRef.current;

    // Clone objects and pages so live document in memory is never modified
    const newObjects = new Map<string, PDFObject>();
    for (const [k, v] of targetDoc.objects) {
      newObjects.set(k, v);
    }
    const newPages: PDFPageInfo[] = targetDoc.pages.map((p) => {
      const pageDict = new engine.PDFDict();
      for (const [k, v] of p.dict.entries()) {
        pageDict.set(k, v);
      }
      // The writer serializes pages from the object map, so point the copy's map
      // at the cloned page dict; edits below then land only in the export copy.
      newObjects.set(p.ref.toKey(), pageDict);
      return {
        ...p,
        dict: pageDict,
        contentRefs: [...p.contentRefs],
        resources: p.resources ? p.resources : new engine.PDFDict(),
      };
    });

    const exportDoc: PDFDocumentData = {
      ...targetDoc,
      objects: newObjects,
      pages: newPages,
    };

    const page = exportDoc.pages[targetPageIdx];
    if (!page) return exportDoc;

    // Give a page its own Resources / XObject / ExtGState dicts before images are
    // added, so the export copy never writes new entries into the live document.
    const isolateResources = (target: PDFPageInfo) => {
      const copy = (value: unknown) => {
        const src = value instanceof engine.PDFRef ? exportDoc.objects.get(value.toKey()) : value;
        const dict = new engine.PDFDict();
        if (src instanceof engine.PDFDict) {
          for (const [k, v] of src.entries()) dict.set(k, v);
        }
        return dict;
      };
      const resources = copy(target.dict.get('Resources') ?? target.resources);
      for (const key of ['XObject', 'ExtGState']) {
        if (resources.has(key)) resources.set(key, copy(resources.get(key)));
      }
      target.dict.set('Resources', resources);
      target.resources = resources;
    };

    // Same for /Annots: annotations are appended to a copy, not the live page's array.
    if (paths.length > 0) {
      const annots = page.dict.get('Annots');
      const arr = annots instanceof engine.PDFRef ? exportDoc.objects.get(annots.toKey()) : annots;
      if (arr instanceof engine.PDFArray) page.dict.set('Annots', new engine.PDFArray([...arr.items]));
    }

    let currentObjNum = engine.getNextObjNum(exportDoc);
    const pageHeight = renderResult?.pageHeight || page.mediaBox.height;

    const toPdf = (cx: number, cy: number) => canvasToPdf(
      cx, cy, scale,
      renderResult?.pageWidth || page.mediaBox.width,
      pageHeight,
      page.mediaBox.x, page.mediaBox.y,
    );

    for (const p of paths) {
      const kind = p.kind ?? 'freehand';
      const lw = p.size / scale;
      const rgb = hexToRGB(p.color);
      let annotation: import('@/engine').Annotation | null = null;
      if (kind !== 'freehand' && p.start && p.end) {
        const a = toPdf(p.start.x, p.start.y);
        const b = toPdf(p.end.x, p.end.y);
        if (kind === 'line' || kind === 'arrow') {
          const minX = Math.min(a.pdfX, b.pdfX);
          const minY = Math.min(a.pdfY, b.pdfY);
          const maxX = Math.max(a.pdfX, b.pdfX);
          const maxY = Math.max(a.pdfY, b.pdfY);
          const pad = Math.max(lw * 4, 8);
          annotation = {
            type: 'Line',
            rect: { x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 },
            color: rgb,
            opacity: 1,
            x1: a.pdfX,
            y1: a.pdfY,
            x2: b.pdfX,
            y2: b.pdfY,
            lineWidth: lw,
            startStyle: 'None',
            endStyle: kind === 'arrow' ? 'OpenArrow' : 'None',
          };
        } else if (kind === 'rectangle') {
          const minX = Math.min(a.pdfX, b.pdfX);
          const minY = Math.min(a.pdfY, b.pdfY);
          const maxX = Math.max(a.pdfX, b.pdfX);
          const maxY = Math.max(a.pdfY, b.pdfY);
          annotation = {
            type: 'Square',
            rect: { x: minX, y: minY, width: Math.max(maxX - minX, lw), height: Math.max(maxY - minY, lw) },
            color: rgb,
            opacity: 1,
            lineWidth: lw,
            fillColor: null,
          };
        } else if (kind === 'ellipse') {
          const minX = Math.min(a.pdfX, b.pdfX);
          const minY = Math.min(a.pdfY, b.pdfY);
          const maxX = Math.max(a.pdfX, b.pdfX);
          const maxY = Math.max(a.pdfY, b.pdfY);
          annotation = {
            type: 'Circle',
            rect: { x: minX, y: minY, width: Math.max(maxX - minX, lw), height: Math.max(maxY - minY, lw) },
            color: rgb,
            opacity: 1,
            lineWidth: lw,
            fillColor: null,
          };
        }
      } else {
        if (p.points.length < 2) continue;
        const inkPathsPdf: number[][] = [[]];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of p.points) {
          const { pdfX, pdfY } = toPdf(pt.x, pt.y);
          inkPathsPdf[0].push(pdfX, pdfY);
          minX = Math.min(minX, pdfX);
          minY = Math.min(minY, pdfY);
          maxX = Math.max(maxX, pdfX);
          maxY = Math.max(maxY, pdfY);
        }
        annotation = {
          type: 'Ink',
          rect: { x: minX - lw, y: minY - lw, width: (maxX - minX) + lw * 2, height: (maxY - minY) + lw * 2 },
          color: rgb,
          opacity: p.type === 'highlight' ? 0.4 : 1.0,
          inkPaths: inkPathsPdf,
          lineWidth: lw,
        };
      }

      if (annotation) {
        // addAnnotationToPage stores the appearance stream as its own object.
        const { dict } = engine.createAnnotationDict(annotation, currentObjNum++);
        const annotRef = new engine.PDFRef(currentObjNum, 0);
        engine.addAnnotationToPage(page.dict, dict, annotRef, exportDoc.objects);
        currentObjNum = engine.getNextObjNum(exportDoc);
      }
    }

    if (texts.length > 0 || images.length > 0) {
      isolateResources(page);
      const contentBytes = engine.getPageContentBytes(page, exportDoc.objects);
      let newContentBytes: Uint8Array = new Uint8Array(contentBytes);

      for (const ft of texts) {
        if (!ft.text.trim()) continue;
        const rgb = hexToRGB(ft.color);
        newContentBytes = engine.insertTextRun(
          newContentBytes, page, exportDoc.objects,
          ft.text, ft.pdfX, ft.pdfY, ft.fontSize, rgb
        );
      }

      for (const fi of images) {
        const { newContentBytes: b } = await engine.insertImageRun(
          newContentBytes, page, exportDoc.objects,
          fi.dataUrl, fi.pdfX, fi.pdfY, fi.pdfWidth, fi.pdfHeight,
          () => currentObjNum++,
          fi.rotation || 0
        );
        newContentBytes = b;
      }

      try {
        await engine.updatePageContent(page.contentRefs, newContentBytes, exportDoc.objects, true, page);
      } catch (e: unknown) {
        console.error('[Editor] Failed to update export content:', e);
      }
    }

    // Placed (visual) signatures can sit on any page: stamp each one in as a
    // transparent image so it appears in the downloaded / exported PDF.
    const placed = signaturesRef.current;
    const library = getSignatureLibrary();
    for (const pageIdx of new Set(placed.map((sig) => sig.pageIndex))) {
      const sigPage = exportDoc.pages[pageIdx];
      if (!sigPage) continue;
      isolateResources(sigPage);
      let bytes: Uint8Array = new Uint8Array(engine.getPageContentBytes(sigPage, exportDoc.objects));
      let stamped = 0;
      for (const sig of placed) {
        if (sig.pageIndex !== pageIdx) continue;
        const src = library.get(sig.appearanceId)?.imageDataUrl;
        if (!src) continue;
        // Signature rotation is counter-clockwise; insertImageRun rotates clockwise.
        const { newContentBytes } = await engine.insertImageRun(
          bytes, sigPage, exportDoc.objects,
          src, sig.x, sig.y + sig.height, sig.width, sig.height,
          () => currentObjNum++,
          -(sig.rotation || 0),
          { preserveAlpha: true, opacity: sig.opacity },
        );
        bytes = newContentBytes;
        stamped++;
      }
      if (stamped > 0) {
        await engine.updatePageContent(sigPage.contentRefs, bytes, exportDoc.objects, true, sigPage);
      }
    }

    return exportDoc;
  }, [scale, renderResult]);

  const strokeShapePreview = useCallback((
    ctx: CanvasRenderingContext2D,
    kind: DrawMode,
    start: { x: number; y: number },
    end: { x: number; y: number },
    color: string,
    size: number,
  ) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (kind === 'line' || kind === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      if (kind === 'arrow') {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const head = Math.max(size * 4, 10);
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - head * Math.cos(angle - 0.4), end.y - head * Math.sin(angle - 0.4));
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - head * Math.cos(angle + 0.4), end.y - head * Math.sin(angle + 0.4));
        ctx.stroke();
      }
    } else if (kind === 'rectangle') {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      ctx.strokeRect(x, y, w, h);
    } else if (kind === 'ellipse') {
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2;
      const ry = Math.abs(end.y - start.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, []);

  const handleDrawStart = useCallback((e: React.MouseEvent) => {
    if (activeTool !== 'draw' && activeTool !== 'highlight' && activeTool !== 'erase') return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setIsDrawing(true);
    drawDraggedRef.current = false;
    eraseChangedRef.current = false;

    if (activeTool === 'erase') {
      lastErasePosRef.current = { x, y };
      const removed = applyEraserStroke(null, { x, y });
      if (removed > 0) {
        eraseChangedRef.current = true;
        setIsDirty(true);
        setRenderKey(k => k + 1);
      }
    } else if (activeTool === 'draw' && drawMode !== 'freehand') {
      lastErasePosRef.current = null;
      shapeStartRef.current = { x, y };
      shapeEndRef.current = { x, y };
      currentDrawPath.current = [];
    } else {
      lastErasePosRef.current = null;
      shapeStartRef.current = null;
      shapeEndRef.current = null;
      currentDrawPath.current = [{ x, y }];
    }
  }, [activeTool, applyEraserStroke, drawMode]);

  const handleDrawMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool === 'erase') {
      const removed = applyEraserStroke(lastErasePosRef.current, { x, y });
      lastErasePosRef.current = { x, y };
      if (removed > 0) {
        eraseChangedRef.current = true;
        setIsDirty(true);
        setRenderKey(k => k + 1);
      }
      return;
    }

    // Shape drag preview
    if (activeTool === 'draw' && drawMode !== 'freehand' && shapeStartRef.current) {
      if (Math.hypot(x - shapeStartRef.current.x, y - shapeStartRef.current.y) > 5) {
        drawDraggedRef.current = true;
      }
      shapeEndRef.current = { x, y };
      drawOverlay();
      const ctx = overlay.getContext('2d');
      if (ctx && drawDraggedRef.current) {
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.scale(dpr, dpr);
        strokeShapePreview(ctx, drawMode, shapeStartRef.current, { x, y }, drawColor, drawSize);
        ctx.restore();
      }
      return;
    }

    const path = currentDrawPath.current;
    if (path.length > 0) {
      const dx = x - path[0].x;
      const dy = y - path[0].y;
      if (Math.hypot(dx, dy) > 5) drawDraggedRef.current = true;
    }
    // Ignore tiny jitter so a click doesn't become a freehand highlight stroke
    if (!drawDraggedRef.current) return;

    currentDrawPath.current.push({ x, y });

    // Live draw on overlay
    const ctx = overlay.getContext('2d');
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      const pts = currentDrawPath.current;
      if (pts.length >= 2) {
        ctx.save();
        ctx.scale(dpr, dpr);
        if (activeTool === 'highlight') {
          ctx.strokeStyle = highlightColor;
          ctx.lineWidth = highlightSize;
          ctx.globalCompositeOperation = 'multiply';
          ctx.globalAlpha = 0.35;
          ctx.lineCap = 'butt';
          ctx.lineJoin = 'round';
        } else {
          ctx.strokeStyle = drawColor;
          ctx.lineWidth = drawSize;
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1.0;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
        }
        ctx.beginPath();
        const prev = pts[pts.length - 2];
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [isDrawing, activeTool, drawMode, drawColor, drawSize, highlightColor, highlightSize, applyEraserStroke, strokeShapePreview, drawOverlay]);

  const handleDrawEnd = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    lastErasePosRef.current = null;

    if (activeTool === 'erase') {
      if (eraseChangedRef.current) {
        // Also capture overlay path erasures via current drawnPaths state
        pushEditorHistory('erase');
        eraseChangedRef.current = false;
      }
      return;
    }

    // Shape placement
    if (activeTool === 'draw' && drawMode !== 'freehand' && shapeStartRef.current && shapeEndRef.current) {
      if (drawDraggedRef.current) {
        const start = shapeStartRef.current;
        const end = shapeEndRef.current;
        const newPath: DrawnPath = {
          id: Math.random().toString(36).substr(2, 9),
          type: 'draw',
          kind: drawMode,
          color: drawColor,
          size: drawSize,
          points: [start, end],
          start,
          end,
        };
        setDrawnPaths((prev) => {
          const next = [...prev, newPath];
          drawnPathsRef.current = next;
          pushEditorHistory('draw-shape', { drawnPaths: next });
          return next;
        });
      }
      shapeStartRef.current = null;
      shapeEndRef.current = null;
      drawDraggedRef.current = false;
      return;
    }

    if (drawDraggedRef.current && currentDrawPath.current.length > 1) {
      // Drag produced a freehand stroke — suppress the trailing click annotation
      if (activeTool === 'highlight') {
        skipNextHighlightClickRef.current = true;
      }
      const newPath: DrawnPath = {
        id: Math.random().toString(36).substr(2, 9),
        type: activeTool as PathType,
        kind: 'freehand',
        color: activeTool === 'draw' ? drawColor : highlightColor,
        size: activeTool === 'draw' ? drawSize : highlightSize,
        points: [...currentDrawPath.current],
      };

      setDrawnPaths((prev) => {
        const next = [...prev, newPath];
        drawnPathsRef.current = next;
        pushEditorHistory(activeTool === 'highlight' ? 'highlight-stroke' : 'draw-stroke', { drawnPaths: next });
        return next;
      });
    }
    currentDrawPath.current = [];
    drawDraggedRef.current = false;
  }, [isDrawing, activeTool, drawMode, drawColor, drawSize, highlightColor, highlightSize, pushEditorHistory]);

  const openLinkHover = useCallback((link: import('@/engine').PageLinkInfo) => {
    if (linkHoverTimerRef.current) {
      clearTimeout(linkHoverTimerRef.current);
      linkHoverTimerRef.current = null;
    }
    // Already showing this link — don't reset state (avoids flicker / remount)
    if (
      selectedLink?.ref.toKey() === link.ref.toKey()
      && (linkPopoverMode === 'hover' || linkPopoverMode === 'edit')
    ) {
      return;
    }
    if (linkPopoverMode === 'edit') return;
    setSelectedLink(link);
    setLinkDraftUrl(link.url || '');
    setLinkDisplayDraft(resolveLinkDisplay(link).text);
    setLinkPopoverMode('hover');
  }, [linkPopoverMode, selectedLink, resolveLinkDisplay]);

  const scheduleLinkHoverClose = useCallback(() => {
    if (linkPopoverMode === 'edit') return;
    if (linkPopoverHoverRef.current) return;
    if (linkHoverTimerRef.current) clearTimeout(linkHoverTimerRef.current);
    linkHoverTimerRef.current = setTimeout(() => {
      linkHoverTimerRef.current = null;
      if (linkPopoverHoverRef.current) return;
      setLinkPopoverMode((mode) => {
        if (mode === 'hover') {
          setSelectedLink(null);
          return null;
        }
        return mode;
      });
    }, 700);
  }, [linkPopoverMode]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    handleDrawMove(e);
    if (!linksHighlighted || !doc || !engineRef.current || !renderResult || editingLine) return;
    if (linkPopoverMode === 'edit') return;
    if (['draw', 'highlight', 'erase'].includes(activeTool)) return;
    // Pointer is over the popover — keep it open
    if (linkPopoverHoverRef.current) return;

    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const page = doc.pages[currentPage];
    const { pdfX, pdfY } = canvasToPdf(
      cssX, cssY, scale,
      renderResult.pageWidth, renderResult.pageHeight,
      page.mediaBox.x, page.mediaBox.y,
    );
    const hit = engineRef.current.hitTestPageLink(doc, currentPage, pdfX, pdfY);
    if (hit) {
      openLinkHover(hit);
    } else if (linkPopoverMode === 'hover') {
      scheduleLinkHoverClose();
    }
  }, [
    handleDrawMove, linksHighlighted, doc, renderResult, editingLine,
    linkPopoverMode, activeTool, currentPage, scale, openLinkHover, scheduleLinkHoverClose,
  ]);

  const handleCanvasMouseLeave = useCallback((e: React.MouseEvent) => {
    handleDrawEnd();
    const next = e.relatedTarget as HTMLElement | null;
    if (next?.closest?.('[data-link-popover]')) return;
    if (linkPopoverMode === 'hover' && !linkPopoverHoverRef.current) {
      scheduleLinkHoverClose();
    }
  }, [handleDrawEnd, linkPopoverMode, scheduleLinkHoverClose]);

  const closeLinkPopover = useCallback(() => {
    if (linkHoverTimerRef.current) {
      clearTimeout(linkHoverTimerRef.current);
      linkHoverTimerRef.current = null;
    }
    setLinkPopoverMode(null);
    setSelectedLink(null);
    setLinkDraftUrl('');
    setLinkDisplayDraft('');
    // The popover unmounts under the pointer, so its mouseleave never fires.
    linkPopoverHoverRef.current = false;
  }, []);

  const scanPageLinks = useCallback(() => {
    if (!doc || !engineRef.current) return;
    try {
      setPageLinks(engineRef.current.listPageLinks(doc, currentPage));
      setLinksHighlighted(true);
      setLinkCreatePending(false);
      closeLinkPopover();
    } catch (err) {
      console.warn('[Editor] Scan links failed:', err);
    }
  }, [doc, currentPage, closeLinkPopover]);

  /**
   * Toolbar selection. Link is not a separate canvas mode: it opens Edit Text
   * with the page's links highlighted, where links are added and edited.
   */
  const selectTool = useCallback((tool: EditorTool) => {
    if (tool === 'link') {
      setActiveTool('text');
      setIsPanelOpen(true);
      scanPageLinks();
      return;
    }
    setActiveTool(tool);
  }, [scanPageLinks]);

  const handleApplyRedactions = useCallback(async () => {
    if (!doc || !engineRef.current) return;
    if (!window.confirm('Permanently remove the marked content on this page? This cannot be undone after you download the PDF.')) return;
    try {
      setIsSaving(true);
      ensureHistoryBaseline(currentPage);
      await engineRef.current.applyRedactions(doc, currentPage);
      pushEditorHistory('apply-redactions');
      setRedactionMarkCount(0);
      setIsDirty(true);
      setRenderKey(k => k + 1);
    } catch (err) {
      setError(actionErrorMessage('Couldn\'t apply redactions', err));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, ensureHistoryBaseline, pushEditorHistory, setIsDirty]);

  const saveLinkFromPopover = useCallback(async (andClose = true) => {
    if (!doc || !engineRef.current || !selectedLink) {
      if (andClose) closeLinkPopover();
      return;
    }
    const url = linkDraftUrl.trim();
    if (!url || url === 'https://') {
      if (andClose) closeLinkPopover();
      return;
    }

    try {
      const display = resolveLinkDisplay(selectedLink);
      // Update display text in the PDF if the user changed it
      if (display.line && linkDisplayDraft !== display.text && display.end > display.start) {
        const line = display.line;
        const nextText =
          line.text.slice(0, display.start) + linkDisplayDraft + line.text.slice(display.end);
        const page = doc.pages[currentPage];
        const bytes = engineRef.current.getPageContentBytes(page, doc.objects);
        const editResult = engineRef.current.applyLineTextEdit(
          bytes, page, doc.objects, line, nextText, renderResult?.documentFlow,
        );
        await engineRef.current.updatePageContent(
          page.contentRefs, editResult.newContentBytes, doc.objects,
        );
      }

      if (url !== selectedLink.url) {
        engineRef.current.updatePageLinkUrl(doc, currentPage, selectedLink, url);
      }
      setIsDirty(true);
      setRenderKey(k => k + 1);
      if (andClose) closeLinkPopover();
    } catch (err) {
      console.warn('[Editor] Save link failed:', err);
    }
  }, [
    doc, selectedLink, linkDraftUrl, linkDisplayDraft, resolveLinkDisplay,
    currentPage, renderResult, closeLinkPopover,
  ]);

  const removeLinkFromPopover = useCallback(() => {
    if (!doc || !engineRef.current || !selectedLink) {
      closeLinkPopover();
      return;
    }
    try {
      engineRef.current.removePageLink(doc, currentPage, selectedLink.ref);
      setIsDirty(true);
      setRenderKey(k => k + 1);
      closeLinkPopover();
    } catch (err) {
      console.warn('[Editor] Remove link failed:', err);
    }
  }, [doc, selectedLink, currentPage, closeLinkPopover]);

  const handleFloatingTextPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    setActiveFloatingTextId(id);
    setActiveFloatingImageId(null);
    const box = floatingTexts.find(b => b.id === id);
    if (!box) return;
    dragInfo.current = {
      id,
      type: 'text',
      startX: e.clientX,
      startY: e.clientY,
      startPdfX: box.pdfX,
      startPdfY: box.pdfY
    };

    const handleMove = (me: PointerEvent) => {
      if (!dragInfo.current || !doc || !renderResult) return;
      const dx = me.clientX - dragInfo.current.startX;
      const dy = me.clientY - dragInfo.current.startY;
      const pdfDx = dx / scale;
      const pdfDy = -dy / scale;

      const { startPdfX, startPdfY } = dragInfo.current;

      setFloatingTexts(prev => prev.map(p => p.id === id ? {
        ...p,
        pdfX: startPdfX + pdfDx,
        pdfY: startPdfY + pdfDy,
      } : p));
    };

    const handleUp = () => {
      dragInfo.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [floatingTexts, scale, doc, renderResult]);

  const handleFloatingImagePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    setActiveFloatingImageId(id);
    setActiveFloatingTextId(null);
    const box = floatingImages.find(b => b.id === id);
    if (!box) return;
    dragInfo.current = {
      id,
      type: 'image',
      startX: e.clientX,
      startY: e.clientY,
      startPdfX: box.pdfX,
      startPdfY: box.pdfY
    };
    let moved = false;

    const handleMove = (me: PointerEvent) => {
      if (!dragInfo.current || !doc || !renderResult) return;
      const dx = me.clientX - dragInfo.current.startX;
      const dy = me.clientY - dragInfo.current.startY;
      const pdfDx = dx / scale;
      const pdfDy = -dy / scale;

      const { startPdfX, startPdfY } = dragInfo.current;

      moved = true;
      updateFloatingImages(prev => prev.map(p => p.id === id ? {
        ...p,
        pdfX: startPdfX + pdfDx,
        pdfY: startPdfY + pdfDy,
      } : p));
    };

    const handleUp = () => {
      dragInfo.current = null;
      if (moved) recordFloatingImages('move-image');
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [floatingImages, scale, doc, renderResult, updateFloatingImages, recordFloatingImages]);

  const handleFloatingImageRotateDown = useCallback((e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();

    const parentEl = (e.currentTarget as HTMLElement).closest('.floating-image-container');
    if (!parentEl) return;

    const rect = parentEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const fi = floatingImagesRef.current.find(f => f.id === id);
    const initialRot = fi?.rotation || 0;
    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
    let rotated = false;

    const onPointerMove = (ev: PointerEvent) => {
      const currentAngle = Math.atan2(ev.clientY - centerY, ev.clientX - centerX) * (180 / Math.PI);
      const diff = currentAngle - startAngle;
      let newRot = Math.round((initialRot + diff) % 360);
      if (newRot < 0) newRot += 360;
      if (ev.shiftKey) {
        newRot = Math.round(newRot / 15) * 15;
      }
      rotated = true;
      updateFloatingImages(prev => prev.map(p => p.id === id ? { ...p, rotation: newRot } : p));
    };

    const onPointerUp = () => {
      if (rotated) recordFloatingImages('rotate-image');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }, [updateFloatingImages, recordFloatingImages]);

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      const img = new window.Image();
      img.onload = async () => {
        // Always convert to JPEG — engine image XObjects use DCTDecode
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);

        // Replace embedded PDF image in-place (same cm / bbox)
        if (replacingEmbeddedImageRef.current && doc && engineRef.current) {
          const target = replacingEmbeddedImageRef.current;
          replacingEmbeddedImageRef.current = null;
          try {
            await engineRef.current.replaceImageXObject(doc, currentPage, target, jpegDataUrl);
            pushEditorHistory('replace-image');
            setIsDirty(true);
            setSelectedDisplayItem(null);
            setRenderKey(k => k + 1);
          } catch (err) {
            console.error('[Editor] Replace embedded image failed:', err);
            setError(actionErrorMessage('Couldn\'t replace the text', err));
          }
          return;
        }

        if (replacingImageIdRef.current) {
          const replacingId = replacingImageIdRef.current;
          updateFloatingImages(prev => prev.map(p => p.id === replacingId ? { ...p, dataUrl: jpegDataUrl } : p), 'replace-image');
          replacingImageIdRef.current = null;
          return;
        }

        // Add new floating image
        if (!doc) return;
        const page = doc.pages[currentPage];
        if (!page) return;

        let pdfWidth = img.width;
        let pdfHeight = img.height;
        const maxDim = 200;
        if (pdfWidth > maxDim || pdfHeight > maxDim) {
          const ratio = Math.min(maxDim / pdfWidth, maxDim / pdfHeight);
          pdfWidth *= ratio;
          pdfHeight *= ratio;
        }

        const pdfX = page.mediaBox.width / 2 - pdfWidth / 2;
        const pdfY = page.mediaBox.height / 2 + pdfHeight / 2;

        const newImg: FloatingImage = {
          id: Math.random().toString(36).substr(2, 9),
          pdfX,
          pdfY,
          pdfWidth,
          pdfHeight,
          dataUrl: jpegDataUrl,
        };
        updateFloatingImages(prev => [...prev, newImg], 'add-image');
        setActiveFloatingImageId(newImg.id);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [doc, currentPage, renderResult, pushEditorHistory, updateFloatingImages]);

  const toEditableImage = useCallback((item: ImageItem): EditableObject => ({
    id: `sel-image-${item.name}`,
    kind: 'image',
    bbox: { x: item.x, y: item.y, width: item.width, height: item.height },
    ctm: item.ctm
      ? [item.ctm.a, item.ctm.b, item.ctm.c, item.ctm.d, item.ctm.e, item.ctm.f]
      : [item.width, 0, 0, item.height, item.x, item.y],
    source: item,
  }), []);

  const handleEmbeddedImageMove = useCallback(async (pdfDx: number, pdfDy: number) => {
    if (!doc || !engineRef.current || selectedDisplayItem?.type !== 'image') return;
    const item = selectedDisplayItem as ImageItem;
    const editable = toEditableImage(item);
    const moved = transformObject(editable, { dx: pdfDx, dy: pdfDy });
    await applyObjectTransform(doc, currentPage, editable, moved.ctm);
    pushEditorHistory('move-image');
    setIsDirty(true);
    setSelectedDisplayItem(null);
    setRenderKey(k => k + 1);
  }, [doc, currentPage, selectedDisplayItem, toEditableImage, pushEditorHistory]);

  const handleEmbeddedImageResize = useCallback(async (newWidth: number, newHeight: number) => {
    if (!doc || !engineRef.current || selectedDisplayItem?.type !== 'image') return;
    const item = selectedDisplayItem as ImageItem;
    const editable = toEditableImage(item);
    // Keep screen top-left fixed → PDF x fixed, top (y+h) fixed
    const top = item.y + item.height;
    const newY = top - newHeight;
    const newCtm = [newWidth, 0, 0, newHeight, item.x, newY];
    await applyObjectTransform(doc, currentPage, editable, newCtm);
    pushEditorHistory('resize-image');
    setIsDirty(true);
    setSelectedDisplayItem(null);
    setRenderKey(k => k + 1);
  }, [doc, currentPage, selectedDisplayItem, toEditableImage, pushEditorHistory]);

  const handleReplaceEmbeddedImage = useCallback(() => {
    if (selectedDisplayItem?.type !== 'image') return;
    replacingEmbeddedImageRef.current = selectedDisplayItem as ImageItem;
    replacingImageIdRef.current = null;
    fileInputRef.current?.click();
  }, [selectedDisplayItem]);

  const handleCopyEmbeddedImage = useCallback(async () => {
    if (!doc || !selectedDisplayItem || selectedDisplayItem.type !== 'image') return;
    const item = selectedDisplayItem as ImageItem;
    const page = doc.pages[currentPage];
    try {
      const dataUrl = await extractImageItemDataUrl(item, page, doc.objects);
      if (!dataUrl) return;

      // 1. Copy image to system clipboard if supported
      try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type || 'image/png']: blob }),
          ]);
        }
      } catch (clipErr) {
        console.warn('[Editor] System clipboard copy failed:', clipErr);
      }

      // 2. Duplicate as a floating image overlay on the page
      const newImg: FloatingImage = {
        id: `copy-img-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        pdfX: item.x + 20,
        pdfY: (item.y + item.height) - 20,
        pdfWidth: item.width,
        pdfHeight: item.height,
        dataUrl,
      };

      updateFloatingImages(prev => [...prev, newImg], 'copy-image');
      setActiveFloatingImageId(newImg.id);
    } catch (e) {
      console.error('[Editor] Copy image failed:', e);
    }
  }, [doc, currentPage, selectedDisplayItem, updateFloatingImages]);

  // ── Hidden / line input — preview only; PDF commits on submit ──
  const handleHiddenInput = useCallback((e: React.FormEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (!editingLine) return;
    const el = e.target as HTMLTextAreaElement | HTMLInputElement;
    const newVal = el.value;
    const oldVal = editTextRef.current;
    const sel = el.selectionStart ?? newVal.length;
    const delta = newVal.length - oldVal.length;
    const editAt = Math.min(sel - Math.max(0, delta), oldVal.length);


    if (delta !== 0 || newVal !== oldVal) {
      setEditStyleOverrides(prev => prev.flatMap(ov => {
        const next = remapStyleRange(ov.start, ov.end, editAt, delta);
        return next ? [{ ...ov, ...next }] : [];
      }).filter(ov => ov.end > ov.start));
      pendingStylesRef.current = pendingStylesRef.current.flatMap(p => {
        const next = remapStyleRange(p.start, p.end, editAt, delta);
        return next ? [{ ...p, ...next }] : [];
      }).filter(p => p.end > p.start);
    }

    // Inherit caret-local style, then let explicit typingStyle (sidebar) win.
    // Never inherit fontFamily — seeded display names strip Bold and would
    // force synthetic weight over the PDF face in the overlay.
    const anchor = editAnchorLineRef.current;
    const inherited = anchor
      ? resolveTypingStyleFromCaret(
          anchor,
          editAt,
          renderResult?.fonts,
          strokePaths,
          pendingStylesRef.current.map(p => ({
            start: p.start,
            end: p.end,
            bold: p.patch.bold,
            italic: p.patch.italic,
            underline: p.patch.underline,
            color: p.patch.color,
            fontSize: p.patch.fontSize,
          })),
          oldVal,
          initialRunTextRef.current || anchor.text,
        )
      : {};
    const explicit = typingStyleRef.current;
    const ts: TypingStyle = {
      ...inherited,
      ...explicit,
      // Only apply a font family the user picked in the sidebar
      ...(explicit.fontFamily != null ? { fontFamily: explicit.fontFamily } : { fontFamily: undefined }),
    };
    if (explicit.fontFamily == null) delete ts.fontFamily;

    // After deleting out of a sized override, drop sticky fontSize so neighbors
    // and further typing return to the surrounding size.
    if (delta < 0 && explicit.fontSize != null) {
      const stillInSized = pendingStylesRef.current.some(
        p => sel >= p.start && sel < p.end && p.patch.fontSize != null,
      );
      if (!stillInSized && inherited.fontSize != null && explicit.fontSize !== inherited.fontSize) {
        typingStyleRef.current = { ...explicit, fontSize: inherited.fontSize };
        ts.fontSize = inherited.fontSize;
        setTextFontSize(inherited.fontSize);
      }
    }

    // Only paint live overrides when style differs from the caret run.
    // Matching inserts stay in the run's span (no 1-glyph splits that break
    // bold face / underline continuity). Path underlines still need a
    // commit-only pending patch so the PDF underline extends.
    if (delta > 0) {
      const styleIdx = editAt > 0 ? editAt - 1 : 0;
      // Redistribute current text onto frozen runs — do NOT use raw anchor
      // indices (they walk into later segments as the caret advances).
      const destRun = anchor
        ? runAtDistributedEditIndex(
            anchor,
            initialRunTextRef.current || anchor.text,
            oldVal,
            styleIdx,
          )
        : null;
      const destFd = destRun && renderResult ? renderResult.fonts.get(destRun.fontName) : undefined;
      const destFlags = destRun
        ? resolveRunStyleFlags(destRun.fontName, destFd)
        : { bold: false, italic: false };
      const destUl = destRun
        ? !!(destRun.isUnderline || runHasPathUnderline(destRun, strokePaths))
        : false;
      const destFs = destRun ? visualFontSize(destRun) : 0;
      const colorDiffers = (() => {
        if (ts.color == null || !destRun?.fillColor) return ts.color != null && !destRun?.fillColor;
        const [r, g, b] = destRun.fillColor;
        const runHex = '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
        return ts.color.toLowerCase() !== runHex.toLowerCase();
      })();
      // Compare against the destination run — inherited color/size that already
      // match must NOT force live overrides (that split every glyph into its
      // own span and breaks bold/underline continuity).
      const differs =
        (ts.bold != null && ts.bold !== destFlags.bold)
        || (ts.italic != null && ts.italic !== destFlags.italic)
        || (ts.underline != null && ts.underline !== destUl)
        || (ts.fontSize != null && Math.abs(ts.fontSize - destFs) > 0.5)
        || (explicit.fontFamily != null)
        || colorDiffers;

      const insertStart = sel - delta;
      const insertEnd = sel;
      const insertedText = newVal.slice(insertStart, insertEnd);
      const onlyWhitespace = /^\s+$/.test(insertedText);

      if (differs) {
        // Only queue properties that actually differ from the destination run.
        // Seeded typingStyle always carries bold/italic/color — piggybacking those
        // onto a fontSize-only insert created per-glyph bold overrides and, for
        // spaces, bold-only commit patches that flipped neighboring unbold runs.
        const patch: Partial<TextStyleUI> = {};
        if (ts.bold != null && ts.bold !== destFlags.bold) patch.bold = ts.bold;
        if (ts.italic != null && ts.italic !== destFlags.italic) patch.italic = ts.italic;
        if (ts.underline != null && ts.underline !== destUl) patch.underline = ts.underline;
        if (ts.color != null && colorDiffers) patch.color = ts.color;
        // Spaces: never commit a larger fontSize (that invents rivers via trailing
        // shifts). Still paint typing-size spaces in the live overlay so the
        // caret doesn't look like it's arrow-skipping through the next word.
        if (ts.fontSize != null && !onlyWhitespace && Math.abs(ts.fontSize - destFs) > 0.5) {
          patch.fontSize = ts.fontSize;
        }
        if (explicit.fontFamily != null) patch.fontFamily = ts.fontFamily;
        const hasPatch = Object.keys(patch).length > 0;
        if (hasPatch) {
          pendingStylesRef.current = [...pendingStylesRef.current, { patch, start: insertStart, end: insertEnd }];
          setEditStyleOverrides(prev => [
            ...prev,
            {
              start: insertStart,
              end: insertEnd,
              bold: patch.bold,
              italic: patch.italic,
              underline: patch.underline,
              color: patch.color,
              fontSize: patch.fontSize,
              fontFamily: patch.fontFamily,
            },
          ]);
        }
        if (
          onlyWhitespace
          && ts.fontSize != null
          && Math.abs(ts.fontSize - destFs) > 0.5
        ) {
          setEditStyleOverrides(prev => [
            ...prev,
            { start: insertStart, end: insertEnd, fontSize: ts.fontSize },
          ]);
        }
      } else if (ts.underline && destRun && !destRun.isUnderline && runHasPathUnderline(destRun, strokePaths)) {
        // Path-drawn underline won't grow with new glyphs on commit
        pendingStylesRef.current = [
          ...pendingStylesRef.current,
          { patch: { underline: true }, start: insertStart, end: insertEnd },
        ];
      }
    }

    // Do NOT live-collapse spaces while typing — rewriting the textarea mid-
    // keystroke made Space feel broken (2nd+ press) and jumped the caret.
    // Rivers are still collapsed on commit (see handleEditSubmit).
    editTextRef.current = newVal;
    setEditText(newVal);
    setCaretPos(sel);
    const selEnd = el.selectionEnd ?? sel;
    editSelRef.current = { start: sel, end: selEnd };
    setEditSel({ start: sel, end: selEnd });
    caretVisibleRef.current = true;
  }, [editingLine, renderResult, strokePaths]);

  const handleHiddenKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the browser handle Ctrl+Z / Ctrl+Y for in-progress typing (native textarea undo).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y')) {
      e.stopPropagation();
      return;
    }
    if (!editingLine) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleEditSubmit();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      void handleDuplicateLineBelow();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleEditCancel();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      setTimeout(() => {
        const el = hiddenInputRef.current;
        if (!el) return;
        const start = el.selectionStart ?? caretPos;
        const end = el.selectionEnd ?? start;
        setCaretPos(start);
        editSelRef.current = { start, end };
        setEditSel({ start, end });
        caretVisibleRef.current = true;
      }, 0);
    }
  }, [editingLine, caretPos, handleEditSubmit, handleEditCancel, handleDuplicateLineBelow]);

  const handleHiddenBlur = useCallback(() => {
    if (!editingLine) return;
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = null;
      // Sidebar / font <select> uses data-keep-text-edit — keep edit open.
      // Do NOT refocus the textarea here or the native dropdown closes instantly.
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.('[data-keep-text-edit]')) {
        return;
      }
      if (editingLineRef.current) {
        handleEditSubmit();
      }
    }, 150);
  }, [editingLine, handleEditSubmit]);

  // ── Navigation handlers ──
  const goToPrev = useCallback(async () => {
    await commitDrawingsToPdf();
    closeLinkPopover();
    setLinkCreatePending(false);
    setCurrentPage(p => Math.max(0, p - 1));
  }, [commitDrawingsToPdf, closeLinkPopover]);

  const goToNext = useCallback(async () => {
    await commitDrawingsToPdf();
    closeLinkPopover();
    setLinkCreatePending(false);
    setCurrentPage(p => Math.min(totalPages - 1, p + 1));
  }, [totalPages, commitDrawingsToPdf, closeLinkPopover]);

  const zoomIn = useCallback(() => {
    setScale(s => Math.min(4, Math.round((s + 0.25) * 100) / 100));
  }, []);

  const zoomOut = useCallback(() => {
    setScale(s => Math.max(0.5, Math.round((s - 0.25) * 100) / 100));
  }, []);

  // On phones, open the document fitted to the screen width instead of at 100%.
  const fittedDocRef = useRef<PDFDocumentData | null>(null);
  useEffect(() => {
    if (!isMobile || !doc || fittedDocRef.current === doc) return;
    const viewport = scrollViewportRef.current;
    const firstPage = doc.pages[0];
    if (!viewport || !firstPage) return;
    fittedDocRef.current = doc;
    const fit = (viewport.clientWidth - 16) / firstPage.mediaBox.width;
    if (fit < 1) setScale(Math.max(0.5, Math.floor(fit * 100) / 100));
  }, [isMobile, doc]);

  // Trackpad pinch / Ctrl+wheel zoom (browsers fire wheel+ctrlKey for pinch)
  useEffect(() => {
    if (isLoading || !doc) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    let lastPageFlip = 0;
    const onWheel = (e: WheelEvent) => {
      // Plain wheel at the top or bottom edge of a page moves to the
      // neighbouring page (one page is shown at a time), throttled so one
      // flick doesn't skip several pages.
      if (!(e.ctrlKey || e.metaKey)) {
        const now = Date.now();
        if (now - lastPageFlip < 450 || Math.abs(e.deltaY) < 4) return;
        const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
        const atTop = viewport.scrollTop <= 1;
        if (e.deltaY > 0 && atBottom && currentPage < totalPages - 1) {
          lastPageFlip = now;
          e.preventDefault();
          void goToNext().then(() => { viewport.scrollTop = 0; });
        } else if (e.deltaY < 0 && atTop && currentPage > 0) {
          lastPageFlip = now;
          e.preventDefault();
          void goToPrev().then(() => {
            requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight; });
          });
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const intensity = Math.max(0.05, Math.min(0.25, Math.abs(e.deltaY) * 0.012));
      const direction = e.deltaY < 0 ? 1 : -1;
      setScale(s => {
        const next = s + direction * intensity;
        const clamped = Math.min(4, Math.max(0.5, next));
        return Math.round(clamped * 100) / 100;
      });
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [doc, isLoading, currentPage, totalPages, goToNext, goToPrev]);
  // ── Watermark Handlers ──
  const handleWatermarkImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setWatermarkImageFile(file);

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      const img = new window.Image();
      img.onload = () => {
        // Convert the image to JPEG using a canvas because the simplified PDF engine
        // only correctly supports image/jpeg (DCTDecode) without complex FlateDecode logic.
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // Fill with white background in case of transparent PNG
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);

          canvas.toBlob(blob => {
            if (blob) {
              blob.arrayBuffer().then(buf => {
                setWatermarkImageBytes(new Uint8Array(buf));
                setWatermarkImageDims({ width: img.naturalWidth, height: img.naturalHeight });

                // Override the file to be considered JPEG
                const jpegFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
                setWatermarkImageFile(jpegFile);
              });
            }
          }, 'image/jpeg', 0.9);
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, []);

  const handleWatermarkImageClear = useCallback(() => {
    setWatermarkImageFile(null);
    setWatermarkImageBytes(null);
    setWatermarkImageDims(null);
  }, []);

  const handleApplyWatermark = useCallback(() => {
    if (!doc || !engineRef.current) return;
    try {
      let wm: Watermark;

      const pageIndices: number[] = [];
      const totalPages = doc.pages.length;
      const fromIdx = Math.max(0, watermarkPageFrom - 1);
      const toIdx = Math.min(totalPages - 1, watermarkPageTo - 1);
      for (let i = fromIdx; i <= toIdx; i++) {
        pageIndices.push(i);
      }

      // Shrink a single oversized watermark to fit the smallest target page,
      // exactly as the preview does (BE-314).
      let fittedSize = watermarkSize;
      if (!watermarkMosaic) {
        const natural = watermarkNaturalSize(watermarkType, watermarkText, watermarkSize, watermarkImageDims, watermarkShapeType);
        let fit = 1;
        for (const idx of pageIndices) {
          const pg = doc.pages[idx];
          if (!pg) continue;
          const rot = ((pg.rotate % 360) + 360) % 360;
          const sideways = rot === 90 || rot === 270;
          const pw = sideways ? pg.mediaBox.height : pg.mediaBox.width;
          const ph = sideways ? pg.mediaBox.width : pg.mediaBox.height;
          fit = Math.min(fit, watermarkFitScale(natural.width, natural.height, watermarkRotation, pw, ph));
        }
        fittedSize = watermarkSize * fit;
      }

      if (watermarkType === 'text') {
        const r = parseInt(watermarkColor.slice(1, 3), 16) / 255;
        const g = parseInt(watermarkColor.slice(3, 5), 16) / 255;
        const b = parseInt(watermarkColor.slice(5, 7), 16) / 255;

        wm = {
          id: `wm-${Date.now()}`,
          type: 'text',
          text: watermarkText,
          opacity: watermarkOpacity / 100,
          blendMode: watermarkBlendMode,
          color: [r, g, b],
          rotation: watermarkRotation,
          tile: watermarkMosaic,
          layer: watermarkLayer,
          fontName: watermarkFontName,
          fontSize: Math.max(1, Math.round(72 * (fittedSize / 100))),
          position: watermarkPosition,
          pageIndices
        };
      } else if (watermarkType === 'shape') {
        const r = parseInt(watermarkColor.slice(1, 3), 16) / 255;
        const g = parseInt(watermarkColor.slice(3, 5), 16) / 255;
        const b = parseInt(watermarkColor.slice(5, 7), 16) / 255;

        const sr = parseInt(watermarkShapeColor.slice(1, 3), 16) / 255;
        const sg = parseInt(watermarkShapeColor.slice(3, 5), 16) / 255;
        const sb = parseInt(watermarkShapeColor.slice(5, 7), 16) / 255;

        const fontSizePt = Math.max(1, Math.round(72 * (fittedSize / 100)));
        const textWidth = watermarkText.length * fontSizePt * 0.5;

        let finalWidth = textWidth + 40;
        let finalHeight = fontSizePt + 40;
        if (watermarkShapeType === 'circle') {
          const maxDim = Math.max(finalWidth, finalHeight);
          finalWidth = maxDim;
          finalHeight = maxDim;
        }

        wm = {
          id: `wm-${Date.now()}`,
          type: 'shape',
          shape: watermarkShapeType,
          text: watermarkText,
          fontName: watermarkFontName,
          fontSize: fontSizePt,
          textColor: [r, g, b],
          shapeColor: [sr, sg, sb],
          width: finalWidth,
          height: finalHeight,
          opacity: watermarkOpacity / 100,
          blendMode: watermarkBlendMode,
          rotation: watermarkRotation,
          tile: watermarkMosaic,
          layer: watermarkLayer,
          position: watermarkPosition,
          pageIndices
        };
      } else {
        if (!watermarkImageBytes || !watermarkImageDims || !watermarkImageFile) {
          setError('Please upload an image first');
          return;
        }

        const mimeType = watermarkImageFile.type === 'image/png' ? 'image/png' : 'image/jpeg';

        wm = {
          id: `wm-${Date.now()}`,
          type: 'image',
          imageBytes: watermarkImageBytes,
          mimeType,
          width: watermarkImageDims.width * (fittedSize / 100),
          height: watermarkImageDims.height * (fittedSize / 100),
          opacity: watermarkOpacity / 100,
          blendMode: watermarkBlendMode,
          rotation: watermarkRotation,
          tile: watermarkMosaic,
          layer: watermarkLayer,
          position: watermarkPosition,
          pageIndices
        };
      }

      const results = engineRef.current.applyWatermarks(doc, [wm], () => engineRef.current!.getNextObjNum(doc));

      const updatePromises: Promise<unknown>[] = [];
      results.forEach((newBytes, pageIdx) => {
        const page = doc.pages[pageIdx];
        updatePromises.push(
          engineRef.current!.updatePageContent(page.contentRefs, newBytes, doc.objects)
        );
      });

      Promise.all(updatePromises).then(() => {
        setDoc({ ...doc });
        setRenderKey(k => k + 1);
        setWatermarkLivePreview(false);
        setIsDirty(true);
        setShowApplySuccessModal(true);
      }).catch(err => {
        console.error('[Editor] Apply watermark failed:', err);
        setError(actionErrorMessage('Couldn\'t apply the watermark', err));
      });
    } catch (e) {
      console.error('[Editor] Apply watermark failed:', e);
      setError(actionErrorMessage('Couldn\'t apply the watermark', e));
    }
  }, [doc, watermarkType, watermarkText, watermarkFontName, watermarkOpacity, watermarkRotation, watermarkSize, watermarkPosition, watermarkMosaic, watermarkPageFrom, watermarkPageTo, watermarkLayer, watermarkColor, watermarkShapeColor, watermarkShapeType, watermarkImageBytes, watermarkImageDims, watermarkImageFile, watermarkBlendMode]);

  // ── Signature handlers ──
  const resolveSignatureImage = useCallback((sig: VisualSignature): string | null => {
    const entry = getSignatureLibrary().get(sig.appearanceId);
    return entry?.imageDataUrl ?? null;
  }, []);

  const handleSignatureSelect = useCallback((id: string) => {
    setSelectedSignatureId(id);
    setSelectedDisplayItem(null);
  }, []);

  const handleSignatureMove = useCallback((id: string, dx: number, dy: number) => {
    const next = updateSignature(signaturesRef.current, id, (s) => moveSignature(s, dx, dy));
    pushSignatureSnapshot(next, 'move-signature');
  }, [pushSignatureSnapshot]);

  const handleSignatureResize = useCallback((id: string, width: number, height: number) => {
    const next = updateSignature(signaturesRef.current, id, (s) => resizeSignature(s, width, height));
    pushSignatureSnapshot(next, 'resize-signature');
  }, [pushSignatureSnapshot]);

  const handleSignatureRotate = useCallback((id: string, degrees: number) => {
    const next = updateSignature(signaturesRef.current, id, (s) => rotateSignature(s, degrees));
    pushSignatureSnapshot(next, 'rotate-signature');
  }, [pushSignatureSnapshot]);

  const handleSignatureDelete = useCallback((id: string) => {
    const next = deleteSignature(signaturesRef.current, id);
    pushSignatureSnapshot(next, 'delete-signature');
    if (selectedSignatureId === id) setSelectedSignatureId(null);
  }, [pushSignatureSnapshot, selectedSignatureId]);

  const handleSignatureOpacity = useCallback((id: string, opacity: number) => {
    const next = updateSignature(signaturesRef.current, id, (s) => setSignatureOpacity(s, opacity));
    pushSignatureSnapshot(next, 'opacity-signature');
  }, [pushSignatureSnapshot]);

  const handleSignatureLockToggle = useCallback((id: string) => {
    const next = updateSignature(signaturesRef.current, id, (s) => setSignatureLocked(s, !s.locked));
    pushSignatureSnapshot(next, 'lock-signature');
  }, [pushSignatureSnapshot]);

  const handleSignatureCreateSave = useCallback((result: SignatureCreateResult) => {
    const entry = getSignatureLibrary().add({
      ...result.entry,
      favorite: false,
    });
    refreshSignatureLibrary();
    setActiveLibraryId(entry.id);
  }, [refreshSignatureLibrary]);

  const handleLibraryRename = useCallback((id: string, name: string) => {
    getSignatureLibrary().rename(id, name);
    refreshSignatureLibrary();
  }, [refreshSignatureLibrary]);

  const handleLibraryDelete = useCallback((id: string) => {
    getSignatureLibrary().delete(id);
    if (activeLibraryId === id) setActiveLibraryId(null);
    refreshSignatureLibrary();
  }, [activeLibraryId, refreshSignatureLibrary]);

  const handleLibraryDuplicate = useCallback((id: string) => {
    const dup = getSignatureLibrary().duplicate(id);
    if (dup) {
      setActiveLibraryId(dup.id);
      refreshSignatureLibrary();
    }
  }, [refreshSignatureLibrary]);

  const handleLibraryFavorite = useCallback((id: string) => {
    getSignatureLibrary().toggleFavorite(id);
    refreshSignatureLibrary();
  }, [refreshSignatureLibrary]);

  const handleScanWatermarks = useCallback(() => {
    if (!doc || !engineRef.current) return;
    try {
      const detections = engineRef.current.detectWatermarks(doc);
      setDetectedWatermarks(detections);
    } catch (e) {
      console.error('[Editor] Scan watermarks failed:', e);
      setError(actionErrorMessage('Couldn\'t look for watermarks', e));
    }
  }, [doc]);

  const handleConfirmRemoveWatermarks = useCallback(() => {
    setIsConfirmingRemoval(true);
  }, []);

  const executeRemoveWatermarks = useCallback(() => {
    if (!doc || !engineRef.current || !detectedWatermarks) return;
    try {
      const removal = engineRef.current.removeWatermarks(doc, detectedWatermarks);
      console.log('[Editor] Removed watermarks:', removal);
      setDoc({ ...doc });
      setRenderKey(k => k + 1);
      setDetectedWatermarks(null);
      setIsConfirmingRemoval(false);
      setIsDirty(true);
    } catch (e) {
      console.error('[Editor] Remove watermarks failed:', e);
      setError(actionErrorMessage('Couldn\'t remove the watermarks', e));
    }
  }, [doc, detectedWatermarks]);

  const handleCancelScan = useCallback(() => {
    setDetectedWatermarks(null);
  }, []);


  /** Current edited PDF for Bloom structure conversion (Export → Document convert). */
  const getPdfBytesForConvert = useCallback(async (): Promise<Uint8Array> => {
    if (!doc || !engineRef.current) {
      throw new Error('No document loaded');
    }
    // Prefer original PDF bytes when there are no edits. saveQuick() re-serializes
    // content and currently drops non-black text fill colors / some vector paints,
    // which destroys green headings and table fills in Word export.
    const raw = doc.rawBytes;
    if (!isDirty && raw && raw.byteLength > 5) {
      return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    }
    const exportDoc = await createExportDocWithOverlays(
      doc,
      currentPage,
      drawnPathsRef.current,
      floatingTextsRef.current,
      floatingImagesRef.current
    );
    const bytes = await engineRef.current.saveQuick(exportDoc);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }, [doc, currentPage, isDirty, createExportDocWithOverlays]);

  // ── Download / Save ──
  const handleDownload = useCallback(async () => {
    if (!doc || !engineRef.current) return;
    try {
      setIsSaving(true);
      const engine = engineRef.current;
      const raw = doc.rawBytes;
      const noOverlays =
        drawnPathsRef.current.length === 0 &&
        floatingTextsRef.current.length === 0 &&
        floatingImagesRef.current.length === 0;
      // Nothing changed (or only a signature was just added): return the file
      // byte-for-byte, which keeps existing digital signatures valid.
      const untouched =
        noOverlays &&
        !!raw && raw.byteLength > 5 &&
        (signedPristineRef.current || (!isDirty && signaturesRef.current.length === 0));
      let bytes: Uint8Array;
      if (untouched) {
        bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      } else {
        const exportDoc = await createExportDocWithOverlays(
          doc,
          currentPage,
          drawnPathsRef.current,
          floatingTextsRef.current,
          floatingImagesRef.current
        );
        bytes = saveMode === 'quick'
          ? await engine.saveQuick(exportDoc)
          : await engine.saveOptimized(exportDoc);
      }
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'edited.pdf';
      a.click();
      URL.revokeObjectURL(url);
      const keepSigned = signedPristineRef.current;
      setIsDirty(false);
      signedPristineRef.current = keepSigned;
    } catch (e) {
      console.error('[Editor] Download failed:', e);
      setError(actionErrorMessage('Couldn\'t prepare the download', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, fileName, saveMode, isDirty, setIsDirty, createExportDocWithOverlays]);

  // ── Compressed Download ──
  const [signedCompressOpen, setSignedCompressOpen] = useState(false);
  const signedCompressResolveRef = useRef<((choice: SignedCompressChoice) => void) | null>(null);
  const chooseSignedCompress = useCallback((choice: SignedCompressChoice) => {
    setSignedCompressOpen(false);
    signedCompressResolveRef.current?.(choice);
    signedCompressResolveRef.current = null;
  }, []);

  const handleCompressedDownload = useCallback(async (opts: {
    quality: number;
    dpi: number;
    targetBytes?: number;
  }) => {
    if (!doc || !engineRef.current) return;
    if (hasDigitalSignature(doc.rawBytes)) {
      const choice = await new Promise<SignedCompressChoice>((resolve) => {
        signedCompressResolveRef.current = resolve;
        setSignedCompressOpen(true);
      });
      if (choice === 'cancel') return;
      if (choice === 'signed') {
        await handleDownload();
        return;
      }
    }
    try {
      setIsSaving(true);
      setError(null);
      const exportDoc = await createExportDocWithOverlays(
        doc,
        currentPage,
        drawnPathsRef.current,
        floatingTextsRef.current,
        floatingImagesRef.current
      );
      const engine = engineRef.current;
      const originalLen = doc.rawBytes?.length ?? 0;

      const result = await engine.compressDocumentImages(exportDoc, {
        quality: opts.quality,
        dpi: opts.dpi,
        targetBytes: opts.targetBytes,
      });

      // Hard safety: never hand the user a bigger file than they started with
      let outBytes = result.bytes;
      let outLen = result.compressedBytes;
      let note = result.message;
      if (originalLen > 0 && outLen > originalLen) {
        outBytes = doc.rawBytes!;
        outLen = originalLen;
        note = `Compression produced a larger file (${(result.compressedBytes / 1024).toFixed(1)} KB). Kept original ${(originalLen / 1024).toFixed(1)} KB instead.`;
      }

      console.log('[Compress]', note, {
        method: result.method,
        originalBytes: originalLen,
        compressedBytes: outLen,
      });

      const blob = new Blob([outBytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const base = (fileName || 'document.pdf').replace(/\.pdf$/i, '');
      a.download =
        outLen < originalLen * 0.98 ? `${base}_compressed.pdf` : `${base}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (result.targetMissed || result.method === 'unchanged' || outLen >= originalLen) {
        setError(note);
      } else {
        setError(null);
      }
      setIsDirty(false);
    } catch (e) {
      console.error('[Editor] Compressed download failed:', e);
      setError(actionErrorMessage('Couldn\'t compress the PDF', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, fileName, createExportDocWithOverlays, handleDownload]);

  const handleClose = useCallback(async () => {
    await clearEditorSession();
    await clearPdfFromStorage();
    router.push('/');
  }, [router]);

  // ── Page Operations ──
  const refreshAfterPageOp = useCallback((nextDoc: PDFDocumentData, nextCurrentPage?: number) => {
    setDoc({ ...nextDoc });
    setTotalPages(nextDoc.pages.length);
    if (nextCurrentPage != null) {
      setCurrentPage(Math.max(0, Math.min(nextCurrentPage, nextDoc.pages.length - 1)));
    } else if (currentPage >= nextDoc.pages.length) {
      setCurrentPage(Math.max(0, nextDoc.pages.length - 1));
    }
    setIsDirty(true);
    setRenderKey((k) => k + 1);
    setThumbnailKey((k) => k + 1);
  }, [currentPage]);

  const downloadPdfBytes = useCallback((bytes: Uint8Array, name: string) => {
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleDeletePage = useCallback((index: number) => {
    if (!doc || !engineRef.current) return;
    try {
      engineRef.current.deletePage(doc, index);
      let nextPage = currentPage;
      if (currentPage === index) {
        nextPage = Math.min(index, doc.pages.length - 1);
      } else if (currentPage > index) {
        nextPage = currentPage - 1;
      }
      refreshAfterPageOp(doc, nextPage);
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t delete the page', e));
    }
  }, [doc, currentPage, refreshAfterPageOp]);

  const handleRotatePage = useCallback((index: number) => {
    if (!doc || !engineRef.current) return;
    try {
      engineRef.current.rotatePageBy(doc, index, 90);
      refreshAfterPageOp(doc);
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t rotate the page', e));
    }
  }, [doc, refreshAfterPageOp]);

  const handleReorderPages = useCallback((fromIndex: number, toIndex: number) => {
    if (!doc || !engineRef.current || fromIndex === toIndex) return;
    try {
      engineRef.current.movePage(doc, fromIndex, toIndex);
      let nextPage = currentPage;
      if (currentPage === fromIndex) {
        nextPage = toIndex;
      } else if (fromIndex < toIndex) {
        if (currentPage > fromIndex && currentPage <= toIndex) nextPage = currentPage - 1;
      } else if (currentPage >= toIndex && currentPage < fromIndex) {
        nextPage = currentPage + 1;
      }
      refreshAfterPageOp(doc, nextPage);
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t reorder the pages', e));
    }
  }, [doc, currentPage, refreshAfterPageOp]);

  const handleMergePdf = useCallback(async (file: File) => {
    if (!doc || !engineRef.current) return;
    try {
      const buffer = await file.arrayBuffer();
      const sourceDoc = await engineRef.current.parsePDF(new Uint8Array(buffer));
      const insertAt = doc.pages.length;
      engineRef.current.insertPagesFromDocument(doc, sourceDoc, insertAt);
      refreshAfterPageOp(doc);
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t merge the PDF', e));
    }
  }, [doc, refreshAfterPageOp]);

  const handleSplitCurrentPage = useCallback(async () => {
    if (!doc || !engineRef.current) return;
    try {
      setIsSaving(true);
      const exportDoc = await createExportDocWithOverlays(
        doc,
        currentPage,
        drawnPathsRef.current,
        floatingTextsRef.current,
        floatingImagesRef.current
      );
      const engine = engineRef.current;
      const extracted = engine.extractPages(exportDoc, [currentPage]);
      const bytes = await engine.saveQuick(extracted);
      const base = (fileName || 'document').replace(/\.pdf$/i, '');
      downloadPdfBytes(bytes, `${base}-page-${currentPage + 1}.pdf`);
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t split the page', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, fileName, downloadPdfBytes, createExportDocWithOverlays]);

  const handleSplitAllPages = useCallback(async () => {
    if (!doc || !engineRef.current) return;
    if (doc.pages.length < 2) return;
    const ok = window.confirm(
      `Download ${doc.pages.length} separate PDF files (one per page)?`,
    );
    if (!ok) return;
    try {
      setIsSaving(true);
      const exportDoc = await createExportDocWithOverlays(
        doc,
        currentPage,
        drawnPathsRef.current,
        floatingTextsRef.current,
        floatingImagesRef.current
      );
      const engine = engineRef.current;
      const base = (fileName || 'document').replace(/\.pdf$/i, '');
      for (let i = 0; i < exportDoc.pages.length; i++) {
        const extracted = engine.extractPages(exportDoc, [i]);
        const bytes = await engine.saveQuick(extracted);
        downloadPdfBytes(bytes, `${base}-page-${i + 1}.pdf`);
        // Brief pause so the browser doesn't coalesce / block downloads
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t split the pages', e));
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, fileName, downloadPdfBytes, createExportDocWithOverlays]);

  const handleRemoveCurrentPage = useCallback(() => {
    if (!doc || doc.pages.length <= 1) return;
    if (!window.confirm(`Remove page ${currentPage + 1}?`)) return;
    handleDeletePage(currentPage);
  }, [doc, currentPage, handleDeletePage]);

  const handleDeleteSelectedDisplayItem = useCallback(async () => {
    if (!doc || !engineRef.current || !selectedDisplayItem) return;
    try {
      const engine = engineRef.current;
      const page = doc.pages[currentPage];
      const item = selectedDisplayItem;

      // Warn when removing a near-full-page image (common for scanned certificates)
      if (item.type === 'image') {
        const pageArea = Math.max(1, page.mediaBox.width * page.mediaBox.height);
        const imgArea = Math.max(0, item.width) * Math.max(0, item.height);
        if (imgArea / pageArea >= 0.5) {
          const ok = window.confirm(
            'This image covers most of the page. Deleting it will remove most of what you see. Continue?',
          );
          if (!ok) return;
        }

        // Extract image data to store in removed images bin
        try {
          const dataUrl = await extractImageItemDataUrl(item, page, doc.objects);
          if (dataUrl) {
            const record: RemovedImageRecord = {
              id: `removed-img-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
              dataUrl,
              name: item.name,
              fileName,
              sourceType: 'embedded',
              originalPage: currentPage,
              originalBounds: {
                x: item.x,
                y: item.y,
                width: item.width,
                height: item.height,
              },
              deletedAt: Date.now(),
            };
            setRemovedImages(prev => {
              const isDuplicate = prev.some(r => r.dataUrl === dataUrl);
              if (isDuplicate) return prev;
              const updated = [record, ...prev.filter(r => !(r.originalPage === currentPage && r.name === item.name))];
              saveRemovedImages(updated);
              return updated;
            });
          }
        } catch (extractErr) {
          console.warn('[Editor] Failed to extract image for removed bin:', extractErr);
        }
      }

      const editable: EditableObject = {
        id: `sel-${item.type}`,
        kind: item.type,
        bbox: { x: item.x, y: item.y, width: item.width, height: item.height },
        ctm:
          item.type === 'image' && item.ctm
            ? [item.ctm.a, item.ctm.b, item.ctm.c, item.ctm.d, item.ctm.e, item.ctm.f]
            : [1, 0, 0, 1, 0, 0],
        source: item,
      };

      await deleteObject(doc, currentPage, editable);
      pushEditorHistory(`delete-${item.type}`);
      setSelectedDisplayItem(null);
      setIsDirty(true);
      setRenderKey(k => k + 1);
      setThumbnailKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Delete object failed:', e);
      setError(actionErrorMessage('Couldn\'t delete that', e));
    }
  }, [doc, currentPage, selectedDisplayItem, fileName, pushEditorHistory]);

  const handleRestoreRemovedImage = useCallback((record: RemovedImageRecord) => {
    if (!doc) return;
    const targetPage = (record.originalPage >= 0 && record.originalPage < doc.pages.length)
      ? record.originalPage
      : currentPage;

    if (targetPage !== currentPage) {
      setCurrentPage(targetPage);
    }

    const pdfY = record.sourceType === 'floating'
      ? record.originalBounds.y
      : record.originalBounds.y + record.originalBounds.height;

    const newFloatingImage: FloatingImage = {
      id: `restored-img-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      pdfX: record.originalBounds.x,
      pdfY: pdfY,
      pdfWidth: record.originalBounds.width,
      pdfHeight: record.originalBounds.height,
      dataUrl: record.dataUrl,
    };

    updateFloatingImages(prev => [...prev, newFloatingImage], 'restore-image');
    setActiveFloatingImageId(newFloatingImage.id);
    // A restored image leaves the bin, so it can't be restored twice (BE-310).
    setRemovedImages(prev => {
      const next = prev.filter(r => r.id !== record.id);
      void saveRemovedImages(next);
      return next;
    });
  }, [doc, currentPage, updateFloatingImages]);

  const handleInsertRemovedImage = useCallback((record: RemovedImageRecord) => {
    if (!doc) return;
    const page = doc.pages[currentPage];
    const pageW = page?.mediaBox.width || 612;
    const pageH = page?.mediaBox.height || 792;

    const fitW = Math.min(record.originalBounds.width || 200, pageW * 0.7);
    const fitH = (fitW / (record.originalBounds.width || 1)) * (record.originalBounds.height || fitW);

    const pdfX = Math.max(20, (pageW - fitW) / 2);
    const pdfY = Math.max(20, (pageH + fitH) / 2);

    const newFloatingImage: FloatingImage = {
      id: `inserted-img-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      pdfX,
      pdfY,
      pdfWidth: fitW,
      pdfHeight: fitH,
      dataUrl: record.dataUrl,
    };

    updateFloatingImages(prev => [...prev, newFloatingImage], 'restore-image');
    setActiveFloatingImageId(newFloatingImage.id);
  }, [doc, currentPage, updateFloatingImages]);

  const handleDeleteRemovedImage = useCallback((id: string) => {
    setRemovedImages(prev => {
      const updated = prev.filter(r => r.id !== id);
      saveRemovedImages(updated);
      return updated;
    });
  }, []);

  const handleClearRemovedImages = useCallback(() => {
    setRemovedImages([]);
    clearRemovedImages();
  }, []);

  const handleInsertBlankPage = useCallback((index: number) => {
    if (!doc || !engineRef.current) return;
    try {
      engineRef.current.insertBlankPage(doc, index);
      const nextPage = currentPage >= index ? currentPage + 1 : currentPage;
      refreshAfterPageOp(doc, nextPage);
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t insert a blank page', e));
    }
  }, [doc, currentPage, refreshAfterPageOp]);

  const handleInsertPdf = useCallback(async (index: number, file: File) => {
    if (!doc || !engineRef.current) return;
    try {
      const buffer = await file.arrayBuffer();
      const sourceDoc = await engineRef.current.parsePDF(new Uint8Array(buffer));
      engineRef.current.insertPagesFromDocument(doc, sourceDoc, index);
      const nextPage = currentPage >= index ? currentPage + sourceDoc.pages.length : currentPage;
      refreshAfterPageOp(doc, nextPage);
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t insert the PDF', e));
    }
  }, [doc, currentPage, refreshAfterPageOp]);


  // ── Keyboard shortcuts (global — NOT during editing) ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Zoom works everywhere, including while a line or text box is being edited (BE-111).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
        e.preventDefault();
        if (e.key === '-' || e.key === '_') zoomOut();
        else zoomIn();
        return;
      }
      // Don't intercept when the hidden input has focus (editing)
      if (editingLine) return;

      // Don't intercept when the user is typing in any text box, input or dropdown
      const focusedTag = document.activeElement?.tagName;
      if (focusedTag === 'INPUT' || focusedTag === 'TEXTAREA' || focusedTag === 'SELECT') return;
      if ((document.activeElement as HTMLElement | null)?.isContentEditable) return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault(); goToPrev();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault(); goToNext();
      } else if (e.key === '+' || e.key === '=') {
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); zoomIn(); }
      } else if (e.key === '-') {
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); zoomOut(); }
      } else if ((e.key === 'v' || e.key === 'V') && e.shiftKey && !e.metaKey && !e.ctrlKey && activeTool === 'sign') {
        // SIGNATURE_SHORTCUTS.validate (undo/redo live in the document-level handler above)
        e.preventDefault();
        void handleValidateSignatures();
      } else if (e.key === 'v' || e.key === 'V') {
        if (!e.metaKey && !e.ctrlKey) setActiveTool('select');
      } else if (e.key === 't' || e.key === 'T') {
        if (!e.metaKey && !e.ctrlKey) setActiveTool('text');
      } else if (e.key === 'd' || e.key === 'D') {
        if (!e.metaKey && !e.ctrlKey) setActiveTool('draw');
      } else if (e.key === 'h' || e.key === 'H') {
        if (!e.metaKey && !e.ctrlKey) setActiveTool('highlight');
      } else if (e.key === 'p' || e.key === 'P') {
        if (!e.metaKey && !e.ctrlKey) setActiveTool('draw');
      } else if (e.key === 'e' || e.key === 'E') {
        if (!e.metaKey && !e.ctrlKey) setActiveTool('erase');
      } else if (e.key === 's' || e.key === 'S') {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey) setActiveTool('sign');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDrawing) {
        e.preventDefault();
        handleDeleteSelectedDrawing();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedSignatureId) {
        e.preventDefault();
        handleSignatureDelete(selectedSignatureId);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDisplayItem) {
        e.preventDefault();
        void handleDeleteSelectedDisplayItem();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && activeFloatingImageId) {
        e.preventDefault();
        const fi = floatingImages.find(f => f.id === activeFloatingImageId);
        if (fi && fi.dataUrl) {
          const record: RemovedImageRecord = {
            id: `removed-fi-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            dataUrl: fi.dataUrl,
            name: `Image ${fi.id}`,
            fileName,
            sourceType: 'floating',
            originalPage: currentPage,
            originalBounds: {
              x: fi.pdfX,
              y: fi.pdfY,
              width: fi.pdfWidth,
              height: fi.pdfHeight,
            },
            deletedAt: Date.now(),
          };
          setRemovedImages(prev => {
            const isDuplicate = prev.some(r => r.dataUrl === fi.dataUrl);
            if (isDuplicate) return prev;
            const updated = [record, ...prev];
            saveRemovedImages(updated);
            return updated;
          });
        }
        updateFloatingImages(prev => prev.filter(p => p.id !== activeFloatingImageId), 'delete-image');
        setActiveFloatingImageId(null);
      } else if (e.key === 'r' || e.key === 'R') {
        if (!e.metaKey && !e.ctrlKey) setActiveTool('redact');
      } else if (e.key === 'l' || e.key === 'L') {
        if (!e.metaKey && !e.ctrlKey) selectTool('link');
      } else if (e.key === 'w' || e.key === 'W') {
        if (!e.metaKey && !e.ctrlKey) setActiveTool('watermark');
      } else if (e.key === 'x' || e.key === 'X') {
        if (!e.metaKey && !e.ctrlKey) {
          setActiveTool('security');
          setIsPanelOpen(true);
        }
      } else if ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsSearchOpen(v => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectTool, goToPrev, goToNext, zoomIn, zoomOut, editingLine, selectedSignatureId, handleSignatureDelete, selectedDisplayItem, handleDeleteSelectedDisplayItem, activeFloatingImageId, floatingImages, fileName, currentPage, activeTool, handleValidateSignatures, updateFloatingImages, selectedDrawing, handleDeleteSelectedDrawing]);

  // ── Global clipboard paste listener for images (Ctrl+V on Windows / Cmd+V on Mac) ──
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Don't intercept when user is typing in an input or textarea
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
         target.tagName === 'TEXTAREA' ||
         target.isContentEditable)
      ) {
        return;
      }

      if (!doc) return;
      const page = doc.pages[currentPage];
      if (!page) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;

          const reader = new FileReader();
          reader.onload = (re) => {
            const dataUrl = re.target?.result as string;
            if (!dataUrl) return;

            const img = new window.Image();
            img.onload = () => {
              let pdfWidth = img.width;
              let pdfHeight = img.height;
              const maxDim = 200;
              if (pdfWidth > maxDim || pdfHeight > maxDim) {
                const ratio = Math.min(maxDim / pdfWidth, maxDim / pdfHeight);
                pdfWidth *= ratio;
                pdfHeight *= ratio;
              }

              // Center on the page
              const pdfX = Math.max(0, page.mediaBox.width / 2 - pdfWidth / 2);
              const pdfY = Math.min(page.mediaBox.height, page.mediaBox.height / 2 + pdfHeight / 2);

              let jpegDataUrl = dataUrl;
              try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || pdfWidth;
                canvas.height = img.naturalHeight || pdfHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.fillStyle = '#ffffff';
                  ctx.fillRect(0, 0, canvas.width, canvas.height);
                  ctx.drawImage(img, 0, 0);
                  jpegDataUrl = canvas.toDataURL('image/jpeg', 0.95);
                }
              } catch {}

              const newImg: FloatingImage = {
                id: Math.random().toString(36).substr(2, 9),
                pdfX,
                pdfY,
                pdfWidth,
                pdfHeight,
                dataUrl: jpegDataUrl,
                rotation: 0,
              };

              updateFloatingImages(prev => [...prev, newImg], 'paste-image');
              setActiveFloatingImageId(newImg.id);
            };
            img.src = dataUrl;
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [doc, currentPage, updateFloatingImages]);

  // Clean, Minimalist 3D Tilted Pink Square Rubber Block Eraser Cursor
  const eraser3dSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><filter id="er-pinksq-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="1" dy="1.4" stdDeviation="1.2" flood-color="#000000" flood-opacity="0.45"/></filter><linearGradient id="er-pink-top" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FFA8E0"/><stop offset="60%" stop-color="#FF65C8"/><stop offset="100%" stop-color="#E840A8"/></linearGradient><linearGradient id="er-pink-left" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF52B7"/><stop offset="100%" stop-color="#D6208A"/></linearGradient><linearGradient id="er-pink-right" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#BF157A"/><stop offset="100%" stop-color="#80094F"/></linearGradient></defs><g filter="url(#er-pinksq-shadow)"><path d="M 4 16 L 16 4 L 28 16 L 28 19 L 16 31 L 4 19 Z" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/><path d="M 4 16 L 16 4 L 28 16 L 16 28 Z" fill="url(#er-pink-top)" stroke="#80094F" stroke-width="0.6"/><path d="M 4 16 L 16 28 L 16 31 L 4 19 Z" fill="url(#er-pink-left)" stroke="#80094F" stroke-width="0.6"/><path d="M 16 28 L 28 16 L 28 19 L 16 31 Z" fill="url(#er-pink-right)" stroke="#80094F" stroke-width="0.6"/><path d="M 4 16 L 16 4 L 22 10 L 10 22 Z" fill="#FFFFFF" fill-opacity="0.45"/><circle cx="4" cy="28" r="0.8" fill="#FFFFFF" stroke="#80094F" stroke-width="0.4"/></g></svg>`;
  const eraserCursorUrl = `url('data:image/svg+xml;utf8,${encodeURIComponent(eraser3dSvg)}') 4 28, auto`;

  // Hyper-Realistic 3D Apple Pencil Replica Cursor with active drawColor tip, chrome collar, ceramic cylinder body, and color cap band
  const drawPenSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><filter id="pen3d-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="1" dy="1.2" stdDeviation="1" flood-color="#000000" flood-opacity="0.5"/></filter><linearGradient id="pen3d-chrome" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E5E5EA"/><stop offset="25%" stop-color="#FFFFFF"/><stop offset="50%" stop-color="#A2A2A7"/><stop offset="80%" stop-color="#636366"/><stop offset="100%" stop-color="#2C2C2E"/></linearGradient><linearGradient id="pen3d-body" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FFFFFF"/><stop offset="45%" stop-color="#F2F2F7"/><stop offset="80%" stop-color="#E5E5EA"/><stop offset="100%" stop-color="#D1D1D6"/></linearGradient><linearGradient id="pen3d-cap-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#F2F2F7"/><stop offset="50%" stop-color="#A2A2A7"/><stop offset="100%" stop-color="#3A3A3C"/></linearGradient></defs><g filter="url(#pen3d-shadow)"><path d="M 1 31 L 5 21 L 9 16 L 23 2 L 30 9 L 16 23 L 11 27 Z" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.95"/><path d="M 9 16 L 23 2 L 30 9 L 16 23 Z" fill="url(#pen3d-body)" stroke="#2C2C2E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 9 16 L 23 2 L 26 5 L 12 19 Z" fill="#FFFFFF" fill-opacity="0.6"/><line x1="12" y1="19" x2="26" y2="5" stroke="#D1D1D6" stroke-width="0.5"/><path d="M 12 19 L 26 5 L 30 9 L 16 23 Z" fill="#000000" fill-opacity="0.12"/><path d="M 18 7 L 23 2 L 28 7 L 23 12 Z" fill="${drawColor}" stroke="#2C2C2E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 18 7 L 23 2 L 25.5 4.5 L 20.5 9.5 Z" fill="#FFFFFF" fill-opacity="0.4"/><path d="M 20.5 9.5 L 25.5 4.5 L 28 7 L 23 12 Z" fill="#000000" fill-opacity="0.25"/><path d="M 23 2 L 25 -0.5 C 27 -0.5 30 2.5 30.5 4.5 L 28 7 Z" fill="url(#pen3d-cap-ring)" stroke="#1C1C1E" stroke-width="0.7"/><path d="M 5 21 L 9 16 L 16 23 L 11 27 Z" fill="url(#pen3d-chrome)" stroke="#2C2C2E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 1 31 L 5 21 L 11 27 Z" fill="#F4F4F6" stroke="#2C2C2E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 1 31 L 5 21 L 8 24 Z" fill="#FFFFFF" fill-opacity="0.5"/><path d="M 1 31 L 3.5 25 L 7 28.5 Z" fill="${drawColor}" stroke="#1C1C1E" stroke-width="0.6" stroke-linejoin="round"/><path d="M 1 31 L 3.5 25 L 5.25 26.75 Z" fill="#FFFFFF" fill-opacity="0.45"/><path d="M 1 31 L 5.25 26.75 L 7 28.5 Z" fill="#000000" fill-opacity="0.2"/><circle cx="1" cy="31" r="0.75" fill="#FFFFFF" stroke="#000000" stroke-width="0.4"/></g></svg>`;
  const penCursorUrl = `url('data:image/svg+xml;utf8,${encodeURIComponent(drawPenSvg)}') 1 31, crosshair`;

  // Hyper-Realistic 3D Apple-style Highlighter Marker Replica Cursor with active highlightColor chisel tip, ribbed grip, and glass ink chamber
  const highlighterMarkerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><filter id="hl3d-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="1" dy="1.2" stdDeviation="1" flood-color="#000000" flood-opacity="0.5"/></filter><linearGradient id="hl3d-barrel" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#545456"/><stop offset="35%" stop-color="#3A3A3C"/><stop offset="70%" stop-color="#2C2C2E"/><stop offset="100%" stop-color="#1C1C1E"/></linearGradient><linearGradient id="hl3d-grip" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8E8E93"/><stop offset="40%" stop-color="#636366"/><stop offset="80%" stop-color="#3A3A3C"/><stop offset="100%" stop-color="#1C1C1E"/></linearGradient><linearGradient id="hl3d-cap" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#AEAEB2"/><stop offset="50%" stop-color="#636366"/><stop offset="100%" stop-color="#2C2C2E"/></linearGradient></defs><g filter="url(#hl3d-shadow)"><path d="M 2 28 L 7 20 L 12 14 L 23 3 L 29 9 L 18 20 L 12 26 L 6 30 Z" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.95"/><path d="M 12 14 L 23 3 L 29 9 L 18 20 Z" fill="url(#hl3d-barrel)" stroke="#1C1C1E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 12 14 L 23 3 L 25.5 5.5 L 14.5 16.5 Z" fill="#FFFFFF" fill-opacity="0.18"/><path d="M 16 10 L 21 5 L 25.5 9.5 L 20.5 14.5 Z" fill="${highlightColor}" stroke="#1C1C1E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 16 10 L 21 5 L 23.25 7.25 L 18.25 12.25 Z" fill="#FFFFFF" fill-opacity="0.5"/><path d="M 18.25 12.25 L 23.25 7.25 L 25.5 9.5 L 20.5 14.5 Z" fill="#000000" fill-opacity="0.2"/><path d="M 23 3 L 25.5 0.5 C 27.5 0.5 30.5 3.5 31 5.5 L 29 9 Z" fill="url(#hl3d-cap)" stroke="#1C1C1E" stroke-width="0.7"/><path d="M 7 20 L 12 14 L 18 20 L 12 26 Z" fill="url(#hl3d-grip)" stroke="#1C1C1E" stroke-width="0.7" stroke-linejoin="round"/><line x1="8.5" y1="18.5" x2="13.5" y2="23.5" stroke="#1C1C1E" stroke-width="0.6"/><line x1="10" y1="16.5" x2="15" y2="21.5" stroke="#1C1C1E" stroke-width="0.6"/><path d="M 2 28 L 7 20 L 12 26 L 6 30 Z" fill="${highlightColor}" stroke="#1C1C1E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 2 28 L 7 20 L 9.5 23 Z" fill="#FFFFFF" fill-opacity="0.6"/><path d="M 2 28 L 9.5 23 L 12 26 L 6 30 Z" fill="#000000" fill-opacity="0.22"/><line x1="2" y1="28" x2="6" y2="30" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round"/></g></svg>`;
  const highlightCursorUrl = `url('data:image/svg+xml;utf8,${encodeURIComponent(highlighterMarkerSvg)}') 2 28, pointer`;

  const cursorForTool = isPanning ? 'grabbing'
    : spacePanHeld || (scale > 1 && !['draw', 'highlight', 'erase', 'sign'].includes(activeTool)) ? 'grab'
    : activeTool === 'text' ? 'text'
      : activeTool === 'draw' ? penCursorUrl
        : activeTool === 'highlight' ? highlightCursorUrl
          : activeTool === 'erase' ? eraserCursorUrl
            : activeTool === 'sign' ? 'default'
              : activeTool === 'select' ? 'grab'
                : 'default';

  const isPanIgnoreTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest(
      'textarea, input, button, a, [data-no-pan], [contenteditable="true"]',
    );
  }, []);

  const endPanDrag = useCallback((pointerId?: number) => {
    const drag = panDragRef.current;
    if (!drag) return false;
    if (pointerId != null && drag.pointerId !== pointerId) return false;
    const didPan = drag.moved;
    panDragRef.current = null;
    setIsPanning(false);
    const viewport = scrollViewportRef.current;
    try {
      viewport?.releasePointerCapture(drag.pointerId);
    } catch {
      // ignore
    }
    return didPan;
  }, []);

  const handleViewportPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (isPanIgnoreTarget(e.target)) return;

    const middle = e.button === 1;
    const leftPan =
      e.button === 0 &&
      (spacePanHeld ||
        (scale > 1 && !['draw', 'highlight', 'erase'].includes(activeTool)));
    if (!middle && !leftPan) return;

    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    if (
      e.button === 0 &&
      !spacePanHeld &&
      (e.target as Element).closest?.('.absolute.z-20, [data-edit-box], [data-resize-handle]')
    ) {
      return;
    }

    panDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      moved: false,
    };

    if (middle || spacePanHeld) {
      setIsPanning(true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
    }
  }, [activeTool, scale, spacePanHeld, isPanIgnoreTarget]);

  const handleViewportPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      drag.moved = true;
      setIsPanning(true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    // Flex + justify-center breaks scrollLeft; pan via scroll on a max-content wrapper.
    viewport.scrollLeft = drag.scrollLeft - dx;
    viewport.scrollTop = drag.scrollTop - dy;
  }, []);

  const handleViewportPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const didPan = endPanDrag(e.pointerId);
    if (didPan) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, [endPanDrag]);

  // Space = temporary hand tool (Photoshop-style)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space' || e.repeat) return;
      if (editingLine) return;
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      setSpacePanHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== 'Space') return;
      setSpacePanHeld(false);
      if (!panDragRef.current) setIsPanning(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [editingLine]);

  // ── Loading state ──
  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background bg-paper text-muted-foreground">
        <Lotus size={56} className="text-primary animate-pulse-glow" />
        <p className="mt-3 font-hand text-[24px] text-primary">opening your PDF…</p>
      </div>
    );
  }

  // ── Password prompt for encrypted PDFs ──
  if (needsPassword && !doc) {
    return (
      <div className="min-h-screen bg-surface">
        <PasswordDialog
          fileName={fileName}
          error={passwordError}
          isVerifying={isVerifyingPassword}
          onSubmit={handlePasswordSubmit}
          onCancel={handleClose}
        />
      </div>
    );
  }

  // ── Error state ──
  if (error && !doc) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 font-sans bg-background bg-paper text-foreground">
        <LostPageIllustration className="w-56 h-auto text-primary" />
        <h1 className="mt-4 text-xl font-extrabold tracking-tight">We couldn&apos;t open this PDF</h1>
        <p role="alert" className="mt-2 text-destructive text-sm max-w-[420px] text-center leading-relaxed">
          {error}
        </p>
        <button
          onClick={handleClose}
          className="mt-6 h-10 px-5 rounded-full bg-primary text-primary-foreground text-[13px] font-semibold shadow-sm hover:brightness-105 transition flex items-center gap-1.5"
        >
          <ChevronLeft size={16} /> Go Back
        </button>
      </div>
    );
  }

  // ── Main editor UI ──
  return (
    <div className="flex flex-col h-screen font-sans bg-surface text-app selection:bg-primary/30 overflow-hidden">

      {/* ── Top toolbar ── */}
      <Toolbar
        fileName={fileName}
        isDirty={isDirty}
        currentPage={currentPage}
        totalPages={totalPages}
        scale={scale}
        drawnPaths={drawnPaths}
        isSaving={isSaving}
        canUndo={canUndo}
        canRedo={canRedo}
        onClose={handleClose}
        onPrevPage={goToPrev}
        onNextPage={goToNext}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClearPaths={() => {
          setDrawnPaths([]);
          drawnPathsRef.current = [];
          if (doc && engineRef.current) {
            const page = doc.pages[currentPage];
            engineRef.current.clearMarkupAnnotationsOnPage(page.dict, doc.objects);
          }
          pushEditorHistory('clear-markup', { drawnPaths: [] });
          setIsDirty(true);
          setRenderKey(k => k + 1);
        }}
        onDownload={handleDownload}
        saveMode={saveMode}
        onSaveModeChange={setSaveMode}
        isSearchOpen={isSearchOpen}
        onToggleSearch={() => setIsSearchOpen(!isSearchOpen)}
        onExport={() => setShowExportPanel(true)}
        doc={doc}
        onCompressedDownload={handleCompressedDownload}
      />

      <div className="flex-1 flex relative min-h-0 overflow-hidden">

        {/* ── Left sidebar (Tools only) — on mobile renders as fixed bottom strip ── */}
        <ToolsSidebar
          activeTool={activeTool}
          setActiveTool={selectTool}
          highlightColor={highlightColor}
          isPanelOpen={isPanelOpen}
          onTogglePanel={() => setIsPanelOpen(v => !v)}
          isMobile={isMobile}
        />

        {/* ── Left Sidebar (Properties / Security) ── */}
        {isPanelOpen && (
          activeTool === 'security' ? (
            <SecurityPanel
              doc={doc}
              engine={engineModule}
              onDocChange={(d) => {
                setDoc(d);
                setIsDirty(true);
              }}
              markDirty={() => setIsDirty(true)}
              onClose={() => setIsPanelOpen(false)}
              isMobile={isMobile}
            />
          ) : (
            <PropertiesSidebar
              activeTool={activeTool}
              setActiveTool={selectTool}
              onClose={() => setIsPanelOpen(false)}
              selectedRun={selectedLine?.runs[0] ?? null}
          textFontFamily={textFontFamily}
          setTextFontFamily={handleTextFontFamily}
          textFontSize={textFontSize}
          setTextFontSize={handleTextFontSize}
          textBold={textBold}
          setTextBold={handleTextBold}
          textItalic={textItalic}
          setTextItalic={handleTextItalic}
          textUnderline={textUnderline}
          setTextUnderline={handleTextUnderline}
          textColor={textColor}
          setTextColor={handleTextColor}
          textAlign={textAlign}
          setTextAlign={handleTextAlign}
          replacingImageIdRef={replacingImageIdRef}
          fileInputRef={fileInputRef}
          drawColor={drawColor}
          setDrawColor={setDrawColor}
          drawSize={drawSize}
          setDrawSize={setDrawSize}
          drawMode={drawMode}
          setDrawMode={setDrawMode}
          highlightColor={highlightColor}
          setHighlightColor={setHighlightColor}
          highlightSize={highlightSize}
          setHighlightSize={setHighlightSize}
          eraserSize={eraserSize}
          setEraserSize={setEraserSize}
          pageLinkCount={pageLinks.length}
          linksHighlighted={linksHighlighted}
          onScanLinks={scanPageLinks}
          hasSelectedLink={false}
          linkCreatePending={linkCreatePending}
          selectedLinkUrl={linkDraftUrl}
          onSelectedLinkUrlChange={setLinkDraftUrl}
          onSaveSelectedLink={() => {
            if (!doc || !engineRef.current) return;
            const url = linkDraftUrl.trim();
            if (!url || url === 'https://') return;

            // Create from current text selection / line
            const line = editAnchorLineRef.current ?? selectedLine ?? editingLine;
            if (!line) {
              window.alert(LINK_NEEDS_SELECTION);
              return;
            }
            const sel = editSelRef.current;
            let start = 0;
            let end = line.text.length;
            if (editingLine && sel.end > sel.start) {
              start = sel.start;
              end = sel.end;
            } else if (editingLine) {
              const range = resolveEditStyleRange(line, sel.start, sel.end);
              start = range.start;
              end = range.end;
            }
            try {
              const ref = engineRef.current.addLinkFromLineSelection(
                doc, currentPage, line, start, end, url,
              );
              if (ref) {
                setLinkCreatePending(false);
                setLinkDraftUrl('');
                setLinksHighlighted(true);
                setIsDirty(true);
                setRenderKey(k => k + 1);
              } else {
                window.alert(LINK_NEEDS_SELECTION);
              }
            } catch (err) {
              console.warn('[Editor] Add link failed:', err);
            }
          }}
          onRemoveSelectedLink={() => {
            setLinkCreatePending(false);
            setLinkDraftUrl('');
          }}
          onAddLink={() => {
            const line = editAnchorLineRef.current ?? selectedLine ?? editingLine;
            // Validate before asking for a URL: while editing, a collapsed caret
            // has nothing to link.
            const sel = editSelRef.current;
            if (!line || (editingLine && sel.end <= sel.start)) {
              window.alert(LINK_NEEDS_SELECTION);
              return;
            }
            closeLinkPopover();
            setLinkCreatePending(true);
            setLinkDraftUrl('https://');
            setActiveTool('text');
          }}
          selectedDisplayItem={selectedDisplayItem}
          setSelectedDisplayItem={setSelectedDisplayItem}
          onDeleteSelectedDisplayItem={handleDeleteSelectedDisplayItem}
          onReplaceSelectedImage={handleReplaceEmbeddedImage}
          onCopySelectedImage={handleCopyEmbeddedImage}
          onClearImageReplaceMode={() => { replacingEmbeddedImageRef.current = null; }}
          displayItems={displayItems}
          removedImages={removedImages}
          onRestoreRemovedImage={handleRestoreRemovedImage}
          onInsertRemovedImage={handleInsertRemovedImage}
          onDeleteRemovedImage={handleDeleteRemovedImage}
          onClearRemovedImages={handleClearRemovedImages}
          formFields={formFields}
          selectedFormField={selectedFormField}
          formFieldDraft={formFieldDraft}
          onFormFieldSelect={handleFormFieldSelect}
          onFormFieldChange={handleFormFieldChange}
          onFlattenForms={handleFlattenForms}
          onDuplicateLineBelow={handleDuplicateLineBelow}
          onRecognizeText={() => void handleRecognizeText()}
          redactionMarkCount={redactionMarkCount}
          onApplyRedactions={() => void handleApplyRedactions()}
          tableInfo={selectedTableCell ? {
            rows: selectedTableCell.table.rows,
            cols: selectedTableCell.table.cols,
            row: selectedTableCell.cell.row,
            col: selectedTableCell.cell.col,
          } : null}
          onAddTableRow={handleAddTableRow}
          onAddTableColumn={handleAddTableColumn}
          watermarkType={watermarkType}
          setWatermarkType={setWatermarkType}
          watermarkShapeType={watermarkShapeType}
          setWatermarkShapeType={setWatermarkShapeType}
          watermarkShapeColor={watermarkShapeColor}
          setWatermarkShapeColor={setWatermarkShapeColor}
          watermarkImageFile={watermarkImageFile}
          onWatermarkImageUpload={handleWatermarkImageUpload}
          onWatermarkImageClear={handleWatermarkImageClear}
          watermarkText={watermarkText}
          setWatermarkText={setWatermarkText}
          watermarkFontName={watermarkFontName}
          setWatermarkFontName={setWatermarkFontName}
          watermarkOpacity={watermarkOpacity}
          setWatermarkOpacity={setWatermarkOpacity}
          watermarkRotation={watermarkRotation}
          setWatermarkRotation={setWatermarkRotation}
          watermarkSize={watermarkSize}
          setWatermarkSize={setWatermarkSize}
          watermarkPosition={watermarkPosition}
          setWatermarkPosition={setWatermarkPosition}
          watermarkBlendMode={watermarkBlendMode}
          setWatermarkBlendMode={setWatermarkBlendMode}
          watermarkMosaic={watermarkMosaic}
          setWatermarkMosaic={setWatermarkMosaic}
          watermarkPageFrom={watermarkPageFrom}
          setWatermarkPageFrom={setWatermarkPageFrom}
          watermarkPageTo={watermarkPageTo}
          setWatermarkPageTo={setWatermarkPageTo}
          watermarkLayer={watermarkLayer}
          setWatermarkLayer={setWatermarkLayer}
          watermarkColor={watermarkColor}
          setWatermarkColor={setWatermarkColor}
          watermarkLivePreview={watermarkLivePreview}
          setWatermarkLivePreview={setWatermarkLivePreview}
          onApplyWatermark={handleApplyWatermark}
          hasScannedWatermarks={detectedWatermarks !== null}
          detectedWatermarksCount={detectedWatermarks?.length}
          onScanWatermarks={handleScanWatermarks}
          onRemoveWatermarks={handleConfirmRemoveWatermarks}
          onCancelScan={handleCancelScan}
          // Signature tool
          signatureLibraryEntries={signatureLibraryEntries}
          activeLibraryId={activeLibraryId}
          setActiveLibraryId={setActiveLibraryId}
          selectedSignatureId={selectedSignatureId}
          selectedSignature={signatures.find((s) => s.id === selectedSignatureId) ?? null}
          onOpenSignatureCreate={() => setSignatureCreateOpen(true)}
          onSignatureDelete={handleSignatureDelete}
          onSignatureOpacity={handleSignatureOpacity}
          onSignatureLockToggle={handleSignatureLockToggle}
          onSignatureRotate={handleSignatureRotate}
          onLibraryRename={handleLibraryRename}
          onLibraryDelete={handleLibraryDelete}
          onLibraryDuplicate={handleLibraryDuplicate}
          onLibraryFavorite={handleLibraryFavorite}
          pdfSignatureFields={pdfSignatureFields}
          selectedPdfSigFieldId={selectedPdfSigFieldId}
          setSelectedPdfSigFieldId={setSelectedPdfSigFieldId}
          onPlaceIntoSelectedField={() => {
            const field = pdfSignatureFields.find((f) => f.id === selectedPdfSigFieldId);
            if (field) void placeLibrarySignatureIntoField(field);
          }}
          certificateIdentities={certificateIdentities}
          selectedCertificateId={selectedCertificateId}
          onOpenCertificateImport={() => setCertificateImportOpen(true)}
          onSelectCertificate={handleSelectCertificate}
          onCryptographicSign={() => void handleCryptographicSign()}
          cryptoSignBusy={cryptoSignBusy}
          enableTimestamp={enableTimestamp}
          setEnableTimestamp={setEnableTimestamp}
          onValidateSignatures={() => void handleValidateSignatures()}
          validationBusy={validationBusy}
          validationReport={validationReport}
          onEnableLtv={handleEnableLtv}
          ltvStatus={ltvStatus}
          managedSignatures={managedSignatures}
          revisionEntries={revisionEntries}
          isMobile={isMobile}
        />
      )
    )}

        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          className="hidden"
          onChange={handleImageUpload}
        />

        {/* ── Canvas area ── */}
        <div
          ref={scrollViewportRef}
          className="flex-1 overflow-auto relative checkerboard"
          style={{ cursor: cursorForTool, touchAction: isMobile ? 'manipulation' : (scale > 1 || spacePanHeld ? 'none' : undefined), paddingBottom: isMobile ? '56px' : undefined }}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          onPointerCancel={handleViewportPointerUp}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={handleCanvasDrop}
        >
          {/* Floating Search & OCR Panel (viewport-fixed) */}
          {isSearchOpen && (
            <div className="absolute top-4 left-4 right-4 md:left-auto z-40 flex flex-col items-end gap-3 pointer-events-none animate-in fade-in slide-in-from-top-4 duration-200">
              <div className="pointer-events-auto flex items-center justify-between gap-2 bg-popover backdrop-blur-md px-3 py-2 rounded-xl border border-border shadow-lg w-full md:w-72">
                <button
                  onClick={() => void handleRecognizeText()}
                  data-testid="search-ocr-button"
                  className="flex items-center gap-2 text-xs font-semibold text-foreground/90 hover:text-primary transition-colors"
                  title="Recognize text on this page with OCR, for scanned pages"
                >
                  <Type size={14} /> Recognize Text (OCR)
                </button>
              </div>
              <div className="pointer-events-auto">
                <FindReplacePanel
                  findText={findText}
                  onFindTextChange={setFindText}
                  replaceText={replaceText}
                  onReplaceTextChange={setReplaceText}
                  matchCount={searchResults.length}
                  currentMatchIndex={activeMatchIndex}
                  onNextMatch={handleNextMatch}
                  onPrevMatch={handlePrevMatch}
                  onReplaceCurrent={handleReplaceCurrent}
                  onReplaceAll={handleReplaceAll}
                  caseSensitive={caseSensitive}
                  onToggleCaseSensitive={() => setCaseSensitive(v => !v)}
                  onClose={() => setIsSearchOpen(false)}
                  busy={searchBusy}
                />
              </div>
            </div>
          )}
          {isRendering && (
            <div className="absolute top-4 right-4 z-30 bg-popover backdrop-blur border border-border shadow-lg rounded-full px-4 py-2 flex items-center gap-2 text-foreground/90 text-sm font-medium animate-in slide-in-from-top-4 fade-in">
              <Loader2 size={16} className="animate-spin text-primary" />
              Rendering…
            </div>
          )}

          {/*
            Centering wrapper: minWidth 100% + width max-content so overflow scroll
            works left/right after zoom (flex justify-center on the scroller breaks scrollLeft).
          */}
          <div
            className="flex justify-center items-start py-12"
            style={{ minWidth: '100%', width: 'max-content', minHeight: '100%' }}
          >
          <div
            ref={canvasContainerRef}
            data-testid="page-canvas"
            className="relative inline-block shrink-0 shadow-[0_20px_50px_-12px_rgba(15,23,42,0.18),0_4px_16px_-2px_rgba(0,0,0,0.06),0_0_0_1px_rgba(15,23,42,0.06)] rounded-sm bg-white transition-shadow duration-300"
            style={{ cursor: cursorForTool }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={handleCanvasDrop}
            onClick={(e) => {
              if (panDragRef.current?.moved || isPanning) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              handleCanvasClick(e);
            }}
            onDoubleClick={handleCanvasDoubleClick}
            onMouseDown={handleDrawStart}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleDrawEnd}
            onMouseLeave={handleCanvasMouseLeave}
          >
            {/* PDF canvas is prepended here by the render effect */}

            {/* Overlay canvas for caret / drawings */}
            <canvas
              ref={overlayRef}
              className="absolute top-0 left-0 z-10"
              style={{
                pointerEvents: ['draw', 'highlight', 'erase'].includes(activeTool) ? 'auto' : 'none',
                cursor: cursorForTool,
              }}
            />

            {/* Search matches highlights overlay */}
            {isSearchOpen && searchResults.length > 0 && searchResults
              .filter(m => m.pageIndex === currentPage)
              .map((m) => {
                const isCurrent = searchResults[activeMatchIndex]?.id === m.id;
                const mediaBox = doc?.pages[currentPage]?.mediaBox;
                const pageH = mediaBox?.height || 0;
                const mbX = mediaBox?.x || 0;
                const mbY = mediaBox?.y || 0;

                const { cssX: x1, cssY: y1 } = pdfToCanvas(m.pdfX, m.pdfY + m.pdfHeight, scale, pageH, mbX, mbY);
                const { cssX: x2, cssY: y2 } = pdfToCanvas(m.pdfX + m.pdfWidth, m.pdfY, scale, pageH, mbX, mbY);

                const w = Math.max(Math.abs(x2 - x1), 4);
                const h = Math.max(Math.abs(y2 - y1), 8);

                return (
                  <div
                    key={m.id}
                    className={`absolute rounded-sm pointer-events-none transition-all duration-150 ${
                      isCurrent
                        ? 'bg-amber-400/80 border-2 border-amber-600 ring-4 ring-amber-400/40 shadow-lg scale-[1.04] z-30'
                        : 'bg-yellow-300/45 border border-yellow-500/80 shadow-sm z-20 hover:bg-yellow-300/70'
                    }`}
                    style={{
                      left: Math.min(x1, x2),
                      top: Math.min(y1, y2),
                      width: w,
                      height: h,
                    }}
                  />
                );
              })}

            {/* DOM overlays for FloatingText */}
            {/* Preview only on pages the watermark will be applied to (BE-314). */}
            {activeTool === 'watermark' && watermarkLivePreview &&
              currentPage + 1 >= watermarkPageFrom && currentPage + 1 <= watermarkPageTo && (
              <WatermarkPreview
                doc={doc}
                currentPage={currentPage}
                scale={scale}
                watermarkType={watermarkType}
                watermarkText={watermarkText}
                watermarkFontName={watermarkFontName}
                watermarkSize={watermarkSize}
                watermarkColor={watermarkColor}
                watermarkOpacity={watermarkOpacity}
                watermarkRotation={watermarkRotation}
                watermarkMosaic={watermarkMosaic}
                watermarkPosition={watermarkPosition}
                watermarkImageDims={watermarkImageDims}
                watermarkImageFile={watermarkImageFile}
                watermarkShapeType={watermarkShapeType}
                watermarkShapeColor={watermarkShapeColor}
                watermarkBlendMode={watermarkBlendMode}
              />
            )}

            {/* Detected watermarks dotted boxes */}
            {activeTool === 'watermark' && detectedWatermarks?.filter(d => d.pageIndex === currentPage).map(dw =>
              dw.positions.map((pos, i) => {
                const { cssX, cssY } = pdfToCanvas(
                  pos.x,
                  pos.y,
                  scale,
                  doc?.pages[currentPage]?.mediaBox.height || 0,
                  doc?.pages[currentPage]?.mediaBox.x || 0,
                  doc?.pages[currentPage]?.mediaBox.y || 0
                );
                const boxW = (pos.width || 120) * scale;
                const boxH = (pos.height || 60) * scale;
                const rot = pos.rotation ?? dw.rotation ?? 0;

                return (
                  <div
                    key={`det-${dw.id}-${i}`}
                    className="absolute border-2 border-red-500 border-dashed bg-red-500/20 rounded z-50 pointer-events-none animate-in fade-in zoom-in duration-200"
                    style={{
                      left: cssX,
                      top: cssY,
                      width: boxW,
                      height: boxH,
                      transform: `translate(-50%, -50%) rotate(${-rot}deg)`
                    }}
                  />
                );
              })
            )}

            {/* Interactive overlay for selected embedded PDF image */}
            {selectedDisplayItem?.type === 'image' && renderResult && doc && (() => {
              const item = selectedDisplayItem as ImageItem;
              const page = doc.pages[currentPage];
              const { mediaBox } = page;
              return (
                <EmbeddedImageOverlay
                  item={item}
                  scale={scale}
                  toCss={(b) => {
                    const tl = pdfToCanvas(
                      b.x, b.y + b.height,
                      scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                    );
                    const br = pdfToCanvas(
                      b.x + b.width, b.y,
                      scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                    );
                    return {
                      left: Math.min(tl.cssX, br.cssX),
                      top: Math.min(tl.cssY, br.cssY),
                      width: Math.abs(br.cssX - tl.cssX),
                      height: Math.abs(br.cssY - tl.cssY),
                    };
                  }}
                  onCommitMove={handleEmbeddedImageMove}
                  onCommitResize={handleEmbeddedImageResize}
                  onReplace={handleReplaceEmbeddedImage}
                  onCopy={handleCopyEmbeddedImage}
                  onDelete={handleDeleteSelectedDisplayItem}
                  onDeselect={() => setSelectedDisplayItem(null)}
                />
              );
            })()}

            {/* Visual signatures — render above page contents */}
            {renderResult && doc && signatures.filter((s) => s.pageIndex === currentPage).map((sig) => {
              const page = doc.pages[currentPage];
              const { mediaBox } = page;
              return (
                <SignatureOverlay
                  key={sig.id}
                  signature={sig}
                  imageDataUrl={resolveSignatureImage(sig)}
                  scale={scale}
                  selected={selectedSignatureId === sig.id}
                  toCss={(b) => {
                    const tl = pdfToCanvas(
                      b.x, b.y + b.height,
                      scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                    );
                    const br = pdfToCanvas(
                      b.x + b.width, b.y,
                      scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                    );
                    return {
                      left: Math.min(tl.cssX, br.cssX),
                      top: Math.min(tl.cssY, br.cssY),
                      width: Math.abs(br.cssX - tl.cssX),
                      height: Math.abs(br.cssY - tl.cssY),
                    };
                  }}
                  onSelect={handleSignatureSelect}
                  onCommitMove={handleSignatureMove}
                  onCommitResize={handleSignatureResize}
                  onCommitRotate={handleSignatureRotate}
                  onDelete={handleSignatureDelete}
                  onDeselect={() => setSelectedSignatureId(null)}
                />
              );
            })}

            {/* PDF AcroForm signature field widgets */}
            {(activeTool === 'sign' || selectedPdfSigFieldId) && renderResult && doc &&
              pdfSignatureFields.map((field) => {
                const page = doc.pages[currentPage];
                const { mediaBox } = page;
                const tl = pdfToCanvas(
                  field.rect.x, field.rect.y + field.rect.height,
                  scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                );
                const br = pdfToCanvas(
                  field.rect.x + field.rect.width, field.rect.y,
                  scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                );
                const selected = selectedPdfSigFieldId === field.id;
                return (
                  <div
                    key={`pdf-sig-${field.id}`}
                    className={`absolute z-35 pointer-events-none border-2 border-dashed ${
                      selected ? 'border-emerald-400 bg-emerald-400/10' : 'border-sky-400/80 bg-sky-400/5'
                    }`}
                    style={{
                      left: Math.min(tl.cssX, br.cssX),
                      top: Math.min(tl.cssY, br.cssY),
                      width: Math.abs(br.cssX - tl.cssX),
                      height: Math.abs(br.cssY - tl.cssY),
                    }}
                  >
                    <span className="absolute -top-5 left-0 text-[9px] px-1 rounded bg-sky-700 text-white whitespace-nowrap">
                      {joinParts(field.fieldName, field.signed ? 'Signed' : field.hasAppearance && 'Visible')}
                    </span>
                  </div>
                );
              })}

            {floatingTexts.map(ft => {
              const { cssX, cssY } = pdfToCanvas(
                ft.pdfX,
                ft.pdfY,
                scale,
                doc?.pages[currentPage]?.mediaBox.height || 0,
                doc?.pages[currentPage]?.mediaBox.x || 0,
                doc?.pages[currentPage]?.mediaBox.y || 0
              );
              const isActive = activeFloatingTextId === ft.id;

              return (
                <div
                  key={ft.id}
                  className={`absolute z-20 cursor-move border-2 ${isActive ? 'border-primary border-dashed' : 'border-transparent hover:border-border-strong hover:border-dashed'} p-1 -m-1`}
                  style={{
                    left: cssX,
                    top: cssY - (ft.fontSize * scale),
                  }}
                  onPointerDown={(e) => handleFloatingTextPointerDown(e, ft.id)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {isActive && (
                    <button
                      className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1 shadow hover:bg-red-600 transition-colors z-30"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFloatingTexts(prev => prev.filter(p => p.id !== ft.id));
                        if (activeFloatingTextId === ft.id) setActiveFloatingTextId(null);
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                  <textarea
                    ref={(el) => {
                      // Focus a just-created box so typing goes into it instead
                      // of triggering tool shortcuts.
                      if (el && focusFloatingTextIdRef.current === ft.id) {
                        focusFloatingTextIdRef.current = null;
                        el.focus();
                        el.select();
                      }
                    }}
                    aria-label="Text box"
                    value={ft.text}
                    onChange={(e) => {
                      setFloatingTexts(prev => prev.map(p => p.id === ft.id ? { ...p, text: e.target.value } : p));
                    }}
                    onFocus={() => setActiveFloatingTextId(ft.id)}
                    className="bg-transparent outline-none overflow-hidden block resize"
                    style={{
                      fontFamily: ft.fontFamily,
                      fontSize: ft.fontSize * scale,
                      color: ft.color,
                      minWidth: '100px',
                      minHeight: `${ft.fontSize * scale * 1.5}px`,
                      width: ft.pdfWidth ? `${ft.pdfWidth * scale}px` : undefined,
                      height: ft.pdfHeight ? `${ft.pdfHeight * scale}px` : undefined,
                    }}
                    onPointerDown={e => {
                      if (isActive) e.stopPropagation();
                    }}
                    onMouseUp={e => {
                      // Capture size after resize handle is released
                      const target = e.target as HTMLTextAreaElement;
                      const w = target.offsetWidth / scale;
                      const h = target.offsetHeight / scale;
                      setFloatingTexts(prev => prev.map(p => p.id === ft.id ? { ...p, pdfWidth: w, pdfHeight: h } : p));
                    }}
                  />
                </div>
              );
            })}

            {/* DOM overlays for FloatingImage */}
            {floatingImages.map(fi => {
              const { cssX, cssY } = pdfToCanvas(
                fi.pdfX,
                fi.pdfY,
                scale,
                doc?.pages[currentPage]?.mediaBox.height || 0,
                doc?.pages[currentPage]?.mediaBox.x || 0,
                doc?.pages[currentPage]?.mediaBox.y || 0
              );
              const isActive = activeFloatingImageId === fi.id;
              const rot = fi.rotation || 0;

              // Upright panel beside the image's rotated bounding box.
              const frameW = fi.pdfWidth * scale + 8;
              const frameH = fi.pdfHeight * scale + 8;
              const rad = (rot * Math.PI) / 180;
              const halfW = (frameW * Math.abs(Math.cos(rad)) + frameH * Math.abs(Math.sin(rad))) / 2;
              const halfH = (frameW * Math.abs(Math.sin(rad)) + frameH * Math.abs(Math.cos(rad))) / 2;
              const panelLeft = cssX + frameW / 2 + halfW + 10;
              const panelTop = cssY + frameH / 2 - halfH;

              return (
                <Fragment key={fi.id}>
                <div
                  className={`floating-image-container absolute z-20 cursor-move border-2 ${isActive ? 'border-primary border-dashed' : 'border-transparent hover:border-border-strong hover:border-dashed'} p-1 -m-1`}
                  style={{
                    left: cssX,
                    top: cssY,
                    width: fi.pdfWidth * scale + 8, // +8 for padding/border
                    height: fi.pdfHeight * scale + 8,
                    transform: `rotate(${rot}deg)`,
                    transformOrigin: 'center center',
                  }}
                  onPointerDown={(e) => handleFloatingImagePointerDown(e, fi.id)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <img
                    src={fi.dataUrl}
                    alt="floating"
                    className="w-full h-full object-fill pointer-events-none"
                  />

                  {isActive && (
                    <>
                      {/* Rotation Handle */}
                      <div
                        className="absolute -top-8 left-1/2 -translate-x-1/2 flex flex-col items-center cursor-grab active:cursor-grabbing z-30"
                        onPointerDown={(e) => handleFloatingImageRotateDown(e, fi.id)}
                        title="Drag to rotate image (Hold Shift for 15° steps)"
                      >
                        <div className="w-5 h-5 rounded-full bg-primary text-white flex items-center justify-center shadow-md hover:scale-110 transition-transform">
                          <RotateCw size={11} />
                        </div>
                        <div className="w-0.5 h-3 bg-primary" />
                      </div>

                      <button
                        className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1 shadow hover:bg-red-600 transition-colors z-30"
                        title="Delete Image"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (fi.dataUrl) {
                            const record: RemovedImageRecord = {
                              id: `removed-fi-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                              dataUrl: fi.dataUrl,
                              name: `Image ${fi.id}`,
                              fileName,
                              sourceType: 'floating',
                              originalPage: currentPage,
                              originalBounds: {
                                x: fi.pdfX,
                                y: fi.pdfY,
                                width: fi.pdfWidth,
                                height: fi.pdfHeight,
                              },
                              deletedAt: Date.now(),
                            };
                            setRemovedImages(prev => {
                              const isDuplicate = prev.some(r => r.dataUrl === fi.dataUrl);
                              if (isDuplicate) return prev;
                              const updated = [record, ...prev];
                              saveRemovedImages(updated);
                              return updated;
                            });
                          }
                          updateFloatingImages(prev => prev.filter(p => p.id !== fi.id), 'delete-image');
                          if (activeFloatingImageId === fi.id) setActiveFloatingImageId(null);
                        }}
                      >
                        <X size={12} />
                      </button>
                      <button
                        className="absolute -top-3 -left-3 bg-muted text-foreground border border-border-strong rounded-full p-1 shadow hover:bg-border transition-colors z-30"
                        title="Copy Image (Duplicate & clipboard)"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (fi.dataUrl) {
                            try {
                              const res = await fetch(fi.dataUrl);
                              const blob = await res.blob();
                              if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
                                await navigator.clipboard.write([
                                  new ClipboardItem({ [blob.type || 'image/png']: blob }),
                                ]);
                              }
                            } catch {}
                            const dup: FloatingImage = {
                              id: `dup-fi-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                              dataUrl: fi.dataUrl,
                              pdfX: fi.pdfX + 20,
                              pdfY: fi.pdfY - 20,
                              pdfWidth: fi.pdfWidth,
                              pdfHeight: fi.pdfHeight,
                              rotation: fi.rotation,
                            };
                            updateFloatingImages(prev => [...prev, dup], 'duplicate-image');
                            setActiveFloatingImageId(dup.id);
                          }
                        }}
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        className="absolute -bottom-3 -left-3 bg-primary text-white rounded-full p-1 shadow hover:bg-bloom-600 transition-colors z-30"
                        title="Replace Image"
                        onClick={(e) => {
                          e.stopPropagation();
                          replacingImageIdRef.current = fi.id;
                          fileInputRef.current?.click();
                        }}
                      >
                        <Image size={12} />
                      </button>

                    </>
                  )}

                  {/* Resize handle: shown only while the image is selected (BE-313) */}
                  {isActive && (
                  <div
                    title="Drag to resize"
                    className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 cursor-se-resize rounded-sm border border-white bg-primary shadow z-30"
                    onPointerDown={e => {
                      e.stopPropagation(); // prevent dragging
                      const startX = e.clientX;
                      const startY = e.clientY;
                      const startW = fi.pdfWidth * scale;
                      const startH = fi.pdfHeight * scale;

                      let resized = false;
                      const handleMove = (me: PointerEvent) => {
                        const newW = startW + (me.clientX - startX);
                        const newH = startH + (me.clientY - startY);
                        resized = true;
                        updateFloatingImages(prev => prev.map(p => p.id === fi.id ? { ...p, pdfWidth: Math.max(10, newW / scale), pdfHeight: Math.max(10, newH / scale) } : p));
                      };

                      const handleUp = () => {
                        if (resized) recordFloatingImages('resize-image');
                        window.removeEventListener('pointermove', handleMove);
                        window.removeEventListener('pointerup', handleUp);
                      };

                      window.addEventListener('pointermove', handleMove);
                      window.addEventListener('pointerup', handleUp);
                    }}
                  />
                  )}
                </div>
                {/* Transform panel, outside the rotated frame so it stays upright (BE-309) */}
                {isActive && (
                  <div
                    className="absolute bg-popover text-foreground rounded-lg p-2 shadow-xl border border-border text-xs flex flex-col gap-2 z-30 w-28"
                    style={{ left: panelLeft, top: panelTop }}
                    onClick={e => e.stopPropagation()}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    <div className="text-[9px] text-muted-foreground font-bold uppercase tracking-wider mb-0.5">Transform</div>
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-muted-foreground w-3 text-center">W</span>
                      <input
                        type="number"
                        value={Math.round(fi.pdfWidth)}
                        onChange={e => {
                          const newW = parseFloat(e.target.value);
                          if (newW > 0) updateFloatingImages(prev => prev.map(p => p.id === fi.id ? { ...p, pdfWidth: newW } : p), 'resize-image');
                        }}
                        className="w-10 bg-muted rounded px-1 py-0.5 text-right no-spinners outline-none focus:ring-1 focus:ring-primary"
                        step="1"
                      />
                      <span className="text-muted-foreground text-[10px]">pt</span>
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-muted-foreground w-3 text-center">H</span>
                      <input
                        type="number"
                        value={Math.round(fi.pdfHeight)}
                        onChange={e => {
                          const newH = parseFloat(e.target.value);
                          if (newH > 0) updateFloatingImages(prev => prev.map(p => p.id === fi.id ? { ...p, pdfHeight: newH } : p), 'resize-image');
                        }}
                        className="w-10 bg-muted rounded px-1 py-0.5 text-right no-spinners outline-none focus:ring-1 focus:ring-primary"
                        step="1"
                      />
                      <span className="text-muted-foreground text-[10px]">pt</span>
                    </div>
                    <div className="flex items-center justify-between gap-1 border-t border-border pt-1.5 mt-0.5">
                      <span className="text-muted-foreground w-3 text-center">↻</span>
                      <input
                        type="number"
                        value={Math.round(rot)}
                        onChange={e => {
                          const val = (parseFloat(e.target.value) || 0) % 360;
                          updateFloatingImages(prev => prev.map(p => p.id === fi.id ? { ...p, rotation: (val + 360) % 360 } : p), 'rotate-image');
                        }}
                        className="w-10 bg-muted rounded px-1 py-0.5 text-right no-spinners outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button
                        type="button"
                        title="Rotate 90° clockwise"
                        className="p-1 hover:bg-muted rounded text-foreground/90 hover:text-primary transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateFloatingImages(prev => prev.map(p => p.id === fi.id ? { ...p, rotation: ((p.rotation || 0) + 90) % 360 } : p), 'rotate-image');
                        }}
                      >
                        <RotateCw size={11} />
                      </button>
                    </div>
                  </div>
                )}
                </Fragment>
              );
            })}

            {/* Word-like line editor — same size/position as canvas text */}
            {editingLine && editAnchorLine && renderResult && doc && (() => {
              const anchor = editAnchorLine;
              const bounds = getLineBounds(anchor);
              const page = doc.pages[currentPage];
              const { mediaBox } = page;
              const primaryRun = anchor.runs[0];
              const visualSize = primaryRun ? visualFontSize(primaryRun) : anchor.fontSize;
              // Box height follows the tallest glyph on the line (mixed sizes / overrides)
              let maxFontSizeCss = visualSize * scale;
              for (const run of anchor.runs) {
                maxFontSizeCss = Math.max(maxFontSizeCss, visualFontSize(run) * scale);
              }
              for (const ov of editStyleOverrides) {
                if (ov.fontSize != null) {
                  maxFontSizeCss = Math.max(maxFontSizeCss, ov.fontSize * scale);
                }
              }
              // Include sidebar size while typing so the box grows with the caret style
              if (editSel.end <= editSel.start && textFontSize > 0) {
                maxFontSizeCss = Math.max(maxFontSizeCss, textFontSize * scale);
              }
              const fontSizeCss = maxFontSizeCss;
              const baseline = anchor.baseline;
              const ascent = fontSizeCss * 0.85;
              const lineHasUnderline = textUnderline || anchor.runs.some(r =>
                !!r.isUnderline || runHasPathUnderline(r, strokePaths),
              ) || editStyleOverrides.some(o => o.underline);
              const descent = fontSizeCss * (lineHasUnderline ? 0.45 : 0.25);
              const origin = pdfToCanvas(
                bounds.x,
                baseline,
                scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
              );
              const left = origin.cssX;
              const top = origin.cssY - ascent;
              const naturalWidth = Math.max(20, bounds.width * scale);
              const naturalHeight = ascent + descent;
              const fontData = primaryRun ? renderResult.fonts.get(primaryRun.fontName) : undefined;
              const [r, g, b] = primaryRun?.fillColor || [0, 0, 0];
              const colorCss = textColor.startsWith('#')
                ? textColor
                : `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

              const pathItems = strokePaths;
              const edits = distributeTextChangeToSegments(
                anchor,
                anchor.text,
                editText,
                caretPos,
              );

              type Piece = {
                start: number;
                end: number;
                text: string;
                run: TextRun;
              };
              let pieces: Piece[] = [];
              {
                let pos = 0;
                for (const edit of edits) {
                  pieces.push({
                    start: pos,
                    end: pos + edit.newText.length,
                    text: edit.newText,
                    run: edit.run,
                  });
                  pos += edit.newText.length;
                }
              }

              // Split pieces at override boundaries so bold-off only affects the selection
              for (const ov of editStyleOverrides) {
                if (ov.end <= ov.start) continue;
                const next: Piece[] = [];
                for (const p of pieces) {
                  if (ov.end <= p.start || ov.start >= p.end) {
                    next.push(p);
                    continue;
                  }
                  if (ov.start > p.start) {
                    next.push({
                      ...p,
                      end: ov.start,
                      text: p.text.slice(0, ov.start - p.start),
                    });
                  }
                  const midStart = Math.max(p.start, ov.start);
                  const midEnd = Math.min(p.end, ov.end);
                  next.push({
                    ...p,
                    start: midStart,
                    end: midEnd,
                    text: p.text.slice(midStart - p.start, midEnd - p.start),
                  });
                  if (ov.end < p.end) {
                    next.push({
                      ...p,
                      start: ov.end,
                      text: p.text.slice(ov.end - p.start),
                    });
                  }
                }
                pieces = next.filter(p => p.text.length > 0 || p.end > p.start);
              }

              const overlaySegments: OverlaySegmentStyle[] = pieces.map((piece) => {
                const run = piece.run;
                const fd = renderResult.fonts.get(run.fontName);
                const flags = resolveRunStyleFlags(run.fontName, fd);
                const faceStyle = getOverlayFontStyle(run.fontName, fd);
                // Embedded faces already carry weight — don't synthesize extra bold
                // (matches canvas renderer). Fall back to flag-based weight otherwise.
                let bold = fd?.fontBytes
                  ? faceStyle.fontWeight === 'bold' || flags.bold
                  : flags.bold;
                let italic = fd?.fontBytes
                  ? faceStyle.fontStyle === 'italic' || flags.italic
                  : flags.italic;
                let underline = !!run.isUnderline || runHasPathUnderline(run, pathItems);
                let color = run.fillColor
                  ? `rgb(${Math.round(run.fillColor[0] * 255)}, ${Math.round(run.fillColor[1] * 255)}, ${Math.round(run.fillColor[2] * 255)})`
                  : colorCss;
                let segFontSize = visualFontSize(run) * scale;
                let segFontFamily = getOverlayFontFamily(run.fontName, fd);

                for (const ov of editStyleOverrides) {
                  if (piece.start >= ov.start && piece.end <= ov.end) {
                    if (ov.bold != null) bold = ov.bold;
                    if (ov.italic != null) italic = ov.italic;
                    if (ov.underline != null) underline = ov.underline;
                    if (ov.color) color = ov.color.startsWith('#') ? ov.color : color;
                    if (ov.fontSize != null) segFontSize = ov.fontSize * scale;
                    if (ov.fontFamily) {
                      segFontFamily = cssFontFamilyFromUI(ov.fontFamily);
                    }
                  }
                }

                const fontWeight = bold ? 'bold' : 'normal';
                const fontStyle = italic ? 'italic' : 'normal';

                return {
                  text: piece.text,
                  fontFamily: segFontFamily,
                  fontSizeCss: segFontSize,
                  fontWeight,
                  fontStyle,
                  underline,
                  color,
                };
              });

              return (
                <EditableLineBox
                  left={left}
                  top={top}
                  naturalWidth={naturalWidth}
                  naturalHeight={naturalHeight}
                  fontSizeCss={fontSizeCss}
                  fontFamily={getOverlayFontFamily(primaryRun?.fontName || '', fontData)}
                  fontWeight={textBold ? 'bold' : 'normal'}
                  fontStyle={textItalic ? 'italic' : 'normal'}
                  underline={textUnderline}
                  color={colorCss}
                  segments={overlaySegments}
                  text={editText}
                  caretStart={editSel.start}
                  caretEnd={editSel.end}
                  textRef={hiddenInputRef}
                  onTextInput={handleHiddenInput}
                  onKeyDown={handleHiddenKeyDown}
                  onSelect={handleEditSelection}
                  onBlur={handleHiddenBlur}
                  offsetCssX={editOffsetCss.x}
                  offsetCssY={editOffsetCss.y}
                  manualWidth={editManualSize.w}
                  manualHeight={editManualSize.h}
                  onOffsetChange={(x, y) => setEditOffsetCss({ x, y })}
                  onSizeChange={(w, h) => setEditManualSize({ w, h })}
                />
              );
            })()}

            {/* Link hover / edit popovers on the PDF (after Scan for links) */}
            {linksHighlighted && selectedLink && linkPopoverMode && renderResult && doc && (() => {
              const page = doc.pages[currentPage];
              const { mediaBox } = page;
              const topLeft = pdfToCanvas(
                selectedLink.rect.x,
                selectedLink.rect.y + selectedLink.rect.height,
                scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
              );
              const bottomRight = pdfToCanvas(
                selectedLink.rect.x + selectedLink.rect.width,
                selectedLink.rect.y,
                scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
              );
              const bx = Math.min(topLeft.cssX, bottomRight.cssX);
              const by = Math.min(topLeft.cssY, bottomRight.cssY);
              const bw = Math.abs(bottomRight.cssX - topLeft.cssX);
              const bh = Math.abs(bottomRight.cssY - topLeft.cssY);
              return (
                <LinkPopover
                  mode={linkPopoverMode}
                  anchorX={bx + bw / 2}
                  anchorY={by + bh}
                  url={linkDraftUrl}
                  displayText={linkDisplayDraft}
                  onUrlChange={setLinkDraftUrl}
                  onDisplayChange={setLinkDisplayDraft}
                  onEdit={() => {
                    if (linkHoverTimerRef.current) {
                      clearTimeout(linkHoverTimerRef.current);
                      linkHoverTimerRef.current = null;
                    }
                    setLinkPopoverMode('edit');
                  }}
                  onOpen={() => {
                    const url = (linkDraftUrl || selectedLink.url || '').trim();
                    if (url) window.open(url, '_blank', 'noopener,noreferrer');
                  }}
                  onRemove={removeLinkFromPopover}
                  onClose={() => { void saveLinkFromPopover(true); }}
                  onPopoverEnter={() => {
                    linkPopoverHoverRef.current = true;
                    if (linkHoverTimerRef.current) {
                      clearTimeout(linkHoverTimerRef.current);
                      linkHoverTimerRef.current = null;
                    }
                  }}
                  onPopoverLeave={() => {
                    linkPopoverHoverRef.current = false;
                    if (linkPopoverMode === 'hover') scheduleLinkHoverClose();
                  }}
                />
              );
            })()}
          </div>
          </div>
        </div>

        {/* ── Right Sidebar: Page Thumbnails (hidden on mobile, shown via floating button) ── */}
        {!isMobile && (
          <ThumbnailsSidebar
            totalPages={totalPages}
            currentPage={currentPage}
            thumbnails={thumbnails}
            isGeneratingThumbnails={isGeneratingThumbnails}
            onPageSelect={(i) => {
              commitDrawingsToPdf();
              closeLinkPopover();
              setLinkCreatePending(false);
              setCurrentPage(i);
            }}
            onDeletePage={handleDeletePage}
            onInsertBlankPage={handleInsertBlankPage}
            onInsertPdf={handleInsertPdf}
            onRotatePage={handleRotatePage}
            onReorderPages={handleReorderPages}
            onMergePdf={handleMergePdf}
            onSplitCurrentPage={handleSplitCurrentPage}
            onSplitAllPages={handleSplitAllPages}
            onRemoveCurrentPage={handleRemoveCurrentPage}
          />
        )}

        {/* ── Mobile: Floating "Pages" button ── */}
        {isMobile && !showMobileThumbnails && (
          <button
            onClick={() => setShowMobileThumbnails(true)}
            className="fixed bottom-16 right-3 z-30 flex items-center gap-1.5 px-3 py-2 bg-panel/95 backdrop-blur-md border border-app rounded-xl shadow-lg text-app-muted text-xs font-medium hover:text-app transition-colors"
            title="Show page thumbnails"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="8" y1="3" x2="8" y2="21"/></svg>
            {totalPages}p
          </button>
        )}

        {/* ── Mobile: Thumbnails drawer ── */}
        {isMobile && showMobileThumbnails && (
          <ThumbnailsSidebar
            totalPages={totalPages}
            currentPage={currentPage}
            thumbnails={thumbnails}
            isGeneratingThumbnails={isGeneratingThumbnails}
            onPageSelect={(i) => {
              commitDrawingsToPdf();
              closeLinkPopover();
              setLinkCreatePending(false);
              setCurrentPage(i);
              setShowMobileThumbnails(false);
            }}
            onDeletePage={handleDeletePage}
            onInsertBlankPage={handleInsertBlankPage}
            onInsertPdf={handleInsertPdf}
            onRotatePage={handleRotatePage}
            onReorderPages={handleReorderPages}
            onMergePdf={handleMergePdf}
            onSplitCurrentPage={handleSplitCurrentPage}
            onSplitAllPages={handleSplitAllPages}
            onRemoveCurrentPage={handleRemoveCurrentPage}
            isMobile={true}
            onClose={() => setShowMobileThumbnails(false)}
          />
        )}
      </div>

      {/* ── Bottom status bar ── */}
      <div className="shrink-0">
        <StatusBar
          renderResult={renderResult}
          activeTool={activeTool}
          selectedRun={selectedLine?.runs[0] ?? null}
          doc={doc}
          totalPages={totalPages}
        />
      </div>

      {/* Error toast */}
      {error && (
        <div role="alert" data-testid="error-toast" className="fixed bottom-10 left-1/2 -translate-x-1/2 w-max max-w-[calc(100vw-2rem)] bg-popover border border-destructive/30 text-destructive px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-4 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.25)] z-[100] animate-fade-up">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss" className="text-destructive/80 hover:text-destructive transition-colors shrink-0">
            <X size={16} />
          </button>
        </div>
      )}
      {isConfirmingRemoval && (
        <div className="fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div role="dialog" aria-label="Remove watermarks" className="bg-popover border border-border rounded-2xl p-6 shadow-2xl max-w-sm w-full animate-scale-in">
            <h3 className="text-foreground font-bold text-lg mb-2">Remove watermarks</h3>
            <p className="text-muted-foreground text-sm mb-6">
              Do you really want to remove the detected watermarks from this document? This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setIsConfirmingRemoval(false)}
                className="px-4 py-2 rounded-lg font-semibold text-sm text-foreground/90 hover:text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeRemoveWatermarks}
                className="px-4 py-2 rounded-lg font-semibold text-sm bg-destructive hover:brightness-110 text-destructive-foreground transition-colors"
              >
                Yes, Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {showApplySuccessModal && (
        <div className="fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div role="dialog" aria-label="Watermark applied" className="bg-popover border border-border rounded-2xl p-6 shadow-2xl max-w-sm w-full text-center animate-scale-in">
            <h3 className="text-foreground font-bold text-lg mb-4">Watermark applied</h3>
            <p className="text-muted-foreground text-sm mb-6 leading-relaxed">
              The watermark has been applied and Live Preview is off. To add another watermark, turn Live Preview back on.
            </p>
            <button
              onClick={() => setShowApplySuccessModal(false)}
              className="w-full h-11 px-4 rounded-xl font-bold text-sm bg-primary hover:brightness-105 text-primary-foreground shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)] transition-all"
            >
              Okay
            </button>
          </div>
        </div>
      )}

      <SignatureCreateDialog
        open={signatureCreateOpen}
        onOpenChange={setSignatureCreateOpen}
        onSave={handleSignatureCreateSave}
      />
      <CertificateImportDialog
        open={certificateImportOpen}
        onOpenChange={setCertificateImportOpen}
        onChange={(list) => {
          setCertificateIdentities(list);
          setSelectedCertificateId(getCertificateManager().getSelected()?.id ?? null);
        }}
      />

      {/* ── Export Panel ── */}
      <SignedCompressDialog open={signedCompressOpen} onChoose={chooseSignedCompress} />
      <ExportPanel
        isOpen={showExportPanel}
        onClose={() => setShowExportPanel(false)}
        doc={doc}
        engine={engineModule}
        fileName={fileName}
        totalPages={totalPages}
        currentPage={currentPage}
        getPdfBytes={getPdfBytesForConvert}
      />
    </div>
  );
}

/** True when the file contains a digital signature (a signature dictionary with /ByteRange). */
function hasDigitalSignature(bytes: Uint8Array | ArrayBuffer | null | undefined): boolean {
  if (!bytes) return false;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const needle = [0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]; // "/ByteRange"
  outer: for (let i = 0; i <= view.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (view[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
