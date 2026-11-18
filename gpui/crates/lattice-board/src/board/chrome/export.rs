// Lattice's own (not copied from quiet.md): the board's image export, after
// Excalidraw \`ImageExportDialog.tsx\` @ 3a317b5 (MIT License, Copyright (c)
// 2020 Excalidraw), as the Tauri app's board shows it.

//! "Export image" (\`actionChangeExportScale\` & co., ⇧⌘E): a dialog with the
//! picture as it will be exported on the left, and on the right the options
//! upstream offers (only the selection, the background, dark mode, the scene
//! embedded, the scale) over PNG, SVG and Copy to clipboard. Saving asks
//! where with the system's save panel, starting in the board's folder with
//! the board's name. Differs: no file-name field (the save panel names the
//! file), and the scale applies to the PNG and the clipboard only, as the
//! SVG is drawn at any size.

use super::*;
use crate::board::BoardView;
use crate::board::run::{embed_in_svg, picture, rasterize};
use crate::settings::tr;
use std::sync::Arc;

/// The preview is drawn at most this many pixels long.
const PREVIEW_PX: f32 = 1200.;

#[derive(Clone, Debug)]
pub(crate) struct ExportImage {
    pub(crate) only_selected: bool,
    pub(crate) background: bool,
    pub(crate) dark: bool,
    pub(crate) embed: bool,
    pub(crate) scale: u8,
    preview: Option<(u64, Option<Arc<Image>>)>,
}

impl ExportImage {
    fn new(me: &BoardView) -> Self {
        ExportImage {
            only_selected: !me.app.selected_element_ids.is_empty(),
            background: true,
            dark: crate::theme::dark(),
            embed: false,
            scale: 2,
            preview: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Png,
    Svg,
    Clipboard,
}

impl BoardView {
    pub(crate) fn toggle_export_image(&mut self, cx: &mut Context<Self>) {
        self.export = match self.export {
            Some(_) => None,
            None => Some(ExportImage::new(self)),
        };
        cx.notify();
    }

    fn export_option(&mut self, set: impl FnOnce(&mut ExportImage), cx: &mut Context<Self>) {
        if let Some(e) = self.export.as_mut() {
            set(e);
            cx.notify();
        }
    }

    /// The picture with the dialog's options: the SVG (dark mode as upstream's
    /// root filter, for the SVG file) and the scene.
    fn export_picture(&self, e: &ExportImage, svg_dark: bool) -> Option<(String, String)> {
        let selected = e.only_selected && !self.app.selected_element_ids.is_empty();
        picture(self, selected, e.background, svg_dark && e.dark)
    }

    fn export(&mut self, format: Format, cx: &mut Context<Self>) {
        let Some(e) = self.export.clone() else { return };
        let Some((svg, scene)) = self.export_picture(&e, format == Format::Svg) else {
            return;
        };
        let bytes = match format {
            Format::Svg => (if e.embed {
                embed_in_svg(&svg, &scene)
            } else {
                svg
            })
            .into_bytes(),
            Format::Png | Format::Clipboard => {
                let Some(png) = rasterize(&svg, e.scale as f32, e.dark) else {
                    return;
                };
                if e.embed {
                    match crate::board::encode::encode_png_metadata(&png, &scene) {
                        Ok(png) => png,
                        Err(_) => png,
                    }
                } else {
                    png
                }
            }
        };
        if format == Format::Clipboard {
            cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
                ImageFormat::Png,
                bytes,
            )));
            self.export = None;
            cx.notify();
            return;
        }
        let (dir, stem) = self.export_target.clone().unwrap_or_else(|| {
            (
                std::env::var_os("HOME").map(Into::into).unwrap_or_default(),
                "board".into(),
            )
        });
        let name = format!(
            "{stem}.{}",
            if format == Format::Svg { "svg" } else { "png" }
        );
        let chosen = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn(async move |me, cx| {
            let Ok(Ok(Some(path))) = chosen.await else {
                return;
            };
            if let Err(err) = std::fs::write(&path, bytes) {
                log::warn!(
                    "board: the image could not be written to {}: {err}",
                    path.display()
                );
                return;
            }
            let _ = me.update(cx, |me, cx| {
                me.export = None;
                cx.notify();
            });
        })
        .detach();
    }

    /// The preview's PNG, drawn again when the scene or an option changes.
    fn export_preview(&mut self) -> Option<Arc<Image>> {
        use std::hash::{Hash, Hasher};
        let e = self.export.clone()?;
        let mut h = rustc_hash::FxHasher::default();
        (
            self.scene.scene_nonce(),
            e.only_selected,
            e.background,
            e.dark,
            crate::theme::dark(),
        )
            .hash(&mut h);
        self.app.selected_element_ids.len().hash(&mut h);
        let key = h.finish();
        if let Some((k, img)) = &e.preview
            && *k == key
        {
            return img.clone();
        }
        let img = self.export_picture(&e, false).and_then(|(svg, _)| {
            let size = resvg::usvg::Tree::from_str(&svg, &Default::default())
                .ok()?
                .size();
            let scale = (PREVIEW_PX / size.width().max(size.height())).min(2.);
            rasterize(&svg, scale, e.dark)
                .map(|png| Arc::new(Image::from_bytes(ImageFormat::Png, png)))
        });
        if let Some(x) = self.export.as_mut() {
            x.preview = Some((key, img.clone()));
        }
        img
    }
}

/// A labelled switch row (\`ExportSetting\` with a \`Switch\`).
fn switch_row(
    id: &'static str,
    label: &'static str,
    on: bool,
    set: impl Fn(&mut ExportImage, bool) + 'static,
    cx: &mut Context<BoardView>,
) -> impl IntoElement {
    let track = if on {
        style::primary()
    } else {
        crate::theme::palette(|p| p.line_strong)
    };
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_between()
        .h(px(32.))
        .cursor_pointer()
        .text_size(px(14.))
        .child(label)
        .child(
            div()
                .w(px(32.))
                .h(px(18.))
                .p(px(2.))
                .rounded_full()
                .bg(track)
                .flex()
                .when(on, |d| d.justify_end())
                .child(
                    div()
                        .size(px(14.))
                        .rounded_full()
                        .bg(crate::theme::palette(|p| p.raised)),
                ),
        )
        .on_click(cx.listener(move |me, _, _, cx| me.export_option(|e| set(e, !on), cx)))
}

fn button(id: &'static str, label: &'static str, primary: bool) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(36.))
        .px(px(14.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(style::RADIUS_LG))
        .cursor_pointer()
        .text_size(px(14.))
        .font_weight(FontWeight::SEMIBOLD)
        .when(primary, |d| {
            d.bg(style::primary())
                .text_color(crate::theme::palette(|p| p.accent_contrast))
                .hover(|s| s.opacity(0.9))
        })
        .when(!primary, |d| {
            d.border_1()
                .border_color(style::border())
                .hover(|s| s.bg(style::button_hover_bg()))
                .active(|s| s.bg(style::surface_high()))
        })
        .child(label)
}

pub(crate) fn render(
    me: &mut BoardView,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) -> Option<AnyElement> {
    let preview = me.export_preview();
    let e = me.export.clone()?;
    let has_selection = !me.app.selected_element_ids.is_empty();
    let scales = div().flex().gap(px(4.)).children([1u8, 2, 3].map(|s| {
        div()
            .id(("board-export-scale", s as usize))
            .w(px(36.))
            .h(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(style::RADIUS_MD))
            .cursor_pointer()
            .text_size(px(13.))
            .when(e.scale == s, |d| d.bg(style::surface_primary_container()))
            .hover(|d| d.bg(style::button_hover_bg()))
            .child(format!("{s}×"))
            .on_click(cx.listener(move |me, _, _, cx| me.export_option(|e| e.scale = s, cx)))
    }));
    let settings = div()
        .w(px(260.))
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(4.))
        .when(has_selection, |d| {
            d.child(switch_row(
                "board-export-selected",
                tr("仅导出选中", "Only selected"),
                e.only_selected,
                |e, v| e.only_selected = v,
                cx,
            ))
        })
        .child(switch_row(
            "board-export-bg",
            tr("背景", "Background"),
            e.background,
            |e, v| e.background = v,
            cx,
        ))
        .child(switch_row(
            "board-export-dark",
            tr("深色模式", "Dark mode"),
            e.dark,
            |e, v| e.dark = v,
            cx,
        ))
        .child(switch_row(
            "board-export-embed",
            tr("包含画布数据", "Embed scene"),
            e.embed,
            |e, v| e.embed = v,
            cx,
        ))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .h(px(32.))
                .text_size(px(14.))
                .child(tr("缩放比例", "Scale"))
                .child(scales),
        )
        .child(
            div()
                .mt(px(20.))
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .child(
                    button("board-export-png", "PNG", true)
                        .on_click(cx.listener(|me, _, _, cx| me.export(Format::Png, cx))),
                )
                .child(
                    button("board-export-svg", "SVG", true)
                        .on_click(cx.listener(|me, _, _, cx| me.export(Format::Svg, cx))),
                )
                .child(
                    button(
                        "board-export-copy",
                        tr("复制到剪贴板", "Copy to clipboard"),
                        false,
                    )
                    .on_click(cx.listener(|me, _, _, cx| me.export(Format::Clipboard, cx))),
                ),
        );
    let preview_box = div()
        .flex_1()
        .min_w_0()
        .h(px(360.))
        .rounded(px(style::RADIUS_LG))
        .bg(crate::theme::palette(|p| p.chrome))
        .p(px(16.))
        .flex()
        .items_center()
        .justify_center()
        .when_some(preview, |d, img| {
            d.child(gpui::img(img).size_full().object_fit(ObjectFit::Contain))
        })
        .when(e.preview.as_ref().is_some_and(|p| p.1.is_none()), |d| {
            d.text_color(style::input_label())
                .child(tr("画布为空", "The canvas is empty"))
        });
    Some(
        help::modal(
            "board-export-dialog",
            960.,
            tr("导出图片", "Export image"),
            div().flex().gap(px(24.)).child(preview_box).child(settings),
            |me, cx| me.toggle_export_image(cx),
            window,
            cx,
        )
        .into_any_element(),
    )
}
