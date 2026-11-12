//! Uniform element scale: CSS's `transform: scale(s)` about a
//! `transform-origin`, for entrances that grow a popup in from 95%, with the
//! `translate()` that such an entrance pairs with it (a toast dropping in by
//! its own height).
//!
//! A scale is a transform of what an element paints, not of its layout: while
//! [`Window::with_element_transform`] runs, every primitive the scene takes in,
//! and every layer and rounded clip it opens, is mapped through
//! `p' = p * scale + translate` in device pixels before the scene orders it,
//! so draw order, batching and culling all see where it lands. Layout and
//! hit testing keep the unscaled geometry, which is right for an entrance
//! that is at rest within a few frames and wrong only for something that
//! rests scaled (pointer targets would not shrink with it).
//!
//! Sprites (glyphs, icons, images) keep the raster they have at rest and are
//! drawn stretched with their quad, as a browser composites a transformed
//! layer: an entrance rasterizes nothing new, so the atlas does not fill up
//! with a glyph at every fractional size a frame of the animation passes
//! through, and the text is crisp again the frame the scale is back at 1.
//!
//! The subtree's own content masks scale with it. Whatever clipped the
//! element before the scale began (a scrolling ancestor, the window) still
//! clips at the same place afterwards, as an ancestor's `overflow: hidden`
//! clips a transformed child in CSS: the mask in effect where the outermost
//! scale began is kept and intersected with every scaled mask.
//!
//! Two of gpui-fast's caches see the scale. A view replayed from last frame
//! inside a scale already holds the primitives it was painted with,
//! transformed, so [`Scene::replay`] suspends the transform while it copies
//! them, and the retained context of a view records the scale it was painted
//! under, so a view is replayed only under the scale it was painted with and
//! is built again under any other. Scroll layers, which composite a cached
//! texture, are off inside a scale (see `layers::active`).

use crate::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Point, Primitive, ScaledPixels, Scene, TransformationMatrix, Window, point,
    size,
};

/// The scale in effect while a scaled element paints, in device pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SceneScale {
    /// The uniform factor, `p' = p * scale + translate`.
    pub(crate) scale: f32,
    pub(crate) translate: Point<ScaledPixels>,
    /// The content mask in effect where the outermost scale began, which
    /// clips everything inside it at its own place.
    pub(crate) clip: Bounds<ScaledPixels>,
}

impl SceneScale {
    /// The scale by `scale` about `origin`, then moved by `offset`, inside
    /// the content mask `clip`.
    fn about(
        scale: f32,
        origin: Point<ScaledPixels>,
        offset: Point<ScaledPixels>,
        clip: Bounds<ScaledPixels>,
    ) -> Self {
        Self {
            scale,
            translate: point(
                origin.x * (1. - scale) + offset.x,
                origin.y * (1. - scale) + offset.y,
            ),
            clip,
        }
    }

    /// `inner` drawn inside `self`: `inner` maps first, then `self`. Both
    /// are in the unscaled coordinates of `inner`'s element, so its clip is
    /// mapped by `self` before the two clips are intersected.
    fn then(self, inner: Self) -> Self {
        Self {
            scale: self.scale * inner.scale,
            translate: point(
                inner.translate.x * self.scale + self.translate.x,
                inner.translate.y * self.scale + self.translate.y,
            ),
            clip: self.map_bounds(inner.clip).intersect(&self.clip),
        }
    }

    fn map_point(&self, p: Point<ScaledPixels>) -> Point<ScaledPixels> {
        point(
            p.x * self.scale + self.translate.x,
            p.y * self.scale + self.translate.y,
        )
    }

    fn map_length(&self, length: ScaledPixels) -> ScaledPixels {
        length * self.scale
    }

    fn map_bounds(&self, bounds: Bounds<ScaledPixels>) -> Bounds<ScaledPixels> {
        Bounds {
            origin: self.map_point(bounds.origin),
            size: size(
                self.map_length(bounds.size.width),
                self.map_length(bounds.size.height),
            ),
        }
    }

    fn map_mask(&self, mask: &mut crate::ContentMask<ScaledPixels>) {
        mask.bounds = self.map_bounds(mask.bounds).intersect(&self.clip);
    }

    fn map_corners(&self, corners: &mut crate::Corners<ScaledPixels>) {
        *corners = corners.map(|radius| self.map_length(*radius));
    }

    /// A sprite's own transformation `M`, applied in device pixels, becomes
    /// `S ∘ M ∘ S⁻¹`, so it turns about the scaled sprite as it turned about
    /// the unscaled one: the matrix keeps its rotation and scale `R`, and its
    /// translation `T` becomes `s·T + t − R·t`.
    fn map_transformation(&self, transformation: &mut TransformationMatrix) {
        if *transformation == TransformationMatrix::unit() {
            return;
        }
        let r = transformation.rotation_scale;
        let t = [self.translate.x.0, self.translate.y.0];
        for (row, translation) in transformation.translation.iter_mut().enumerate() {
            *translation =
                *translation * self.scale + t[row] - (r[row][0] * t[0] + r[row][1] * t[1]);
        }
    }

    fn map_primitive(&self, primitive: &mut Primitive) {
        match primitive {
            Primitive::Shadow(shadow) => {
                shadow.bounds = self.map_bounds(shadow.bounds);
                self.map_mask(&mut shadow.content_mask);
                self.map_corners(&mut shadow.corner_radii);
                shadow.blur_radius = self.map_length(shadow.blur_radius);
                shadow.element_bounds = self.map_bounds(shadow.element_bounds);
                self.map_corners(&mut shadow.element_corner_radii);
            }
            Primitive::Quad(quad) => {
                quad.bounds = self.map_bounds(quad.bounds);
                self.map_mask(&mut quad.content_mask);
                self.map_corners(&mut quad.corner_radii);
                quad.border_widths = quad.border_widths.map(|width| self.map_length(*width));
            }
            Primitive::Path(path) => {
                path.bounds = self.map_bounds(path.bounds);
                self.map_mask(&mut path.content_mask);
                for vertex in &mut path.vertices {
                    vertex.xy_position = self.map_point(vertex.xy_position);
                    self.map_mask(&mut vertex.content_mask);
                }
            }
            Primitive::Underline(underline) => {
                underline.bounds = self.map_bounds(underline.bounds);
                self.map_mask(&mut underline.content_mask);
                underline.thickness = self.map_length(underline.thickness);
            }
            Primitive::MonochromeSprite(sprite) => {
                sprite.bounds = self.map_bounds(sprite.bounds);
                self.map_mask(&mut sprite.content_mask);
                self.map_transformation(&mut sprite.transformation);
            }
            Primitive::SubpixelSprite(sprite) => {
                sprite.bounds = self.map_bounds(sprite.bounds);
                self.map_mask(&mut sprite.content_mask);
                self.map_transformation(&mut sprite.transformation);
            }
            Primitive::PolychromeSprite(sprite) => {
                sprite.bounds = self.map_bounds(sprite.bounds);
                self.map_mask(&mut sprite.content_mask);
                self.map_corners(&mut sprite.corner_radii);
            }
            Primitive::Surface(surface) => {
                surface.bounds = self.map_bounds(surface.bounds);
                self.map_mask(&mut surface.content_mask);
            }
        }
    }
}

/// Maps a primitive the scene is taking in through the scale in effect.
#[inline]
pub(crate) fn transform_primitive(scene: &Scene, primitive: &mut Primitive) {
    if let Some(scale) = &scene.fast_scale {
        scale.map_primitive(primitive);
    }
}

/// Maps the bounds of a layer the scene is opening through the scale in
/// effect.
#[inline]
pub(crate) fn transform_layer(scene: &Scene, bounds: Bounds<ScaledPixels>) -> Bounds<ScaledPixels> {
    match &scene.fast_scale {
        Some(scale) => scale.map_bounds(bounds).intersect(&scale.clip),
        None => bounds,
    }
}

/// Maps the padding edge of a rounded clip the scene is opening through the
/// scale in effect.
#[inline]
pub(crate) fn transform_clip_shape(scene: &Scene, shape: &mut crate::fast::rounded_clip::Shape) {
    if let Some(scale) = &scene.fast_scale {
        shape.bounds = scale.map_bounds(shape.bounds);
        shape.radii = shape.radii.map(|radius| {
            size(
                scale.map_length(radius.width),
                scale.map_length(radius.height),
            )
        });
    }
}

/// Takes the scale off the scene while it replays primitives that were
/// transformed when they were first painted; [`resume`] puts it back.
#[inline]
pub(crate) fn suspend(scene: &mut Scene) -> Option<SceneScale> {
    scene.fast_scale.take()
}

/// Puts back the scale [`suspend`] took off.
#[inline]
pub(crate) fn resume(scene: &mut Scene, scale: Option<SceneScale>) {
    scene.fast_scale = scale;
}

/// The scale a view is being drawn under, for its retained context.
#[inline]
pub(crate) fn current(window: &Window) -> Option<SceneScale> {
    window.next_frame.scene.fast_scale
}

impl Window {
    /// Paints what `f` paints scaled uniformly by `scale` about `origin`,
    /// then moved by `offset`, as CSS's `transform: translate(offset)
    /// scale(s)` with a `transform-origin` does.
    ///
    /// Only paint is transformed: layout, hit testing and the bounds elements
    /// are handed keep their untransformed geometry. Transforms nest. Glyphs,
    /// icons and images are stretched from the raster they have at scale 1
    /// rather than drawn again at the scaled size, so this is for motion (a
    /// popup growing in from 95%) more than for something that rests scaled.
    ///
    /// Call it around both an element's prepaint and its paint, as
    /// [`scaled`] does, so the views inside are cached for the transform
    /// they are drawn under.
    pub(crate) fn with_element_transform<R>(
        &mut self,
        scale: f32,
        origin: Point<Pixels>,
        offset: Point<Pixels>,
        f: impl FnOnce(&mut Self) -> R,
    ) -> R {
        if !scale.is_finite() || (scale == 1. && offset == Point::default()) {
            return f(self);
        }
        let scale = scale.max(0.);
        let scale_factor = self.scale_factor();
        let inner = SceneScale::about(
            scale,
            origin.scale(scale_factor),
            offset.scale(scale_factor),
            self.snapped_content_mask().bounds,
        );
        let previous = self.next_frame.scene.fast_scale;
        self.next_frame.scene.fast_scale = Some(match previous {
            Some(outer) => outer.then(inner),
            None => inner,
        });
        let result = f(self);
        self.next_frame.scene.fast_scale = previous;
        result
    }
}

/// Wraps `child` so that it paints scaled, about its center unless
/// [`Scaled::origin`] says otherwise, and moved by [`Scaled::translate`].
/// Only paint is transformed: layout and hit testing keep the child's
/// untransformed geometry.
///
/// ```ignore
/// scaled(menu).scale(0.95).origin(point(0.5, 0.)) // grows from its top edge
/// ```
pub fn scaled<E: IntoElement>(child: E) -> Scaled<E> {
    Scaled {
        child: Some(child),
        scale: 1.,
        origin: point(0.5, 0.5),
        translate: point(0., 0.),
    }
}

/// An element that paints its child scaled, built by [`scaled`].
pub struct Scaled<E> {
    child: Option<E>,
    scale: f32,
    origin: Point<f32>,
    translate: Point<f32>,
}

impl<E> Scaled<E> {
    /// The uniform factor: 1 paints the child as it is.
    pub fn scale(mut self, scale: f32) -> Self {
        self.scale = scale;
        self
    }

    /// The point that stays put, as fractions of the child's bounds: `(0, 0)`
    /// is its top left corner, `(0.5, 0)` the middle of its top edge.
    pub fn origin(mut self, origin: Point<f32>) -> Self {
        self.origin = origin;
        self
    }

    /// How far the child's paint moves, as fractions of its own size, as
    /// CSS's `translate(-100%)` is: `(0, -1)` paints it one height higher.
    pub fn translate(mut self, translate: Point<f32>) -> Self {
        self.translate = translate;
        self
    }

    /// Changes the child, as an animation does each frame.
    pub fn map_child(mut self, f: impl FnOnce(E) -> E) -> Self {
        self.child = self.child.map(f);
        self
    }

    fn transform_in<R>(
        &self,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        f: impl FnOnce(&mut Window) -> R,
    ) -> R {
        let origin = point(
            bounds.origin.x + bounds.size.width * self.origin.x,
            bounds.origin.y + bounds.size.height * self.origin.y,
        );
        let offset = point(
            bounds.size.width * self.translate.x,
            bounds.size.height * self.translate.y,
        );
        window.with_element_transform(self.scale, origin, offset, f)
    }
}

impl<E: IntoElement + 'static> IntoElement for Scaled<E> {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl<E: IntoElement + 'static> Element for Scaled<E> {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .expect("a scaled element is laid out once")
            .into_any_element();
        (child.request_layout(window, cx), child)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.transform_in(bounds, window, |window| child.prepaint(window, cx));
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        _prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.transform_in(bounds, window, |window| child.paint(window, cx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ContentMask, Corners, Edges, Hsla, MonochromeSprite, Quad, TestAppContext, div, prelude::*,
        px,
    };

    fn bounds(x: f32, y: f32, w: f32, h: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(w), ScaledPixels(h)),
        }
    }

    fn about(scale: f32, origin: Point<ScaledPixels>, clip: Bounds<ScaledPixels>) -> SceneScale {
        SceneScale::about(scale, origin, Point::default(), clip)
    }

    fn everywhere() -> Bounds<ScaledPixels> {
        bounds(-1e6, -1e6, 2e6, 2e6)
    }

    fn quad(at: Bounds<ScaledPixels>) -> Quad {
        Quad {
            order: 0,
            border_style: Default::default(),
            bounds: at,
            content_mask: ContentMask {
                bounds: everywhere(),
            },
            background: Hsla::black().into(),
            border_color: Hsla::black(),
            corner_radii: Corners::all(ScaledPixels(10.)),
            border_widths: Edges::all(ScaledPixels(2.)),
        }
    }

    #[test]
    fn a_scale_keeps_its_origin_put_and_shrinks_about_it() {
        // 95% about the middle of the top edge of a 200 × 100 box at (100, 50).
        let scale = about(
            0.95,
            point(ScaledPixels(200.), ScaledPixels(50.)),
            everywhere(),
        );
        let mapped = scale.map_bounds(bounds(100., 50., 200., 100.));
        assert_eq!(mapped.origin.y, ScaledPixels(50.));
        assert!((mapped.center().x.0 - 200.).abs() < 1e-4);
        assert!((mapped.size.width.0 - 190.).abs() < 1e-4);
        assert!((mapped.size.height.0 - 95.).abs() < 1e-4);
    }

    #[test]
    fn nested_scales_compose_inner_first() {
        let outer = about(0.5, point(ScaledPixels(0.), ScaledPixels(0.)), everywhere());
        let inner = about(
            0.5,
            point(ScaledPixels(100.), ScaledPixels(100.)),
            everywhere(),
        );
        let both = outer.then(inner);
        let p = point(ScaledPixels(300.), ScaledPixels(100.));
        assert_eq!(both.map_point(p), outer.map_point(inner.map_point(p)));
        assert_eq!(both.scale, 0.25);
    }

    #[test]
    fn quads_scale_their_corners_and_borders_and_keep_the_outer_clip() {
        let clip = bounds(0., 0., 150., 1000.);
        let scale = about(0.5, point(ScaledPixels(0.), ScaledPixels(0.)), clip);
        let mut primitive = Primitive::Quad(quad(bounds(100., 100., 200., 100.)));
        scale.map_primitive(&mut primitive);
        let Primitive::Quad(quad) = primitive else {
            unreachable!()
        };
        assert_eq!(quad.bounds, bounds(50., 50., 100., 50.));
        assert_eq!(quad.corner_radii, Corners::all(ScaledPixels(5.)));
        assert_eq!(quad.border_widths, Edges::all(ScaledPixels(1.)));
        // The subtree's mask scaled, then cut by what clipped it outside.
        assert_eq!(quad.content_mask.bounds, clip);
    }

    #[test]
    fn a_rotated_sprite_turns_about_its_scaled_center() {
        let scale = about(
            0.5,
            point(ScaledPixels(40.), ScaledPixels(20.)),
            everywhere(),
        );
        let sprite_bounds = bounds(100., 100., 20., 20.);
        let center = sprite_bounds.center();
        let rotation = TransformationMatrix::unit()
            .translate(center)
            .rotate(crate::radians(1.0))
            .translate(point(ScaledPixels(-center.x.0), ScaledPixels(-center.y.0)));
        let mut primitive = Primitive::MonochromeSprite(MonochromeSprite {
            order: 0,
            pad: 0,
            bounds: sprite_bounds,
            content_mask: ContentMask {
                bounds: everywhere(),
            },
            color: Hsla::black(),
            tile: crate::AtlasTile {
                texture_id: crate::AtlasTextureId {
                    index: 0,
                    kind: crate::AtlasTextureKind::Monochrome,
                },
                tile_id: crate::TileId(0),
                padding: 0,
                bounds: Default::default(),
            },
            transformation: rotation,
        });
        scale.map_primitive(&mut primitive);
        let Primitive::MonochromeSprite(sprite) = primitive else {
            unreachable!()
        };
        // The center of the scaled sprite is a fixed point of its new
        // transformation, as the unscaled center was of the old one.
        let scaled_center = sprite.bounds.center();
        let moved = sprite
            .transformation
            .apply(point(px(scaled_center.x.0), px(scaled_center.y.0)));
        assert!((moved.x.0 - scaled_center.x.0).abs() < 1e-3);
        assert!((moved.y.0 - scaled_center.y.0).abs() < 1e-3);
        // Any other point lands where scaling what the old matrix did puts it.
        let corner = sprite_bounds.origin;
        let old = rotation.apply(point(px(corner.x.0), px(corner.y.0)));
        let expected = scale.map_point(point(ScaledPixels(old.x.0), ScaledPixels(old.y.0)));
        let scaled_corner = scale.map_point(corner);
        let new = sprite
            .transformation
            .apply(point(px(scaled_corner.x.0), px(scaled_corner.y.0)));
        assert!((new.x.0 - expected.x.0).abs() < 1e-3);
        assert!((new.y.0 - expected.y.0).abs() < 1e-3);
    }

    #[gpui::test]
    fn a_scaled_element_paints_its_quads_scaled_and_leaves_the_rest_alone(cx: &mut TestAppContext) {
        struct View {
            scale: f32,
            translate: Point<f32>,
        }
        impl crate::Render for View {
            fn render(&mut self, _: &mut Window, _: &mut crate::Context<Self>) -> impl IntoElement {
                div()
                    .size_full()
                    .child(
                        div()
                            .absolute()
                            .top(px(0.))
                            .left(px(0.))
                            .size(px(10.))
                            .bg(gpui::red()),
                    )
                    .child(
                        div().absolute().top(px(100.)).left(px(100.)).child(
                            scaled(div().w(px(200.)).h(px(100.)).bg(gpui::blue()))
                                .scale(self.scale)
                                .origin(point(0.5, 0.))
                                .translate(self.translate),
                        ),
                    )
            }
        }

        let (view, cx) = cx.add_window_view(|_, _| View {
            scale: 0.5,
            translate: point(0., 0.),
        });
        cx.run_until_parked();
        let quads = |cx: &mut gpui::VisualTestContext| {
            cx.update(|window, _| {
                let factor = window.scale_factor();
                let mut quads = window
                    .rendered_frame
                    .scene
                    .quads
                    .iter()
                    .map(|quad| Bounds {
                        origin: point(
                            px(quad.bounds.origin.x.0 / factor),
                            px(quad.bounds.origin.y.0 / factor),
                        ),
                        size: size(
                            px(quad.bounds.size.width.0 / factor),
                            px(quad.bounds.size.height.0 / factor),
                        ),
                    })
                    .collect::<Vec<_>>();
                quads.sort_by(|a, b| a.size.width.partial_cmp(&b.size.width).unwrap());
                quads
            })
        };
        let painted = quads(cx);
        // The unscaled square stays as it is; the scaled box is half its size,
        // its top edge where it was, its middle on the same vertical.
        assert_eq!(painted[0].size, size(px(10.), px(10.)));
        assert_eq!(painted[1].origin, point(px(150.), px(100.)));
        assert_eq!(painted[1].size, size(px(100.), px(50.)));

        // Back at 1, the box is painted where layout put it, at full size.
        view.update(cx, |view, cx| {
            view.scale = 1.;
            cx.notify();
        });
        cx.run_until_parked();
        let painted = quads(cx);
        assert_eq!(painted[1].origin, point(px(100.), px(100.)));
        assert_eq!(painted[1].size, size(px(200.), px(100.)));

        // A translation by its own height paints it one height higher.
        view.update(cx, |view, cx| {
            view.translate = point(0., -1.);
            cx.notify();
        });
        cx.run_until_parked();
        let painted = quads(cx);
        assert_eq!(painted[1].origin, point(px(100.), px(0.)));
        assert_eq!(painted[1].size, size(px(200.), px(100.)));
    }

    #[gpui::test]
    fn a_view_replayed_inside_a_scale_is_scaled_once_and_rebuilt_for_another(
        cx: &mut TestAppContext,
    ) {
        struct Child;
        impl crate::Render for Child {
            fn render(&mut self, _: &mut Window, _: &mut crate::Context<Self>) -> impl IntoElement {
                div().w(px(200.)).h(px(100.)).bg(gpui::blue())
            }
        }
        struct Parent {
            child: crate::Entity<Child>,
            scale: f32,
        }
        impl crate::Render for Parent {
            fn render(&mut self, _: &mut Window, _: &mut crate::Context<Self>) -> impl IntoElement {
                div().size_full().child(
                    div().absolute().top(px(100.)).left(px(100.)).child(
                        scaled(self.child.clone())
                            .scale(self.scale)
                            .origin(point(0.5, 0.)),
                    ),
                )
            }
        }

        let (parent, cx) = cx.add_window_view(|_, cx| Parent {
            child: cx.new(|_| Child),
            scale: 0.5,
        });
        cx.run_until_parked();
        let child_quad = |cx: &mut gpui::VisualTestContext| {
            cx.update(|window, _| {
                let factor = window.scale_factor();
                let quads = &window.rendered_frame.scene.quads;
                assert_eq!(quads.len(), 1);
                let bounds = quads[0].bounds;
                (
                    point(bounds.origin.x.0 / factor, bounds.origin.y.0 / factor),
                    size(bounds.size.width.0 / factor, bounds.size.height.0 / factor),
                )
            })
        };
        assert_eq!(child_quad(cx), (point(150., 100.), size(100., 50.)));

        // The parent is drawn again and the child, unchanged, replayed under
        // the same scale: its primitives are already scaled.
        parent.update(cx, |_, cx| cx.notify());
        cx.run_until_parked();
        assert_eq!(child_quad(cx), (point(150., 100.), size(100., 50.)));

        // Under another scale the child is drawn again, not replayed.
        parent.update(cx, |parent, cx| {
            parent.scale = 0.75;
            cx.notify();
        });
        cx.run_until_parked();
        assert_eq!(child_quad(cx), (point(125., 100.), size(150., 75.)));
    }
}
