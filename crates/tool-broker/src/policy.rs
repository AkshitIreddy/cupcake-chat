use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    ReadFiles,
    WriteFiles,
    Delete,
    NetworkRead,
    ExternalCommunication,
    SpendMoney,
    InstallSoftware,
    SystemChange,
    ExecuteSandboxed,
    ExecuteUnsandboxed,
    ManageModels,
    ManageArtifacts,
}

impl Effect {
    pub fn requires_fresh_approval(self) -> bool {
        matches!(
            self,
            Self::Delete
                | Self::ExternalCommunication
                | Self::SpendMoney
                | Self::InstallSoftware
                | Self::SystemChange
                | Self::ExecuteUnsandboxed
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeKey {
    pub tool_id: String,
    pub effect: Effect,
    /// Opaque broker-owned resource identifier, never a raw path or credential.
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoryDecision {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicySet {
    pub denied: BTreeSet<ScopeKey>,
    pub exact_grants: BTreeSet<ScopeKey>,
    pub session_grants: BTreeSet<ScopeKey>,
    pub project_grants: BTreeSet<ScopeKey>,
    pub category: BTreeMap<Effect, CategoryDecision>,
    /// Explicit owner-selected escape hatch. Explicit denies still win, but
    /// every other effect is allowed without an approval challenge.
    #[serde(default)]
    pub full_freedom: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionSource {
    ExplicitDeny,
    MandatoryFreshApproval,
    FullFreedom,
    ExactGrant,
    SessionGrant,
    ProjectGrant,
    CategoryPolicy,
    DefaultAsk,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow(DecisionSource),
    Deny(DecisionSource),
    Ask(DecisionSource),
}

impl PolicySet {
    /// Deterministic precedence: deny, mandatory fresh approval, exact grant,
    /// session grant, project grant, category policy, then ask.
    pub fn evaluate(&self, key: &ScopeKey) -> PolicyDecision {
        if self.denied.contains(key) {
            return PolicyDecision::Deny(DecisionSource::ExplicitDeny);
        }
        if self.full_freedom {
            return PolicyDecision::Allow(DecisionSource::FullFreedom);
        }
        if key.effect.requires_fresh_approval() {
            return PolicyDecision::Ask(DecisionSource::MandatoryFreshApproval);
        }
        if self.exact_grants.contains(key) {
            return PolicyDecision::Allow(DecisionSource::ExactGrant);
        }
        if self.session_grants.contains(key) {
            return PolicyDecision::Allow(DecisionSource::SessionGrant);
        }
        if self.project_grants.contains(key) {
            return PolicyDecision::Allow(DecisionSource::ProjectGrant);
        }
        match self.category.get(&key.effect) {
            Some(CategoryDecision::Allow) => PolicyDecision::Allow(DecisionSource::CategoryPolicy),
            Some(CategoryDecision::Deny) => PolicyDecision::Deny(DecisionSource::CategoryPolicy),
            Some(CategoryDecision::Ask) => PolicyDecision::Ask(DecisionSource::CategoryPolicy),
            None => PolicyDecision::Ask(DecisionSource::DefaultAsk),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(effect: Effect) -> ScopeKey {
        ScopeKey {
            tool_id: "native.files".into(),
            effect,
            resource_id: Some("grant_opaque".into()),
        }
    }

    #[test]
    fn deny_wins_over_every_allow() {
        let k = key(Effect::ReadFiles);
        let mut policy = PolicySet::default();
        policy.denied.insert(k.clone());
        policy.exact_grants.insert(k.clone());
        policy
            .category
            .insert(Effect::ReadFiles, CategoryDecision::Allow);
        assert_eq!(
            policy.evaluate(&k),
            PolicyDecision::Deny(DecisionSource::ExplicitDeny)
        );
    }

    #[test]
    fn high_consequence_effect_always_asks_fresh() {
        let k = key(Effect::Delete);
        let mut policy = PolicySet::default();
        policy.exact_grants.insert(k.clone());
        policy
            .category
            .insert(Effect::Delete, CategoryDecision::Allow);
        assert_eq!(
            policy.evaluate(&k),
            PolicyDecision::Ask(DecisionSource::MandatoryFreshApproval)
        );
    }

    #[test]
    fn full_freedom_skips_fresh_approval_but_not_explicit_denies() {
        let allowed = key(Effect::Delete);
        let denied = key(Effect::SystemChange);
        let mut policy = PolicySet {
            full_freedom: true,
            ..PolicySet::default()
        };
        policy.denied.insert(denied.clone());
        assert_eq!(
            policy.evaluate(&allowed),
            PolicyDecision::Allow(DecisionSource::FullFreedom)
        );
        assert_eq!(
            policy.evaluate(&denied),
            PolicyDecision::Deny(DecisionSource::ExplicitDeny)
        );
    }

    #[test]
    fn grants_precede_category_policy() {
        let k = key(Effect::ReadFiles);
        let mut policy = PolicySet::default();
        policy.session_grants.insert(k.clone());
        policy
            .category
            .insert(Effect::ReadFiles, CategoryDecision::Deny);
        assert_eq!(
            policy.evaluate(&k),
            PolicyDecision::Allow(DecisionSource::SessionGrant)
        );
    }
}
