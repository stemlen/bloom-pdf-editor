/**
 * PDF Engine — Public API
 *
 * This is the main entry point for the PDF engine.
 * Import from '@/engine' to access all parsing, rendering, and editing capabilities.
 */

// ── Core types ──
export {
  PDFName,
  PDFString,
  PDFHexString,
  PDFNumber,
  PDFBoolean,
  PDFNull,
  PDFRef,
  PDFArray,
  PDFDict,
  PDFStream,
} from './types';

export type {
  PDFObject,
  XRefEntry,
  XRefTable,
  PDFRectangle,
  PDFPageInfo,
  PDFDocumentInfo,
  PDFDocumentData,
} from './types';

// ── Parser ──
export { parsePDF, resolveRef, deepResolve, getPageContentBytes, getResource } from './parser/parser';
export { PDFLexer, TokenType } from './parser/lexer';
export type { Token } from './parser/lexer';
export { applyFilters, flateEncode } from './parser/filters';

// ── Content Stream ──
export { parseContentStream } from './content/operator-lexer';
export type { CSInstruction } from './content/operator-lexer';
export { interpretPage } from './content/interpreter';
export type {
  TextRun,
  GlyphPosition,
  PathItem,
  PathSegment,
  ImageItem,
  DisplayItem,
  InterpreterResult,
  GraphicsState,
  Matrix,
  FontInfo,
} from './content/interpreter';

// ── Fonts ──
export { loadPageFonts, loadFont, charCodeToUnicode } from './fonts/font-parser';
export type { FontData } from './fonts/font-parser';
export { getStandardFont, getCSSFontFamily, getStandardFontCharWidth } from './fonts/standard14';
export type { StandardFontMetrics } from './fonts/standard14';
export { parseCMap, getCodeBytes } from './fonts/cmap-parser';
export type { CMapData } from './fonts/cmap-parser';
export { parseTTF, getGlyphOutline, charCodeToGlyphId, getGlyphWidth } from './fonts/truetype-parser';
export { parseGSUBLigatures, applyLigatures, shapeGlyphIdsWithLigatures } from './fonts/gsub';
export type { LigatureRule } from './fonts/gsub';
export {
  parseGPOSPairAdjustments,
  parseGPOSMarkRecords,
  lookupGPOSPair,
  applyGPOSAdjustments,
} from './fonts/gpos';
export type { GPOSPairAdjustment, GPOSMarkRecord } from './fonts/gpos';
export type { TTFFont, GlyphOutline, GlyphCommand } from './fonts/truetype-parser';
export {
  ensureFallbackFont,
  buildSimpleToUnicodeCMap,
  augmentFontsForMissingGlyphs,
} from './fonts/font-augmentation';
export {
  normalizeIndicText,
  reorderPreBaseVowels,
  reorderIndicGlyphs,
  repairIndicRuns,
  isIndicCombiningChar,
  isDevanagariChar,
  isLegacyIndicFont,
  convertKrutiDevToUnicode,
  INDIC_FONT_FALLBACKS,
  EMOJI_FONT_FALLBACKS,
  hasEmoji,
  countEmoji,
} from './fonts/indic-normalizer';

// ── Renderer ──
export { renderPage, renderPageToCanvas, renderPDFPage, renderAllPages } from './render/renderer';
export type { RenderOptions, RenderResult } from './render/renderer';
export { parseColorSpace, cmykToRGB, rgbToCSSColor, componentsToCSSColor } from './render/color-space';
export type { ColorSpace, RGBColor } from './render/color-space';

// ── Flow (line/paragraph model) ──
export {
  buildDocumentFlow,
  reconstructLines,
  reconstructParagraphs,
  applyLineTextEdit,
  correctLineResidualGaps,
  hitTestTextLine,
  findNearestTextLine,
  caretIndexFromLineX,
  lineXFromCaretIndex,
  distributeTextToSegments,
  distributeTextChangeToSegments,
  segmentAtIndex,
  computeLineWidthDelta,
  analyzeJustification,
  distributeJustifiedSpace,
  distributeGlue,
  opticalMarginAdjust,
  computeBaseline,
  getRunBounds,
  visualFontSize,
  fontNameStyleFlags,
  resolveRunStyleFlags,
  averageCharWidth,
  estimateTextWidth,
  greedyWrap,
  previewWrap,
  knuthPlassWrap,
  hyphenateBreaks,
  computeLayoutPlan,
  computeEditPreview,
  computeHorizontalShifts,
  computeLineHeight,
  findParagraphForLine,
  computeFlowDrawPositions,
  buildLineDrawMap,
  buildFlowDrawIndex,
  shapeText,
  measureText,
  layoutShapedGlyphs,
  applyStyleToSelection,
  applyStyleToLine,
  applyStyleToSelectionOnPage,
  collectBatchedFontSizeTrailingShifts,
  mapSelectionToSegments,
  resolveStyledFontName,
  duplicateLineBelow,
  duplicateTableRowBelow,
  insertTableColumnRight,
  detectTablesOnPage,
  hitTestTableCell,
  getTableRowLines,
  findCellForLine,
  detectColumnSplitIndices,
  resolveBidiLevels,
  reorderForDisplay,
  visualToLogical,
  logicalToVisual,
  graphemeClusters,
  moveCaret,
  snapCaretToGrapheme,
  lineSelectionToQuadPoints,
  multiLineSelectionToQuadPoints,
  quadPointsToRect,
} from './flow';
export type {
  DocumentFlow,
  TextLine,
  Paragraph,
  StyledSegment,
  SegmentEdit,
  LayoutPlan,
  LineTextEdit,
  RunShift,
  FlowGlyphDraw,
  ShapedGlyph,
  TextStylePatch,
  StyleEditResult,
  KnuthPlassOptions,
  DetectedTable,
  TableCell,
} from './flow';

// ── Bloom Engine (Word-like document model) ──
export {
  ingestPage,
  ingestDocument,
  resetBloomIds,
  layoutPage,
  layoutBlock,
  measureWithRuns,
  sliceRunsForRange,
  insertTextAtCaret,
  deleteTextAtCaret,
  replaceRange,
  replaceBlockText,
  setBlockText,
  hitTestBloomPage,
  findNearestBlock,
  caretPdfPosition,
  renderBloomPage,
  maskBloomTextRegions,
  paintBloomOverPdf,
  maskBloomBlocks,
  renderBloomBlocks,
  paintBloomBlocksOverPdf,
  compilePage,
  compilePageAndClearDirty,
  compileBlocks,
  compileBlocksAndClearDirty,
  stripOwnedTextOps,
  collectOwnedIndices,
  blockPlainText,
} from './bloom';
export type {
  BloomRun,
  BloomBlockKind,
  BloomAlign,
  BloomBox,
  BloomLineBox,
  BloomBlock,
  BloomFrame,
  BloomPage,
  BloomDocument,
  BloomCaret,
  BloomSelection,
  IngestPageOptions,
  BloomRenderOptions,
  CompilePageResult,
} from './bloom';

// ── Editor ──
export { applyTextEdits, applyRunPositionShifts, findTextInPage, findAndReplace, insertTextRun } from './editor/text-editor';
export { insertImageRun, replaceImageXObject } from './editor/image-editor';
export type { TextEdit, EditResult, RunPositionShift } from './editor/text-editor';
export {
  applyObjectTransform,
  deleteObject,
} from './editor/object-editor';
export { markRedaction, applyRedactions, unionRects, rectsOverlap } from './editor/redaction';
export type { Rect as RedactionRect, ApplyRedactionsResult } from './editor/redaction';
export {
  addHighlightFromSelection,
  addHighlightFromLineSelection,
  addHighlightFromMultiLineSelection,
} from './editor/highlight';
export type { SelectionPos } from './editor/highlight';
export { insertInvisibleTextLayer } from './editor/invisible-text';
export type { InvisibleWord } from './editor/invisible-text';
export {
  compileContentStream,
  updatePageContent,
  serializeObject,
  serializeToString,
  serializeIndirectObject,
  concatBytes,
} from './editor/stream-compiler';
export {
  createAnnotationDict,
  addAnnotationToPage,
  removeAnnotationFromPage,
  eraseAnnotationsAtPoint,
  findMarkupAnnotationsAtPoint,
  hitTestMarkupAnnotation,
  clearMarkupAnnotationsOnPage,
  pdfDateString,
} from './editor/annotation-engine';
export type {
  AnnotationBase,
  MarkupAnnotationHit,
  HighlightAnnotation,
  FreeTextAnnotation,
  InkAnnotation,
  LineAnnotation,
  SquareAnnotation,
  CircleAnnotation,
  StampAnnotation,
  RedactAnnotation,
  LinkAnnotation,
  Annotation,
} from './editor/annotation-engine';
export {
  addLinkFromLineSelection,
  listPageLinks,
  hitTestPageLink,
  removePageLink,
  updatePageLinkUrl,
  normalizeUrl,
} from './editor/link';
export type { PageLinkInfo } from './editor/link';

// ── Writer ──
export { serializeDocument, serializeDocumentCompact, getNextObjNum } from './writer/serializer';
export { saveIncremental, appendIncrementalUpdate, IncrementalUpdateSession, listRevisions, OffsetManager, RevisionManager } from './writer/incremental-writer';
export type { IncrementalWriteResult, IncrementalWriteOptions } from './writer/incremental-writer';
export type { PDFRevision, RevisionChain } from './writer/revision-manager';
export type { OffsetRecord, ObjectKey } from './writer/offset-manager';
export { saveQuick, saveOptimized, saveDocument } from './writer/save-pipeline';
export type { SaveMode } from './writer/save-pipeline';
export {
  deletePage,
  deletePages,
  reorderPages,
  movePage,
  rotatePage,
  rotatePageBy,
  insertBlankPage,
  extractPages,
  insertPagesFromDocument,
} from './writer/page-operations';

export { measureTextLine, measureTextRange, shapedGlyphsToPositions } from './fonts/measurement';
export type { TextMetrics } from './fonts/measurement';

// ── Color (Phase 3) ──
export {
  parseICCProfile,
  getICCTag,
  iccColorSpaceComponents,
  parseICCLutTag,
  parseMft2Table,
  transformDeviceToPCS,
  transformPCSToDevice,
  iccBasedToRGB,
} from './color';
export type { ICCProfile, ICCHeader, ICCTag, ICCLutInfo, ICCLutType, Mft2Table } from './color';

// ── Editing (Phase 5) ──
export {
  QuadTree,
  hitTestSpatial,
  TransactionStack,
  EditorHistory,
  captureHistoryEntry,
  captureAnnotSnapshot,
  restoreAnnotSnapshot,
  clonePDFObject,
  makeOverlaySnapshot,
  parseOverlaySnapshot,
  buildDisplayListIndex,
  hitTestDisplayList,
  isSelectableDisplayItem,
  isPageBackgroundPath,
  buildSceneGraph,
  hitTestScene,
  composeTransform,
  invertAffine,
  transformObject,
  snapToGuides,
  buildPageGuides,
  buildObjectGuides,
  buildAllGuides,
  multiplyAffine,
  identityAffine,
} from './editing';
export type {
  Bounds,
  SpatialEntry,
  EditSnapshot,
  EditorHistoryEntry,
  OverlaySnapshot,
  PageAnnotSnapshot,
  SelectableItem,
  EditableObject,
  Affine,
  SnapGuide,
  Guide,
  ObjectTransformOps,
} from './editing';

// ── Image (Phase 4) ──
export { decodeImage } from './image';
export type { DecodedImage } from './image';

// ── Render 2.0 (Phase 1) ──
export {
  GraphicsStateStack,
  multiplyMatrices,
  identityMatrix,
  transformPoint,
  defaultGraphicsState,
  cloneGraphicsState,
} from './render/graphics-state';
export { toCanvasBlendMode, compositeOver } from './render/transparency';
export { parseSoftMask, effectiveAlpha } from './render/soft-mask';
export type { SoftMaskInfo, SoftMaskSubtype } from './render/soft-mask';
export { parseTilingPattern, createCanvasPattern, isPatternColorSpace } from './render/patterns';
export type { TilingPattern, PatternPaintType } from './render/patterns';
export { applyClipPaths } from './render/clipping';
export { interpolateShading, axialParameter } from './render/shading';
export type { ClipPathNode as RenderClipPathNode } from './render/graphics-state';
export type { Shading, AxialShading, RadialShading } from './render/shading';

// ── Forms (Phase 6) ──
export {
  buildAppearanceStream,
  appearanceToPageContent,
  parseWidgetRect,
  flattenField,
  flattenWidgets,
  parseAcroFormCatalog,
  detectFormFieldsOnPage,
  listAllFormWidgets,
  hitTestFormField,
  setFormFieldValue,
  flattenFormFieldsOnPage,
  setButtonFieldValue,
  setChoiceFieldValue,
  regenerateNeedAppearances,
  runCalculationOrder,
} from './forms';
export type {
  AcroFormFieldType,
  AcroFormWidget,
  AcroFormField,
  FlattenFieldResult,
} from './forms';

// ── OCR (Phase 7) ──
export {
  computeHorizontalProjection,
  detectLayoutRegions,
  detectDeskewAngle,
  analyzePageLayout,
} from './ocr';
export type { ProjectionProfile, LayoutRegion, PageLayout } from './ocr';

// ── Optimize (Phase 9) ──
export {
  garbageCollect,
  deduplicateStreams,
  computeReachability,
  compressDocumentImages,
} from './optimize';
export type {
  GarbageCollectResult,
  DeduplicateResult,
  ReachabilityResult,
  ImageCompressOptions,
  ImageCompressResult,
} from './optimize';

// ── Signatures (Phase 10 + visual Phases 1–5) ──
export {
  verifySignatureDigest,
  parseDER,
  parseCMSSignedData,
  createSignatureField,
  signDocument,
  signDocumentWithResult,
  signDocumentCryptographic,
  buildDetachedCMS,
  buildDetachedCMSAdvanced,
  // Visual signatures
  createVisualSignature,
  cloneVisualSignature,
  hitTestSignature,
  moveSignature,
  resizeSignature,
  rotateSignature,
  setSignatureOpacity,
  setSignatureLocked,
  deleteSignature,
  updateSignature,
  signatureToBBox,
  nextSignatureId,
  resetSignatureIdCounter,
  SignatureHistory,
  SignatureDrawEngine,
  paintStroke,
  strokeToPathD,
  isAllowedSignatureFile,
  importSignatureFile,
  importSvgString,
  importDataURL,
  listTypedSignatureFonts,
  renderTypedSignature,
  typedSignatureToSVG,
  SignatureLibrary,
  getSignatureLibrary,
  resetSignatureLibraryForTests,
  buildSignatureAppearance,
  cloneAppearance,
  setAppearanceComponentVisible,
  updateAppearanceLayout,
  listAppearanceTemplates,
  getAppearanceTemplate,
  renderSignatureAppearance,
  buildAppearanceSVG,
  rasterizeAppearanceAsync,
  DEFAULT_SIGNATURE_SIZE,
  TYPED_SIGNATURE_FONTS,
  // Phase 4 — signature fields
  listSignatureFields,
  detectSignatureFieldsOnPage,
  hitTestSignatureField,
  lookupSignatureFieldByName,
  lookupSignatureFieldByRef,
  createSignatureFieldAtPoint,
  placeSignatureInField,
  hitTestAnyFormOrSignatureField,
  ensureAcroFormCatalog,
  widgetToSignatureField,
  // Phase 5 — appearance streams
  AppearanceResourceManager,
  buildSignatureAppearanceContent,
  serializeAppearanceStream,
  attachNormalAppearance,
  embedAppearanceImage,
  dataUrlToJpegBytes,
  applySignatureFieldAppearance,
  applySignatureFieldAppearanceAsync,
  getNormalAppearanceRef,
  // Phase 7–8 — crypto + ByteRange finalizer
  hashBytes,
  hashByteRanges,
  bytesToHex,
  hexToBytes,
  HASH_ALGORITHMS,
  getSignedAttributesForSigning,
  findContentsHexSpan,
  computeByteRangeFromContentsSpan,
  calculateByteRange,
  validateByteRange,
  hashExcludedContents,
  fillContentsHex,
  patchByteRangeInPlace,
  injectSignature,
  makeContentsPlaceholder,
  DEFAULT_CONTENTS_SIZE,
  BYTERANGE_DIGIT_WIDTH,
  computeDocumentDigest,
  finalizePdfSignature,
  // Phase 9 — certificates
  decodePem,
  isPem,
  parseCertificateDer,
  importFromPem,
  importCertificateDer,
  importPkcs12,
  detectCertificateFileFormat,
  formatCertificateSummary,
  isCertificateExpired,
  CertificateManager,
  getCertificateManager,
  resetCertificateManagerForTests,
  // Phase 10–14
  validateDocumentSignatures,
  validateSignatureField,
  validationStatusBadge,
  extractPdfSignatureDict,
  verifyCmsCryptographic,
  buildTimestampRequest,
  parseTimestampResponse,
  requestTimestamp,
  cmsHasTimestampToken,
  DEFAULT_TSA_URLS,
  listManagedSignatures,
  buildRevisionViewer,
  inspectMultiSignatures,
  canAddSignatureWithoutInvalidating,
  buildDocumentSecurityStore,
  embedDssIncremental,
  readDssSummary,
  collectEmbeddedCertificates,
  enableLongTermValidation,
  getLtvStatus,
  SIGNATURE_SHORTCUTS,
  pushRecentSignatureId,
  listRecentSignatureIds,
  orderLibraryByRecent,
  lockSignaturesAfterSigning,
  snapToAlignmentGuides,
  defaultPageGuides,
} from './signatures';
export type {
  ASN1Node,
  CMSSignedData,
  SignatureVerificationResult,
  SignOptions,
  CryptoSignOptions,
  SignPipelineResult,
  VisualSignature,
  SignatureAppearanceType,
  SignatureLibraryEntry,
  SignatureSourceKind,
  SignatureAppearance,
  AppearanceRenderResult,
  AppearanceRenderOptions,
  AppearanceTemplate,
  BuildAppearanceInput,
  ImportedSignature,
  TypedSignatureResult,
  TypedSignatureOptions,
  Stroke,
  StrokePoint,
  SignatureSnapshot,
  CreateSignatureOpts,
  SignatureField,
  CreateSignatureFieldOptions,
  SignatureFieldAppearanceOptions,
  SerializedAppearance,
  HashAlgorithm,
  SignatureAlgorithmKind,
  ByteRange,
  ContentsSpan,
  ByteRangeCalculation,
  FinalizeSignatureResult,
  CertificateInfo,
  CertificateFormat,
  ImportedCertificateBundle,
  ManagedIdentity,
  DistinguishedName,
  ValidationStatus,
  ValidationOptions,
  ValidationReport,
  SignatureValidationDetail,
  ManagedSignature,
  MultiSignatureSnapshot,
  RevisionViewEntry,
  LtvStatus,
  DssBuildResult,
  TimestampResult,
} from './signatures';

// ── Security Engine (Phases 1–10) ──
export {
  securityEngine,
  SecurityEngine,
  encryptionEngine,
  EncryptionEngine,
  passwordEngine,
  PasswordEngine,
  permissionEngine,
  PermissionEngine,
  publicKeyEncryptionEngine,
  PublicKeyEncryptionEngine,
  RecipientManager,
  metadataEngine,
  MetadataEngine,
  embeddedFileSecurityEngine,
  EmbeddedFileSecurityEngine,
  javaScriptSecurityEngine,
  JavaScriptSecurityEngine,
  redactionEngine,
  RedactionEngine,
  sanitizationEngine,
  SanitizationEngine,
  integrityScanner,
  IntegrityScanner,
  secureOptimizer,
  SecureOptimizer,
  securityPolicyEngine,
  SecurityPolicyEngine,
  securityInspector,
  SecurityInspector,
  enterpriseSecurity,
  EnterpriseSecurityLayer,
  parseEncryptDict,
  parseFileId,
  getEncryptDictFromTrailer,
  isEncryptedTrailer,
  ensureFileId,
  detectAlgorithm,
  padPassword,
  computeObjectKey,
  decryptBytes,
  encryptBytes,
  decryptDocumentObjects,
  encryptDocumentObjects,
  parsePermissions,
  serializePermissions,
  mergePermissions,
  allowsOperation,
  assertAllowed,
  md5,
  rc4,
  DEFAULT_PERMISSIONS,
} from './security';
export type {
  EncryptionAlgorithm,
  EncryptionRevision,
  EncryptDictionary,
  EncryptionContext,
  PdfPermissions,
  RestrictedOperation,
  PasswordRole,
  PasswordAuthResult,
  EncryptOptions,
  SecurityOpenResult,
  SecurityInspectionReport,
  FileIdPair,
  RecipientCert,
  RecipientInfo,
  PublicKeyEncryptOptions,
  MetadataStripOptions,
  MetadataValidationResult,
  EmbeddedAttachment,
  ActionKind,
  DetectedAction,
  ActionSecurityReport,
  SecureRedactionOptions,
  SecureRedactionResult,
  RedactionVerification,
  FullSecurityReport,
  SecurityPolicy,
  AuditEntry,
  BatchResult,
} from './security';

// ── AI (Phase 12) ──
export {
  chunkDocument,
  buildSemanticSearchIndex,
  searchSemanticIndex,
  comparePageText,
  compareDocuments,
  extractPagePlainText,
} from './ai';
export type {
  DocumentChunk,
  SemanticSearchIndex,
  SearchHit,
  TextDiff,
  DocumentCompareResult,
} from './ai';

// ── Watermark ──
export {
  buildTextWatermarkContent,
  buildImageWatermarkContent,
  buildPatternWatermarkContent,
  createOpacityExtGState,
  createWatermarkImageXObject,
  applyWatermarkToPage,
  applyWatermarks,
} from './watermark/watermark-engine';
export type {
  WatermarkType,
  WatermarkBase,
  TextWatermark,
  ImageWatermark,
  PatternWatermark,
  WatermarkPosition,
  Watermark,
} from './watermark/watermark-engine';

export { detectWatermarks, detectWatermarksOnPage } from './watermark/watermark-detector';
export type { DetectedWatermark, DetectionOptions } from './watermark/watermark-detector';

export {
  removeWatermarks,
  removeWatermarksFromPage,
  detectAndRemoveAllWatermarks,
} from './watermark/watermark-remover';
export type { RemovalResult, BatchRemovalResult } from './watermark/watermark-remover';
