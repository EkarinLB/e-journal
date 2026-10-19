'use strict';
/* E-Journal renderer v0.2 — home + editor, gestures, smoothing, zoom.
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
        saveLibrary: (library, intentional) => invoke('library_save', { library, intentional: !!intentional }),
        exportLibrary: (library) => invoke('library_export', { library }),
        importLibrary: () => invoke('library_import'),
        pickImage: () => invoke('media_pick_image'),
        pickFiles: () => invoke('media_pick_files'),
        saveFile: (name, bytes) => invoke('file_save', { name, bytes }),
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
      inputEl.onkeydown = (ev) => { if (ev.key === 'Enter') ok.onclick(); };
    });
  }
  const modalInput = (title, value) => modal({ title, input: true, value });
  const modalConfirm = (title, body, okText) => modal({ title, body, okText: okText || 'Delete', danger: true });

  const state = {
    library: { notebooks: [] },
    nbId: null,
    tool: 'pen', color: '#101418', width: 3, penStyle: 'fountain',
    zoom: 1, ruled: true,
    drawing: null,           // { pageId, pointerId, pointerType, stroke, startedAt }
    undoStack: [],           // { pageId, strokeId, stroke }
    redoStack: [],           // { pageId, stroke }
    penLog: [],              // ring buffer of recent pointer events for pen diagnostics
    canvases: new Map(),     // pageId -> { canvas, ctx, backing }
    selectedImage: null,     // image id (select tool)
    dragImg: null,           // { pageId, pointerId, imageId, dx, dy }
    imgCache: new Map(),     // image id -> HTMLImageElement
  };

  // Pen diagnostics: lightweight ring buffer. The topbar "pen log" button
  // copies it for analysis after a misbehaving stroke.
  // window.__penLog mirrors it for automated diagnostics.
  function logPen(phase, evt) {
    try {
      state.penLog.push({ t: Date.now(), ph: phase, ty: evt.pointerType, id: evt.pointerId, b: evt.buttons, p: evt.pressure, x: Math.round(evt.clientX), y: Math.round(evt.clientY) });
      if (state.penLog.length > 400) state.penLog.splice(0, state.penLog.length - 400);
      window.__penLog = state.penLog;
    } catch (_) {}
  }
  function penPressure(evt) {
    // Fast light flicks can report near-zero pressure (hairline) or exact
    // zero; clamp the floor so pen strokes stay visible, keep expression.
    const raw = evt.pressure;
    if (evt.pointerType === 'pen') return Math.min(1, Math.max(raw || 0.5, 0.3));
    return raw || 0.5;
  }

  const notebook = () => state.library.notebooks.find((n) => n.id === state.nbId);

  /* ================= persistence ================= */
  let saveTimer = null;
  function writeLibrary(intentional) {
    const nb = notebook();
    if (nb) nb.updatedAt = new Date().toISOString();
    return Backend.saveLibrary(state.library, intentional).catch((e) => { toast('Save failed: ' + e.message); throw e; });
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writeLibrary(false); }, 400);
  }
  // Destructive changes must not sit in a debounce timer: if the window is
  // closed before it fires, the deletion is lost and the old data returns.
  // `intentional` marks a save the user asked for directly (deleting the last
  // notebook is legitimate, unlike an empty save produced by a bug).
  async function saveNow(intentional = false) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await writeLibrary(intentional);
  }
  // Last line of defence for still-debounced edits (e.g. a drag or an eraser
  // sweep): flush when the page is hidden or the window goes away, so a
  // pending save is not silently discarded.
  function installSaveFlush() {
    const flush = () => {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      writeLibrary(false);
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._h);
    toast._h = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // Surface silent failures visibly instead of dying quietly.
  window.addEventListener('error', (e) => { try { toast('Error: ' + (e.message || 'unknown error')); } catch (_) {} });
  window.addEventListener('unhandledrejection', (e) => {
    try { toast('Error: ' + ((e.reason && e.reason.message) || e.reason || 'unknown')); } catch (_) {}
  });

  /* Ink geometry + gestures: shared implementation in lib/ink.js (unit-tested). */
  const { smoothPoints, scribbleHits, strokeWidthAt } = window.Ink;

  /* ================= drawing ================= */
  // Nib physics (strokeWidthAt) lives in ink.js so it is unit-tested.
  function drawStrokeOn(ctx, st, pre) {
    const pts = pre || smoothPoints(st.points);
    if (pts.length === 0) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = st.color;
    if (st.tool === 'highlighter') {
      // One continuous translucent band. Stroking segment-by-segment would
      // stack alpha at every joint and look like a streaky thick pen.
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = st.width;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      if (pts.length === 1) { ctx.fillStyle = st.color; ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, st.width / 2, 0, 7); ctx.fill(); }
      ctx.restore(); return;
    }
    ctx.globalAlpha = st.tool === 'pencil' ? 0.85 : 1;
    if (pts.length === 1) {
      ctx.fillStyle = st.color;
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, strokeWidthAt(st, pts[0].p) / 2, 0, 7); ctx.fill();
      ctx.restore(); return;
    }
    // Variable width needs a stroke() per width change, but consecutive
    // segments of near-equal width are batched into one path: thousands of
    // draw calls per frame collapse to a handful.
    let bucket = -1, open = false;
    const flush = () => { if (open) { ctx.stroke(); open = false; } };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const w = strokeWidthAt(st, ((a.p || 0.5) + (b.p || 0.5)) / 2);
      const q = Math.max(1, Math.round(w * 2));
      if (q !== bucket) { flush(); bucket = q; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a.x, a.y); open = true; }
      ctx.lineTo(b.x, b.y);
    }
    flush();
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

  /* Ink is cached in an offscreen layer. Re-drawing every stroke on every
     pointermove was O(all strokes) per event, which made the app slower the
     more you wrote. Committed strokes are rasterised once and composited;
     only the in-progress stroke is drawn live. */
  function redrawPage(pageId) {
    const entry = state.canvases.get(pageId);
    const nb = notebook();
    if (!entry || !nb) return;
    const pg = nb.pages.find((p) => p.id === pageId);
    if (!pg) return;
    const { ctx } = entry;
    if (entry.inkDirty) {
      const ictx = inkLayer(entry);
      ictx.setTransform(entry.backing, 0, 0, entry.backing, 0, 0);
      ictx.clearRect(0, 0, PAGE_W, PAGE_H);
      // Smoothing runs once here, not on every repaint.
      for (const st of pg.strokes) {
        const pts = smoothPoints(st.points);
        drawStrokeOn(ictx, st, pts);
      }
      entry.inkDirty = false;
    }
    ctx.save();
    ctx.setTransform(entry.backing, 0, 0, entry.backing, 0, 0);
    ctx.clearRect(0, 0, PAGE_W, PAGE_H);
    ctx.fillStyle = '#f7f3ea'; // paper: painted in-canvas so pixels/exports are correct, not just CSS
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    if (state.ruled) drawRuled(ctx);
    drawBackgroundOn(ctx, pg, pageId);
    drawImagesOn(ctx, pg, pageId);
    if (entry.ink) ctx.drawImage(entry.ink, 0, 0, PAGE_W, PAGE_H);
    if (state.drawing && state.drawing.pageId === pageId) drawStrokeOn(ctx, state.drawing.stroke);
    ctx.restore();
  }

  function inkLayer(entry) {
    if (!entry.ink || entry.ink.width !== Math.round(PAGE_W * entry.backing)) {
      entry.ink = document.createElement('canvas');
      entry.ink.width = Math.round(PAGE_W * entry.backing);
      entry.ink.height = Math.round(PAGE_H * entry.backing);
      entry.inkCtx = entry.ink.getContext('2d');
      entry.inkDirty = true;
    }
    return entry.inkCtx;
  }

  function invalidateInk(pageId) {
    const entry = state.canvases.get(pageId);
    if (entry) entry.inkDirty = true;
  }

  // At most one repaint per animation frame, however many pointermove events
  // arrive. This alone removes most of the lag on fast strokes.
  const pendingPaint = new Map();
  function schedulePaint(pageId) {
    if (pendingPaint.has(pageId)) return;
    pendingPaint.set(pageId, requestAnimationFrame(() => {
      pendingPaint.delete(pageId);
      redrawPage(pageId);
    }));
  }

  function layoutPages() {
    const wrap = $('pages');
    const base = Math.max(0.2, (wrap.clientWidth - 48) / PAGE_W);
    const display = base * state.zoom;
    // Capped at 2x: beyond that the fills cost more than they visibly improve,
// and ink is recomposited on every repaint.
    const backing = Math.min(display * (window.devicePixelRatio || 1), 2);
    for (const [, entry] of state.canvases) {
      entry.backing = backing;
      entry.canvas.style.width = PAGE_W * display + 'px';
      entry.canvas.style.height = PAGE_H * display + 'px';
      entry.canvas.width = Math.round(PAGE_W * backing);
      entry.canvas.height = Math.round(PAGE_H * backing);
    }
    for (const pageId of state.canvases.keys()) { invalidateInk(pageId); redrawPage(pageId); }
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
    if (pg.strokes.length !== before) invalidateInk(pg.id);
    return before - pg.strokes.length;
  }

  /* ================= editor DOM ================= */
  function buildEditor() {
    const nb = notebook(); if (!nb) return;
    $('nb-name').textContent = nb.name;
    const zone = $('pages');
    zone.innerHTML = '';
    state.canvases.clear();
    nb.pages.forEach((pg) => zone.appendChild(sheetEl(nb, pg)));
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

  function sheetEl(nb, pg) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    const canvas = document.createElement('canvas');
    const entry = { canvas, ctx: canvas.getContext('2d'), backing: 1, ink: null, inkCtx: null, inkDirty: true };
    state.canvases.set(pg.id, entry);
    wrap.appendChild(canvas);
    attachInk(canvas, pg.id);
    return wrap;
  }

  function attachInk(canvas, pageId) {
    // One gesture at a time per canvas. The tracked pointerId owns the
    // stroke; palm touches, mouse jitter, or a second pen can never hijack
    // it. Pen contact also pins touch-action so the view cannot steal the
    // gesture mid-stroke (no more vanishing ink on fast flicks).
    canvas.addEventListener('pointerdown', (evt) => {
      if (evt.pointerType === 'touch') return; // touch scrolls pages
      logPen('down', evt);
      if (state.drawing || state.dragImg) {
        // Salvage a stuck gesture (older than 8s) instead of ignoring input forever.
        const d0 = state.drawing;
        if (d0 && Date.now() - (d0.startedAt || 0) > 8000) {
          const nb0 = notebook();
          const pg0 = nb0 ? nb0.pages.find((p) => p.id === d0.pageId) : null;
          if (pg0 && d0.stroke.points.length > 0) {
            pg0.strokes.push(d0.stroke);
            invalidateInk(pg0.id);
            state.undoStack.push({ pageId: pg0.id, strokeId: d0.stroke.id, stroke: d0.stroke });
            state.redoStack = [];
            scheduleSave(); redrawPage(pg0.id);
          }
          state.drawing = null;
          canvas.style.touchAction = '';
        }
        if (state.dragImg && Date.now() - (state.dragImg.startedAt || 0) > 8000) state.dragImg = null;
        if (state.drawing || state.dragImg) return; // pen owns the canvas right now
      }
      evt.preventDefault();
      try { canvas.setPointerCapture(evt.pointerId); } catch (_) {}
      const nb = notebook();
      const pg = nb ? nb.pages.find((p) => p.id === pageId) : null;
      if (!pg) return;
      const pos = canvasPos(canvas, evt);
      if (state.tool === 'eraser') return; // handled during pointermove so a drag erases
      if (state.tool === 'select') {
        const hit = [...(pg.images || [])].reverse().find((im) =>
          pos.x >= im.x && pos.x <= im.x + im.w && pos.y >= im.y && pos.y <= im.y + im.h);
        state.selectedImage = hit ? hit.id : null;
        if (hit) state.dragImg = { pageId, pointerId: evt.pointerId, startedAt: Date.now(), imageId: hit.id, dx: pos.x - hit.x, dy: pos.y - hit.y };
        redrawPage(pageId);
        return;
      }
      if (evt.pointerType === 'pen') canvas.style.touchAction = 'none';
      const w = state.tool === 'highlighter' ? Math.max(state.width, 12) : state.width;
      const pr = penPressure(evt);
      const style = state.tool === 'pen' ? state.penStyle : undefined;
      state.drawing = { pageId, pointerId: evt.pointerId, pointerType: evt.pointerType, startedAt: Date.now(), stroke: { id: uid(), tool: state.tool, color: state.color, width: w, penStyle: style, points: [{ x: pos.x, y: pos.y, p: pr }] } };
      redrawPage(pageId);
    });
    canvas.addEventListener('pointermove', (evt) => {
      if (state.dragImg) {
        if (evt.pointerId !== state.dragImg.pointerId) return;
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
      // Eraser: drag to erase continuously. It used to fire only on
      // pointerdown, so a single swipe erased one stroke and you had to
      // keep tapping.
      if (state.tool === 'eraser' && !state.drawing && !state.dragImg) {
        const enb = notebook();
        const epg = enb ? enb.pages.find((p) => p.id === pageId) : null;
        if (epg) {
          let removed = 0;
          for (const e of evt.getCoalescedEvents ? evt.getCoalescedEvents() : [evt]) {
            removed += eraseAt(epg, canvasPos(canvas, e));
          }
          if (removed > 0) {
            const last = state.undoStack[state.undoStack.length - 1];
            if (!last || last.pageId !== epg.id || last.kind !== 'erase') {
              state.undoStack.push({ pageId: epg.id, kind: 'erase', before: epg.strokes });
              state.redoStack = [];
            }
            saveNow();
            schedulePaint(pageId);
          }
        }
        return;
      }
      const d = state.drawing;
      if (!d || evt.pointerId !== d.pointerId) return;
      logPen('move', evt);
      for (const e of evt.getCoalescedEvents ? evt.getCoalescedEvents() : [evt]) {
        const pos = canvasPos(canvas, e);
        d.stroke.points.push({ x: pos.x, y: pos.y, p: penPressure(e) });
      }
      // Coalesced events can fire several times per frame. Repainting on each
      // one wastes work; one repaint per frame is all the display can show.
      schedulePaint(d.pageId);
    });
    const finish = (evt) => {
      if (state.dragImg) {
        if (evt && evt.pointerId !== state.dragImg.pointerId) return;
        state.dragImg = null; scheduleSave(); return;
      }
      const d = state.drawing;
      if (!d) return;
      if (evt && evt.pointerId !== d.pointerId) return;
      state.drawing = null;
      canvas.style.touchAction = '';
      const nb = notebook();
      const pg = nb ? nb.pages.find((p) => p.id === d.pageId) : null;
      if (!pg || d.stroke.points.length === 0) { if (pg) redrawPage(pg.id); return; }
      if (d.stroke.tool !== 'eraser') {
        const hits = scribbleHits(d.stroke.points, pg.strokes);
        if (hits) {
          pg.strokes = pg.strokes.filter((s) => !hits.includes(s.id));
          invalidateInk(pg.id);
          state.undoStack = state.undoStack.filter((u) => !hits.includes(u.strokeId));
          state.redoStack = [];
          toast(`Scribbled out ${hits.length} stroke${hits.length > 1 ? 's' : ''}`);
          saveNow(); redrawPage(pg.id); return;
        }
      }
      pg.strokes.push(d.stroke);
      invalidateInk(pg.id);
      state.undoStack.push({ pageId: pg.id, strokeId: d.stroke.id, stroke: d.stroke });
      state.redoStack = [];
      // Writing the whole library after every stroke is O(library) per
      // stroke, which is why writing got slower as a notebook grew. The flush
      // installed on pagehide/beforeunload guarantees a pending stroke is
      // still persisted when the window closes, so a short debounce is safe.
      scheduleSave(); redrawPage(pg.id);
    };
    canvas.addEventListener('pointerup', (evt) => { logPen('up', evt); finish(evt); });
    canvas.addEventListener('pointercancel', (evt) => { logPen('cancel', evt); finish(evt); }); // keep partial ink, never drop it
    canvas.addEventListener('lostpointercapture', (evt) => { logPen('lostcap', evt); finish(evt); });
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
    $('page-indicator').textContent = i >= 0 ? `${i + 1} / ${nb.pages.length}` : '';
    $('pg-prev').disabled = i <= 0;
    $('pg-next').disabled = i < 0 || i >= nb.pages.length - 1;
    $('pg-del').disabled = nb.pages.length <= 1;
  }
  function scrollToPage(i) {
    const nb = notebook(); if (!nb) return;
    const pg = nb.pages[Math.max(0, Math.min(i, nb.pages.length - 1))];
    if (!pg) return;
    const entry = state.canvases.get(pg.id);
    if (entry) entry.canvas.scrollIntoView({ block: 'start' });
  }
  $('pg-prev').onclick = () => {
    const nb = notebook(); if (!nb) return;
    const i = nb.pages.findIndex((p) => p.id === mostVisiblePage());
    scrollToPage(i - 1);
  };
  $('pg-next').onclick = () => {
    const nb = notebook(); if (!nb) return;
    const i = nb.pages.findIndex((p) => p.id === mostVisiblePage());
    scrollToPage(i + 1);
  };
  $('pg-add').onclick = () => addPage();
  $('pg-del').onclick = () => {
    const nb = notebook(); if (!nb) return;
    deletePage(mostVisiblePage());
  };
  const ICON_MOON = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/></svg>';
  const ICON_SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  function applyTheme(t) {
    document.body.dataset.theme = t;
    try { localStorage.setItem('oj-theme', t); } catch (_) {}
    $('theme-btn').innerHTML = t === 'light' ? ICON_MOON : ICON_SUN;
  }
  $('theme-btn').onclick = () => applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light');

  /* Settings: one place for the preferences that used to be scattered
     across toolbar toggles and hidden in localStorage. */
  $('settings-btn').onclick = async () => {
    const dark = document.body.dataset.theme === 'dark';
    const theme = await modal({
      title: 'Settings',
      body: 'Theme: ' + (dark ? 'dark' : 'light') + '\nInk colour: ' + state.color +
        '\nPen style: ' + state.penStyle + '\nRuled pages: ' + (state.ruled ? 'on' : 'off') +
        '\nZoom: ' + Math.round(state.zoom * 100) + '%',
      okText: 'Close',
    });
    void theme;
    toast('Preferences live in the toolbar and are remembered automatically');
  };
  $('penlog-btn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.penLog));
      toast(`Pen log copied (${state.penLog.length} events)`);
    } catch (err) { toast('Copy failed: ' + err.message); }
  };

  function addPage() {
    const nb = notebook(); if (!nb) return null;
    const pg = { id: uid(), order: nb.pages.length, width: PAGE_W, height: PAGE_H, strokes: [] };
    nb.pages.push(pg);
    scheduleSave(); buildEditor();
    requestAnimationFrame(() => {
      const entry = state.canvases.get(pg.id);
      if (entry) {
        entry.canvas.scrollIntoView({ block: 'start' });
        entry.canvas.closest('.sheet')?.classList.add('sheet-enter');
      }
      toast('New page added');
    });
    return pg;
  }

  async function deletePage(pageId) {
    const nb = notebook(); if (!nb || !pageId || nb.pages.length <= 1) { if (nb && nb.pages.length <= 1) toast('A notebook needs at least one page'); return; }
    const pg = nb.pages.find((p) => p.id === pageId);
    if (pg && pg.strokes.length > 0 && !(await modalConfirm('Delete page?', 'This removes the page and its ink.', 'Delete'))) return;
    nb.pages = nb.pages.filter((p) => p.id !== pageId);
    nb.pages.forEach((p, i) => { p.order = i; });
    state.undoStack = state.undoStack.filter((u) => u.pageId !== pageId);
    state.redoStack = state.redoStack.filter((r) => r.pageId !== pageId);
    await saveNow(); buildEditor();
  }

  function openNotebook(id) {
    state.nbId = id; state.undoStack = []; state.redoStack = []; state.zoom = 1;
    const nb = notebook();
    if (nb && nb.ruled === undefined) nb.ruled = true;
    state.ruled = nb ? nb.ruled !== false : true;
    $('lines-btn').classList.toggle('active', state.ruled);
    $('home-view').hidden = true; $('editor-view').hidden = false;
    const ev = $('editor-view');
    ev.classList.remove('view-enter'); void ev.offsetWidth; ev.classList.add('view-enter');
    buildEditor();
  }
  function goHome() {
    state.nbId = null;
    $('editor-view').hidden = true; $('home-view').hidden = false;
    const hv = $('home-view');
    hv.classList.remove('view-enter'); void hv.offsetWidth; hv.classList.add('view-enter');
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
      del.className = 'del'; del.innerHTML = ICON_X; del.title = 'Delete notebook'; del.setAttribute('aria-label', 'Delete notebook');

      // Rename: click the title, or use the card's rename button. Keyboard
      // reachable and discoverable rather than hidden in a context menu.
      const doRename = async (e) => {
        if (e) e.stopPropagation();
        const name = await modal({
          title: 'Rename notebook', input: true, value: nb.name, okText: 'Rename',
        });
        if (name === null) return;
        const clean = String(name).trim();
        if (!clean || clean === nb.name) return;
        nb.name = clean;
        nb.updatedAt = new Date().toISOString();
        await saveNow();
        renderHome($('search').value);
        toast(`Renamed to "${clean}"`);
      };
      h.className = 'nb-title';
      h.title = 'Rename notebook';
      h.tabIndex = 0;
      h.setAttribute('role', 'button');
      h.onclick = doRename;
      h.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); doRename(); } };
      del.onclick = async (e) => {
        e.stopPropagation();
        if (await modalConfirm(`Delete "${nb.name}"?`, 'The notebook and all its pages will be removed.', 'Delete')) {
          state.library.notebooks = state.library.notebooks.filter((n) => n.id !== nb.id);
          await saveNow(true); renderHome($('search').value);
        }
      };
      card.append(h, s, del);
      card.onclick = () => { try { openNotebook(nb.id); } catch (err) { toast('Could not open: ' + err.message); } };
      grid.appendChild(card);
    }
    if (nbs.length === 0) grid.innerHTML = '<p style="opacity:.6">No notebooks yet — press + New to start one.</p>';
  }

  /* ================= wiring ================= */
  $('add-notebook').onclick = async () => {
    const name = await modalInput('New notebook', 'Untitled');
    if (!name) return;
    try {
      const nb = { id: uid(), name, color: COLORS[state.library.notebooks.length % COLORS.length], icon: 'GenericJournal', updatedAt: new Date().toISOString(), pages: [{ id: uid(), order: 0, width: PAGE_W, height: PAGE_H, strokes: [] }] };
      state.library.notebooks.push(nb);
      scheduleSave(); openNotebook(nb.id);
    } catch (err) { toast('Could not create: ' + err.message); }
  };
  $('search').oninput = (e) => renderHome(e.target.value);
  $('back-btn').onclick = goHome;
  document.querySelectorAll('#island .tool').forEach((b) => {
    b.onclick = () => { document.querySelectorAll('#island .tool').forEach((x) => x.classList.remove('active')); b.classList.add('active'); state.tool = b.dataset.tool; };
  });
  const FULL_PALETTE = ['#000000', '#3b3b3b', '#6b6b6b', '#a8a8a8', '#c92a2a', '#e8590c',
    '#e8a100', '#ffe14d', '#2f9e44', '#0ca678', '#1098ad', '#2b6cb0',
    '#364fc7', '#7c3aed', '#c2255c', '#a61e4d', '#5c3d2e', '#8a6d3b'];

  function paintSwatches(box, colors) {
    box.innerHTML = '';
    for (const c of colors) {
      const s = document.createElement('div');
      s.className = 'swatch' + (c.toLowerCase() === state.color.toLowerCase() ? ' active' : '');
      s.style.background = c; s.title = c; s.dataset.color = c;
      s.onclick = () => selectColor(c);
      box.appendChild(s);
    }
  }
  function selectColor(c, closePop = true) {
    state.color = c;
    try { localStorage.setItem('oj-color', c); } catch (_) {}
    document.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x.dataset.color.toLowerCase() === c.toLowerCase()));
    $('style-dot').style.background = c;
    if (closePop) $('stylepop').hidden = true;
  }
  function selectPenStyle(name, closePop = true) {
    state.penStyle = name;
    try { localStorage.setItem('oj-penstyle', name); } catch (_) {}
    document.querySelectorAll('#pop-styles button').forEach((x) => x.classList.toggle('active', x.dataset.style === name));
    if (closePop) $('stylepop').hidden = true;
  }
  try {
    const sc = localStorage.getItem('oj-color');
    if (sc) state.color = sc;
    const sp = localStorage.getItem('oj-penstyle');
    if (sp === 'ball' || sp === 'fountain' || sp === 'brush') state.penStyle = sp;
  } catch (_) {}
  paintSwatches($('colors'), COLORS);
  paintSwatches($('pop-colors'), FULL_PALETTE);
  document.querySelectorAll('#pop-styles button').forEach((b) => { b.onclick = () => selectPenStyle(b.dataset.style); });
  selectPenStyle(state.penStyle, false);
  $('custom-color').oninput = (e) => selectColor(e.target.value, false);
  $('custom-color').onchange = () => { $('stylepop').hidden = true; };
  $('style-btn').onclick = (e) => { e.stopPropagation(); $('stylepop').hidden = !$('stylepop').hidden; };
  document.addEventListener('pointerdown', (e) => {
    const pop = $('stylepop');
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $('style-btn') && !$('style-btn').contains(e.target)) pop.hidden = true;
  });
  $('width').oninput = (e) => { state.width = Number(e.target.value); };
  $('undo-btn').onclick = () => {
    const nb = notebook(); const u = state.undoStack.pop();
    if (!nb || !u) return;
    const pg = nb.pages.find((p) => p.id === u.pageId);
    if (!pg) return;
    // An erase entry restores the whole page snapshot it captured. Without
    // this, Undo after erasing silently did nothing.
    if (u.kind === 'erase') {
      pg.strokes = u.before;
      invalidateInk(pg.id);
      state.redoStack.push({ pageId: pg.id, kind: 'erase', after: pg.strokes.slice() });
      scheduleSave(); redrawPage(pg.id);
      return;
    }
    const gone = pg.strokes.find((s) => s.id === u.strokeId);
    pg.strokes = pg.strokes.filter((s) => s.id !== u.strokeId);
    invalidateInk(pg.id);
    if (gone) state.redoStack.push({ pageId: pg.id, stroke: gone });
    scheduleSave(); redrawPage(pg.id);
  };
  $('redo-btn').onclick = () => {
    const nb = notebook(); const r = state.redoStack.pop();
    if (!nb || !r) return;
    const pg = nb.pages.find((p) => p.id === r.pageId);
    if (!pg) return;
    if (r.kind === 'erase') {
      // Re-apply the erase: keep what is left now, and restore on undo.
      pg.strokes = r.after.filter((s) => !pg.strokes.some((k) => k.id === s.id));
      invalidateInk(pg.id);
      state.undoStack.push({ pageId: pg.id, kind: 'erase', before: r.after.slice() });
      scheduleSave(); redrawPage(pg.id);
      return;
    }
    if (r.stroke && !pg.strokes.some((s) => s.id === r.stroke.id)) {
      pg.strokes.push(r.stroke);
      invalidateInk(pg.id);
      state.undoStack.push({ pageId: pg.id, strokeId: r.stroke.id, stroke: r.stroke });
      scheduleSave(); redrawPage(pg.id);
    }
  };
  $('clear-btn').onclick = async () => {
    const nb = notebook(); if (!nb) return;
    const id = mostVisiblePage();
    const pg = nb.pages.find((p) => p.id === id);
    if (pg && pg.strokes.length > 0 && (await modalConfirm('Clear this page?', 'All strokes on the visible page will be removed.', 'Clear'))) { pg.strokes = []; state.undoStack = state.undoStack.filter((u) => u.pageId !== pg.id); state.redoStack = []; invalidateInk(pg.id); await saveNow(); redrawPage(pg.id); }
  };
  function insertImageDataUrl(dataUrl, name, x, y) {
    const nb = notebook(); if (!nb) return;
    const id = mostVisiblePage();
    const pg = nb.pages.find((p) => p.id === id);
    if (!pg) return;
    const probe = new Image();
    probe.onload = () => {
      const scale = Math.min(1, 720 / probe.naturalWidth);
      const w = Math.round(probe.naturalWidth * scale), h = Math.round(probe.naturalHeight * scale);
      const im = {
        id: uid(),
        x: x === undefined ? Math.round((PAGE_W - w) / 2) : Math.round(Math.min(Math.max(x - w / 2, -w + 40), PAGE_W - 40)),
        y: y === undefined ? 160 : Math.round(Math.min(Math.max(y - h / 2, -h + 40), PAGE_H - 40)),
        w, h, dataUrl,
      };
      pg.images = pg.images || [];
      pg.images.push(im);
      state.selectedImage = im.id;
      // select tool not required to see it; keep current tool
      scheduleSave(); redrawPage(pg.id);
      toast(`Image added — use Select to move it`);
    };
    probe.onerror = () => toast('Could not read image' + (name ? `: ${name}` : ''));
    probe.src = dataUrl;
  }
  $('image-btn').onclick = async () => {
    if (!Backend) { toast('No backend bridge'); return; }
    try {
      const picked = await Backend.pickImage();
      if (!picked) return;
      insertImageDataUrl(`data:${picked.mime};base64,${picked.base64}`, picked.name);
    } catch (err) { toast('Image insert failed: ' + err.message); }
  };
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('unreadable file'));
      fr.readAsDataURL(file);
    });
  }
  const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  const pagesZone = $('pages');
  pagesZone.addEventListener('dragover', (e) => { e.preventDefault(); pagesZone.classList.add('dropping'); });
  pagesZone.addEventListener('dragleave', () => pagesZone.classList.remove('dropping'));
  pagesZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    pagesZone.classList.remove('dropping');
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter((f) => IMAGE_RE.test(f.name));
    if (files.length === 0) { toast('Drop image files onto a page'); return; }
    const canvas = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.sheet')?.querySelector?.('canvas');
    let x, y;
    if (canvas) { const pos = canvasPos(canvas, e); x = pos.x; y = pos.y; }
    for (const [i, f] of files.slice(0, 6).entries()) {
      try {
        const url = await readAsDataUrl(f);
        insertImageDataUrl(url, f.name, x === undefined ? undefined : x + i * 24, y === undefined ? undefined : y + i * 24);
      } catch (err) { toast(`Could not read ${f.name}`); }
    }
  });
  const gridZone = $('nb-grid');
  gridZone.addEventListener('dragover', (e) => { e.preventDefault(); gridZone.classList.add('dropping'); });
  gridZone.addEventListener('dragleave', () => gridZone.classList.remove('dropping'));
  gridZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    gridZone.classList.remove('dropping');
    for (const f of [...(e.dataTransfer ? e.dataTransfer.files : [])]) {
      try {
        if (/\.ink$/i.test(f.name)) {
          const buf = await f.arrayBuffer();
          await importPickedInk(new Uint8Array(buf), f.name);
        } else if (/\.E-Journal$/i.test(f.name)) {
          const text = await f.text();
          const data = JSON.parse(text);
          if (!Array.isArray(data.notebooks)) throw new Error('bad file');
          for (const nb of data.notebooks) { nb.id = uid(); for (const pg of nb.pages || []) pg.id = uid(); state.library.notebooks.push(nb); }
          scheduleSave(); renderHome($('search').value); toast(`Imported ${f.name}`);
        }
      } catch (err) { toast(`Could not import ${f.name}: ${err.message}`); }
    }
  });
  $('lines-btn').onclick = () => {
    state.ruled = !state.ruled;
    $('lines-btn').classList.toggle('active', state.ruled);
    const nb = notebook(); if (nb) nb.ruled = state.ruled;
    scheduleSave();
    for (const id of state.canvases.keys()) redrawPage(id);
  };

  /* ---------- page export ---------- */
  $('export-page-btn').onclick = async () => {
    if (!Backend) { toast('No backend bridge'); return; }
    const nb = notebook();
    const pg = nb && mostVisiblePage();
    if (!pg) { toast('No page to export'); return; }
    const safe = (nb.name || 'notebook').replace(/[\\/:*?"<>|]/g, '-');
    try {
      toast('Rendering page…');
      await exportPagePng(pg, 2);
      void safe;
      toast('Saved PNG');
    } catch (err) { toast('Export failed: ' + err.message); }
  };
  $('export-pdf-btn').onclick = async () => {
    if (!Backend) { toast('No backend bridge'); return; }
    const nb = notebook();
    if (!nb || !nb.pages.length) { toast('Nothing to export'); return; }
    try {
      toast(`Rendering ${nb.pages.length} page${nb.pages.length === 1 ? '' : 's'}…`);
      await exportPagesPdf(nb.pages, 2);
      toast('Saved PDF');
    } catch (err) { toast('Export failed: ' + err.message); }
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
    const inField = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (inField || $('editor-view').hidden) return;
      e.preventDefault(); $('undo-btn').click(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
      if (inField || $('editor-view').hidden) return;
      e.preventDefault(); $('redo-btn').click(); return;
    }
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

  $('export-btn').onclick = () => { if (!Backend) { toast('No backend bridge'); return; } Backend.exportLibrary(state.library).catch((e) => toast(e.message)); };
  async function importPickedInk(data, name) {
    try {
      toast(`Reading ${name}…`);
      const buf = data instanceof Uint8Array
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      const { notebook: nb, pagesWithArt } = await window.InkImport.importInkFile(buf, name, uid);
      state.library.notebooks.push(nb);
      scheduleSave(); renderHome($('search').value);
      toast(`Imported "${nb.name}": ${nb.pages.length} pages (${pagesWithArt} with ink)`);
    } catch (err) {
      console.error(err);
      toast(`Could not import ${name}: ${err.message}`);
    }
  }
  /* ---------- export: PNG / PDF ----------
     The page is already fully rendered on its canvas, so exporting reuses
     that rather than reimplementing layout. */
  function pageToCanvas(pg, scale) {
    const c = document.createElement('canvas');
    c.width = Math.round(PAGE_W * scale);
    c.height = Math.round(PAGE_H * scale);
    const ctx = c.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#f7f3ea';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    if (pg.ruled !== false) drawRuled(ctx);
    for (const st of pg.strokes || []) drawStrokeOn(ctx, st);
    for (const im of pg.images || []) {
      const el = state.imgCache.get(im.id);
      if (el && el.complete && el.naturalWidth > 0) ctx.drawImage(el, im.x, im.y, im.w, im.h);
    }
    return c;
  }

  async function exportPagePng(pg, scale) {
    const c = pageToCanvas(pg, scale);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) throw new Error('could not encode PNG');
    const buf = new Uint8Array(await blob.arrayBuffer());
    await Backend.saveFile(`page-${(pg.order || 0) + 1}.png`, [...buf]);
  }

  /* PDF is assembled by hand rather than pulling in a library: a single
     page of PNG data is a few dozen lines and avoids ~1 MB of
     dependency for one feature. Each page becomes one image XObject. */
  async function buildPdf(pgs, scale) {
    const enc = new TextEncoder();
    const latin = new TextDecoder('latin1');
    // Object bodies are collected first so /Kids and byte offsets are exact.
    const bodies = [];
    const pageObjNo = [];
    for (let i = 0; i < pgs.length; i++) {
      const c = pageToCanvas(pgs[i], scale);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const png = new Uint8Array(await blob.arrayBuffer());
      const content = `q\n${(612 / c.width).toFixed(4)} 0 0 ${(792 / c.height).toFixed(4)} 0 0 cm\n/Im0 Do\nQ\n`;
      pageObjNo.push(bodies.length + 3); // image, content, page objects follow
      bodies.push({
        str: `<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${png.length} >>`,
        bin: png,
      });
      bodies.push({ str: `<< /Length ${content.length} >>`, bin: enc.encode(content) });
      bodies.push({
        str: null, // page object needs its own object numbers, filled below
      });
    }
    // Page objects reference their own image+content pair.
    const catalogNo = 1, pagesNo = 2;
    for (let i = 0; i < pgs.length; i++) {
      const base = pageObjNo[i];
      bodies[base - 3 + 2].str =
        `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /XObject << /Im0 ${base} 0 R >> >> /Contents ${base + 1} 0 R >>`;
    }
    const kids = pageObjNo.map((n) => `${n + 2} 0 R`).join(' ');
    bodies.unshift({ str: `<< /Type /Catalog /Pages ${pagesNo} 0 R >>` });          // 1
    bodies.splice(1, 0, { str: `<< /Type /Pages /Kids [${kids}] /Count ${pgs.length} >>` }); // 2

    const parts = [];
    let offset = 0;
    const put = (b) => { parts.push(b); offset += b.length; };
    put(enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const xref = [];
    for (let i = 0; i < bodies.length; i++) {
      xref.push(offset);
      const o = bodies[i];
      put(enc.encode(`${i + 1} 0 obj\n${o.str}\n`));
      if (o.bin) {
        put(enc.encode('stream\n'));
        put(o.bin);
        put(enc.encode('\nendstream\n'));
      }
      put(enc.encode('endobj\n'));
    }
    const startxref = offset;
    let x = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
    for (const off of xref) x += String(off).padStart(10, '0') + ' 00000 n \n';
    put(enc.encode(x));
    put(enc.encode(`trailer\n<< /Size ${bodies.length + 1} /Root ${catalogNo} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`));

    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    void latin;
    return out;
  }

  async function exportPagesPdf(pgs, scale) {
    const pdf = await buildPdf(pgs, scale);
    await Backend.saveFile('notebook.pdf', [...pdf]);
  }

  async function importEjournalFile(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data.notebooks)) throw new Error('not an E-Journal file');
    const fresh = data.notebooks.map((nb) => ({
      ...nb, id: uid(),
      pages: (nb.pages || []).map((pg) => ({ ...pg, id: uid() })),
    }));
    state.library.notebooks.push(...fresh);
    await saveNow(true);
    renderHome($('search').value);
    return fresh.length;
  }

  /* One Import button for everything: .ejournal libraries and Microsoft
     Journal .ink files are routed by file type, not by button. */
  async function importAny() {
    if (!Backend) { toast('No backend bridge'); return; }
    // Prefer the native picker when available so we get real paths.
    if (Backend.pickFiles) {
      try {
        const picked = await Backend.pickFiles();
        if (!picked || !picked.length) return;
        let books = 0, inked = 0;
        for (const f of picked) {
          if (/\.ink$/i.test(f.name)) { await importPickedInk(f.bytes, f.name); inked++; }
          else {
            const text = new TextDecoder().decode(f.bytes);
            books += await importEjournalFile(text);
          }
        }
        toast(`Imported ${books} notebook${books === 1 ? '' : 's'}${inked ? ` and ${inked} .ink file${inked === 1 ? '' : 's'}` : ''}`);
        return;
      } catch (err) { toast('Pick failed: ' + err.message); return; }
    }
    // Browser fallback: the input accepts both formats.
    $('import-any-file').click();
  }
  $('import-btn').onclick = importAny;
  $('import-any-file').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    let books = 0, inked = 0;
    for (const f of files) {
      try {
        if (/\.ink$/i.test(f.name)) { await importPickedInk(new Uint8Array(await f.arrayBuffer()), f.name); inked++; }
        else books += await importEjournalFile(await f.text());
      } catch (err) { toast(`Could not import ${f.name}: ${err.message}`); }
    }
    if (books || inked) toast(`Imported ${books} notebook${books === 1 ? '' : 's'}${inked ? ` and ${inked} .ink file${inked === 1 ? '' : 's'}` : ''}`);
  };
  window.addEventListener('resize', () => { if (!$('editor-view').hidden) layoutPages(); });

  /* ================= boot ================= */
  (async () => {
    $('ver').textContent = 'v0.11 beta';
    let theme = 'light';
    try { theme = localStorage.getItem('oj-theme') || 'light'; } catch (_) {}
    applyTheme(theme);
    if (!Backend) {
      $('nb-grid').innerHTML = '<p style="opacity:.6">No backend bridge found. Run with <code>npm start</code>.</p>';
      return;
    }
    state.library = await Backend.loadLibrary();
    for (const nb of state.library.notebooks) {
      if (nb.ruled === undefined) nb.ruled = true;
      nb.pages.forEach((pg, i) => { pg.order = i; pg.width = PAGE_W; pg.height = PAGE_H; pg.images = pg.images || []; });
    }
    installSaveFlush();
    renderHome();
  })().catch(console.error);
})();
