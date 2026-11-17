//! Backdrop blur on Metal: the renderer's side of `gpui::fast::backdrop`,
//! CSS's `backdrop-filter: blur()`.
//!
//! The scene carries a backdrop as a polychrome sprite with its own texture
//! id, ordered like any other primitive, so it arrives here as a batch of
//! its own after what is under it and before what goes over it. For each
//! backdrop the frame's render pass is ended, the target's pixels under it,
//! with a margin of three standard deviations, grown to whole 64 pixel steps
//! within the target so a card scaling in or out keeps its textures, are
//! copied into a scratch texture the size of that region and blurred into
//! another by
//! `MPSImageGaussianBlur` (clamping at the region's edges, so the blur does
//! not darken toward them), and the pass is begun again, loading what it
//! stored, to draw the blurred pixels back inside the backdrop's rounded
//! rectangle and content mask (`backdrop.metal`).
//!
//! An overlay surface, drawn over native views on a layer of its own, holds
//! only what the window draws over them, so its backdrops blur the base
//! surface's frame (kept for it by [`MetalRenderer::keep_frame_for_backdrops`]
//! and handed over by [`MetalRenderer::set_backdrop_frame`]) with what the
//! overlay drew so far composited over it: what Core Animation will show
//! under the backdrop, as long as no native view lies between them.
//!
//! Where the pixels at hand are not what the backdrop is over, its rectangle
//! is filled with its fallback colour instead: an overlay surface's backdrop
//! over a native view (its pixels are the view's own, which Metal cannot
//! read) or with no base frame handed over, a scroll layer's tile (a piece
//! of its layer), a drawable the layer made framebuffer-only (not readable;
//! the layer is asked for readable drawables from then on), or a device
//! without Metal Performance Shaders.

use std::{mem, ptr::NonNull};

use anyhow::{Context as _, Result};
use gpui::{Backdrop, Bounds, DevicePixels, PolychromeSprite, Size};
use objc2::{
    Message, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool, ProtocolObject},
};
use objc2_metal::{
    MTLBlitCommandEncoder, MTLCommandBuffer, MTLCommandEncoder, MTLDevice, MTLLibrary, MTLOrigin,
    MTLPixelFormat, MTLPrimitiveType, MTLRenderCommandEncoder, MTLRenderPipelineState, MTLSize,
    MTLStorageMode, MTLTexture, MTLTextureDescriptor, MTLTextureUsage,
};

use crate::metal_renderer::{MetalRenderer, build_pipeline_state, new_command_encoder_for_texture};

type Texture = Retained<ProtocolObject<dyn MTLTexture>>;
type Encoder = Retained<ProtocolObject<dyn MTLRenderCommandEncoder>>;
type Pipeline = Retained<ProtocolObject<dyn MTLRenderPipelineState>>;

#[link(name = "MetalPerformanceShaders", kind = "framework")]
unsafe extern "C" {
    fn MPSSupportsMTLDevice(device: &ProtocolObject<dyn MTLDevice>) -> Bool;
}

/// `MPSImageEdgeModeClamp`: texels past the source's edge read as its edge.
const EDGE_MODE_CLAMP: usize = 1;

/// How many blur kernels, one per standard deviation, are kept.
const MAX_KERNELS: usize = 8;

/// The step, in device pixels, a sampled region's width and height are
/// rounded up to, so a backdrop that changes size by a few pixels a frame
/// (a card scaling in) samples into the same scratch textures.
const REGION_STEP: f32 = 64.;

/// The step, in device pixels, a standard deviation is rounded to, so a
/// backdrop whose blur scales with it reuses a few kernels.
const SIGMA_STEP: f32 = 0.5;

/// The parameters `backdrop.metal` reads, in its `BackdropUniforms` layout.
#[repr(C)]
#[derive(Clone, Copy)]
struct Uniforms {
    bounds: [f32; 4],
    clip: [f32; 4],
    radii: [f32; 4],
    fallback: [f32; 4],
    viewport: [f32; 2],
    source_origin: [f32; 2],
    opacity: f32,
    padding: [f32; 3],
}

/// The Metal performance shader kernel that blurs, by standard deviation.
struct Kernel {
    sigma: u32,
    blur: Retained<AnyObject>,
}

/// The region of the target a backdrop samples, in whole device pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Region {
    pub(crate) x: usize,
    pub(crate) y: usize,
    pub(crate) width: usize,
    pub(crate) height: usize,
}

/// A frame a surface's renderer drew, kept for the surfaces drawn over it
/// ([`MetalRenderer::keep_frame_for_backdrops`]).
#[derive(Clone)]
pub struct BackdropFrame(Texture);

/// What an overlay surface's backdrops are over: the base surface's frame,
/// except over the native views between them.
struct Under {
    frame: Texture,
    /// The native views between, in device pixels.
    covered: Vec<Bounds<DevicePixels>>,
}

/// The renderer's backdrop state: the pipelines, what its backdrops are
/// over, and the scratch textures and kernels it blurs with.
pub(crate) struct Backdrops {
    blur_pipeline: Pipeline,
    fill_pipeline: Pipeline,
    /// The blur pipeline drawing into a scratch texture: composites an
    /// overlay's pixels over the base frame's.
    composite_pipeline: Pipeline,
    /// False for a renderer whose target is not what is under its backdrops:
    /// an overlay surface over native views.
    samples_target: bool,
    /// For an overlay surface: the base frame under it this frame.
    under: Option<Under>,
    /// For the base surface: whether to keep the frames it draws, and the
    /// last one kept.
    keep_frame: bool,
    kept: Option<Texture>,
    /// True while scroll layer tiles are rasterized.
    in_tiles: bool,
    /// Whether the device runs Metal Performance Shaders, once asked.
    supported: Option<bool>,
    source: Option<Texture>,
    blurred: Option<Texture>,
    kernels: Vec<Kernel>,
}

impl Backdrops {
    pub(crate) fn new(
        device: &ProtocolObject<dyn MTLDevice>,
        library: &ProtocolObject<dyn MTLLibrary>,
    ) -> Result<Self> {
        let format = MTLPixelFormat::BGRA8Unorm;
        Ok(Self {
            blur_pipeline: build_pipeline_state(
                device,
                library,
                "backdrop_blur",
                "backdrop_vertex",
                "backdrop_blur_fragment",
                format,
            )?,
            fill_pipeline: build_pipeline_state(
                device,
                library,
                "backdrop_fill",
                "backdrop_vertex",
                "backdrop_fill_fragment",
                format,
            )?,
            composite_pipeline: build_pipeline_state(
                device,
                library,
                "backdrop_composite",
                "backdrop_vertex",
                "backdrop_blur_fragment",
                format,
            )?,
            samples_target: true,
            under: None,
            keep_frame: false,
            kept: None,
            in_tiles: false,
            supported: None,
            source: None,
            blurred: None,
            kernels: Vec::new(),
        })
    }

    /// Called for an overlay surface's renderer, which draws over native
    /// views: its backdrops blur the base frame handed to it, or are filled.
    pub(crate) fn fill_only(&mut self) {
        self.samples_target = false;
    }
}

impl MetalRenderer {
    /// Whether to keep each frame this renderer draws, for the backdrops of
    /// the surfaces drawn over it this frame ([`Self::kept_frame`]); `false`
    /// lets the last one go. A frame is kept only once the layer's drawables
    /// are readable, which this asks it for.
    pub fn keep_frame_for_backdrops(&mut self, keep: bool) {
        self.fast_backdrop.keep_frame = keep;
        if !keep {
            self.fast_backdrop.kept = None;
        }
    }

    /// The frame this renderer last drew, while it keeps them.
    pub fn kept_frame(&self) -> Option<BackdropFrame> {
        self.fast_backdrop.kept.clone().map(BackdropFrame)
    }

    /// What this overlay surface's backdrops are over until it is changed:
    /// `frame`, drawn by the surface under it in the same command queue
    /// before this renderer draws, except within `covered`, the device pixel
    /// bounds of the native views between them, where they are filled.
    /// `None`: every backdrop is filled.
    pub fn set_backdrop_frame(
        &mut self,
        frame: Option<BackdropFrame>,
        covered: Vec<Bounds<DevicePixels>>,
    ) {
        self.fast_backdrop.under = frame.map(|BackdropFrame(frame)| Under { frame, covered });
    }
}

/// Forwarded to once a frame is encoded into `target`: keeps it if asked.
pub(crate) fn frame_rendered(
    renderer: &mut MetalRenderer,
    target: &ProtocolObject<dyn MTLTexture>,
) {
    if !renderer.fast_backdrop.keep_frame {
        return;
    }
    if target.isFramebufferOnly() {
        if let Some(layer) = &renderer.layer {
            layer.setFramebufferOnly(false);
        }
        renderer.fast_backdrop.kept = None;
        return;
    }
    renderer.fast_backdrop.kept = Some(target.retain());
}

/// Runs `f`, which rasterizes scroll layer tiles, with every backdrop filled.
pub(crate) fn in_tiles<R>(
    renderer: &mut MetalRenderer,
    f: impl FnOnce(&mut MetalRenderer) -> R,
) -> R {
    let was = mem::replace(&mut renderer.fast_backdrop.in_tiles, true);
    let result = f(renderer);
    renderer.fast_backdrop.in_tiles = was;
    result
}

/// Forwarded to for a batch of backdrop sprites by every loop that draws a
/// frame's batches. Ends `encoder` to blur under each backdrop and returns
/// the encoder that continues the pass; `rebind` restores what the loop had
/// bound on its encoder (the rounded clips) on a new one.
pub(crate) fn draw(
    renderer: &mut MetalRenderer,
    sprites: &[PolychromeSprite],
    target: &ProtocolObject<dyn MTLTexture>,
    viewport: Size<DevicePixels>,
    command_buffer: &ProtocolObject<dyn MTLCommandBuffer>,
    mut encoder: Encoder,
    rebind: impl Fn(&ProtocolObject<dyn MTLRenderCommandEncoder>),
) -> Result<Encoder> {
    for backdrop in sprites.iter().filter_map(Backdrop::decode) {
        let Some(region) = region(&backdrop, viewport) else {
            continue;
        };
        let blurred = match sample(renderer, &backdrop, target, viewport) {
            Some(under) => blur(
                renderer,
                &backdrop,
                region,
                target,
                under.as_ref(),
                command_buffer,
                &encoder,
            )?,
            None => None,
        };
        match blurred {
            Some(blurred) => {
                encoder = new_command_encoder_for_texture(command_buffer, target, viewport, None)?;
                rebind(&encoder);
                let origin = [region.x as f32, region.y as f32];
                let uniforms = uniforms(&backdrop, viewport, origin);
                encoder.setRenderPipelineState(&renderer.fast_backdrop.blur_pipeline);
                // SAFETY: The texture slot is the one the fragment reads.
                unsafe { encoder.setFragmentTexture_atIndex(Some(&blurred), 0) };
                draw_rect(&encoder, &uniforms);
            }
            None => fill_one(renderer, &backdrop, viewport, &encoder),
        }
    }
    Ok(encoder)
}

/// Fills each backdrop of `sprites` with its fallback colour, in `encoder`'s
/// pass, for a target that never holds what is under a backdrop (a scroll
/// layer's tile).
pub(crate) fn fill(
    renderer: &MetalRenderer,
    sprites: &[PolychromeSprite],
    viewport: Size<DevicePixels>,
    encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>,
) {
    for backdrop in sprites.iter().filter_map(Backdrop::decode) {
        fill_one(renderer, &backdrop, viewport, encoder);
    }
}

fn fill_one(
    renderer: &MetalRenderer,
    backdrop: &Backdrop,
    viewport: Size<DevicePixels>,
    encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>,
) {
    let uniforms = uniforms(backdrop, viewport, [0., 0.]);
    encoder.setRenderPipelineState(&renderer.fast_backdrop.fill_pipeline);
    draw_rect(encoder, &uniforms);
}

/// What to blur under `backdrop`: `Some(None)` the target, `Some(Some(frame))`
/// the base surface's frame with the target composited over it, `None`
/// nothing (it is filled).
fn sample(
    renderer: &mut MetalRenderer,
    backdrop: &Backdrop,
    target: &ProtocolObject<dyn MTLTexture>,
    viewport: Size<DevicePixels>,
) -> Option<Option<Texture>> {
    let state = &renderer.fast_backdrop;
    if state.in_tiles {
        return None;
    }
    let under = if state.samples_target {
        None
    } else {
        let under = state.under.as_ref()?;
        let fits = under.frame.width() == viewport.width.0 as usize
            && under.frame.height() == viewport.height.0 as usize
            && under.frame.pixelFormat() == target.pixelFormat();
        if !fits || covers(&under.covered, backdrop) {
            return None;
        }
        Some(under.frame.clone())
    };
    can_read(renderer, target).then_some(under)
}

/// Whether any of `covered` overlaps what is visible of `backdrop`.
pub(crate) fn covers(covered: &[Bounds<DevicePixels>], backdrop: &Backdrop) -> bool {
    let visible = backdrop.bounds.intersect(&backdrop.content_mask.bounds);
    covered.iter().any(|view| {
        let (left, top) = (view.left().0 as f32, view.top().0 as f32);
        let (right, bottom) = (view.right().0 as f32, view.bottom().0 as f32);
        left < visible.right().0
            && visible.left().0 < right
            && top < visible.bottom().0
            && visible.top().0 < bottom
    })
}

/// Whether `target` can be read, on a device that blurs.
fn can_read(renderer: &mut MetalRenderer, target: &ProtocolObject<dyn MTLTexture>) -> bool {
    if target.isFramebufferOnly() {
        // A drawable is only readable when its layer was asked for that
        // before handing it out; this frame fills, the next ones blur.
        if let Some(layer) = &renderer.layer {
            layer.setFramebufferOnly(false);
        }
        return false;
    }
    let device = renderer.device.clone();
    *renderer
        .fast_backdrop
        .supported
        .get_or_insert_with(|| device_blurs(&device))
}

/// Whether `device` runs Metal Performance Shaders, which blur.
pub(crate) fn device_blurs(device: &ProtocolObject<dyn MTLDevice>) -> bool {
    // SAFETY: The device is a live Metal device.
    unsafe { MPSSupportsMTLDevice(device) }.as_bool()
}

/// The whole device pixels a backdrop samples: what of it is visible, grown
/// by three standard deviations, then to whole `REGION_STEP`s, all within
/// the viewport. `None` when none of it is visible.
pub(crate) fn region(backdrop: &Backdrop, viewport: Size<DevicePixels>) -> Option<Region> {
    let visible = backdrop.bounds.intersect(&backdrop.content_mask.bounds);
    let (width, height) = (viewport.width.0 as f32, viewport.height.0 as f32);
    let margin = (sigma(backdrop) * 3.).ceil();
    let left = (visible.left().0 - margin).floor().max(0.);
    let top = (visible.top().0 - margin).floor().max(0.);
    let right = (visible.right().0 + margin).ceil().min(width);
    let bottom = (visible.bottom().0 + margin).ceil().min(height);
    let shown = visible.size.width.0 > 0.
        && visible.size.height.0 > 0.
        && visible.left().0 < width
        && visible.top().0 < height
        && visible.right().0 > 0.
        && visible.bottom().0 > 0.;
    shown.then(|| {
        let (x, width) = stepped(left, right, width);
        let (y, height) = stepped(top, bottom, height);
        Region {
            x,
            y,
            width,
            height,
        }
    })
}

/// The span from `start` to `end`, both within `0..extent`, grown to whole
/// `REGION_STEP`s or to `extent`, past `end` where there is room and back
/// from `start` where there is not.
fn stepped(start: f32, end: f32, extent: f32) -> (usize, usize) {
    let length = (((end - start) / REGION_STEP).ceil() * REGION_STEP).min(extent);
    (start.min(extent - length) as usize, length as usize)
}

/// The standard deviation a backdrop is blurred by, in device pixels,
/// rounded to `SIGMA_STEP`.
fn sigma(backdrop: &Backdrop) -> f32 {
    (backdrop.sigma.0.max(0.) / SIGMA_STEP).round() * SIGMA_STEP
}

/// What `backdrop.metal` draws with; `source_origin` is where the blurred
/// texture's first texel lies in the target.
fn uniforms(
    backdrop: &Backdrop,
    viewport: Size<DevicePixels>,
    source_origin: [f32; 2],
) -> Uniforms {
    let b = backdrop.bounds;
    let c = backdrop.content_mask.bounds;
    let r = backdrop.corner_radii;
    let f = backdrop.fallback;
    Uniforms {
        bounds: [b.left().0, b.top().0, b.right().0, b.bottom().0],
        clip: [c.left().0, c.top().0, c.right().0, c.bottom().0],
        radii: [
            r.top_left.0,
            r.top_right.0,
            r.bottom_right.0,
            r.bottom_left.0,
        ],
        fallback: [f.r, f.g, f.b, f.a],
        viewport: [viewport.width.0 as f32, viewport.height.0 as f32],
        source_origin,
        opacity: backdrop.opacity,
        padding: [0.; 3],
    }
}

fn draw_rect(encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>, uniforms: &Uniforms) {
    let length = mem::size_of::<Uniforms>();
    // SAFETY: Metal copies `length` bytes of the live uniforms into slot 0,
    // which both stages read as `BackdropUniforms`, laid out alike.
    unsafe {
        encoder.setVertexBytes_length_atIndex(NonNull::from(uniforms).cast(), length, 0);
        encoder.setFragmentBytes_length_atIndex(NonNull::from(uniforms).cast(), length, 0);
        encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 6);
    }
}

/// Ends `encoder`, then copies `region` of `target` (or of `under`, with
/// `target` composited over it) and blurs it. Returns the blurred texture,
/// whose first texel is `region`'s top left corner, or `None`, with
/// `encoder` still open, when there is nothing to blur with.
fn blur(
    renderer: &mut MetalRenderer,
    backdrop: &Backdrop,
    region: Region,
    target: &ProtocolObject<dyn MTLTexture>,
    under: Option<&Texture>,
    command_buffer: &ProtocolObject<dyn MTLCommandBuffer>,
    encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>,
) -> Result<Option<Texture>> {
    let device = renderer.device.clone();
    let format = target.pixelFormat();
    let state = &mut renderer.fast_backdrop;
    let (Some(source), Some(blurred), Some(kernel)) = (
        scratch(&device, &mut state.source, region, format),
        scratch(&device, &mut state.blurred, region, format),
        kernel(&device, &mut state.kernels, sigma(backdrop)),
    ) else {
        return Ok(None);
    };

    encoder.endEncoding();
    let blit = command_buffer
        .blitCommandEncoder()
        .context("creating a backdrop's blit encoder")?;
    // SAFETY: `region` lies within the target (it is cut to the viewport,
    // the target's size, which `under` is too) and `source` is exactly its
    // size, in the target's pixel format, which `under` has too.
    unsafe {
        blit.copyFromTexture_sourceSlice_sourceLevel_sourceOrigin_sourceSize_toTexture_destinationSlice_destinationLevel_destinationOrigin(
            under.map_or(target, |under| &**under),
            0,
            0,
            MTLOrigin { x: region.x, y: region.y, z: 0 },
            MTLSize { width: region.width, height: region.height, depth: 1 },
            &source,
            0,
            0,
            MTLOrigin { x: 0, y: 0, z: 0 },
        );
    }
    blit.endEncoding();
    if under.is_some() {
        composite(
            &renderer.fast_backdrop.composite_pipeline,
            region,
            target,
            &source,
            command_buffer,
        )?;
    }
    // SAFETY: The kernel was made for this device; `source` is readable and
    // `blurred` writable, both of one size and format.
    unsafe {
        let _: () = msg_send![
            &*kernel,
            encodeToCommandBuffer: command_buffer,
            sourceTexture: &*source,
            destinationTexture: &*blurred
        ];
    }
    Ok(Some(blurred))
}

/// Draws `region` of `overlay` over `source`, which holds the same region
/// of the frame under it: what is seen through the overlay there.
fn composite(
    pipeline: &Pipeline,
    region: Region,
    overlay: &ProtocolObject<dyn MTLTexture>,
    source: &ProtocolObject<dyn MTLTexture>,
    command_buffer: &ProtocolObject<dyn MTLCommandBuffer>,
) -> Result<()> {
    let (width, height) = (region.width as f32, region.height as f32);
    let viewport = Size {
        width: DevicePixels(region.width as i32),
        height: DevicePixels(region.height as i32),
    };
    let encoder = new_command_encoder_for_texture(command_buffer, source, viewport, None)?;
    // The blur fragment reads `overlay` at the position less
    // `source_origin`: the region's own corner, as `source` starts there.
    let uniforms = Uniforms {
        bounds: [0., 0., width, height],
        clip: [0., 0., width, height],
        radii: [0.; 4],
        fallback: [0.; 4],
        viewport: [width, height],
        source_origin: [-(region.x as f32), -(region.y as f32)],
        opacity: 1.,
        padding: [0.; 3],
    };
    encoder.setRenderPipelineState(pipeline);
    // SAFETY: The texture slot is the one the fragment reads.
    unsafe { encoder.setFragmentTexture_atIndex(Some(overlay), 0) };
    draw_rect(&encoder, &uniforms);
    encoder.endEncoding();
    Ok(())
}

/// The scratch texture in `slot`, made again unless it is `region`'s size
/// and `format`: the blur clamps at the texture's edges, so they must be the
/// region's.
fn scratch(
    device: &ProtocolObject<dyn MTLDevice>,
    slot: &mut Option<Texture>,
    region: Region,
    format: MTLPixelFormat,
) -> Option<Texture> {
    let fits = slot.as_ref().is_some_and(|texture| {
        texture.width() == region.width
            && texture.height() == region.height
            && texture.pixelFormat() == format
    });
    if !fits {
        let descriptor = MTLTextureDescriptor::new();
        // SAFETY: The region is at least a pixel each way, and this
        // describes a 2D texture.
        unsafe {
            descriptor.setWidth(region.width);
            descriptor.setHeight(region.height);
        }
        descriptor.setPixelFormat(format);
        descriptor.setUsage(
            MTLTextureUsage::ShaderRead
                | MTLTextureUsage::ShaderWrite
                | MTLTextureUsage::RenderTarget,
        );
        descriptor.setStorageMode(MTLStorageMode::Private);
        *slot = device.newTextureWithDescriptor(&descriptor);
        if slot.is_none() {
            log::error!("failed to allocate a {region:?} backdrop texture");
        }
    }
    slot.clone()
}

/// The blur kernel for `sigma` device pixels, made on first use.
fn kernel(
    device: &ProtocolObject<dyn MTLDevice>,
    kernels: &mut Vec<Kernel>,
    sigma: f32,
) -> Option<Retained<AnyObject>> {
    let key = sigma.to_bits();
    if let Some(kernel) = kernels.iter().find(|kernel| kernel.sigma == key) {
        return Some(kernel.blur.clone());
    }
    let class = AnyClass::get(c"MPSImageGaussianBlur")?;
    // SAFETY: `MPSImageGaussianBlur` is an `MPSUnaryImageKernel` whose
    // designated initializer takes a device and a standard deviation in
    // pixels; `edgeMode` is an `NSUInteger` property.
    let blur: Retained<AnyObject> = unsafe {
        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        let blur: Option<Retained<AnyObject>> =
            msg_send![allocated, initWithDevice: device, sigma: sigma];
        let blur = blur?;
        let _: () = msg_send![&*blur, setEdgeMode: EDGE_MODE_CLAMP];
        blur
    };
    if kernels.len() >= MAX_KERNELS {
        kernels.clear();
    }
    kernels.push(Kernel {
        sigma: key,
        blur: blur.clone(),
    });
    Some(blur)
}

#[cfg(test)]
#[path = "backdrop_tests.rs"]
mod tests;
