//! Lattice ▸ About Lattice: AppKit's standard About panel, with the project's
//! links under the credits.
//!
//! Not muda's predefined About item: it hands the credits to AppKit as plain
//! text, so a URL in them is not clickable, and it drops `website` on macOS.
//! The panel's credits view opens an `NSLinkAttributeName` link in the
//! default browser itself.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAboutPanelOptionApplicationName, NSAboutPanelOptionApplicationVersion,
    NSAboutPanelOptionCredits, NSApplication, NSLinkAttributeName,
};
use objc2_foundation::{NSDictionary, NSMutableAttributedString, NSRange, NSString, NSURL};

/// Show the About panel for `name` `version`: `credits`, then each
/// `(title, url)` link on one line.
pub(crate) fn show(name: &str, version: &str, credits: &str, links: &[(&str, &str)]) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let (text, ranges) = credits_text(credits, links);
    let credits = NSMutableAttributedString::from_nsstring(&NSString::from_str(&text));
    for ((start, length), (_, url)) in ranges.into_iter().zip(links) {
        let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else { continue };
        // SAFETY: NSLinkAttributeName takes an NSURL (or NSString), and the
        // range lies inside `text`, measured in UTF-16 units as NSString is.
        unsafe {
            credits.addAttribute_value_range(
                NSLinkAttributeName,
                &url,
                NSRange::new(start, length),
            );
        }
    }
    let keys: [&NSString; 3] = unsafe {
        [
            NSAboutPanelOptionApplicationName,
            NSAboutPanelOptionApplicationVersion,
            NSAboutPanelOptionCredits,
        ]
    };
    let objects: [Retained<AnyObject>; 3] = [
        Retained::into_super(Retained::into_super(NSString::from_str(name))),
        Retained::into_super(Retained::into_super(NSString::from_str(version))),
        Retained::into_super(Retained::into_super(Retained::into_super(credits))),
    ];
    let options = NSDictionary::from_retained_objects(&keys, &objects);
    // SAFETY: every key is an About panel option with a value of its type.
    unsafe {
        NSApplication::sharedApplication(mtm).orderFrontStandardAboutPanelWithOptions(&options)
    };
}

/// The credits' text, and each link title's (start, length) in it in UTF-16
/// units, the indices NSRange counts in.
fn credits_text(credits: &str, links: &[(&str, &str)]) -> (String, Vec<(usize, usize)>) {
    let mut text = format!("{credits}\n\n");
    let mut ranges = Vec::with_capacity(links.len());
    for (index, (title, _)) in links.iter().enumerate() {
        if index > 0 {
            text.push_str("  ·  ");
        }
        let start = text.encode_utf16().count();
        text.push_str(title);
        ranges.push((start, title.encode_utf16().count()));
    }
    (text, ranges)
}

#[cfg(test)]
mod tests {
    use super::credits_text;

    #[test]
    fn link_ranges_count_utf16_units_after_the_credits() {
        let (text, ranges) = credits_text(
            "Uses Trellis",
            &[("Lattice 的 GitHub", "https://a"), ("Lattice 网站", "https://b")],
        );
        assert_eq!(text, "Uses Trellis\n\nLattice 的 GitHub  ·  Lattice 网站");
        let units: Vec<u16> = text.encode_utf16().collect();
        let titles: Vec<String> = ranges
            .iter()
            .map(|&(start, length)| String::from_utf16(&units[start..start + length]).unwrap())
            .collect();
        assert_eq!(titles, ["Lattice 的 GitHub", "Lattice 网站"]);
    }
}
