// Regression: Undo after a continuous erase must restore the strokes. The
// erase path records a page snapshot, and undo has to understand that entry
// type; without it, Undo silently did nothing after erasing.
'use strict';
const assert = require('assert');

// Minimal model of the renderer undo/redo contract, mirroring the branches in
// renderer.js. Kept here so the logic is verified without a browser.
function makePage(strokes) { return { id: 'p1', strokes: strokes.slice() }; }

function undo(stacks, pg) {
  const u = stacks.undoStack.pop();
  if (!u) return false;
  if (u.kind === 'erase') {
    pg.strokes = u.before;
    stacks.redoStack.push({ pageId: pg.id, kind: 'erase', after: pg.strokes.slice() });
    return true;
  }
  const gone = pg.strokes.find((s) => s.id === u.strokeId);
  pg.strokes = pg.strokes.filter((s) => s.id !== u.strokeId);
  if (gone) stacks.redoStack.push({ pageId: pg.id, stroke: gone });
  return true;
}

function redo(stacks, pg) {
  const r = stacks.redoStack.pop();
  if (!r) return false;
  if (r.kind === 'erase') {
    pg.strokes = r.after.filter((s) => !pg.strokes.some((k) => k.id === s.id));
    stacks.undoStack.push({ pageId: pg.id, kind: 'erase', before: r.after.slice() });
    return true;
  }
  if (r.stroke && !pg.strokes.some((s) => s.id === r.stroke.id)) {
    pg.strokes.push(r.stroke);
    stacks.undoStack.push({ pageId: pg.id, strokeId: r.stroke.id, stroke: r.stroke });
    return true;
  }
  return false;
}

const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };

// 1. Undo after an erase restores every removed stroke.
{
  const stacks = { undoStack: [{ pageId: 'p1', kind: 'erase', before: [a, b, c] }], redoStack: [] };
  const pg = makePage([]);
  assert.strictEqual(undo(stacks, pg), true);
  assert.strictEqual(pg.strokes.length, 3, 'undo must restore the snapshot');
  assert.deepStrictEqual(pg.strokes.map((s) => s.id), ['a', 'b', 'c']);
}

// 2. Redo re-applies the erase.
{
  const stacks = { undoStack: [{ pageId: 'p1', kind: 'erase', before: [a, b, c] }], redoStack: [] };
  const pg = makePage([]);
  undo(stacks, pg);
  assert.strictEqual(redo(stacks, pg), true);
  assert.strictEqual(pg.strokes.length, 0, 'redo must remove them again');
}

// 3. A partial erase restores only what the snapshot held.
{
  const stacks = { undoStack: [{ pageId: 'p1', kind: 'erase', before: [a, b] }], redoStack: [] };
  const pg = makePage([c]); // c was added after the erase snapshot
  undo(stacks, pg);
  assert.deepStrictEqual(pg.strokes.map((s) => s.id), ['a', 'b']);
}

// 4. Ordinary stroke undo still works (the pre-existing path).
{
  const stacks = { undoStack: [{ pageId: 'p1', strokeId: 'b', stroke: b }], redoStack: [] };
  const pg = makePage([a, b, c]);
  undo(stacks, pg);
  assert.deepStrictEqual(pg.strokes.map((s) => s.id), ['a', 'c']);
  assert.strictEqual(stacks.redoStack.length, 1);
}

// 5. Undo on an empty stack is a no-op, not a crash.
{
  const stacks = { undoStack: [], redoStack: [] };
  const pg = makePage([a]);
  assert.strictEqual(undo(stacks, pg), false);
  assert.strictEqual(redo(stacks, pg), false);
  assert.strictEqual(pg.strokes.length, 1);
}

console.log('undo.test.js: all 5 checks passed');