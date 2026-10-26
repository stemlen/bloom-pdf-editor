/**
 * AcroForm field model — widgets, appearances, and flattening operations.
 *
 * ISO 32000-2 §12.7 (Interactive Forms), §12.5.5 (Appearance streams).
 */

import type { PDFDict, PDFObject, PDFRef, PDFRectangle } from '../types';

/** AcroForm field type (FT entry). */
export type AcroFormFieldType = 'Tx' | 'Btn' | 'Ch' | 'Sig';

/** Button field flags (Ff bit field for Btn). */
export type ButtonStyle = 'check' | 'circle' | 'cross' | 'diamond' | 'square' | 'star';

/** Widget annotation subtype — every field exposes one or more widget annotations. */
export interface AcroFormWidget {
  ref: PDFRef;
  dict: PDFDict;
  rect: PDFRectangle;
  pageRef: PDFRef | null;
  fieldName: string;
  fieldType: AcroFormFieldType;
  /** Current value (V entry or appearance state). */
  value: string | boolean | string[] | null;
  /** Default appearance string (/DA). */
  defaultAppearance: string;
  /** Border width in default user space units. */
  borderWidth: number;
  /** Background RGB 0–1, null when transparent. */
  backgroundColor: [number, number, number] | null;
  /** Border RGB 0–1. */
  borderColor: [number, number, number];
  /** Read-only flag (Ff bit 1). */
  readOnly: boolean;
  /** Required flag (Ff bit 2). */
  required: boolean;
  /** For Btn: radio vs checkbox vs pushbutton. */
  buttonFlags: number;
  /** For Ch: combo vs list, multi-select. */
  choiceFlags: number;
  /** Export value for checkbox/radio (Opt / AS). */
  exportValue: string | null;
  /** Selected appearance state name (/AS). */
  appearanceState: string | null;
  /** For Btn: the widget's "on" appearance state (the non-Off key of /AP /N). */
  onState: string | null;
  /** For Ch: display options from /Opt (own or inherited). */
  options: string[];
  /** For Tx: multiline flag (Ff bit 13). */
  multiline: boolean;
}

/** Parsed AcroForm catalog entry. */
export interface AcroFormCatalog {
  dict: PDFDict;
  fields: AcroFormField[];
  needAppearances: boolean;
  calculationOrder: PDFRef[];
  defaultResources: PDFDict | null;
}

/** Logical form field (may own child fields for hierarchical names). */
export interface AcroFormField {
  ref: PDFRef;
  dict: PDFDict;
  partialName: string;
  fullName: string;
  fieldType: AcroFormFieldType;
  value: string | boolean | string[] | null;
  defaultValue: string | boolean | string[] | null;
  widgets: AcroFormWidget[];
  kids: AcroFormField[];
  flags: number;
  options: string[];
}

/** Normal / down / rollover appearance sub-dictionary keys. */
export type AppearanceVariant = 'N' | 'D' | 'R';

/** Built appearance stream (content + resource dict fragment). */
export interface AppearanceStream {
  variant: AppearanceVariant;
  stateName: string | null;
  content: string;
  bbox: PDFRectangle;
  resources: Record<string, PDFObject>;
}

/** Result of flattening one widget onto a page content stream. */
export interface FlattenFieldResult {
  fieldName: string;
  widgetRef: PDFRef;
  /** Content-stream operators appended to the page. */
  contentFragment: string;
  /** Widget annotation refs to remove or mark non-interactive. */
  removeWidgetRefs: PDFRef[];
  /** Whether an appearance stream was synthesized (vs reused). */
  synthesizedAppearance: boolean;
}

/** Options for appearance generation and flattening. */
export interface FlattenFieldOptions {
  /** Include field border in synthesized appearance. */
  drawBorder: boolean;
  /** Font resource name injected into content stream. */
  fontResourceName: string;
  /** Font size for text fields (points). */
  fontSize: number;
  /** Text color RGB 0–1. */
  textColor: [number, number, number];
}

export const DEFAULT_FLATTEN_OPTIONS: FlattenFieldOptions = {
  drawBorder: true,
  fontResourceName: 'ZaDb',
  fontSize: 12,
  textColor: [0, 0, 0],
};
