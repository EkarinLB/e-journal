'use strict';
/* OpenJournal renderer v0.2 — home + editor, gestures, smoothing, zoom.
   All code here is original. */
(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_W = 1024, PAGE_H = 1408, LINE_GAP = 48;
  const COLORS = ['#101418', '#C92A2A', '#2B6CB0', '#2F9E44', '#E8A100', '#7C3AED', '#FFE14D'];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

  const state = {
    library: { notebooks: [] },
    nbId: null,
    tool: 'pen', color: '#101418', width: 3,
    zoom: 1, ruled: true,
    drawing: null,           // { pageId, stroke, canvas, ctx }
    undoStack: [],           // { pageId, strokeId }
    canvases: new Map(),     // pageId -> { canvas, ctx }
  };

  const notebook = () => state.library.notebooks.find((n) => n.id === state.nbId);

  /* ================= persistence ================= */
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const nb = notebook();
      if (nb) nb.updatedAt = new Date().toISOString();
      window.oj.saveLibrary(state.library).catch((e) => toast('Save failed: ' + e.message));
    }, 400);
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._h);
    toast._h = setTimeout(() => { t.hidden = true; }, 2200);
  }

  /* Ink geometry + gestures: shared implementation in lib/ink.js (unit-tested). */
  const { smoothPoints, scribbleHits } = window.Ink;

  /* ================= drawing ================= */
  function drawStrokeOn(ctx, st) {
    const pts = smoothPoints(st.points);
    if (pts.length === 0) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = st.color;
    ctx.globalAlpha = st.tool === 'highlighter' ? 0.45 : 1;
    if (pts.length === 1) {
      ctx.fillStyle = st.color;
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, (st.width * (pts[0].p || 0.5)) / 2, 0, 7); ctx.fill();
      ctx.restore(); return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.lineWidth = Math.max(0.5, st.width * (((a.p || 0.5) + (b.p || 0.5)) / 2));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawRuled(ctx) {
    ctx.save();
    ctx.strokeStyle = '#c9c2b2'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = LINE_GAP; y < PAGE_H; y += LINE_GAP) { ctx.moveTo(0, y + 0.5); ctx.lineTo(PAGE_W, y + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = '#d88f8f';
    ctx.beginPath(); ctx.moveTo(96.5, 0); ctx.lineTo(96.5, PAGE_H); ctx.stroke();
    ctx.restore();
  }

  function redrawPage(pageId) {
    const entry = state.canvases.get(pageId);
    const nb = notebook();
    if (!entry || !nb) return;
    const pg = nb.pages.find((p) => p.id === pageId);
    if (!pg) return;
    const { ctx } = entry;
    ctx.save();
    ctx.setTransform(entry.backing, 0, 0, entry.backing, 0, 0);
    ctx.clearRect(0, 0, PAGE_W, PAGE_H);
    if (state.ruled) drawRuled(ctx);
    for (const st of pg.strokes) drawStrokeOn(ctx, st);
    if (state.drawing && state.drawing.pageId === pageId) drawStrokeOn(ctx, state.drawing.stroke);
    ctx.restore();
  }

  function layoutPages() {
    const wrap = $('pages');
    const base = Math.max(0.2, (wrap.clientWidth - 48) / PAGE_W);
    const display = base * state.zoom;
    const backing = Math.min(display * (window.devicePixelRatio || 1), 3);
    for (const [, entry] of state.canvases) {
      entry.backing = backing;
      entry.canvas.style.width = PAGE_W * display + 'px';
      entry.canvas.style.height = PAGE_H * display + 'px';
      entry.canvas.width = Math.round(PAGE_W * backing);
      entry.canvas.height = Math.round(PAGE_H * backing);
    }
    for (const pageId of state.canvases.keys()) redrawPage(pageId);
    $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  }

  function canvasPos(canvas, evt) {
    const r = canvas.getBoundingClientRect();
    return { x: (evt.clientX - r.left) * (PAGE_W / r.width), y: (evt.clientY - r.top) * (PAGE_H / r.height) };
  }

  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function eraseAt(pg, pos) {
    const before = pg.strokes.length;
    pg.strokes = pg.strokes.filter((st) =>
      !st.points.some((p, i) => (i > 0 ? distToSeg(pos, st.points[i - 1], p) : Math.hypot(p.x - pos.x, p.y - pos.y)) < 14));
    return before - pg.strokes.length;
  }

  /* ================= editor DOM ================= */
  function buildEditor() {
    const nb = notebook(); if (!nb) return;
    $('nb-name').textContent = nb.name;
    const zone = $('pages');
    zone.innerHTML = '';
    state.canvases.clear();
    nb.pages.forEach((pg, idx) => zone.appendChild(sheetEl(nb, pg, idx)));
    const end = document.createElement('div');
    end.id = 'end-zone';
    end.innerHTML = `<div id="scroll-hint">Scroll down for a new page</div>`;
    const btn = document.createElement('button');
    btn.id = 'add-page-end'; btn.textContent = '+ New page';
    btn.onclick = () => addPage();
    end.appendChild(btn);
    zone.appendChild(end);
    updateIndicator();
    requestAnimationFrame(layoutPages);
  }

  function sheetEl(nb, pg, idx) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    const canvas = document.createElement('canvas');
    const entry = { canvas, ctx: canvas.getContext('2d'), backing: 1 };
    state.canvases.set(pg.id, entry);
    const bar = document.createElement('div');
    bar.className = 'sheet-bar';
    bar.innerHTML = `<span>Page ${idx + 1}</span>`;
    const del = document.createElement('button');
    del.textContent = '×'; del.title = 'Delete page';
    del.onclick = () => deletePage(pg.id);
    bar.appendChild(del);
    wrap.appendChild(canvas); wrap.appendChild(bar);
    attachInk(canvas, pg.id);
    return wrap;
  }

  function attachInk(canvas, pageId) {
    canvas.addEventListener('pointerdown', (evt) => {
      if (evt.pointerType === 'touch') return; // touch scrolls pages; pen/mouse draws
      evt.preventDefault();
      canvas.setPointerCapture(evt.pointerId);
      const nb = notebook();
      const pg = nb ? nb.pages.find((p) => p.id === pageId) : null;
      if (!pg) return;
      const pos = canvasPos(canvas, evt);
      if (state.tool === 'eraser') {
        if (eraseAt(pg, pos) > 0) { scheduleSave(); redrawPage(pageId); }
        return;
      }
      const w = state.tool === 'highlighter' ? Math.max(state.width, 12) : state.width;
      state.drawing = { pageId, stroke: { id: uid(), tool: state.tool, color: state.color, width: w, points: [{ x: pos.x, y: pos.y, p: evt.pressure || 0.5 }] } };
      redrawPage(pageId);
    });
    canvas.addEventListener('pointermove', (evt) => {
      const d = state.drawing;
      if (!d || evt.pointerType === 'touch') return;
      for (const e of evt.getCoalescedEvents ? evt.getCoalescedEvents() : [evt]) {
        const pos = canvasPos(canvas, e);
        d.stroke.points.push({ x: pos.x, y: pos.y, p: e.pressure || 0.5 });
      }
      redrawPage(d.pageId);
    });
    const finish = () => {
      const d = state.drawing;
      if (!d) return;
      state.drawing = null;
      const nb = notebook();
      const pg = nb ? nb.pages.find((p) => p.id === d.pageId) : null;
      if (!pg || d.stroke.points.length === 0) { if (pg) redrawPage(pg.id); return; }
      if (d.stroke.tool !== 'eraser') {
        const hits = scribbleHits(d.stroke.points, pg.strokes);
        if (hits) {
          pg.strokes = pg.strokes.filter((s) => !hits.includes(s.id));
          toast(`Scribbled out ${hits.length} stroke${hits.length > 1 ? 's' : ''}`);
          scheduleSave(); redrawPage(pg.id); return;
        }
      }
      pg.strokes.push(d.stroke);
      state.undoStack.push({ pageId: pg.id, strokeId: d.stroke.id });
      scheduleSave(); redrawPage(pg.id);
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => { state.drawing = null; redrawPage(pageId); });
  }

  function mostVisiblePage() {
    const zone = $('pages');
    const zr = zone.getBoundingClientRect();
    let best = null, bestArea = -1;
    for (const [id, entry] of state.canvases) {
      const r = entry.canvas.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.bottom, zr.bottom) - Math.max(r.top, zr.top));
      if (area > bestArea) { bestArea = area; best = id; }
    }
    return best;
  }
  function updateIndicator() {
    const nb = notebook(); if (!nb) return;
    const id = mostVisiblePage();
    const i = nb.pages.findIndex((p) => p.id === id);
    $('page-indicator').textContent = i >= 0 ? `Page ${i + 1} / ${nb.pages.length}` : '';
  }

  function addPage() {
    const nb = notebook(); if (!nb) return null;
    const pg = { id: uid(), order: nb.pages.length, width: PAGE_W, height: PAGE_H, strokes: [] };
    nb.pages.push(pg);
    scheduleSave(); buildEditor();
    requestAnimationFrame(() => {
      const entry = state.canvases.get(pg.id);
      if (entry) entry.canvas.scrollIntoView({ block: 'start' });
      toast('New page added');
    });
    return pg;
  }

  function deletePage(pageId) {
    const nb = notebook(); if (!nb || nb.pages.length <= 1) { toast('A notebook needs at least one page'); return; }
    const pg = nb.pages.find((p) => p.id === pageId);
    if (pg && pg.strokes.length > 0 && !confirm('Delete this page and its ink?')) return;
    nb.pages = nb.pages.filter((p) => p.id !== pageId);
    nb.pages.forEach((p, i) => { p.order = i; });
    scheduleSave(); buildEditor();
  }

  function openNotebook(id) {
    state.nbId = id; state.undoStack = []; state.zoom = 1;
    const nb = notebook();
    if (nb && nb.ruled === undefined) nb.ruled = true;
    state.ruled = nb ? nb.ruled !== false : true;
    $('lines-btn').classList.toggle('active', state.ruled);
    $('home-view').hidden = true; $('editor-view').hidden = false;
    buildEditor();
  }
  function goHome() {
    state.nbId = null;
    $('editor-view').hidden = true; $('home-view').hidden = false;
    document.body.classList.remove('chrome-hidden'); $('show-chrome').hidden = true;
    renderHome($('search').value);
  }

  /* ================= home ================= */
  function renderHome(filter = '') {
    const grid = $('nb-grid'); grid.innerHTML = '';
    const nbs = [...state.library.notebooks].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    for (const nb of nbs) {
      if (filter && !nb.name.toLowerCase().includes(filter.toLowerCase())) continue;
      const card = document.createElement('div');
      card.className = 'card';
      card.style.setProperty('--accent', nb.color);
      card.style.borderTopColor = nb.color;
      const h = document.createElement('h3'); h.textContent = nb.name;
      const s = document.createElement('small');
      s.textContent = `${nb.pages.length} page${nb.pages.length === 1 ? '' : 's'}`;
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '×'; del.title = 'Delete notebook';
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${nb.name}"?`)) {
          state.library.notebooks = state.library.notebooks.filter((n) => n.id !== nb.id);
          scheduleSave(); renderHome($('search').value);
        }
      };
      card.append(h, s, del);
      card.onclick = () => openNotebook(nb.id);
      grid.appendChild(card);
    }
    if (nbs.length === 0) grid.innerHTML = '<p style="opacity:.6">No notebooks yet — press + New to start one.</p>';
  }

  /* ================= wiring ================= */
  $('add-notebook').onclick = () => {
    const name = prompt('Notebook name:', 'Untitled');
    if (!name) return;
    const nb = { id: uid(), name, color: COLORS[state.library.notebooks.length % COLORS.length], icon: 'GenericJournal', updatedAt: new Date().toISOString(), pages: [{ id: uid(), order: 0, width: PAGE_W, height: PAGE_H, strokes: [] }] };
    state.library.notebooks.push(nb);
    scheduleSave(); openNotebook(nb.id);
  };
  $('search').oninput = (e) => renderHome(e.target.value);
  $('back-btn').onclick = goHome;
  document.querySelectorAll('#island .tool').forEach((b) => {
    b.onclick = () => { document.querySelectorAll('#island .tool').forEach((x) => x.classList.remove('active')); b.classList.add('active'); state.tool = b.dataset.tool; };
  });
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
    const nb = notebook(); const u = state.undoStack.pop();
    if (!nb || !u) return;
    const pg = nb.pages.find((p) => p.id === u.pageId);
    if (pg) { pg.strokes = pg.strokes.filter((s) => s.id !== u.strokeId); scheduleSave(); redrawPage(pg.id); }
  };
  $('clear-btn').onclick = () => {
    const nb = notebook(); if (!nb) return;
    const id = mostVisiblePage();
    const pg = nb.pages.find((p) => p.id === id);
    if (pg && pg.strokes.length > 0 && confirm('Clear this page?')) { pg.strokes = []; scheduleSave(); redrawPage(pg.id); }
  };
  $('lines-btn').onclick = () => {
    state.ruled = !state.ruled;
    $('lines-btn').classList.toggle('active', state.ruled);
    const nb = notebook(); if (nb) nb.ruled = state.ruled;
    scheduleSave();
    for (const id of state.canvases.keys()) redrawPage(id);
  };

  /* zoom */
  function setZoom(z, keepRatio = true) {
    const zone = $('pages');
    const ratio = keepRatio ? zone.scrollTop / (zone.scrollHeight || 1) : 0;
    state.zoom = Math.min(4, Math.max(0.25, z));
    layoutPages();
    requestAnimationFrame(() => { zone.scrollTop = ratio * zone.scrollHeight; updateIndicator(); });
  }
  $('zoom-in').onclick = () => setZoom(state.zoom * 1.2);
  $('zoom-out').onclick = () => setZoom(state.zoom / 1.2);
  $('zoom-label').onclick = () => setZoom(1);
  $('zoom-fit').onclick = () => setZoom(1);
  $('pages').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  /* hide UI */
  function setChrome(hidden) {
    document.body.classList.toggle('chrome-hidden', hidden);
    $('show-chrome').hidden = !hidden;
  }
  $('hide-btn').onclick = () => setChrome(true);
  $('show-chrome').onclick = () => setChrome(false);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') {
      if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (!$('editor-view').hidden) setChrome(!document.body.classList.contains('chrome-hidden'));
    } else if (e.key === 'Escape') setChrome(false);
  });

  /* infinite scroll → new page */
  let scrollT = null;
  $('pages').addEventListener('scroll', () => {
    updateIndicator();
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const zone = $('pages');
      const nb = notebook();
      if (!nb || $('editor-view').hidden) return;
      if (zone.scrollTop + zone.clientHeight > zone.scrollHeight - 240) {
        const last = nb.pages[nb.pages.length - 1];
        if (last && last.strokes.length > 0) addPage();
      }
    }, 250);
  });

  $('export-btn').onclick = () => window.oj.exportLibrary(state.library).catch((e) => toast(e.message));
  $('import-btn').onclick = async () => {
    try {
      const text = await window.oj.importLibrary();
      if (!text) return;
      const data = JSON.parse(text);
      if (!Array.isArray(data.notebooks)) throw new Error('bad file');
      for (const nb of data.notebooks) { nb.id = uid(); for (const pg of nb.pages || []) pg.id = uid(); state.library.notebooks.push(nb); }
      scheduleSave(); renderHome($('search').value); toast('Imported');
    } catch (err) { toast('Import failed: ' + err.message); }
  };
  window.addEventListener('resize', () => { if (!$('editor-view').hidden) layoutPages(); });

  /* ================= boot ================= */
  (async () => {
    state.library = await window.oj.loadLibrary();
    for (const nb of state.library.notebooks) {
      if (nb.ruled === undefined) nb.ruled = true;
      nb.pages.forEach((pg, i) => { pg.order = i; pg.width = PAGE_W; pg.height = PAGE_H; });
    }
    renderHome();
  })().catch(console.error);
})();
