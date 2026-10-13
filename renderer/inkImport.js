'use strict';
/* .ink import entry point (renderer side).
   Electron: bytes go to the main process, which parses with Node sql.js
   (no file:// wasm restrictions). Tauri/future: falls back to in-page
   sql.js, which works when the frontend is served over http(s).
   Parsing itself lives in lib/inkfile.js, shared by both paths. */
window.InkImport = (() => {
  let SQL = null;

  function loadEngineScript() {
    return new Promise((resolve, reject) => {
      if (typeof initSqlJs === 'function') { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'vendor/sql-wasm.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('SQL engine file missing'));
      document.head.appendChild(s);
    });
  }

  async function engine() {
    if (SQL) return SQL;
    await loadEngineScript();
    SQL = await initSqlJs();
    return SQL;
  }

  async function importInkFile(arrayBuffer, fileName, uid) {
    const B = window.oj;
    if (B && B.parseInk) return B.parseInk(new Uint8Array(arrayBuffer), fileName);
    const sql = await engine();
    const db = new sql.Database(new Uint8Array(arrayBuffer));
    try {
      return window.InkFile.buildNotebook(window.InkFile.parseInkDb(db), fileName, uid);
    } finally {
      db.close();
    }
  }

  return { importInkFile };
})();
