'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { LibraryStore } = require('./lib/store');

let store;
let win;

function libraryPath() {
  return path.join(app.getPath('userData'), 'openjournal-library.json');
}

function createWindow() {
  store = new LibraryStore(libraryPath());
  win = new BrowserWindow({
    width: 1280,
    height: 860,
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

// sql.js wasm binary, so the renderer can init the engine without
// depending on file:// fetch behavior.
ipcMain.handle('util:sqlwasm', () => {
  const buf = fs.readFileSync(path.join(__dirname, 'renderer', 'vendor', 'sql-wasm.wasm'));
  return new Uint8Array(buf);
});
