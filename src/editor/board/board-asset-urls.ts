import { iconTypes, type TLUiAssetUrlOverrides } from "tldraw";
// tldraw's defaults point every font, icon, translation and embed icon at
// https://cdn.tldraw.com. The app CSP only allows `font-src 'self' data:`, so
// the CDN fonts fail and text falls back; the rest would still leave a local
// app depending on a third-party CDN. These are the same files from the
// matching @tldraw/assets release, bundled by Vite and served from 'self'.
// Keep @tldraw/assets pinned to the tldraw version (board-asset-urls.test.ts).
import monoMedium from "@tldraw/assets/fonts/IBMPlexMono-Medium.woff2?url";
import monoMediumItalic from "@tldraw/assets/fonts/IBMPlexMono-MediumItalic.woff2?url";
import monoBold from "@tldraw/assets/fonts/IBMPlexMono-Bold.woff2?url";
import monoBoldItalic from "@tldraw/assets/fonts/IBMPlexMono-BoldItalic.woff2?url";
import serifMedium from "@tldraw/assets/fonts/IBMPlexSerif-Medium.woff2?url";
import serifMediumItalic from "@tldraw/assets/fonts/IBMPlexSerif-MediumItalic.woff2?url";
import serifBold from "@tldraw/assets/fonts/IBMPlexSerif-Bold.woff2?url";
import serifBoldItalic from "@tldraw/assets/fonts/IBMPlexSerif-BoldItalic.woff2?url";
import sansMedium from "@tldraw/assets/fonts/IBMPlexSans-Medium.woff2?url";
import sansMediumItalic from "@tldraw/assets/fonts/IBMPlexSans-MediumItalic.woff2?url";
import sansBold from "@tldraw/assets/fonts/IBMPlexSans-Bold.woff2?url";
import sansBoldItalic from "@tldraw/assets/fonts/IBMPlexSans-BoldItalic.woff2?url";
import drawRegular from "@tldraw/assets/fonts/Shantell_Sans-Informal_Regular.woff2?url";
import drawRegularItalic from "@tldraw/assets/fonts/Shantell_Sans-Informal_Regular_Italic.woff2?url";
import drawBold from "@tldraw/assets/fonts/Shantell_Sans-Informal_Bold.woff2?url";
import drawBoldItalic from "@tldraw/assets/fonts/Shantell_Sans-Informal_Bold_Italic.woff2?url";
import iconSprite from "@tldraw/assets/icons/icon/0_merged.svg?url";
// tldraw fetch()es translations, and connect-src has no `data:`: never inline
// them (en.json is 3 bytes, well under Vite's inline limit).
import enTranslation from "@tldraw/assets/translations/en.json?url&no-inline";
import zhCnTranslation from "@tldraw/assets/translations/zh-cn.json?url&no-inline";
import canvaIcon from "@tldraw/assets/embed-icons/canva.png?url";
import codepenIcon from "@tldraw/assets/embed-icons/codepen.png?url";
import codesandboxIcon from "@tldraw/assets/embed-icons/codesandbox.png?url";
import desmosIcon from "@tldraw/assets/embed-icons/desmos.png?url";
import feltIcon from "@tldraw/assets/embed-icons/felt.png?url";
import figmaIcon from "@tldraw/assets/embed-icons/figma.png?url";
import githubGistIcon from "@tldraw/assets/embed-icons/github_gist.png?url";
import googleCalendarIcon from "@tldraw/assets/embed-icons/google_calendar.png?url";
import googleMapsIcon from "@tldraw/assets/embed-icons/google_maps.png?url";
import googleSlidesIcon from "@tldraw/assets/embed-icons/google_slides.png?url";
import observableIcon from "@tldraw/assets/embed-icons/observable.png?url";
import replitIcon from "@tldraw/assets/embed-icons/replit.png?url";
import scratchIcon from "@tldraw/assets/embed-icons/scratch.png?url";
import spotifyIcon from "@tldraw/assets/embed-icons/spotify.png?url";
import tldrawIcon from "@tldraw/assets/embed-icons/tldraw.png?url";
import valTownIcon from "@tldraw/assets/embed-icons/val_town.png?url";
import vimeoIcon from "@tldraw/assets/embed-icons/vimeo.png?url";
import youtubeIcon from "@tldraw/assets/embed-icons/youtube.png?url";

/**
 * Only the locales BoardEditor can select are bundled; tldraw fetches `en`
 * as the base for every locale, so it is always required.
 */
export const boardAssetUrls = {
  fonts: {
    tldraw_mono: monoMedium,
    tldraw_mono_italic: monoMediumItalic,
    tldraw_mono_bold: monoBold,
    tldraw_mono_italic_bold: monoBoldItalic,
    tldraw_serif: serifMedium,
    tldraw_serif_italic: serifMediumItalic,
    tldraw_serif_bold: serifBold,
    tldraw_serif_italic_bold: serifBoldItalic,
    tldraw_sans: sansMedium,
    tldraw_sans_italic: sansMediumItalic,
    tldraw_sans_bold: sansBold,
    tldraw_sans_italic_bold: sansBoldItalic,
    tldraw_draw: drawRegular,
    tldraw_draw_italic: drawRegularItalic,
    tldraw_draw_bold: drawBold,
    tldraw_draw_italic_bold: drawBoldItalic,
  },
  icons: Object.fromEntries(iconTypes.map((name) => [name, `${iconSprite}#${name}`])),
  translations: { en: enTranslation, "zh-cn": zhCnTranslation },
  embedIcons: {
    canva: canvaIcon,
    codepen: codepenIcon,
    codesandbox: codesandboxIcon,
    desmos: desmosIcon,
    felt: feltIcon,
    figma: figmaIcon,
    github_gist: githubGistIcon,
    google_calendar: googleCalendarIcon,
    google_maps: googleMapsIcon,
    google_slides: googleSlidesIcon,
    observable: observableIcon,
    replit: replitIcon,
    scratch: scratchIcon,
    spotify: spotifyIcon,
    tldraw: tldrawIcon,
    val_town: valTownIcon,
    vimeo: vimeoIcon,
    youtube: youtubeIcon,
  },
} satisfies TLUiAssetUrlOverrides;
