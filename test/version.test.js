// The version is declared in four places. When one drifts, the shipped
// artifact lies: a .deb whose control file says 0.12.0 while the binary
// inside it reports 0.11.0 is exactly what happened. This fails the build
// instead.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const declared = {};

// package.json
declared['package.json'] = JSON.parse(read('package.json')).version;

// src-tauri/tauri.conf.json
declared['src-tauri/tauri.conf.json'] = JSON.parse(read('src-tauri/tauri.conf.json')).version;

// Cargo manifests use `version = "x"` rather than JSON.
for (const manifest of ['src-tauri/Cargo.toml', 'native/Cargo.toml']) {
  const m = read(manifest).match(/^version\s*=\s*"([^"]+)"/m);
  assert.ok(m, `${manifest} has no version field`);
  declared[manifest] = m[1];
}

// AppStream metadata lists released versions; its newest entry is the one
// being shipped and must agree.
const meta = read('data/metainfo/com.ejournal.app.metainfo.xml');
const releases = [...meta.matchAll(/<release version="([^"]+)"[^>]*>/g)].map((m) => m[1]);
assert.ok(releases.length > 0, 'metainfo lists no releases');
declared['data/metainfo (latest release)'] = releases[0];

const distinct = [...new Set(Object.values(declared))];
assert.strictEqual(
  distinct.length,
  1,
  `version mismatch:\n` +
    Object.entries(declared).map(([f, v]) => `  ${v}  ${f}`).join('\n') +
    `\nAll manifests and the metainfo release must declare the same version.`
);

console.log(`version.test.js: all manifests agree on ${distinct[0]}`);