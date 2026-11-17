//! Citing a GitHub repository. The repository's own citation comes first:
//! its `CITATION.cff` (what GitHub's "Cite this repository" reads, with its
//! `preferred-citation`, usually the paper, ahead of the software), then a
//! BibTeX block in its README. A repository that offers neither gets an
//! entry built from what GitHub knows about it: the owner as author, the
//! year of its latest release (else of its last commit), and its URL.
//!
//! The page's generic metadata used to stand in for all of this, and GitHub's
//! HTML describes the site, not the work: `author = {GitHub}`, a title of
//! "GitHub - owner/repo: description", no year, and the key
//! `githubXXXXgithub`.

use super::{http_client, read_capped};
use crate::util::err;
use reqwest::blocking::Client;
use serde_json::Value;
use yaml_rust2::{Yaml, YamlLoader};

/// A repository named by a github.com URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Repository {
    pub(super) owner: String,
    pub(super) name: String,
}

impl Repository {
    fn url(&self) -> String {
        format!("https://github.com/{}/{}", self.owner, self.name)
    }
}

/// The citation found for a repository, and where it came from.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum RepositoryCitation {
    /// The authors' own record (from `origin`), kept field for field.
    Supplied { bibtex: String, origin: &'static str },
    /// An entry built from the repository's GitHub metadata, under `key`,
    /// and the arXiv paper its README links, if any.
    Built { bibtex: String, key: String, paper: Option<String> },
}

impl RepositoryCitation {
    /// For the Agent: where the entry came from.
    pub(super) fn note(&self, repository: &Repository) -> String {
        let url = repository.url();
        match self {
            Self::Supplied { origin, .. } => format!(
                "{url} supplies its own citation ({origin}); it was added as the authors wrote it."
            ),
            Self::Built { paper: Some(paper), .. } => format!(
                "{url} has no CITATION.cff and no BibTeX in its README, so the entry was built from its GitHub metadata (owner, latest release or last commit, URL). Its README links the paper {paper}: if the paper is what the text means, cite that instead."
            ),
            Self::Built { paper: None, .. } => format!(
                "{url} has no CITATION.cff and no BibTeX in its README, so the entry was built from its GitHub metadata (owner, latest release or last commit, URL). Check the author and title; if the repository accompanies a paper, cite the paper instead."
            ),
        }
    }
}

/// Owners that are GitHub's own pages, never a repository's.
const RESERVED_OWNERS: &[&str] = &[
    "about",
    "apps",
    "collections",
    "customer-stories",
    "enterprise",
    "events",
    "explore",
    "features",
    "login",
    "marketplace",
    "new",
    "notifications",
    "orgs",
    "pricing",
    "pulls",
    "issues",
    "search",
    "settings",
    "sponsors",
    "topics",
    "trending",
    "users",
];

/// The repository a `github.com/<owner>/<repo>[/…]` URL names; any page of it
/// (a file, a tree, a release) cites the repository.
pub(super) fn repository_from_url(url: &str) -> Option<Repository> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !matches!(parsed.host_str()?, "github.com" | "www.github.com")
    {
        return None;
    }
    let mut segments = parsed.path_segments()?.filter(|segment| !segment.is_empty());
    let owner = segments.next()?;
    let name = segments.next()?.trim_end_matches(".git");
    let plain = |value: &str| {
        !value.is_empty()
            && value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    };
    if !plain(owner)
        || !plain(name)
        || RESERVED_OWNERS.contains(&owner.to_ascii_lowercase().as_str())
    {
        return None;
    }
    Some(Repository { owner: owner.to_string(), name: name.to_string() })
}

/// The repository's citation: its `CITATION.cff`, else its README's BibTeX,
/// else one built from its metadata.
pub(super) fn resolve(repository: &Repository) -> Result<RepositoryCitation, String> {
    let client = http_client(15).map_err(err)?;
    let api = |path: &str| github_json(&client, &format!("{}{path}", api_base(repository)));
    let metadata = api("")?;
    let branch = metadata["default_branch"].as_str().unwrap_or("HEAD");
    let raw_file = |file: &str| {
        let url = format!(
            "https://raw.githubusercontent.com/{}/{}/{branch}/{file}",
            repository.owner, repository.name
        );
        fetch_text(&client, &url, None)
    };
    if let Some(bibtex) = raw_file("CITATION.cff")?.and_then(|cff| cff_bibtex(&cff, repository)) {
        return Ok(RepositoryCitation::Supplied { bibtex, origin: "CITATION.cff" });
    }
    let readme = fetch_text(
        &client,
        &format!("{}/readme", api_base(repository)),
        Some("application/vnd.github.raw"),
    )?;
    if let Some(bibtex) = readme.as_deref().and_then(readme_bibtex) {
        return Ok(RepositoryCitation::Supplied { bibtex, origin: "a BibTeX block in its README" });
    }
    let owner = api_owner_name(&client, &metadata);
    let release = github_json(&client, &format!("{}/releases/latest", api_base(repository))).ok();
    let last_commit = || {
        github_json(&client, &format!("{}/commits?per_page=1", api_base(repository))).ok().and_then(
            |commits| commits[0]["commit"]["committer"]["date"].as_str().map(str::to_string),
        )
    };
    let year = release
        .as_ref()
        .and_then(|release| release["published_at"].as_str().map(str::to_string))
        .or_else(last_commit)
        .or_else(|| metadata["pushed_at"].as_str().map(str::to_string))
        .and_then(|date| date.get(..4).map(str::to_string));
    // A tag names a version only when it reads like one ("v1.2", "2.0").
    let version = release.as_ref().and_then(|release| release["tag_name"].as_str()).filter(|tag| {
        tag.trim_start_matches(['v', 'V']).starts_with(|ch: char| ch.is_ascii_digit())
    });
    let mut citation = built_entry(repository, &metadata, &owner, year.as_deref(), version);
    if let RepositoryCitation::Built { paper, .. } = &mut citation {
        *paper = readme.as_deref().and_then(readme_paper);
    }
    Ok(citation)
}

fn api_base(repository: &Repository) -> String {
    format!("https://api.github.com/repos/{}/{}", repository.owner, repository.name)
}

fn github_json(client: &Client, url: &str) -> Result<Value, String> {
    let text = fetch_text(client, url, Some("application/vnd.github+json"))?.ok_or_else(|| {
        "GitHub has no such repository (or it is private). Check the URL.".to_string()
    })?;
    serde_json::from_str(&text).map_err(|error| format!("GitHub returned invalid JSON: {error}"))
}

/// The body of `url`, `None` when it is not there (404). A refusal names
/// GitHub's hourly limit for unauthenticated requests, the usual cause.
fn fetch_text(client: &Client, url: &str, accept: Option<&str>) -> Result<Option<String>, String> {
    let mut request = client.get(url);
    if let Some(accept) = accept {
        request = request.header("Accept", accept);
    }
    let response = request.send().map_err(|error| format!("Could not reach GitHub: {error}"))?;
    match response.status().as_u16() {
        404 => return Ok(None),
        403 | 429 => {
            return Err("GitHub refused the request (its hourly limit for unauthenticated lookups is spent). Retry later, or cite the repository with its BibTeX.".into())
        }
        status if !(200..300).contains(&status) => {
            return Err(format!("GitHub answered HTTP {status} for {url}."))
        }
        _ => {}
    }
    let bytes = read_capped(response, 1024 * 1024)
        .map_err(err)?
        .ok_or("The GitHub file exceeds the 1 MB citation limit.")?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// The owner's display name ("NVIDIA Cosmos"), else its login.
fn api_owner_name(client: &Client, metadata: &Value) -> String {
    let login = metadata["owner"]["login"].as_str().unwrap_or_default().to_string();
    metadata["owner"]["url"]
        .as_str()
        .and_then(|url| github_json(client, url).ok())
        .and_then(|owner| {
            owner["name"]
                .as_str()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
        })
        .unwrap_or(login)
}

/// The first arXiv paper a README links (`https://arxiv.org/abs/…`).
pub(super) fn readme_paper(readme: &str) -> Option<String> {
    let link =
        regex::Regex::new(r"https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})")
            .unwrap();
    link.captures(readme).map(|capture| format!("https://arxiv.org/abs/{}", &capture[1]))
}

/// The first complete entry with a title in a README.
pub(super) fn readme_bibtex(readme: &str) -> Option<String> {
    crate::project::bibliography_entry_spans(readme).into_iter().find_map(|(_, start, end)| {
        let raw = readme[start..end].trim();
        let entry = crate::project::parse_bibliography(raw).into_iter().next()?;
        (raw.len() <= 64 * 1024 && raw.ends_with(['}', ')']) && !entry.title.trim().is_empty())
            .then(|| raw.to_string())
    })
}

/// A BibTeX value with its specials escaped and inner braces balanced away.
fn bib_value(value: &str) -> String {
    let mut out = String::new();
    for ch in value.trim().chars() {
        match ch {
            '{' | '}' => {}
            '&' | '%' | '$' | '#' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            '\n' | '\r' | '\t' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn entry(kind: &str, key: &str, fields: &[(&str, String)]) -> String {
    let body = fields
        .iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .map(|(name, value)| format!("  {name} = {{{value}}}"))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("@{kind}{{{key},\n{body}\n}}")
}

/// `<owner><year><repo>`, lowercase ASCII letters and digits.
fn built_key(repository: &Repository, year: Option<&str>) -> String {
    let plain = |value: &str| {
        value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .flat_map(|ch| ch.to_lowercase())
            .collect::<String>()
    };
    format!("{}{}{}", plain(&repository.owner), year.unwrap_or_default(), plain(&repository.name))
}

/// An `@misc` entry for a repository without a citation of its own; BibTeX
/// styles (CVPR's among them) do not know biblatex's `@software`.
pub(super) fn built_entry(
    repository: &Repository, metadata: &Value, owner: &str, year: Option<&str>,
    version: Option<&str>,
) -> RepositoryCitation {
    // The name alone: a description is often a paragraph, too long for a
    // reference list.
    let title = metadata["name"].as_str().unwrap_or(&repository.name);
    let url = repository.url();
    let key = built_key(repository, year);
    let note = match version {
        Some(version) => format!("GitHub repository, version {}", bib_value(version)),
        None => "GitHub repository".to_string(),
    };
    let bibtex = entry(
        "misc",
        &key,
        &[
            ("title", format!("{{{}}}", bib_value(title))),
            ("author", format!("{{{}}}", bib_value(owner))),
            ("year", year.unwrap_or_default().to_string()),
            ("howpublished", format!("\\url{{{url}}}")),
            ("note", note),
            ("url", url),
        ],
    );
    RepositoryCitation::Built { bibtex, key, paper: None }
}

/// A `CITATION.cff` as BibTeX: its `preferred-citation` when it has one
/// (usually the paper the software accompanies), else the software itself.
pub(super) fn cff_bibtex(cff: &str, repository: &Repository) -> Option<String> {
    let document = YamlLoader::load_from_str(cff).ok()?.into_iter().next()?;
    let preferred = &document["preferred-citation"];
    let work = if preferred.as_hash().is_some() { preferred } else { &document };
    let text = |yaml: &Yaml| match yaml {
        Yaml::String(value) | Yaml::Real(value) => Some(value.clone()),
        Yaml::Integer(value) => Some(value.to_string()),
        _ => None,
    };
    let field = |name: &str| text(&work[name]).map(|value| bib_value(&value)).unwrap_or_default();
    // Identifiers stay verbatim: an escaped `_` is another DOI or URL.
    let verbatim = |name: &str| {
        text(&work[name]).map(|value| value.trim().replace(['{', '}', ' '], "")).unwrap_or_default()
    };
    let title = field("title");
    let authors: Vec<String> = work["authors"]
        .as_vec()?
        .iter()
        .filter_map(|person| {
            let part = |name: &str| text(&person[name]).map(|value| bib_value(&value));
            match (part("family-names"), part("name")) {
                (Some(family), _) => {
                    let family = match part("name-particle") {
                        Some(particle) => format!("{particle} {family}"),
                        None => family,
                    };
                    let suffix =
                        part("name-suffix").map(|suffix| format!(", {suffix}")).unwrap_or_default();
                    Some(match part("given-names") {
                        Some(given) => format!("{family}{suffix}, {given}"),
                        None => format!("{{{family}}}"),
                    })
                }
                (None, Some(entity)) => Some(format!("{{{entity}}}")),
                _ => None,
            }
        })
        .collect();
    if title.is_empty() || authors.is_empty() {
        return None;
    }
    let date = ["date-published", "date-released"].iter().find_map(|name| text(&work[*name]));
    let year =
        text(&work["year"]).or_else(|| date.and_then(|date| date.get(..4).map(str::to_string)));
    let nested = |outer: &str, inner: &str| {
        text(&work[outer][inner]).map(|value| bib_value(&value)).unwrap_or_default()
    };
    let pages = match (field("start"), field("end")) {
        (start, end) if !start.is_empty() && !end.is_empty() => format!("{start}--{end}"),
        (start, _) => start,
    };
    let url = [verbatim("url"), verbatim("repository-code")]
        .into_iter()
        .find(|url| !url.is_empty())
        .unwrap_or_else(|| repository.url());
    let kind = text(&work["type"]).unwrap_or_else(|| "software".into());
    let (bibtype, venue) = match kind.as_str() {
        "article" | "magazine-article" | "newspaper-article" => {
            ("article", ("journal", [field("journal"), nested("journal", "name")].concat()))
        }
        "conference-paper" | "proceedings" | "conference" => (
            "inproceedings",
            ("booktitle", [field("collection-title"), nested("conference", "name")].concat()),
        ),
        "book" => ("book", ("publisher", nested("publisher", "name"))),
        "report" => ("techreport", ("institution", nested("institution", "name"))),
        "thesis" => ("phdthesis", ("school", nested("institution", "name"))),
        _ => ("misc", ("howpublished", format!("\\url{{{url}}}"))),
    };
    // An article without its journal (a preprint) is a `@misc` to BibTeX.
    let (bibtype, venue) = if venue.1.is_empty() {
        ("misc", ("howpublished", format!("\\url{{{url}}}")))
    } else {
        (bibtype, venue)
    };
    let mut fields = vec![
        ("title", format!("{{{title}}}")),
        ("author", authors.join(" and ")),
        ("year", year.unwrap_or_default()),
        venue,
        ("volume", field("volume")),
        ("number", field("issue")),
        ("pages", pages),
        ("doi", verbatim("doi")),
        ("url", url),
    ];
    if bibtype == "misc" {
        let version = field("version");
        fields.push((
            "note",
            if version.is_empty() { String::new() } else { format!("Version {version}") },
        ));
    }
    Some(entry(bibtype, &built_key(repository, None), &fields))
}

#[cfg(test)]
mod tests;
