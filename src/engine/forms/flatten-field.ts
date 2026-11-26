/**
 * AcroForm flattening — synthesize widget appearance streams and bake
 * field values into page content streams.
 *
 * Flattening removes interactivity while preserving visual appearance.
 * ISO 32000-2 §12.7.6 (Field flags), §12.5.5 (Appearance streams).
 */

import type { PDFDict, PDFObject, PDFRef, PDFRectangle } from '../types';
import type {
  AcroFormWidget,
  AppearanceStream,
  FlattenFieldOptions,
  FlattenFieldResult,
} from './types';
import { DEFAULT_FLATTEN_OPTIONS } from './types';

// ─── Appearance stream builder ──────────────────────────────────────────────

function escapePdfString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function rgbOperators(color: [number, number, number]): string {
  return `${color[0]} ${color[1]} ${color[2]} rg ${color[0]} ${color[1]} ${color[2]} RG `;
}

/**
 * Build a minimal normal appearance stream for a widget.
 * Supports Tx (text), Btn/checkbox, and basic Ch (selected option text).
 */
export function buildAppearanceStream(
  widget: AcroFormWidget,
  options: Partial<FlattenFieldOptions> = {},
): AppearanceStream {
  const opts = { ...DEFAULT_FLATTEN_OPTIONS, ...options };
  const { rect } = widget;
  const w = rect.width;
  const h = rect.height;

  let body = 'q\n';
  // Background first, then the border on top of it, then the value in the
  // text colour (painting the background last hid the value).
  if (widget.backgroundColor) {
    body += rgbOperators(widget.backgroundColor);
    body += `${rect.x} ${rect.y} ${w} ${h} re f `;
  }

  if (opts.drawBorder && widget.borderWidth > 0) {
    body += rgbOperators(widget.borderColor);
    body += `${widget.borderWidth} w `;
    body += `${rect.x} ${rect.y} ${w} ${h} re S `;
  }

  body += rgbOperators(opts.textColor);

  switch (widget.fieldType) {
    case 'Tx': {
      const text = typeof widget.value === 'string' ? widget.value : '';
      const pad = Math.max(2, widget.borderWidth + 1);
      const tx = rect.x + pad;
      const ty = rect.y + h * 0.25;
      body += `BT /${opts.fontResourceName} ${opts.fontSize} Tf `;
      body += `${tx} ${ty} Td (${escapePdfString(text)}) Tj ET `;
      break;
    }
    case 'Btn': {
      const checked = widget.value === true
        || widget.value === widget.exportValue
        || widget.appearanceState === 'Yes'
        || widget.appearanceState === 'On';
      if (checked) {
        const inset = Math.min(w, h) * 0.2;
        const cx = rect.x + w / 2;
        const cy = rect.y + h / 2;
        const r = Math.min(w, h) / 2 - inset;
        body += `${cx} ${cy} ${r} 0 360 arc S `;
        body += `${rect.x + inset} ${rect.y + inset} `;
        body += `${rect.x + w - inset} ${rect.y + h - inset} m S `;
        body += `${rect.x + inset} ${rect.y + h - inset} `;
        body += `${rect.x + w - inset} ${rect.y + inset} m S `;
      }
      break;
    }
    case 'Ch': {
      const selected = Array.isArray(widget.value)
        ? widget.value[0]
        : typeof widget.value === 'string'
          ? widget.value
          : '';
      const pad = Math.max(2, widget.borderWidth + 1);
      body += `BT /${opts.fontResourceName} ${opts.fontSize} Tf `;
      body += `${rect.x + pad} ${rect.y + h * 0.25} Td (${escapePdfString(selected ?? '')}) Tj ET `;
      break;
    }
    default:
      break;
  }

  body += 'Q\n';

  return {
    variant: 'N',
    stateName: widget.appearanceState,
    content: body,
    bbox: { ...rect },
    resources: {
      [`/${opts.fontResourceName}`]: { type: 'Font', subtype: 'Type1', baseFont: 'Helvetica' },
    } as unknown as Record<string, PDFObject>,
  };
}

/**
 * Wrap appearance content with matrix positioning for page insertion.
 * Widget rects are in page user space; we emit a form-like wrapper.
 */
export function appearanceToPageContent(
  appearance: AppearanceStream,
  widget: AcroFormWidget,
): string {
  const { rect } = widget;
  return [
    'q',
    '1 0 0 1 0 0 cm',
    appearance.content.trim(),
    'Q',
    `% flattened widget ${widget.fieldName} at ${rect.x},${rect.y}`,
  ].join('\n');
}

/** Parse widget rectangle from /Rect array [llx lly urx ury]. */
export function parseWidgetRect(dict: PDFDict): PDFRectangle {
  const rectArr = dict.getArray('Rect');
  if (!rectArr || rectArr.length < 4) {
    return { x: 0, y: 0, width: 100, height: 20 };
  }
  const nums = rectArr.asNumbers();
  const llx = nums[0] ?? 0;
  const lly = nums[1] ?? 0;
  const urx = nums[2] ?? llx + 100;
  const ury = nums[3] ?? lly + 20;
  return {
    x: llx,
    y: lly,
    width: Math.max(0, urx - llx),
    height: Math.max(0, ury - lly),
  };
}

/**
 * Flatten a single widget: synthesize appearance if needed and return
 * page content fragment plus widget refs to strip from the page Annots array.
 */
export function flattenField(
  widget: AcroFormWidget,
  options: Partial<FlattenFieldOptions> = {},
): FlattenFieldResult {
  const appearance = buildAppearanceStream(widget, options);
  const contentFragment = appearanceToPageContent(appearance, widget);

  return {
    fieldName: widget.fieldName,
    widgetRef: widget.ref,
    contentFragment,
    removeWidgetRefs: [widget.ref],
    synthesizedAppearance: true,
  };
}

/**
 * Flatten all widgets on a page, returning merged content and removed annot refs.
 */
export function flattenWidgets(
  widgets: AcroFormWidget[],
  options: Partial<FlattenFieldOptions> = {},
): { content: string; removedRefs: PDFRef[] } {
  const parts: string[] = [];
  const removedRefs: PDFRef[] = [];

  for (const widget of widgets) {
    const result = flattenField(widget, options);
    parts.push(result.contentFragment);
    removedRefs.push(...result.removeWidgetRefs);
  }

  return {
    content: parts.join('\n'),
    removedRefs,
  };
}
