/**
 * PDF optimization — object reachability graph, stream deduplication,
 * and garbage collection of unreachable indirect objects.
 *
 * ISO 32000-2: orphaned objects may be removed during save optimization.
 */

import {
  PDFArray,
  PDFDict,
  PDFRef,
  PDFStream,
  type PDFObject,
} from '../types';
import type {
  DeduplicateResult,
  GarbageCollectResult,
  ObjectGraph,
  ObjectGraphEdge,
  OptimizeOptions,
  ReachabilityResult,
  StreamDuplicateGroup,
} from './types';
import { DEFAULT_OPTIMIZE_OPTIONS } from './types';
import { serializeToString } from '../editor/stream-compiler';

// ─── Object graph construction ───────────────────────────────────────────────

function refKey(ref: PDFRef): string {
  return ref.toKey();
}

function collectRefs(obj: PDFObject, fromKey: string, edges: ObjectGraphEdge[]): void {
  if (obj instanceof PDFRef) {
    edges.push({ from: fromKey, to: refKey(obj), via: 'ref' });
    return;
  }
  if (obj instanceof PDFArray) {
    obj.items.forEach((item, i) => {
      if (item instanceof PDFRef) {
        edges.push({ from: fromKey, to: refKey(item), via: `[${i}]` });
      } else {
        collectRefs(item, fromKey, edges);
      }
    });
    return;
  }
  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      if (v instanceof PDFRef) {
        edges.push({ from: fromKey, to: refKey(v), via: k });
      } else {
        collectRefs(v, fromKey, edges);
      }
    }
    return;
  }
  if (obj instanceof PDFStream) {
    collectRefs(obj.dict, fromKey, edges);
  }
}

/**
 * Build a reference graph over all objects in the map.
 */
export function buildObjectGraph(
  objects: Map<string, PDFObject>,
  roots: PDFRef[],
): ObjectGraph {
  const nodes = new Set(objects.keys());
  const edges: ObjectGraphEdge[] = [];
  const rootKeys = roots.map(refKey);

  for (const [key, obj] of objects.entries()) {
    collectRefs(obj, key, edges);
  }

  return { nodes, edges, roots: rootKeys };
}

/**
 * DFS reachability from root object keys.
 */
export function computeReachability(graph: ObjectGraph): ReachabilityResult {
  const adj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  const reachable = new Set<string>();
  const stack = [...graph.roots];

  while (stack.length > 0) {
    const key = stack.pop()!;
    if (reachable.has(key)) continue;
    if (!graph.nodes.has(key)) continue;
    reachable.add(key);
    const neighbors = adj.get(key) ?? [];
    for (const n of neighbors) stack.push(n);
  }

  const unreachable = new Set<string>();
  for (const node of graph.nodes) {
    if (!reachable.has(node)) unreachable.add(node);
  }

  return { reachable, unreachable, graph };
}

/** Extract root refs from trailer dict (/Root, /Info, /Encrypt). */
export function rootsFromTrailer(trailer: PDFDict, extra: PDFRef[] = []): PDFRef[] {
  const roots: PDFRef[] = [...extra];
  for (const key of ['Root', 'Info', 'Encrypt'] as const) {
    const ref = trailer.getRef(key);
    if (ref) roots.push(ref);
  }
  return roots;
}

// ─── Stream deduplication ────────────────────────────────────────────────────

function streamBytes(obj: PDFObject): Uint8Array | null {
  if (!(obj instanceof PDFStream)) return null;
  return obj.getBytes();
}

/** Dictionary keys that describe only how the bytes are stored, not what the stream is. */
const STORAGE_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL']);

/**
 * Two streams are interchangeable only if their dictionaries match too: the
 * same content with a different /BBox, /Resources, /Width, /ColorSpace… draws
 * differently. Storage keys are ignored, as the keeper is written with its own.
 */
function streamDictSignature(stream: PDFStream): string {
  const parts: string[] = [];
  for (const [k, v] of stream.dict.entries()) {
    if (!STORAGE_KEYS.has(k)) parts.push(`${k}=${serializeToString(v)}`);
  }
  return parts.sort().join('\n');
}

/**
 * Find streams with identical content and dictionaries; pick lowest objNum as keeper.
 */
export function deduplicateStreams(
  objects: Map<string, PDFObject>,
  hashFn = DEFAULT_OPTIMIZE_OPTIONS.hashFn,
): DeduplicateResult {
  const byHash = new Map<string, string[]>();
  const contentHash = new Map<string, string>();
  const refMap = new Map<string, string>();
  const groups: StreamDuplicateGroup[] = [];
  let totalBytesSaved = 0;

  for (const [key, obj] of objects.entries()) {
    const bytes = streamBytes(obj);
    if (!bytes || bytes.length === 0) continue;
    const hash = hashFn(bytes);
    const groupKey = `${hash}\n${streamDictSignature(obj as PDFStream)}`;
    contentHash.set(groupKey, hash);
    const list = byHash.get(groupKey) ?? [];
    list.push(key);
    byHash.set(groupKey, list);
  }

  for (const [groupKey, keys] of byHash.entries()) {
    if (keys.length < 2) continue;
    const hash = contentHash.get(groupKey)!;
    keys.sort((a, b) => {
      const [ao] = a.split('_').map(Number);
      const [bo] = b.split('_').map(Number);
      return (ao ?? 0) - (bo ?? 0);
    });
    const keeper = keys[0]!;
    const duplicates = keys.slice(1);
    let bytesSaved = 0;
    for (const dup of duplicates) {
      const bytes = streamBytes(objects.get(dup)!);
      if (bytes) bytesSaved += bytes.length;
      refMap.set(dup, keeper);
    }
    totalBytesSaved += bytesSaved;
    groups.push({ hash, keeper, duplicates, bytesSaved });
  }

  return { groups, refMap, totalBytesSaved };
}

/** Rewrite PDFRef targets using refMap (duplicate → keeper). */
export function applyRefMap(
  objects: Map<string, PDFObject>,
  refMap: Map<string, string>,
): Map<string, PDFObject> {
  if (refMap.size === 0) return objects;

  function remap(obj: PDFObject): PDFObject {
    if (obj instanceof PDFRef) {
      const mapped = refMap.get(refKey(obj));
      if (mapped) {
        const [objNum, genNum] = mapped.split('_').map(Number);
        return new PDFRef(objNum!, genNum ?? 0);
      }
      return obj;
    }
    if (obj instanceof PDFArray) {
      return new PDFArray(obj.items.map(remap));
    }
    if (obj instanceof PDFDict) {
      const d = new PDFDict();
      for (const [k, v] of obj.entries()) d.set(k, remap(v));
      return d;
    }
    if (obj instanceof PDFStream) {
      const dict = remap(obj.dict) as PDFDict;
      return new PDFStream(dict, obj.rawBytes, obj.decodedBytes);
    }
    return obj;
  }

  const out = new Map<string, PDFObject>();
  for (const [key, obj] of objects.entries()) {
    out.set(key, remap(obj));
  }
  return out;
}

// ─── Garbage collection ──────────────────────────────────────────────────────

/**
 * Remove unreachable indirect objects from the object map.
 * Optionally deduplicates streams first and remaps references.
 */
export function garbageCollect(
  objects: Map<string, PDFObject>,
  roots: PDFRef[],
  options: Partial<OptimizeOptions> = {},
): GarbageCollectResult {
  const opts = { ...DEFAULT_OPTIMIZE_OPTIONS, ...options };
  const beforeCount = objects.size;

  let working = new Map(objects);
  let refMap = new Map<string, string>();

  if (opts.deduplicateStreams) {
    const dedup = deduplicateStreams(working, opts.hashFn);
    refMap = dedup.refMap;
    if (refMap.size > 0) {
      working = applyRefMap(working, refMap);
    }
  }

  const allRoots = [...roots, ...opts.extraRoots];
  const graph = buildObjectGraph(working, allRoots);
  const { reachable, unreachable } = computeReachability(graph);

  const removedKeys: string[] = [];
  for (const key of unreachable) {
    removedKeys.push(key);
    working.delete(key);
  }

  removedKeys.sort();

  return {
    beforeCount,
    afterCount: working.size,
    removedKeys,
    objects: working,
    refMap,
  };
}
