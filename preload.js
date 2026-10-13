'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oj', {
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (library) => ipcRenderer.invoke('library:save', library),
  exportLibrary: (library) => ipcRenderer.invoke('library:export', library),
  importLibrary: () => ipcRenderer.invoke('library:import'),
  pickImage: () => ipcRenderer.invoke('media:pickImage'),
  pickInk: () => ipcRenderer.invoke('ink:pick'),
  parseInk: (bytes, fileName) => ipcRenderer.invoke('ink:parse', bytes, fileName),
  sqlWasmBinary: () => ipcRenderer.invoke('util:sqlwasm'),
});
