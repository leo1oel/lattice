//! The parts of FlashTeX's `display-list-v3` host protocol the spike speaks
//! (docs/protocol/display-list-v3.md in the FlashTeX repository, §2 and §6).
//!
//! Every message is one frame: a little-endian `u32` length (the kind byte
//! and the body), a kind byte, then the body. The client sends `HELLO` and
//! `COMPILE`; of the host's replies only `HELLO`, `DIAGNOSTIC`, `DONE` and
//! `ERROR` matter here. The page, font and source frames describe the pages
//! for a native renderer, and the spike reads the PDF the host writes instead.

use serde_json::Value;
use std::io::{Read, Write};

pub(super) const CLIENT_HELLO: u8 = 0x01;
pub(super) const COMPILE: u8 = 0x02;
pub(super) const HOST_HELLO: u8 = 0x41;
pub(super) const DIAGNOSTIC: u8 = 0x48;
pub(super) const DONE: u8 = 0x49;
pub(super) const ERROR: u8 = 0x4A;

/// The protocol version the client asks for. A host whose major differs
/// answers `ERROR {"code": "version"}`.
pub(super) const VERSION: [u64; 2] = [3, 2];

/// The longest frame the protocol allows (§2): a longer one, or one of
/// length 0, is a corrupt stream.
const MAX_FRAME: usize = 1 << 28;

/// Send one JSON message of `kind`.
pub(super) fn write_frame(stream: &mut impl Write, kind: u8, body: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(body)?;
    let length = u32::try_from(body.len() + 1)
        .map_err(|_| std::io::Error::other("The FlashTeX request is too large."))?;
    let mut frame = Vec::with_capacity(body.len() + 5);
    frame.extend_from_slice(&length.to_le_bytes());
    frame.push(kind);
    frame.extend_from_slice(&body);
    stream.write_all(&frame)?;
    stream.flush()
}

/// The next frame whose kind is one of `wanted`, decoded as JSON. Frames of
/// other kinds are read past without being kept: a 70-page compile sends
/// megabytes of pages.
pub(super) fn read_frame(stream: &mut impl Read, wanted: &[u8]) -> std::io::Result<(u8, Value)> {
    loop {
        let mut header = [0u8; 5];
        stream.read_exact(&mut header)?;
        let length = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        if length == 0 || length > MAX_FRAME {
            return Err(std::io::Error::other("FlashTeX sent a corrupt frame."));
        }
        let kind = header[4];
        let body_length = (length - 1) as u64;
        if !wanted.contains(&kind) {
            let skipped =
                std::io::copy(&mut stream.by_ref().take(body_length), &mut std::io::sink())?;
            if skipped != body_length {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
            continue;
        }
        let mut body = vec![0u8; length - 1];
        stream.read_exact(&mut body)?;
        let value = serde_json::from_slice(&body).map_err(|error| {
            std::io::Error::other(format!("FlashTeX sent a frame that is not JSON: {error}"))
        })?;
        return Ok((kind, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(kind: u8, body: &[u8]) -> Vec<u8> {
        let mut bytes = ((body.len() + 1) as u32).to_le_bytes().to_vec();
        bytes.push(kind);
        bytes.extend_from_slice(body);
        bytes
    }

    #[test]
    fn writes_a_length_prefixed_json_frame() {
        let mut out = Vec::new();
        write_frame(&mut out, COMPILE, &json!({"id": 1})).unwrap();
        assert_eq!(out, frame(COMPILE, br#"{"id":1}"#));
    }

    #[test]
    fn skips_frames_it_was_not_asked_for() {
        let mut stream = frame(0x45, &[0xff; 300]);
        stream.extend(frame(0x42, br#"{"id":1}"#));
        stream.extend(frame(DONE, br#"{"id":1,"status":"ok"}"#));
        let (kind, value) = read_frame(&mut stream.as_slice(), &[DONE, ERROR]).unwrap();
        assert_eq!(kind, DONE);
        assert_eq!(value["status"], "ok");
    }

    #[test]
    fn refuses_empty_and_truncated_frames() {
        let empty = 0u32.to_le_bytes();
        assert!(read_frame(&mut empty.as_slice(), &[DONE]).is_err());
        let mut truncated = frame(0x45, &[0; 100]);
        truncated.truncate(50);
        assert!(read_frame(&mut truncated.as_slice(), &[DONE]).is_err());
        let not_json = frame(DONE, b"not json");
        assert!(read_frame(&mut not_json.as_slice(), &[DONE]).is_err());
    }
}
