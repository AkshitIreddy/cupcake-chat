use crate::registry::{validate_identifier, validate_schema};
use crate::{BrokerError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuthPkceConfig {
    pub client_id: String,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub redirect_uri: Url,
    pub scopes: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "transport")]
pub enum McpTransportConfig {
    Stdio {
        executable: PathBuf,
        #[serde(default)]
        arguments: Vec<String>,
        /// Names copied from the broker's allowlisted environment. Values are
        /// never accepted from the model/runtime protocol.
        #[serde(default)]
        inherited_environment: BTreeSet<String>,
    },
    StreamableHttp {
        endpoint: Url,
        allowed_origins: BTreeSet<String>,
        oauth: Option<Box<OAuthPkceConfig>>,
    },
}

impl McpTransportConfig {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Stdio {
                executable,
                arguments,
                inherited_environment,
            } => {
                if !executable.is_absolute() || arguments.len() > 128 {
                    return Err(BrokerError::InvalidConfig(
                        "MCP stdio executable must be absolute and have at most 128 arguments"
                            .into(),
                    ));
                }
                if is_shell(executable) {
                    return Err(BrokerError::InvalidConfig(
                        "MCP stdio cannot launch a command shell".into(),
                    ));
                }
                if inherited_environment.iter().any(|name| {
                    name.is_empty()
                        || name.len() > 128
                        || !name
                            .bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                }) {
                    return Err(BrokerError::InvalidConfig(
                        "invalid inherited environment name".into(),
                    ));
                }
            }
            Self::StreamableHttp {
                endpoint,
                allowed_origins,
                oauth,
            } => {
                require_secure_url(endpoint)?;
                let origin = origin(endpoint)?;
                if !allowed_origins.contains(&origin) {
                    return Err(BrokerError::InvalidConfig(
                        "MCP endpoint origin is not explicitly allowlisted".into(),
                    ));
                }
                if let Some(oauth) = oauth {
                    validate_oauth(oauth, allowed_origins)?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    SchemaApprovalRequired,
    Faulted,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpToolSchema {
    pub id: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
}

impl McpToolSchema {
    fn validate(&self) -> Result<()> {
        validate_mcp_tool_name(&self.id)?;
        validate_schema("input_schema", &self.input_schema)?;
        validate_schema("output_schema", &self.output_schema)?;
        Ok(())
    }
}

fn validate_mcp_tool_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(BrokerError::InvalidConfig(format!(
            "invalid MCP tool name {name:?}"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct McpConnection {
    pub id: String,
    pub config: McpTransportConfig,
    state: ConnectionState,
    schema_hash: Option<String>,
    pending_schema_hash: Option<String>,
    tools: BTreeMap<String, McpToolSchema>,
    allowed_tools: BTreeMap<String, String>,
}

impl McpConnection {
    pub fn new(id: impl Into<String>, config: McpTransportConfig) -> Result<Self> {
        let id = id.into();
        validate_identifier(&id)?;
        config.validate()?;
        Ok(Self {
            id,
            config,
            state: ConnectionState::Disconnected,
            schema_hash: None,
            pending_schema_hash: None,
            tools: BTreeMap::new(),
            allowed_tools: BTreeMap::new(),
        })
    }

    pub fn state(&self) -> ConnectionState {
        self.state.clone()
    }

    pub fn schema_digest(&self) -> Option<&str> {
        self.schema_hash.as_deref()
    }

    pub fn pending_schema_digest(&self) -> Option<&str> {
        self.pending_schema_hash.as_deref()
    }

    pub fn tools(&self) -> Vec<McpToolSchema> {
        self.tools.values().cloned().collect()
    }

    /// Restores only the previously approved digest from broker persistence.
    /// Tool allowlists are deliberately restored separately after a matching
    /// live schema has been received.
    pub fn restore_approved_schema_digest(&mut self, digest: &str) -> Result<()> {
        if self.state != ConnectionState::Disconnected
            || digest.len() != 64
            || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(BrokerError::Integrity(
                "invalid persisted MCP schema digest".into(),
            ));
        }
        self.schema_hash = Some(digest.to_ascii_lowercase());
        Ok(())
    }

    pub fn begin_connect(&mut self) -> Result<()> {
        self.transition(ConnectionState::Connecting)
    }

    pub fn connection_failed(&mut self) -> Result<()> {
        self.transition(ConnectionState::Faulted)
    }

    pub fn disconnect(&mut self) -> Result<()> {
        self.transition(ConnectionState::Disconnected)
    }

    pub fn disable(&mut self) -> Result<()> {
        self.allowed_tools.clear();
        self.transition(ConnectionState::Disabled)
    }

    pub fn receive_schema(&mut self, tools: Vec<McpToolSchema>) -> Result<String> {
        if self.state != ConnectionState::Connecting && self.state != ConnectionState::Connected {
            return Err(BrokerError::InvalidTransition {
                from: format!("{:?}", self.state),
                to: "receive_schema".into(),
            });
        }
        let mut map = BTreeMap::new();
        for tool in tools {
            tool.validate()?;
            let id = tool.id.clone();
            if map.insert(id.clone(), tool).is_some() {
                return Err(BrokerError::Duplicate(id));
            }
        }
        let hash = schema_hash(&map)?;
        match &self.schema_hash {
            None => {
                self.schema_hash = Some(hash.clone());
                self.tools = map;
                self.state = ConnectionState::Connected;
            }
            Some(current) if current == &hash => {
                self.tools = map;
                self.state = ConnectionState::Connected;
            }
            Some(_) => {
                // A server may replace a harmless-looking schema with a more
                // capable one. No prior tool allowlist survives this change.
                self.allowed_tools.clear();
                self.pending_schema_hash = Some(hash.clone());
                self.tools = map;
                self.state = ConnectionState::SchemaApprovalRequired;
            }
        }
        Ok(hash)
    }

    pub fn approve_pending_schema(&mut self, expected_hash: &str) -> Result<()> {
        if self.state != ConnectionState::SchemaApprovalRequired
            || self.pending_schema_hash.as_deref() != Some(expected_hash)
        {
            return Err(BrokerError::Integrity(
                "MCP schema approval digest mismatch".into(),
            ));
        }
        self.schema_hash = self.pending_schema_hash.take();
        self.state = ConnectionState::Connected;
        Ok(())
    }

    pub fn allow_tool(&mut self, tool_id: &str) -> Result<()> {
        if self.state != ConnectionState::Connected || !self.tools.contains_key(tool_id) {
            return Err(BrokerError::PermissionDenied(
                "tool is unavailable or the connection is not approved".into(),
            ));
        }
        let hash = self
            .schema_hash
            .clone()
            .ok_or_else(|| BrokerError::Integrity("connected MCP has no schema hash".into()))?;
        self.allowed_tools.insert(tool_id.into(), hash);
        Ok(())
    }

    pub fn authorize_call(&self, tool_id: &str) -> Result<&McpToolSchema> {
        let current = self
            .schema_hash
            .as_deref()
            .ok_or_else(|| BrokerError::PermissionDenied("MCP schema is unapproved".into()))?;
        if self.state != ConnectionState::Connected
            || self.allowed_tools.get(tool_id).map(String::as_str) != Some(current)
        {
            return Err(BrokerError::PermissionDenied(
                "MCP tool is not allowlisted for the current schema".into(),
            ));
        }
        self.tools
            .get(tool_id)
            .ok_or_else(|| BrokerError::NotFound(tool_id.into()))
    }

    fn transition(&mut self, to: ConnectionState) -> Result<()> {
        let valid = matches!(
            (&self.state, &to),
            (ConnectionState::Disconnected, ConnectionState::Connecting)
                | (ConnectionState::Faulted, ConnectionState::Connecting)
                | (ConnectionState::Connecting, ConnectionState::Faulted)
                | (ConnectionState::Connecting, ConnectionState::Disconnected)
                | (ConnectionState::Connected, ConnectionState::Disconnected)
                | (
                    ConnectionState::SchemaApprovalRequired,
                    ConnectionState::Disconnected
                )
                | (_, ConnectionState::Disabled)
                | (ConnectionState::Disabled, ConnectionState::Disconnected)
        );
        if !valid {
            return Err(BrokerError::InvalidTransition {
                from: format!("{:?}", self.state),
                to: format!("{to:?}"),
            });
        }
        self.state = to;
        Ok(())
    }
}

fn schema_hash(tools: &BTreeMap<String, McpToolSchema>) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(tools)?)))
}

fn require_secure_url(url: &Url) -> Result<()> {
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(BrokerError::InvalidConfig(
            "remote MCP URLs require HTTPS (HTTP is loopback-only)".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(BrokerError::InvalidConfig(
            "MCP URLs cannot contain credentials or fragments".into(),
        ));
    }
    Ok(())
}

fn origin(url: &Url) -> Result<String> {
    let host = url
        .host_str()
        .ok_or_else(|| BrokerError::InvalidConfig("URL has no host".into()))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| BrokerError::InvalidConfig("URL has no known or explicit port".into()))?;
    Ok(format!("{}://{}:{}", url.scheme(), host, port))
}

fn validate_oauth(config: &OAuthPkceConfig, origins: &BTreeSet<String>) -> Result<()> {
    if config.client_id.trim().is_empty() || config.scopes.is_empty() {
        return Err(BrokerError::InvalidConfig(
            "OAuth client ID and scopes are required".into(),
        ));
    }
    require_secure_url(&config.authorization_endpoint)?;
    require_secure_url(&config.token_endpoint)?;
    // Redirects remain app-owned loopback endpoints; authorization/token hosts
    // must be explicitly accepted to prevent discovery-based SSRF.
    if !matches!(
        config.redirect_uri.host_str(),
        Some("127.0.0.1" | "::1" | "localhost")
    ) || config.redirect_uri.scheme() != "http"
        || !config.redirect_uri.username().is_empty()
        || config.redirect_uri.password().is_some()
        || config.redirect_uri.query().is_some()
        || config.redirect_uri.fragment().is_some()
    {
        return Err(BrokerError::InvalidConfig(
            "OAuth redirect must be a credential-free app-owned loopback HTTP URI".into(),
        ));
    }
    for endpoint in [&config.authorization_endpoint, &config.token_endpoint] {
        if !origins.contains(&origin(endpoint)?) {
            return Err(BrokerError::InvalidConfig(
                "OAuth endpoint origin is not explicitly allowlisted".into(),
            ));
        }
    }
    Ok(())
}

fn is_shell(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "sh" | "bash"
                    | "zsh"
                    | "fish"
                    | "cmd"
                    | "cmd.exe"
                    | "powershell"
                    | "powershell.exe"
                    | "pwsh"
                    | "pwsh.exe"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> McpTransportConfig {
        McpTransportConfig::StreamableHttp {
            endpoint: Url::parse("https://mcp.example.test/api").unwrap(),
            allowed_origins: ["https://mcp.example.test:443".into()]
                .into_iter()
                .collect(),
            oauth: None,
        }
    }

    fn tool(description: &str) -> McpToolSchema {
        McpToolSchema {
            id: "search.query".into(),
            description: description.into(),
            input_schema: serde_json::json!({"type":"object"}),
            output_schema: serde_json::json!({"type":"object"}),
        }
    }

    #[test]
    fn state_machine_rejects_illegal_transitions() {
        let mut connection = McpConnection::new("test", config()).unwrap();
        assert!(connection.disconnect().is_err());
        connection.begin_connect().unwrap();
        connection.receive_schema(vec![tool("one")]).unwrap();
        assert_eq!(connection.state(), ConnectionState::Connected);
        assert!(connection.begin_connect().is_err());
    }

    #[test]
    fn schema_change_invalidates_allowed_tools() {
        let mut connection = McpConnection::new("test", config()).unwrap();
        connection.begin_connect().unwrap();
        connection.receive_schema(vec![tool("one")]).unwrap();
        connection.allow_tool("search.query").unwrap();
        connection.disconnect().unwrap();
        connection.begin_connect().unwrap();
        let new_hash = connection.receive_schema(vec![tool("changed")]).unwrap();
        assert_eq!(connection.state(), ConnectionState::SchemaApprovalRequired);
        assert!(connection.authorize_call("search.query").is_err());
        connection.approve_pending_schema(&new_hash).unwrap();
        assert!(connection.authorize_call("search.query").is_err());
        connection.allow_tool("search.query").unwrap();
        connection.authorize_call("search.query").unwrap();
    }

    #[test]
    fn persisted_digest_forces_live_schema_reapproval_without_restoring_tools() {
        let mut original = McpConnection::new("test", config()).unwrap();
        original.begin_connect().unwrap();
        let digest = original.receive_schema(vec![tool("one")]).unwrap();

        let mut restored = McpConnection::new("test", config()).unwrap();
        restored.restore_approved_schema_digest(&digest).unwrap();
        restored.begin_connect().unwrap();
        restored.receive_schema(vec![tool("changed")]).unwrap();
        assert_eq!(restored.state(), ConnectionState::SchemaApprovalRequired);
        assert!(restored.authorize_call("search.query").is_err());
    }

    #[test]
    fn insecure_remote_and_shell_stdio_are_rejected() {
        let remote = McpTransportConfig::StreamableHttp {
            endpoint: Url::parse("http://example.test/mcp").unwrap(),
            allowed_origins: ["http://example.test:80".into()].into_iter().collect(),
            oauth: None,
        };
        assert!(remote.validate().is_err());
        let shell = McpTransportConfig::Stdio {
            executable: if cfg!(windows) {
                PathBuf::from(r"C:\Windows\System32\cmd.exe")
            } else {
                PathBuf::from("/bin/sh")
            },
            arguments: vec![],
            inherited_environment: BTreeSet::new(),
        };
        assert!(shell.validate().is_err());
    }
}
