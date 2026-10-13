'use strict';
/* OpenJournal renderer: pressure-sensitive ink canvas, pages, notebooks.
   All code here is original. Storage model mirrors only factual observations
   (notebooks contain ordered pages; pages contain strokes). */
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('ink');
  const ctx = canvas.getContext('2d');
  const COLORS = ['#101418', '#C92A2A', '#2B6CB0', '#2F9E44', '#E8A100', '#7C3AED', '#FFE14D'];

  const state = {
    library: { notebooks: [] },
    nbId: null, pageId: null,
    tool: 'pen', color: '#101418', width: 3,
    drawing: null, undoStack: [],
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

  const notebook = () => state.library.notebooks.find((n) => n.id === state.nbId);
  const page = () => { const nb = notebook(); return nb ? nb.pages.find((p) => p.id === state.pageId) : null; };

  // ---------- persistence ----------
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.oj.saveLibrary(state.library).catch(console.error), 400);
  }

  // ---------- canvas ----------
  function fitCanvas() {
    const pg = page(); if (!pg) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(1, ($('canvas-wrap').clientWidth - 32) / pg.width);
    canvas.style.width = pg.width * scale + 'px';
    canvas.style.height = pg.height * scale + 'px';
    canvas.width = Math.round(pg.width * dpr);
    canvas.height = Math.round(pg.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function drawStroke(st) {
    if (st.points.length === 0) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = st.color;
    ctx.globalAlpha = st.tool === 'highlighter' ? 0.45 : 1;
    if (st.points.length === 1) {
      const p = st.points[0];
      ctx.fillStyle = st.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, (st.width * (p.p || 0.5)) / 2, 0, 7); ctx.fill();
      ctx.restore(); return;
    }
    for (let i = 1; i < st.points.length; i++) {
      const a = st.points[i - 1], b = st.points[i];
      ctx.lineWidth = st.width * (((a.p || 0.5) + (b.p || 0.5)) / 2);
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  function redraw() {
    const pg = page(); if (!pg) return;
    ctx.save(); ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, pg.width, pg.height);
    for (const st of pg.strokes) drawStroke(st);
    if (state.drawing) drawStroke(state.drawing);
    ctx.restore();
  }

  function canvasPos(evt) {
    const r = canvas.getBoundingClientRect();
    const pg = page();
    return { x: (evt.clientX - r.left) * (pg.width / r.width), y: (evt.clientY - r.top) * (pg.height / r.height) };
  }

  canvas.addEventListener('pointerdown', (evt) => {
    const pg = page(); if (!pg) return;
    canvas.setPointerCapture(evt.pointerId);
    if (state.tool === 'eraser') { eraseAt(canvasPos(evt)); return; }
    const w = state.tool === 'highlighter' ? Math.max(state.width, 12) : state.width;
    state.drawing = { id: uid(), tool: state.tool, color: state.color, width: w, points: [] };
    const pos = canvasPos(evt);
    state.drawing.points.push({ x: pos.x, y: pos.y, p: evt.pressure || 0.5 });
    redraw();
  });
  canvas.addEventListener('pointermove', (evt) => {
    if (!state.drawing) return;
    for (const e of evt.getCoalescedEvents ? evt.getCoalescedEvents() : [evt]) {
      const pos = canvasPos(e);
      state.drawing.points.push({ x: pos.x, y: pos.y, p: e.pressure || 0.5 });
    }
    redraw();
  });
  function finishStroke() {
    const pg = page();
    if (state.drawing && pg) {
      if (state.drawing.points.length > 0) {
        pg.strokes.push(state.drawing);
        state.undoStack.push(state.drawing.id);
        scheduleSave();
      }
      state.drawing = null;
      redraw();
    }
  }
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);

  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function eraseAt(pos) {
    const pg = page(); if (!pg) return;
    const before = pg.strokes.length;
    pg.strokes = pg.strokes.filter((st) =>
      !st.points.some((p, i) => (i > 0 ? distToSeg(pos, st.points[i - 1], p) : Math.hypot(p.x - pos.x, p.y - pos.y)) < 12));
    if (pg.strokes.length !== before) { scheduleSave(); redraw(); }
  }

  // ---------- sidebar / pages ----------
  function renderNotebooks(filter = '') {
    const list = $('notebook-list'); list.innerHTML = '';
    for (const nb of state.library.notebooks) {
      if (filter && !nb.name.toLowerCase().includes(filter.toLowerCase())) continue;
      const div = document.createElement('div');
      div.className = 'nb' + (nb.id === state.nbId ? ' active' : '');
      div.style.setProperty('--accent', nb.color);
      div.style.borderLeftColor = nb.color;
      div.innerHTML = `<strong></strong> <small></small>`;
      div.querySelector('strong').textContent = nb.name;
      div.querySelector('small').textContent = `${nb.pages.length} pages`;
      div.onclick = () => { state.nbId = nb.id; state.pageId = nb.pages[0] ? nb.pages[0].id : null; state.undoStack = []; renderAll(); };
      list.appendChild(div);
    }
  }

  function renderPageLabel() {
    const nb = notebook(); const pg = page();
    $('page-label').textContent = nb && pg ? `Page ${nb.pages.indexOf(pg) + 1} / ${nb.pages.length}` : '';
  }

  function renderAll() { renderNotebooks($('search').value); renderPageLabel(); fitCanvas(); }

  $('add-notebook').onclick = () => {
    const name = prompt('Notebook name:', 'Untitled');
    if (!name) return;
    const nb = { id: uid(), name, color: COLORS[state.library.notebooks.length % COLORS.length], icon: 'GenericJournal', pages: [{ id: uid(), order: 0, width: 1024, height: 1408, strokes: [] }] };
    state.library.notebooks.push(nb);
    state.nbId = nb.id; state.pageId = nb.pages[0].id; state.undoStack = [];
    scheduleSave(); renderAll();
  };
  $('search').oninput = (e) => renderNotebooks(e.target.value);
  document.querySelectorAll('.tool').forEach((b) => { b.onclick = () => { document.querySelectorAll('.tool').forEach((x) => x.classList.remove('active')); b.classList.add('active'); state.tool = b.dataset.tool; }; });
  const colorBox = $('colors');
  for (const c of COLORS) {
    const s = document.createElement('div');
    s.className = 'swatch' + (c === state.color ? ' active' : '');
    s.style.background = c; s.title = c;
    s.onclick = () => { state.color = c; document.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active')); s.classList.add('active'); };
    colorBox.appendChild(s);
  }
  $('width').oninput = (e) => { state.width = Number(e.target.value); };
  $('undo-btn').onclick = () => {
    const pg = page(); const id = state.undoStack.pop(); if (!pg || !id) return;
    pg.strokes = pg.strokes.filter((s) => s.id !== id); scheduleSave(); redraw();
  };
  $('clear-btn').onclick = () => { const pg = page(); if (pg && confirm('Clear this page?')) { pg.strokes = []; state.undoStack = []; scheduleSave(); redraw(); } };
  $('add-page').onclick = () => {
    const nb = notebook(); if (!nb) return;
    const pg = { id: uid(), order: nb.pages.length, width: 1024, height: 1408, strokes: [] };
    nb.pages.push(pg); state.pageId = pg.id; state.undoStack = []; scheduleSave(); renderAll();
  };
  $('del-page').onclick = () => {
    const nb = notebook(); if (!nb || nb.pages.length <= 1) return;
    if (!confirm('Delete this page?')) return;
    nb.pages = nb.pages.filter((p) => p.id !== state.pageId);
    nb.pages.forEach((p, i) => { p.order = i; });
    state.pageId = nb.pages[0].id; state.undoStack = []; scheduleSave(); renderAll();
  };
  $('export-btn').onclick = () => window.oj.exportLibrary(state.library).catch(console.error);
  $('import-btn').onclick = async () => {
    try {
      const text = await window.oj.importLibrary();
      if (!text) return;
      const data = JSON.parse(text);
      if (!Array.isArray(data.notebooks)) throw new Error('bad file');
      for (const nb of data.notebooks) { nb.id = uid(); for (const pg of nb.pages) pg.id = uid(); state.library.notebooks.push(nb); }
      scheduleSave(); renderAll();
    } catch (err) { alert('Import failed: ' + err.message); }
  };
  window.addEventListener('resize', fitCanvas);

  // ---------- boot ----------
  (async () => {
    state.library = await window.oj.loadLibrary();
    if (state.library.notebooks.length === 0) {
      const nb = { id: uid(), name: 'Quick notes', color: '#4FA3CD', icon: 'GenericJournal', pages: [{ id: uid(), order: 0, width: 1024, height: 1408, strokes: [] }] };
      state.library.notebooks.push(nb);
    }
    state.nbId = state.library.notebooks[0].id;
    state.pageId = state.library.notebooks[0].pages[0].id;
    renderAll();
  })().catch(console.error);
})();
