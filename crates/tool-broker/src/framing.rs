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

/// Reads exactly one 4-byte big-endian length-prefixed JSON document.
/// Allocation occurs only after the advertised length has passed the bound.
pub fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R, maximum: usize) -> Result<T> {
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
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

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
}
