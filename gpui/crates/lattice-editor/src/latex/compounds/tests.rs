//! The Tauri app's `compound-keys.test.ts`, as far as the PDF's hover uses it.

use super::*;

const AUX: &str = r"\chemnum@cmpd {ketone}{1}{1}{}{}{}{}{\bfseries }
\chemnum@cmpd {alcohol}{2}{2}{}{}{}{}{\bfseries }
\chemnum@subcmpd {alcohol}{OMe}{1}{a}
\chemnum@cmpd {ten}{10}{10}{}{}{}{}{\bfseries }
\chemnum@check ";

fn numbers(pairs: &[(&str, &str)]) -> CompoundNumbers {
    CompoundNumbers {
        numbers: pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        counter_prefixed: HashSet::new(),
    }
}

fn keys(list: &[&str]) -> Vec<String> {
    list.iter().map(|key| key.to_string()).collect()
}

fn map(found: &CompoundNumbers) -> Vec<(String, String)> {
    let mut pairs: Vec<_> = found.numbers.clone().into_iter().collect();
    pairs.sort();
    pairs
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut pairs: Vec<_> = list
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    pairs.sort();
    pairs
}

#[test]
fn pdf_text_is_a_compounds_only_where_the_build_gave_it_that_number() {
    let numbers = numbers(&[
        ("ketone", "1"),
        ("alcohol", "2"),
        ("alcohol.OMe", "2a"),
        ("amine.a", "3.1"),
        ("a:x", "b"),
    ]);
    let line = keys(&["ketone", "alcohol", "alcohol.OMe", "amine.a.num", "a:x"]);
    assert_eq!(
        keys_numbered("(2a),", &line, &numbers),
        keys(&["alcohol.OMe"])
    );
    assert_eq!(keys_numbered(" 1 ", &line, &numbers), keys(&["ketone"]));
    assert_eq!(
        keys_numbered("3.1", &line, &numbers),
        keys(&["amine.a.num"])
    );
    assert_eq!(keys_numbered("b", &line, &numbers), keys(&["a:x"]));
    // A citation number, a year or a word on the same source line names none.
    assert!(keys_numbered("[12]", &line, &numbers).is_empty());
    assert!(keys_numbered("2023", &line, &numbers).is_empty());
    assert!(keys_numbered("a", &line, &numbers).is_empty());
}

#[test]
fn a_line_names_every_key_once_across_the_commands_forms() {
    assert_eq!(
        compound_keys_on_line(
            r"    \node at (0.5,0.19) {\fontsize{10}{12}\selectfont \cmpd{alcohol.OMe}~(85\%)};"
        ),
        keys(&["alcohol.OMe"])
    );
    assert_eq!(
        compound_keys_on_line(r"\cmpd{a, b} and \cmpd*{c} and \refcmpd{a} and \labelcmpd[pre]{d}"),
        keys(&["a", "b", "c", "d"])
    );
    assert_eq!(
        compound_keys_on_line(r"85\% \cmpd{a} % \cmpd{b}"),
        keys(&["a"])
    );
    assert!(compound_keys_on_line(r"% \cmpd{a}").is_empty());
    assert_eq!(
        compound_keys_on_line(r"\node {\rcmpd{A:cat} \cmpd{k} \rcmpd{amine.a.num}};"),
        keys(&["k", "A:cat", "amine.a.num"])
    );
    assert_eq!(
        compound_marks_on_line(r"\rcmpd{a} % \rcmpd{b}"),
        keys(&["a"])
    );
}

#[test]
fn the_command_cites_a_compound_or_a_mark() {
    assert_eq!(
        compound_command("alcohol.OMe", false),
        r"\cmpd{alcohol.OMe}"
    );
    assert_eq!(compound_command("A:cat", false), r"\rcmpd{A:cat}");
    assert_eq!(compound_command("ketone", true), r"\rcmpd{ketone}");
    assert_eq!(compound_command("é", false), r"\cmpd{é}");
}

#[test]
fn chemnums_numbers_are_read_from_an_aux() {
    assert_eq!(
        map(&parse_compound_numbers(AUX)),
        pairs(&[
            ("ketone", "1"),
            ("alcohol", "2"),
            ("alcohol.OMe", "2a"),
            ("ten", "10")
        ])
    );
    assert!(parse_compound_numbers(r"\relax").is_empty());
    let series = parse_compound_numbers("\\cmpdser@aux{A}{cat}{B}\n\\cmpdser@aux{i}{x}{ii}");
    assert_eq!(map(&series), pairs(&[("A:cat", "B"), ("i:x", "ii")]));
    let labelled = parse_compound_numbers(
        r"\chemnum@cmpd {c}{7}{7}{S}{}{}{}{\bfseries }
\chemnum@subcmpd {c}{x}{1}{a}
\chemnum@cmpd {b}{2}{II}{}{x}{}{}{\bfseries }
\chemnum@cmpd {k}{3}{3}{}{}{}{.}{\bfseries }
\chemnum@subcmpd {k}{one}{1}{1}
\chemnum@cmpd {ester}{1}{1}{\thechapter -}{}{}{}{\bfseries }",
    );
    assert_eq!(
        map(&labelled),
        pairs(&[
            ("c", "S7"),
            ("c.x", "S7a"),
            ("b", "IIx"),
            ("k", "3"),
            ("k.one", "3.1"),
            ("ester", "1")
        ])
    );
}

#[test]
fn keys_are_data() {
    assert_eq!(
        compound_keys_on_line(r"\cmpd{a\input} \rcmpd{b#c} \cmpd{ok.sub} \rcmpd{A:cat}"),
        keys(&["ok.sub", "A:cat"])
    );
    assert!(compound_keys_on_line(&format!("\\cmpd{{{}}}", "x".repeat(201))).is_empty());
}

#[test]
fn a_number_printed_with_a_chapter_is_the_compounds() {
    let numbers = parse_compound_numbers(
        r"\chemnum@cmpd {a}{1}{1}{\textbf {\thechapter -}}{}{}{}{\bfseries }
\chemnum@cmpd {b}{2}{2}{\textbf {\thechapter -}}{}{}{}{\bfseries }
\chemnum@subcmpd {b}{x}{1}{a}",
    );
    assert_eq!(
        keys_numbered("1-1,", &keys(&["a", "b"]), &numbers),
        keys(&["a"])
    );
    assert_eq!(
        keys_numbered("2-2a", &keys(&["b.x", "a"]), &numbers),
        keys(&["b.x"])
    );
    assert_eq!(keys_numbered("1", &keys(&["a"]), &numbers), keys(&["a"]));
    assert!(keys_numbered("2023", &keys(&["a", "b"]), &numbers).is_empty());
    assert!(keys_numbered("1-3", &keys(&["a", "b"]), &numbers).is_empty());
    assert_eq!(without_counter_prefix("[1]", &numbers), "");
    let plain = parse_compound_numbers(r"\chemnum@cmpd {a}{1}{1}{}{}{}{}{\bfseries }");
    assert!(keys_numbered("4-1", &keys(&["a"]), &plain).is_empty());
    assert!(numbers.prints("(2a)") && numbers.prints("1-1") && !numbers.prints("2023"));
}

#[test]
fn a_builds_aux_and_its_inputs_are_read_from_its_folder() {
    let dir = std::env::temp_dir().join(format!("lattice-compounds-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("build/chapters")).unwrap();
    std::fs::write(
        dir.join("build/main.aux"),
        "\\chemnum@cmpd {ketone}{1}{1}{}{}{}{}{\\bfseries }\n\\@input{chapters/two.aux}\n\\@input{../escape.aux}\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("build/chapters/two.aux"),
        "\\chemnum@cmpd {amine}{2}{2}{}{}{}{}{\\bfseries }\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("escape.aux"),
        "\\chemnum@cmpd {outside}{9}{9}{}{}{}{}{\\bfseries }\n",
    )
    .unwrap();
    let found = read_compound_numbers(&dir, "main.tex", "build");
    assert_eq!(map(&found), pairs(&[("ketone", "1"), ("amine", "2")]));
    assert!(read_compound_numbers(&dir, "main.tex", "").is_empty());
    std::fs::remove_dir_all(&dir).ok();
}
