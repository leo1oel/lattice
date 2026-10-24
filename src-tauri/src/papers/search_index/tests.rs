use super::*;
use crate::test_support::TempDir;

const LIMITS: Limits = Limits { papers: 10, hits_per_paper: 5 };

/// A library in a scratch directory: `(key, title, paper.md)` per paper.
struct Library {
    dir: TempDir,
    papers: Vec<(&'static str, &'static str)>,
}

impl Library {
    fn new(papers: &[(&'static str, &'static str, &str)]) -> Self {
        let dir = TempDir::new("paper-index");
        for (key, _, markdown) in papers {
            dir.write(&format!("papers/{key}/paper.md"), markdown);
        }
        Self { dir, papers: papers.iter().map(|(key, title, _)| (*key, *title)).collect() }
    }

    fn index(&self) -> PathBuf {
        self.dir.join("index")
    }

    fn texts(&self) -> Vec<PaperText> {
        self.papers
            .iter()
            .map(|(key, title)| PaperText {
                key: key.to_string(),
                title: title.to_string(),
                files: ["paper.md", "blog.md"]
                    .into_iter()
                    .map(|file| PaperFile {
                        path: format!("papers/{key}/{file}"),
                        absolute: self.dir.join(format!("papers/{key}/{file}")),
                    })
                    .filter(|file| file.absolute.is_file())
                    .collect(),
            })
            .collect()
    }

    fn search(&self, query: &str) -> Vec<PaperTextMatch> {
        search(&self.index(), &self.texts(), query, LIMITS).unwrap()
    }

    /// Sync directly, reporting whether anything was written.
    fn sync_wrote(&self) -> bool {
        with_index(&self.index(), |open| sync_open(open, &self.texts())).unwrap()
    }
}

fn keys(matches: &[PaperTextMatch]) -> Vec<&str> {
    matches.iter().map(|paper| paper.key.as_str()).collect()
}

fn highlighted(hit: &LineHit) -> Vec<String> {
    let units: Vec<u16> = hit.text.encode_utf16().collect();
    hit.highlights
        .iter()
        .map(|[from, to]| String::from_utf16(&units[*from as usize..*to as usize]).unwrap())
        .collect()
}

#[test]
fn ranks_papers_by_title_and_best_lines_with_highlighted_line_hits() {
    let library = Library::new(&[
        ("2106.09685", "LoRA: Low-Rank Adaptation of Large Language Models", "# LoRA\n\nWe propose **Low-Rank** Adaptation.\n\nLow-rank adaptation freezes the weights.\n"),
        ("2401.00001", "Vision Transformers", "# Method\n\nA low-rank adaptation baseline.\n"),
        ("2401.00002", "Unrelated", "Nothing to see here.\n"),
    ]);
    let matches = library.search("low-rank adaptation");
    assert_eq!(keys(&matches), ["2106.09685", "2401.00001"]);
    let lora = &matches[0];
    assert!(lora.title_match);
    assert_eq!(lora.hits.len(), 2);
    assert_eq!(lora.hits[0].path, "papers/2106.09685/paper.md");
    assert!([3, 5].contains(&lora.hits[0].line), "{lora:?}");
    let second = &matches[1].hits[0];
    assert_eq!((second.line, second.text.as_str()), (3, "A low-rank adaptation baseline."));
    assert_eq!(highlighted(second), ["low-rank adaptation"]);
    assert!(!matches[1].title_match);
    // Every word must be on one line.
    assert!(library.search("weights baseline").is_empty());
}

#[test]
fn matches_the_word_being_typed_as_a_prefix_and_whole_words_by_stem() {
    let library = Library::new(&[(
        "2002.10957",
        "MiniLM",
        "Distillation of transformers.\n\nWe were distilling attention.\n",
    )]);
    let lines = |query: &str| -> Vec<u32> {
        library
            .search(query)
            .first()
            .map(|paper| paper.hits.iter().map(|hit| hit.line).collect())
            .unwrap_or_default()
    };
    // Typed so far: a prefix of "transformers".
    assert_eq!(lines("transfo"), [1]);
    assert_eq!(highlighted(&library.search("transfo")[0].hits[0]), ["transformers"]);
    // A whole word matches every form of its stem, before or after a space.
    let mut both = lines("distilling");
    both.sort();
    assert_eq!(both, [1, 3]);
    assert_eq!(lines("distilling ").len(), 2);
    // Only the last word is a prefix.
    assert!(lines("transfo attention").is_empty());
}

#[test]
fn segments_chinese_queries_into_words() {
    let library = Library::new(&[
        (
            "zh-1",
            "神经机器翻译",
            "# 概述\n\n神经机器翻译使用编码器和解码器。\n\n图像处理是另一个领域。\n",
        ),
        ("zh-2", "计算机视觉", "计算机视觉研究图像的理解。\n"),
    ]);
    let compound = library.search("机器翻译");
    assert_eq!(keys(&compound), ["zh-1"]);
    assert!(compound[0].title_match);
    assert_eq!(highlighted(&compound[0].hits[0]), ["机器翻译"]);
    // A part of a compound finds it too, and a two-character word ranks.
    assert_eq!(keys(&library.search("翻译")), ["zh-1"]);
    let images = library.search("图像");
    assert_eq!(images.len(), 2);
    assert_eq!(highlighted(&images[0].hits[0]), ["图像"]);
    // Mixed scripts on one line.
    let mixed = Library::new(&[("mixed", "Mixed", "Transformer 编码器由多层组成。\n")]);
    assert_eq!(mixed.search("transformer 编码器")[0].hits[0].line, 1);
}

#[test]
fn reindexes_only_changed_papers_and_drops_removed_ones() {
    let mut library = Library::new(&[
        ("a", "Alpha", "The alpha paper on sparse attention.\n"),
        ("b", "Beta", "The beta paper on dense retrieval.\n"),
    ]);
    assert!(library.sync_wrote(), "the first sync builds the index");
    assert!(!library.sync_wrote(), "nothing changed, nothing is written");

    library.dir.write("papers/b/paper.md", "Beta now studies contrastive pretraining.\n");
    assert!(library.sync_wrote());
    assert!(library.search("dense retrieval").is_empty());
    assert_eq!(keys(&library.search("contrastive")), ["b"]);

    // An overview arriving is a change; so is a title edited in the bibliography.
    library.dir.write("papers/a/blog.md", "# Overview\n\nAn overview of routing.\n");
    let routing = library.search("routing");
    assert_eq!(routing[0].hits[0].path, "papers/a/blog.md");
    library.papers[0].1 = "Gamma";
    assert!(library.search("alpha").iter().all(|paper| !paper.title_match));
    assert!(library.search("gamma")[0].title_match);

    library.papers.remove(1);
    assert!(library.search("contrastive").is_empty());
    assert!(!library.sync_wrote());
}

#[test]
fn rebuilds_an_index_that_cannot_be_read() {
    let library = Library::new(&[("a", "Alpha", "Sparse attention for long documents.\n")]);
    assert_eq!(keys(&library.search("sparse")), ["a"]);
    // Another process (or a crash) left garbage; this one opens it afresh.
    OPEN.lock().unwrap().remove(&library.index());
    fs::write(library.index().join("meta.json"), "not json").unwrap();
    assert_eq!(keys(&library.search("sparse")), ["a"]);

    // An index from an older schema is rebuilt as well.
    OPEN.lock().unwrap().remove(&library.index());
    let index = Index::open_in_dir(library.index()).unwrap();
    let mut writer: IndexWriter = index.writer_with_num_threads(1, WRITER_MEMORY).unwrap();
    let mut commit = writer.prepare_commit().unwrap();
    commit.set_payload(r#"{"schema":0,"papers":{}}"#);
    commit.commit().unwrap();
    drop(writer);
    assert_eq!(keys(&library.search("sparse")), ["a"]);
    assert!(!library.sync_wrote());
}
