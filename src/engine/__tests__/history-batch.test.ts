import { describe, it, expect } from 'vitest';
import { EditorHistory, type EditorHistoryEntry } from '@/engine/editing/editor-history';

function entry(pageIndex: number, label: string, batchId?: string): EditorHistoryEntry {
  return {
    label,
    timestamp: 0,
    pageIndex,
    contentBytes: new Uint8Array(),
    annotSnapshot: { annotRefKeys: [], objects: new Map() },
    overlays: { drawnPathsJson: '[]', floatingTextsJson: '[]', floatingImagesJson: '[]', signaturesJson: '[]' },
    batchId,
  };
}

describe('EditorHistory batches (BE-203)', () => {
  it('undoes and redoes a multi-page batch as one step', () => {
    const h = new EditorHistory();
    h.seed(entry(0, 'open'));
    h.push(entry(1, 'baseline'));
    h.push(entry(0, 'replace-all', 'b1'));
    h.push(entry(1, 'replace-all', 'b1'));

    const undone = h.undoStep()!;
    expect(undone.map((e) => `${e.label}@${e.pageIndex}`).sort()).toEqual(['baseline@1', 'open@0']);
    expect(h.peek()!.label).toBe('baseline');

    const redone = h.redoStep()!;
    expect(redone.map((e) => e.pageIndex)).toEqual([0, 1]);
    expect(h.peek()!.batchId).toBe('b1');
    expect(h.canRedo()).toBe(false);
  });

  it('treats unbatched entries one at a time', () => {
    const h = new EditorHistory();
    h.seed(entry(0, 'open'));
    h.push(entry(0, 'edit-1'));
    h.push(entry(0, 'edit-2'));
    expect(h.undoStep()!.map((e) => e.label)).toEqual(['edit-1']);
  });
});
