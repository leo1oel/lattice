use super::*;
use crate::papers::bundle::fetch_web_bundle;
use crate::papers::library::read_paper;
#[cfg(unix)]
use crate::papers::test_support::{fake_raw_bibcite, tool_lock, ToolOverride};
use crate::papers::test_support::{serve_once, TestProject};
#[cfg(unix)]
use crate::test_support::TempDir;

const SUPPLIED_BLOG: &str = "@misc{mirros2026sspace,\n title={S-Space: Exploring Spatial Workspace in Multimodal Models},\n author={{MirroS Team}},\n year={2026},\n month={September},\n url={https://mirros.ai/blog/s-space},\n note={Blog post}\n}";

#[test]
fn alphaxiv_citation_keeps_fields_and_supplies_a_stable_identity_and_missing_year() {
    let mut paper = crate::alphaxiv::Paper {
        version_id: "version-id".into(),
        universal_id: "2609.report".into(),
        title: "A Report".into(),
        citation_bibtex: Some("@misc{report, title={A Report}, author={{Research Team}}, url={https://example.org/announcement}, note={Keep {nested} braces}}".into()),
        publication_date: Some(1789948800000),
    };
    let raw = alphaxiv_bibtex(&paper).unwrap();
    let entry = project::parse_bibliography(&raw).remove(0);
    assert_eq!(entry.url.as_deref(), Some("https://www.alphaxiv.org/abs/2609.report"));
    assert_eq!(entry.year, "2026");
    assert!(raw.contains("note = {Keep {nested} braces}"));
    paper.title = "A different report".into();
    assert!(alphaxiv_bibtex(&paper).is_err());
}

#[test]
fn supplied_keys_follow_bibcite_arxiv_policy() {
    for (author, year, title, expected) in [
        (
            "Ashish Vaswani and Noam Shazeer",
            "2017",
            "Attention Is All You Need",
            "vaswani2017attention",
        ),
        (
            "García, María AND Other, Author",
            "2025",
            "The Éléphant in the Room",
            "garcia2025elephant",
        ),
        ("{Thinking Machines Lab}", "2026", "Introducing Inkling-Small", "lab2026introducing"),
        ("", "2026", "GLM-5.3: Frontier Coding", "anonymous2026glm53"),
        ("", "", "The and a", "anonymousXXXXthe"),
        ("李", "2024", "研究", "anon2024paper"),
    ] {
        let raw = format!(
            "@misc{{publisherKey,author={{{author}}},year={{{year}}},title={{{title}}}}}\n"
        );
        assert_eq!(supplied_citation_key(&raw), expected);
    }
}

#[test]
fn supplied_bibtex_prefers_the_page_itself_not_its_references_or_scripts() {
    let html = format!("<title>Publisher title</title><script><pre>@misc{{noise,title={{Wrong}},url={{https://mirros.ai/blog/s-space}}}}</pre></script><pre>@article{{other,title={{Other work}},url={{https://example.org/other}}}}</pre><pre><code>{SUPPLIED_BLOG}</code></pre>");
    let raw = supplied_web_bibtex(&html, "https://mirros.ai/blog/s-space#citation").unwrap();
    assert_eq!(raw, SUPPLIED_BLOG);
    let conflict = format!("{html}<code>{}</code>", SUPPLIED_BLOG.replace("2026", "2025"));
    assert!(supplied_web_bibtex(&conflict, "https://mirros.ai/blog/s-space").is_none());
    let highlighted = "<title>A &amp; B</title><pre><code><span>@misc</span>{a,title={A &amp; B},author={{A Team}}}</code></pre>";
    assert_eq!(
        supplied_web_bibtex(highlighted, "https://example.org/a").as_deref(),
        Some("@misc{a,title={A & B},author={{A Team}}}")
    );
    let broken = "<code>@misc{broken,title={Missing braces";
    assert!(supplied_web_bibtex(broken, "https://example.org/").is_none());
}

#[test]
fn a_cvf_paper_page_supplies_its_proceedings_record() {
    // The record Check citations reads from the same page (`.bibref`).
    let html = "<title>CVPR 2026 Open Access Repository</title><meta name=\"citation_title\" content=\"ROSE: Rotate Your Large Language Model to See\"><div class=\"bibref pre-white-space\">@InProceedings{Yue_2026_CVPR,<br>    author = {Yue, Tongtian and Gao, Xuange},<br>    title = {ROSE: Rotate Your Large Language Model to See},<br>    booktitle = {Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},<br>    month = {June},<br>    year = {2026},<br>    pages = {19265-19275}<br>}</div>";
    let url = "https://openaccess.thecvf.com/content/CVPR2026/html/Yue_ROSE_CVPR_2026_paper.html";
    let raw = webpage_bibtex(html, url).expect("the .bibref record");
    assert!(
        raw.starts_with("@InProceedings{Yue_2026_CVPR") && raw.contains("pages = {19265-19275}"),
        "{raw}"
    );
}

#[test]
fn supplied_web_citations_handle_html_spaces_and_note_urls() {
    let html = "<title>Atlas: A World Model | World Labs</title><pre><code>@article{atlas,<br>&nbsp;author={World Labs Team},<br>\u{202f}title={Atlas: A World Model},<br> year={2026}, note={https://www.worldlabs.ai/blog/atlas}}</code></pre>";
    let raw = supplied_web_bibtex(html, "https://www.worldlabs.ai/blog/atlas#citation")
        .expect("a matching note URL identifies the official citation despite the site suffix");
    assert!(!raw.contains(['\u{a0}', '\u{202f}']));
    assert!(raw.contains("author={World Labs Team}"));
    let raw = supplied_bibtex_with_source(raw, "https://www.worldlabs.ai/blog/atlas");
    assert!(raw.contains("url = {https://www.worldlabs.ai/blog/atlas}"));
    assert!(raw.contains("note={https://www.worldlabs.ai/blog/atlas}"));
    // A cited reference must not become the page's citation merely because
    // its title matches; an explicit conflicting source takes precedence.
    let other = "<title>Atlas: A World Model</title><pre>@article{other,title={Atlas: A World Model},note={https://example.org/other}}</pre>";
    assert!(supplied_web_bibtex(other, "https://www.worldlabs.ai/blog/atlas").is_none());
    let conflict = html.replace("year={2026}", "url={https://example.org/other},year={2026}");
    assert!(supplied_web_bibtex(&conflict, "https://www.worldlabs.ai/blog/atlas").is_none());
}

#[test]
fn webpage_citation_reads_official_nested_div_before_metadata() {
    let url = "https://generalistai.com/blog/gen-1.5";
    let html = "<meta property='og:title' content='Wrong site suffix'><div class='citation monospace'>@article&lbrace;generalist2026gen15,<br><span>author={Generalist Team},title={<span>GEN-1.5</span>: One-Shot Learners},year={2026},note={https://generalistai.com/blog/gen-1.5},</span><br>&rbrace;</div>";
    let bib = webpage_bibtex(html, url).unwrap();
    assert!(bib.starts_with("@article{generalist2026gen15,"));
    assert!(bib.contains("title={GEN-1.5: One-Shot Learners}"));
    assert!(bib.contains("url = {https://generalistai.com/blog/gen-1.5}"));
}

#[cfg(unix)]
#[test]
fn supplied_citations_keep_existing_keys_and_do_not_merge_report_with_blog() {
    let _lock = tool_lock();
    let tools = TempDir::new("papers");
    let _bibcite = ToolOverride::set(&crate::commands::BIBCITE, &fake_raw_bibcite(&tools));
    let (fresh, key, _) = merge_supplied_bibtex("", SUPPLIED_BLOG).unwrap();
    assert_eq!(key, "team2026sspace");
    assert_eq!(fresh.trim(), SUPPLIED_BLOG.replacen("mirros2026sspace", "team2026sspace", 1));
    let (unchanged, key, exists) = merge_supplied_bibtex(SUPPLIED_BLOG, SUPPLIED_BLOG).unwrap();
    assert!(exists);
    assert_eq!(key, "mirros2026sspace");
    // A re-import with nothing new leaves the entry exactly as written.
    assert_eq!(unchanged, SUPPLIED_BLOG);
    let before = "@misc{team2026sspace,title={S-Space: Exploring Spatial Workspace in Multimodal Models},url={https://mirros.ai/report/s-space.pdf}}\n";
    let (added, key, existing) = merge_supplied_bibtex(before, SUPPLIED_BLOG).unwrap();
    assert!(!existing);
    assert_eq!(key, "team2026sspace-2");
    assert!(added.starts_with(before));
    assert_eq!(project::parse_bibliography(&added).len(), 2);
    assert!(added.contains("author={{MirroS Team}}"));
    assert!(added.contains("note={Blog post}"));
    let (_, key, existing) = merge_supplied_bibtex(&added, SUPPLIED_BLOG).unwrap();
    assert!(existing);
    assert_eq!(key, "team2026sspace-2");
    let old = "@misc{keepMyKey,title={Old},author={{User Team}},year={2024},url={https://example.org/a.pdf},note={Imported from PDF; bibliographic metadata needs review},keywords={keep this}}";
    let raw = "@misc{newKey,title={New},url={https://example.org/a.pdf}}";
    let (repaired, key, existing) = merge_supplied_bibtex(old, raw).unwrap();
    assert!(existing);
    assert_eq!(key, "keepMyKey");
    for kept in ["author = {{User Team}}", "year = {2024}", "keywords = {keep this}"] {
        assert!(repaired.contains(kept), "{kept}");
    }
    assert!(!repaired.contains("needs review"));
    let old = "@misc{keep,title={Study},url={https://example.org/macro},month=jul,journal=publisher,howpublished=\"Blog\"}";
    let update = "@misc{new,title={Study},url={https://example.org/macro},year={2026}}";
    let (merged, key, _) = merge_supplied_bibtex(old, update).unwrap();
    assert_eq!(key, "keep");
    for kept in
        ["month = jul,", "journal = publisher,", "howpublished = \"Blog\",", "year = {2026}"]
    {
        assert!(merged.contains(kept), "{kept}");
    }
}

#[test]
fn pdf_citation_borrows_official_fields_but_keeps_the_pdf_source() {
    let title = "S-Space: Exploring Spatial Workspace in Multimodal Models";
    let page = format!(
        "<title>{title}</title><pre>{}</pre>",
        SUPPLIED_BLOG.replace("url={https://mirros.ai/blog/s-space},", "")
    );
    let (page_url, server) = serve_once(page.into_bytes());
    let pdf_url =
        reqwest::Url::parse(&page_url).unwrap().join("/original.pdf").unwrap().to_string();
    let raw = pdf_citation_bibtex(
        &format!("# {title}\n\nDate:September 7, 2026 Website:[{page_url}]({page_url}) Code:https://example.org/code\n"),
        title,
        &pdf_url,
    );
    server.join().unwrap();
    for expected in [
        "author = {{MirroS Team}}",
        "year = {2026}",
        "month = {September}",
        &format!("url = {{{pdf_url}}}"),
    ] {
        assert!(raw.contains(expected), "{expected}: {raw}");
    }
    assert!(!raw.contains("Blog post"));
    let plain = "https://example.org/plain.pdf";
    let fallback = pdf_citation_bibtex("# Plain PDF\n\nNo supplied citation.", "Plain PDF", plain);
    assert!(fallback.contains("url = {https://example.org/plain.pdf}"));
    assert!(!fallback.contains("note"));
    assert!(!fallback.contains("year"));
    let embedded = pdf_citation_bibtex(
        "@misc{official,title={Plain PDF},author={{Example Team}},year={2025}}",
        "Plain PDF",
        plain,
    );
    assert!(embedded.contains("url = {https://example.org/plain.pdf}"));
    assert!(embedded.contains("author={{Example Team}}"));
    assert!(embedded.contains("year={2025}"));
}

#[test]
fn webpage_citation_resolver_uses_rendered_metadata_and_reuses_capture() {
    let url = "https://example.org/js-page";
    let html = "<meta property='og:title' content='Rendered study'><meta name='authors' content='Ada One,Bea Two'><meta property='article:published_time' content='2026-09-02'>";
    let markdown =
        "# Rendered study\n\n".to_string() + &"Actual captured research content. ".repeat(15);
    let result = resolve_web_citation_with(url, Ok("<div id='root'></div>".into()), |requested| {
        assert_eq!(requested, url);
        Ok(ScrapedPage {
            html: html.into(),
            title: Some("Rendered study".into()),
            markdown: markdown.clone(),
        })
    })
    .unwrap()
    .unwrap();
    assert!(result.bibtex.contains("Ada One and Bea Two"));
    assert!(result.bibtex.contains("year = {2026}"));
    let project = TestProject::new("");
    let root = &project.root;
    let fetched = fetch_web_bundle(root, url, result.page, &AtomicBool::new(false)).unwrap();
    assert!(read_paper(root, &fetched.arxiv_id)
        .unwrap()
        .contains("Actual captured research content."));
    // No supplied page is necessary on the second visit, and no network
    // scrape occurs: the first render already populated the complete cache.
    assert!(
        crate::papers::fetch_web_reference(root, url, &std::sync::atomic::AtomicBool::new(false))
            .unwrap()
            .reused
    );

    let static_page = resolve_web_citation_with(url, Ok(html.into()), |_| {
        panic!("static metadata must not spend a scrape")
    });
    assert!(static_page.unwrap().unwrap().page.is_none());
    let failure = resolve_web_citation_with(url, Err("HTTP 567".into()), |_| {
        Err("blocked after rendering".into())
    })
    .err()
    .unwrap();
    assert!(failure.contains("HTTP 567"));
    assert!(failure.contains("blocked after rendering"));
    let doi_page = "<meta name='citation_doi' content='10.1/example'><title>Publication</title>";
    let doi = resolve_web_citation_with(url, Ok(doi_page.into()), |_| {
        panic!("DOI resolution must not scrape")
    });
    assert!(doi.unwrap().is_none());
}

#[test]
#[ignore = "requires network access and bibcite"]
fn supplied_blog_live_s_space() {
    let raw = fetch_supplied_web_bibtex("https://mirros.ai/blog/s-space").unwrap();
    let (bib, key, _) = merge_supplied_bibtex("", &raw).unwrap();
    let entry = project::parse_bibliography(&bib).remove(0);
    assert_eq!(key, "team2026sspace");
    assert_eq!(entry.authors, "MirroS Team");
    assert_eq!(entry.year, "2026");
    assert!(bib.contains("September"));
    assert!(bib.contains("Blog post"));
    assert_eq!(entry.url.as_deref(), Some("https://mirros.ai/blog/s-space"));
    eprintln!("{bib}");
}

#[test]
#[ignore = "requires network access and bibcite"]
fn supplied_web_citations_live_workspace_and_atlas() {
    for (url, key, journal, author) in [
        (
            "https://transformer-circuits.pub/2026/workspace/index.html",
            "gurnee2026verbalizable",
            "Transformer Circuits Thread",
            "Gurnee, Wes",
        ),
        (
            "https://www.worldlabs.ai/blog/atlas",
            "team2026atlas",
            "World Labs Blog",
            "World Labs Team",
        ),
    ] {
        let raw = fetch_supplied_web_bibtex(url).expect(url);
        let (bib, actual_key, _) = merge_supplied_bibtex("", &raw).expect(url);
        let entry = project::parse_bibliography(&bib).remove(0);
        assert_eq!(actual_key, key);
        assert!(bib.starts_with("\n@article{"), "{bib}");
        assert!(bib.contains(author), "{bib}");
        assert!(bib.contains(journal), "{bib}");
        assert_eq!(entry.year, "2026");
        assert_eq!(entry.url.as_deref(), Some(url));
        eprintln!("{bib}");
    }
}

#[test]
#[ignore = "requires network access and bibcite; set LATTICE_TEST_CITATION_URL"]
fn webpage_citation_live_requested_url() {
    let url = std::env::var("LATTICE_TEST_CITATION_URL").unwrap();
    let result = resolve_web_citation(&url).unwrap().unwrap();
    let (bib, _, _) = merge_supplied_bibtex("", &result.bibtex).unwrap();
    eprintln!("{bib}");
    if std::env::var_os("LATTICE_TEST_FULL_WEB_IMPORT").is_some() {
        let project = TestProject::new("");
        let fetched =
            fetch_web_bundle(&project.root, &url, result.page, &AtomicBool::new(false)).unwrap();
        let markdown = read_paper(&project.root, &fetched.arxiv_id).unwrap();
        assert!(markdown.len() > 1000, "captured article is unexpectedly short");
        assert!(
            crate::papers::fetch_web_reference(
                &project.root,
                &url,
                &std::sync::atomic::AtomicBool::new(false)
            )
            .unwrap()
            .reused
        );
        eprintln!("Captured {} bytes of Markdown; repeat import reused cache.", markdown.len());
    }
    assert_eq!(project::parse_bibliography(&bib).remove(0).url.as_deref(), Some(url.as_str()));
}
