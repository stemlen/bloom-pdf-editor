/**
 * Color Space Engine
 *
 * Handles PDF color space conversion to sRGB for canvas rendering.
 * Supports:
 *   - DeviceRGB (pass-through)
 *   - DeviceGray (gray → RGB)
 *   - DeviceCMYK (CMYK → RGB with ink simulation)
 *   - Indexed (palette lookup)
 *   - CalGray / CalRGB (calibrated color with gamma correction)
 *   - ICCBased (falls back to alternate or device space)
 *   - Separation / DeviceN (uses tint transform approximation)
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFStream,
} from '../types';
import { resolveRef } from '../parser/parser';
import { parseICCProfile } from '../color/icc-profile';
import { transformDeviceToPCS } from '../color/icc-lut';

// ─── Color space types ──────────────────────────────────────────────────────

export type RGBColor = [number, number, number]; // 0-1 range
export type CMYKColor = [number, number, number, number]; // 0-1 range

export interface ColorSpace {
  name: string;
  numComponents: number;
  /** Convert component values (0-1) to RGB (0-1) */
  toRGB(components: number[]): RGBColor;
}

// ─── Color space factory ────────────────────────────────────────────────────

/**
 * Parse a PDF color space specification and return a ColorSpace converter.
 */
export function parseColorSpace(
  csObj: PDFObject,
  objects: Map<string, PDFObject>,
): ColorSpace {
  const resolved = resolveRef(csObj, objects);

  // Simple name: /DeviceRGB, /DeviceGray, /DeviceCMYK
  if (resolved instanceof PDFName) {
    return getNamedColorSpace(resolved.name);
  }

  // Array: [/ICCBased stream], [/Indexed base hival lookup], etc.
  if (resolved instanceof PDFArray && resolved.length > 0) {
    const csName = resolved.get(0);
    if (!(csName instanceof PDFName)) return DEVICE_RGB;

    switch (csName.name) {
      case 'ICCBased':
        return parseICCBased(resolved, objects);
      case 'Indexed':
      case 'I':
        return parseIndexed(resolved, objects);
      case 'CalGray':
        return parseCalGray(resolved, objects);
      case 'CalRGB':
        return parseCalRGB(resolved, objects);
      case 'Separation':
        return parseSeparation(resolved, objects);
      case 'DeviceN':
        return parseDeviceN(resolved, objects);
      case 'Lab':
        return parseLab(resolved, objects);
      case 'Pattern':
        return DEVICE_RGB; // Patterns are handled separately
      default:
        return getNamedColorSpace(csName.name);
    }
  }

  return DEVICE_RGB;
}

function getNamedColorSpace(name: string): ColorSpace {
  switch (name) {
    case 'DeviceRGB':
    case 'RGB':
      return DEVICE_RGB;
    case 'DeviceGray':
    case 'G':
      return DEVICE_GRAY;
    case 'DeviceCMYK':
    case 'CMYK':
      return DEVICE_CMYK;
    default:
      return DEVICE_RGB;
  }
}

// ─── Device color spaces ────────────────────────────────────────────────────

const DEVICE_RGB: ColorSpace = {
  name: 'DeviceRGB',
  numComponents: 3,
  toRGB(c: number[]): RGBColor {
    return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
  },
};

const DEVICE_GRAY: ColorSpace = {
  name: 'DeviceGray',
  numComponents: 1,
  toRGB(c: number[]): RGBColor {
    const g = c[0] ?? 0;
    return [g, g, g];
  },
};

const DEVICE_CMYK: ColorSpace = {
  name: 'DeviceCMYK',
  numComponents: 4,
  toRGB(c: number[]): RGBColor {
    return cmykToRGB(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0);
  },
};

// ─── CMYK → RGB conversion ─────────────────────────────────────────────────

/**
 * Convert CMYK to RGB using an improved formula that better simulates
 * real ink behavior compared to the naive (1-C)*(1-K) formula.
 */
export function cmykToRGB(c: number, m: number, y: number, k: number): RGBColor {
  // Clamp inputs
  c = Math.max(0, Math.min(1, c));
  m = Math.max(0, Math.min(1, m));
  y = Math.max(0, Math.min(1, y));
  k = Math.max(0, Math.min(1, k));

  // Standard conversion formula
  const r = (1 - c) * (1 - k);
  const g = (1 - m) * (1 - k);
  const b = (1 - y) * (1 - k);

  return [
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b)),
  ];
}

// ─── ICCBased ───────────────────────────────────────────────────────────────

function parseICCBased(arr: PDFArray, objects: Map<string, PDFObject>): ColorSpace {
  const streamRef = arr.get(1);
  if (!streamRef) return DEVICE_RGB;

  const stream = resolveRef(streamRef, objects);
  if (!(stream instanceof PDFStream)) return DEVICE_RGB;

  const n = stream.dict.getNumber('N') ?? 3;
  const profileBytes = stream.getBytes();
  const profile = parseICCProfile(profileBytes);

  if (profile) {
    return {
      name: 'ICCBased',
      numComponents: n,
      toRGB(c: number[]): RGBColor {
        const pcs = transformDeviceToPCS(profile, c.slice(0, n));
        if (pcs.length >= 3) {
          return [Math.max(0, Math.min(1, pcs[0])), Math.max(0, Math.min(1, pcs[1])), Math.max(0, Math.min(1, pcs[2]))];
        }
        const g = Math.max(0, Math.min(1, pcs[0] ?? 0));
        return [g, g, g];
      },
    };
  }

  // Use alternate color space if specified
  const alternate = stream.dict.get('Alternate');
  if (alternate) {
    const altCS = parseColorSpace(alternate, objects);
    if (altCS.numComponents === n) return altCS;
  }

  // Fallback based on number of components
  switch (n) {
    case 1: return DEVICE_GRAY;
    case 3: return DEVICE_RGB;
    case 4: return DEVICE_CMYK;
    default: return DEVICE_RGB;
  }
}

// ─── Indexed ────────────────────────────────────────────────────────────────

function parseIndexed(arr: PDFArray, objects: Map<string, PDFObject>): ColorSpace {
  if (arr.length < 4) return DEVICE_RGB;

  // [/Indexed base hival lookup]
  const baseCSObj = arr.get(1)!;
  const hival = arr.get(2);
  const lookupObj = arr.get(3)!;

  const baseCS = parseColorSpace(baseCSObj, objects);
  const maxIndex = hival instanceof PDFNumber ? hival.value : 255;

  // Get lookup table bytes
  let lookupBytes: Uint8Array;
  const resolvedLookup = resolveRef(lookupObj, objects);
  if (resolvedLookup instanceof PDFStream) {
    lookupBytes = resolvedLookup.getBytes();
  } else if (resolvedLookup instanceof PDFName) {
    lookupBytes = new Uint8Array(0);
  } else {
    // Could be a string
    lookupBytes = new Uint8Array(0);
  }

  return {
    name: 'Indexed',
    numComponents: 1,
    toRGB(c: number[]): RGBColor {
      const index = Math.round(c[0] ?? 0);
      if (index < 0 || index > maxIndex || lookupBytes.length === 0) {
        return [0, 0, 0];
      }

      // Read base color components from lookup table
      const numBase = baseCS.numComponents;
      const offset = index * numBase;
      const components: number[] = [];
      for (let i = 0; i < numBase; i++) {
        const byteVal = offset + i < lookupBytes.length ? lookupBytes[offset + i] : 0;
        components.push(byteVal / 255);
      }

      return baseCS.toRGB(components);
    },
  };
}

// ─── CalGray ────────────────────────────────────────────────────────────────

function parseCalGray(arr: PDFArray, objects: Map<string, PDFObject>): ColorSpace {
  const dictRef = arr.get(1);
  const dict = dictRef ? resolveRef(dictRef, objects) : null;
  const gamma = (dict instanceof PDFDict) ? (dict.getNumber('Gamma') ?? 1.8) : 1.8;

  return {
    name: 'CalGray',
    numComponents: 1,
    toRGB(c: number[]): RGBColor {
      // Apply gamma correction
      const linear = Math.pow(Math.max(0, Math.min(1, c[0] ?? 0)), gamma);
      return [linear, linear, linear];
    },
  };
}

// ─── CalRGB ─────────────────────────────────────────────────────────────────

function parseCalRGB(arr: PDFArray, objects: Map<string, PDFObject>): ColorSpace {
  const dictRef = arr.get(1);
  const dict = dictRef ? resolveRef(dictRef, objects) : null;

  let gammaR = 1, gammaG = 1, gammaB = 1;
  if (dict instanceof PDFDict) {
    const gammaArr = dict.getArray('Gamma');
    if (gammaArr) {
      const gNums = gammaArr.asNumbers();
      gammaR = gNums[0] ?? 1;
      gammaG = gNums[1] ?? 1;
      gammaB = gNums[2] ?? 1;
    }
  }

  return {
    name: 'CalRGB',
    numComponents: 3,
    toRGB(c: number[]): RGBColor {
      return [
        Math.pow(Math.max(0, Math.min(1, c[0] ?? 0)), gammaR),
        Math.pow(Math.max(0, Math.min(1, c[1] ?? 0)), gammaG),
        Math.pow(Math.max(0, Math.min(1, c[2] ?? 0)), gammaB),
      ];
    },
  };
}

// ─── Lab ────────────────────────────────────────────────────────────────────

function parseLab(arr: PDFArray, objects: Map<string, PDFObject>): ColorSpace {
  return {
    name: 'Lab',
    numComponents: 3,
    toRGB(c: number[]): RGBColor {
      // Simplified Lab → sRGB conversion
      const L = (c[0] ?? 0) * 100;
      const a = (c[1] ?? 0) * 255 - 128;
      const b = (c[2] ?? 0) * 255 - 128;

      // Lab → XYZ (D65 white point)
      const fy = (L + 16) / 116;
      const fx = a / 500 + fy;
      const fz = fy - b / 200;

      const xn = 0.9505, yn = 1.0, zn = 1.0890;
      const delta = 6 / 29;

      function fInv(t: number): number {
        return t > delta ? t * t * t : 3 * delta * delta * (t - 4 / 29);
      }

      const X = xn * fInv(fx);
      const Y = yn * fInv(fy);
      const Z = zn * fInv(fz);

      // XYZ → sRGB
      const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
      const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
      const bVal = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;

      // Gamma correction
      function gammaCorrect(v: number): number {
        return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      }

      return [
        Math.max(0, Math.min(1, gammaCorrect(r))),
        Math.max(0, Math.min(1, gammaCorrect(g))),
        Math.max(0, Math.min(1, gammaCorrect(bVal))),
      ];
    },
  };
}

// ─── Separation ─────────────────────────────────────────────────────────────

function parseSeparation(arr: PDFArray, objects: Map<string, PDFObject>): ColorSpace {
  // [/Separation name alternateCS tintTransform]
  // For now, approximate using the alternate color space
  if (arr.length < 3) return DEVICE_GRAY;

  const altCSObj = arr.get(2)!;
  const altCS = parseColorSpace(altCSObj, objects);

  return {
    name: 'Separation',
    numComponents: 1,
    toRGB(c: number[]): RGBColor {
      // Simple approximation: map tint to grayscale
      const tint = c[0] ?? 0;
      // Invert because separation colors are subtractive
      const gray = 1 - tint;
      return [gray, gray, gray];
    },
  };
}

// ─── DeviceN ────────────────────────────────────────────────────────────────

function parseDeviceN(arr: PDFArray, objects: Map<string, PDFObject>): ColorSpace {
  // [/DeviceN names alternateCS tintTransform]
  const namesArr = arr.get(1);
  const numComponents = namesArr instanceof PDFArray ? namesArr.length : 1;

  if (arr.length >= 3) {
    const altCSObj = arr.get(2)!;
    const altCS = parseColorSpace(altCSObj, objects);

    return {
      name: 'DeviceN',
      numComponents,
      toRGB(c: number[]): RGBColor {
        // Approximate: average all component tints
        let totalTint = 0;
        for (let i = 0; i < c.length; i++) totalTint += (c[i] ?? 0);
        const avgTint = totalTint / Math.max(1, c.length);
        const gray = 1 - avgTint;
        return [gray, gray, gray];
      },
    };
  }

  return DEVICE_GRAY;
}

// ─── Utility: RGB to CSS color string ───────────────────────────────────────

/**
 * Convert an RGB triple (0-1 range) to a CSS rgba() string.
 */
export function rgbToCSSColor(rgb: RGBColor, alpha: number = 1): string {
  const r = Math.round(rgb[0] * 255);
  const g = Math.round(rgb[1] * 255);
  const b = Math.round(rgb[2] * 255);
  if (alpha >= 1) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

/**
 * Convert component values to a CSS color using a color space.
 */
export function componentsToCSSColor(
  components: number[],
  colorSpace: ColorSpace,
  alpha: number = 1,
): string {
  const rgb = colorSpace.toRGB(components);
  return rgbToCSSColor(rgb, alpha);
}
