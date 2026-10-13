'use strict';
// Round-trip + validation tests. Run with: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNotebook, createPage, createStroke, serializeLibrary, deserializeLibrary, validateLibrary } = require('../lib/model');
const { LibraryStore } = require('../lib/store');

// 1. Model round-trip with a realistic stroke.
const nb = createNotebook('Physics', '#FF228DC3');
const page = nb.pages[0];
const stroke = createStroke('pen', '#101418', 3);
for (let i = 0; i < 50; i++) stroke.points.push({ x: i * 10, y: Math.sin(i / 5) * 40 + 200, p: 0.5 });
page.strokes.push(stroke);
const hi = createStroke('highlighter', '#FFE14D', 18);
hi.points.push({ x: 5, y: 5, p: 0.5 }, { x: 300, y: 8, p: 0.5 });
page.strokes.push(hi);

const lib = { notebooks: [nb] };
const text = serializeLibrary(lib);
const back = deserializeLibrary(text);
assert.strictEqual(back.notebooks[0].pages[0].strokes.length, 2);
assert.strictEqual(back.notebooks[0].pages[0].strokes[0].points.length, 50);

// 2. Validation rejects garbage.
assert.strictEqual(validateLibrary({ notebooks: [{ id: 1 }] }).ok, false);
assert.throws(() => deserializeLibrary('{"notebooks":[{"id":1}]}'), /Invalid library/);
assert.throws(() => deserializeLibrary('not json'), /Unexpected token/);

// 3. Store writes atomically and reloads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-test-'));
const store = new LibraryStore(path.join(dir, 'library.json'));
store.save(lib);
assert.ok(!fs.existsSync(path.join(dir, 'library.json.tmp')), 'no temp file left behind');
const loaded = new LibraryStore(path.join(dir, 'library.json')).load();
assert.strictEqual(loaded.notebooks[0].name, 'Physics');

// 4. Missing file loads empty library instead of crashing.
const empty = new LibraryStore(path.join(dir, 'does-not-exist.json')).load();
assert.deepStrictEqual(empty, { notebooks: [] });

console.log('store.test.js: all 4 checks passed');
