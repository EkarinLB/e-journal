'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oj', {
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (library) => ipcRenderer.invoke('library:save', library),
  exportLibrary: (library) => ipcRenderer.invoke('library:export', library),
  importLibrary: () => ipcRenderer.invoke('library:import'),
  pickImage: () => ipcRenderer.invoke('media:pickImage'),
  sqlWasmBinary: () => ipcRenderer.invoke('util:sqlwasm'),
});
