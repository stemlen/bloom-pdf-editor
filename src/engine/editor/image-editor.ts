import { PDFDict, PDFName, PDFNumber, PDFStream, PDFRef } from '../types';
import type { PDFDocumentData, PDFPageInfo, PDFObject } from '../types';
import type { ImageItem } from '../content/interpreter';
import { getResource } from '../parser/parser';
import { flateEncode } from '../parser/filters';
import { concatBytes, isolateGraphicsState } from './stream-compiler';

export interface InsertImageOptions {
  /**
   * Keep the image's alpha channel (PNG/SVG signatures, logos) as a soft mask
   * instead of flattening it onto white as a JPEG.
   */
  preserveAlpha?: boolean;
  /** Constant opacity 0–1 applied through an ExtGState. */
  opacity?: number;
}

/** Flate-compress when the browser can; otherwise store the bytes unfiltered. */
async function flateStream(dict: PDFDict, bytes: Uint8Array): Promise<PDFStream> {
  const encoded = await flateEncode(bytes);
  if (encoded !== bytes) dict.set('Filter', new PDFName('FlateDecode'));
  dict.set('Length', new PDFNumber(encoded.length));
  return new PDFStream(dict, encoded);
}

function subDict(parent: PDFDict, key: string, objects: Map<string, PDFObject>): PDFDict {
  let d = parent.get(key);
  if (d instanceof PDFRef) d = objects.get(d.toKey());
  if (!(d instanceof PDFDict)) {
    d = new PDFDict();
    parent.set(key, d);
  }
  return d as PDFDict;
}

function uniqueName(dict: PDFDict, prefix: string): string {
  let i = 1;
  while (dict.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/**
 * Inserts an image into the PDF content stream by creating an Image XObject.
 * Note: imageDataUrl must be a JPEG Data URL (image/jpeg).
 */
export async function insertImageRun(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  imageDataUrl: string,
  x: number,
  y: number,
  width: number,
  height: number,
  getNextObjNum: () => number,
  rotation: number = 0,
  options: InsertImageOptions = {},
): Promise<{ newContentBytes: Uint8Array }> {
  let finalDataUrl = imageDataUrl;

  // 1. Read image dimensions
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image for insertion'));
    img.src = imageDataUrl;
  });
  
  const trueWidth = img.naturalWidth || width || 100;
  const trueHeight = img.naturalHeight || height || 100;

  let imageStream: PDFStream | null = null;
  if (options.preserveAlpha && typeof document !== 'undefined') {
    imageStream = await alphaImageStream(img, trueWidth, trueHeight, objects, getNextObjNum);
  }

  if (!imageStream) {
    // Ensure JPEG format for DCTDecode filter
    if (typeof document !== 'undefined' && !imageDataUrl.startsWith('data:image/jpeg')) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = trueWidth;
        canvas.height = trueHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, trueWidth, trueHeight);
          ctx.drawImage(img, 0, 0);
          finalDataUrl = canvas.toDataURL('image/jpeg', 0.95);
        }
      } catch {
        finalDataUrl = imageDataUrl;
      }
    }

    // Convert Data URL to Uint8Array
    const base64Data = (finalDataUrl.split(',')[1] || '').trim();
    const binaryString = atob(base64Data);
    const imageBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      imageBytes[i] = binaryString.charCodeAt(i);
    }

    // 3. Create the Image XObject dictionary
    const dict = new PDFDict();
    dict.set('Type', new PDFName('XObject'));
    dict.set('Subtype', new PDFName('Image'));
    dict.set('Width', new PDFNumber(trueWidth));
    dict.set('Height', new PDFNumber(trueHeight));
    dict.set('ColorSpace', new PDFName('DeviceRGB'));
    dict.set('BitsPerComponent', new PDFNumber(8));
    dict.set('Filter', new PDFName('DCTDecode'));
    dict.set('Length', new PDFNumber(imageBytes.length));

    // 4. Create the stream object
    imageStream = new PDFStream(dict, imageBytes);
  }
  const objNum = getNextObjNum();
  const objRef = new PDFRef(objNum, 0);
  objects.set(objRef.toKey(), imageStream);

  // 5. Register in page Resources
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? (objects.get(resourcesObj.toKey()) as PDFDict) : resourcesObj as PDFDict;
  if (!resources || !(resources instanceof PDFDict)) {
    resources = new PDFDict();
    if (page.resources instanceof PDFDict) {
      for (const [k, v] of page.resources.entries()) {
        resources.set(k, v);
      }
    }
    page.dict.set('Resources', resources);
  }
  
  let xobjects = resources.get('XObject');
  if (xobjects instanceof PDFRef) xobjects = objects.get(xobjects.toKey()) as PDFDict;
  if (!xobjects || !(xobjects instanceof PDFDict)) {
    xobjects = new PDFDict();
    resources.set('XObject', xobjects);
  }
  
  // Find a unique name
  let imgName = 'Im1';
  let i = 1;
  while (xobjects.has(imgName)) {
    i++;
    imgName = `Im${i}`;
  }
  xobjects.set(imgName, objRef);

  let gsOp = '';
  const opacity = options.opacity ?? 1;
  if (opacity < 1) {
    const extGState = subDict(resources, 'ExtGState', objects);
    const gs = new PDFDict();
    gs.set('Type', new PDFName('ExtGState'));
    gs.set('ca', new PDFNumber(Math.max(0, opacity)));
    gs.set('CA', new PDFNumber(Math.max(0, opacity)));
    const gsName = uniqueName(extGState, 'GSimg');
    extGState.set(gsName, gs);
    gsOp = `/${gsName} gs\n`;
  }

  // Keep page.resources in sync with page.dict
  page.resources = resources;

  // 6. Inject the 'Do' command into the content stream
  const bottomY = y - height;
  const fmt = (n: number) => {
    if (Math.abs(n) < 1e-6) return '0';
    return Number.isInteger(n) ? n.toString() : Number(n.toFixed(4)).toString();
  };

  let injection: string;
  const normRot = ((rotation % 360) + 360) % 360;
  if (normRot !== 0) {
    const cx = x + width / 2;
    const cy = bottomY + height / 2;
    const rad = -normRot * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = width * cos;
    const b = width * sin;
    const c = -height * sin;
    const d = height * cos;
    const e = cx - 0.5 * (a + c);
    const f = cy - 0.5 * (b + d);
    injection = `\nq\n${gsOp}${fmt(a)} ${fmt(b)} ${fmt(c)} ${fmt(d)} ${fmt(e)} ${fmt(f)} cm\n/${imgName} Do\nQ\n`;
  } else {
    injection = `\nq\n${gsOp}${fmt(width)} 0 0 ${fmt(height)} ${fmt(x)} ${fmt(bottomY)} cm\n/${imgName} Do\nQ\n`;
  }

  const enc = new TextEncoder();
  const injectionBytes = enc.encode(injection);

  // Draw in the page's default user space, whatever state the content left.
  const newContentBytes = concatBytes(isolateGraphicsState(contentBytes), injectionBytes);

  return { newContentBytes };
}

/**
 * RGB image XObject (Flate) with an 8-bit /SMask carrying the alpha channel.
 * Returns null when the canvas can't be read so the caller falls back to JPEG.
 */
async function alphaImageStream(
  img: HTMLImageElement,
  width: number,
  height: number,
  objects: Map<string, PDFObject>,
  getNextObjNum: () => number,
): Promise<PDFStream | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const rgb = new Uint8Array(width * height * 3);
    const alpha = new Uint8Array(width * height);
    let opaque = true;
    for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
      rgb[p * 3] = data[i];
      rgb[p * 3 + 1] = data[i + 1];
      rgb[p * 3 + 2] = data[i + 2];
      alpha[p] = data[i + 3];
      if (data[i + 3] !== 255) opaque = false;
    }

    const dict = new PDFDict();
    dict.set('Type', new PDFName('XObject'));
    dict.set('Subtype', new PDFName('Image'));
    dict.set('Width', new PDFNumber(width));
    dict.set('Height', new PDFNumber(height));
    dict.set('ColorSpace', new PDFName('DeviceRGB'));
    dict.set('BitsPerComponent', new PDFNumber(8));

    if (!opaque) {
      const maskDict = new PDFDict();
      maskDict.set('Type', new PDFName('XObject'));
      maskDict.set('Subtype', new PDFName('Image'));
      maskDict.set('Width', new PDFNumber(width));
      maskDict.set('Height', new PDFNumber(height));
      maskDict.set('ColorSpace', new PDFName('DeviceGray'));
      maskDict.set('BitsPerComponent', new PDFNumber(8));
      const maskRef = new PDFRef(getNextObjNum(), 0);
      objects.set(maskRef.toKey(), await flateStream(maskDict, alpha));
      dict.set('SMask', maskRef);
    }
    return await flateStream(dict, rgb);
  } catch {
    return null;
  }
}

/**
 * Replace an embedded image's pixel data while keeping the same placement
 * (cm / Do / bbox). The content stream is untouched — only the XObject stream
 * and Width/Height dictionary entries are updated.
 *
 * @param imageDataUrl must be image/jpeg
 */
export async function replaceImageXObject(
  doc: PDFDocumentData,
  pageIndex: number,
  image: ImageItem,
  imageDataUrl: string,
): Promise<void> {
  const page = doc.pages[pageIndex];
  const name = image.name.replace(/^\//, '');
  const xobj = getResource(page.resources, 'XObject', name, doc.objects);
  if (!(xobj instanceof PDFStream)) {
    throw new Error(`Image XObject /${name} not found`);
  }
  if (xobj.dict.getName('Subtype') !== 'Image') {
    throw new Error(`XObject /${name} is not an Image`);
  }

  const base64Data = imageDataUrl.split(',')[1];
  if (!base64Data) throw new Error('Invalid image data URL');
  const binaryString = atob(base64Data);
  const imageBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    imageBytes[i] = binaryString.charCodeAt(i);
  }

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to decode replacement image'));
    img.src = imageDataUrl;
  });

  const trueWidth = img.naturalWidth;
  const trueHeight = img.naturalHeight;

  xobj.dict.set('Width', new PDFNumber(trueWidth));
  xobj.dict.set('Height', new PDFNumber(trueHeight));
  xobj.dict.set('ColorSpace', new PDFName('DeviceRGB'));
  xobj.dict.set('BitsPerComponent', new PDFNumber(8));
  xobj.dict.set('Filter', new PDFName('DCTDecode'));
  xobj.dict.set('Length', new PDFNumber(imageBytes.length));
  // Drop filters that don't apply to the new JPEG bytes
  xobj.dict.delete('DecodeParms');
  xobj.dict.delete('SMask');

  xobj.rawBytes = imageBytes;
  xobj.decodedBytes = null;
}
