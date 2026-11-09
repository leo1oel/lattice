//! The queries over a copy of zotero.sqlite. Only tables and columns that
//! Zotero 5 through 10 all share are read (items, itemData by field name,
//! creators, collections, attachments, the trash), and their presence is
//! checked first, so a future schema that drops one fails with a clear error
//! instead of an empty library.

use super::bibtex::{self, Creator, Record};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// The personal library; group libraries are not read.
const USER_LIBRARY: i64 = 1;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroCollection {
    pub key: String,
    pub name: String,
    /// The collection it sits in, by key; None at the top.
    pub parent: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItem {
    /// The item's BibTeX entry, under `citation_key`.
    pub bibtex: String,
    pub citation_key: String,
    /// Its PDF attachment's item key, for `attachment_path`.
    pub pdf: Option<String>,
    /// The collections it sits in directly (not through a subcollection), by
    /// key.
    pub collections: Vec<String>,
}

/// The items an import brings in, over `items i` joined to
/// `itemTypesCombined t`: the personal library's (`?1`) top-level regular
/// items, trash aside.
const IMPORTABLE: &str = "i.libraryID = ?1
    AND t.typeName NOT IN ('attachment', 'note', 'annotation')
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)";

/// The tables and columns read here; a database without them is not one this
/// code understands.
const REQUIRED: &[(&str, &[&str])] = &[
    ("items", &["itemID", "itemTypeID", "libraryID", "key"]),
    ("itemTypesCombined", &["itemTypeID", "typeName"]),
    ("itemData", &["itemID", "fieldID", "valueID"]),
    ("itemDataValues", &["valueID", "value"]),
    ("fieldsCombined", &["fieldID", "fieldName"]),
    ("creators", &["creatorID", "firstName", "lastName", "fieldMode"]),
    ("itemCreators", &["itemID", "creatorID", "creatorTypeID", "orderIndex"]),
    ("creatorTypes", &["creatorTypeID", "creatorType"]),
    ("collections", &["collectionID", "collectionName", "parentCollectionID", "libraryID", "key"]),
    ("collectionItems", &["collectionID", "itemID"]),
    ("itemAttachments", &["itemID", "parentItemID", "linkMode", "contentType", "path"]),
    ("deletedItems", &["itemID"]),
];

fn check_schema(db: &Connection) -> Result<(), String> {
    let version: Option<i64> = db
        .query_row("SELECT version FROM version WHERE schema = 'userdata'", [], |row| row.get(0))
        .optional()
        .unwrap_or(None);
    for (table, columns) in REQUIRED {
        let mut statement =
            db.prepare(&format!("PRAGMA table_info({table})")).map_err(|e| e.to_string())?;
        let present: HashSet<String> = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        if let Some(missing) = columns.iter().find(|column| !present.contains(**column)) {
            return Err(format!(
                "this Zotero database (schema {}) has no {table}.{missing}",
                version.map(|v| v.to_string()).unwrap_or_else(|| "unknown".into())
            ));
        }
    }
    Ok(())
}

pub(super) fn collections(db: &Connection) -> Result<Vec<ZoteroCollection>, String> {
    check_schema(db)?;
    let mut statement = db
        .prepare(&format!(
            "SELECT c.key, c.collectionName, p.key
             FROM collections c LEFT JOIN collections p ON p.collectionID = c.parentCollectionID
             WHERE c.libraryID = ?1 {}
             ORDER BY lower(c.collectionName)",
            live_collections(db, "c")
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![USER_LIBRARY], |row| {
            Ok(ZoteroCollection { key: row.get(0)?, name: row.get(1)?, parent: row.get(2)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// The condition that leaves out trashed collections, over `alias`; none when
/// this Zotero has no collection trash.
fn live_collections(db: &Connection, alias: &str) -> String {
    if table_exists(db, "deletedCollections") {
        format!("AND {alias}.collectionID NOT IN (SELECT collectionID FROM deletedCollections)")
    } else {
        String::new()
    }
}

fn table_exists(db: &Connection, table: &str) -> bool {
    db.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |_| {
        Ok(())
    })
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// Each top-level regular item of the library, with the collections it is in
/// and the path of its PDF when the file is on this Mac. `base` is the
/// directory linked `attachments:` files are relative to.
///
/// Every pinned key is taken first, then keys go out in itemID order: an item
/// keeps its pinned key unless an earlier item claimed it, and a repeated
/// pinned key or a generated one gets a suffix, so no two items share a key.
pub(super) fn items(
    db: &Connection, better_bibtex: Option<&Connection>, data_dir: &Path, base: Option<&Path>,
) -> Result<Vec<(ZoteroItem, Option<PathBuf>)>, String> {
    check_schema(db)?;
    let listed: Vec<(i64, String, String)> = db
        .prepare(&format!(
            "SELECT i.itemID, i.key, t.typeName FROM items i
             JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
             WHERE {IMPORTABLE}
             ORDER BY i.itemID"
        ))
        .map_err(|e| e.to_string())?
        .query_map(params![USER_LIBRARY], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut memberships: HashMap<i64, Vec<String>> = HashMap::new();
    let mut statement = db
        .prepare(&format!(
            "SELECT ci.itemID, c.key FROM collectionItems ci
             JOIN collections c ON c.collectionID = ci.collectionID
             WHERE c.libraryID = ?1 {}
             ORDER BY ci.itemID, c.collectionID",
            live_collections(db, "c")
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![USER_LIBRARY], |row| Ok((row.get::<_, i64>(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (item, collection) = row.map_err(|e| e.to_string())?;
        memberships.entry(item).or_default().push(collection);
    }
    let better_bibtex_keys = better_bibtex.map(better_bibtex_keys).unwrap_or_default();
    let mut read = Vec::with_capacity(listed.len());
    for (id, key, item_type) in listed {
        let fields = fields(db, id)?;
        let pinned = [
            better_bibtex_keys.get(&key).cloned(),
            fields.get("citationKey").cloned(),
            bibtex::extra_value(
                fields.get("extra").map(String::as_str).unwrap_or(""),
                "citation key",
            ),
        ]
        .into_iter()
        .flatten()
        .find(|candidate| bibtex::is_citation_key(candidate));
        read.push((id, item_type, fields, creators(db, id)?, pinned));
    }
    let mut taken: HashSet<String> = read
        .iter()
        .filter_map(|(.., pinned)| pinned.as_ref())
        .map(|key| key.to_lowercase())
        .collect();
    let mut claimed: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(read.len());
    for (id, item_type, fields, creators, pinned) in read {
        let record = Record { item_type: &item_type, fields: &fields, creators: &creators };
        let citation_key = match pinned {
            Some(key) if claimed.insert(key.to_lowercase()) => key,
            pinned => {
                let key = bibtex::unique_key(
                    &pinned.unwrap_or_else(|| bibtex::generated_key(&record)),
                    &taken,
                );
                taken.insert(key.to_lowercase());
                key
            }
        };
        let pdf = pdf_attachment(db, id, data_dir, base)?;
        out.push((
            ZoteroItem {
                bibtex: bibtex::entry(&record, &citation_key),
                citation_key,
                pdf: pdf.as_ref().map(|(key, _)| key.clone()),
                collections: memberships.remove(&id).unwrap_or_default(),
            },
            pdf.map(|(_, path)| path),
        ));
    }
    Ok(out)
}

fn fields(db: &Connection, item: i64) -> Result<HashMap<String, String>, String> {
    let mut statement = db
        .prepare_cached(
            "SELECT f.fieldName, v.value FROM itemData d
             JOIN fieldsCombined f ON f.fieldID = d.fieldID
             JOIN itemDataValues v ON v.valueID = d.valueID
             WHERE d.itemID = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([item], |row| Ok((row.get::<_, String>(0)?, value_text(row.get_ref(1)?))))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// itemDataValues.value is untyped: years and volumes may be stored as numbers.
fn value_text(value: rusqlite::types::ValueRef<'_>) -> String {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(n) => n.to_string(),
        ValueRef::Text(text) | ValueRef::Blob(text) => String::from_utf8_lossy(text).into_owned(),
        ValueRef::Null => String::new(),
    }
}

fn creators(db: &Connection, item: i64) -> Result<Vec<Creator>, String> {
    let mut statement = db
        .prepare_cached(
            "SELECT t.creatorType, c.firstName, c.lastName, c.fieldMode FROM itemCreators ic
             JOIN creators c ON c.creatorID = ic.creatorID
             JOIN creatorTypes t ON t.creatorTypeID = ic.creatorTypeID
             WHERE ic.itemID = ?1 ORDER BY ic.orderIndex",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([item], |row| {
            Ok(Creator {
                role: row.get(0)?,
                first: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                last: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                single_field: row.get::<_, Option<i64>>(3)?.unwrap_or(0) == 1,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// The item's first PDF attachment whose file exists: a stored copy
/// (`storage:<file>` under storage/<attachment key>/) or a linked file (an
/// absolute path, or `attachments:<path>` under the base directory).
fn pdf_attachment(
    db: &Connection, item: i64, data_dir: &Path, base: Option<&Path>,
) -> Result<Option<(String, PathBuf)>, String> {
    let mut statement = db
        .prepare_cached(
            "SELECT i.key, a.linkMode, a.path FROM itemAttachments a
             JOIN items i ON i.itemID = a.itemID
             WHERE a.parentItemID = ?1 AND a.contentType = 'application/pdf' AND a.path IS NOT NULL
               AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
             ORDER BY a.itemID",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64, String)> = statement
        .query_map([item], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().find_map(|(key, link_mode, stored)| {
        let path = match (link_mode, stored.split_once(':')) {
            // Imported file or imported URL: a copy in storage/.
            (0 | 1, Some(("storage", file))) if !file.contains('/') && !file.is_empty() => {
                data_dir.join("storage").join(&key).join(file)
            }
            (2, Some(("attachments", relative))) => base?.join(relative),
            (2, _) if stored.starts_with('/') => PathBuf::from(stored),
            _ => return None,
        };
        path.is_file().then_some((key, path))
    }))
}

/// Better BibTeX's keys by item key (its `citationkey` table), when its
/// database can be read; an unknown layout gives none.
fn better_bibtex_keys(db: &Connection) -> HashMap<String, String> {
    let Ok(mut statement) =
        db.prepare("SELECT itemKey, citationKey FROM citationkey WHERE libraryID = ?1")
    else {
        return HashMap::new();
    };
    statement
        .query_map([USER_LIBRARY], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}
