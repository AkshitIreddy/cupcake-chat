use crate::{BrokerError, Result};
use base64::prelude::*;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{HashMap, HashSet, VecDeque};
use subtle::ConstantTimeEq;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
const MAX_REPLAY_TOMBSTONES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalChallenge {
    pub approval_id: Uuid,
    pub nonce: String,
    pub intent_digest: String,
    pub preflight_digest: String,
    pub expires_unix_ms: i64,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalProof {
    pub approval_id: Uuid,
    pub nonce: String,
    pub intent_digest: String,
    pub preflight_digest: String,
    pub token: String,
}

pub struct ApprovalManager {
    key: [u8; 32],
    active: HashMap<Uuid, ApprovalChallenge>,
    consumed: HashSet<Uuid>,
    consumed_order: VecDeque<Uuid>,
}

impl ApprovalManager {
    pub fn random() -> Self {
        let mut key = [0_u8; 32];
        OsRng.fill_bytes(&mut key);
        Self::with_key(key)
    }

    pub fn with_key(key: [u8; 32]) -> Self {
        Self {
            key,
            active: HashMap::new(),
            consumed: HashSet::new(),
            consumed_order: VecDeque::new(),
        }
    }

    pub fn issue(
        &mut self,
        intent_digest: impl Into<String>,
        preflight_digest: impl Into<String>,
        expires_unix_ms: i64,
    ) -> ApprovalChallenge {
        let approval_id = Uuid::now_v7();
        let mut nonce_bytes = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = BASE64_URL_SAFE_NO_PAD.encode(nonce_bytes);
        let intent_digest = intent_digest.into();
        let preflight_digest = preflight_digest.into();
        let token = self.sign(
            approval_id,
            &nonce,
            &intent_digest,
            &preflight_digest,
            expires_unix_ms,
        );
        let challenge = ApprovalChallenge {
            approval_id,
            nonce,
            intent_digest,
            preflight_digest,
            expires_unix_ms,
            token,
        };
        self.active.insert(approval_id, challenge.clone());
        challenge
    }

    /// Atomically consumes a proof. Every binding is checked in constant time
    /// where it contains secret material, and any successful proof is one-use.
    pub fn redeem(&mut self, proof: &ApprovalProof, now_unix_ms: i64) -> Result<()> {
        if self.consumed.contains(&proof.approval_id) {
            return Err(BrokerError::InvalidApproval);
        }
        let challenge = self
            .active
            .get(&proof.approval_id)
            .ok_or(BrokerError::InvalidApproval)?;
        let expected = self.sign(
            challenge.approval_id,
            &challenge.nonce,
            &challenge.intent_digest,
            &challenge.preflight_digest,
            challenge.expires_unix_ms,
        );
        let valid = challenge.expires_unix_ms >= now_unix_ms
            && challenge
                .nonce
                .as_bytes()
                .ct_eq(proof.nonce.as_bytes())
                .into()
            && challenge
                .intent_digest
                .as_bytes()
                .ct_eq(proof.intent_digest.as_bytes())
                .into()
            && challenge
                .preflight_digest
                .as_bytes()
                .ct_eq(proof.preflight_digest.as_bytes())
                .into()
            && expected.as_bytes().ct_eq(proof.token.as_bytes()).into();
        if !valid {
            return Err(BrokerError::InvalidApproval);
        }
        self.active.remove(&proof.approval_id);
        self.remember_consumed(proof.approval_id);
        Ok(())
    }

    pub fn revoke(&mut self, approval_id: Uuid) {
        self.active.remove(&approval_id);
        self.remember_consumed(approval_id);
    }

    fn remember_consumed(&mut self, id: Uuid) {
        self.consumed.insert(id);
        self.consumed_order.push_back(id);
        while self.consumed_order.len() > MAX_REPLAY_TOMBSTONES {
            if let Some(oldest) = self.consumed_order.pop_front() {
                self.consumed.remove(&oldest);
            }
        }
    }

    fn sign(&self, id: Uuid, nonce: &str, intent: &str, preflight: &str, expires: i64) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC supports 32-byte keys");
        for bytes in [
            id.as_bytes().as_slice(),
            nonce.as_bytes(),
            intent.as_bytes(),
            preflight.as_bytes(),
            &expires.to_be_bytes(),
        ] {
            mac.update(&(bytes.len() as u64).to_be_bytes());
            mac.update(bytes);
        }
        BASE64_URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }
}

impl From<&ApprovalChallenge> for ApprovalProof {
    fn from(value: &ApprovalChallenge) -> Self {
        Self {
            approval_id: value.approval_id,
            nonce: value.nonce.clone(),
            intent_digest: value.intent_digest.clone(),
            preflight_digest: value.preflight_digest.clone(),
            token: value.token.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_approval_to_both_digests_and_rejects_replay() {
        let mut manager = ApprovalManager::with_key([7; 32]);
        let challenge = manager.issue("intent-a", "preflight-a", 2_000);
        let proof = ApprovalProof::from(&challenge);
        manager.redeem(&proof, 1_000).unwrap();
        assert!(matches!(
            manager.redeem(&proof, 1_001),
            Err(BrokerError::InvalidApproval)
        ));
    }

    #[test]
    fn detects_tampering_without_consuming_valid_approval() {
        let mut manager = ApprovalManager::with_key([9; 32]);
        let challenge = manager.issue("intent", "preflight", 2_000);
        let mut tampered = ApprovalProof::from(&challenge);
        tampered.intent_digest = "different".into();
        assert!(manager.redeem(&tampered, 1_000).is_err());
        manager
            .redeem(&ApprovalProof::from(&challenge), 1_000)
            .unwrap();
    }

    #[test]
    fn rejects_expired_challenge() {
        let mut manager = ApprovalManager::with_key([4; 32]);
        let challenge = manager.issue("i", "p", 999);
        assert!(manager
            .redeem(&ApprovalProof::from(&challenge), 1_000)
            .is_err());
    }
}
