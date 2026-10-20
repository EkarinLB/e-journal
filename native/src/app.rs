//! Native window: real pen input, rasterised without a webview.
//!
//! winit 0.30 gives us the window and raw input (including stylus pressure
//! via the platform backends in `pen`). tiny-skia rasterises everything to a
//! Pixmap; softbuffer blits it to the screen. ab_glyph renders text. No
//! browser engine, no webview, no HTML, no CSS, no JavaScript.

use std::mem;
use std::num::NonZeroU32;
use std::rc::Rc;

use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::raw_window_handle::{DisplayHandle, HasDisplayHandle};
use winit::window::{Window, WindowAttributes, WindowId};
use softbuffer::{Context, Surface};
use tiny_skia::{
    Pixmap, Paint, Color, Transform, PathBuilder, Stroke as SkStroke,
    FillRule, Rect,
};
use ab_glyph::{FontRef, Font, Glyph, PxScale, point};

use crate::ink::{PenStyle, Pt, Stroke as InkStroke};
use crate::page::{PageCache, PageId, render_page, visible_pages};
use crate::store::{save};
use crate::model::{self, Library, Notebook, Page as ModelPage, Stroke as ModelStroke};
use crate::pen::PenState;

const PAGE_W: f32 = 1024.0;
const PAGE_H: f32 = 1408.0;
const PAGE_SPACING: f32 = 24.0;
const TOOLBAR_H: f32 = 56.0;

/// Application theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Theme {
    Light,
    Dark,
}

impl Theme {
    fn bg(self) -> Color {
        match self {
            Theme::Light => Color::from_rgba8(243, 244, 246, 255),
            Theme::Dark => Color::from_rgba8(27, 30, 36, 255),
        }
    }
    fn panel(self) -> Color {
        match self {
            Theme::Light => Color::from_rgba8(255, 255, 255, 255),
            Theme::Dark => Color::from_rgba8(35, 39, 47, 255),
        }
    }
    fn border(self) -> Color {
        match self {
            Theme::Light => Color::from_rgba8(227, 229, 232, 255),
            Theme::Dark => Color::from_rgba8(58, 63, 72, 255),
        }
    }
    fn ink(self) -> Color {
        match self {
            Theme::Light => Color::from_rgba8(27, 27, 27, 255),
            Theme::Dark => Color::from_rgba8(232, 232, 232, 255),
        }
    }
    fn ink_soft(self) -> Color {
        match self {
            Theme::Light => Color::from_rgba8(93, 93, 93, 255),
            Theme::Dark => Color::from_rgba8(167, 173, 182, 255),
        }
    }
    fn accent(self) -> Color {
        Color::from_rgba8(79, 163, 205, 255)
    }
}

/// Which drawing tool is active.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tool {
    Pen,
    Eraser,
    Highlighter,
}

/// Which screen is shown.
enum View {
    Home,
    Editor,
    Settings,
}

/// One entry in the undo stack.
struct UndoEntry {
    notebook_id: String,
    page_id: String,
    before: Vec<ModelStroke>,
    after: Vec<ModelStroke>,
}

/// A stroke being drawn right now.
struct Drawing {
    points: Vec<Pt>,
}

/// Application state.
struct App {
    // --- Windowing ---
    window: Option<Rc<Window>>,
    context: Option<Context<DisplayHandle<'static>>>,
    surface: Option<Surface<DisplayHandle<'static>, Rc<Window>>>,
    /// Font for text rendering.
    font: Option<FontRef<'static>>,
    /// Framebuffer for the current window size.
    frame: Option<Pixmap>,
    /// Offscreen pixmap per notebook page (committed ink).
    page_cache: PageCache,
    /// Whether a frame is pending.
    needs_redraw: bool,

    // --- Data ---
    library: Library,
    view: View,
    /// Index of the open notebook in `library.notebooks`, or None on home.
    notebook: Option<usize>,
    /// Index of the current page within the notebook.
    page: Option<usize>,

    // --- UI state ---
    theme: Theme,
    tool: Tool,
    color: Color,
    width: f32,
    pen_style: PenStyle,
    zoom: f32,
    ruled: bool,
    pressure_enabled: bool,
    pressure_sensitivity: f32,

    // --- Input ---
    pen_state: PenState,
    drawing: Option<Drawing>,
    /// Last known pointer position.
    cursor: (f32, f32),

    // --- Undo / redo ---
    undo_stack: Vec<UndoEntry>,
    redo_stack: Vec<UndoEntry>,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        event_loop.set_control_flow(ControlFlow::Wait);
        let mut attrs = WindowAttributes::default();
        attrs.title = "E-Journal".into();
        attrs.inner_size = Some(winit::dpi::LogicalSize::new(1024.0, 768.0).into());
        let window = Rc::new(event_loop.create_window(attrs).unwrap());
        let display = window.display_handle().unwrap();
        // The DisplayHandle borrows from the window, but since both window and
        // context are owned by App (and context is dropped before window), we
        // can safely extend the lifetime to 'static.
        let display_static = unsafe {
            mem::transmute::<DisplayHandle<'_>, DisplayHandle<'static>>(display)
        };
        let context = Context::new(display_static).unwrap();
        let surface = Surface::new(&context, Rc::clone(&window)).unwrap();
        self.window = Some(window);
        self.context = Some(context);
        self.surface = Some(surface);
        self.needs_redraw = true;
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => {
                // Save before exit.
                let _ = save(std::path::Path::new("library.json"), &self.library, false);
                _event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                let surface = self.surface.as_mut().unwrap();
                let _ = surface.resize(NonZeroU32::new(size.width).unwrap(), NonZeroU32::new(size.height).unwrap());
                self.frame = Some(Pixmap::new(size.width, size.height).unwrap());
                self.frame.as_mut().unwrap().fill(self.theme.bg());
                self.page_cache.clear();
                self.needs_redraw = true;
                self.window.as_ref().unwrap().request_redraw();
            }
            WindowEvent::RedrawRequested => {
                self.present();
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = (position.x as f32, position.y as f32);
                self.needs_redraw = true;
                self.window.as_ref().unwrap().request_redraw();
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let pressed = state == ElementState::Pressed;
                let (cx, cy) = self.cursor;
                match button {
                    MouseButton::Left => {
                        if pressed {
                            self.handle_click(cx, cy);
                        } else {
                            if let Some(draw) = self.drawing.take() {
                                self.commit_stroke(draw.points);
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        // Not needed; we use request_redraw() explicitly.
    }
}

impl App {
    fn new() -> Result<Self, String> {
        let font = load_font();
        let page_cache = PageCache::with_page_budget(4, PAGE_W as u32, PAGE_H as u32);
        let library = Library::default();

        Ok(Self {
            window: None,
            context: None,
            surface: None,
            font,
            frame: None,
            page_cache,
            needs_redraw: false,
            library,
            view: View::Home,
            notebook: None,
            page: None,
            theme: Theme::Light,
            tool: Tool::Pen,
            color: Color::from_rgba8(16, 20, 24, 255),
            width: 3.0,
            pen_style: PenStyle::Fountain,
            zoom: 1.0,
            ruled: true,
            pressure_enabled: true,
            pressure_sensitivity: 1.0,
            pen_state: PenState::new(),
            drawing: None,
            cursor: (0.0, 0.0),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        })
    }

    /// Notebook currently open, or None.
    fn current_notebook(&self) -> Option<&Notebook> {
        self.notebook.and_then(|i| self.library.notebooks.get(i))
    }

    /// Page currently open, or None.
    fn current_page(&self) -> Option<&ModelPage> {
        let nb = self.current_notebook()?;
        let p = self.page?;
        nb.pages.get(p)
    }

    /// Mutable current page.
    fn current_page_mut(&mut self) -> Option<&mut ModelPage> {
        let nb_idx = self.notebook?;
        let p_idx = self.page?;
        self.library.notebooks.get_mut(nb_idx)
            .and_then(|nb| nb.pages.get_mut(p_idx))
    }

    /// Present the framebuffer to the window.
    fn present(&mut self) {
        if !self.needs_redraw {
            return;
        }
        self.needs_redraw = false;

        let window = self.window.as_ref().unwrap();
        let size = window.inner_size();
        let (w, h) = (size.width, size.height);

        // Clear frame.
        let mut frame = self.frame.take().unwrap_or_else(|| {
            Pixmap::new(w, h).unwrap_or_else(|| Pixmap::new(1, 1).unwrap())
        });
        frame.fill(self.theme.bg());

        // Render current view.
        match self.view {
            View::Home => render_home(self, &mut frame),
            View::Editor => render_editor(self, &mut frame),
            View::Settings => render_settings(self, &mut frame),
        }

        // Draw cursor.
        let (cx, cy) = self.cursor;
        let r = Rect::from_xywh(cx - 4.0, cy - 4.0, 8.0, 8.0).unwrap();
        let mut pb = PathBuilder::new();
        pb.push_rect(r);
        if let Some(path) = pb.finish() {
            let mut paint = Paint::default();
            paint.set_color(Color::from_rgba8(255, 0, 0, 200));
            frame.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
        }

        // Convert RGBA8 (tiny-skia) to u32 pixels (softbuffer).
        let data = frame.data();
        let mut pixels = Vec::with_capacity((w * h) as usize);
        for chunk in data.chunks(4) {
            let pixel = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
            pixels.push(pixel | 0xFF000000);
        }

        // Present via softbuffer.
        let surface = self.surface.as_mut().unwrap();
        let mut buffer = match surface.buffer_mut() {
            Ok(b) => b,
            Err(_) => {
                self.frame = Some(frame);
                return;
            }
        };
        let slice = &mut *buffer;
        let n = slice.len().min(pixels.len());
        slice[..n].copy_from_slice(&pixels[..n]);
        let _ = buffer.present();

        self.frame = Some(frame);
    }

    /// Handle a click at (x, y).
    fn handle_click(&mut self, x: f32, y: f32) {
        match self.view {
            View::Home => {
                // "+ New notebook" button.
                let bw = 100.0; let bh = 36.0;
                let fw = self.window.as_ref().unwrap().inner_size().width as f32;
                let bx = fw - bw - 20.0;
                let by = 12.0;
                if x >= bx && x <= bx + bw && y >= by && y <= by + bh {
                    let nb = Notebook {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: "Untitled".into(),
                        color: "#4FA3CD".into(),
                        ruled: true,
                        updated_at: "".into(),
                        pages: vec![ModelPage {
                            id: uuid::Uuid::new_v4().to_string(),
                            order: 0,
                            width: PAGE_W,
                            height: PAGE_H,
                            strokes: vec![],
                            images: vec![],
                            background: None,
                        }],
                    };
                    self.library.notebooks.push(nb);
                    let _ = save(std::path::Path::new("library.json"), &self.library, false);
                    self.needs_redraw = true;
                    return;
                }
                // Notebook rows.
                let mut yy = 80.0;
                for (i, nb) in self.library.notebooks.iter().enumerate() {
                    let row_h = 72.0;
                    if x >= 20.0 && x <= fw - 20.0 && y >= yy && y <= yy + row_h {
                        self.notebook = Some(i);
                        self.page = Some(0);
                        self.view = View::Editor;
                        self.page_cache.clear();
                        self.needs_redraw = true;
                        return;
                    }
                    yy += row_h + 8.0;
                }
            }
            View::Editor => {
                let fw = self.window.as_ref().unwrap().inner_size().width as f32;
                let fh = self.window.as_ref().unwrap().inner_size().height as f32;
                // Back button (top-left).
                if y < TOOLBAR_H && x < 80.0 {
                    self.view = View::Home;
                    self.notebook = None;
                    self.page = None;
                    self.needs_redraw = true;
                    return;
                }
                // Bottom toolbar.
                let tb_y = fh - TOOLBAR_H;
                if y >= tb_y {
                    // Tool buttons.
                    let tools = [("Pen", Tool::Pen), ("Eraser", Tool::Eraser), ("Highlighter", Tool::Highlighter)];
                    let mut tx = 20.0;
                    for (_, t) in tools {
                        if x >= tx && x <= tx + 64.0 && y >= tb_y + 8.0 && y <= tb_y + 40.0 {
                            self.tool = t;
                            self.needs_redraw = true;
                            return;
                        }
                        tx += 72.0;
                    }
                    // Settings.
                    if x >= fw - 80.0 && x <= fw - 16.0 && y >= tb_y + 8.0 && y <= tb_y + 40.0 {
                        self.view = View::Settings;
                        self.needs_redraw = true;
                        return;
                    }
                    // Canvas click → start drawing.
                    if x >= 40.0 && x <= 40.0 + PAGE_W && y >= TOOLBAR_H && y <= tb_y {
                        if let Some(pidx) = self.page {
                            let local_x = x - 40.0;
                            let local_y = y - TOOLBAR_H - pidx as f32 * (PAGE_H + PAGE_SPACING);
                            if local_y >= 0.0 && local_y <= PAGE_H {
                                self.start_drawing(local_x, local_y);
                            }
                        }
                    }
                }
            }
            View::Settings => {
                // Back (top-left).
                if y < 60.0 && x < 80.0 {
                    self.view = View::Home;
                    self.needs_redraw = true;
                    return;
                }
            }
        }
    }

    /// Start drawing a stroke at (x, y) in page-local coordinates.
    fn start_drawing(&mut self, x: f32, y: f32) {
        self.drawing = Some(Drawing {
            points: vec![Pt::new(x, y, Some(1.0))],
        });
    }

    /// Commit a completed drawing stroke to the current page.
    fn commit_stroke(&mut self, points: Vec<Pt>) {
        if points.len() < 2 {
            return;
        }
        let pg_id = self.page.map(|p| {
            let nb_idx = self.notebook.unwrap();
            self.library.notebooks[nb_idx].pages[p].id.clone()
        }).unwrap_or_default();
        let nb_id = self.current_notebook().map(|n| n.id.clone()).unwrap_or_default();

        // Snapshot before, under a scoped borrow.
        let before: Vec<ModelStroke> = {
            let pg = self.current_page().unwrap();
            pg.strokes.clone()
        };

        // Build the new stroke.
        let stroke = ModelStroke {
            id: uuid::Uuid::new_v4().to_string(),
            tool: match self.tool {
                Tool::Pen => "pen",
                Tool::Eraser => "eraser",
                Tool::Highlighter => "highlighter",
            }.into(),
            color: format!(
                "#{:02X}{:02X}{:02X}",
                (self.color.red() * 255.0) as u32,
                (self.color.green() * 255.0) as u32,
                (self.color.blue() * 255.0) as u32,
            ),
            width: self.width,
            pen_style: Some(self.pen_style.as_str().into()),
            points: points.iter().map(|p| model::Point { x: p.x, y: p.y, p: p.p }).collect(),
        };

        // Mutably borrow the page to push the stroke.
        {
            let pg = self.current_page_mut().unwrap();
            pg.strokes.push(stroke);
        }

        let after: Vec<ModelStroke> = {
            let pg = self.current_page().unwrap();
            pg.strokes.clone()
        };

        self.undo_stack.push(UndoEntry { notebook_id: nb_id, page_id: pg_id, before, after });
        self.redo_stack.clear();

        // Invalidate page cache so it re-renders.
        if let Some(pidx) = self.page {
            let strokes: Vec<InkStroke> = {
                let pg = self.current_page().unwrap();
                pg.strokes.iter().map(|s| model_to_ink(s)).collect()
            };
            self.page_cache.insert(PageId(pidx), render_page(
                PAGE_W as u32,
                PAGE_H as u32,
                if self.ruled { Color::from_rgba8(247, 243, 234, 255) } else { Color::WHITE },
                &strokes,
            ));
        }
        self.needs_redraw = true;

        // Save.
        let _ = save(std::path::Path::new("library.json"), &self.library, false);
    }
}

/// Convert a model stroke to an ink stroke.
fn model_to_ink(s: &ModelStroke) -> InkStroke {
    let color = parse_color(&s.color).unwrap_or(Color::from_rgba8(16, 20, 24, 255));
    InkStroke {
        points: s.points.iter().map(|p| Pt::new(p.x, p.y, p.p)).collect(),
        width: s.width,
        pen_style: s.pen_style.as_deref().and_then(PenStyle::parse),
        color,
        highlighter: s.tool == "highlighter",
    }
}

/// Parse a hex color string "#RRGGBB" into a tiny-skia Color.
fn parse_color(hex: &str) -> Option<Color> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some(Color::from_rgba8(r, g, b, 255))
}

/// Load a font from the system. Returns None if no font is found.
fn load_font() -> Option<FontRef<'static>> {
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &[
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf",
            "C:/Windows/Fonts/tahoma.ttf",
        ]
    } else {
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ]
    };
    for path in candidates {
        if let Ok(data) = std::fs::read(path) {
            let data = Box::leak(data.into_boxed_slice());
            if let Ok(font) = FontRef::try_from_slice(data) {
                return Some(font);
            }
        }
    }
    None
}

/// Draw a line of text at (x, y) with the given size and color.
/// Uses ab_glyph's outline_glyph + draw callback to render each glyph as
/// alpha coverage into the target pixmap.
fn draw_text(
    pm: &mut Pixmap,
    font: &FontRef,
    x: f32,
    y: f32,
    size: f32,
    text: &str,
    color: Color,
) {
    let scale = PxScale::from(size);
    let mut cursor_x = 0.0f32;
    let r = color.red() as u8;
    let g = color.green() as u8;
    let b = color.blue() as u8;

    for ch in text.chars() {
        let gid = font.glyph_id(ch);
        if gid.0 == 0 {
            cursor_x += font.h_advance_unscaled(gid) * scale.x / 1000.0;
            continue;
        }
        if let Some(outlined) = font.outline_glyph(Glyph { id: gid, scale, position: point(cursor_x, 0.0) }) {
            let bounds = outlined.px_bounds();
            let offset_x = x + cursor_x + bounds.min.x;
            let offset_y = y + bounds.min.y;

            let frame_w = pm.width() as u32;
            let frame_data = pm.data_mut();
            outlined.draw(|px, py, coverage| {
                if coverage > 0.0 {
                    let alpha = (coverage * 255.0) as u8;
                    let dx = (offset_x + px as f32) as u32;
                    let dy = (offset_y + py as f32) as u32;
                    if dx < frame_w {
                        let idx = ((dy * frame_w + dx) * 4) as usize;
                        frame_data[idx] = r;
                        frame_data[idx + 1] = g;
                        frame_data[idx + 2] = b;
                        frame_data[idx + 3] = alpha;
                    }
                }
            });
        }
        cursor_x += font.h_advance_unscaled(gid) * scale.x / 1000.0;
    }
}

/// Measure text width.
fn text_width(font: &Option<FontRef>, size: f32, text: &str) -> f32 {
    let Some(font) = font else { return text.len() as f32 * size * 0.5; };
    let scale = PxScale::from(size);
    let mut width = 0.0f32;
    for ch in text.chars() {
        let gid = font.glyph_id(ch);
        if gid.0 != 0 {
            width += font.h_advance_unscaled(gid) * scale.x / 1000.0;
        }
    }
    width
}

/// UI helpers.

fn rect(pm: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, color: Color) {
    let r = Rect::from_xywh(x, y, w, h).unwrap();
    let mut pb = PathBuilder::new();
    pb.push_rect(r);
    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(color);
        pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
}

fn stroke_rect(pm: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, color: Color, thickness: f32) {
    let r = Rect::from_xywh(x, y, w, h).unwrap();
    let mut pb = PathBuilder::new();
    pb.push_rect(r);
    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(color);
        let mut sk = SkStroke::default();
        sk.width = thickness;
        pm.stroke_path(&path, &paint, &sk, Transform::identity(), None);
    }
}

fn draw_button(
    pm: &mut Pixmap,
    font: &FontRef,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    label: &str,
    theme: Theme,
    active: bool,
) {
    let bg = if active { theme.accent() } else { theme.panel() };
    let fg = if active { Color::WHITE } else { theme.ink() };
    rect(pm, x, y, w, h, bg);
    stroke_rect(pm, x, y, w, h, theme.border(), 1.0);
    let tw = text_width(&Some(font.clone()), 14.0, label);
    draw_text(pm, font, x + (w - tw) / 2.0, y + h / 2.0 + 4.0, 14.0, label, fg);
}

// --- View renderers ---

fn render_home(app: &mut App, frame: &mut Pixmap) {
    let theme = app.theme;
    let font = app.font.as_ref().expect("font loaded");
    let fw = frame.width() as f32;
    let fh = frame.height() as f32;
    rect(frame, 0.0, 0.0, fw, fh, theme.bg());

    // Header bar.
    rect(frame, 0.0, 0.0, fw, 60.0, theme.panel());
    stroke_rect(frame, 0.0, 60.0, fw, 1.0, theme.border(), 1.0);
    draw_text(frame, font, 20.0, 20.0 + 8.0, 20.0, "E-Journal", theme.ink());
    draw_text(frame, font, 20.0, 40.0 + 8.0, 12.0, "Local-first ink notebook — native, no webview", theme.ink_soft());

    // "+ New" button.
    let btn_w = 100.0;
    let btn_h = 36.0;
    let bx = fw - btn_w - 20.0;
    let by = 12.0;
    draw_button(frame, font, bx, by, btn_w, btn_h, "+ New notebook", theme, false);

    // Notebook list.
    let mut yy = 80.0;
    for nb in app.library.notebooks.iter() {
        let row_h = 72.0;
        let row_y = yy;
        let accent = parse_color(&nb.color).unwrap_or(theme.accent());
        // Color chip.
        rect(frame, 20.0, row_y + 10.0, 12.0, 12.0, accent);
        // Name.
        draw_text(frame, font, 44.0, row_y + 14.0 + 8.0, 16.0, &nb.name, theme.ink());
        // Page count.
        let pc = format!("{} page{}", nb.pages.len(), if nb.pages.len() == 1 { "" } else { "s" });
        draw_text(frame, font, 44.0, row_y + 34.0 + 8.0, 12.0, &pc, theme.ink_soft());
        yy += row_h + 8.0;
    }

    if app.library.notebooks.is_empty() {
        draw_text(
            frame, font,
            20.0, yy + 8.0, 14.0,
            "No notebooks yet. Tap \"+ New notebook\" to start one.",
            theme.ink_soft(),
        );
    }
}

fn render_editor(app: &mut App, frame: &mut Pixmap) {
    let theme = app.theme;
    let font = app.font.as_ref().expect("font loaded");
    let fw = frame.width() as f32;
    let fh = frame.height() as f32;
    rect(frame, 0.0, 0.0, fw, fh, theme.bg());

    let nb = match app.current_notebook() {
        Some(nb) => nb,
        None => return,
    };

    // Clone notebook data so we can drop the immutable borrow before
    // mutably borrowing app.page_cache.
    let nb_name = nb.name.clone();
    let nb_pages: Vec<ModelPage> = nb.pages.clone();

    // Topbar.
    rect(frame, 0.0, 0.0, fw, TOOLBAR_H, theme.panel());
    stroke_rect(frame, 0.0, TOOLBAR_H, fw, 1.0, theme.border(), 1.0);

    // Back button.
    draw_text(frame, font, 12.0, 12.0 + 8.0, 16.0, "‹ Back", theme.ink());
    // Notebook name.
    draw_text(frame, font, 70.0, 12.0 + 8.0, 18.0, &nb_name, theme.ink());

    // --- Page canvas area ---
    let canvas_y = TOOLBAR_H;
    let canvas_h = fh - TOOLBAR_H - TOOLBAR_H;
    rect(frame, 0.0, canvas_y, fw, canvas_h, theme.panel());

    // Render visible pages.
    let page_rects: Vec<crate::page::PageRect> = nb_pages.iter().enumerate()
        .map(|(i, _)| crate::page::PageRect {
            top: i as f32 * (PAGE_H + PAGE_SPACING),
            height: PAGE_H,
        })
        .collect();
    let view_top = 0.0;
    let view_bottom = canvas_h;
    let vis = visible_pages(&page_rects, view_top, view_bottom, 1);

    for pid in &vis {
        let pg = &nb_pages[pid.0];
        let py = pid.0 as f32 * (PAGE_H + PAGE_SPACING);
        // Page background.
        rect(frame, 40.0, canvas_y + py, PAGE_W, PAGE_H, Color::from_rgba8(247, 243, 234, 255));
        if app.ruled {
            for ly in (48..(PAGE_H as i32)).step_by(48) {
                stroke_rect(
                    frame,
                    40.0,
                    canvas_y + py + ly as f32,
                    PAGE_W,
                    1.0,
                    Color::from_rgba8(201, 194, 178, 128),
                    1.0,
                );
            }
        }
        // Draw committed ink.
        if let Some(pm) = app.page_cache.get(PageId(pid.0)) {
            let pm_w = pm.width() as u32;
            let frame_w = frame.width() as u32;
            let frame_data = frame.data_mut();
            let pm_data = pm.data();
            for py_ in 0..pm.height() as u32 {
                for px_ in 0..pm_w {
                    let src_idx = ((py_ * pm_w + px_) * 4) as usize;
                    let c = pm.pixel(px_, py_).unwrap();
                    if c.alpha() > 0 {
                        let dst_x = 40 + px_;
                        let dst_y = canvas_y as u32 + py as u32 + py_;
                        let dst_idx = ((dst_y * frame_w + dst_x) * 4) as usize;
                        frame_data[dst_idx] = pm_data[src_idx];
                        frame_data[dst_idx + 1] = pm_data[src_idx + 1];
                        frame_data[dst_idx + 2] = pm_data[src_idx + 2];
                        frame_data[dst_idx + 3] = pm_data[src_idx + 3];
                    }
                }
            }
        }
    }

    // Bottom toolbar (ink tools).
    let tb_y = fh - TOOLBAR_H;
    rect(frame, 0.0, tb_y, fw, TOOLBAR_H, theme.panel());
    stroke_rect(frame, 0.0, tb_y, fw, 1.0, theme.border(), 1.0);

    // Tool buttons.
    let tools = [("Pen", Tool::Pen), ("Eraser", Tool::Eraser), ("Highlighter", Tool::Highlighter)];
    let mut tx = 20.0;
    for (label, t) in tools {
        let active = app.tool == t;
        draw_button(frame, font, tx, tb_y + 8.0, 64.0, 32.0, label, theme, active);
        tx += 72.0;
    }

    // Color chip.
    rect(frame, tx, tb_y + 14.0, 24.0, 24.0, app.color);
    stroke_rect(frame, tx, tb_y + 14.0, 24.0, 24.0, theme.border(), 1.0);
    tx += 40.0;

    // Width.
    draw_text(frame, font, tx, tb_y + 12.0 + 8.0, 12.0, "Width", theme.ink_soft());
    tx += 30.0;

    // Settings button (far right).
    draw_button(frame, font, fw - 80.0, tb_y + 8.0, 64.0, 32.0, "Settings", theme, false);
}

fn render_settings(app: &mut App, frame: &mut Pixmap) {
    let theme = app.theme;
    let font = app.font.as_ref().expect("font loaded");
    let fw = frame.width() as f32;
    let fh = frame.height() as f32;
    rect(frame, 0.0, 0.0, fw, fh, theme.bg());

    rect(frame, 0.0, 0.0, fw, 60.0, theme.panel());
    stroke_rect(frame, 0.0, 60.0, fw, 1.0, theme.border(), 1.0);
    draw_text(frame, font, 20.0, 20.0 + 8.0, 20.0, "Settings", theme.ink());
    draw_text(frame, font, 20.0, 40.0 + 8.0, 12.0, "Preferences for the native app", theme.ink_soft());

    let mut yy = 90.0;

    // Theme.
    let dark = matches!(app.theme, Theme::Dark);
    let checked = if dark { "[■]" } else { "[ ]" };
    draw_text(frame, font, 20.0, yy + 8.0, 14.0, checked, theme.ink());
    draw_text(frame, font, 44.0, yy + 8.0, 14.0, "Dark theme", theme.ink());
    yy += 40.0;

    // Pressure.
    let pchecked = if app.pressure_enabled { "[■]" } else { "[ ]" };
    draw_text(frame, font, 20.0, yy + 8.0, 14.0, pchecked, theme.ink());
    draw_text(frame, font, 44.0, yy + 8.0, 14.0, "Pressure sensitivity", theme.ink());
    yy += 30.0;
    let sens = (app.pressure_sensitivity * 100.0) as i32;
    draw_text(
        frame, font,
        44.0, yy + 8.0, 12.0,
        &format!("Sensitivity: {}%", sens),
        theme.ink_soft(),
    );
    yy += 30.0;

    // Library path.
    draw_text(frame, font, 20.0, yy + 8.0, 14.0, "Library location", theme.ink());
    yy += 20.0;
    let path = "library.json (current dir)";
    draw_text(frame, font, 20.0, yy + 8.0, 12.0, path, theme.ink_soft());
}

/// Run the native application.
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let event_loop = EventLoop::new()?;
    let mut app = App::new()?;
    event_loop.run_app(&mut app)?;
    Ok(())
}
