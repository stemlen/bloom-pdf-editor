/**
 * Secure Optimizer — Phase 14.
 * Shrinks PDFs while preserving encryption and security properties.
 */

import type { PDFDocumentData } from '../../types';
import { PDFRef } from '../../types';
import { garbageCollect } from '../../optimize/garbage-collect';
import { deduplicateStreams } from '../../optimize/garbage-collect';
import type { ISecureOptimizer } from '../types';

export interface OptimizeReport {
  beforeObjects: number;
  afterObjects: number;
  removedObjects: number;
  deduplicatedStreams: number;
  preservedEncrypt: boolean;
  notes: string[];
}

export class SecureOptimizer implements ISecureOptimizer {
  async optimize(doc: PDFDocumentData): Promise<PDFDocumentData> {
    await this.optimizeWithReport(doc);
    return doc;
  }

  async optimizeWithReport(doc: PDFDocumentData): Promise<OptimizeReport> {
    const notes: string[] = [];
    const beforeObjects = doc.objects.size;
    const preservedEncrypt = doc.xref.trailerDict.has('Encrypt');

    const rootRef = doc.xref.trailerDict.getRef('Root');
    const infoRef = doc.xref.trailerDict.getRef('Info');
    const encryptRef = doc.xref.trailerDict.getRef('Encrypt');
    const roots: PDFRef[] = [];
    if (rootRef) roots.push(rootRef);
    if (infoRef) roots.push(infoRef);
    if (encryptRef) roots.push(encryptRef);

    let deduplicatedStreams = 0;
    try {
      const dedup = deduplicateStreams(doc.objects);
      deduplicatedStreams = dedup.groups?.length ?? dedup.refMap.size;
      // Merging happens in the optimized save; nothing is rewritten here.
      if (deduplicatedStreams > 0) {
        notes.push(
          `Found ${deduplicatedStreams} duplicate stream ${deduplicatedStreams === 1 ? 'group' : 'groups'} (merged by an optimized save)`,
        );
      }
    } catch {
      notes.push('Stream deduplication skipped');
    }

    let removedObjects = 0;
    try {
      const gc = garbageCollect(doc.objects, roots, {
        deduplicateStreams: false,
        // Never drop Encrypt
        extraRoots: encryptRef ? [encryptRef] : [],
      });
      doc.objects.clear();
      for (const [k, v] of gc.objects) doc.objects.set(k, v);
      removedObjects = gc.removedKeys.length;
      if (removedObjects > 0) notes.push(`Removed ${removedObjects} unused object(s)`);
    } catch {
      notes.push('Garbage collection skipped');
    }

    // Ensure Encrypt still present if it was
    if (preservedEncrypt && !doc.xref.trailerDict.has('Encrypt')) {
      notes.push('WARNING: Encrypt dict was lost — unexpected');
    } else if (preservedEncrypt) {
      notes.push('Preserved encryption dictionary');
    }

    if (notes.length === 0) notes.push('No further optimization opportunities');

    return {
      beforeObjects,
      afterObjects: doc.objects.size,
      removedObjects,
      deduplicatedStreams,
      preservedEncrypt,
      notes,
    };
  }
}

export const secureOptimizer = new SecureOptimizer();
