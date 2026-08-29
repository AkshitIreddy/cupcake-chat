use crate::protocol::canonical_json;
use crate::{BrokerError, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::io::{Read, Write};

pub const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

pub fn write_frame<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
    maximum: usize,
) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > maximum || body.len() > u32::MAX as usize {
        return Err(BrokerError::FrameTooLarge {
            actual: body.len(),
            maximum,
        });
    }
    writer.write_all(&(body.len() as u32).to_be_bytes())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

/// Write a security-sensitive protocol frame in its unique canonical JSON
/// representation. This makes the bytes on the pipe deterministic across the
/// TypeScript, Python, and Rust implementations before envelope auth is checked.
pub fn write_protocol_frame<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
    maximum: usize,
) -> Result<()> {
    let body = canonical_json(&serde_json::to_value(value)?)?.into_bytes();
    write_body(writer, &body, maximum)
}

/// Reads exactly one 4-byte big-endian length-prefixed JSON document.
/// Allocation occurs only after the advertised length has passed the bound.
pub fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R, maximum: usize) -> Result<T> {
    let body = read_body(reader, maximum)?;
    Ok(serde_json::from_slice(&body)?)
}

/// Read a security-sensitive protocol frame and reject alternate JSON
/// spellings before authentication. A receiver therefore never authenticates
/// a parsed-and-reserialized value that differs from the bytes the peer sent.
pub fn read_protocol_frame<R: Read, T: DeserializeOwned>(
    reader: &mut R,
    maximum: usize,
) -> Result<T> {
    let body = read_body(reader, maximum)?;
    // Canonicality is a property of the raw JSON value, not its eventual Rust
    // representation. Checking after typed deserialization can produce false
    // mismatches when a Serde type normalizes an otherwise valid wire value.
    let raw: serde_json::Value = serde_json::from_slice(&body)?;
    let canonical = canonical_json(&raw)?;
    if canonical.as_bytes() != body {
        let difference = canonical
            .as_bytes()
            .iter()
            .zip(&body)
            .position(|(left, right)| left != right)
            .unwrap_or(canonical.len().min(body.len()));
        return Err(BrokerError::InvalidEnvelope(format!(
            "protocol frame body must use canonical JSON encoding \
                 (first difference at byte {difference}, received {} bytes, canonical {} bytes)",
            body.len(),
            canonical.len()
        )));
    }
    Ok(serde_json::from_value(raw)?)
}

fn write_body<W: Write>(writer: &mut W, body: &[u8], maximum: usize) -> Result<()> {
    if body.is_empty() {
        return Err(BrokerError::InvalidEnvelope("empty frame".into()));
    }
    if body.len() > maximum || body.len() > u32::MAX as usize {
        return Err(BrokerError::FrameTooLarge {
            actual: body.len(),
            maximum,
        });
    }
    writer.write_all(&(body.len() as u32).to_be_bytes())?;
    writer.write_all(body)?;
    writer.flush()?;
    Ok(())
}

fn read_body<R: Read>(reader: &mut R, maximum: usize) -> Result<Vec<u8>> {
    let mut prefix = [0_u8; 4];
    match reader.read_exact(&mut prefix) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(BrokerError::TruncatedFrame)
        }
        Err(error) => return Err(error.into()),
    }
    let size = u32::from_be_bytes(prefix) as usize;
    if size == 0 {
        return Err(BrokerError::InvalidEnvelope("empty frame".into()));
    }
    if size > maximum {
        return Err(BrokerError::FrameTooLarge {
            actual: size,
            maximum,
        });
    }
    let mut body = vec![0_u8; size];
    reader
        .read_exact(&mut body)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::UnexpectedEof => BrokerError::TruncatedFrame,
            _ => error.into(),
        })?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;
    use serde_json::Value;
    use std::io::Cursor;
    use uuid::Uuid;

    #[derive(Deserialize)]
    struct NormalizedUuid {
        id: Uuid,
    }

    #[test]
    fn framing_round_trip() {
        let source = json!({"cupcake": true});
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &source, 128).unwrap();
        assert_eq!(&bytes[..4], &(bytes.len() as u32 - 4).to_be_bytes());
        assert_eq!(
            read_frame::<_, serde_json::Value>(&mut Cursor::new(bytes), 128).unwrap(),
            source
        );
    }

    #[test]
    fn refuses_oversized_frame_before_allocation() {
        let bytes = (1_000_u32).to_be_bytes().to_vec();
        assert!(matches!(
            read_frame::<_, serde_json::Value>(&mut Cursor::new(bytes), 10),
            Err(BrokerError::FrameTooLarge { .. })
        ));
    }

    #[test]
    fn truncated_body_has_specific_error() {
        let mut bytes = 10_u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        assert!(matches!(
            read_frame::<_, serde_json::Value>(&mut Cursor::new(bytes), 128),
            Err(BrokerError::TruncatedFrame)
        ));
    }

    #[test]
    fn protocol_frames_are_canonical_and_noncanonical_bodies_are_rejected() {
        let value = json!({"z": 1, "a": {"probe": 1e-6}});
        let mut bytes = Vec::new();
        write_protocol_frame(&mut bytes, &value, 256).unwrap();
        assert_eq!(
            std::str::from_utf8(&bytes[4..]).unwrap(),
            r#"{"a":{"probe":0.000001},"z":1}"#
        );

        let body = br#"{"z":1,"a":{"probe":1e-6}}"#;
        let mut noncanonical = (body.len() as u32).to_be_bytes().to_vec();
        noncanonical.extend_from_slice(body);
        assert!(matches!(
            read_protocol_frame::<_, Value>(&mut Cursor::new(noncanonical), 256),
            Err(BrokerError::InvalidEnvelope(message)) if message.contains("canonical")
        ));
    }

    #[test]
    fn canonicality_is_checked_before_typed_normalization() {
        let body = br#"{"id":"018F1E2D-3C4B-7A69-8DEF-0123456789AB"}"#;
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(body);

        let decoded: NormalizedUuid = read_protocol_frame(&mut Cursor::new(frame), 256).unwrap();
        assert_eq!(
            decoded.id.to_string(),
            "018f1e2d-3c4b-7a69-8def-0123456789ab"
        );
    }
}
