//! The math island's page (`gpui/islands/math/`), loaded into a WKWebView no
//! window holds, which sets one formula at a time with KaTeX and is
//! photographed: WebKit's own snapshot of the formula's box, transparent
//! around the ink, at the screen's scale. The card draws the picture, so it
//! shows what the Tauri app's card shows, pixel for pixel, without a page
//! over the editor.
//!
//! - **Loading.** The page is the built island on disk
//!   ([`crate::structured::resources::islands_dir`]), loaded as a file with
//!   read access to the built folder: its module chunks and KaTeX's fonts
//!   are its siblings there. WebKit refuses module scripts from `file:`
//!   URLs unless `allowFileAccessFromFileURLs` is on, which only this page's
//!   webview turns on; it loads nothing else and runs no other script.
//! - **One at a time.** The page has one formula box, so requests queue and
//!   each is set, measured and photographed before the next is set.
//! - **Macros.** The project's TeX sources go to the page when they change,
//!   which reads its macros with the Tauri app's `katexMacrosFromSources`.
//! - **Idle.** A page nothing has asked of for [`IDLE`] is dropped with its
//!   WebContent process, and loaded again on the next request (about 250 ms;
//!   a formula on a loaded page takes 2-7 ms).
//!
//! The first picture on a cold page costs the load; every picture after is
//! the card's cache, keyed by the formula, its size, ink and macros
//! (`lattice_editor::latex::previews`).

use std::{cell::Cell, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context as _, Result, anyhow, bail};
use block2::RcBlock;
use futures::{
    FutureExt as _, StreamExt as _,
    channel::{mpsc, oneshot},
};
use gpui::{App, AsyncApp, RenderImage, Rgba, px};
use lattice_editor::latex::previews::{MacroSources, MathPicture, MathRequest};
use objc2::{
    class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyObject, Bool},
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use serde_json::json;

/// How long an unused page is kept.
const IDLE: Duration = Duration::from_secs(60);
/// How long a page has to report ready.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10);
/// The page's viewport: room for the largest formula a card shows.
const VIEWPORT: (f64, f64) = (1600., 1200.);

struct Job {
    request: MathRequest,
    reply: oneshot::Sender<Option<MathPicture>>,
}

/// The queue the page works through.
pub struct MathPage {
    jobs: mpsc::UnboundedSender<Job>,
}

impl MathPage {
    /// The page's queue, worked on the main thread, where WebKit wants it.
    pub fn start(cx: &mut App) -> Self {
        let (jobs, mut queue) = mpsc::unbounded::<Job>();
        cx.spawn(async move |cx| {
            let mut page: Option<Page> = None;
            loop {
                let next = if page.is_some() {
                    let idle = cx.background_executor().timer(IDLE).fuse();
                    futures::pin_mut!(idle);
                    futures::select_biased! {
                        job = queue.next() => job,
                        _ = idle => {
                            page = None;
                            continue;
                        }
                    }
                } else {
                    queue.next().await
                };
                let Some(job) = next else { break };
                if page.is_none() {
                    match Page::load(cx).await {
                        Ok(loaded) => page = Some(loaded),
                        Err(error) => log::warn!("the math page did not load: {error:#}"),
                    }
                }
                let picture = match &mut page {
                    Some(loaded) => match loaded.picture(&job.request).await {
                        Ok(picture) => picture,
                        Err(error) => {
                            log::warn!("the math page could not set a formula: {error:#}");
                            // A page that failed is loaded afresh next time.
                            page = None;
                            None
                        }
                    },
                    None => None,
                };
                job.reply.send(picture).ok();
            }
        })
        .detach();
        Self { jobs }
    }

    /// KaTeX's picture of `request`; `None` when KaTeX cannot set it or the
    /// page is not there.
    pub fn picture(&self, request: MathRequest) -> oneshot::Receiver<Option<MathPicture>> {
        let (reply, picture) = oneshot::channel();
        self.jobs.unbounded_send(Job { request, reply }).ok();
        picture
    }
}

/// The built page, from the islands folder.
fn page_path() -> Option<(PathBuf, PathBuf)> {
    let dist = crate::structured::resources::islands_dir()?;
    let page = dist.join("math/index.html");
    page.is_file().then_some((page, dist))
}

/// A CSS colour for `color`.
fn css(color: gpui::Hsla) -> String {
    let Rgba { r, g, b, a } = Rgba::from(color);
    let channel = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
    format!("rgba({}, {}, {}, {a})", channel(r), channel(g), channel(b))
}

struct Page {
    webview: Retained<AnyObject>,
    /// The sources the page last read its macros from.
    macros: u64,
    scale: f64,
}

impl Page {
    async fn load(cx: &mut AsyncApp) -> Result<Self> {
        let (file, dist) = page_path().context("the math island is not built")?;
        // SAFETY: on the main thread; every object is checked before use.
        let (webview, scale) = unsafe {
            let config: Retained<AnyObject> = msg_send![class!(WKWebViewConfiguration), new];
            let preferences: *mut AnyObject = msg_send![&*config, preferences];
            let yes: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithBool: Bool::YES];
            let no: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithBool: Bool::NO];
            let key = NSString::from_str("allowFileAccessFromFileURLs");
            let _: () = msg_send![preferences, setValue: &*yes, forKey: &*key];
            let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(VIEWPORT.0, VIEWPORT.1));
            let allocated: Allocated<AnyObject> = msg_send![class!(WKWebView), alloc];
            let webview: Option<Retained<AnyObject>> =
                msg_send![allocated, initWithFrame: frame, configuration: &*config];
            let webview = webview.context("WebKit made no webview")?;
            // Transparent around the ink: the card's surface shows through.
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![&*webview, setValue: &*no, forKey: &*key];
            let url: Retained<AnyObject> = msg_send![
                class!(NSURL),
                fileURLWithPath: &*NSString::from_str(&file.to_string_lossy())
            ];
            let folder: Retained<AnyObject> = msg_send![
                class!(NSURL),
                fileURLWithPath: &*NSString::from_str(&dist.to_string_lossy())
            ];
            let _: Option<Retained<AnyObject>> =
                msg_send![&*webview, loadFileURL: &*url, allowingReadAccessToURL: &*folder];
            let screen: *mut AnyObject = msg_send![class!(NSScreen), mainScreen];
            let scale: f64 = if screen.is_null() {
                2.
            } else {
                msg_send![screen, backingScaleFactor]
            };
            (webview, scale.max(2.))
        };
        let page = Self {
            webview,
            macros: u64::MAX,
            scale,
        };
        let started = std::time::Instant::now();
        loop {
            let ready = page
                .call(
                    "return window.latticeMath ? await window.latticeMath.ready() : false",
                    &[],
                )
                .await;
            if matches!(ready, Ok(Some(ref value)) if value == "1" || value == "true") {
                break;
            }
            if started.elapsed() > LOAD_TIMEOUT {
                bail!("the page was not ready in {LOAD_TIMEOUT:?}: {ready:?}");
            }
            cx.background_executor()
                .timer(Duration::from_millis(25))
                .await;
        }
        log::info!("the math page loaded in {:?}", started.elapsed());
        Ok(page)
    }

    async fn picture(&mut self, request: &MathRequest) -> Result<Option<MathPicture>> {
        self.read_macros(&request.macros).await?;
        let payload = json!({
            "tex": request.tex,
            "display": request.display,
            "size": f32::from(request.size),
            "color": css(request.color),
        });
        let boxed = self
            .call(
                "return JSON.stringify(await latticeMath.render(JSON.parse(request)))",
                &[("request", payload.to_string())],
            )
            .await?
            .context("the page answered nothing")?;
        let Some(found) = serde_json::from_str::<Option<serde_json::Value>>(&boxed)? else {
            return Ok(None);
        };
        let number = |key: &str| found.get(key).and_then(serde_json::Value::as_f64);
        let (Some(x), Some(y), Some(width), Some(height)) =
            (number("x"), number("y"), number("width"), number("height"))
        else {
            bail!("the page measured no box: {boxed}");
        };
        let (width, height) = (width.ceil(), height.ceil());
        let png = self.snapshot(x, y, width, height).await?;
        Ok(Some(MathPicture {
            image: decode(&png)?,
            width: px(width as f32),
            height: px(height as f32),
        }))
    }

    /// Give the page `macros`' sources, unless it has them already.
    async fn read_macros(&mut self, macros: &MacroSources) -> Result<()> {
        if self.macros == macros.generation {
            return Ok(());
        }
        let sources = serde_json::to_string(&*macros.sources)?;
        self.call(
            "latticeMath.setSources(JSON.parse(sources)); return true",
            &[("sources", sources)],
        )
        .await?;
        self.macros = macros.generation;
        Ok(())
    }

    /// Run `body` as an async function of `arguments` (each a string) in the
    /// page; its result, when it is a string or a number.
    async fn call(&self, body: &str, arguments: &[(&str, String)]) -> Result<Option<String>> {
        let (sender, receiver) = oneshot::channel::<Result<Option<String>>>();
        let sender = Cell::new(Some(sender));
        let done = RcBlock::new(move |value: *mut AnyObject, error: *mut AnyObject| {
            let Some(sender) = sender.take() else { return };
            // SAFETY: WebKit calls this once, on the main thread, with
            // objects that live for the call.
            let result = unsafe {
                if !error.is_null() {
                    let description: Retained<NSString> = msg_send![error, localizedDescription];
                    Err(anyhow!("{description}"))
                } else {
                    Ok(describe(value))
                }
            };
            sender.send(result).ok();
        });
        // SAFETY: on the main thread; the block is retained by WebKit until
        // it has run.
        unsafe {
            let keys: Vec<Retained<NSString>> = arguments
                .iter()
                .map(|(key, _)| NSString::from_str(key))
                .collect();
            let values: Vec<Retained<NSString>> = arguments
                .iter()
                .map(|(_, value)| NSString::from_str(value))
                .collect();
            let object = |string: &Retained<NSString>| Retained::as_ptr(string) as *mut AnyObject;
            let key_pointers: Vec<*mut AnyObject> = keys.iter().map(object).collect();
            let value_pointers: Vec<*mut AnyObject> = values.iter().map(object).collect();
            let dictionary: Retained<AnyObject> = msg_send![
                class!(NSDictionary),
                dictionaryWithObjects: value_pointers.as_ptr(),
                forKeys: key_pointers.as_ptr(),
                count: arguments.len()
            ];
            let world: Retained<AnyObject> = msg_send![class!(WKContentWorld), pageWorld];
            let frame: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![
                &*self.webview,
                callAsyncJavaScript: &*NSString::from_str(body),
                arguments: &*dictionary,
                inFrame: frame,
                inContentWorld: &*world,
                completionHandler: &*done
            ];
        }
        receiver.await.context("WebKit dropped the call")?
    }

    /// WebKit's picture of the page's box at `x, y`, `width` by `height`
    /// CSS pixels, as PNG bytes at the screen's scale.
    async fn snapshot(&self, x: f64, y: f64, width: f64, height: f64) -> Result<Vec<u8>> {
        let (sender, receiver) = oneshot::channel::<Result<Vec<u8>>>();
        let sender = Cell::new(Some(sender));
        let done = RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
            let Some(sender) = sender.take() else { return };
            // SAFETY: as in `call`.
            let result = unsafe { png_of(image, error) };
            sender.send(result).ok();
        });
        // SAFETY: on the main thread; the block is retained by WebKit until
        // it has run.
        unsafe {
            let configuration: Retained<AnyObject> =
                msg_send![class!(WKSnapshotConfiguration), new];
            let rect = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
            let _: () = msg_send![&*configuration, setRect: rect];
            let pixels: Retained<AnyObject> =
                msg_send![class!(NSNumber), numberWithDouble: width * self.scale];
            let _: () = msg_send![&*configuration, setSnapshotWidth: &*pixels];
            let _: () = msg_send![
                &*self.webview,
                takeSnapshotWithConfiguration: &*configuration,
                completionHandler: &*done
            ];
        }
        receiver.await.context("WebKit dropped the snapshot")?
    }
}

/// The snapshot's PNG as the BGRA frame GPUI draws.
fn decode(png: &[u8]) -> Result<Arc<RenderImage>> {
    let mut pixels =
        image::load_from_memory_with_format(png, image::ImageFormat::Png)?.into_rgba8();
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    Ok(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(pixels)
    ])))
}

/// A script's result as text: a string as it is, a number or boolean as
/// its description; `None` for anything else.
///
/// # Safety
/// On the main thread, with `value` null or a live object.
unsafe fn describe(value: *mut AnyObject) -> Option<String> {
    if value.is_null() {
        return None;
    }
    // SAFETY: `value` is a live object (the caller's promise).
    unsafe {
        let is_string: Bool = msg_send![value, isKindOfClass: class!(NSString)];
        let is_number: Bool = msg_send![value, isKindOfClass: class!(NSNumber)];
        if !is_string.as_bool() && !is_number.as_bool() {
            return None;
        }
        let text: Retained<NSString> = msg_send![value, description];
        Some(text.to_string())
    }
}

/// The snapshot `image` (an `NSImage`) as PNG bytes.
///
/// # Safety
/// On the main thread, with each argument null or a live object.
unsafe fn png_of(image: *mut AnyObject, error: *mut AnyObject) -> Result<Vec<u8>> {
    // SAFETY: each object is live (the caller's promise) and checked.
    unsafe {
        if !error.is_null() {
            let description: Retained<NSString> = msg_send![error, localizedDescription];
            bail!("{description}");
        }
        if image.is_null() {
            bail!("WebKit took no snapshot");
        }
        let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
        if tiff.is_null() {
            bail!("the snapshot has no bitmap");
        }
        let bitmap: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
        if bitmap.is_null() {
            bail!("the snapshot's bitmap could not be read");
        }
        let properties: Retained<AnyObject> = msg_send![class!(NSDictionary), dictionary];
        // NSBitmapImageFileTypePNG.
        let png: *mut AnyObject =
            msg_send![bitmap, representationUsingType: 4usize, properties: &*properties];
        if png.is_null() {
            bail!("the snapshot could not be written as PNG");
        }
        let length: usize = msg_send![png, length];
        let bytes: *const std::ffi::c_void = msg_send![png, bytes];
        if bytes.is_null() || length == 0 {
            bail!("the snapshot's PNG is empty");
        }
        Ok(std::slice::from_raw_parts(bytes.cast::<u8>(), length).to_vec())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn inks_are_css_colours() {
        assert_eq!(super::css(gpui::hsla(0., 0., 0., 1.)), "rgba(0, 0, 0, 1)");
        assert_eq!(
            super::css(gpui::hsla(0., 0., 1., 0.5)),
            "rgba(255, 255, 255, 0.5)"
        );
    }
}
