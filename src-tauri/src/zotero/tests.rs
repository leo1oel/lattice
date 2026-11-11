use super::*;
use crate::test_support::TempDir;

/// The part of Zotero's schema the reader uses, as Zotero 10 lays it out.
const SCHEMA: &str = "
CREATE TABLE version (schema TEXT PRIMARY KEY, version INT NOT NULL);
INSERT INTO version VALUES ('userdata', 131);
CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
INSERT INTO libraries VALUES (1, 'user'), (2, 'group');
CREATE TABLE itemTypesCombined (itemTypeID INT, typeName TEXT);
INSERT INTO itemTypesCombined VALUES (1, 'journalArticle'), (2, 'preprint'), (3, 'conferencePaper'), (4, 'attachment'), (5, 'note');
CREATE TABLE fieldsCombined (fieldID INT, fieldName TEXT);
INSERT INTO fieldsCombined VALUES (1, 'title'), (2, 'date'), (3, 'publicationTitle'), (4, 'DOI'), (5, 'archiveID'),
  (6, 'url'), (7, 'extra'), (8, 'citationKey'), (9, 'pages'), (10, 'proceedingsTitle'), (11, 'volume');
CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, libraryID INT, key TEXT);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value);
CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
CREATE TABLE creatorTypes (creatorTypeID INT, creatorType TEXT);
INSERT INTO creatorTypes VALUES (1, 'author'), (2, 'editor');
CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, libraryID INT, key TEXT);
CREATE TABLE collectionItems (collectionID INT, itemID INT, orderIndex INT);
CREATE TABLE deletedCollections (collectionID INT);
CREATE TABLE itemAttachments (itemID INT, parentItemID INT, linkMode INT, contentType TEXT, path TEXT);
CREATE TABLE deletedItems (itemID INT);
";

/// A Zotero data directory with a small library, Zotero's own way: in WAL
/// mode, with the connection kept open under an exclusive lock as Zotero
/// keeps it, so the last write is still only in the log.
struct Library {
    dir: TempDir,
    live: rusqlite::Connection,
}

impl Library {
    fn new() -> Self {
        let dir = TempDir::new("zotero");
        let live = rusqlite::Connection::open(dir.join("zotero.sqlite")).unwrap();
        live.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;").unwrap();
        live.execute_batch(SCHEMA).unwrap();
        Self { dir, live }
    }

    fn item(
        &self, id: i64, kind: i64, key: &str, fields: &[(i64, &str)], authors: &[(&str, &str)],
    ) {
        self.live
            .execute("INSERT INTO items VALUES (?1, ?2, 1, ?3)", params![id, kind, key])
            .unwrap();
        for (field, value) in fields {
            self.live.execute("INSERT INTO itemDataValues (value) VALUES (?1)", [value]).unwrap();
            let value_id = self.live.last_insert_rowid();
            self.live
                .execute("INSERT INTO itemData VALUES (?1, ?2, ?3)", params![id, field, value_id])
                .unwrap();
        }
        for (index, (first, last)) in authors.iter().enumerate() {
            self.live
                .execute(
                    "INSERT INTO creators (firstName, lastName, fieldMode) VALUES (?1, ?2, 0)",
                    [first, last],
                )
                .unwrap();
            let creator = self.live.last_insert_rowid();
            self.live
                .execute(
                    "INSERT INTO itemCreators VALUES (?1, ?2, 1, ?3)",
                    params![id, creator, index as i64],
                )
                .unwrap();
        }
    }

    fn path(&self) -> Option<&str> {
        self.dir.to_str()
    }
}

use rusqlite::params;

fn library() -> Library {
    let library = Library::new();
    library.live.execute_batch("
        INSERT INTO collections VALUES (1, 'Thesis', NULL, 1, 'THESIS01'), (2, 'Chapter 3', 1, 1, 'CHAP0003'),
          (3, 'Old', NULL, 1, 'OLD00001'), (4, 'Group stuff', NULL, 2, 'GROUP001');
        INSERT INTO deletedCollections VALUES (3);
    ").unwrap();
    library.item(
        10,
        1,
        "ALPHA001",
        &[
            (1, "Highly accurate protein structure prediction with AlphaFold"),
            (2, "2021-08-26 2021-08-26"),
            (3, "Nature"),
            (4, "10.1038/s41586-021-03819-2"),
            (9, "583-589"),
            (11, "596"),
        ],
        &[("John", "Jumper"), ("Richard", "Evans")],
    );
    library.item(
        11,
        2,
        "MAMBA001",
        &[
            (1, "Mamba: Linear-Time Sequence Modeling with Selective State Spaces"),
            (2, "2023-12-01"),
            (5, "arXiv:2312.00752"),
            (6, "http://arxiv.org/abs/2312.00752"),
        ],
        &[("Albert", "Gu"), ("Tri", "Dao")],
    );
    library.item(
        12,
        3,
        "RESNET01",
        &[
            (1, "Deep Residual Learning for Image Recognition"),
            (2, "2016"),
            (8, "He2016ResNet"),
            (10, "CVPR"),
        ],
        &[("Kaiming", "He")],
    );
    library.item(
        13,
        3,
        "BERT0001",
        &[
            (1, "BERT: Pre-training of Deep Bidirectional Transformers"),
            (2, "2019-06-00 June 2019"),
            (7, "Citation Key: devlin2019bert"),
        ],
        &[("Jacob", "Devlin")],
    );
    library.item(14, 1, "TRASHED1", &[(1, "In the trash")], &[]);
    library.item(15, 4, "PDF00001", &[], &[]);
    library.item(16, 5, "NOTE0001", &[], &[]);
    library.live.execute_batch("
        INSERT INTO deletedItems VALUES (14);
        INSERT INTO collectionItems VALUES (2, 10, 0), (2, 13, 1), (2, 14, 2), (1, 11, 0);
        INSERT INTO itemAttachments VALUES (15, 13, 1, 'application/pdf', 'storage:Devlin 2019 BERT.pdf');
    ").unwrap();
    library.dir.write("storage/PDF00001/Devlin 2019 BERT.pdf", b"%PDF-1.4");
    library
}

/// The items of one read, in itemID order.
fn items(library: &Library) -> Vec<ZoteroItem> {
    super::library(library.path()).unwrap().items
}

/// The citation keys of the items directly in `collection`.
fn keys_in(items: &[ZoteroItem], collection: &str) -> Vec<String> {
    items
        .iter()
        .filter(|item| item.collections.iter().any(|key| key == collection))
        .map(|item| item.citation_key.clone())
        .collect()
}

#[test]
fn collections_come_from_a_copy_while_zotero_holds_the_database() {
    let library = library();
    library
        .live
        .execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")
        .unwrap();
    // The live file cannot be opened beside Zotero; its copy can.
    let beside = rusqlite::Connection::open(library.dir.join("zotero.sqlite")).unwrap();
    assert!(beside
        .query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
        .is_err());

    let read = super::library(library.path()).unwrap();
    assert_eq!(
        read.collections,
        vec![
            ZoteroCollection {
                key: "CHAP0003".into(),
                name: "Chapter 3".into(),
                parent: Some("THESIS01".into()),
            },
            ZoteroCollection { key: "THESIS01".into(), name: "Thesis".into(), parent: None },
        ]
    );
    // The live database is untouched: Zotero's connection still writes to it.
    library
        .live
        .execute("INSERT INTO collections VALUES (9, 'After', NULL, 1, 'AFTER001')", [])
        .unwrap();
}

#[test]
fn native_absolute_linked_pdfs_are_imported() {
    let library = library();
    let path = library.dir.write("linked paper.pdf", b"%PDF-1.4");
    library.item(19, 4, "ABSOLUTE", &[], &[]);
    library
        .live
        .execute(
            "INSERT INTO itemAttachments VALUES (19, 10, 2, 'application/pdf', ?1)",
            [path.to_str().unwrap()],
        )
        .unwrap();
    let read = super::library(library.path()).unwrap();
    let item = read.items.iter().find(|item| item.citation_key == "jumper_highly_2021").unwrap();
    assert_eq!(item.pdf.as_deref(), Some("ABSOLUTE"));
    assert_eq!(attachment_path("ABSOLUTE").unwrap(), path);
}

#[test]
fn a_collection_reads_as_bibtex_under_the_keys_the_writer_cites() {
    let library = library();
    // A PDF key no other test reads: attachment keys are remembered process-wide.
    library.item(18, 4, "JUMPPDF1", &[], &[]);
    library
        .live
        .execute("INSERT INTO itemAttachments VALUES (18, 10, 1, 'application/pdf', 'storage:Jumper 2021.pdf')", [])
        .unwrap();
    library.dir.write("storage/JUMPPDF1/Jumper 2021.pdf", b"%PDF-1.4");
    let all = items(&library);
    // The trashed item is left out; a key pinned in Extra is kept.
    assert_eq!(keys_in(&all, "CHAP0003"), ["jumper_highly_2021", "devlin2019bert"]);
    let items: Vec<&ZoteroItem> =
        all.iter().filter(|item| item.collections == ["CHAP0003"]).collect();
    assert_eq!(
        items[0].bibtex,
        "@article{jumper_highly_2021,\n  title = {Highly accurate protein structure prediction with AlphaFold},\n  author = {Jumper, John and Evans, Richard},\n  journal = {Nature},\n  year = {2021},\n  volume = {596},\n  pages = {583--589},\n  doi = {10.1038/s41586-021-03819-2}\n}"
    );
    assert!(items[1].bibtex.starts_with("@inproceedings{devlin2019bert,\n"), "{}", items[1].bibtex);
    assert!(items[1].bibtex.contains("  year = {2019}"), "{}", items[1].bibtex);
    // Its PDF is named by key, and only that key resolves to the file.
    assert_eq!(items[1].pdf.as_deref(), Some("PDF00001"));
    assert_eq!(items[0].pdf.as_deref(), Some("JUMPPDF1"));
    assert_eq!(
        attachment_path("JUMPPDF1").unwrap(),
        library.dir.join("storage/JUMPPDF1/Jumper 2021.pdf")
    );
    assert!(attachment_path("NOPE0001").is_err());
}

#[test]
fn the_whole_library_carries_arxiv_ids_and_zoteros_citation_key_field() {
    let library = library();
    let items = items(&library);
    let by_key: HashMap<&str, &ZoteroItem> =
        items.iter().map(|item| (item.citation_key.as_str(), item)).collect();
    assert_eq!(items.len(), 4, "{:?}", by_key.keys());
    let mamba = by_key["gu_mamba_2023"];
    assert!(mamba.bibtex.starts_with("@misc{gu_mamba_2023,\n"), "{}", mamba.bibtex);
    assert!(
        mamba.bibtex.contains("  eprint = {2312.00752},\n  archiveprefix = {arXiv}"),
        "{}",
        mamba.bibtex
    );
    assert!(by_key["He2016ResNet"].bibtex.contains("  booktitle = {CVPR}"));
}

#[test]
fn better_bibtex_keys_come_first() {
    let library = library();
    let bbt = rusqlite::Connection::open(library.dir.join("better-bibtex.sqlite")).unwrap();
    bbt.execute_batch("
        CREATE TABLE citationkey (itemID INT, itemKey TEXT, libraryID INT, citationKey TEXT, pinned INT);
        INSERT INTO citationkey VALUES (10, 'ALPHA001', 1, 'Jumper2021AlphaFold', 0), (12, 'RESNET01', 1, 'HeResNet', 1);
    ").unwrap();
    let keys: Vec<String> = items(&library).into_iter().map(|item| item.citation_key).collect();
    assert_eq!(keys, ["Jumper2021AlphaFold", "gu_mamba_2023", "HeResNet", "devlin2019bert"]);
}

#[test]
fn a_write_still_in_zoteros_log_is_read() {
    let library = library();
    library.item(20, 1, "NEWEST01", &[(1, "Just saved")], &[("Ada", "Lee")]);
    library.live.execute("INSERT INTO collectionItems VALUES (1, 20, 1)", []).unwrap();
    let wal = std::fs::metadata(library.dir.join("zotero.sqlite-wal")).unwrap().len();
    assert!(wal > 0);
    let items = items(&library);
    assert!(keys_in(&items, "THESIS01").contains(&"lee_just".to_string()), "{items:?}");
}

#[test]
fn only_regular_items_are_listed_with_the_collections_they_sit_in() {
    let library = library();
    // A standalone note and a standalone PDF sit beside the regular items, and
    // an item is also in a trashed collection.
    library.item(17, 4, "LOOSEPDF", &[], &[]);
    library
        .live
        .execute_batch(
            "
        INSERT INTO itemAttachments VALUES (17, NULL, 1, 'application/pdf', 'storage:loose.pdf');
        INSERT INTO collectionItems VALUES (2, 16, 3), (2, 17, 4), (3, 11, 0), (2, 11, 5);
    ",
        )
        .unwrap();
    library.dir.write("storage/LOOSEPDF/loose.pdf", b"%PDF-1.4");
    let items = items(&library);
    assert_eq!(items.len(), 4);
    let mamba = items.iter().find(|item| item.citation_key == "gu_mamba_2023").unwrap();
    assert_eq!(mamba.collections, ["THESIS01", "CHAP0003"]);
    assert_eq!(
        keys_in(&items, "CHAP0003"),
        ["jumper_highly_2021", "gu_mamba_2023", "devlin2019bert"]
    );
}

#[test]
fn generated_keys_never_take_a_key_another_item_is_cited_by() {
    let library = library();
    library
        .live
        .execute_batch(
            "
        INSERT INTO collections VALUES (5, 'A', NULL, 1, 'COLLA001'), (6, 'B', NULL, 1, 'COLLB001');
    ",
        )
        .unwrap();
    // Two items that generate the same key, the earlier one only in B.
    library.item(30, 1, "WANGLRN1", &[(1, "Learning to rank"), (2, "2023")], &[("Wei", "Wang")]);
    library.item(31, 1, "WANGLRN2", &[(1, "Learning to see"), (2, "2023")], &[("Li", "Wang")]);
    // An item whose generated key another, later item has pinned.
    library.item(32, 1, "LEEGRAPH", &[(1, "Graph networks"), (2, "2020")], &[("Ada", "Lee")]);
    library.item(33, 1, "PINNED01", &[(1, "Other"), (7, "Citation Key: lee_graph_2020")], &[]);
    library
        .live
        .execute_batch(
            "
        INSERT INTO collectionItems VALUES (5, 31, 0), (5, 32, 1), (6, 30, 0);
    ",
        )
        .unwrap();
    let items = items(&library);
    // The earlier item keeps the plain key even though only B holds it.
    assert_eq!(keys_in(&items, "COLLB001"), ["wang_learning_2023"]);
    assert_eq!(keys_in(&items, "COLLA001"), ["wang_learning_2023b", "lee_graph_2020b"]);
    let lee: Vec<&str> = items
        .iter()
        .map(|item| item.citation_key.as_str())
        .filter(|key| key.starts_with("lee_graph_2020"))
        .collect();
    assert_eq!(lee, ["lee_graph_2020b", "lee_graph_2020"]);
}

#[test]
fn a_pinned_key_two_items_share_stays_with_the_first() {
    let library = library();
    // Zotero's Duplicate Item copies the Citation Key field; Extra pins the
    // same key in another case.
    library.item(50, 1, "SMITH001", &[(1, "Original"), (8, "smith2020")], &[]);
    library.item(51, 1, "SMITH002", &[(1, "Duplicate"), (8, "smith2020")], &[]);
    library.item(52, 1, "SMITH003", &[(1, "Third"), (7, "Citation Key: Smith2020")], &[]);
    let keys: Vec<String> = items(&library)
        .into_iter()
        .map(|item| item.citation_key)
        .filter(|key| key.to_lowercase().starts_with("smith2020"))
        .collect();
    assert_eq!(keys, ["smith2020", "smith2020b", "Smith2020c"]);
}

#[test]
fn zoteros_rich_text_becomes_latex() {
    let library = library();
    library.item(
        40,
        1,
        "RICHTEXT",
        &[
            (
                1,
                "<i>Drosophila</i> genes, H<sub>2</sub>O, x<sup>2</sup>, <b>bold</b>, <sc>Small</sc>, <span class=\"nocase\">iPhone</span>, O(n^2), a~b\\c, <i>open",
            ),
            (2, "2020"),
        ],
        &[("Min", "Kim")],
    );
    let items = items(&library);
    let item = items.iter().find(|item| item.citation_key == "kim_drosophila_2020").unwrap();
    assert!(
        item.bibtex.contains(
            "  title = {\\textit{Drosophila} genes, H\\textsubscript{2}O, x\\textsuperscript{2}, \\textbf{bold}, \\textsc{Small}, {iPhone}, O(n\\^{}2), a\\textasciitilde{}b\\textbackslash{}c, \\textit{open}},\n"
        ),
        "{}",
        item.bibtex
    );
}

#[test]
fn an_absent_or_unknown_library_says_so() {
    let empty = TempDir::new("no-zotero");
    assert_eq!(super::library(empty.to_str()).unwrap_err(), NOT_FOUND);
    let odd = TempDir::new("odd-zotero");
    rusqlite::Connection::open(odd.join("zotero.sqlite"))
        .unwrap()
        .execute_batch("CREATE TABLE items (itemID INT);")
        .unwrap();
    let error = super::library(odd.to_str()).unwrap_err();
    assert!(error.starts_with("Lattice couldn't read the Zotero library: this Zotero database (schema unknown) has no items.itemTypeID"), "{error}");
}

#[test]
fn the_default_profile_names_the_data_directory() {
    let support = TempDir::new("zotero-support");
    support.write(
        "profiles.ini",
        "[Profile1]\nName=other\nIsRelative=1\nPath=Profiles/other\n\n[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abc.default\nDefault=1\n\n[General]\nStartWithLastProfile=1\n",
    );
    support.write(
        "Profiles/abc.default/prefs.js",
        "user_pref(\"extensions.zotero.dataDir\", \"/Volumes/Research/Zotero\");\nuser_pref(\"extensions.zotero.useDataDir\", true);\n",
    );
    assert_eq!(profile_data_dir(&support), Some(PathBuf::from("/Volumes/Research/Zotero")));
    // Linked files resolve against the default profile's base, not the first listed.
    support.write(
        "Profiles/other/prefs.js",
        "user_pref(\"extensions.zotero.baseAttachmentPath\", \"/Users/other/Papers\");\n",
    );
    support.write(
        "Profiles/abc.default/prefs.js",
        "user_pref(\"extensions.zotero.dataDir\", \"/Volumes/Research/Zotero\");\nuser_pref(\"extensions.zotero.baseAttachmentPath\", \"/Volumes/Research/Papers\");\n",
    );
    assert_eq!(profile_data_dir(&support), None);
    assert_eq!(attachment_base(&support), Some(PathBuf::from("/Volumes/Research/Papers")));
}

/// Reads the Zotero library on this Mac (or `ZOTERO_DATA_DIR`) and prints
/// what the picker and the import would get, for checking against a real
/// Zotero: `cargo test --lib zotero::tests::real -- --ignored --nocapture`.
#[test]
#[ignore = "reads the Zotero library of whoever runs it"]
fn real_library() {
    let chosen = std::env::var("ZOTERO_DATA_DIR").ok();
    let read = super::library(chosen.as_deref()).unwrap();
    println!("{} collections", read.collections.len());
    let items = read.items;
    println!(
        "{} items, {} with a PDF on this Mac",
        items.len(),
        items.iter().filter(|item| item.pdf.is_some()).count()
    );
    let filter = std::env::var("ZOTERO_TITLE_FILTER").unwrap_or_default().to_lowercase();
    for item in items.iter().filter(|item| {
        filter.is_empty() || filter.split('|').any(|word| item.bibtex.to_lowercase().contains(word))
    }) {
        println!(
            "--- pdf: {:?} -> {:?}\n{}",
            item.pdf,
            item.pdf.as_deref().map(attachment_path),
            item.bibtex
        );
    }
}
