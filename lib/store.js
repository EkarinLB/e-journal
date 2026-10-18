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
  // `intentional` marks a save the user asked for directly (deleting the last
  // notebook). An empty save that is NOT intentional would silently destroy
  // real notes, so it is refused instead.
  save(library, intentional = false) {
    const v = validateLibrary(library);
    if (!v.ok) throw new Error('Refusing to save invalid library: ' + v.errors.join('; '));
    const incoming = Array.isArray(library.notebooks) ? library.notebooks.length : 0;
    const existing = this.library.notebooks.length;
    if (incoming === 0 && existing > 0 && !intentional) {
      throw new Error(`refusing to overwrite ${existing} notebooks with an empty library`);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Rolling backup of the last known-good copy, taken before every overwrite.
    if (fs.existsSync(this.filePath)) {
      try { fs.copyFileSync(this.filePath, this.filePath.replace(/\.json$/, '.json.bak')); } catch (_) {}
    }
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, notebooks: library.notebooks }));
    fs.renameSync(tmp, this.filePath);
    this.library = library;
  }
}

module.exports = { LibraryStore };
