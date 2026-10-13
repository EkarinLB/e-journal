'use strict';
/* Read-only importer for Microsoft Journal .ink files (SQLite container).
   Facts used: pages(id, page_order), blobs(owner_id, ordinal, bytes),
   metadata(icon, color). Page and blob IDs are ASCII GUID strings.
   Ordinal-0 blobs are PNG page renders — pages import as backgrounds.
   Higher-ordinal stroke blobs use an undocumented encoding and are NOT
   parsed yet; pages import without editable strokes (see roadmap). */
window.InkImport = (() => {
  let SQL = null;

  async function engine() {
    if (SQL) return SQL;
    if (typeof initSqlJs === 'function') {
      try {
        SQL = await initSqlJs(); // wasm resolved next to sql-wasm.js
        return SQL;
      } catch (e) { /* fall through to main-process binary */ }
    }
    const wasmBinary = await window.oj.sqlWasmBinary();
    SQL = await initSqlJs({ wasmBinary });
    return SQL;
  }

  function bytesToDataUrl(bytes, mime) {
    let bin = '';
    const CH = 8192;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return 'data:' + mime + ';base64,' + btoa(bin);
  }

  function guidText(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Uint8Array) {
      let s = '';
      for (const b of v) s += String.fromCharCode(b);
      if (/^[\x20-\x7e]+$/.test(s) && s.length > 0) return s;
      return [...v].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    return String(v);
  }

  function isPng(bytes) {
    return bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }

  async function parseInk(arrayBuffer) {
    const sql = await engine();
    const db = new sql.Database(new Uint8Array(arrayBuffer));
    try {
      const meta = db.exec('SELECT icon, color FROM metadata LIMIT 1')[0];
      const icon = meta ? meta.values[0][0] : 'GenericJournal';
      const color = meta ? meta.values[0][1] : '#4FA3CD';
      const pagesRes = db.exec('SELECT id, page_order FROM pages ORDER BY page_order')[0];
      const pages = pagesRes ? pagesRes.values.map(([id, order]) => ({ id: guidText(id), order })) : [];
      const blobsRes = db.exec('SELECT owner_id, ordinal, bytes FROM blobs')[0];
      const byOwner = new Map();
      if (blobsRes) {
        for (const [owner, ordinal, bytes] of blobsRes.values) {
          const key = guidText(owner);
          if (!byOwner.has(key)) byOwner.set(key, {});
          byOwner.get(key)[ordinal] = bytes;
        }
      }
      return { icon, color, pages: pages.map((p) => ({ order: p.order, blobs: byOwner.get(p.id) || {} })) };
    } finally {
      db.close();
    }
  }

  async function importInkFile(arrayBuffer, fileName, uid) {
    const parsed = await parseInk(arrayBuffer);
    const nb = {
      id: uid(), name: fileName.replace(/\.ink$/i, '') || 'Imported',
      color: parsed.color || '#4FA3CD', icon: parsed.icon || 'GenericJournal',
      updatedAt: new Date().toISOString(), pages: [],
    };
    let withArt = 0;
    parsed.pages.forEach((p, i) => {
      const pg = { id: uid(), order: i, width: 1024, height: 1408, strokes: [], images: [] };
      const b0 = p.blobs[0];
      if (isPng(b0)) { pg.background = bytesToDataUrl(b0, 'image/png'); withArt++; }
      nb.pages.push(pg);
    });
    if (nb.pages.length === 0) {
      nb.pages.push({ id: uid(), order: 0, width: 1024, height: 1408, strokes: [], images: [] });
    }
    return { notebook: nb, pagesWithArt: withArt };
  }

  return { parseInk, importInkFile };
})();
