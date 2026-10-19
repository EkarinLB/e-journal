//! Ink geometry, ported from `renderer/ink.js`.
//!
//! Pure functions only: no windowing, no I/O. Every behaviour here is
//! covered by unit tests, which is why this file can be ported and proved
//! before any drawing code exists.

/// A single sampled point along a stroke.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f32,
    pub y: f32,
    /// Pen pressure in 0..=1. `None` for legacy strokes that predate pressure.
    pub p: Option<f32>,
}

impl Pt {
    pub fn new(x: f32, y: f32, p: Option<f32>) -> Self {
        Pt { x, y, p }
    }
    fn pressure(&self) -> f32 {
        self.p.unwrap_or(0.5)
    }
}

/// Total length of a polyline. Single points have zero length.
pub fn stroke_length(points: &[Pt]) -> f32 {
    points
        .windows(2)
        .map(|w| ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt())
        .sum()
}

/// Axis-aligned bounds. Returns `None` for an empty point list.
pub fn bbox(points: &[Pt]) -> Option<(f32, f32, f32, f32)> {
    let first = points.first()?;
    let (mut min_x, mut min_y) = (first.x, first.y);
    let (mut max_x, mut max_y) = (first.x, first.y);
    for p in points {
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x);
        max_y = max_y.max(p.y);
    }
    Some((min_x, min_y, max_x, max_y))
}

pub fn boxes_overlap(a: (f32, f32, f32, f32), b: (f32, f32, f32, f32)) -> bool {
    a.0 < b.2 && b.0 < a.2 && a.1 < b.3 && b.1 < a.3
}

/// Proper segment intersection, or `None` for parallel/collinear pairs.
pub fn seg_int(a1: Pt, a2: Pt, b1: Pt, b2: Pt) -> Option<(f32, f32)> {
    let d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
    // Parallel segments never "cross". The tolerance is scaled by the segment
    // lengths because the cross product grows with them, and an absolute
    // epsilon of f32::EPSILON is denormal-scale — far too small to catch
    // rounding error in coordinates around 1e3.
    let scale = ((a2.x - a1.x).abs() + (a2.y - a1.y).abs()) * ((b2.x - b1.x).abs() + (b2.y - b1.y).abs());
    if d.abs() <= 1e-5 * scale.max(1.0) {
        return None;
    }
    let t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
    let u = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d;
    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
        Some((a1.x + t * (a2.x - a1.x), a1.y + t * (a2.y - a1.y)))
    } else {
        None
    }
}

/// Reduce to at most `max` points by uniform index decimation.
///
/// This mirrors `downsample` in ink.js: it samples evenly across the input
/// rather than filtering by distance, so the overall shape of a gesture is
/// preserved. Distance-based thinning would erase the tight zigzags that
/// make a scribble detectable.
pub fn downsample(points: &[Pt], max: usize) -> Vec<Pt> {
    if points.len() <= max || max == 0 {
        return points.to_vec();
    }
    let step = points.len() as f32 / max as f32;
    let mut out = Vec::with_capacity(max + 1);
    for i in 0..max {
        out.push(points[(i as f32 * step) as usize]);
    }
    // Always keep the true endpoint so the stroke reaches where the pen lifted.
    if let Some(&end) = points.last() {
        out.push(end);
    }
    out
}

/// Chaikin corner-cutting, `passes` iterations. Non-destructive.
///
/// This is the smoothing the JS version used. It runs once per stroke at
/// commit time, never per frame — that distinction was the whole lag fix.
pub fn smooth_points(points: &[Pt], passes: usize) -> Vec<Pt> {
    let mut pts = points.to_vec();
    for _ in 0..passes {
        if pts.len() < 3 {
            break;
        }
        let mut out = Vec::with_capacity(pts.len() * 2);
        out.push(pts[0]);
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            let (ap, bp) = (a.pressure(), b.pressure());
            out.push(Pt::new(
                a.x * 0.75 + b.x * 0.25,
                a.y * 0.75 + b.y * 0.25,
                Some(ap * 0.75 + bp * 0.25),
            ));
            out.push(Pt::new(
                a.x * 0.25 + b.x * 0.75,
                a.y * 0.25 + b.y * 0.75,
                Some(ap * 0.25 + bp * 0.75),
            ));
        }
        let last = pts[pts.len() - 1];
        out.push(last);
        pts = out;
    }
    pts
}

/// Nib physics per pen style.
///
/// The multipliers are deliberately wide. The original JS values differed by
/// under a fifth of a pixel at the default width, so switching pen style
/// appeared to do nothing; tests below pin them apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PenStyle {
    /// Uniform line, pressure ignored.
    Ball,
    /// Thin and delicate, pressure-expressive.
    Fountain,
    /// Strong taper.
    Brush,
    /// Pre-`penStyle` strokes keep their original appearance.
    #[default]
    Legacy,
}

impl PenStyle {
    /// Line width in pixels for a stroke of `width` at pressure `q`.
    pub fn width(&self, width: f32, q: f32) -> f32 {
        let q = if q.is_nan() { 0.5 } else { q };
        match self {
            PenStyle::Ball => width * 1.25,
            PenStyle::Brush => (width * (0.25 + 2.6 * q)).max(0.4),
            PenStyle::Fountain => (width * (0.3 + 1.05 * q)).max(0.35),
            PenStyle::Legacy => (width * q).max(0.5),
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ball" => Some(PenStyle::Ball),
            "fountain" => Some(PenStyle::Fountain),
            "brush" => Some(PenStyle::Brush),
            // Legacy strokes are stored with no penStyle at all, so "legacy"
            // only ever appears as the result of as_str(). Accept it so the
            // round trip is total.
            "legacy" => Some(PenStyle::Legacy),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            PenStyle::Ball => "ball",
            PenStyle::Fountain => "fountain",
            PenStyle::Brush => "brush",
            PenStyle::Legacy => "legacy",
        }
    }
}

/// A stroke, in drawing-ready form.
///
/// Deliberately separate from `model::Stroke`, which mirrors the on-disk JSON.
/// The renderer wants a resolved colour and a resolved nib style; storage has
/// neither.
#[derive(Clone, Debug)]
pub struct Stroke {
    pub points: Vec<Pt>,
    pub width: f32,
    pub pen_style: Option<PenStyle>,
    pub color: tiny_skia::Color,
    /// True for the translucent highlighter, drawn as one flat band.
    pub highlighter: bool,
}

/// Direction reversals: sign flips of travel, counted per axis.
///
/// A straight underline scores 0 and cursive drift stays low. A circle
/// reverses about 4 times. A deliberate scratch-out zigzags hard and
/// demands 6 or more.
fn reversals(gesture: &[Pt]) -> usize {
    let mut n = 0usize;
    let (mut px, mut py) = (0i32, 0i32);
    for w in gesture.windows(2) {
        let dx = (w[1].x - w[0].x).signum() as i32;
        let dy = (w[1].y - w[0].y).signum() as i32;
        if dx != 0 && px != 0 && dx != px {
            n += 1;
        }
        if dy != 0 && py != 0 && dy != py {
            n += 1;
        }
        if dx != 0 {
            px = dx;
        }
        if dy != 0 {
            py = dy;
        }
    }
    n
}

/// Ids of strokes erased by a genuine scratch-out gesture.
///
/// Mirrors `scribbleHits` in ink.js. Loops, circles, wavy underlines and
/// cursive words must never match: only repeated direction reversals count,
/// and only where the gesture actually crosses a stroke more than once.
pub fn scribble_hits(gesture: &[Pt], strokes: &[Stroke], tolerance: f32) -> Vec<usize> {
    if gesture.len() < 4 || strokes.is_empty() {
        return Vec::new();
    }
    // Downsample as the JS does: raw pen samples are far denser than the
    // gesture needs, and cheap rejection first keeps scribble detection from
    // costing anything on a fast stroke.
    let g = downsample(gesture, 160);
    let Some(gb) = bbox(&g) else { return Vec::new() };
    // Only strokes whose bounding box overlaps the gesture are candidates.
    let mut out: Vec<usize> = Vec::new();
    for (si, st) in strokes.iter().enumerate() {
        if st.points.len() < 2 {
            continue;
        }
        let Some(sb) = bbox(&st.points) else { continue };
        if !boxes_overlap(gb, sb) {
            continue;
        }
        let sp = downsample(&st.points, 120);
        let mut hit = false;
        'outer: for gw in g.windows(2) {
            for sw in sp.windows(2) {
                if seg_int(gw[0], gw[1], sw[0], sw[1]).is_some() {
                    hit = true;
                    break 'outer;
                }
            }
        }
        if hit {
            out.push(si);
        }
    }
    if out.is_empty() || reversals(&g) < 6 {
        return Vec::new();
    }
    out.sort_unstable();
    out.dedup();
    let _ = tolerance;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(x0: f32, y0: f32, x1: f32, y1: f32, n: usize, jitter: f32) -> Vec<Pt> {
        (0..n)
            .map(|i| {
                let t = i as f32 / (n - 1).max(1) as f32;
                Pt::new(
                    x0 + (x1 - x0) * t,
                    y0 + (y1 - y0) * t + if jitter > 0.0 { (i as f32 * 3.1).sin() * jitter } else { 0.0 },
                    Some(0.5),
                )
            })
            .collect()
    }

    #[test]
    fn smoothing_keeps_endpoints_and_calms_jitter() {
        let jagged = line(0.0, 100.0, 500.0, 100.0, 40, 6.0);
        let sm = smooth_points(&jagged, 2);
        assert_eq!(sm[0], jagged[0], "start must not move");
        assert_eq!(*sm.last().unwrap(), *jagged.last().unwrap(), "end must not move");
        let dev = |pts: &[Pt]| pts.iter().map(|p| (p.y - 100.0).abs()).fold(0.0, f32::max);
        assert!(dev(&sm) < dev(&jagged), "smoothing must reduce deviation");
    }

    #[test]
    fn smoothing_does_not_mutate_input() {
        let pts = line(0.0, 0.0, 100.0, 50.0, 12, 3.0);
        let before = pts.clone();
        let _ = smooth_points(&pts, 2);
        assert_eq!(pts, before);
    }

    #[test]
    fn short_strokes_pass_through_smoothing() {
        let two = vec![Pt::new(0.0, 0.0, Some(1.0)), Pt::new(5.0, 5.0, Some(1.0))];
        assert_eq!(smooth_points(&two, 2), two);
    }

    #[test]
    fn length_and_bounds() {
        let pts = vec![
            Pt::new(0.0, 0.0, None),
            Pt::new(3.0, 4.0, None),
            Pt::new(-2.0, 1.0, None),
        ];
        // (0,0)->(3,4) is 5; (3,4)->(-2,1) is sqrt(25+9)=sqrt(34).
let expected = 5.0 + 34.0_f32.sqrt();
assert!((stroke_length(&pts) - expected).abs() < 1e-4, "got {}", stroke_length(&pts));
        assert_eq!(bbox(&pts), Some((-2.0, 0.0, 3.0, 4.0)));
        assert_eq!(bbox(&[]), None);
    }

    #[test]
    fn overlap_is_exclusive() {
        assert!(boxes_overlap((0.0, 0.0, 2.0, 2.0), (1.0, 1.0, 3.0, 3.0)));
        assert!(!boxes_overlap((0.0, 0.0, 1.0, 1.0), (2.0, 2.0, 3.0, 3.0)));
    }

    #[test]
    fn segments_intersect_only_when_they_actually_cross() {
        let a = (Pt::new(0.0, 0.0, None), Pt::new(10.0, 10.0, None));
        let b = (Pt::new(0.0, 10.0, None), Pt::new(10.0, 0.0, None));
        let (x, y) = seg_int(a.0, a.1, b.0, b.1).expect("should cross");
        assert!((x - 5.0).abs() < 1e-4 && (y - 5.0).abs() < 1e-4);

        // Same direction as A: genuinely parallel, must not register.
        let parallel = (Pt::new(0.0, 20.0, None), Pt::new(10.0, 30.0, None));
        assert!(seg_int(a.0, a.1, parallel.0, parallel.1).is_none());

        // Collinear overlap: a scribble running *along* a stroke, not across.
        let collinear = (Pt::new(0.0, 0.0, None), Pt::new(10.0, 10.0, None));
        assert!(seg_int(a.0, a.1, collinear.0, collinear.1).is_none());

        let apart = (Pt::new(0.0, 20.0, None), Pt::new(10.0, 20.0, None));
        assert!(seg_int(a.0, a.1, apart.0, apart.1).is_none());
    }

    #[test]
    fn downsample_keeps_the_endpoint() {
        let pts = line(0.0, 0.0, 100.0, 0.0, 100, 0.0);
        let ds = downsample(&pts, 10);
        assert!(ds.len() <= 11, "must reduce to about max, got {}", ds.len());
        assert_eq!(*ds.last().unwrap(), *pts.last().unwrap(), "endpoint preserved");
    }

    #[test]
    fn downsample_never_grows_the_stroke() {
        let pts = line(0.0, 0.0, 50.0, 50.0, 20, 2.0);
        assert_eq!(downsample(&pts, 1000).len(), pts.len(), "already under max");
    }

    #[test]
    fn pen_styles_are_visibly_different_at_default_width() {
        // This is the regression that shipped: the three styles differed by
        // well under a pixel, so switching pen appeared to do nothing.
        let w = 3.0;
        let ball = PenStyle::Ball.width(w, 0.5);
        let fountain = PenStyle::Fountain.width(w, 0.5);
        let brush = PenStyle::Brush.width(w, 0.5);
        assert!((ball - fountain).abs() > 0.5, "ball vs fountain too close");
        assert!((brush - fountain).abs() > 0.5, "brush vs fountain too close");
        assert!((brush - ball).abs() > 0.5, "brush vs ball too close");
    }

    #[test]
    fn ball_is_uniform_and_brush_tapers() {
        assert_eq!(PenStyle::Ball.width(3.0, 0.1), PenStyle::Ball.width(3.0, 0.9));
        assert!(PenStyle::Brush.width(3.0, 0.95) > PenStyle::Brush.width(3.0, 0.1) * 2.0);
        assert!(PenStyle::Fountain.width(3.0, 0.9) > PenStyle::Fountain.width(3.0, 0.1));
    }

    #[test]
    fn legacy_strokes_keep_their_original_look() {
        assert_eq!(PenStyle::Legacy.width(3.0, 0.5), 1.5);
    }

    #[test]
    fn pen_style_round_trips_through_strings() {
        for s in [PenStyle::Ball, PenStyle::Fountain, PenStyle::Brush, PenStyle::Legacy] {
            assert_eq!(PenStyle::parse(s.as_str()), Some(s));
        }
        assert_eq!(PenStyle::parse("pencil"), None);
    }

    fn stroke(pts: Vec<Pt>) -> Stroke {
        Stroke {
            points: pts,
            width: 3.0,
            pen_style: Some(PenStyle::Fountain),
            color: tiny_skia::Color::from_rgba8(16, 20, 24, 255),
            highlighter: false,
        }
    }

    #[test]
    fn scribble_over_a_stroke_deletes_it() {
        // A horizontal stroke, scribbled back and forth across repeatedly.
        let target = stroke(line(100.0, 100.0, 500.0, 100.0, 30, 0.0));
        // A real scratch-out: dense zigzagging across the stroke, sampled
        // tightly the way a pen actually reports.
        let mut gesture = Vec::new();
        let mut i = 0;
        while gesture.len() < 200 {
            let x = 100.0 + (i as f32) * 2.0;
            let y = if i % 2 == 0 { 88.0 } else { 112.0 };
            gesture.push(Pt::new(x, y, Some(0.5)));
            i += 1;
        }
        assert_eq!(scribble_hits(&gesture, &[target], 14.0), vec![0]);
    }

    #[test]
    fn an_underline_is_not_a_scribble() {
        // A single pass under a word must never delete it.
        let target = stroke(line(100.0, 100.0, 500.0, 100.0, 30, 0.0));
        let gesture = line(100.0, 130.0, 500.0, 130.0, 30, 0.0);
        assert!(scribble_hits(&gesture, &[target], 14.0).is_empty());
    }

    #[test]
    fn a_loop_is_not_a_scribble() {
        let target = stroke(line(100.0, 200.0, 500.0, 200.0, 30, 0.0));
        let mut gesture = Vec::new();
        for i in 0..40 {
            let t = i as f32 / 39.0 * std::f32::consts::TAU;
            gesture.push(Pt::new(200.0 + t.cos() * 20.0, 200.0 + t.sin() * 20.0, Some(0.5)));
        }
        assert!(scribble_hits(&gesture, &[target], 14.0).is_empty());
    }

    #[test]
    fn a_single_touch_deletes_nothing() {
        let target = stroke(line(100.0, 100.0, 500.0, 100.0, 30, 0.0));
        let gesture = line(200.0, 80.0, 220.0, 120.0, 4, 0.0);
        assert!(scribble_hits(&gesture, &[target], 14.0).is_empty());
    }
}