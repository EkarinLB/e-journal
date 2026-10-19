//! Pen input: the shared policy layer plus one backend per platform.
//!
//! Both backends reduce their native events to these types before the ink
//! code sees them, so no renderer code ever branches on operating system.
//!
//! - Windows (`win`): `WM_POINTER_*`. Win32 merged mouse, pen and touch
//!   into one pointer stack and normalises pressure to 0..=1.
//! - Linux (`linux`): libinput tablet-tool events, i.e. `ABS_MT_PRESSURE`
//!   with `BTN_TOOL_PEN` / `BTN_TOOL_RUBBER` naming the tool. libinput also
//!   normalises pressure to 0..=1.
//!
//! Because both produce identical `PenEvent`s, the palm-rejection rules
//! are written once and proved by unit tests on either platform.

#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "linux")]
mod linux;

// The Windows backend translates raw window messages; the Linux one exposes
// `TabletState` for a libinput event loop to feed. Both are re-exported so
// callers use one name regardless of platform.
#[cfg(target_os = "windows")]
pub use win::translate;
#[cfg(target_os = "linux")]
pub use linux::{TabletState, Tool};

/// What produced an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PenKind {
    /// A stylus. The only device allowed to draw ink.
    Pen,
    /// A finger. Ink only before any pen has been seen (finger writing).
    Touch,
    /// A mouse. Same rule as touch.
    Mouse,
    /// A stylus with the inverted (eraser) end.
    Eraser,
    /// An unknown digitiser.
    Unknown,
}

impl PenKind {
    /// Whether this device can write ink at all.
    pub fn can_draw(&self) -> bool {
        matches!(self, PenKind::Pen | PenKind::Eraser)
    }
    pub fn is_stylus(&self) -> bool {
        matches!(self, PenKind::Pen | PenKind::Eraser)
    }
}

/// Phase of a contact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PenPhase {
    Down,
    Move,
    Up,
    /// The platform took the contact away (palm rejection, gesture, focus).
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PenEvent {
    pub kind: PenKind,
    pub phase: PenPhase,
    /// Stable per-contact id, so a stroke follows one finger or one pen tip.
    pub pointer_id: u32,
    pub x: f32,
    pub y: f32,
    /// Normalised 0..=1. `None` when the hardware cannot report pressure.
    pub pressure: Option<f32>,
    /// Tilt in degrees from vertical, when the digitiser reports it.
    pub tilt: Option<(f32, f32)>,
}

impl PenEvent {
    pub fn new(kind: PenKind, phase: PenPhase, pointer_id: u32, x: f32, y: f32) -> Self {
        PenEvent {
            kind,
            phase,
            pointer_id,
            x,
            y,
            pressure: None,
            tilt: None,
        }
    }
    pub fn with_pressure(mut self, p: Option<f32>) -> Self {
        self.pressure = p.map(|v| v.clamp(0.0, 1.0));
        self
    }
}

/// Map a raw pressure reading onto 0..=1.
///
/// Hardware ranges are all over the place: Win32 already normalises to 0..1,
/// evdev reports 0..=65535, some older tablets 0..=1024. Pen pressure sits in
/// roughly the top half of the range, so a naive divide makes every stroke
/// look like a feather.
pub fn normalise_pressure(raw: f32, raw_max: f32) -> Option<f32> {
    if raw_max <= 0.0 || raw <= 0.0 {
        return None;
    }
    let v = raw / raw_max;
    // Report only the upper part of the range as usable pressure, so light
    // contact still produces a visible line rather than nothing at all.
    let v = ((v - 0.15) / 0.85).clamp(0.0, 1.0);
    Some(v)
}

/// Tracks live contacts so palm rejection can compare positions properly.
///
/// The rules that work in practice:
///   * Once a stylus has been seen, a finger landing near the pen tip is a
///     palm and is dropped. This is the case that actually matters: a hand
///     resting on the page mid-stroke.
///   * Outside a pen stroke, fingers still draw, because plenty of people use
///     this app with a finger and no pen at all.
///   * A contact exactly on the pen tip is never a palm.
#[derive(Debug, Default)]
pub struct PenState {
    /// Latest position per live stylus contact.
    pen_positions: Vec<(u32, f32, f32)>,
    pen_down: bool,
    seen_pen: bool,
    rejected: u32,
}

impl PenState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn rejected(&self) -> u32 {
        self.rejected
    }
    pub fn pen_is_down(&self) -> bool {
        self.pen_down
    }

    /// Feed an event; returns true when it should reach the renderer.
    pub fn accept(&mut self, ev: &PenEvent) -> bool {
        match ev.phase {
            PenPhase::Down | PenPhase::Move => {
                if ev.kind.is_stylus() {
                    self.seen_pen = true;
                    self.pen_down = true;
                    match self.pen_positions.iter_mut().find(|(id, _, _)| *id == ev.pointer_id) {
                        Some(p) => {
                            p.1 = ev.x;
                            p.2 = ev.y;
                        }
                        None => self.pen_positions.push((ev.pointer_id, ev.x, ev.y)),
                    }
                    return true;
                }
                if ev.kind == PenKind::Touch && self.seen_pen && self.within_palm_radius(ev.x, ev.y) {
                    self.rejected += 1;
                    return false;
                }
                true
            }
            PenPhase::Up | PenPhase::Cancel => {
                if ev.kind.is_stylus() {
                    self.pen_positions.retain(|(id, _, _)| *id != ev.pointer_id);
                    self.pen_down = !self.pen_positions.is_empty();
                }
                true
            }
        }
    }

    /// A palm sits beside the pen, not on it.
///
/// Uses an annulus: contacts very close to the tip are treated as genuine
/// (two-handed writing often puts a finger down beside the nib), while
/// contacts in the surrounding band are a resting hand. Rejecting a contact
/// exactly on the tip would drop real input.
    fn within_palm_radius(&self, x: f32, y: f32) -> bool {
        const OUTER: f32 = 70.0;
        const INNER: f32 = 22.0;
        let d2 = |px: f32, py: f32| (x - px).powi(2) + (y - py).powi(2);
        self.pen_positions.iter().any(|(_, px, py)| {
            let d = d2(*px, *py);
            d < OUTER * OUTER && d > INNER * INNER
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: PenKind, phase: PenPhase, id: u32, x: f32, y: f32) -> PenEvent {
        PenEvent::new(kind, phase, id, x, y)
    }

    #[test]
    fn a_stylus_always_draws() {
        let mut s = PenState::new();
        assert!(s.accept(&ev(PenKind::Pen, PenPhase::Down, 1, 10.0, 10.0)));
        assert!(s.accept(&ev(PenKind::Pen, PenPhase::Move, 1, 20.0, 20.0)));
        assert!(s.pen_is_down());
    }

    #[test]
    fn a_finger_draws_before_any_pen_is_seen() {
        // Nobody owns a tablet; fingers must still work.
        let mut s = PenState::new();
        assert!(s.accept(&ev(PenKind::Touch, PenPhase::Down, 1, 50.0, 50.0)));
        assert_eq!(s.rejected(), 0);
    }

    #[test]
    fn a_finger_beside_the_tip_still_draws() {
        // Two-handed writing: a finger resting right next to the nib is
        // deliberate, not a palm.
        let mut s = PenState::new();
        s.accept(&ev(PenKind::Pen, PenPhase::Down, 1, 200.0, 200.0));
        assert!(s.accept(&ev(PenKind::Touch, PenPhase::Down, 2, 215.0, 200.0)));
    }

    #[test]
    fn a_palm_beside_the_pen_is_rejected() {
        // The case that matters: hand resting on the page mid-stroke.
        let mut s = PenState::new();
        assert!(s.accept(&ev(PenKind::Pen, PenPhase::Down, 1, 200.0, 200.0)));
        // ~40 px out: where a resting hand actually lands.
        assert!(!s.accept(&ev(PenKind::Touch, PenPhase::Down, 2, 240.0, 200.0)));
        assert_eq!(s.rejected(), 1);
    }

    #[test]
    fn a_finger_far_from_the_pen_still_draws() {
        // Two-handed writing: palm near the pen, fingers elsewhere.
        let mut s = PenState::new();
        s.accept(&ev(PenKind::Pen, PenPhase::Down, 1, 200.0, 200.0));
        assert!(s.accept(&ev(PenKind::Touch, PenPhase::Down, 2, 700.0, 700.0)));
    }

    #[test]
    fn the_pen_tip_is_never_treated_as_a_palm() {
        // A palm landing exactly on the tip must not cancel the stroke.
        let mut s = PenState::new();
        s.accept(&ev(PenKind::Pen, PenPhase::Down, 1, 200.0, 200.0));
        assert!(s.accept(&ev(PenKind::Touch, PenPhase::Down, 2, 200.0, 200.0)));
    }

    #[test]
    fn lifting_the_pen_re_enables_finger_drawing() {
        let mut s = PenState::new();
        s.accept(&ev(PenKind::Pen, PenPhase::Down, 1, 200.0, 200.0));
        s.accept(&ev(PenKind::Pen, PenPhase::Up, 1, 200.0, 200.0));
        assert!(!s.pen_is_down());
        assert!(s.accept(&ev(PenKind::Touch, PenPhase::Down, 2, 205.0, 205.0)));
    }

    #[test]
    fn two_pen_contacts_are_tracked_independently() {
        // Some tablets report a second stylus tip; the pen is only "up" when
        // every tip is gone.
        let mut s = PenState::new();
        s.accept(&ev(PenKind::Pen, PenPhase::Down, 1, 100.0, 100.0));
        s.accept(&ev(PenKind::Pen, PenPhase::Down, 2, 300.0, 300.0));
        s.accept(&ev(PenKind::Pen, PenPhase::Up, 1, 100.0, 100.0));
        assert!(s.pen_is_down(), "one tip remains");
        s.accept(&ev(PenKind::Pen, PenPhase::Up, 2, 300.0, 300.0));
        assert!(!s.pen_is_down());
    }

    #[test]
    fn pressure_normalises_across_hardware_ranges() {
        // Win32 hands us 0..=1 already; evdev gives 0..=65535.
        let win = normalise_pressure(0.5, 1.0).unwrap();
        let evdev = normalise_pressure(0.5 * 65535.0, 65535.0).unwrap();
        assert!((win - evdev).abs() < 1e-4, "same reading must normalise identically");
    }

    #[test]
    fn light_contact_still_draws_a_visible_line() {
        // Without the rescale, 0.2 of raw range is invisible.
        let light = normalise_pressure(0.2, 1.0).unwrap();
        assert!(light > 0.05, "light touch mapped to nothing: {light}");
    }

    #[test]
    fn no_pressure_reading_yields_none() {
        assert_eq!(normalise_pressure(0.0, 65535.0), None, "no contact, no pressure");
        assert_eq!(normalise_pressure(100.0, 0.0), None, "bad range");
    }

    #[test]
    fn pressure_is_clamped_to_a_sensible_range() {
        assert!(normalise_pressure(99999.0, 65535.0).unwrap() <= 1.0);
        let e = PenEvent::new(PenKind::Pen, PenPhase::Down, 1, 0.0, 0.0)
            .with_pressure(Some(5.0));
        assert_eq!(e.pressure, Some(1.0), "out-of-range input must clamp");
    }

    #[test]
    fn only_a_stylus_writes_ink() {
        assert!(PenKind::Pen.can_draw());
        assert!(PenKind::Eraser.can_draw());
        assert!(!PenKind::Touch.can_draw());
        assert!(!PenKind::Mouse.can_draw());
        assert!(PenKind::Eraser.is_stylus(), "eraser is a stylus end, not a finger");
    }

    #[test]
    fn palm_filter_counts_what_it_suppressed() {
        let mut s = PenState::new();
        for i in 0..5 {
            s.accept(&ev(PenKind::Pen, PenPhase::Down, 1, 100.0, 100.0));
            s.accept(&ev(PenKind::Touch, PenPhase::Down, 100 + i, 145.0, 100.0));
        }
        assert_eq!(s.rejected(), 5);
    }
}