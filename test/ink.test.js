'use strict';
// Scribble + smoothing checks. Run with: npm test
const assert = require('assert');
const Ink = require('../renderer/ink');

function line(x0, y0, x1, y1, n, jitter) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t + (jitter ? Math.sin(i * 3.1) * jitter : 0), p: 0.5 });
  }
  return pts;
}

// 1. Smoothing keeps endpoints and calms jitter.
const jagged = line(0, 100, 500, 100, 40, 6);
const sm = Ink.smoothPoints(jagged);
assert.strictEqual(sm[0].x, jagged[0].x);
assert.strictEqual(sm[sm.length - 1].x, jagged[jagged.length - 1].x);
const dev = (pts) => Math.max(...pts.map((p) => Math.abs(p.y - 100)));
assert.ok(dev(sm) < dev(jagged), `smoothed dev ${dev(sm)} < raw dev ${dev(jagged)}`);
// short strokes pass through untouched in length terms
assert.strictEqual(Ink.smoothPoints([{ x: 1, y: 1 }, { x: 2, y: 2 }]).length, 2);

// 2. A zigzag scribble over a word deletes it.
const word = { id: 'w1', points: line(100, 200, 400, 200, 30) };
const scribble = [];
for (let i = 0; i < 24; i++) scribble.push({ x: 90 + i * 14, y: 200 + (i % 2 === 0 ? -18 : 18), p: 0.5 });
const hits = Ink.scribbleHits(scribble, [word]);
assert.deepStrictEqual(hits, ['w1']);

// 3. A plain underline must NOT trigger deletion.
const underline = line(90, 230, 410, 230, 20);
assert.strictEqual(Ink.scribbleHits(underline, [word]), null);

// 4. A loop around ink must NOT delete it (circling is not scratching out).
const loop = [];
for (let i = 0; i <= 40; i++) {
  const a = (i / 40) * Math.PI * 2;
  loop.push({ x: 250 + Math.cos(a) * 90, y: 200 + Math.sin(a) * 60, p: 0.5 });
}
assert.strictEqual(Ink.scribbleHits(loop, [word]), null);

// 5. A wavy underline over ink must NOT delete it.
const wavy = [];
for (let i = 0; i < 60; i++) {
  const x = 90 + (320 * i) / 59;
  wavy.push({ x, y: 232 + Math.sin(x / 18) * 14, p: 0.5 });
}
assert.strictEqual(Ink.scribbleHits(wavy, [word]), null);

// 5. Scribble over empty space hits nothing.
assert.strictEqual(Ink.scribbleHits(scribble, [{ id: 'far', points: line(0, 900, 300, 900, 10) }]), null);

console.log('ink.test.js: all 5 checks passed');
