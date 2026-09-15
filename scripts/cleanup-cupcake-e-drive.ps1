# Compatibility entry point. Cleanup is now scoped to this checkout, never E:\temp.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'clean-workspace.mjs') --apply
if ($LASTEXITCODE -ne 0) { throw 'Workspace cleanup failed; see the command output.' }
