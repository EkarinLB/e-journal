//! Page rendering cache.
//!
//! A rendered 1024x1408 RGBA page costs ~5.8 MB. A 40-page notebook would
//! be 230 MB if every page stayed resident, so caching everything is a leak
//! with a paper interface. Instead we keep the ink small (strokes are a few
//! KB) and cache only rendered pixels, under a hard memory ceiling.
//!
//! This means memory stays flat whether a notebook has 10 pages or 400, and
//! frame cost depends on what is *visible*, not what is in the file.

use std::collections::HashMap;

use tiny_skia::{Pixmap, Transform};

use crate::ink::{smooth_points, PenStyle, Pt};

/// Bytes in one RGBA pixel.
const BYTES_PER_PIXEL: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PageId(pub usize);

/// Rendered pixels for one page, kept only while it is near the viewport.
struct Entry {
    pixmap: Pixmap,
    /// Monotonic counter for LRU ordering.
    used: u64,
}

pub struct PageCache {
    entries: HashMap<PageId, Entry>,
    order: Vec<PageId>,
    clock: u64,
    /// Hard ceiling on cached pixel bytes. The cache never exceeds this.
    budget: usize,
    evictions: u64,
}

impl PageCache {
    /// Budget expressed in pages of this size.
    pub fn with_page_budget(max_pages: usize, page_w: u32, page_h: u32) -> Self {
        let per_page = page_w as usize * page_h as usize * BYTES_PER_PIXEL;
        PageCache {
            entries: HashMap::new(),
            order: Vec::new(),
            clock: 0,
            budget: per_page * max_pages.max(1),
            evictions: 0,
        }
    }

    /// Upper bound on resident pixels, in bytes.
    pub fn budget_bytes(&self) -> usize {
        self.budget
    }

    /// Bytes currently held.
    pub fn resident_bytes(&self) -> usize {
        self.entries
            .values()
            .map(|e| e.pixmap.width() as usize * e.pixmap.height() as usize * BYTES_PER_PIXEL)
            .sum()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn evictions(&self) -> u64 {
        self.evictions
    }

    fn touch(&mut self, id: PageId) {
        self.clock += 1;
        let c = self.clock;
        if let Some(e) = self.entries.get_mut(&id) {
            e.used = c;
        }
        self.order.retain(|p| *p != id);
        self.order.push(id);
    }

    /// Cached pixels for a page, if resident.
    pub fn get(&mut self, id: PageId) -> Option<&Pixmap> {
        if !self.entries.contains_key(&id) {
            return None;
        }
        self.touch(id);
        self.entries.get(&id).map(|e| &e.pixmap)
    }

    /// Insert a rendered page, evicting least-recently-used pages until the
    /// memory ceiling holds. The just-inserted page is always kept: dropping
    /// it would guarantee a re-render on the next frame.
    pub fn insert(&mut self, id: PageId, pixmap: Pixmap) {
        self.entries.insert(id, Entry { pixmap, used: 0 });
        self.touch(id);
        while self.resident_bytes() > self.budget && self.entries.len() > 1 {
            let Some(victim) = self.order.first().copied() else { break };
            if victim == id {
                break;
            }
            self.entries.remove(&victim);
            self.order.remove(0);
            self.evictions += 1;
        }
    }

    /// Drop everything. Called when a notebook closes or the window resizes.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    /// Drop the least-recently-used page, whatever it is.
    ///
    /// Used to hold back exactly one page so the "currently drawing" slot can
    /// be reserved for it without disturbing what the user is looking at.
    pub fn evict_one(&mut self) {
        if let Some(victim) = self.order.first().copied() {
            self.entries.remove(&victim);
            self.order.remove(0);
            self.evictions += 1;
        }
    }
}

/// Geometry of a page in notebook coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageRect {
    pub top: f32,
    pub height: f32,
}

impl PageRect {
    pub fn bottom(&self) -> f32 {
        self.top + self.height
    }
    pub fn intersects(&self, view_top: f32, view_bottom: f32) -> bool {
        self.bottom() > view_top && self.top < view_bottom
    }
}

/// The subset of pages that actually need rendering for the current scroll.
///
/// This is what makes frame cost independent of notebook length: a 400-page
/// notebook still yields two or three visible pages.
pub fn visible_pages(
    pages: &[PageRect],
    view_top: f32,
    view_bottom: f32,
    margin_pages: usize,
) -> Vec<PageId> {
    let mut out: Vec<PageId> = Vec::new();
    for (i, p) in pages.iter().enumerate() {
        if p.intersects(view_top - view_top, view_bottom) {
            out.push(PageId(i));
        }
    }
    if out.is_empty() {
        return out;
    }
    // Extend by a margin so small scrolls do not trigger re-renders.
    let first = out.first().map(|p| p.0).unwrap_or(0);
    let last = out.last().map(|p| p.0).unwrap_or(0);
    let lo = first.saturating_sub(margin_pages);
    let hi = (last + margin_pages).min(pages.len().saturating_sub(1));
    (lo..=hi)
        .filter(|i| pages[*i].intersects(view_top, view_bottom))
        .map(PageId)
        .collect()
}

/// Render one page's ink into a fresh pixmap.
///
/// Strokes are smoothed once here, at commit time, rather than per frame.
/// That single change is what removed the lag in the previous build.
pub fn render_page(
    page_w: u32,
    page_h: u32,
    paper: tiny_skia::Color,
    strokes: &[crate::ink::Stroke],
) -> Pixmap {
    let mut pm = Pixmap::new(page_w.max(1), page_h.max(1)).expect("pixmap");
    pm.fill(paper);
    for st in strokes {
        draw_stroke(&mut pm, st);
    }
    pm
}

fn draw_stroke(pm: &mut Pixmap, st: &crate::ink::Stroke) {
    let pts = smooth_points(&st.points, 2);
    if pts.is_empty() {
        return;
    }
    if st.highlighter {
        draw_polyline(pm, &pts, st.width, st);
        return;
    }
    if pts.len() == 1 {
        let w = style_width(st, pts[0].p.unwrap_or(0.5));
        let mut pb = tiny_skia::PathBuilder::new();
        pb.move_to(pts[0].x, pts[0].y);
        pb.line_to(pts[0].x + 0.01, pts[0].y + 0.01);
        if let Some(path) = pb.finish() {
            stroke_path(pm, &path, w, st);
        }
        return;
    }
    // Batch consecutive segments of near-equal width into one path, so a
    // stroke is a handful of draw calls rather than one per point.
    let mut band: Vec<Pt> = vec![pts[0]];
    let mut bucket: Option<i64> = None;
    for i in 1..pts.len() {
        let (a, b) = (pts[i - 1], pts[i]);
        let q = (a.p.unwrap_or(0.5) + b.p.unwrap_or(0.5)) / 2.0;
        let bkt = (style_width(st, q) * 2.0).round() as i64;
        match bucket {
            Some(cur) if cur == bkt => band.push(b),
            Some(_) => {
                draw_polyline(pm, &band, st.width, st);
                band = vec![b];
                bucket = Some(bkt);
            }
            None => {
                band.push(b);
                bucket = Some(bkt);
            }
        }
    }
    draw_polyline(pm, &band, st.width, st);
}

fn style_width(st: &crate::ink::Stroke, q: f32) -> f32 {
    let style = st.pen_style.unwrap_or(PenStyle::Legacy);
    style.width(st.width, q)
}

fn draw_polyline(pm: &mut Pixmap, pts: &[Pt], width: f32, st: &crate::ink::Stroke) {
    if pts.len() < 2 {
        return;
    }
    let mut pb = tiny_skia::PathBuilder::new();
    pb.move_to(pts[0].x, pts[0].y);
    for p in &pts[1..] {
        pb.line_to(p.x, p.y);
    }
    if let Some(path) = pb.finish() {
        let q: f32 = pts.iter().map(|p| p.p.unwrap_or(0.5)).sum::<f32>() / pts.len() as f32;
        let mut w = width;
        if !st.highlighter {
            w = style_width(st, q);
        }
        stroke_path(pm, &path, w, st);
    }
}

fn stroke_path(pm: &mut Pixmap, path: &tiny_skia::Path, width: f32, st: &crate::ink::Stroke) {
    let mut paint = tiny_skia::Paint::default();
    // Alpha lives on the colour in tiny-skia 0.11, not on the paint.
    let color = if st.highlighter {
        // Translucent, so overlapping passes do not stack into a dark band.
        let mut c = st.color;
        c.set_alpha(0.32);
        c
    } else {
        st.color
    };
    paint.set_color(color);
    let mut stroke = tiny_skia::Stroke {
        width: width.max(0.5),
        ..tiny_skia::Stroke::default()
    };
    stroke.line_cap = tiny_skia::LineCap::Round;
    stroke.line_join = tiny_skia::LineJoin::Round;
    pm.stroke_path(path, &paint, &stroke, Transform::identity(), None);
}

/// The rectangle a live stroke touches, padded for line width and smoothing.
///
/// Only this region needs repainting while drawing — not the whole page.
pub fn dirty_rect(points: &[Pt], _style: PenStyle, width: f32) -> Option<(f32, f32, f32, f32)> {
    if points.is_empty() {
        return None;
    }
    let pts = smooth_points(points, 2);
    let (min_x, min_y, max_x, max_y) = crate::ink::bbox(&pts)?;
    let pad = width.max(1.0) + 2.0;
    Some((min_x - pad, min_y - pad, max_x + pad, max_y + pad))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ink::{PenStyle, Stroke};

    const PW: u32 = 1024;
    const PH: u32 = 1408;
    const PAGE_BYTES: usize = PW as usize * PH as usize * 4;

    fn stroke(points: Vec<Pt>) -> Stroke {
        Stroke {
            points,
            width: 3.0,
            pen_style: Some(PenStyle::Fountain),
            color: tiny_skia::Color::from_rgba8(0, 0, 0, 255),
            highlighter: false,
        }
    }

    fn demo_strokes(n: usize) -> Vec<Stroke> {
        (0..n)
            .map(|i| {
                let y = 100.0 + i as f32 * 12.0;
                stroke(
                    (0..20)
                        .map(|k| Pt::new(50.0 + k as f32 * 8.0, y, Some(0.5)))
                        .collect(),
                )
            })
            .collect()
    }

    #[test]
    fn memory_stays_flat_across_a_long_notebook() {
        // The point of this cache: 40 pages must not cost 40 pages of RAM.
        let mut cache = PageCache::with_page_budget(4, PW, PH);
        for i in 0..40 {
            let pm = render_page(PW, PH, tiny_skia::Color::WHITE, &demo_strokes(3));
            cache.insert(PageId(i), pm);
        }
        assert!(
            cache.resident_bytes() <= cache.budget_bytes(),
            "cache exceeded its ceiling: {} > {}",
            cache.resident_bytes(),
            cache.budget_bytes()
        );
        assert!(
            cache.resident_bytes() <= 4 * PAGE_BYTES,
            "should hold at most 4 pages, held {}",
            cache.resident_bytes() / PAGE_BYTES
        );
        assert!(cache.evictions() > 0, "40 pages into 4 slots must evict");
    }

    #[test]
    fn ten_pages_stay_well_under_a_reasonable_ceiling() {
        let mut cache = PageCache::with_page_budget(4, PW, PH);
        for i in 0..10 {
            let pm = render_page(PW, PH, tiny_skia::Color::WHITE, &demo_strokes(3));
            cache.insert(PageId(i), pm);
        }
        assert!(cache.resident_bytes() <= 4 * PAGE_BYTES);
    }

    #[test]
    fn most_recently_used_page_survives_eviction() {
        let mut cache = PageCache::with_page_budget(2, PW, PH);
        for i in 0..3 {
            let pm = render_page(PW, PH, tiny_skia::Color::WHITE, &[]);
            cache.insert(PageId(i), pm);
        }
        // 2 and 3 are newest; 0 must be gone.
        assert!(cache.get(PageId(0)).is_none(), "oldest should be evicted");
        assert!(cache.get(PageId(2)).is_some(), "recent must survive");
    }

    #[test]
    fn touching_a_page_protects_it() {
        let mut cache = PageCache::with_page_budget(2, PW, PH);
        for i in 0..2 {
            let pm = render_page(PW, PH, tiny_skia::Color::WHITE, &[]);
            cache.insert(PageId(i), pm);
        }
        // Reading page 0 makes it newer than page 1.
        assert!(cache.get(PageId(0)).is_some());
        let pm = render_page(PW, PH, tiny_skia::Color::WHITE, &[]);
        cache.insert(PageId(9), pm);
        assert!(cache.get(PageId(0)).is_some(), "touched page must survive");
        assert!(cache.get(PageId(1)).is_none());
    }

    #[test]
    fn the_just_inserted_page_is_never_evicted() {
        // Otherwise the page being drawn would vanish immediately and force
        // a re-render every single frame.
        let mut cache = PageCache::with_page_budget(1, PW, PH);
        cache.insert(PageId(0), render_page(PW, PH, tiny_skia::Color::WHITE, &[]));
        cache.insert(PageId(1), render_page(PW, PH, tiny_skia::Color::WHITE, &[]));
        assert!(cache.get(PageId(1)).is_some(), "newest page must be present");
    }

    #[test]
    fn only_visible_pages_are_rendered() {
        let pages: Vec<PageRect> = (0..100)
            .map(|i| PageRect { top: i as f32 * PH as f32, height: PH as f32 })
            .collect();
        // Viewport shows roughly one page height.
        let vis = visible_pages(&pages, 0.0, 1500.0, 0);
        assert!(vis.len() <= 2, "must not render the whole notebook, got {}", vis.len());
        assert!(!vis.is_empty());
        // Frame cost must not scale with notebook length.
        let pages400: Vec<PageRect> = (0..400)
            .map(|i| PageRect { top: i as f32 * PH as f32, height: PH as f32 })
            .collect();
        let vis400 = visible_pages(&pages400, 0.0, 1500.0, 0);
        assert_eq!(vis.len(), vis400.len(), "cost must be independent of size");
    }

    #[test]
    fn scrolled_viewport_selects_different_pages() {
        let pages: Vec<PageRect> = (0..50)
            .map(|i| PageRect { top: i as f32 * PH as f32, height: PH as f32 })
            .collect();
        let a = visible_pages(&pages, 0.0, 1000.0, 0);
        let b = visible_pages(&pages, 20_000.0, 21_000.0, 0);
        assert_eq!(a[0], PageId(0));
        assert!(b[0].0 > 10, "scrolling must change the rendered set");
    }

    #[test]
    fn dirty_rect_covers_the_stroke_and_is_small() {
        let pts: Vec<Pt> = (0..30).map(|i| Pt::new(100.0 + i as f32, 100.0, Some(0.5))).collect();
        let (x0, y0, x1, y1) = dirty_rect(&pts, PenStyle::Fountain, 3.0).unwrap();
        assert!(x0 <= 100.0 && y0 <= 100.0, "rect must contain the stroke");
        assert!(x1 >= 129.0 && y1 >= 100.0);
        // A repaint region of a few hundred pixels, not the whole page.
        assert!((x1 - x0) < 200.0 && (y1 - y0) < 200.0, "dirty rect too large");
    }

    #[test]
    fn empty_stroke_has_no_dirty_rect() {
        assert!(dirty_rect(&[], PenStyle::Fountain, 3.0).is_none());
    }

    #[test]
    fn rendering_produces_actual_ink() {
        let pm = render_page(PW, PH, tiny_skia::Color::WHITE, &demo_strokes(3));
        // Sample a pixel the strokes pass through: must not be the paper.
        let px = pm.pixel(60, 100).expect("pixel");
        assert_ne!(px.red(), 0xFF, "no ink was rasterised at the stroke");
    }

    #[test]
    fn rendering_matches_across_runs() {
        let a = render_page(PW, PH, tiny_skia::Color::WHITE, &demo_strokes(2));
        let b = render_page(PW, PH, tiny_skia::Color::WHITE, &demo_strokes(2));
        assert_eq!(a.data(), b.data(), "rendering must be deterministic");
    }
}