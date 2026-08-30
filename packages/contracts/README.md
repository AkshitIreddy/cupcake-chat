# `@cupcakeagi/contracts`

This package is the product-owned boundary between the React renderer, Tauri Rust host, Python
runtime, and Rust ToolBroker.

TypeBox declarations under `src/` are canonical. `schema/v1/` contains checked-in JSON Schema and a
digest manifest. Generation also refreshes Pydantic models in the runtime and Serde models in the
broker.

```powershell
pnpm --filter @cupcakeagi/contracts typecheck
pnpm --filter @cupcakeagi/contracts test
pnpm --filter @cupcakeagi/contracts generate:schemas
pnpm --filter @cupcakeagi/contracts check:schemas
```

Boundaries reject unknown properties/versions, invalid UUIDv7/timestamps, frames over 8 MiB, expired
deadlines, invalid authentication, replay, and sequence gaps. Renderer-facing contracts use opaque
handles and never expose credentials, unrestricted paths/process/network primitives, private
reasoning, provider SDK objects, or framework checkpoints.

Provider onboarding, model discovery, Cupcake Local management, window lifecycle, and sidecar status
use narrow typed Tauri commands/events. Hosted routes and `cupcake_local` remain explicit; removed
local-server kinds are rejected rather than migrated into active settings.

Use additive changes within protocol/schema version 1. Incompatible changes require a new version
and migration plan.
