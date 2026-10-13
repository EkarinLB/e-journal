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
