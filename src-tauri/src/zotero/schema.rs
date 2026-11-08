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
    /// Items directly in it (not in its subcollections), trash aside.
    pub items: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItem {
    /// The item's BibTeX entry, under `citation_key`.
    pub bibtex: String,
    pub citation_key: String,
    /// Its PDF attachment's item key, for `attachment_path`.
    pub pdf: Option<String>,
}

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
    let deleted = table_exists(db, "deletedCollections");
    let mut statement = db
        .prepare(&format!(
            "SELECT c.key, c.collectionName, p.key,
                    (SELECT count(*) FROM collectionItems ci
                     WHERE ci.collectionID = c.collectionID
                       AND ci.itemID NOT IN (SELECT itemID FROM deletedItems))
             FROM collections c LEFT JOIN collections p ON p.collectionID = c.parentCollectionID
             WHERE c.libraryID = ?1 {}
             ORDER BY lower(c.collectionName)",
            if deleted {
                "AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)"
            } else {
                ""
            }
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![USER_LIBRARY], |row| {
            Ok(ZoteroCollection {
                key: row.get(0)?,
                name: row.get(1)?,
                parent: row.get(2)?,
                items: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
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

/// Each top-level regular item of `collection` (the library when None), with
/// the path of its PDF when the file is on this Mac.
pub(super) fn items(
    db: &Connection, better_bibtex: Option<&Connection>, data_dir: &Path, collection: Option<&str>,
) -> Result<Vec<(ZoteroItem, Option<PathBuf>)>, String> {
    check_schema(db)?;
    let mut statement = db
        .prepare(
            "SELECT i.itemID, i.key, t.typeName FROM items i
             JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
             WHERE i.libraryID = ?1
               AND t.typeName NOT IN ('attachment', 'note', 'annotation')
               AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
               AND (?2 IS NULL OR i.itemID IN (
                    SELECT ci.itemID FROM collectionItems ci
                    JOIN collections c ON c.collectionID = ci.collectionID
                    WHERE c.key = ?2 AND c.libraryID = ?1))
             ORDER BY i.itemID",
        )
        .map_err(|e| e.to_string())?;
    let listed: Vec<(i64, String, String)> = statement
        .query_map(params![USER_LIBRARY, collection], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let better_bibtex_keys = better_bibtex.map(better_bibtex_keys).unwrap_or_default();
    let base_path = attachment_base();
    let mut taken: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (id, key, item_type) in listed {
        let fields = fields(db, id)?;
        let creators = creators(db, id)?;
        let record = Record { item_type: &item_type, fields: &fields, creators: &creators };
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
        let citation_key =
            pinned.unwrap_or_else(|| bibtex::unique_key(&bibtex::generated_key(&record), &taken));
        taken.insert(citation_key.to_lowercase());
        let pdf = pdf_attachment(db, id, data_dir, base_path.as_deref())?;
        out.push((
            ZoteroItem {
                bibtex: bibtex::entry(&record, &citation_key),
                citation_key,
                pdf: pdf.as_ref().map(|(key, _)| key.clone()),
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

/// The base directory linked files are relative to, from the default profile.
fn attachment_base() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let support = home.join("Library/Application Support/Zotero");
    let ini = std::fs::read_to_string(support.join("profiles.ini")).ok()?;
    let path = ini.lines().find_map(|line| line.trim().strip_prefix("Path="))?;
    let prefs = std::fs::read_to_string(support.join(path.trim()).join("prefs.js")).ok()?;
    prefs.lines().find_map(|line| {
        let rest =
            line.trim().strip_prefix("user_pref(\"extensions.zotero.baseAttachmentPath\",")?;
        serde_json::from_str::<String>(
            rest.trim().trim_end_matches(';').trim_end_matches(')').trim(),
        )
        .ok()
        .map(PathBuf::from)
    })
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
