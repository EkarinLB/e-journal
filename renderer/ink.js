'use strict';
// Pure ink geometry: smoothing + scribble-gesture detection.
// Runs in Node (module.exports) and in the browser (window.Ink).
(function (root) {
  function strokeLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return L;
  }
  function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0, y0, x1, y1 };
  }
  function boxesOverlap(a, b) { return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0; }
  function segInt(a, b, c, d) {
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (den === 0) return false;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }
  function downsample(pts, max) {
    if (pts.length <= max) return pts;
    const step = pts.length / max, out = [];
    for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
  }

  // Chaikin corner-cutting, 2 passes. Non-destructive: input untouched.
  function smoothPoints(points) {
    let pts = points;
    for (let k = 0; k < 2; k++) {
      if (pts.length < 3) break;
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const ap = a.p === undefined ? 0.5 : a.p, bp = b.p === undefined ? 0.5 : b.p;
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, p: ap * 0.75 + bp * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, p: ap * 0.25 + bp * 0.75 });
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  // Returns array of hit stroke ids when `gesture` is a genuine
  // scratch-out (rapid zigzag over existing strokes), else null.
  // Loops, circles, wavy underlines, and cursive words must NEVER match:
  // only repeated direction reversals count, and only with intersections.
  function scribbleHits(gesture, strokes) {
    if (!gesture || gesture.length < 4 || !strokes || strokes.length === 0) return null;
    const g = downsample(gesture, 160);
    const gb = bbox(g);
    const candidates = strokes.filter((st) => st.points && st.points.length > 0 && boxesOverlap(gb, bbox(st.points)));
    if (candidates.length === 0) return null;
    const hit = new Set();
    for (let i = 1; i < g.length; i++) {
      for (const st of candidates) {
        if (hit.has(st.id)) continue;
        const sp = downsample(st.points, 120);
        for (let j = 1; j < sp.length; j++) {
          if (segInt(g[i - 1], g[i], sp[j - 1], sp[j])) { hit.add(st.id); break; }
        }
      }
    }
    if (hit.size === 0) return null;
    // Direction reversals: a true scratch-out zigzags hard. A circle
    // reverses ~4 times total and cursive drift stays low; demand 6+.
    let reversals = 0, px = 0, py = 0;
    for (let i = 1; i < g.length; i++) {
      const dx = Math.sign(g[i].x - g[i - 1].x), dy = Math.sign(g[i].y - g[i - 1].y);
      if (dx !== 0 && px !== 0 && dx !== px) reversals++;
      if (dy !== 0 && py !== 0 && dy !== py) reversals++;
      if (dx !== 0) px = dx;
      if (dy !== 0) py = dy;
    }
    if (reversals >= 6) return [...hit];
    return null;
  }

  // Pen nib physics per style. Legacy strokes (no penStyle) keep the
  // original width*pressure mapping so old notes never change looks.
  // The ranges are deliberately wide: at the default width of 3 the original
  // multipliers differed by less than a fifth of a pixel, which made the
  // styles indistinguishable in real use.
  function strokeWidthAt(st, p) {
    const w = st.width, q = p === undefined ? 0.5 : p;
    switch (st.penStyle || (st.tool === 'pencil' ? 'pencil' : 'legacy')) {
      case 'ball': return w * 1.25;                             // uniform, broad
      case 'brush': return Math.max(0.4, w * (0.25 + 2.6 * q)); // dramatic taper
      case 'fountain': return Math.max(0.35, w * (0.3 + 1.05 * q)); // thin, delicate
      case 'pencil': return Math.max(0.5, w * q);
      case 'legacy':
      default: return Math.max(0.5, w * q);
    }
  }

  const api = { strokeLength, bbox, boxesOverlap, segInt, downsample, smoothPoints, scribbleHits, strokeWidthAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ink = api;
})(typeof self !== 'undefined' ? self : globalThis);
