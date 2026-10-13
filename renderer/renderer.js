'use strict';
/* OpenJournal renderer v0.2 — home + editor, gestures, smoothing, zoom.
   All code here is original. */
(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_W = 1024, PAGE_H = 1408, LINE_GAP = 48;
  const COLORS = ['#101418', '#C92A2A', '#2B6CB0', '#2F9E44', '#E8A100', '#7C3AED', '#FFE14D'];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

  // Backend bridge. Electron exposes window.oj via preload; under Tauri
  // the same surface is built on window.__TAURI__.core.invoke.
  const Backend = (() => {
    if (window.oj) return window.oj;
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (core) {
      const invoke = (...args) => core.invoke(...args);
      return {
        loadLibrary: () => invoke('library_load'),
        saveLibrary: (library) => invoke('library_save', { library }),
        exportLibrary: (library) => invoke('library_export', { library }),
        importLibrary: () => invoke('library_import'),
        pickImage: () => invoke('media_pick_image'),
        sqlWasmBinary: () => invoke('util_sqlwasm').then((a) => new Uint8Array(a)),
      };
    }
    return null;
  })();
  if (Backend && !window.oj) window.oj = Backend; // inkImport reads window.oj

  /* Modal dialogs. Native prompt()/confirm() are blocked in sandboxed
     webviews (and return null/false), so all user questions go through
     this in-app modal instead. */
  function modal({ title, body, input, value, okText, danger }) {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      const bodyEl = $('modal-body');
      if (body) { bodyEl.textContent = body; bodyEl.hidden = false; } else bodyEl.hidden = true;
      const inputEl = $('modal-input');
      if (input) { inputEl.hidden = false; inputEl.value = value || ''; } else inputEl.hidden = true;
      const ok = $('modal-ok');
      ok.textContent = okText || 'OK';
      ok.classList.toggle('danger', !!danger);
      $('modal-backdrop').hidden = false;
      const done = (v) => {
        $('modal-backdrop').hidden = true;
        ok.onclick = cancelBtn.onclick = null;
        resolve(v);
      };
      const cancelBtn = $('modal-cancel');
      ok.onclick = () => done(input ? inputEl.value.trim() : true);
      cancelBtn.onclick = () => done(input ? null : false);
      if (input) { inputEl.focus(); inputEl.select(); }
    });
  }
  const modalInput = (title, value) => modal({ title, input: true, value });
  const modalConfirm = (title, body, okText) => modal({ title, body, okText: okText || 'Delete', danger: true });

  const state = {
    library: { notebooks: [] },
    nbId: null,
    tool: 'pen', color: '#101418', width: 3,
    zoom: 1, ruled: true,
    drawing: null,           // { pageId, stroke }
    undoStack: [],           // { pageId, strokeId }
    canvases: new Map(),     // pageId -> { canvas, ctx, backing }
    selectedImage: null,     // image id (select tool)
    dragImg: null,           // { pageId, imageId, dx, dy }
    imgCache: new Map(),     // image id -> HTMLImageElement
  };

  const notebook = () => state.library.notebooks.find((n) => n.id === state.nbId);

  /* ================= persistence ================= */
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const nb = notebook();
      if (nb) nb.updatedAt = new Date().toISOString();
      Backend.saveLibrary(state.library).catch((e) => toast('Save failed: ' + e.message));
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

  function imgEl(image, onReady) {
    let el = state.imgCache.get(image.id);
    if (!el) {
      el = new Image();
      el.onload = () => onReady && onReady();
      el.src = image.dataUrl;
      state.imgCache.set(image.id, el);
    }
    return el;
  }

  function drawImagesOn(ctx, pg, pageId) {
    for (const im of pg.images || []) {
      const el = imgEl(im, () => redrawPage(pageId));
      if (el.complete && el.naturalWidth > 0) {
        ctx.drawImage(el, im.x, im.y, im.w, im.h);
        if (state.selectedImage === im.id) {
          ctx.save();
          ctx.strokeStyle = '#4fa3cd'; ctx.lineWidth = 3; ctx.setLineDash([10, 6]);
          ctx.strokeRect(im.x, im.y, im.w, im.h);
          ctx.restore();
        }
      }
    }
  }

  function drawBackgroundOn(ctx, pg, pageId) {
    if (!pg.background) return;
    const el = imgEl({ id: 'bg:' + pg.id, dataUrl: pg.background }, () => redrawPage(pageId));
    if (el.complete && el.naturalWidth > 0) ctx.drawImage(el, 0, 0, PAGE_W, PAGE_H);
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
    drawBackgroundOn(ctx, pg, pageId);
    drawImagesOn(ctx, pg, pageId);
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
      if (state.tool === 'select') {
        const hit = [...(pg.images || [])].reverse().find((im) =>
          pos.x >= im.x && pos.x <= im.x + im.w && pos.y >= im.y && pos.y <= im.y + im.h);
        state.selectedImage = hit ? hit.id : null;
        if (hit) state.dragImg = { pageId, imageId: hit.id, dx: pos.x - hit.x, dy: pos.y - hit.y };
        redrawPage(pageId);
        return;
      }
      const w = state.tool === 'highlighter' ? Math.max(state.width, 12) : state.width;
      state.drawing = { pageId, stroke: { id: uid(), tool: state.tool, color: state.color, width: w, points: [{ x: pos.x, y: pos.y, p: evt.pressure || 0.5 }] } };
      redrawPage(pageId);
    });
    canvas.addEventListener('pointermove', (evt) => {
      if (state.dragImg) {
        const nb = notebook();
        const pg = nb ? nb.pages.find((p) => p.id === state.dragImg.pageId) : null;
        if (pg) {
          const im = (pg.images || []).find((i) => i.id === state.dragImg.imageId);
          if (im) {
            const pos = canvasPos(canvas, evt);
            im.x = Math.min(Math.max(pos.x - state.dragImg.dx, -im.w + 40), PAGE_W - 40);
            im.y = Math.min(Math.max(pos.y - state.dragImg.dy, -im.h + 40), PAGE_H - 40);
            redrawPage(pg.id);
          }
        }
        return;
      }
      const d = state.drawing;
      if (!d || evt.pointerType === 'touch') return;
      for (const e of evt.getCoalescedEvents ? evt.getCoalescedEvents() : [evt]) {
        const pos = canvasPos(canvas, e);
        d.stroke.points.push({ x: pos.x, y: pos.y, p: e.pressure || 0.5 });
      }
      redrawPage(d.pageId);
    });
    const finish = () => {
      if (state.dragImg) { state.dragImg = null; scheduleSave(); return; }
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
    canvas.addEventListener('pointercancel', () => { state.drawing = null; state.dragImg = null; redrawPage(pageId); });
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

  async function deletePage(pageId) {
    const nb = notebook(); if (!nb || nb.pages.length <= 1) { toast('A notebook needs at least one page'); return; }
    const pg = nb.pages.find((p) => p.id === pageId);
    if (pg && pg.strokes.length > 0 && !(await modalConfirm('Delete page?', 'This removes the page and its ink.', 'Delete'))) return;
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
      del.onclick = async (e) => {
        e.stopPropagation();
        if (await modalConfirm(`Delete "${nb.name}"?`, 'The notebook and all its pages will be removed.', 'Delete')) {
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
  $('add-notebook').onclick = async () => {
    const name = await modalInput('New notebook', 'Untitled');
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
  $('clear-btn').onclick = async () => {
    const nb = notebook(); if (!nb) return;
    const id = mostVisiblePage();
    const pg = nb.pages.find((p) => p.id === id);
    if (pg && pg.strokes.length > 0 && (await modalConfirm('Clear this page?', 'All strokes on the visible page will be removed.', 'Clear'))) { pg.strokes = []; scheduleSave(); redrawPage(pg.id); }
  };
  $('image-btn').onclick = async () => {
    const nb = notebook(); if (!nb) return;
    const id = mostVisiblePage();
    const pg = nb.pages.find((p) => p.id === id);
    if (!pg) return;
    try {
      const picked = await Backend.pickImage();
      if (!picked) return;
      const dataUrl = `data:${picked.mime};base64,${picked.base64}`;
      const probe = new Image();
      probe.onload = () => {
        const scale = Math.min(1, 720 / probe.naturalWidth);
        const w = Math.round(probe.naturalWidth * scale), h = Math.round(probe.naturalHeight * scale);
        const im = { id: uid(), x: Math.round((PAGE_W - w) / 2), y: 160, w, h, dataUrl };
        pg.images = pg.images || [];
        pg.images.push(im);
        state.selectedImage = im.id;
        scheduleSave(); redrawPage(pg.id);
        toast('Image added — use Select to move it');
      };
      probe.onerror = () => toast('Could not read that image');
      probe.src = dataUrl;
    } catch (err) { toast('Image insert failed: ' + err.message); }
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedImage) {
      if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      const nb = notebook();
      const pg = nb ? nb.pages.find((p) => (p.images || []).some((i) => i.id === state.selectedImage)) : null;
      if (pg) {
        pg.images = pg.images.filter((i) => i.id !== state.selectedImage);
        state.imgCache.delete(state.selectedImage);
        state.selectedImage = null;
        scheduleSave(); redrawPage(pg.id);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'h' || e.key === 'H') {
      if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (!$('editor-view').hidden) setChrome(!document.body.classList.contains('chrome-hidden'));
    } else if (e.key === 'Escape') { setChrome(false); state.selectedImage = null;
    const nb = notebook();
    if (nb && !$('editor-view').hidden) for (const p of nb.pages) redrawPage(p.id);
  }
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

  $('export-btn').onclick = () => Backend.exportLibrary(state.library).catch((e) => toast(e.message));
  $('import-ink-btn').onclick = () => $('ink-file').click();
  $('ink-file').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      try {
        toast(`Reading ${f.name}…`);
        const buf = await f.arrayBuffer();
        const { notebook: nb, pagesWithArt } = await window.InkImport.importInkFile(buf, f.name, uid);
        state.library.notebooks.push(nb);
        scheduleSave(); renderHome($('search').value);
        toast(`Imported "${nb.name}": ${nb.pages.length} pages (${pagesWithArt} with ink)`);
      } catch (err) {
        console.error(err);
        toast(`Could not import ${f.name}: ${err.message}`);
      }
    }
  };
  $('import-btn').onclick = async () => {
    try {
      const text = await Backend.importLibrary();
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
    if (!Backend) {
      $('nb-grid').innerHTML = '<p style="opacity:.6">No backend bridge found. Run with <code>npm start</code>.</p>';
      return;
    }
    state.library = await Backend.loadLibrary();
    for (const nb of state.library.notebooks) {
      if (nb.ruled === undefined) nb.ruled = true;
      nb.pages.forEach((pg, i) => { pg.order = i; pg.width = PAGE_W; pg.height = PAGE_H; pg.images = pg.images || []; });
    }
    renderHome();
  })().catch(console.error);
})();
