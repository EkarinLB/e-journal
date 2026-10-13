'use strict';
// Pure .ink (Microsoft Journal, SQLite container) parsing + notebook build.
// No DOM, no sql.js loading here: the caller supplies an opened database
// object with `.exec(sql)` returning [{columns, values}], matching sql.js.
// Facts used: pages(id, page_order), blobs(owner_id, ordinal, bytes),
// metadata(icon, color). Page/blob IDs are ASCII GUID strings. Ordinal-0
// blobs are PNG page renders; higher ordinals use an undocumented encoding
// and are intentionally not parsed (pages import as backgrounds).
(function (root) {
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

  function base64Encode(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    const CH = 8192;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function isPng(bytes) {
    return bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }

  function parseInkDb(db) {
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
  }

  function buildNotebook(parsed, fileName, uid) {
    const nb = {
      id: uid(), name: fileName.replace(/\.ink$/i, '') || 'Imported',
      color: parsed.color || '#4FA3CD', icon: parsed.icon || 'GenericJournal',
      updatedAt: new Date().toISOString(), pages: [],
    };
    let withArt = 0;
    parsed.pages.forEach((p, i) => {
      const pg = { id: uid(), order: i, width: 1024, height: 1408, strokes: [], images: [] };
      const b0 = p.blobs[0];
      if (isPng(b0)) { pg.background = 'data:image/png;base64,' + base64Encode(b0); withArt++; }
      nb.pages.push(pg);
    });
    if (nb.pages.length === 0) {
      nb.pages.push({ id: uid(), order: 0, width: 1024, height: 1408, strokes: [], images: [] });
    }
    return { notebook: nb, pagesWithArt: withArt };
  }

  const api = { guidText, base64Encode, isPng, parseInkDb, buildNotebook };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InkFile = api;
})(typeof self !== 'undefined' ? self : globalThis);
