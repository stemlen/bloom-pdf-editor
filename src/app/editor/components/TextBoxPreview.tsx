'use client';

/**
 * Draws a formatted text box from the same layout the PDF writer uses, so line
 * breaks, alignment, spacing and decorations on screen match the export.
 */

import { decorationGeometry, layoutTextBox, textBoxCssFamily, type TextBoxStyle } from '@/engine/editor/text-box';

interface TextBoxPreviewProps {
  text: string;
  style: TextBoxStyle;
  /** Wrap width in points, if the box has a fixed width. */
  maxWidth?: number;
  /** CSS pixels per point. */
  scale: number;
}

export function TextBoxPreview({ text, style, maxWidth, scale }: TextBoxPreviewProps) {
  const layout = layoutTextBox(text, style, maxWidth);
  const deco = decorationGeometry(style.fontSize);
  const family = textBoxCssFamily(style.fontFamily);
  const w = Math.max(layout.width, 1);
  return (
    <svg
      data-testid="text-box-preview"
      width={w * scale}
      height={layout.height * scale}
      viewBox={`0 0 ${w} ${layout.height}`}
      style={{ display: 'block', overflow: 'visible' }}
      aria-hidden="true"
    >
      {style.highlight && layout.lines.map((l, i) => (l.text === '' && !l.marker) ? null : (
        <rect
          key={`h${i}`}
          x={l.marker ? l.markerX : l.x}
          y={l.baseline - layout.ascent}
          width={l.x + l.width - (l.marker ? l.markerX! : l.x)}
          height={layout.bandHeight}
          fill={style.highlight!}
        />
      ))}
      <g
        fill={style.color}
        fontFamily={family}
        fontSize={style.fontSize}
        fontWeight={style.bold ? 700 : 400}
        fontStyle={style.italic ? 'italic' : 'normal'}
        letterSpacing={style.letterSpacing}
        style={{ whiteSpace: 'pre', fontKerning: 'none', fontVariantLigatures: 'none' }}
      >
        {layout.lines.map((l, i) => (
          <g key={i}>
            {l.marker && <text x={l.markerX} y={l.baseline}>{l.marker}</text>}
            {l.text !== '' && (
              <text x={l.x} y={l.baseline} wordSpacing={l.wordSpacing || undefined}>{l.text}</text>
            )}
            {l.text !== '' && style.underline && (
              <rect x={l.x} y={l.baseline + deco.underline.offset} width={l.width} height={deco.underline.thickness} />
            )}
            {l.text !== '' && style.strikethrough && (
              <rect x={l.x} y={l.baseline + deco.strike.offset - deco.strike.thickness / 2} width={l.width} height={deco.strike.thickness} />
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}
