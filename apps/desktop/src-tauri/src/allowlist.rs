use crate::error::{HostError, HostResult};

const MAX_METHOD_LENGTH: usize = 96;

/// Generic runtime bridge methods. Credential mutation is deliberately absent:
/// provider test/connect/disconnect use dedicated commands whose secret-bearing
/// parameters cannot be confused with ordinary runtime requests.
pub fn ensure_runtime_method_allowed(method: &str) -> HostResult<()> {
    if method.is_empty() || method.len() > MAX_METHOD_LENGTH || !is_method_shape(method) {
        return Err(HostError::invalid("Runtime method is invalid"));
    }
    if is_sensitive_provider_method(method) {
        return Err(HostError::new(
            "SENSITIVE_METHOD_REQUIRES_DEDICATED_COMMAND",
            "Provider credential operations require a dedicated desktop command",
            false,
        ));
    }
    if ALLOWED_RUNTIME_METHODS.binary_search(&method).is_err() {
        return Err(HostError::new(
            "METHOD_NOT_ALLOWED",
            "Runtime method is not exposed to the renderer",
            false,
        ));
    }
    Ok(())
}

pub fn ensure_provider_id(provider: &str) -> HostResult<()> {
    const PROVIDERS: &[&str] = &[
        "anthropic",
        "cohere",
        "google",
        "mistral",
        "nvidia-nim",
        "openai",
        "openai-compatible",
        "xai",
    ];
    if PROVIDERS.binary_search(&provider).is_err() {
        return Err(HostError::invalid("Unknown provider"));
    }
    Ok(())
}

fn is_sensitive_provider_method(method: &str) -> bool {
    matches!(
        method,
        "providers.connect"
            | "providers.disconnect"
            | "providers.test"
            | "providers.configure"
            | "providers.compatible.configure"
    )
}

fn is_method_shape(method: &str) -> bool {
    method.split('.').all(|segment| {
        !segment.is_empty()
            && segment.len() <= 32
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

// Sorted for binary_search and intentionally excludes LM Studio, Ollama, and
// all provider credential mutation methods.
const ALLOWED_RUNTIME_METHODS: &[&str] = &[
    "agents.delegate",
    "agents.roles",
    "app.bootstrap",
    "artifacts.content.read",
    "artifacts.create",
    "artifacts.export.intent",
    "artifacts.get",
    "artifacts.history",
    "artifacts.list",
    "artifacts.revise",
    "backup.create.intent",
    "backup.restore.intent",
    "broker.permission_mode.get",
    "broker.permission_mode.set",
    "chat.continue",
    "chat.disclosure.preflight",
    "chat.edit",
    "chat.history",
    "chat.preflight",
    "chat.regenerate",
    "chat.send",
    "conversations.archive",
    "conversations.branch",
    "conversations.branches",
    "conversations.create",
    "conversations.get",
    "conversations.list",
    "conversations.rename",
    "developer.events",
    "developer.purge",
    "developer.run_tree",
    "developer.traces",
    "ingestion.ingest",
    "ingestion.ingest.private",
    "local_models.cupcake.benchmark",
    "local_models.cupcake.devices",
    "local_models.cupcake.download",
    "local_models.cupcake.download.cancel",
    "local_models.cupcake.download.pause",
    "local_models.cupcake.download.reset",
    "local_models.cupcake.download.resume",
    "local_models.cupcake.download.status",
    "local_models.cupcake.load",
    "local_models.cupcake.remove_model",
    "local_models.cupcake.runtime.activate",
    "local_models.cupcake.runtime_version",
    "local_models.cupcake.status",
    "local_models.cupcake.unload",
    "local_models.hardware",
    "mcp.connect",
    "mcp.disconnect",
    "mcp.tool.call",
    "mcp.tools.list",
    "memory.activate",
    "memory.confirmation.preflight",
    "memory.forget",
    "memory.get",
    "memory.history",
    "memory.list",
    "memory.propose",
    "memory.remember",
    "memory.suggestions.dismiss",
    "memory.suggestions.enable",
    "memory.suggestions.list",
    "memory.usage.record",
    "migration.decline",
    "migration.detect",
    "migration.execute",
    "migration.preview",
    "migration.recovered_tasks",
    "models.fallback.preflight",
    "models.list",
    "models.select",
    "proactive.enabled",
    "projects.archive",
    "projects.create",
    "projects.files.list",
    "projects.get",
    "projects.list",
    "projects.update",
    "providers.catalog.refresh",
    "providers.status",
    "runtime.health",
    "runtime.self_test",
    "search.project",
    "search.query",
    "settings.get",
    "settings.list",
    "settings.set",
    "system.bootstrap",
    "tasks.approval.resolve",
    "tasks.cancel",
    "tasks.create",
    "tasks.events",
    "tasks.execute",
    "tasks.followup",
    "tasks.get",
    "tasks.list",
    "tasks.resume",
    "tasks.steer",
    "tools.cancel",
    "tools.list",
    "tools.preflight",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_is_sorted_and_unique() {
        assert!(ALLOWED_RUNTIME_METHODS
            .windows(2)
            .all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn credential_methods_cannot_use_generic_bridge() {
        for method in [
            "providers.test",
            "providers.connect",
            "providers.disconnect",
            "providers.configure",
            "providers.compatible.configure",
        ] {
            assert_eq!(
                ensure_runtime_method_allowed(method).unwrap_err().code,
                "SENSITIVE_METHOD_REQUIRES_DEDICATED_COMMAND"
            );
        }
    }

    #[test]
    fn unknown_provider_routes_are_not_exposed() {
        assert_eq!(
            ensure_runtime_method_allowed("providers.legacy_connect")
                .unwrap_err()
                .code,
            "METHOD_NOT_ALLOWED"
        );
    }

    #[test]
    fn removed_local_managers_are_not_exposed() {
        assert!(ensure_runtime_method_allowed("local_models.lm_studio.list").is_err());
        assert!(ensure_runtime_method_allowed("local_models.ollama.load").is_err());
        assert!(ensure_runtime_method_allowed("local_models.cupcake.catalogs.configure").is_err());
    }
}
