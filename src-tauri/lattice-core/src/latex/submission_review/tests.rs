use super::*;
use crate::test_support::TempDir;

/// A project holding `files`, reviewed from `main.tex`.
fn review(files: &[(&str, &str)]) -> SubmissionReview {
    let dir = TempDir::new("submission-review");
    for (path, contents) in files {
        dir.write(path, contents);
    }
    review_document(&dir, "main.tex")
}

fn found(review: &SubmissionReview) -> Vec<(Check, Option<u32>, &str)> {
    review
        .findings
        .iter()
        .map(|finding| (finding.check, finding.line, finding.text.as_str()))
        .collect()
}

const NEURIPS: &str = "\\documentclass{article}\n\\usepackage{neurips_2026}\n";

#[test]
fn reads_each_templates_review_switch() {
    let cases = [
        ("NeurIPS anonymous", "\\usepackage{neurips_2026}", ReviewMode::Anonymous),
        ("NeurIPS preprint", "\\usepackage[preprint]{neurips_2026}", ReviewMode::AuthorsShown),
        (
            "NeurIPS track",
            "\\usepackage[main, nonanonymous]{neurips_2026}",
            ReviewMode::AuthorsShown,
        ),
        ("NeurIPS final", "\\usepackage[final]{neurips_2026}", ReviewMode::CameraReady),
        ("ICML anonymous", "\\usepackage{icml2026}", ReviewMode::Anonymous),
        ("ICML preprint", "\\usepackage[preprint]{icml2026}", ReviewMode::AuthorsShown),
        ("ICML accepted", "\\usepackage[accepted]{icml2026}", ReviewMode::CameraReady),
        ("ICLR anonymous", "\\usepackage{iclr2026_conference,times}", ReviewMode::Anonymous),
        (
            "ICLR final",
            "\\usepackage{iclr2026_conference}\n\\iclrfinalcopy",
            ReviewMode::CameraReady,
        ),
        (
            "ICLR final commented out",
            "\\usepackage{iclr2026_conference}\n% \\iclrfinalcopy",
            ReviewMode::Anonymous,
        ),
    ];
    for (case, preamble, mode) in cases {
        let main = format!(
            "\\documentclass{{article}}\n{preamble}\n\\begin{{document}}\n\\end{{document}}\n"
        );
        assert_eq!(review(&[("main.tex", &main)]).mode, Some(mode), "{case}");
    }
}

#[test]
fn a_shown_author_list_points_at_the_switch() {
    let review =
        review(&[("main.tex", "\\documentclass{article}\n\\usepackage[preprint]{neurips_2026}\n")]);
    assert_eq!(
        found(&review),
        vec![(Check::AuthorsShown, Some(2), "\\usepackage[preprint]{neurips_2026}")]
    );
}

#[test]
fn no_double_blind_checks_without_a_double_blind_template() {
    let main = "\\documentclass{article}\n\\section*{Acknowledgments}\nSee github.com/jdoe/tool.\n";
    let plain = review(&[("main.tex", main)]);
    assert_eq!((plain.venue, plain.mode), (None, None));
    assert!(plain.findings.is_empty());
    // CVPR is double-blind too, but its switches are not read yet.
    let cvpr = review(&[("main.tex", &main.replace("article}", "article}\n\\usepackage{cvpr}"))]);
    assert_eq!((cvpr.venue, cvpr.mode), (Some("CVPR"), None));
}

#[test]
fn finds_what_names_the_authors_in_typeset_source() {
    let main = format!(
        "{NEURIPS}\\title{{Attention\\thanks{{Work done at Acme.}}}}\n\\author{{Jane Doe\\thanks{{Hidden by the style.}} \\\\ Acme}}\n\\begin{{document}}\nCode: \\url{{https://github.com/janedoe/attn}} and \\url{{https://github.com/anonymous/attn}}.\nAs shown in our previous work~\\cite{{doe}}, it helps.\nWe previously proposed a variant.\n% Our earlier paper \\cite{{doe2}} is not typeset.\n\\section*{{Acknowledgments}}\nThanks to Acme.\n\\end{{document}}\n"
    );
    let review = review(&[("main.tex", &main)]);
    assert_eq!(review.mode, Some(ReviewMode::Anonymous));
    assert_eq!(
        found(&review),
        vec![
            (Check::Thanks, Some(3), "\\title{Attention\\thanks{Work done at Acme.}}"),
            (Check::IdentifyingLink, Some(6), "github.com/janedoe/attn"),
            (Check::SelfCitation, Some(7), "As shown in our previous work~\\cite{doe}, it helps."),
            (Check::SelfCitation, Some(8), "We previously proposed a variant."),
            (Check::Acknowledgements, Some(10), "\\section*{Acknowledgments}"),
        ]
    );
}

#[test]
fn leaves_alone_what_a_camera_ready_switch_gates() {
    let main = format!(
        "{NEURIPS}\\newif\\ifcameraready\n\\begin{{document}}\n\\begin{{ack}}\nThanks to Acme.\n\\end{{ack}}\n\\ifcameraready\n\\section*{{Acknowledgments}}\n\\input{{credits}}\n\\fi\n\\iffalse\nSee github.com/janedoe/attn.\n\\fi\n\\ifdefined\\isaccepted \\section*{{Acknowledgements}}\\fi\n\\ifmmode x\\fi Our prior work stands.\n\\end{{document}}\n"
    );
    let review = review(&[("main.tex", &main), ("credits.tex", "Funded by github.com/janedoe.\n")]);
    // Only the line outside every switch: \ifmmode tests no switch.
    assert_eq!(
        found(&review),
        vec![(Check::SelfCitation, Some(16), "\\ifmmode x\\fi Our prior work stands.")]
    );
}

#[test]
fn reads_inputs_where_they_are_input() {
    let main =
        format!("{NEURIPS}\\begin{{document}}\n\\input{{sections/intro}}\n\\end{{document}}\n");
    let review = review(&[
        ("main.tex", &main),
        ("sections/intro.tex", "Intro.\n\\subsection*{Acknowledgement}\n"),
    ]);
    let finding = &review.findings[0];
    assert_eq!(
        (finding.check, finding.file.as_deref(), finding.line),
        (Check::Acknowledgements, Some("sections/intro.tex"), Some(2))
    );
}

#[test]
fn a_camera_ready_copy_skips_the_anonymity_checks() {
    let main = "\\documentclass{article}\n\\usepackage[final]{neurips_2026}\n\\section*{Acknowledgments}\n";
    let review = review(&[("main.tex", main)]);
    assert_eq!(review.mode, Some(ReviewMode::CameraReady));
    assert!(review.findings.is_empty());
}

/// A PDF of `objects`, whose `metadata` is an XMP stream.
fn pdf(objects: &str, metadata: &str) -> Vec<u8> {
    format!(
        "%PDF-1.5\n{objects}\n9 0 obj\n<< /Type /Metadata /Subtype /XML /Length {} >>\nstream\n{metadata}\nendstream\nendobj\n%%EOF\n",
        metadata.len()
    )
    .into_bytes()
}

#[test]
fn reads_author_names_and_font_problems_from_the_pdf() {
    let objects = concat!(
        "1 0 obj << /Producer (pdfTeX) /Author (Jane Doe \\(Acme\\)) >> endobj\n",
        "2 0 obj << /Author <FEFF004A006F> >> endobj\n",
        "3 0 obj << /Author (Anonymous Authors) >> endobj\n",
        "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+NimbusRomNo9L-Regu /FontDescriptor 5 0 R >> endobj\n",
        "5 0 obj << /Type /FontDescriptor /FontName /ABCDEF+NimbusRomNo9L-Regu /FontFile 6 0 R >> endobj\n",
        "7 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
        "8 0 obj << /Type /Font /Subtype /Type3 /Name /DejaVuSans /CharProcs << /a 10 0 R >> >> endobj\n",
        "11 0 obj << /Type /FontDescriptor /FontName /ArialMT >> endobj\n",
    );
    let xmp = "<rdf:Description><dc:creator><rdf:Seq><rdf:li>R&amp;D Lab</rdf:li></rdf:Seq></dc:creator></rdf:Description>";
    let dir = TempDir::new("submission-review-pdf");
    dir.write(
        "main.tex",
        "\\documentclass{article}\n\\usepackage{icml2026}\n\\hypersetup{pdfauthor={Jane Doe}}\n",
    );
    dir.write("main.pdf", pdf(objects, xmp));
    let review = review_document(&dir, "main.tex");
    assert!(review.pdf && review.fonts_read);
    let names = |check| {
        review
            .findings
            .iter()
            .filter(|finding| finding.check == check)
            .map(|finding| finding.text.as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(Check::PdfAuthor), ["Jane Doe (Acme)", "Jo", "R&D Lab"]);
    assert_eq!(names(Check::Type3Font), ["DejaVuSans"]);
    assert_eq!(names(Check::UnembeddedFont), ["ArialMT", "Helvetica"]);
    // A name in the metadata is fixed where the source sets it.
    let author = review.findings.iter().find(|finding| finding.check == Check::PdfAuthor).unwrap();
    assert_eq!((author.file.as_deref(), author.line), (Some("main.tex"), Some(3)));
}

#[test]
fn a_paper_with_no_conference_template_gets_only_the_font_checks() {
    let dir = TempDir::new("submission-review-fonts");
    dir.write("main.tex", "\\documentclass{article}\n");
    dir.write("main.pdf", pdf("1 0 obj << /Author (Jane Doe) >> endobj\n2 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj", ""));
    let review = review_document(&dir, "main.tex");
    assert_eq!(found(&review), vec![(Check::UnembeddedFont, None, "Helvetica")]);
}
