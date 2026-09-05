//! CUPCAKEAGI's privileged tool boundary.
//!
//! The renderer and model runtime are untrusted callers. This crate owns the
//! protocol, authorization, credentials, filesystem grants, MCP connections,
//! audit trail, and process launch policy used to turn a model suggestion into
//! a bounded operating-system action.

pub mod approval;
pub mod audit;
pub mod backup_container;
pub mod backup_envelope;
pub mod backup_restore;
pub mod custom_tool;
pub mod error;
pub mod framing;
pub mod generated;
pub mod grants;
pub mod installed_tools;
pub mod integration;
pub mod mcp;
pub mod mcp_transport;
pub mod native;
pub mod policy;
#[cfg(windows)]
pub(crate) mod process_containment;
pub mod protocol;
pub mod registry;
pub mod runtime;
pub mod sandbox;
pub mod sdk;
pub mod security_db;
pub mod vault;

pub use error::{BrokerError, Result};

/// The only wire-protocol version accepted by this release.
pub const PROTOCOL_VERSION: u16 = 1;
