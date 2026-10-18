'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { LibraryStore } = require('./lib/store');
const { parseInkDb, buildNotebook } = require('./lib/inkfile');

let sqlEngine = null;
async function sqlite() {
  if (!sqlEngine) sqlEngine = await require('sql.js')();
  return sqlEngine;
}

let store;
let win;

function libraryPath() {
  return path.join(app.getPath('userData'), 'openjournal-library.json');
}

function createWindow() {
  store = new LibraryStore(libraryPath());
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('library:load', () => store.load());
ipcMain.handle('library:save', (_evt, library) => { store.save(library); return true; });

ipcMain.handle('library:export', async (_evt, library) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: 'notebook.openjournal',
    filters: [{ name: 'OpenJournal', extensions: ['openjournal'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, notebooks: library.notebooks }));
  return true;
});

ipcMain.handle('library:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'OpenJournal', extensions: ['openjournal'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return null;
  return fs.readFileSync(filePaths[0], 'utf8');
});

// .ink file picker + read, so the renderer never depends on
// programmatic <input type=file> clicks (blocked in some webviews).
ipcMain.handle('ink:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'Journal ink', extensions: ['ink'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || filePaths.length === 0) return [];
  return filePaths.slice(0, 10).map((p) => {
    const buf = fs.readFileSync(p);
    if (buf.length > 25 * 1024 * 1024) throw new Error(path.basename(p) + ' is larger than 25 MB');
    return { name: path.basename(p), bytes: new Uint8Array(buf) };
  });
});

// .ink parsing runs in the main process: Node's sql.js reads its wasm
// straight from disk, unaffected by file:// fetch restrictions.
ipcMain.handle('ink:parse', async (_evt, bytes, fileName) => {
  const SQL = await sqlite();
  const db = new SQL.Database(new Uint8Array(bytes));
  try {
    return buildNotebook(parseInkDb(db), fileName, () => crypto.randomUUID());
  } finally {
    db.close();
  }
});

const IMAGE_EXTS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

ipcMain.handle('media:pickImage', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return null;
  const ext = path.extname(filePaths[0]).toLowerCase();
  const mime = IMAGE_EXTS[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(filePaths[0]);
  if (buf.length > 12 * 1024 * 1024) throw new Error('Image is larger than 12 MB');
  return { name: path.basename(filePaths[0]), mime, base64: buf.toString('base64') };
});

// sql.js wasm binary as a transferable ArrayBuffer, so the renderer can
// init the engine without depending on file:// fetch behavior.
ipcMain.handle('util:sqlwasm', () => {
  const buf = fs.readFileSync(path.join(__dirname, 'renderer', 'vendor', 'sql-wasm.wasm'));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});
