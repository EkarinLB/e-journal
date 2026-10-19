//! Native window with real pen input — the spike that decides whether the
//! rewrite is viable.
//!
//! Two questions matter and neither is answered by compiling:
//!   1. Does winit report pen pressure from a real tablet?
//!   2. Can we reject palm/touch while the pen is down?
//!
//! Draw with a stylus: pressure is printed live and palm contacts are counted
//! separately. Without a tablet, run `cargo test` — the pure logic is covered
//! there and this just proves the input path wires up.

use std::num::NonZeroU32;
use std::sync::Arc;

use winit::application::ApplicationHandler;
use winit::event::{DeviceId, ElementState, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

use tiny_skia::{Color, Paint, PathBuilder, Pixmap, PixmapPaint, Transform};

use crate::ink::{smooth_points, PenStyle, Pt, Stroke};

/// Everything the renderer needs to know about a pointer this frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pen {
    Pen,
    Touch,
    Mouse,
    Other,
}

impl Pen {
    fn label(&self) -> &'static str {
        match self {
            Pen::Pen => "pen",
            Pen::Touch => "touch",
            Pen::Mouse => "mouse",
            Pen::Other => "other",
        }
    }
}

/// One live contact on the glass.
struct Contact {
    kind: Pen,
    x: f32,
    y: f32,
    /// Pen pressure, 0..=1. Touch and mouse have none.
    pressure: Option<f32>,
    points: Vec<Pt>,
}

/// Palette matching the existing app so notes keep their familiar look.
const INK: Color = Color::from_rgba8(16, 20, 24, 255);
const PAPER: Color = Color::from_rgba8(247, 243, 234, 255);
const RULE: Color = Color::from_rgba8(201, 194, 178, 255);
const MARGIN: Color = Color::from_rgba8(216, 143, 143, 255);

const PAGE_W: f32 = 1024.0;
const PAGE_H: f32 = 1408.0;
const LINE_GAP: f32 = 48.0;

pub struct App {
    window: Option<Arc<Window>>,
    ctx: Option<softbuffer::Context<Arc<Window>>>,
    surface: Option<softbuffer::Surface<softbuffer::Rc<Arc<Window>>>>,
    pixmap: Pixmap,
    contacts: Vec<Contact>,
    /// Pen must be down before touch is treated as a palm.
    pen_active: bool,
    palms_rejected: usize,
    live_stroke: Option<Stroke>,
}

impl App {
    fn new() -> Self {
        let pixmap = Pixmap::new(1, 1).expect("tiny-skia pixmap");
        App {
            window: None,
            ctx: None,
            surface: None,
            pixmap,
            contacts: Vec::new(),
            pen_active: false,
            palms_rejected: 0,
            live_stroke: None,
        }
    }

    /// Paper, ruled lines and margin, drawn into the pixmap.
    fn draw_paper(pixmap: &mut Pixmap) {
        pixmap.fill(PixmapPaint {
            color: PAPER,
            transform: Transform::identity(),
            opacity: 1.0,
            blend_mode: tiny_skia::BlendMode::Source,
            anti_alias: false,
        });
        let mut rule = PathBuilder::new();
        let mut y = LINE_GAP;
        while y < PAGE_H {
            rule.move_to(0.0, y + 0.5);
            rule.line_to(PAGE_W, y + 0.5);
            y += LINE_GAP;
        }
        if let Some(p) = rule.finish() {
            let mut paint = Paint::default();
            paint.set_color(RULE);
            paint.stroke_width = 1.0;
            pixmap.stroke_path(&p, &paint, Transform::identity(), None);
        }
        let mut margin = PathBuilder::new();
        margin.move_to(96.5, 0.0);
        margin.line_to(96.5, PAGE_H);
        if let Some(p) = margin.finish() {
            let mut paint = Paint::default();
            paint.set_color(MARGIN);
            paint.stroke_width = 1.0;
            pixmap.stroke_path(&p, &paint, Transform::identity(), None);
        }
    }

    /// Render one stroke. Width varies with pressure and pen style, exactly
    /// like the web version, so lines keep their character.
    fn draw_stroke(pixmap: &mut Pixmap, st: &Stroke, pen_style: PenStyle) {
        let pts = smooth_points(&st.points, 2);
        if pts.len() < 2 {
            if let Some(p) = pts.first() {
                let mut d = PathBuilder::new();
                d.move_to(p.x, p.y);
                d.line_to(p.x + 0.01, p.y + 0.01);
                if let Some(path) = d.finish() {
                    let mut paint = Paint::default();
                    paint.set_color(INK);
                    paint.set_stroke_width(pen_style.width(st.width, p.p.unwrap_or(0.5)));
                    paint.anti_alias = true;
                    pixmap.stroke_path(&path, &paint, Transform::identity(), None);
                }
            }
            return;
        }
        // Consecutive segments of near-equal width share a path: one draw
        // call per width band instead of one per point.
        let mut band: Vec<Pt> = vec![pts[0]];
        let mut current: Option<f32> = None;
        for i in 1..pts.len() {
            let (a, b) = (pts[i - 1], pts[i]);
            let q = ((a.p.unwrap_or(0.5)) + (b.p.unwrap_or(0.5))) / 2.0;
            let w = pen_style.width(st.width, q);
            let bucket = (w * 2.0).round().max(1.0);
            match current {
                Some(c) if c == bucket => band.push(b),
                Some(_) => {
                    Self::flush_band(pixmap, &band, pen_style);
                    band = vec![b];
                    current = Some(bucket);
                }
                None => {
                    band.push(b);
                    current = Some(bucket);
                }
            }
        }
        Self::flush_band(pixmap, &band, pen_style);
    }

    fn flush_band(pixmap: &mut Pixmap, band: &[Pt], pen_style: PenStyle) {
        if band.len() < 2 {
            return;
        }
        let mut pb = PathBuilder::new();
        pb.move_to(band[0].x, band[0].y);
        for p in &band[1..] {
            pb.line_to(p.x, p.y);
        }
        if let Some(path) = pb.finish() {
            let q: f32 = band.iter().map(|p| p.p.unwrap_or(0.5)).sum::<f32>() / band.len() as f32;
            let mut paint = Paint::default();
            paint.set_color(INK);
            paint.set_stroke_width(pen_style.width(3.0, q));
            paint.anti_alias = true;
            pixmap.stroke_path(&path, &paint, Transform::identity(), None);
        }
    }

    fn redraw(&mut self, size: (u32, u32)) {
        if self.pixmap.width() != size.0 || self.pixmap.height() != size.1 {
            self.pixmap = Pixmap::new(size.0.max(1), size.1.max(1)).expect("pixmap");
        }
        Self::draw_paper(&mut self.pixmap);
        // Committed strokes, then the live one on top.
        let mut all: Vec<Stroke> = self.contacts.iter().map(|c| Stroke {
            points: c.points.clone(),
            width: 3.0,
            pen_style: PenStyle::Fountain,
            highlighter: false,
        }).collect();
        if let Some(live) = self.live_stroke.clone() {
            all.push(live);
        }
        for st in &all {
            Self::draw_stroke(&mut self.pixmap, st, st.pen_style);
        }
    }

    fn present(&mut self) {
        let size = self
            .window
            .as_ref()
            .map(|w| w.inner_size())
            .unwrap_or(winit::dpi::PhysicalSize::new(1, 1));
        self.redraw((size.width, size.height));
        // Copy the pixmap into the window buffer and hand it to the
        // compositor. winit has no software present of its own; softbuffer
        // provides the blit.
        let (Some(window), Some(ctx)) = (self.window.clone(), self.ctx.clone()) else {
            return;
        };
        let Some(w) = NonZeroU32::new(size.width) else { return };
        let Some(h) = NonZeroU32::new(size.height) else { return };
        let width = w.get();
        let height = h.get();
        let need_resize = match &mut self.surface {
            Some(s) => s.width().get() != width || s.height().get() != height,
            None => true,
        };
        if need_resize {
            if self.surface.is_none() {
                match softbuffer::Surface::new(&ctx, window) {
                    Ok(s) => self.surface = Some(s),
                    Err(e) => {
                        eprintln!("could not create surface: {e}");
                        return;
                    }
                }
            }
            if let Some(s) = &mut self.surface {
                if let Err(e) = s.resize(w, h) {
                    eprintln!("resize failed: {e}");
                    return;
                }
            }
        }
        let Some(surface) = &mut self.surface else { return };
        let Ok(mut buf) = surface.buffer_mut() else { return };
        let stride = buf.width() as usize;
        for y in 0..height.min(self.pixmap.height()) {
            let src = self.pixmap.data();
            let row = src
                .chunks_exact(4)
                .skip(y as usize * self.pixmap.width() as usize)
                .take(self.pixmap.width() as usize);
            for (x, px) in row.enumerate() {
                if x as u32 >= stride {
                    break;
                }
                buf[x * 4] = px[2]; // B
                buf[x * 4 + 1] = px[1]; // G
                buf[x * 4 + 2] = px[0]; // R
                buf[x * 4 + 3] = px[3]; // A
            }
        }
        let _ = buf.present();
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        let attrs = Window::default_attributes()
            .with_title("E-Journal")
            .with_inner_size(winit::dpi::LogicalSize::new(1100.0, 850.0));
        let window = Arc::new(el.create_window(attrs).expect("create window"));
        match softbuffer::Context::new(window.clone()) {
            Ok(ctx) => self.ctx = Some(ctx),
            Err(e) => eprintln!("could not create GL context: {e}"),
        }
        self.window = Some(window);
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Resized(size) => {
                self.redraw((size.width, size.height));
                self.present();
            }
            WindowEvent::PointerDown { device_id, state, position, .. } => {
                if state != ElementState::Pressed {
                    return;
                }
                self.pointer_down(device_id, position.x as f32, position.y as f32);
                self.present();
            }
            WindowEvent::PointerMoved { device_id, position, .. } => {
                self.pointer_move(device_id, position.x as f32, position.y as f32);
                self.present();
            }
            WindowEvent::PointerUp { device_id, .. } => {
                self.pointer_up(device_id);
                self.present();
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if event.state != ElementState::Pressed {
                    return;
                }
                if let Key::Named(NamedKey::Escape) = event.logical_key {
                    el.exit();
                }
            }
            _ => {}
        }
    }
}

impl App {
    fn device_kind(&mut self, id: DeviceId) -> Pen {
        if let Some(w) = &self.window {
            if let Ok(d) = w.device_state(id) {
                return match d {
                    winit::event::DeviceType::Pen => Pen::Pen,
                    winit::event::DeviceType::Touch => Pen::Touch,
                    winit::event::DeviceType::Mouse => Pen::Mouse,
                    _ => Pen::Other,
                };
            }
        }
        Pen::Other
    }

    fn pointer_down(&mut self, device: DeviceId, x: f32, y: f32) {
        let kind = self.device_kind(device);
        // Palm rejection: touch is only a palm once a pen has been seen down.
        // Before that, touch is a legitimate finger draw (mouse users, too).
        if kind == Pen::Touch && self.pen_active {
            self.palms_rejected += 1;
            eprintln!("palm contact rejected ({})", self.palms_rejected);
            return;
        }
        if kind == Pen::Pen {
            self.pen_active = true;
        }
        let pressure = self.pressure_of(device);
        let pt = Pt::new(x, y, pressure);
        self.contacts.push(Contact { kind, x, y, pressure, points: vec![pt] });
        self.live_stroke = Some(Stroke {
            points: vec![pt],
            width: 3.0,
            pen_style: PenStyle::Fountain,
            highlighter: false,
        });
        if kind == Pen::Pen {
            eprintln!("pen down: pressure={:?}", pressure);
        }
    }

    fn pointer_move(&mut self, device: DeviceId, x: f32, y: f32) {
        let kind = self.device_kind(device);
        if kind == Pen::Touch && self.pen_active {
            return;
        }
        let pressure = self.pressure_of(device);
        let pt = Pt::new(x, y, pressure);
        if let Some(c) = self.contacts.last_mut() {
            c.x = x;
            c.y = y;
            c.points.push(pt);
            if let Some(l) = self.live_stroke.as_mut() {
                l.points.push(pt);
            }
            if kind == Pen::Pen {
                // Live pressure readout: proves the tablet is really talking.
                if let Some(p) = pressure {
                    eprintln!("pen move: p={:.3} x={:.0} y={:.0}", p, x, y);
                }
            }
        }
    }

    fn pointer_up(&mut self, device: DeviceId) {
        let kind = self.device_kind(device);
        if kind == Pen::Touch && self.pen_active {
            return;
        }
        if kind == Pen::Pen {
            self.pen_active = false;
        }
        self.live_stroke = None;
    }

    /// Pressure as reported by the OS for this device.
    fn pressure_of(&self, device: DeviceId) -> Option<f32> {
        let w = self.window.as_ref()?;
        let state = w.device_state(device).ok()?;
        if state.device_type() != winit::event::DeviceType::Pen {
            return None;
        }
        // winit normalises pressure to 0..=1 where the platform reports it.
        let p = state.pressure();
        if p == 0.0 {
            None
        } else {
            Some(p)
        }
    }
}

use winit::event_loop::ActiveEventLoop;
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let el = EventLoop::new()?;
    el.set_control_flow(ControlFlow::Wait);
    let mut app = App::new();
    el.run_app(&mut app)?;
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
    }
}