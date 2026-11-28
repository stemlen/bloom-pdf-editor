import type { LogicalTable } from '../../../table/types.js';
import { paragraph, runText } from '../ooxml/xml.js';
import { parseEducationRow } from '../utils/heuristics.js';
import { compactCellParagraph } from '../utils/runs.js';

export function writeTable(table: LogicalTable): string {
  const colCount = table.columns.length;
  const grid = table.columns
    .map((c) => {
      const twips = Math.max(400, Math.round((c.width || 100) * 15));
      return `<w:gridCol w:w="${twips}"/>`;
    })
    .join('');

  // Spans come from geometry and can overlap other cells (a wide title row
  // "spanning" rows that hold cells of their own). Shrink each span so it
  // never covers another cell; otherwise that cell's text is dropped.
  const key = (r: number, c: number) => `${r},${c}`;
  const cellAt = new Map(table.cells.map((cell) => [key(cell.rowIndex, cell.colIndex), cell]));
  const owner = new Map<string, { row: number; colSpan: number }>();
  const spans = new Map<(typeof table.cells)[number], { rowSpan: number; colSpan: number }>();
  const ordered = [...table.cells].sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);
  for (const cell of ordered) {
    const { rowIndex: r, colIndex: c } = cell;
    if (owner.has(key(r, c))) continue;
    const free = (rr: number, cc: number) => !cellAt.has(key(rr, cc)) && !owner.has(key(rr, cc));
    let colSpan = 1;
    while (colSpan < cell.colSpan && c + colSpan < colCount && free(r, c + colSpan)) colSpan++;
    let rowSpan = 1;
    while (
      rowSpan < cell.rowSpan &&
      r + rowSpan < table.rows.length &&
      Array.from({ length: colSpan }, (_, i) => free(r + rowSpan, c + i)).every(Boolean)
    ) {
      rowSpan++;
    }
    spans.set(cell, { rowSpan, colSpan });
    for (let rr = 0; rr < rowSpan; rr++) {
      for (let cc = 0; cc < colSpan; cc++) {
        if (rr || cc) owner.set(key(r + rr, c + cc), { row: r, colSpan });
      }
    }
  }

  const rowsXml: string[] = [];
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const tcs: string[] = [];
    for (let c = 0; c < colCount; c++) {
      const covered = owner.get(key(r, c));
      if (covered) {
        // Below a vertical merge: a continuation cell keeps the row's grid intact.
        if (covered.row < r) {
          const width = Math.round(
            table.columns.slice(c, c + covered.colSpan).reduce((sum, col) => sum + (col.width || 100), 0) * 15,
          );
          const gridSpan = covered.colSpan > 1 ? `<w:gridSpan w:val="${covered.colSpan}"/>` : '';
          tcs.push(`<w:tc><w:tcPr>${gridSpan}<w:vMerge/><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`);
          c += covered.colSpan - 1;
        }
        continue;
      }
      const cell = cellAt.get(key(r, c));
      const span = cell ? spans.get(cell) : undefined;
      if (!cell || !span) {
        tcs.push('<w:tc><w:tcPr/><w:p/></w:tc>');
        continue;
      }
      const tcPr: string[] = [];
      if (span.colSpan > 1) tcPr.push(`<w:gridSpan w:val="${span.colSpan}"/>`);
      if (span.rowSpan > 1) tcPr.push('<w:vMerge w:val="restart"/>');
      const width = Math.round(
        table.columns
          .slice(c, c + span.colSpan)
          .reduce((s, col) => s + (col.width || 100), 0) * 15,
      );
      tcPr.push(`<w:tcW w:w="${width}" w:type="dxa"/>`);
      tcs.push(
        `<w:tc><w:tcPr>${tcPr.join('')}</w:tcPr>${paragraph(runText(cell.text || ' '))}</w:tc>`,
      );
    }

    const trPr =
      row.role === 'header'
        ? '<w:trPr><w:tblHeader/></w:trPr>'
        : '';
    rowsXml.push(`<w:tr>${trPr}${tcs.join('')}</w:tr>`);
  }

  void colCount;
  return `<w:tbl>
  <w:tblPr>
    <w:tblW w:w="0" w:type="auto"/>
    <w:tblBorders>
      <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
      <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
      <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
      <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
      <w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>
      <w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>
    </w:tblBorders>
  </w:tblPr>
  <w:tblGrid>${grid}</w:tblGrid>
  ${rowsXml.join('\n')}
</w:tbl>`;
}

export function writeEducationTable(
  rowTexts: string[],
  accent: { text: string; headerFill: string; border: string; muted: string; fromPdf?: boolean },
): string {
  const headers = ['Course', 'Year', 'Institution/Board', 'Remarks'];
  // Proportional widths: Course narrow, Remarks wide to avoid text wrapping
  const widths = [2100, 1400, 2500, 4460];
  const fillC = accent.headerFill.replace('#', '');
  const borderC = accent.border.replace('#', '');
  const rowBorderC = 'D0D0D0';
  // Original: dashed green header band + light gray vertical column rules; no zebra
  const vBorder = (side: 'left' | 'right', isEdge: boolean) =>
    isEdge
      ? `<w:${side} w:val="nil"/>`
      : `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${rowBorderC}"/>`;
  const headerCells = headers
    .map((h, hi) => {
      const align = hi === 3 ? undefined : 'center';
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[hi]}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${fillC}"/><w:vAlign w:val="center"/><w:tcBorders><w:top w:val="dashed" w:sz="8" w:space="0" w:color="${borderC}"/>${vBorder('left', hi === 0)}${vBorder('right', hi === headers.length - 1)}<w:bottom w:val="dashed" w:sz="8" w:space="0" w:color="${borderC}"/></w:tcBorders></w:tcPr>${compactCellParagraph(runText(h, { bold: true, color: accent.text, fontSizePt: 9 }), align)}</w:tc>`;
    })
    .join('');
  const rows = rowTexts.map((rt) => {
    const cols = parseEducationRow(rt);
    const cells = cols
      .map((c, ci) => {
        const align = ci === 3 ? undefined : 'center';
        const isFirst = ci === 0;
        const isLast = ci === cols.length - 1;
        return `<w:tc><w:tcPr><w:tcW w:w="${widths[ci] ?? widths[3]}" w:type="dxa"/><w:vAlign w:val="center"/><w:tcBorders><w:top w:val="nil"/>${vBorder('left', isFirst)}${vBorder('right', isLast)}<w:bottom w:val="single" w:sz="4" w:space="0" w:color="${rowBorderC}"/></w:tcBorders></w:tcPr>${compactCellParagraph(runText(c || ' ', { fontSizePt: 8 }), align)}</w:tc>`;
      })
      .join('');
    return `<w:tr>${cells}</w:tr>`;
  });
  return `<w:tbl>
  <w:tblPr>
    <w:tblW w:w="0" w:type="auto"/>
    <w:tblCellMar>
      <w:top w:w="20" w:type="dxa"/><w:left w:w="40" w:type="dxa"/>
      <w:bottom w:w="20" w:type="dxa"/><w:right w:w="40" w:type="dxa"/>
    </w:tblCellMar>
    <w:tblBorders>
      <w:top w:val="nil"/>
      <w:left w:val="nil"/>
      <w:bottom w:val="nil"/>
      <w:right w:val="nil"/>
      <w:insideH w:val="nil"/>
      <w:insideV w:val="nil"/>
    </w:tblBorders>
  </w:tblPr>
  <w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>
  <w:tr>${headerCells}</w:tr>
  ${rows.join('\n')}
</w:tbl>`;
}
