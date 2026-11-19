//! What makes a registry file trustworthy: a minisign signature by a key
//! compiled into Lattice, whose trusted comment names the file and its serial,
//! and the block list's version ranges.

use minisign_verify::{PublicKey, Signature};

/// The registry's signing keys (`keys/*.pub` in lattice-writer/lattice-plugins). Either
/// may sign, so the registry can move to the backup key without a release; a
/// new backup is added in a release before the old primary is retired.
pub(crate) const PUBLIC_KEYS: [&str; 2] = [
    // primary, key id 03272612D22DB2A5
    "RWSlsi3SEiYnAxL71VpIBo6tVRmDm4vvOUvBfuD5712xWs57ohrDa8qn",
    // backup, key id D520097EDBD2D0F4
    "RWT00NLbfgkg1W6QTpYhd8m/bKFGx+6cZhCzDETkQiBXCaOYcde8/XzN",
];

/// Checks that `body` is `file` as one of `keys` signed it. The trusted
/// comment is covered by the signature, so it pins the signature to this file
/// name and to `serial`, the serial the file itself states: a signature can be
/// neither moved to the other file nor replayed with another body.
pub(crate) fn verify(
    keys: &[PublicKey], file: &str, body: &[u8], signature: &str, serial: u64,
) -> Result<(), String> {
    let invalid = || format!("The registry's {file} has no valid signature.");
    let signature = Signature::decode(signature).map_err(|_| invalid())?;
    // Legacy (unhashed) signatures are refused: the registry's minisign signs
    // pre-hashed, and accepting both would only widen what verifies.
    if !keys.iter().any(|key| key.verify(body, &signature, false).is_ok()) {
        return Err(invalid());
    }
    if signature.trusted_comment() != format!("lattice-plugins file:{file} serial:{serial}") {
        return Err(format!("The registry's {file} is signed for another file or serial."));
    }
    Ok(())
}

/// Whether `version` falls in a block list range: `*`, or npm-style
/// comparators (`<=0.3.1`, `>=1.0.0 <1.2.0`, alternatives joined by `||`).
/// A range or version that does not parse counts as a match, so a block never
/// fails open.
pub(crate) fn version_in(range: &str, version: &str) -> bool {
    let range = range.trim();
    if range == "*" {
        return true;
    }
    let Ok(version) = semver::Version::parse(version) else {
        return true;
    };
    range.split("||").any(|alternative| {
        // npm joins comparators with spaces and may space an operator from
        // its version; Cargo's syntax joins them with commas, and reads a bare
        // version as `^`, where npm means exactly that version.
        let mut comparators: Vec<String> = Vec::new();
        let mut operator = String::new();
        for token in alternative.split_whitespace() {
            if token.chars().all(|c| "<>=^~".contains(c)) {
                operator.push_str(token);
                continue;
            }
            let token = format!("{operator}{token}");
            operator.clear();
            let bare = token.starts_with(|c: char| c.is_ascii_digit());
            comparators.push(if bare { format!("={token}") } else { token });
        }
        match semver::VersionReq::parse(&comparators.join(", ")) {
            Ok(req) => req.matches(&version),
            Err(_) => true,
        }
    })
}

/// Whether `candidate` is a newer version than `installed`.
pub(crate) fn newer(candidate: &str, installed: &str) -> bool {
    match (semver::Version::parse(candidate), semver::Version::parse(installed)) {
        (Ok(candidate), Ok(installed)) => candidate > installed,
        _ => false,
    }
}
