import { 
  SelectToolIcon, 
  TextToolIcon, 
  HighlightToolIcon, 
  DrawToolIcon, 
  EraseToolIcon,
  WatermarkToolIcon,
  SignToolIcon,
  SecurityToolIcon,
  CustomIconProps
} from './components/EditorToolIcons';
import { Link2, SquareSlash } from 'lucide-react';

export type EditorTool = 'select' | 'text' | 'addtext' | 'highlight' | 'draw' | 'erase' | 'watermark' | 'redact' | 'sign' | 'link' | 'security';

export interface ToolDef {
  id: EditorTool;
  label: string;
  icon: React.ComponentType<CustomIconProps>;
  shortcut: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'select',    label: 'Select',    icon: SelectToolIcon,    shortcut: 'V' },
  { id: 'text',      label: 'Edit Text', icon: TextToolIcon,      shortcut: 'T' },
  { id: 'highlight', label: 'Highlight', icon: HighlightToolIcon, shortcut: 'H' },
  { id: 'draw',      label: 'Draw',      icon: DrawToolIcon,      shortcut: 'D' },
  { id: 'erase',     label: 'Erase',     icon: EraseToolIcon,     shortcut: 'E' },
  { id: 'link',      label: 'Link',      icon: Link2,             shortcut: 'L' },
  { id: 'redact',    label: 'Redact',    icon: SquareSlash,       shortcut: 'R' },
  { id: 'watermark', label: 'Watermark', icon: WatermarkToolIcon, shortcut: 'W' },
  { id: 'sign',      label: 'Sign',      icon: SignToolIcon,      shortcut: 'S' },
  { id: 'security',  label: 'Security',  icon: SecurityToolIcon,  shortcut: 'X' },
];

/** Display name for every tool, including modes that have no toolbar button. */
export const TOOL_LABELS: Record<EditorTool, string> = {
  select: 'Select',
  text: 'Edit Text',
  addtext: 'Add Text Box',
  highlight: 'Highlight',
  draw: 'Draw',
  erase: 'Erase',
  watermark: 'Watermark',
  redact: 'Redact',
  sign: 'Sign',
  link: 'Link',
  security: 'Security',
};

export type PathType = 'draw' | 'highlight';

/** Sub-modes for the Draw tool */
export type DrawMode = 'freehand' | 'line' | 'arrow' | 'rectangle' | 'ellipse';

export interface DrawnPath {
  id: string;
  type: PathType;
  /** Geometry kind; defaults to freehand when omitted */
  kind?: DrawMode;
  color: string;
  size: number;
  /** Freehand stroke points (canvas CSS px) */
  points: { x: number; y: number }[];
  /** Shape endpoints (canvas CSS px) — used when kind !== freehand */
  start?: { x: number; y: number };
  end?: { x: number; y: number };
}

export interface FloatingText {
  id: string;
  pdfX: number;
  pdfY: number;
  pdfWidth?: number;
  pdfHeight?: number;
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
}

export interface FloatingImage {
  id: string;
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
  dataUrl: string;
  rotation?: number;
}

export interface RemovedImageRecord {
  id: string;
  dataUrl: string;
  name?: string;
  fileName?: string;
  sourceType: 'embedded' | 'floating';
  originalPage: number; // 0-indexed page number
  originalBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  pixelWidth?: number;
  pixelHeight?: number;
  deletedAt: number; // unix timestamp
}
