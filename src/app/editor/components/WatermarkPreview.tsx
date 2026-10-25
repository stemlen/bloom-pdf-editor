'use client';

import { useEffect, useState } from 'react';
import type { PDFDocumentData } from '@/engine';
import { watermarkFitScale, watermarkNaturalSize } from '@/lib/watermarkFit';

interface WatermarkPreviewProps {
  doc: PDFDocumentData | null;
  currentPage: number;
  scale: number;
  watermarkType: 'text' | 'image' | 'shape';
  watermarkText: string;
  watermarkFontName: string;
  watermarkSize: number;
  watermarkColor: string;
  watermarkOpacity: number;
  watermarkRotation: number;
  watermarkMosaic: boolean;
  watermarkPosition: string;
  watermarkImageDims: { width: number; height: number } | null;
  watermarkImageFile: File | null;
  watermarkShapeType: 'rectangle' | 'circle' | 'pill';
  watermarkShapeColor: string;
  watermarkBlendMode: string;
}

export function WatermarkPreview({
  doc, currentPage, scale, watermarkType, watermarkText, watermarkFontName, watermarkSize,
  watermarkColor, watermarkOpacity, watermarkRotation, watermarkMosaic, watermarkPosition,
  watermarkImageDims, watermarkImageFile, watermarkShapeType, watermarkShapeColor,
  watermarkBlendMode,
}: WatermarkPreviewProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!watermarkImageFile) return;
    // An object URL is an external resource that must be revoked, so it is
    // created and released here and mirrored into state for rendering.
    const url = URL.createObjectURL(watermarkImageFile);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [watermarkImageFile]);

  const imgUrl = watermarkType === 'image' && watermarkImageFile ? objectUrl : null;

  if (!doc || !doc.pages[currentPage]) return null;

  const page = doc.pages[currentPage];
  // Match renderer: swapped dimensions when page /Rotate is 90 or 270
  const rotate = ((page.rotate % 360) + 360) % 360;
  const isRotated = rotate === 90 || rotate === 270;
  const pageWidth = isRotated ? page.mediaBox.height : page.mediaBox.width;
  const pageHeight = isRotated ? page.mediaBox.width : page.mediaBox.height;
  const opacity = watermarkOpacity / 100;
  // A single watermark larger than the page is shrunk to fit (the editor
  // applies the same factor when saving, so preview and output match).
  const natural = watermarkNaturalSize(watermarkType, watermarkText, watermarkSize, watermarkImageDims, watermarkShapeType);
  const fit = watermarkMosaic ? 1 : watermarkFitScale(natural.width, natural.height, watermarkRotation, pageWidth, pageHeight);
  const sizePercent = watermarkSize * fit;
  const fontSizeCss = (72 * (sizePercent / 100)) * scale;
  const imgWidthCss = watermarkImageDims?.width ? (watermarkImageDims.width * (sizePercent / 100)) * scale : 0;
  const imgHeightCss = watermarkImageDims?.height ? (watermarkImageDims.height * (sizePercent / 100)) * scale : 0;
  const padCss = 30 * scale;

  const textWidthCss = (watermarkText.length * (fontSizeCss / scale) * 0.5 * scale);
  const textHeightCss = fontSizeCss;

  let wmWidthCss = watermarkType === 'text' ? textWidthCss : watermarkType === 'shape' ? textWidthCss + 40 * scale : imgWidthCss;
  let wmHeightCss = watermarkType === 'text' ? textHeightCss : watermarkType === 'shape' ? textHeightCss + 40 * scale : imgHeightCss;
  if (watermarkType === 'shape' && watermarkShapeType === 'circle') {
    const maxDim = Math.max(wmWidthCss, wmHeightCss);
    wmWidthCss = maxDim;
    wmHeightCss = maxDim;
  }

  const blend = (watermarkBlendMode === 'ColorDodge' ? 'color-dodge'
    : watermarkBlendMode === 'ColorBurn' ? 'color-burn'
    : watermarkBlendMode === 'HardLight' ? 'hard-light'
    : watermarkBlendMode === 'SoftLight' ? 'soft-light'
    : watermarkBlendMode.toLowerCase()) as React.CSSProperties['mixBlendMode'];

  // CSS positive rotation is clockwise; PDF is counter-clockwise. Negate so
  // the overlay matches the baked watermark after the renderer's Y-flip.
  const cssRotation = -watermarkRotation;

  const renderItem = (cx: number, cy: number, key: string) => (
    <div
      key={key}
      style={{
        position: 'absolute',
        left: `${cx}px`,
        top: `${cy}px`,
        transform: `translate(-50%, -50%) rotate(${cssRotation}deg)`,
        opacity,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        mixBlendMode: blend,
      }}
    >
      {watermarkType === 'text' ? (
        <span style={{ fontSize: fontSizeCss, color: watermarkColor, fontFamily: watermarkFontName, whiteSpace: 'pre', lineHeight: 1 }}>
          {watermarkText}
        </span>
      ) : watermarkType === 'image' && imgUrl ? (
        <img src={imgUrl} style={{ width: imgWidthCss, height: imgHeightCss }} alt="watermark" />
      ) : watermarkType === 'shape' ? (
        <div style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: wmWidthCss,
          height: wmHeightCss,
          border: `2px solid ${watermarkShapeColor}`,
          borderRadius: watermarkShapeType === 'circle' ? '50%' : watermarkShapeType === 'pill' ? `${Math.min(wmWidthCss, wmHeightCss) / 2}px` : '0',
        }}>
          <span style={{ fontSize: fontSizeCss, color: watermarkColor, fontFamily: watermarkFontName, whiteSpace: 'pre', lineHeight: 1, zIndex: 1 }}>
            {watermarkText}
          </span>
        </div>
      ) : null}
    </div>
  );

  if (watermarkMosaic) {
    const spacing = 300 * scale;
    const cols = Math.ceil((pageWidth * scale) / spacing) + 1;
    const rows = Math.ceil((pageHeight * scale) / spacing) + 1;
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        tiles.push(renderItem(c * spacing, r * spacing, `tile-${r}-${c}`));
      }
    }
    return <div className="absolute inset-0 z-40 pointer-events-none overflow-hidden">{tiles}</div>;
  }

  let cx = (pageWidth / 2) * scale;
  let cy = (pageHeight / 2) * scale;

  switch (watermarkPosition) {
    case 'top-left': cx = padCss + wmWidthCss / 2; cy = padCss + wmHeightCss / 2; break;
    case 'top-center': cx = (pageWidth / 2) * scale; cy = padCss + wmHeightCss / 2; break;
    case 'top-right': cx = (pageWidth * scale) - padCss - wmWidthCss / 2; cy = padCss + wmHeightCss / 2; break;
    case 'center-left': cx = padCss + wmWidthCss / 2; cy = (pageHeight / 2) * scale; break;
    case 'center': cx = (pageWidth / 2) * scale; cy = (pageHeight / 2) * scale; break;
    case 'center-right': cx = (pageWidth * scale) - padCss - wmWidthCss / 2; cy = (pageHeight / 2) * scale; break;
    case 'bottom-left': cx = padCss + wmWidthCss / 2; cy = (pageHeight * scale) - padCss - wmHeightCss / 2; break;
    case 'bottom-center': cx = (pageWidth / 2) * scale; cy = (pageHeight * scale) - padCss - wmHeightCss / 2; break;
    case 'bottom-right': cx = (pageWidth * scale) - padCss - wmWidthCss / 2; cy = (pageHeight * scale) - padCss - wmHeightCss / 2; break;
  }

  return <div className="absolute inset-0 z-40 pointer-events-none overflow-hidden">{renderItem(cx, cy, 'single')}</div>;
}
