use crate::{BrokerError, Result};
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditEvent {
    pub category: String,
    pub action: String,
    pub outcome: String,
    #[serde(default)]
    pub fields: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredAuditRecord {
    sequence: u64,
    timestamp: String,
    category: String,
    action: String,
    outcome: String,
    fields: Value,
    previous_hash: String,
    hash: String,
}

#[derive(Debug)]
struct AuditState {
    next_sequence: u64,
    previous_hash: String,
}

pub struct AuditStore {
    path: PathBuf,
    state: Mutex<AuditState>,
}

impl AuditStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let (count, last_hash) = verify_file(&path)?;
        secure_create_if_missing(&path)?;
        Ok(Self {
            path,
            state: Mutex::new(AuditState {
                next_sequence: count + 1,
                previous_hash: last_hash,
            }),
        })
    }

    pub fn append(&self, event: AuditEvent) -> Result<String> {
        let mut state = self.state.lock().expect("audit mutex poisoned");
        let redacted = redact(event.fields);
        let timestamp = Utc::now().to_rfc3339();
        let unsigned = serde_json::json!({
            "sequence": state.next_sequence,
            "timestamp": timestamp,
            "category": event.category,
            "action": event.action,
            "outcome": event.outcome,
            "fields": redacted,
            "previous_hash": state.previous_hash,
        });
        let hash = digest_json(&unsigned)?;
        let record = StoredAuditRecord {
            sequence: state.next_sequence,
            timestamp: unsigned["timestamp"].as_str().unwrap().to_owned(),
            category: unsigned["category"].as_str().unwrap().to_owned(),
            action: unsigned["action"].as_str().unwrap().to_owned(),
            outcome: unsigned["outcome"].as_str().unwrap().to_owned(),
            fields: unsigned["fields"].clone(),
            previous_hash: state.previous_hash.clone(),
            hash: hash.clone(),
        };
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        serde_json::to_writer(&mut file, &record)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        state.next_sequence += 1;
        state.previous_hash = hash.clone();
        Ok(hash)
    }

    pub fn verify(&self) -> Result<usize> {
        Ok(verify_file(&self.path)?.0 as usize)
    }
}

fn verify_file(path: &Path) -> Result<(u64, String)> {
    if !path.exists() {
        return Ok((0, GENESIS_HASH.into()));
    }
    let mut expected_sequence = 1_u64;
    let mut previous_hash = GENESIS_HASH.to_owned();
    for line in BufReader::new(File::open(path)?).lines() {
        let line = line?;
        if line.trim().is_empty() {
            return Err(BrokerError::Integrity("blank audit record".into()));
        }
        let record: StoredAuditRecord = serde_json::from_str(&line)?;
        if record.sequence != expected_sequence || record.previous_hash != previous_hash {
            return Err(BrokerError::Integrity("audit chain discontinuity".into()));
        }
        let unsigned = serde_json::json!({
            "sequence": record.sequence,
            "timestamp": record.timestamp,
            "category": record.category,
            "action": record.action,
            "outcome": record.outcome,
            "fields": record.fields,
            "previous_hash": record.previous_hash,
        });
        let expected_hash = digest_json(&unsigned)?;
        if expected_hash != record.hash {
            return Err(BrokerError::Integrity("audit record was modified".into()));
        }
        previous_hash = record.hash;
        expected_sequence += 1;
    }
    Ok((expected_sequence - 1, previous_hash))
}

fn digest_json(value: &Value) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

pub fn redact(value: Value) -> Value {
    let sensitive_key = Regex::new(
        r"(?i)(api[-_]?key|secret|token|password|authorization|cookie|credential|private[-_]?key)",
    )
    .expect("static redaction regex");
    let bearer = Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/-]+=*").expect("static regex");
    let provider_key =
        Regex::new(r"\b(?:(?:sk|xai|gsk|cohere)[-_][A-Za-z0-9_-]{12,}|nvapi-[A-Za-z0-9_-]+)\b")
            .expect("static regex");
    fn visit(value: Value, sensitive_key: &Regex, bearer: &Regex, provider_key: &Regex) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .into_iter()
                    .map(|(key, value)| {
                        if sensitive_key.is_match(&key) {
                            (key, Value::String("[REDACTED]".into()))
                        } else {
                            (key, visit(value, sensitive_key, bearer, provider_key))
                        }
                    })
                    .collect::<Map<_, _>>(),
            ),
            Value::Array(values) => Value::Array(
                values
                    .into_iter()
                    .map(|value| visit(value, sensitive_key, bearer, provider_key))
                    .collect(),
            ),
            Value::String(text) => Value::String(
                provider_key
                    .replace_all(
                        &bearer.replace_all(&text, "Bearer [REDACTED]"),
                        "[REDACTED]",
                    )
                    .into_owned(),
            ),
            other => other,
        }
    }
    visit(value, &sensitive_key, &bearer, &provider_key)
}

fn secure_create_if_missing(path: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn redacts_nested_secrets_and_verifies_chain() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let store = AuditStore::open(&path).unwrap();
        store
            .append(AuditEvent {
                category: "vault".into(),
                action: "store".into(),
                outcome: "ok".into(),
                fields: serde_json::json!({
                    "api_key": "sk-test-abcdefghijklmnopqrstuvwxyz",
                    "nested": { "authorization": "Bearer hello.secret.value" },
                    "message": "used Bearer abc.def.ghi"
                }),
            })
            .unwrap();
        assert_eq!(store.verify().unwrap(), 1);
        let text = std::fs::read_to_string(path).unwrap();
        assert!(!text.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(!text.contains("abc.def.ghi"));
        assert!(text.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_nvidia_nim_keys_in_free_text() {
        let value = redact(serde_json::json!({
            "message": "provider rejected nvapi-example_synthetic_key_12345"
        }));
        assert_eq!(value["message"], "provider rejected [REDACTED]");
    }

    #[test]
    fn detects_tampering() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let store = AuditStore::open(&path).unwrap();
        store
            .append(AuditEvent {
                category: "tool".into(),
                action: "run".into(),
                outcome: "ok".into(),
                fields: Value::Null,
            })
            .unwrap();
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\"ok\"", "\"no\"");
        std::fs::write(&path, text).unwrap();
        assert!(store.verify().is_err());
    }
}
