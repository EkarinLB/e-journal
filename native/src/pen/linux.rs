//! Linux pen input via libinput.
//!
//! libinput is the right layer to read on Linux: it unifies the three input
//! stacks (libevdev, udev, the XInput2/Wayland paths), applies the kernel's
//! palm-detection heuristics, and normalises pressure to 0..=1 — the same
//! guarantee `WM_POINTER_*` gives on Windows. Reading raw evdev events would
//! mean reimplementing that, badly.
//!
//! What we need from a tablet device:
//!   * `EV_ABS / ABS_MT_PRESSURE` — actual stylus pressure
//!   * `BTN_TOOL_PEN` and `BTN_TOOL_RUBBER` — which end of the stylus
//!   * `EV_ABS / ABS_X` and `ABS_Y` — position (touchscreens report these in
//!     their own range, so libinput's normalisation is what we rely on)
//!   * `EV_KEY / BTN_TOUCH` — contact down/up
//!
//! Tablets report contact via a slot (`ABS_MT_SLOT`) rather than a pointer
//! id, so the slot doubles as the pointer id. That is exactly what
//! `PenEvent.pointer_id` expects.

#![cfg(target_os = "linux")]

use super::{PenEvent, PenKind, PenPhase};

/// Raw evdev axis values for the pressure axis, before normalisation.
///
/// The kernel reports 0..=65535 on current tablets; older ones used 0..=1024,
/// which is why libinput's normalised value is preferred when available and
/// this constant is only the fallback.
pub const PRESSURE_RAW_MAX: f32 = 65535.0;

/// Tracks a tablet device's state between events.
///
/// libinput delivers absolute events, so the event itself carries only the
/// *changed* axis. This keeps the full picture and converts it into complete
/// `PenEvent`s, which the policy layer expects.
#[derive(Debug, Default)]
pub struct TabletState {
    /// Current tool: pen, rubber, or none (touching a pad).
    tool: Tool,
    /// Whether the stylus is in contact with the surface.
    touching: bool,
    /// Latest position and pressure for each active contact slot.
    slots: Vec<Slot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Tool {
    #[default]
    None,
    Pen,
    Rubber,
}

#[derive(Debug, Clone, Copy, Default)]
struct Slot {
    id: u32,
    x: f32,
    y: f32,
    /// Raw pressure, 0 when the axis has not been reported.
    pressure_raw: f32,
    active: bool,
}

impl TabletState {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot_mut(&mut self, id: u32) -> &mut Slot {
        if let Some(i) = self.slots.iter().position(|s| s.id == id) {
            return &mut self.slots[i];
        }
        self.slots.push(Slot { id, active: true, ..Default::default() });
        self.slots.last_mut().expect("just pushed")
    }

    /// Feed a tablet-tool (stilus) change.
    pub fn set_tool(&mut self, tool: Tool) {
        self.tool = tool;
    }

    /// Absolute X position, in normalised 0..=1 coordinates.
    pub fn set_x(&mut self, slot: u32, x: f32) {
        self.slot_mut(slot).x = x;
    }

    /// Absolute Y position, in normalised 0..=1 coordinates.
    pub fn set_y(&mut self, slot: u32, y: f32) {
        self.slot_mut(slot).y = y;
    }

    /// Raw pressure for a slot.
    pub fn set_pressure(&mut self, slot: u32, raw: f32) {
        self.slot_mut(slot).pressure_raw = raw;
    }

    /// Mark a slot as in contact (or lifted).
    pub fn set_touching(&mut self, slot: u32, touching: bool) {
        self.touching = touching;
        self.slot_mut(slot).active = touching;
    }

    /// Whether the stylus is in contact.
    pub fn is_touching(&self) -> bool {
        self.touching
    }

    /// Which end of the stylus is down.
    pub fn tool(&self) -> Tool {
        self.tool
    }

    /// Emit the event for the active slot.
    pub fn event(&self, phase: PenPhase) -> Option<PenEvent> {
        let slot = self.slots.iter().find(|s| s.active)?;
        let kind = match self.tool {
            Tool::Pen => PenKind::Pen,
            Tool::Rubber => PenKind::Eraser,
            // A pad or finger on a tablet with no stylus identified.
            Tool::None => PenKind::Touch,
        };
        Some(
            PenEvent::new(kind, phase, slot.id, slot.x, slot.y)
                .with_pressure(super::normalise_pressure(slot.pressure_raw, PRESSURE_RAW_MAX)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn styled_tablet() -> TabletState {
        let mut t = TabletState::new();
        t.set_tool(Tool::Pen);
        t.set_x(1, 0.5);
        t.set_y(1, 0.25);
        t.set_pressure(1, 400.0);
        t.set_touching(1, true);
        t
    }

    #[test]
    fn a_pen_contact_becomes_a_drawable_event() {
        let t = styled_tablet();
        let ev = t.event(PenPhase::Down).expect("active slot");
        assert_eq!(ev.kind, PenKind::Pen);
        assert!(ev.kind.can_draw());
        assert_eq!(ev.x, 0.5);
        assert_eq!(ev.y, 0.25);
        assert_eq!(ev.pointer_id, 1);
        assert!(ev.pressure.is_some());
    }

    #[test]
    fn the_rubber_end_is_an_eraser_not_a_pen() {
        let mut t = styled_tablet();
        t.set_tool(Tool::Rubber);
        let ev = t.event(PenPhase::Move).unwrap();
        assert_eq!(ev.kind, PenKind::Eraser);
        assert!(ev.kind.is_stylus(), "eraser is still a stylus");
    }

    #[test]
    fn pressure_is_normalised_into_range() {
        let mut t = styled_tablet();
        t.set_pressure(1, PRESSURE_RAW_MAX);
        let p = t.event(PenPhase::Move).unwrap().pressure.unwrap();
        assert!((0.0..=1.0).contains(&p), "got {p}");
        assert!(p > 0.9, "full pressure should read near 1, got {p}");
    }

    #[test]
    fn lifting_the_stylus_ends_the_contact() {
        let mut t = styled_tablet();
        t.set_touching(1, false);
        assert!(!t.is_touching());
        assert!(t.event(PenPhase::Up).is_none(), "no active slot to report");
    }

    #[test]
    fn slots_are_tracked_independently() {
        // Two contacts: the stylus and a resting palm.
        let mut t = styled_tablet();
        t.set_x(2, 0.1);
        t.set_y(2, 0.1);
        t.set_pressure(2, 0.0);
        t.set_touching(2, true);
        let ev = t.event(PenPhase::Move).unwrap();
        // The stylus slot is the one that can draw.
        assert_eq!(ev.kind, PenKind::Pen);
    }

    #[test]
    fn a_device_with_no_tool_yet_reports_touch() {
        let mut t = TabletState::new();
        t.set_x(1, 0.5);
        t.set_y(1, 0.5);
        t.set_touching(1, true);
        let ev = t.event(PenPhase::Down).unwrap();
        assert_eq!(ev.kind, PenKind::Touch);
        assert!(!ev.kind.can_draw(), "a bare finger must not write ink");
    }
}