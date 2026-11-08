//! The mock Overleaf's documents: text, version, and the operations that got
//! them there, with the transform Overleaf's document updater applies to an
//! update made against an older version.
//!
//! This is ShareJS's `text` type, which the document updater runs: each
//! update arriving at version `v` is transformed, as the left side, against
//! every update applied since `v`, then applied. Only inserts and deletes;
//! comments ride along untransformed elsewhere. Positions count UTF-16 units.

use super::OtOp;
use sha1::{Digest, Sha1};

/// One insert or delete, its text in UTF-16 units as positions count it.
#[derive(Debug, Clone, PartialEq)]
struct Component {
    p: usize,
    i: Option<Vec<u16>>,
    d: Option<Vec<u16>>,
}

type Op = Vec<Component>;

fn component(op: &OtOp) -> Component {
    let units = |text: &Option<String>| text.as_deref().map(|text| text.encode_utf16().collect());
    Component { p: op.p, i: units(&op.i), d: units(&op.d) }
}

/// An `OtOp` list with each operation holding at most one of an insert and a
/// delete, as the wire allows, split into components.
fn components(ops: &[OtOp]) -> Op {
    let mut split = Vec::new();
    for op in ops {
        let Component { p, i, d } = component(op);
        if d.is_some() {
            split.push(Component { p, i: None, d });
        }
        if i.is_some() {
            split.push(Component { p, i, d: None });
        }
    }
    split
}

/// A document as the mock serves it.
#[derive(Debug, Clone)]
pub(crate) struct MockDoc {
    text: Vec<u16>,
    /// The version the first entry of `applied` was applied at.
    from: i64,
    applied: Vec<Op>,
}

/// Why the mock refused an update.
#[derive(Debug, PartialEq)]
pub(crate) enum Refused {
    /// From a version the document never had.
    Version,
    /// Deletes text that is not there.
    Mismatch,
    /// Applied cleanly, but not to what the sender said it would.
    Hash,
}

impl MockDoc {
    pub(crate) fn new(text: &str, version: i64) -> Self {
        MockDoc { text: text.encode_utf16().collect(), from: version, applied: Vec::new() }
    }

    pub(crate) fn text(&self) -> String {
        String::from_utf16(&self.text).expect("the mock keeps whole characters")
    }

    pub(crate) fn version(&self) -> i64 {
        self.from + self.applied.len() as i64
    }

    /// Apply `ops` sent against version `at`, transformed against everything
    /// applied since, and answer with the version it applied at. `hash` is
    /// checked only when nothing had to be transformed, as Overleaf does.
    pub(crate) fn submit(
        &mut self, at: i64, ops: &[OtOp], hash: Option<&str>,
    ) -> Result<i64, Refused> {
        if at < self.from || at > self.version() {
            return Err(Refused::Version);
        }
        let mut op = components(ops);
        let concurrent = &self.applied[(at - self.from) as usize..];
        for other in concurrent {
            op = transform(&op, other);
        }
        let mut text = self.text.clone();
        for c in &op {
            apply(&mut text, c).ok_or(Refused::Mismatch)?;
        }
        if concurrent.is_empty() && hash.is_some_and(|hash| hash != units_hash(&text)) {
            return Err(Refused::Hash);
        }
        let version = self.version();
        self.text = text;
        self.applied.push(op);
        Ok(version)
    }
}

fn apply(text: &mut Vec<u16>, c: &Component) -> Option<()> {
    if let Some(deleted) = &c.d {
        if text.get(c.p..c.p + deleted.len()) != Some(&deleted[..]) {
            return None;
        }
        text.drain(c.p..c.p + deleted.len());
    }
    if let Some(inserted) = &c.i {
        if c.p > text.len() {
            return None;
        }
        text.splice(c.p..c.p, inserted.iter().copied());
    }
    Some(())
}

fn units_hash(text: &[u16]) -> String {
    let utf8 = String::from_utf16(text).expect("the mock keeps whole characters");
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", text.len()).as_bytes());
    hasher.update(utf8.as_bytes());
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `text.transform(op, other, 'left')`.
fn transform(op: &Op, other: &Op) -> Op {
    transform_x(op.clone(), other.clone()).0
}

// ---- ShareJS `text`, transcribed ------------------------------------------

fn append(op: &mut Op, c: Component) {
    if c.i.as_ref().is_some_and(Vec::is_empty) || c.d.as_ref().is_some_and(Vec::is_empty) {
        return;
    }
    if let Some(last) = op.last_mut() {
        if let (Some(last_i), Some(i)) = (&mut last.i, &c.i) {
            if last.p <= c.p && c.p <= last.p + last_i.len() {
                let at = c.p - last.p;
                last_i.splice(at..at, i.iter().copied());
                return;
            }
        }
        if let (Some(last_d), Some(d)) = (&last.d, &c.d) {
            if c.p <= last.p && last.p <= c.p + d.len() {
                let mut joined = d.clone();
                let at = last.p - c.p;
                joined.splice(at..at, last_d.iter().copied());
                *last = Component { p: c.p, i: None, d: Some(joined) };
                return;
            }
        }
    }
    op.push(c);
}

fn transform_position(pos: usize, c: &Component, insert_after: bool) -> usize {
    match (&c.i, &c.d) {
        (Some(i), _) if c.p < pos || (c.p == pos && insert_after) => pos + i.len(),
        (Some(_), _) => pos,
        (None, Some(_)) if pos <= c.p => pos,
        (None, Some(d)) if pos <= c.p + d.len() => c.p,
        (None, Some(d)) => pos - d.len(),
        (None, None) => pos,
    }
}

fn transform_component(dest: &mut Op, c: &Component, other: &Component, left: bool) {
    if let Some(i) = &c.i {
        let p = transform_position(c.p, other, !left);
        append(dest, Component { p, i: Some(i.clone()), d: None });
        return;
    }
    let Some(d) = &c.d else { return };
    let piece = |p: usize, d: &[u16]| Component { p, i: None, d: Some(d.to_vec()) };
    match (&other.i, &other.d) {
        (Some(other_i), _) => {
            let mut rest = &d[..];
            if c.p < other.p {
                let cut = (other.p - c.p).min(d.len());
                append(dest, piece(c.p, &d[..cut]));
                rest = &d[cut..];
            }
            if !rest.is_empty() {
                append(dest, piece(c.p + other_i.len(), rest));
            }
        }
        (None, Some(other_d)) => {
            if c.p >= other.p + other_d.len() {
                append(dest, piece(c.p - other_d.len(), d));
            } else if c.p + d.len() <= other.p {
                append(dest, c.clone());
            } else {
                let mut kept = Vec::new();
                if c.p < other.p {
                    kept.extend_from_slice(&d[..other.p - c.p]);
                }
                if c.p + d.len() > other.p + other_d.len() {
                    kept.extend_from_slice(&d[other.p + other_d.len() - c.p..]);
                }
                append(dest, piece(transform_position(c.p, other, false), &kept));
            }
        }
        (None, None) => append(dest, c.clone()),
    }
}

/// ShareJS's `bootstrapTransform` `transformX`: both ops transformed against
/// each other, `left` the one whose inserts go first at a tie.
fn transform_x(mut left: Op, right: Op) -> (Op, Op) {
    let mut new_right = Vec::new();
    for right_component in right {
        let mut right_component = Some(right_component);
        let mut new_left = Vec::new();
        let mut k = 0;
        while k < left.len() {
            let current = right_component.take().expect("set until the loop breaks");
            let mut next = Vec::new();
            transform_component(&mut new_left, &left[k], &current, true);
            transform_component(&mut next, &current, &left[k], false);
            k += 1;
            match next.len() {
                1 => right_component = next.pop(),
                0 => {
                    for c in &left[k..] {
                        append(&mut new_left, c.clone());
                    }
                    break;
                }
                _ => {
                    let (l, r) = transform_x(left[k..].to_vec(), next);
                    for c in l {
                        append(&mut new_left, c);
                    }
                    for c in r {
                        append(&mut new_right, c);
                    }
                    break;
                }
            }
        }
        if let Some(c) = right_component {
            append(&mut new_right, c);
        }
        left = new_left;
    }
    (left, new_right)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ins(p: usize, text: &str) -> OtOp {
        OtOp { p, i: Some(text.into()), d: None, u: None }
    }

    fn del(p: usize, text: &str) -> OtOp {
        OtOp { p, i: None, d: Some(text.into()), u: None }
    }

    #[test]
    fn a_late_update_is_transformed_past_what_landed_first() {
        let mut doc = MockDoc::new("Hello world.", 10);
        // A collaborator typed at the end first...
        assert_eq!(doc.submit(10, &[ins(11, ", again")], None), Ok(10));
        // ...then ours, made against 10, replaces "Hello".
        assert_eq!(doc.submit(10, &[del(0, "Hello"), ins(0, "Goodbye")], None), Ok(11));
        assert_eq!(doc.text(), "Goodbye world, again.");
        // Typing inside a span deleted meanwhile survives the deletion.
        let mut doc = MockDoc::new("one two three", 0);
        doc.submit(0, &[ins(5, "X")], None).unwrap();
        doc.submit(0, &[del(4, "two "), ins(4, "2 ")], None).unwrap();
        assert_eq!(doc.text(), "one 2 Xthree");
    }

    #[test]
    fn the_hash_is_checked_only_when_nothing_landed_first() {
        let mut doc = MockDoc::new("abc", 0);
        assert_eq!(doc.submit(0, &[ins(3, "d")], Some("wrong")), Err(Refused::Hash));
        doc.submit(0, &[ins(0, "x")], None).unwrap();
        assert_eq!(doc.submit(0, &[ins(3, "d")], Some("wrong")), Ok(1));
        assert_eq!(doc.text(), "xabcd");
        assert_eq!(doc.submit(5, &[], None), Err(Refused::Version));
        assert_eq!(doc.submit(2, &[del(0, "zz")], None), Err(Refused::Mismatch));
    }
}
