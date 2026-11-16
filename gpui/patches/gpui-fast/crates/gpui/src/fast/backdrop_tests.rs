use super::*;
use crate::{
    BoxShadow, Hsla, Point, PrimitiveBatch, Scene, TestAppContext, VisualTestContext, canvas, div,
    fast::scale::SceneScale, hsla, prelude::*, px, scaled,
};

fn bounds(x: f32, y: f32, w: f32, h: f32) -> Bounds<ScaledPixels> {
    Bounds {
        origin: point(ScaledPixels(x), ScaledPixels(y)),
        size: size(ScaledPixels(w), ScaledPixels(h)),
    }
}

fn backdrop() -> Backdrop {
    Backdrop {
        bounds: bounds(100., 40., 200., 120.),
        content_mask: ContentMask {
            bounds: bounds(0., 0., 1000., 1000.),
        },
        corner_radii: Corners::all(ScaledPixels(20.)),
        sigma: ScaledPixels(28.),
        fallback: Rgba {
            r: 0.25,
            g: 0.5,
            b: 0.75,
            a: 1.,
        },
        opacity: 0.8,
    }
}

const PAGE: Hsla = Hsla {
    h: 0.,
    s: 1.,
    l: 0.5,
    a: 1.,
};

fn raised() -> Hsla {
    hsla(0.6, 0.2, 0.95, 1.)
}

/// A page at the top left, and a frosted card over part of it.
struct Card {
    scale: f32,
}

impl crate::Render for Card {
    fn render(&mut self, _: &mut Window, _: &mut crate::Context<Self>) -> impl IntoElement {
        let card = div()
            .w(px(100.))
            .h(px(60.))
            .rounded(px(10.))
            .shadow(vec![BoxShadow {
                color: hsla(0., 0., 0., 0.2),
                offset: point(px(0.), px(4.)),
                blur_radius: px(12.),
                spread_radius: px(0.),
                inset: false,
            }])
            .bg(raised().opacity(0.97))
            .backdrop_blur(px(14.), raised());
        div()
            .size_full()
            .child(
                div()
                    .absolute()
                    .top(px(0.))
                    .left(px(0.))
                    .w(px(200.))
                    .h(px(100.))
                    .bg(PAGE),
            )
            .child(
                div()
                    .absolute()
                    .top(px(20.))
                    .left(px(50.))
                    .child(scaled(card).scale(self.scale).origin(point(0., 0.))),
            )
    }
}

/// What the rendered frame's batches draw, in order: `"page"` and `"card"`
/// for the two backgrounds, `"shadow"`, `"backdrop"`, and the backdrops the
/// scene holds.
fn drawn(cx: &mut VisualTestContext) -> (Vec<&'static str>, Vec<Backdrop>, f32) {
    cx.update(|window, _| {
        let scene: &Scene = &window.rendered_frame.scene;
        let mut drawn = Vec::new();
        for batch in scene.batches() {
            match batch {
                PrimitiveBatch::Quads(range) => {
                    for quad in &scene.quads[range] {
                        let background = quad.background.solid;
                        drawn.push(if background == PAGE { "page" } else { "card" });
                    }
                }
                PrimitiveBatch::Shadows(_) => drawn.push("shadow"),
                PrimitiveBatch::PolychromeSprites { texture_id, .. }
                    if is_backdrop_texture(texture_id) =>
                {
                    drawn.push("backdrop")
                }
                _ => {}
            }
        }
        let backdrops = scene
            .polychrome_sprites
            .iter()
            .filter_map(Backdrop::decode)
            .collect();
        (drawn, backdrops, window.scale_factor())
    })
}

#[test]
fn a_backdrop_round_trips_through_its_sprite() {
    let backdrop = backdrop();
    let sprite = backdrop.sprite();
    assert!(is_backdrop_texture(sprite.tile.texture_id));
    assert_eq!(Backdrop::decode(&sprite), Some(backdrop));
    // An atlas sprite is not a backdrop.
    let mut atlas = sprite;
    atlas.tile.texture_id.index = 3;
    assert_eq!(Backdrop::decode(&atlas), None);
}

#[test]
fn an_element_scale_scales_the_blur_with_the_bounds() {
    let scale = SceneScale::about(
        0.5,
        point(ScaledPixels(100.), ScaledPixels(40.)),
        Point::default(),
        bounds(0., 0., 1000., 1000.),
    );
    let mut primitive = Primitive::PolychromeSprite(backdrop().sprite());
    scale.map_primitive(&mut primitive);
    let Primitive::PolychromeSprite(sprite) = primitive else {
        unreachable!()
    };
    let scaled = Backdrop::decode(&sprite).unwrap();
    assert_eq!(scaled.bounds, bounds(100., 40., 100., 60.));
    assert_eq!(scaled.corner_radii, Corners::all(ScaledPixels(10.)));
    assert_eq!(scaled.sigma, ScaledPixels(14.));
    // What is not a length is left alone.
    assert_eq!(scaled.fallback, backdrop().fallback);
    assert_eq!(scaled.opacity, backdrop().opacity);
}

#[gpui::test]
fn a_backdrop_is_drawn_over_what_is_under_it_and_under_its_element(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Card { scale: 1. });
    cx.run_until_parked();
    let (drawn, backdrops, scale_factor) = drawn(cx);
    // The page is drawn, then blurred, then the card's shadow and its
    // translucent background go over the blur.
    assert_eq!(drawn, ["page", "backdrop", "shadow", "card"]);
    let [backdrop] = backdrops[..] else {
        panic!("one backdrop, got {backdrops:?}");
    };
    let device = |x: f32| x * scale_factor;
    assert_eq!(
        backdrop.bounds,
        bounds(device(50.), device(20.), device(100.), device(60.))
    );
    assert_eq!(
        backdrop.corner_radii,
        Corners::all(ScaledPixels(device(10.)))
    );
    // CSS's blur radius is the Gaussian's standard deviation, in CSS pixels.
    assert_eq!(backdrop.sigma, ScaledPixels(device(14.)));
    assert_eq!(backdrop.fallback, raised().to_rgb());
    assert_eq!(backdrop.opacity, 1.);
}

#[gpui::test]
fn a_backdrop_follows_the_element_scale_and_the_interface_zoom(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Card { scale: 0.5 });
    cx.run_until_parked();
    let (_, backdrops, scale_factor) = drawn(cx);
    let device = |x: f32| x * scale_factor;
    assert_eq!(
        backdrops[0].bounds,
        bounds(device(50.), device(20.), device(50.), device(30.))
    );
    assert_eq!(backdrops[0].sigma, ScaledPixels(device(7.)));

    // A zoomed window draws everything larger, the blur included.
    cx.update(|window, cx| window.set_interface_zoom(1.5, cx));
    view.update(cx, |view, cx| {
        view.scale = 1.;
        cx.notify();
    });
    cx.run_until_parked();
    let (_, backdrops, zoomed) = drawn(cx);
    assert_eq!(zoomed, scale_factor * 1.5);
    assert_eq!(backdrops[0].sigma, ScaledPixels(14. * zoomed));
    assert_eq!(backdrops[0].bounds.size.width, ScaledPixels(100. * zoomed));
}

#[gpui::test]
fn inside_a_layer_a_backdrop_is_its_fallback_quad(cx: &mut TestAppContext) {
    struct Layered;
    impl crate::Render for Layered {
        fn render(&mut self, _: &mut Window, _: &mut crate::Context<Self>) -> impl IntoElement {
            canvas(
                |_, _, _| {},
                |bounds, _, window, _| {
                    window.paint_layer(bounds, |window| {
                        window.paint_backdrop_blur(
                            Bounds {
                                origin: bounds.origin,
                                size: size(px(40.), px(30.)),
                            },
                            Corners::all(px(4.)),
                            BackdropBlur {
                                radius: px(14.),
                                fallback: raised(),
                            },
                        );
                    });
                },
            )
            .size_full()
        }
    }

    let (_, cx) = cx.add_window_view(|_, _| Layered);
    cx.run_until_parked();
    cx.update(|window, _| {
        let scene = &window.rendered_frame.scene;
        assert!(scene.polychrome_sprites.is_empty());
        let [quad] = &scene.quads[..] else {
            panic!("one quad, got {:?}", scene.quads);
        };
        assert_eq!(quad.background.solid, raised());
    });
}
