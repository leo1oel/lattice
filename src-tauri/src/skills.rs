use reqwest::header::USER_AGENT;
use serde_json::Value;
use std::time::Duration;

const HUMANIZE_WRITING: &str = include_str!("embedded_skills/humanize-writing/SKILL.md");
const WRITING_ORIGINAL: &str =
    include_str!("embedded_skills/humanize-writing/references/writing/original.md");
const WRITING_REWRITING: &str =
    include_str!("embedded_skills/humanize-writing/references/writing/rewriting.md");
const RESEARCH_TASTE: &str = include_str!("embedded_skills/research-taste/SKILL.md");
const TASTE_PROBLEM_SELECTION: &str =
    include_str!("embedded_skills/research-taste/references/tastes/problem-selection.md");
const TASTE_METHOD_AND_RIGOR: &str =
    include_str!("embedded_skills/research-taste/references/tastes/method-and-rigor.md");
const RELATED_WORK_OPENALEX: &str = include_str!("embedded_skills/related-work-openalex/SKILL.md");

#[derive(Debug, Clone)]
pub struct RoutedSkills {
    pub labels: Vec<String>,
    pub instructions: String,
    pub needs_related_work_search: bool,
}

pub fn route(message: &str, selection: Option<&str>) -> RoutedSkills {
    let normalized = message.to_lowercase();
    let rewriting = contains_any(
        &normalized,
        &[
            "rewrite",
            "revise",
            "edit",
            "polish",
            "proofread",
            "shorten",
            "tighten",
            "improve",
            "humanize",
            "de-slop",
            "改写",
            "修改",
            "润色",
            "精简",
            "压缩",
            "扩写",
            "重写",
            "去除 ai",
        ],
    );
    let writing_forbidden = contains_any(
        &normalized,
        &[
            "do not edit",
            "don't edit",
            "without editing",
            "no edits",
            "不要修改",
            "不要改",
            "不修改",
        ],
    );
    let writing = !writing_forbidden
        && (rewriting
            || contains_any(
                &normalized,
                &[
                    "write",
                    "draft",
                    "compose",
                    "abstract",
                    "introduction",
                    "conclusion",
                    "caption",
                    "paragraph",
                    "section",
                    "撰写",
                    "写",
                    "起草",
                    "生成一段",
                ],
            ));
    let problem_selection = contains_any(
        &normalized,
        &[
            "research direction",
            "research idea",
            "hypothesis",
            "thesis",
            "novelty",
            "novel",
            "worth pursuing",
            "research question",
            "研究方向",
            "研究想法",
            "假设",
            "论点",
            "创新性",
            "研究问题",
            "值得做",
        ],
    );
    let method_and_rigor = contains_any(
        &normalized,
        &[
            "experiment",
            "evaluation",
            "baseline",
            "metric",
            "ablation",
            "failure mode",
            "methodology",
            "mechanism",
            "result",
            "critique",
            "实验",
            "评估",
            "基线",
            "指标",
            "消融",
            "失败模式",
            "方法是否",
            "机制",
            "结果",
            "批评",
        ],
    );
    let related_work = contains_any(
        &normalized,
        &[
            "related work",
            "prior work",
            "literature search",
            "literature review",
            "find papers",
            "find paper",
            "search papers",
            "similar papers",
            "citation graph",
            "openalex",
            "相关工作",
            "相关论文",
            "文献综述",
            "文献调研",
            "找论文",
            "搜索论文",
            "引用图",
        ],
    );

    let mut labels = Vec::new();
    let mut modules = Vec::new();
    if writing {
        labels.push("Writing".to_string());
        let mode = if rewriting || selection.is_some_and(|value| !value.trim().is_empty()) {
            WRITING_REWRITING
        } else {
            WRITING_ORIGINAL
        };
        modules.push(format!(
            "## humanize-writing\n{HUMANIZE_WRITING}\n\n## Selected writing mode\n{mode}"
        ));
    }
    if problem_selection || method_and_rigor {
        labels.push("Research taste".to_string());
        let mut taste = format!("## research-taste\n{RESEARCH_TASTE}");
        if problem_selection {
            taste.push_str(&format!(
                "\n\n## Selected taste module: problem selection\n{TASTE_PROBLEM_SELECTION}"
            ));
        }
        if method_and_rigor {
            taste.push_str(&format!(
                "\n\n## Selected taste module: method and rigor\n{TASTE_METHOD_AND_RIGOR}"
            ));
        }
        modules.push(taste);
    }
    if related_work {
        labels.push("Related work".to_string());
        modules.push(format!("## related-work-openalex\n{RELATED_WORK_OPENALEX}"));
    }

    let instructions = if modules.is_empty() {
        "No application skill was selected for this turn.".to_string()
    } else {
        format!(
            "These skills are bundled inside Lattice and were selected only for this turn.\n\
             Apply their judgment and workflow, but the Lattice JSON response contract and project safety rules take precedence over any skill-specific delivery format, tool command, delegation instruction, or request to write outside the project.\n\
             Perform any draft-audit-final loop internally and return only the final result through the Lattice schema.\n\n{}",
            modules.join("\n\n---\n\n")
        )
    };

    RoutedSkills {
        labels,
        instructions,
        needs_related_work_search: related_work,
    }
}

pub fn search_openalex(query: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .get("https://api.openalex.org/works")
        .header(USER_AGENT, format!("Lattice/{}", env!("CARGO_PKG_VERSION")))
        .query(&[
            ("search", query),
            ("per_page", "10"),
            ("select", "id,title,publication_year,cited_by_count,ids"),
        ]);
    if let Ok(api_key) = std::env::var("OPENALEX_API_KEY") {
        if !api_key.trim().is_empty() {
            request = request.query(&[("api_key", api_key.trim())]);
        }
    }
    let response = request
        .send()
        .map_err(|error| format!("Could not reach OpenAlex: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenAlex search failed: {error}"))?;
    let value = response
        .json::<Value>()
        .map_err(|error| format!("Could not parse OpenAlex results: {error}"))?;
    Ok(format_openalex_results(&value))
}

fn format_openalex_results(value: &Value) -> String {
    let Some(results) = value.get("results").and_then(Value::as_array) else {
        return "OpenAlex returned no candidate papers.".to_string();
    };
    if results.is_empty() {
        return "OpenAlex returned no candidate papers.".to_string();
    }
    let entries = results
        .iter()
        .take(10)
        .enumerate()
        .filter_map(|(index, item)| {
            let title = item.get("title").and_then(Value::as_str)?;
            let year = item
                .get("publication_year")
                .and_then(Value::as_i64)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "year unknown".to_string());
            let citations = item
                .get("cited_by_count")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let openalex = item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("OpenAlex id unavailable");
            let doi = item
                .pointer("/ids/doi")
                .and_then(Value::as_str)
                .map(|value| format!(" | DOI: {value}"))
                .unwrap_or_default();
            Some(format!(
                "{}. {} ({year}, {citations} citations)\n   OpenAlex: {openalex}{doi}",
                index + 1,
                title
            ))
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        "OpenAlex returned no candidate papers.".to_string()
    } else {
        format!(
            "OpenAlex candidate papers for triage only. Titles and citation counts are discovery metadata, not evidence for scientific claims. Import and read a paper before citing its claims.\n\n{}",
            entries.join("\n")
        )
    }
}

fn contains_any(text: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| text.contains(phrase))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_only_the_skills_needed_for_a_turn() {
        let writing = route("Draft the introduction.", None);
        assert_eq!(writing.labels, vec!["Writing"]);
        assert!(writing.instructions.contains("Original writing"));
        assert!(!writing.needs_related_work_search);

        let rigor = route("Critique the experiment and strongest baseline.", None);
        assert_eq!(rigor.labels, vec!["Research taste"]);
        assert!(rigor.instructions.contains("Method and Rigor"));

        let plain = route("What does this sentence mean?", None);
        assert!(plain.labels.is_empty());
        assert_eq!(
            plain.instructions,
            "No application skill was selected for this turn."
        );

        let read_only = route("Do not edit any file. Explain the current paragraph.", None);
        assert!(read_only.labels.is_empty());
    }

    #[test]
    fn composes_writing_taste_and_related_work_when_the_request_needs_all_three() {
        let routed = route(
            "Write a related work section and critique whether the evaluation baselines are convincing.",
            Some("Existing related work paragraph"),
        );
        assert_eq!(
            routed.labels,
            vec!["Writing", "Research taste", "Related work"]
        );
        assert!(routed
            .instructions
            .contains("Humanizer: remove AI writing patterns"));
        assert!(routed.instructions.contains("Method and Rigor"));
        assert!(routed.instructions.contains("Related work with OpenAlex"));
        assert!(routed.needs_related_work_search);
    }

    #[test]
    fn formats_openalex_candidates_without_treating_metadata_as_evidence() {
        let value = serde_json::json!({
            "results": [{
                "id": "https://openalex.org/W1",
                "title": "A Useful Paper",
                "publication_year": 2025,
                "cited_by_count": 12,
                "ids": {"doi": "https://doi.org/10.48550/arXiv.2501.00001"}
            }]
        });
        let formatted = format_openalex_results(&value);
        assert!(formatted.contains("A Useful Paper (2025, 12 citations)"));
        assert!(formatted.contains("triage only"));
        assert!(formatted.contains("Import and read a paper before citing"));
    }

    #[test]
    #[ignore = "requires network access"]
    fn searches_openalex_for_related_work() {
        let results = search_openalex("vision language model prompting").unwrap();
        assert!(results.contains("OpenAlex candidate papers"));
        assert!(results.contains("OpenAlex: https://openalex.org/"));
    }
}
