//! Backdrops drawn by the headless renderer, read back pixel by pixel: the
//! page under a backdrop blurred inside its rounded rectangle and nowhere
//! else, without darkening at its edges, an overlay surface's backdrop
//! blurring the base surface's frame with the overlay over it, and the
//! fallback colour where the renderer cannot read what is under it.

use std::sync::Arc;

use gpui::{
    Backdrop, Bounds, ContentMask, Corners, DevicePixels, Hsla, Quad, Rgba, ScaledPixels, Scene,
    Size, point, size,
};
use parking_lot::Mutex;

use super::{device_blurs, region};
use crate::metal_renderer::{InstanceBufferPool, MetalRenderer};

const WIDTH: i32 = 200;
const HEIGHT: i32 = 120;
/// The page's stripes: this wide, black and white in turn.
const STRIPE: f32 = 4.;

fn sp(x: f32, y: f32, w: f32, h: f32) -> Bounds<ScaledPixels> {
    Bounds {
        origin: point(ScaledPixels(x), ScaledPixels(y)),
        size: size(ScaledPixels(w), ScaledPixels(h)),
    }
}

fn viewport() -> Size<DevicePixels> {
    size(DevicePixels(WIDTH), DevicePixels(HEIGHT))
}

fn quad(bounds: Bounds<ScaledPixels>, color: Hsla) -> Quad {
    Quad {
        order: 0,
        border_style: Default::default(),
        bounds,
        content_mask: ContentMask {
            bounds: sp(0., 0., WIDTH as f32, HEIGHT as f32),
        },
        background: color.into(),
        border_color: Default::default(),
        corner_radii: Default::default(),
        border_widths: Default::default(),
    }
}

/// A backdrop at (40, 30), 120 × 60, with 20px corners and σ = 4.
fn card() -> Backdrop {
    Backdrop {
        bounds: sp(40., 30., 120., 60.),
        content_mask: ContentMask {
            bounds: sp(0., 0., WIDTH as f32, HEIGHT as f32),
        },
        corner_radii: Corners::all(ScaledPixels(20.)),
        sigma: ScaledPixels(4.),
        fallback: Rgba {
            r: 0.,
            g: 0.,
            b: 1.,
            a: 1.,
        },
        opacity: 1.,
    }
}

/// White, with black vertical stripes, and `backdrop` over it.
fn page_under(backdrop: Backdrop) -> Scene {
    let mut scene = striped_page();
    scene.insert_primitive(backdrop.sprite());
    scene.finish();
    scene
}

/// White, with black vertical stripes, unfinished.
fn striped_page() -> Scene {
    let mut scene = Scene::default();
    scene.insert_primitive(quad(sp(0., 0., WIDTH as f32, HEIGHT as f32), Hsla::white()));
    let mut x = 0.;
    while x < WIDTH as f32 {
        scene.insert_primitive(quad(sp(x, 0., STRIPE, HEIGHT as f32), Hsla::black()));
        x += STRIPE * 2.;
    }
    scene
}

fn renderer() -> Option<MetalRenderer> {
    let pool = Arc::new(Mutex::new(InstanceBufferPool::default()));
    match MetalRenderer::new_headless(pool) {
        Ok(renderer) => Some(renderer),
        Err(error) => {
            eprintln!("skipped: no Metal device ({error:#})");
            None
        }
    }
}

/// A renderer whose device blurs, or `None` (the test then skips) on one
/// without Metal Performance Shaders, such as a virtual machine's.
fn blurring_renderer() -> Option<MetalRenderer> {
    let renderer = renderer()?;
    if !device_blurs(&renderer.device) {
        eprintln!("skipped: the Metal device runs no Metal Performance Shaders");
        return None;
    }
    Some(renderer)
}

/// The red channel of the pixel at (x, y), and the blue.
fn at(pixels: &[u8], x: usize, y: usize) -> (u8, u8) {
    let index = (y * WIDTH as usize + x) * 4;
    (pixels[index], pixels[index + 2])
}

fn render(renderer: &mut MetalRenderer, scene: &Scene) -> Vec<u8> {
    renderer
        .render_scene_to_image(scene, viewport())
        .expect("scene rendered")
        .into_raw()
}

#[test]
fn the_page_under_a_backdrop_is_blurred_inside_its_rounded_rectangle_only() {
    let Some(mut renderer) = blurring_renderer() else {
        return;
    };
    let pixels = render(&mut renderer, &page_under(card()));
    // Inside, the stripes are blurred to an even grey, out to the edges: the
    // blur reads the page around the rectangle too, so it does not darken
    // toward them.
    for x in [41, 60, 100, 158] {
        let (red, _) = at(&pixels, x, 60);
        assert!((115..=140).contains(&red), "({x}, 60) is {red}");
    }
    let (top_edge, _) = at(&pixels, 100, 31);
    assert!((115..=140).contains(&top_edge), "(100, 31) is {top_edge}");
    // Outside it, and in its rounded corners, the stripes are as drawn.
    for (x, y) in [(10, 60), (100, 10), (41, 31), (158, 88)] {
        let (red, _) = at(&pixels, x, y);
        let black = (x as f32 / STRIPE) as usize % 2 == 0;
        assert_eq!(red, if black { 0 } else { 255 }, "({x}, {y})");
    }
}

#[test]
fn a_backdrop_draws_only_inside_its_content_mask() {
    let Some(mut renderer) = blurring_renderer() else {
        return;
    };
    let mut backdrop = card();
    backdrop.content_mask.bounds = sp(0., 0., 100., HEIGHT as f32);
    let pixels = render(&mut renderer, &page_under(backdrop));
    let (left, _) = at(&pixels, 60, 60);
    assert!((115..=140).contains(&left), "(60, 60) is {left}");
    for x in [101, 102, 140] {
        let (red, _) = at(&pixels, x, 60);
        let black = (x as f32 / STRIPE) as usize % 2 == 0;
        assert_eq!(red, if black { 0 } else { 255 }, "({x}, 60)");
    }
}

#[test]
fn a_renderer_that_cannot_read_its_target_fills_the_fallback() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    renderer.fast_backdrop.fill_only();
    let pixels = render(&mut renderer, &page_under(card()));
    assert_eq!(at(&pixels, 100, 60), (0, 255));
    assert_eq!(at(&pixels, 41, 60), (0, 255));
    // Its rounded corners keep the page: a black stripe at (41, 31).
    assert_eq!(at(&pixels, 41, 31), (0, 0));
}

#[test]
fn the_region_sampled_is_the_visible_rectangle_grown_by_three_sigma_then_to_64px_steps() {
    // 28..172 × 18..102 grown by 3σ; 192 wide, moved back from the right
    // edge to fit, and the viewport's whole height, as 128 would not fit.
    let sampled = region(&card(), viewport()).unwrap();
    assert_eq!(
        (sampled.x, sampled.y, sampled.width, sampled.height),
        (8, 0, 192, 120)
    );
    // Cut to the viewport (0..42 each way), then grown to a step.
    let mut corner = card();
    corner.bounds = sp(-20., -20., 50., 50.);
    let sampled = region(&corner, viewport()).unwrap();
    assert_eq!(
        (sampled.x, sampled.y, sampled.width, sampled.height),
        (0, 0, 64, 64)
    );
    // Nothing visible, nothing sampled.
    corner.bounds = sp(300., 0., 50., 50.);
    assert_eq!(region(&corner, viewport()), None);
}

#[test]
fn a_card_scaling_in_samples_regions_of_one_size() {
    // A pop-in's frames scale the card and its σ together about its centre.
    let sizes: Vec<_> = [0.96f32, 0.97, 0.98, 0.99, 1.]
        .into_iter()
        .map(|scale| {
            let mut frame = card();
            let (w, h) = (120. * scale, 60. * scale);
            frame.bounds = sp(100. - w / 2., 60. - h / 2., w, h);
            frame.sigma = ScaledPixels(4. * scale);
            let sampled = region(&frame, viewport()).unwrap();
            (sampled.width, sampled.height)
        })
        .collect();
    assert!(sizes.iter().all(|size| *size == sizes[0]), "{sizes:?}");
}

/// An overlay surface over the striped page: an opaque red pane on its left
/// half, under the card's backdrop.
fn overlay_over_page(covered: Vec<Bounds<DevicePixels>>) -> Option<Vec<u8>> {
    let mut base = blurring_renderer()?;
    base.keep_frame_for_backdrops(true);
    let mut page = striped_page();
    page.finish();
    render(&mut base, &page);
    let frame = base.kept_frame().expect("the base frame is kept");
    let mut overlay = renderer()?;
    // An overlay's layer is transparent: it starts each frame clear.
    overlay.opaque = false;
    overlay.fast_backdrop.fill_only();
    overlay.set_backdrop_frame(Some(frame), covered);
    let mut scene = Scene::default();
    let red = Hsla {
        h: 0.,
        s: 1.,
        l: 0.5,
        a: 1.,
    };
    scene.insert_primitive(quad(sp(0., 0., 100., HEIGHT as f32), red));
    scene.insert_primitive(card().sprite());
    scene.finish();
    Some(render(&mut overlay, &scene))
}

#[test]
fn an_overlay_s_backdrop_blurs_the_base_frame_with_the_overlay_over_it() {
    let Some(pixels) = overlay_over_page(Vec::new()) else {
        return;
    };
    // Under the red pane the blur is the pane's red, not the page's stripes
    // and not the fallback's blue.
    assert_eq!(at(&pixels, 60, 60), (255, 0));
    // Beside it, where the overlay is clear, the page's stripes blurred.
    let (red, blue) = at(&pixels, 140, 60);
    assert!((115..=140).contains(&red), "(140, 60) is {red}");
    assert_eq!(red, blue, "(140, 60) is grey");
    // Outside the card the overlay stays clear.
    let index = (60 * WIDTH as usize + 180) * 4;
    assert_eq!(pixels[index + 3], 0);
}

#[test]
fn an_overlay_s_backdrop_over_a_native_view_fills_the_fallback() {
    let view = Bounds {
        origin: point(DevicePixels(150), DevicePixels(80)),
        size: size(DevicePixels(40), DevicePixels(30)),
    };
    let Some(pixels) = overlay_over_page(vec![view]) else {
        return;
    };
    // The view's pixels are its own, which the base frame does not hold.
    assert_eq!(at(&pixels, 100, 60), (0, 255));
}
