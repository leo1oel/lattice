//! The Agent's bibliography tools end to end through the host path
//! (`AgentBibliographyMutation::run` with the broker's 30-second deadline),
//! on a temporary project with the test keychain, against the real bibcite
//! and literature services. Ignored: they spend shared public quota. Run with
//! `LATTICE_BIBCITE_BIN` pointing at bibcite and `--ignored --nocapture`.

use super::AgentBibliographyMutation;
use std::time::Instant;

const PREPRINTS: &[(&str, &str, &str, &str)] = &[
    ("he2015deep", "Deep Residual Learning for Image Recognition", "He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian", "1512.03385"),
    ("vaswani2017attention", "Attention Is All You Need", "Vaswani, Ashish and Shazeer, Noam", "1706.03762"),
    ("devlin2018bert", "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", "Devlin, Jacob and Chang, Ming-Wei", "1810.04805"),
    ("kingma2014adam", "Adam: A Method for Stochastic Optimization", "Kingma, Diederik P. and Ba, Jimmy", "1412.6980"),
    ("dosovitskiy2020image", "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale", "Dosovitskiy, Alexey and Beyer, Lucas", "2010.11929"),
    ("ho2020denoising", "Denoising Diffusion Probabilistic Models", "Ho, Jonathan and Jain, Ajay and Abbeel, Pieter", "2006.11239"),
    ("radford2021learning", "Learning Transferable Visual Models From Natural Language Supervision", "Radford, Alec and Kim, Jong Wook", "2103.00020"),
    ("brown2020language", "Language Models are Few-Shot Learners", "Brown, Tom B. and Mann, Benjamin", "2005.14165"),
    ("ronneberger2015unet", "U-Net: Convolutional Networks for Biomedical Image Segmentation", "Ronneberger, Olaf and Fischer, Philipp and Brox, Thomas", "1505.04597"),
    ("goodfellow2014generative", "Generative Adversarial Networks", "Goodfellow, Ian J. and Pouget-Abadie, Jean", "1406.2661"),
    ("ioffe2015batch", "Batch Normalization: Accelerating Deep Network Training by Reducing Internal Covariate Shift", "Ioffe, Sergey and Szegedy, Christian", "1502.03167"),
    ("kipf2016semi", "Semi-Supervised Classification with Graph Convolutional Networks", "Kipf, Thomas N. and Welling, Max", "1609.02907"),
];

fn bibliography() -> String {
    PREPRINTS
        .iter()
        .map(|(key, title, author, id)| {
            format!("@misc{{{key},\n  title = {{{title}}},\n  author = {{{author}}},\n  journal = {{arXiv preprint arXiv:{id}}},\n  eprint = {{{id}}},\n  archivePrefix = {{arXiv}},\n  year = {{20{}}}\n}}\n\n", &id[..2])
        })
        .collect()
}

fn project(bib: &str) -> (crate::test_support::TempDir, std::path::PathBuf) {
    let parent = crate::test_support::TempDir::new("agent-repro");
    let root = crate::project::create(&parent, "paper").unwrap();
    std::fs::write(root.join("references.bib"), bib).unwrap();
    (parent, root)
}

fn run(root: &std::path::Path, json: &str) -> (f64, Result<serde_json::Value, String>) {
    let mutation: AgentBibliographyMutation = serde_json::from_str(json).unwrap();
    let started = Instant::now();
    // As the host receives it: the broker gives up 30 s after the request.
    let deadline = std::time::SystemTime::now() + std::time::Duration::from_secs(30);
    let deadline_ms = deadline.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let result = mutation.run(root, Some(deadline_ms));
    (started.elapsed().as_secs_f64(), result)
}

#[test]
#[ignore = "live: calls bibcite and the public literature services"]
fn live_upgrade_batch_duration() {
    let (_parent, root) = project(&bibliography());
    for call in 1..=3 {
        let (secs, result) = run(&root, r#"{"action":"upgrade_bibliography"}"#);
        eprintln!("UPGRADE call {call} elapsed={secs:.1}s (broker deadline 30s)\n{result:#?}");
        if result.as_ref().is_ok_and(|value| value["complete"] == true) {
            break;
        }
    }
    eprintln!("BIB AFTER:\n{}", std::fs::read_to_string(root.join("references.bib")).unwrap());
}

#[test]
#[ignore = "live: calls bibcite and the public literature services"]
fn live_cite_existing_preprint_by_published_doi() {
    let bib = "@misc{he2015deep,\n  title = {Deep Residual Learning for Image Recognition},\n  author = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},\n  journal = {arXiv preprint arXiv:1512.03385},\n  eprint = {1512.03385},\n  year = {2015}\n}\n";
    let (_parent, root) = project(bib);
    let (secs, result) = run(&root, r#"{"action":"cite","query":"10.1109/CVPR.2016.90"}"#);
    eprintln!("CITE elapsed={secs:.1}s\n{result:#?}");
    eprintln!("BIB AFTER:\n{}", std::fs::read_to_string(root.join("references.bib")).unwrap());
}

#[test]
#[ignore = "live: calls bibcite and the public literature services"]
fn live_cite_existing_preprint_by_id_and_title() {
    let bib = "@misc{he2015deep,\n  title = {Deep Residual Learning for Image Recognition},\n  author = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},\n  journal = {arXiv preprint arXiv:1512.03385},\n  eprint = {1512.03385},\n  year = {2015}\n}\n";
    for query in ["1512.03385", "Deep Residual Learning for Image Recognition"] {
        let (_parent, root) = project(bib);
        let json = serde_json::json!({"action": "cite", "query": query}).to_string();
        let (secs, result) = run(&root, &json);
        eprintln!("CITE {query} elapsed={secs:.1}s\n{result:#?}");
        eprintln!("BIB AFTER:\n{}", std::fs::read_to_string(root.join("references.bib")).unwrap());
    }
}
