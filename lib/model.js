'use strict';
// Pure data-model helpers shared by tests (and mirrored in the renderer).
// Stroke model: { id, tool: 'pen'|'highlighter', color, width, points: [{x,y,p}] }

const crypto = require('crypto');

function newId() {
  return crypto.randomUUID();
}

function createNotebook(name, color = '#4FA3CD') {
  return { id: newId(), name, color, icon: 'GenericJournal', pages: [createPage(0)] };
}

function createPage(order) {
  return { id: newId(), order, width: 1024, height: 1408, strokes: [] };
}

function createStroke(tool, color, width) {
  return { id: newId(), tool, color, width, points: [] };
}

// Validate a library object loaded from disk. Returns { ok, errors[] }.
function validateLibrary(lib) {
  const errors = [];
  if (!lib || typeof lib !== 'object') return { ok: false, errors: ['root must be object'] };
  if (!Array.isArray(lib.notebooks)) return { ok: false, errors: ['notebooks must be array'] };
  for (const nb of lib.notebooks) {
    if (typeof nb.id !== 'string' || typeof nb.name !== 'string') errors.push('bad notebook id/name');
    if (!Array.isArray(nb.pages)) { errors.push('notebook pages must be array'); continue; }
    for (const pg of nb.pages) {
      if (typeof pg.id !== 'string' || !Array.isArray(pg.strokes)) { errors.push('bad page'); continue; }
      for (const st of pg.strokes) {
        if (!Array.isArray(st.points) || typeof st.color !== 'string') errors.push('bad stroke');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function serializeLibrary(lib) {
  return JSON.stringify({ version: 1, notebooks: lib.notebooks });
}

function deserializeLibrary(text) {
  const data = JSON.parse(text);
  const lib = { notebooks: data.notebooks || [] };
  const v = validateLibrary(lib);
  if (!v.ok) throw new Error('Invalid library: ' + v.errors.join('; '));
  return lib;
}

module.exports = { newId, createNotebook, createPage, createStroke, validateLibrary, serializeLibrary, deserializeLibrary };
