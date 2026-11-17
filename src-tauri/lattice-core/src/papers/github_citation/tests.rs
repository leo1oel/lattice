use super::*;
use serde_json::json;

fn repository(owner: &str, name: &str) -> Repository {
    Repository { owner: owner.into(), name: name.into() }
}

#[test]
fn any_page_of_a_repository_names_the_repository() {
    for url in [
        "https://github.com/nvidia-cosmos/cosmos-reason2",
        "https://github.com/nvidia-cosmos/cosmos-reason2/",
        "https://www.github.com/nvidia-cosmos/cosmos-reason2.git",
        "https://github.com/nvidia-cosmos/cosmos-reason2/tree/main/examples#readme",
        "http://github.com/nvidia-cosmos/cosmos-reason2/releases/tag/v1.0",
    ] {
        assert_eq!(
            repository_from_url(url),
            Some(repository("nvidia-cosmos", "cosmos-reason2")),
            "{url}"
        );
    }
    for url in [
        "https://github.com/nvidia-cosmos",
        "https://github.com/topics/vision",
        "https://github.com/orgs/nvidia/repositories",
        "https://gist.github.com/someone/abc",
        "https://example.com/nvidia-cosmos/cosmos-reason2",
        "github.com/nvidia-cosmos/cosmos-reason2",
    ] {
        assert_eq!(repository_from_url(url), None, "{url}");
    }
}

#[test]
fn a_repository_without_a_citation_gets_a_clean_misc_entry() {
    let metadata = json!({
        "name": "cosmos-reason2",
        "description": "Cosmos-Reason2 models understand the physical common sense & reason.",
    });
    let repo = repository("nvidia-cosmos", "cosmos-reason2");
    let RepositoryCitation::Built { bibtex, key, .. } =
        built_entry(&repo, &metadata, "NVIDIA Cosmos", Some("2026"), Some("v1.2"))
    else {
        panic!("expected a built entry")
    };
    assert_eq!(key, "nvidiacosmos2026cosmosreason2");
    assert_eq!(
        bibtex,
        "@misc{nvidiacosmos2026cosmosreason2,\n  \
         title = {{cosmos-reason2}},\n  \
         author = {{NVIDIA Cosmos}},\n  year = {2026},\n  \
         howpublished = {\\url{https://github.com/nvidia-cosmos/cosmos-reason2}},\n  \
         note = {GitHub repository, version v1.2},\n  \
         url = {https://github.com/nvidia-cosmos/cosmos-reason2}\n}"
    );
    let entry = crate::project::parse_bibliography(&bibtex).remove(0);
    assert_eq!(entry.year, "2026");
    assert!(!bibtex.contains("XXXX"));
}

#[test]
fn citation_cff_prefers_the_paper_it_names() {
    let cff = r#"
cff-version: 1.2.0
message: "If you use this software, please cite it as below."
title: "my-tool"
authors:
  - family-names: Doe
    given-names: Jane
version: 2.0.1
date-released: 2024-03-01
preferred-citation:
  type: article
  title: "A Paper About My_Tool"
  authors:
    - family-names: Doe
      given-names: Jane
    - family-names: Beethoven
      name-particle: van
      given-names: Ludwig
    - name: "The Tool Consortium"
  journal: "Journal of Tools"
  volume: 3
  issue: 2
  start: 10
  end: 20
  year: 2023
  doi: 10.1000/my_tool
"#;
    let bibtex = cff_bibtex(cff, &repository("doe", "my-tool")).unwrap();
    let entry = crate::project::parse_bibliography(&bibtex).remove(0);
    assert!(bibtex.starts_with("@article{"), "{bibtex}");
    assert_eq!(entry.title, "A Paper About My\\_Tool");
    assert!(
        bibtex.contains("author = {Doe, Jane and van Beethoven, Ludwig and {The Tool Consortium}}")
    );
    assert_eq!(entry.year, "2023");
    assert_eq!(entry.doi.as_deref(), Some("10.1000/my_tool"));
    assert!(bibtex.contains("journal = {Journal of Tools}"));
    assert!(bibtex.contains("pages = {10--20}"));
    assert!(bibtex.contains("number = {2}"));
}

#[test]
fn citation_cff_without_a_preferred_citation_cites_the_software() {
    let cff = "cff-version: 1.2.0\ntitle: my-tool\nversion: 2.0.1\ndate-released: '2024-03-01'\n\
               authors:\n  - family-names: Doe\n    given-names: Jane\n\
               repository-code: https://github.com/doe/my-tool\n";
    let bibtex = cff_bibtex(cff, &repository("doe", "my-tool")).unwrap();
    assert!(bibtex.starts_with("@misc{"), "{bibtex}");
    assert!(bibtex.contains("year = {2024}"));
    assert!(bibtex.contains("note = {Version 2.0.1}"));
    assert!(bibtex.contains("howpublished = {\\url{https://github.com/doe/my-tool}}"));
    // A preferred article without its journal is a preprint: `@misc`.
    let preprint = "title: t\nauthors:\n  - name: X\npreferred-citation:\n  type: article\n  title: P\n  authors:\n    - family-names: Doe\n      given-names: J\n";
    assert!(cff_bibtex(preprint, &repository("a", "b")).unwrap().starts_with("@misc{"));
    // Without a title or authors there is nothing to cite.
    assert_eq!(cff_bibtex("cff-version: 1.2.0\ntitle: x\n", &repository("a", "b")), None);
    assert_eq!(cff_bibtex("not: [valid", &repository("a", "b")), None);
}

#[test]
fn a_readme_bibtex_block_is_used_as_written() {
    let readme = "# Tool\n\nSee @someone on Twitter.\n\n## Citation\n\n```bibtex\n\
                  @inproceedings{doe2024tool,\n  title={The Tool},\n  author={Doe, Jane},\n  \
                  booktitle={CVPR},\n  year={2024}\n}\n```\n";
    let bibtex = readme_bibtex(readme).unwrap();
    assert!(bibtex.starts_with("@inproceedings{doe2024tool,"));
    assert!(bibtex.ends_with('}'));
    assert_eq!(readme_bibtex("# Tool\nNo citation here.\n"), None);
    let links = "### [Paper](https://arxiv.org/abs/2503.15558v2) | [Website](https://example.com)";
    assert_eq!(readme_paper(links).as_deref(), Some("https://arxiv.org/abs/2503.15558"));
    assert_eq!(readme_paper("no paper"), None);
}
