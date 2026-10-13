'use strict';
// File-backed library store used by the Electron main process.
const fs = require('fs');
const path = require('path');
const { validateLibrary } = require('./model');

class LibraryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.library = { notebooks: [] };
  }
  load() {
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(text);
      const lib = { notebooks: data.notebooks || [] };
      const v = validateLibrary(lib);
      if (!v.ok) throw new Error(v.errors.join('; '));
      this.library = lib;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.library = { notebooks: [] };
    }
    return this.library;
  }
  save(library) {
    const v = validateLibrary(library);
    if (!v.ok) throw new Error('Refusing to save invalid library: ' + v.errors.join('; '));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, notebooks: library.notebooks }));
    fs.renameSync(tmp, this.filePath);
    this.library = library;
  }
}

module.exports = { LibraryStore };
