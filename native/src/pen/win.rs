//! Windows pen input via the Win32 pointer stack.
//!
//! Why `WM_POINTER_*` rather than raw mouse messages: since Windows 8 the OS
//! merges mouse, pen and touch into one pointer stack, so a single message
//! stream carries the device type, a stable pointer id, and real stylus
//! pressure. Mouse messages do not have any of that, which is why pen apps
//! read pointer messages instead.
//!
//! Everything here converts native events into `PenEvent`s and hands them to
//! the shared policy layer in `super`, so no ink code knows it is on Windows.
//!
//! Two details that matter in practice and are easy to miss:
//!
//!   * `historyCount` packs several samples into one message. Using only the
//!     final sample throws away most of a fast stroke, which shows up as
//!     polygonal ink. `GetPointerHistory` recovers the rest.
//!   * The inverted (eraser) end of the stylus is reported as `penFlags`, not
//!     as a separate pointer type.

#![cfg(target_os = "windows")]

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::Input::Pointer::{
    GetPointerFramePenInfoHistory, GetPointerInfo, GetPointerPenInfo, POINTER_INFO,
    POINTER_PEN_INFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    PT_MOUSE, PT_PEN, PT_TOUCH, WM_POINTERDOWN, WM_POINTERUP, WM_POINTERUPDATE,
};

use super::{PenEvent, PenKind, PenPhase};

/// Upper bound on history samples taken from one message.
///
/// A fast flick can pack hundreds; this keeps a pathological message from
/// stalling the frame.
const MAX_HISTORY: usize = 256;

/// `POINTER_PEN_FLAG_INVERTED`: the stylus is flipped to its eraser end.
const POINTER_PEN_FLAG_INVERTED: u32 = 0x02;

/// Convert a Win32 pointer message into zero or more `PenEvent`s.
///
/// Returns an empty vector for messages that carry no pointer data. Safe to
/// call for any window message; only pointer messages produce output.
pub fn translate(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> Vec<PenEvent> {
    let phase = match msg {
        WM_POINTERDOWN => PenPhase::Down,
        // There is no WM_POINTERMOVE: a pen that moves sends UPDATE. Older
        // docs mention a MOVE variant; handle it by value so a stray message
        // cannot silently start a stroke with the wrong phase.
        WM_POINTERUPDATE => PenPhase::Move,
        WM_POINTERUP => PenPhase::Up,
        _ => return Vec::new(),
    };

    // Low word of wParam is the pointer id; high word flags a pen eraser.
    let pointer_id = (wparam.0 & 0xFFFF) as u32;
    let eraser = wparam.0 & 0x8000_0000 != 0;

    let _ = hwnd;
    let mut info = POINTER_INFO::default();
    // SAFETY: `info` is a correctly sized, initialised out-param. Failing to
    // read pointer info is not fatal: the message still identifies the
    // pointer, and lparam carries a usable position.
    let have_info = unsafe { GetPointerInfo(pointer_id, &mut info) }.is_ok();

    let (x, y) = if have_info {
        (info.ptPixelLocation.x as f32, info.ptPixelLocation.y as f32)
    } else {
        (((lparam.0 & 0xFFFF) as u16 as i16) as f32, (((lparam.0 >> 16) & 0xFFFF) as u16 as i16) as f32)
    };

    let kind = match (have_info, info.pointerType) {
        (true, PT_PEN) => {
            if eraser || pen_is_eraser(pointer_id) {
                PenKind::Eraser
            } else {
                PenKind::Pen
            }
        }
        (true, PT_TOUCH) => PenKind::Touch,
        (true, PT_MOUSE) => PenKind::Mouse,
        _ => PenKind::Unknown,
    };

    let mut out = Vec::new();

    // Recover the intermediate samples packed into this message. A fast
    // stroke can carry hundreds in one UPDATE; using only the final position
    // is what makes ink look polygonal.
    //
    // `GetPointerFramePenInfoHistory` is used rather than the older
    // `GetPointerHistory` because it returns pressure with each sample, and
    // because it is the function the current Windows headers expose.
    if have_info && info.historyCount > 1 {
        let mut entries = info.historyCount.min(MAX_HISTORY as u32);
        let mut buffer = [POINTER_PEN_INFO::default(); MAX_HISTORY];
        let mut count = 0u32;
        // SAFETY: `buffer` has MAX_HISTORY slots, `entries` is clamped to it,
        // and both out-params are valid for the count actually written.
        let ok = unsafe {
            GetPointerFramePenInfoHistory(
                pointer_id,
                &mut entries,
                &mut count,
                Some(buffer.as_mut_ptr()),
            )
        }
        .is_ok();
        if ok && count > 0 {
            for (i, pen) in buffer.iter().take(count as usize).enumerate() {
                let last = i == count as usize - 1;
                let mut ev = PenEvent::new(
                    if pen.penFlags & POINTER_PEN_FLAG_INVERTED != 0 {
                        PenKind::Eraser
                    } else {
                        kind
                    },
                    // Only the final sample carries the announced phase.
                    if last { phase } else { PenPhase::Move },
                    pointer_id,
                    pen.pointerInfo.ptPixelLocation.x as f32,
                    pen.pointerInfo.ptPixelLocation.y as f32,
                );
                ev.pressure = super::normalise_pressure(pen.pressure as f32, 1024.0);
                out.push(ev);
            }
            return out;
        }
    }

    let mut ev = PenEvent::new(kind, phase, pointer_id, x, y);
    ev.pressure = pen_pressure(pointer_id);
    out.push(ev);
    out
}

/// Normalised pressure from the pen, when the pointer is a pen.
fn pen_pressure(pointer_id: u32) -> Option<f32> {
    let mut pen = POINTER_PEN_INFO::default();
    // SAFETY: `pen` is a correctly sized, initialised out-param. Failure just
    // means this pointer is not a pen, which is not an error here.
    if unsafe { GetPointerPenInfo(pointer_id, &mut pen) }.is_err() {
        return None;
    }
    // POINTER_PEN_INFO.pressure is 0..=1024.
    super::normalise_pressure(pen.pressure as f32, 1024.0)
}

/// Whether the inverted stylus end is in use.
fn pen_is_eraser(pointer_id: u32) -> bool {
    let mut pen = POINTER_PEN_INFO::default();
    if unsafe { GetPointerPenInfo(pointer_id, &mut pen) }.is_err() {
        return false;
    }
    // POINTER_PEN_FLAG_INVERTED == 0x02
    pen.penFlags & 0x02 != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_pointer_messages_are_ignored() {
        // The window receives far more than pointer messages; anything else
        // must produce nothing rather than a bogus stroke.
        for msg in [0x0002u32, 0x0010, 0x0100, 0x000F] {
            assert!(
                translate(HWND(std::ptr::null_mut()), msg, WPARAM(0), LPARAM(0)).is_empty(),
                "message {msg:#x} must not yield pen events"
            );
        }
    }

    #[test]
    fn pointer_id_is_read_from_the_low_word() {
        // Without a live pointer, GetPointerInfo fails and we fall back to
        // lparam; the id must still be decoded correctly.
        let evs = translate(
            HWND(std::ptr::null_mut()),
            WM_POINTERDOWN,
            WPARAM(7),
            LPARAM(((50i16 as isize) & 0xFFFF) | (((60i16 as isize) & 0xFFFF) << 16)),
        );
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].pointer_id, 7);
        assert_eq!(evs[0].phase, PenPhase::Down);
    }

    #[test]
    fn fallback_position_comes_from_lparam() {
        let evs = translate(
            HWND(std::ptr::null_mut()),
            WM_POINTERDOWN,
            WPARAM(3),
            LPARAM(((120i16 as isize) & 0xFFFF) | (((240i16 as isize) & 0xFFFF) << 16)),
        );
        assert_eq!(evs[0].x, 120.0);
        assert_eq!(evs[0].y, 240.0);
    }

    #[test]
    fn phases_map_from_the_message() {
        let cases = [
            (WM_POINTERDOWN, PenPhase::Down),
            (WM_POINTERUPDATE, PenPhase::Move),
            (0x0245, PenPhase::Move), // WM_POINTERMOVE, absent from the bindings
            (WM_POINTERUP, PenPhase::Up),
        ];
        for (msg, want) in cases {
            let evs = translate(HWND(std::ptr::null_mut()), msg, WPARAM(1), LPARAM(0));
            assert_eq!(evs[0].phase, want, "message {msg:#x}");
        }
    }

    #[test]
    fn a_dead_pointer_produces_no_pressure_rather_than_zero() {
        // Zero pressure would draw a hairline; None lets the renderer fall
        // back to its default width.
        let evs = translate(
            HWND(std::ptr::null_mut()),
            WM_POINTERDOWN,
            WPARAM(99),
            LPARAM(0),
        );
        assert_eq!(evs[0].pressure, None);
    }
}