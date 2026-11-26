import { describe, it, expect } from 'vitest';
import { EditorHistory, mapPageIndex, type EditorHistoryEntry } from '@/engine/editing/editor-history';

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

describe('EditorHistory follows page deletes, moves and inserts', () => {
  it('maps page indices', () => {
    const del = [0, 1, 2, 3].map((i) => mapPageIndex({ kind: 'delete', index: 1 }, i));
    expect(del).toEqual([0, null, 1, 2]);
    const ins = [0, 1, 2].map((i) => mapPageIndex({ kind: 'insert', index: 1, count: 2 }, i));
    expect(ins).toEqual([0, 3, 4]);
    const down = [0, 1, 2, 3].map((i) => mapPageIndex({ kind: 'move', from: 0, to: 2 }, i));
    expect(down).toEqual([2, 0, 1, 3]);
    const up = [0, 1, 2, 3].map((i) => mapPageIndex({ kind: 'move', from: 3, to: 1 }, i));
    expect(up).toEqual([0, 2, 3, 1]);
  });

  it('undo after deleting an earlier page restores the right page and drops the deleted one', () => {
    const h = new EditorHistory();
    h.seed(entry(0, 'open'));
    h.push(entry(2, 'baseline'));
    h.push(entry(0, 'replace-all', 'b1'));
    h.push(entry(2, 'replace-all', 'b1'));
    h.applyPageChange({ kind: 'delete', index: 0 });
    // Old page 3 is now page 2; nothing may be written to the new page 1 (old page 2).
    expect(h.undoStep()!.map((e) => `${e.label}@${e.pageIndex}`)).toEqual(['baseline@1']);
    expect(h.canUndo()).toBe(false);
  });

  it('moves entries along with a moved page, on both stacks', () => {
    const h = new EditorHistory();
    h.seed(entry(0, 'open'));
    h.push(entry(0, 'edit'));
    h.push(entry(1, 'baseline'));
    h.push(entry(1, 'edit'));
    h.undoStep();
    h.applyPageChange({ kind: 'move', from: 1, to: 0 });
    expect(h.redoStep()!.map((e) => `${e.label}@${e.pageIndex}`)).toEqual(['edit@0']);
    expect(h.undoStep()!.map((e) => `${e.label}@${e.pageIndex}`)).toEqual(['baseline@0']);
  });
});
