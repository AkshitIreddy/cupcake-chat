[CmdletBinding()]
param([switch]$ValidateOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tempRoot = [IO.Path]::GetFullPath('E:\temp\')
$archiveParent = [IO.Path]::GetFullPath('E:\uesless\')
$archiveBatchName = 'CupcakeAI-cleanup-{0}-{1}-{2}' -f (Get-Date).ToString('yyyyMMdd-HHmmss-fff'), $PID, ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$archiveRoot = [IO.Path]::GetFullPath((Join-Path $archiveParent $archiveBatchName))
$manifestPath = [IO.Path]::GetFullPath((Join-Path $archiveRoot 'manifest.jsonl'))
$logPath = 'E:\temp\cupcake-archive-20260905.log'
$ledgerPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'docs\worklogs\2026-09-05-e-drive-cleanup.md'))
$batchPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'Cleanup CupcakeAI E Drive.bat'))
$archiveBatchPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'Archive Obsolete CupcakeAI E Drive.bat'))
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
$archiveInitialized = $false

$protectedPaths = @(
    'E:\temp\cupcakeai-owner-test-20260902',
    'E:\temp\cupcakeai-owner-test-20260902-webview2',
    'E:\temp\cupcakeagi-out',
    'E:\temp\cupcakeagi-tauri-inputs',
    'E:\temp\cupcakeagi-tauri-target',
    'E:\temp\cupcake-overhaul-20260905',
    'E:\temp\cupcake-overhaul-20260905\broker-target',
    'E:\temp\cupcakeai-models',
    'E:\temp\cupcake-security-native-20260905-fresh',
    'E:\temp\cupcakeai-onboarding-qa-20260905',
    'E:\temp\cupcakeai-owner-showcase-20260905',
    'E:\temp\cupcake-model-catalog-qa-20260905',
    'E:\temp\cupcake-startup-profile-20260905',
    'E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z\cupcake-dbos-system.db',
    'E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z\cupcake-runtime.db',
    'E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z\cupcake.db',
    'E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z\developer-traces.db'
) | ForEach-Object { [IO.Path]::GetFullPath($_) }

$directoryTargets = @(
    'E:\temp\cupcakeai-owner-test-20260902-close-webview2',
    'E:\temp\cupcakeai-owner-test-20260902-close-final-webview2',
    'E:\temp\cupcakeai-owner-test-20260903-webview2',
    'E:\temp\cupcakeai-owner-test-20260903-probe-webview2',
    'E:\temp\cupcakeai-owner-test-20260903-status-webview2',
    'E:\temp\cupcakeai-owner-test-20260903-nim-webview2',
    'E:\temp\cupcakeai-owner-test-20260903-nim2-webview2',
    'E:\temp\cupcakeai-owner-test-20260903-diag-webview2',
    'E:\temp\cupcakeai-direct-open-smoke-20260904-v2-webview2',
    'E:\temp\CupcakeAI\qa\default-open-native-webview2',
    'E:\temp\CupcakeAI\qa\native-final-20260903',
    'E:\temp\CupcakeAI\qa\native-model-catalogs-20260903',
    'E:\temp\CupcakeAI\qa\native-model-catalogs-diag-20260903',
    'E:\temp\CupcakeAI\qa\native-model-catalogs-final-20260903',
    'E:\temp\CupcakeAI\qa\native-model-catalogs-final-verified-20260903',
    'E:\temp\CupcakeAI\qa\native-model-catalogs-pass-20260903',
    'E:\temp\CupcakeAI\qa\native-model-catalogs-pass2-20260903',
    'E:\temp\CupcakeAI\qa\native-model-catalogs-verified-20260903',
    'E:\temp\CupcakeAI\qa\native-model-intelligence-final-webview-20260903',
    'E:\temp\CupcakeAI\qa\native-model-intelligence-lazy-webview-20260903',
    'E:\temp\CupcakeAI\qa\native-model-intelligence-lean-webview-20260903',
    'E:\temp\CupcakeAI\qa\owner-final-build-webview2',
    'E:\temp\CupcakeAI\qa\owner-final-webview2',
    'E:\temp\CupcakeAI\qa\owner-migration-webview2',
    'E:\temp\CupcakeAI\qa\owner-migration-webview2-v2',
    'E:\temp\CupcakeAI\qa\owner-migration-webview2-v3',
    'E:\temp\CupcakeAI\qa\owner-optional-security-webview2',
    'E:\temp\CupcakeAI\qa\webview-model-intelligence-20260903',
    'E:\temp\cupcakeagi-target\security-backup',
    'E:\temp\Cupcakeagi-cargo-target',
    'E:\temp\cupcakeagi-target',
    'E:\temp\cupcakeagi-tool-broker-target',
    'E:\temp\CupcakeAI\normal-profile',
    'E:\temp\CupcakeAI\qa',
    'E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z\local-models.cupcake-migration-backup',
    'E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z\runtime',
    'E:\temp\cupcakeai-direct-open-smoke-20260904-v2',
    'E:\temp\cupcakeai-default-open-20260904',
    'E:\temp\Cupcakeagi-legacy-tests',
    'E:\temp\cupcakeai-owner-test-20260903-ui',
    'E:\temp\cupcake-wallpaper-qa-20260904',
    'E:\temp\cupcakeai-ui-pass2',
    'E:\temp\cupcakeai-visual-20260903',
    'E:\temp\cupcakeai-default-open-native-20260904',
    'E:\temp\cupcakeai-owner-test-20260902-ui',
    'E:\temp\cupcakeai-owner-optional-security-20260904',
    'E:\temp\cupcakeai-owner-final-build-20260903',
    'E:\temp\cupcakeai-owner-final-20260903',
    'E:\temp\cupcakeai-owner-migration-20260903-v3',
    'E:\temp\cupcakeai-owner-migration-20260903-v2',
    'E:\temp\cupcakeai-brand-research',
    'E:\temp\cupcakeai-ui-qa',
    'E:\temp\cupcakeai-owner-migration-20260903'
) | ForEach-Object { [IO.Path]::GetFullPath($_) }

$repositoryReferenceExemptTargets = @(
    'E:\temp\CupcakeAI\normal-profile',
    'E:\temp\CupcakeAI\qa',
    'E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z\local-models.cupcake-migration-backup',
    'E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z\runtime',
    'E:\temp\cupcakeai-direct-open-smoke-20260904-v2',
    'E:\temp\cupcakeai-default-open-20260904',
    'E:\temp\Cupcakeagi-legacy-tests',
    'E:\temp\cupcakeai-owner-test-20260903-ui',
    'E:\temp\cupcake-wallpaper-qa-20260904',
    'E:\temp\cupcakeai-ui-pass2',
    'E:\temp\cupcakeai-visual-20260903',
    'E:\temp\cupcakeai-default-open-native-20260904',
    'E:\temp\cupcakeai-owner-test-20260902-ui',
    'E:\temp\cupcakeai-owner-optional-security-20260904',
    'E:\temp\cupcakeai-owner-final-build-20260903',
    'E:\temp\cupcakeai-owner-final-20260903',
    'E:\temp\cupcakeai-owner-migration-20260903-v3',
    'E:\temp\cupcakeai-owner-migration-20260903-v2',
    'E:\temp\cupcakeai-brand-research',
    'E:\temp\cupcakeai-ui-qa',
    'E:\temp\cupcakeai-owner-migration-20260903'
) | ForEach-Object { [IO.Path]::GetFullPath($_) }

$fileTargets = @(
    'E:\temp\cupcake-opening-titlebar.png',
    'E:\temp\cupcakeai-opening-review.png',
    'E:\temp\cupcakeai-chat-review-corrected.png',
    'E:\temp\cupcakeai-chat-review.png',
    'E:\temp\cupcakeai-wallpaper-picker-review.png',
    'E:\temp\cupcake-chat-wallpaper.png',
    'E:\temp\cupcakeai-chat-narrow-main-review.png',
    'E:\temp\cupcake-models-filters-v2.png',
    'E:\temp\cupcakeai-models-review.png',
    'E:\temp\cupcake-models-curated-v2.png',
    'E:\temp\cupcake-models-filters.png',
    'E:\temp\cupcake-models-curated.png',
    'E:\temp\cupcake-security-desktop-home.png',
    'E:\temp\cupcake-security-desktop-settings.png',
    'E:\temp\cupcakeai-chat-narrow-review.png',
    'E:\temp\cupcake-models-narrow-v2.png',
    'E:\temp\cupcake-security-narrow-home.png',
    'E:\temp\cupcake-security-narrow-settings.png',
    'E:\temp\cupcake-security-narrow-detail.png',
    'E:\temp\cupcake-security-desktop-detail.png',
    'E:\temp\cupcakeai-owner-test-20260902-evidence.json'
) | ForEach-Object { [IO.Path]::GetFullPath($_) }

$runtimeDownloadRoot = [IO.Path]::GetFullPath('E:\temp\CupcakeAI\normal-profile\local-models\downloads\runtime\')
$ownerRuntimeDownloadRoot = [IO.Path]::GetFullPath('E:\temp\cupcakeai-owner-test-20260902\local-models\downloads\runtime\')
$runtimeArchives = @(
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
    'cudart-llama-bin-win-cuda-13.3-x64.zip',
    'llama-b10679-bin-win-cuda-12.4-x64.zip',
    'llama-b10679-bin-win-cuda-13.3-x64.zip',
    'llama-b10679-bin-win-vulkan-x64.zip'
)

function Write-Log {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date).ToString('o'), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Get-TreeBytes {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        return [int64](Get-Item -LiteralPath $Path -Force).Length
    }
    $files = @(Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction Stop)
    if ($files.Count -eq 0) {
        return [int64]0
    }
    return [int64](($files | Measure-Object -Property Length -Sum).Sum)
}

function Get-Sha256Hex {
    param([string]$Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $digest = $algorithm.ComputeHash($stream)
        return ([BitConverter]::ToString($digest)).Replace('-', '')
    }
    finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Assert-ContainedOrdinaryPath {
    param(
        [string]$Path,
        [switch]$CheckDescendants
    )
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Target escaped E:\temp: $full"
    }
    $resolved = (Resolve-Path -LiteralPath $full -ErrorAction Stop).Path
    if (-not $resolved.Equals($full, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Resolved target mismatch: $resolved"
    }
    $ancestor = if (Test-Path -LiteralPath $full -PathType Leaf) {
        [IO.Path]::GetDirectoryName($full)
    }
    else {
        $full.TrimEnd('\')
    }
    $rootWithoutSlash = $tempRoot.TrimEnd('\')
    while ($null -ne $ancestor) {
        $ancestorItem = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
        if ($ancestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Target has a reparse-point ancestor: $ancestor"
        }
        if ($ancestor.Equals($rootWithoutSlash, [StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        if (-not $ancestor.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Target ancestor escaped E:\temp: $ancestor"
        }
        $parent = [IO.Directory]::GetParent($ancestor)
        $ancestor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Target is a reparse point: $full"
    }
    if ($CheckDescendants) {
        $links = @(Get-ChildItem -LiteralPath $full -Force -Recurse -Attributes ReparsePoint -ErrorAction SilentlyContinue)
        if ($links.Count -gt 0) {
            throw "Target contains reparse points: $full"
        }
    }
    return $full
}

function Test-ProtectedOverlap {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    foreach ($protected in $protectedPaths) {
        $guard = $protected.TrimEnd('\')
        if ($full.Equals($guard, [StringComparison]::OrdinalIgnoreCase) -or
            $full.StartsWith($guard + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $guard.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Assert-OrdinaryArchiveParent {
    $full = [IO.Path]::GetFullPath($archiveParent).TrimEnd('\')
    if (-not $full.Equals('E:\uesless', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected archive parent: $full"
    }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        New-Item -ItemType Directory -Path $full -ErrorAction Stop | Out-Null
    }
    $resolved = (Resolve-Path -LiteralPath $full -ErrorAction Stop).Path
    if (-not $resolved.Equals($full, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Resolved archive parent mismatch: $resolved"
    }
    $ancestor = $full
    while ($null -ne $ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Archive parent has a reparse-point ancestor: $ancestor"
        }
        $parent = [IO.Directory]::GetParent($ancestor)
        $ancestor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
    return $full
}

function Get-ArchiveDestinationPlan {
    param([string]$SourcePath)
    $source = [IO.Path]::GetFullPath($SourcePath)
    if (-not $source.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Archive source escaped E:\temp: $source"
    }
    $relative = $source.Substring($tempRoot.Length).TrimStart('\')
    if ([string]::IsNullOrWhiteSpace($relative)) {
        throw 'Refusing to archive the E:\temp root.'
    }
    $destination = [IO.Path]::GetFullPath((Join-Path $archiveRoot $relative))
    $archivePrefix = $archiveRoot.TrimEnd('\') + '\'
    if (-not $destination.StartsWith($archivePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Archive destination escaped its unique batch: $destination"
    }
    if (Test-Path -LiteralPath $destination) {
        throw "Archive destination collision (never overwrite): $destination"
    }
    return $destination
}

function Initialize-ArchiveBatch {
    if ($script:archiveInitialized) {
        return
    }
    Assert-OrdinaryArchiveParent | Out-Null
    if (Test-Path -LiteralPath $archiveRoot) {
        throw "Unique archive batch already exists: $archiveRoot"
    }
    New-Item -ItemType Directory -Path $archiveRoot -ErrorAction Stop | Out-Null
    $item = Get-Item -LiteralPath $archiveRoot -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Archive batch is a reparse point: $archiveRoot"
    }
    $script:archiveInitialized = $true
    Write-Log "Archive batch created: $archiveRoot"
}

function Initialize-ArchiveDestinationParent {
    param([string]$Destination)
    Initialize-ArchiveBatch
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Destination))
    $archivePrefix = $archiveRoot.TrimEnd('\') + '\'
    if (-not ($parent.Equals($archiveRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $parent.StartsWith($archivePrefix, [StringComparison]::OrdinalIgnoreCase))) {
        throw "Archive destination parent escaped its batch: $parent"
    }
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
    }
    $ancestor = $parent
    while ($true) {
        $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Archive destination has a reparse-point ancestor: $ancestor"
        }
        if ($ancestor.Equals($archiveRoot, [StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $ancestor = [IO.Directory]::GetParent($ancestor).FullName
    }
}

function Get-PathFingerprint {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) {
        return [pscustomobject]@{
            Type = 'file'
            Bytes = [int64]$item.Length
            Sha256 = Get-Sha256Hex -Path $item.FullName
            HashScheme = 'sha256-file-v1'
        }
    }
    $root = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $entries = @(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop | Sort-Object FullName)
    $builder = [Text.StringBuilder]::new()
    $bytes = [int64]0
    foreach ($entry in $entries) {
        $relative = $entry.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
        if ($entry.PSIsContainer) {
            [void]$builder.Append("D|$relative`n")
        }
        else {
            $length = [int64]$entry.Length
            $hash = Get-Sha256Hex -Path $entry.FullName
            $bytes += $length
            [void]$builder.Append("F|$relative|$length|$hash`n")
        }
    }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString()))
        $treeHash = ([BitConverter]::ToString($digest)).Replace('-', '')
    }
    finally {
        $algorithm.Dispose()
    }
    return [pscustomobject]@{
        Type = 'directory'
        Bytes = $bytes
        Sha256 = $treeHash
        HashScheme = 'sha256-tree-v1:path-type-length-content-hash'
    }
}

function Write-ArchiveManifestRecord {
    param([System.Collections.IDictionary]$Record)
    Initialize-ArchiveBatch
    $line = [pscustomobject]$Record | ConvertTo-Json -Compress -Depth 8
    Add-Content -LiteralPath $manifestPath -Value $line -Encoding UTF8
}

function Move-ValidatedPathToArchive {
    param(
        [string]$Source,
        [string]$Category,
        [string]$GroupId = ''
    )
    $destination = Get-ArchiveDestinationPlan -SourcePath $Source
    $fingerprint = Get-PathFingerprint -Path $Source
    if ($ValidateOnly) {
        return [pscustomobject]@{ Bytes = $fingerprint.Bytes; Destination = $destination; Sha256 = $fingerprint.Sha256; Planned = $true }
    }
    Initialize-ArchiveDestinationParent -Destination $destination
    Write-ArchiveManifestRecord -Record ([ordered]@{
        Status = 'planned'
        OriginalPath = $Source
        ArchivePath = $destination
        Category = $Category
        GroupId = $GroupId
        Type = $fingerprint.Type
        Bytes = $fingerprint.Bytes
        Sha256 = $fingerprint.Sha256
        HashScheme = $fingerprint.HashScheme
        RecordedAt = (Get-Date).ToString('o')
    })
    if (Test-Path -LiteralPath $destination) {
        throw "Archive destination collision before move (never overwrite): $destination"
    }
    Move-Item -LiteralPath $Source -Destination $destination -ErrorAction Stop
    if ((Test-Path -LiteralPath $Source) -or -not (Test-Path -LiteralPath $destination)) {
        throw "Archive move verification failed: $Source -> $destination"
    }
    Write-ArchiveManifestRecord -Record ([ordered]@{
        Status = 'moved'
        OriginalPath = $Source
        ArchivePath = $destination
        Category = $Category
        GroupId = $GroupId
        Type = $fingerprint.Type
        Bytes = $fingerprint.Bytes
        Sha256 = $fingerprint.Sha256
        HashScheme = $fingerprint.HashScheme
        RecordedAt = (Get-Date).ToString('o')
    })
    return [pscustomobject]@{ Bytes = $fingerprint.Bytes; Destination = $destination; Sha256 = $fingerprint.Sha256; Planned = $false }
}

function Get-ReferencingProcesses {
    param([string]$Path)
    $matches = @()
    foreach ($process in @(Get-CimInstance Win32_Process)) {
        $commandLine = [string]$process.CommandLine
        $executable = [string]$process.ExecutablePath
        if ($commandLine.IndexOf($Path, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $executable.StartsWith($Path, [StringComparison]::OrdinalIgnoreCase)) {
            $matches += $process
        }
    }
    return $matches
}

function Get-RepositoryReferences {
    param([string]$Path)
    $leaf = Split-Path -Leaf $Path
    $patterns = @($Path, $Path.Replace('\', '/'), $leaf)
    $extensions = @('.bat', '.cmd', '.js', '.json', '.md', '.mjs', '.ps1', '.toml', '.ts', '.tsx', '.vbs', '.yaml', '.yml')
    $references = @()
    foreach ($filePath in $script:referenceFiles) {
        foreach ($pattern in $patterns) {
            if (Select-String -LiteralPath $filePath -SimpleMatch -Pattern $pattern -Quiet -ErrorAction SilentlyContinue) {
                $references += $filePath
                break
            }
        }
    }
    return @($references | Sort-Object -Unique)
}

Set-Content -LiteralPath $logPath -Value ('CupcakeAI E: reversible archive pass started {0}' -f (Get-Date).ToString('o')) -Encoding UTF8
Assert-OrdinaryArchiveParent | Out-Null
$driveBefore = Get-PSDrive -Name E
$freeBefore = [int64]$driveBefore.Free
$logicalBytesMoved = [int64]0
$movedCount = 0
$skippedCount = 0
$failedCount = 0
$auditReadyCount = 0

$referenceExtensions = @('.bat', '.cmd', '.js', '.json', '.md', '.mjs', '.ps1', '.toml', '.ts', '.tsx', '.vbs', '.yaml', '.yml')
$gitPaths = @(& git -C $repositoryRoot ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) {
    throw 'Could not build the repository reference inventory with git ls-files.'
}
$script:referenceFiles = @($gitPaths |
    ForEach-Object { [IO.Path]::GetFullPath((Join-Path $repositoryRoot $_)) } |
    Where-Object {
        $full = $_
        (Test-Path -LiteralPath $full -PathType Leaf) -and
        $referenceExtensions -contains [IO.Path]::GetExtension($full).ToLowerInvariant() -and
        -not $full.Equals($scriptPath, [StringComparison]::OrdinalIgnoreCase) -and
        -not $full.Equals($batchPath, [StringComparison]::OrdinalIgnoreCase) -and
        -not $full.Equals($archiveBatchPath, [StringComparison]::OrdinalIgnoreCase) -and
        -not $full.Equals($ledgerPath, [StringComparison]::OrdinalIgnoreCase)
    })

Write-Log "Free bytes before: $freeBefore"
Write-Log "Planned unique archive batch: $archiveRoot"

foreach ($target in $directoryTargets) {
    try {
        if (-not (Test-Path -LiteralPath $target -PathType Container)) {
            Write-Log "SKIP already absent: $target"
            $skippedCount++
            continue
        }
        if (Test-ProtectedOverlap -Path $target) {
            throw "Target overlaps a protected path: $target"
        }
        $validated = Assert-ContainedOrdinaryPath -Path $target -CheckDescendants
        $processes = @(Get-ReferencingProcesses -Path $validated)
        if ($processes.Count -gt 0) {
            $names = ($processes | ForEach-Object { '{0}:{1}' -f $_.Name, $_.ProcessId }) -join ', '
            throw "Active process reference: $names"
        }
        $references = @(Get-RepositoryReferences -Path $validated)
        if ($references.Count -gt 0) {
            if ($repositoryReferenceExemptTargets -contains $validated) {
                Write-Log "SUPERSEDED historical repository reference(s): $validated :: $($references -join ', ')"
            }
            else {
                throw "Current repository reference: $($references -join ', ')"
            }
        }
        $result = Move-ValidatedPathToArchive -Source $validated -Category 'obsolete-directory'
        if ($ValidateOnly) {
            $auditReadyCount++
            Write-Log "AUDIT ready directory archive ($($result.Bytes) bytes, SHA256=$($result.Sha256)): $validated -> $($result.Destination)"
        }
        else {
            $logicalBytesMoved += [int64]$result.Bytes
            $movedCount++
            Write-Log "ARCHIVED directory ($($result.Bytes) bytes, SHA256=$($result.Sha256)): $validated -> $($result.Destination)"
        }
    }
    catch {
        $failedCount++
        Write-Log "PRESERVED directory: $target :: $($_.Exception.Message)"
    }
}

foreach ($target in $fileTargets) {
    try {
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            Write-Log "SKIP file already absent: $target"
            $skippedCount++
            continue
        }
        if (Test-ProtectedOverlap -Path $target) {
            throw "File target overlaps a protected path: $target"
        }
        $validated = Assert-ContainedOrdinaryPath -Path $target
        $processes = @(Get-ReferencingProcesses -Path $validated)
        if ($processes.Count -gt 0) {
            $names = ($processes | ForEach-Object { '{0}:{1}' -f $_.Name, $_.ProcessId }) -join ', '
            throw "Active process reference: $names"
        }
        $result = Move-ValidatedPathToArchive -Source $validated -Category 'superseded-file'
        if ($ValidateOnly) {
            $auditReadyCount++
            Write-Log "AUDIT ready file archive ($($result.Bytes) bytes, SHA256=$($result.Sha256)): $validated -> $($result.Destination)"
        }
        else {
            $logicalBytesMoved += [int64]$result.Bytes
            $movedCount++
            Write-Log "ARCHIVED file ($($result.Bytes) bytes, SHA256=$($result.Sha256)): $validated -> $($result.Destination)"
        }
    }
    catch {
        $failedCount++
        Write-Log "PRESERVED file: $target :: $($_.Exception.Message)"
    }
}

$installedBackends = @('cpu', 'cuda-12', 'cuda-13', 'vulkan')
$installedRoot = 'E:\temp\cupcakeai-owner-test-20260902\local-models\runtime\versions\b10679'
$installedReady = $true
foreach ($backend in $installedBackends) {
    if (-not (Test-Path -LiteralPath (Join-Path $installedRoot $backend) -PathType Container)) {
        $installedReady = $false
        Write-Log "PRESERVED runtime downloads: installed backend missing: $backend"
    }
}

if ($installedReady) {
    foreach ($archiveName in $runtimeArchives) {
        $oldArchive = [IO.Path]::GetFullPath((Join-Path $runtimeDownloadRoot $archiveName))
        $ownerCopy = [IO.Path]::GetFullPath((Join-Path $ownerRuntimeDownloadRoot $archiveName))
        $oldMetadata = $oldArchive + '.download.json'
        try {
            $archiveExists = Test-Path -LiteralPath $oldArchive -PathType Leaf
            $metadataExists = Test-Path -LiteralPath $oldMetadata -PathType Leaf
            if (-not $archiveExists -and -not $metadataExists) {
                Write-Log "SKIP runtime cache already absent: $archiveName"
                $skippedCount++
                continue
            }
            if ($archiveExists -ne $metadataExists) {
                throw "Runtime archive/metadata pair is incomplete: $archiveName"
            }
            foreach ($path in @($oldArchive, $oldMetadata, $ownerCopy)) {
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                    throw "Required duplicate proof file missing: $path"
                }
                $validated = Assert-ContainedOrdinaryPath -Path $path
                if ($path -in @($oldArchive, $oldMetadata) -and
                    -not $validated.StartsWith($runtimeDownloadRoot, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Runtime download escaped its exact cache root: $validated"
                }
            }
            $processes = @(Get-ReferencingProcesses -Path $runtimeDownloadRoot.TrimEnd('\'))
            if ($processes.Count -gt 0) {
                $names = ($processes | ForEach-Object { '{0}:{1}' -f $_.Name, $_.ProcessId }) -join ', '
                throw "Active runtime-download process reference: $names"
            }
            $oldHash = Get-Sha256Hex -Path $oldArchive
            $copyHash = Get-Sha256Hex -Path $ownerCopy
            if (-not $oldHash.Equals($copyHash, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Protected duplicate hash mismatch for $archiveName"
            }
            $archiveFingerprint = Get-PathFingerprint -Path $oldArchive
            $metadataFingerprint = Get-PathFingerprint -Path $oldMetadata
            $bytes = [int64]$archiveFingerprint.Bytes + [int64]$metadataFingerprint.Bytes
            $archiveDestination = Get-ArchiveDestinationPlan -SourcePath $oldArchive
            $metadataDestination = Get-ArchiveDestinationPlan -SourcePath $oldMetadata
            $groupId = 'runtime-cache-pair:{0}' -f $archiveName
            if ($ValidateOnly) {
                $auditReadyCount++
                Write-Log "AUDIT ready paired runtime archive ($bytes bytes): $oldArchive -> $archiveDestination; $oldMetadata -> $metadataDestination; archive SHA256=$oldHash; metadata SHA256=$($metadataFingerprint.Sha256)"
                continue
            }
            Initialize-ArchiveDestinationParent -Destination $archiveDestination
            Initialize-ArchiveDestinationParent -Destination $metadataDestination
            foreach ($entry in @(
                @{ Original = $oldArchive; Destination = $archiveDestination; Fingerprint = $archiveFingerprint; Role = 'archive' },
                @{ Original = $oldMetadata; Destination = $metadataDestination; Fingerprint = $metadataFingerprint; Role = 'metadata' }
            )) {
                Write-ArchiveManifestRecord -Record ([ordered]@{
                    Status = 'planned'
                    OriginalPath = $entry.Original
                    ArchivePath = $entry.Destination
                    Category = 'verified-runtime-cache-pair'
                    GroupId = $groupId
                    PairRole = $entry.Role
                    Type = $entry.Fingerprint.Type
                    Bytes = $entry.Fingerprint.Bytes
                    Sha256 = $entry.Fingerprint.Sha256
                    HashScheme = $entry.Fingerprint.HashScheme
                    RecordedAt = (Get-Date).ToString('o')
                })
            }
            $archiveMoved = $false
            try {
                if ((Test-Path -LiteralPath $archiveDestination) -or (Test-Path -LiteralPath $metadataDestination)) {
                    throw "Runtime pair archive collision before move (never overwrite): $archiveName"
                }
                Move-Item -LiteralPath $oldArchive -Destination $archiveDestination -ErrorAction Stop
                $archiveMoved = $true
                Move-Item -LiteralPath $oldMetadata -Destination $metadataDestination -ErrorAction Stop
            }
            catch {
                $pairError = $_
                if ($archiveMoved -and (Test-Path -LiteralPath $archiveDestination) -and -not (Test-Path -LiteralPath $oldArchive)) {
                    Move-Item -LiteralPath $archiveDestination -Destination $oldArchive -ErrorAction Stop
                    Write-Log "ROLLED BACK incomplete runtime pair archive: $archiveName"
                }
                throw $pairError
            }
            if ((Test-Path -LiteralPath $oldArchive) -or (Test-Path -LiteralPath $oldMetadata) -or
                -not (Test-Path -LiteralPath $archiveDestination -PathType Leaf) -or
                -not (Test-Path -LiteralPath $metadataDestination -PathType Leaf)) {
                throw "Runtime cache pair archive verification failed for $archiveName"
            }
            foreach ($entry in @(
                @{ Original = $oldArchive; Destination = $archiveDestination; Fingerprint = $archiveFingerprint; Role = 'archive' },
                @{ Original = $oldMetadata; Destination = $metadataDestination; Fingerprint = $metadataFingerprint; Role = 'metadata' }
            )) {
                Write-ArchiveManifestRecord -Record ([ordered]@{
                    Status = 'moved'
                    OriginalPath = $entry.Original
                    ArchivePath = $entry.Destination
                    Category = 'verified-runtime-cache-pair'
                    GroupId = $groupId
                    PairRole = $entry.Role
                    Type = $entry.Fingerprint.Type
                    Bytes = $entry.Fingerprint.Bytes
                    Sha256 = $entry.Fingerprint.Sha256
                    HashScheme = $entry.Fingerprint.HashScheme
                    RecordedAt = (Get-Date).ToString('o')
                })
            }
            $logicalBytesMoved += $bytes
            $movedCount++
            Write-Log "ARCHIVED paired runtime archive and metadata ($bytes bytes): $archiveName archive SHA256=$oldHash metadata SHA256=$($metadataFingerprint.Sha256)"
        }
        catch {
            $failedCount++
            Write-Log "PRESERVED runtime archive: $archiveName :: $($_.Exception.Message)"
        }
    }
}

$driveAfter = Get-PSDrive -Name E
$freeAfter = [int64]$driveAfter.Free
Write-Log "Free bytes after: $freeAfter"
Write-Log "Logical bytes moved to E:\uesless: $logicalBytesMoved"
Write-Log "Archived entries/groups: $movedCount; skipped absent: $skippedCount; preserved/failed: $failedCount"
Write-Log "Audit-ready entries: $auditReadyCount"
if ($archiveInitialized) {
    Write-Log "Archive manifest: $manifestPath"
}
else {
    Write-Log 'No archive batch created because no source target was present.'
}

if ($failedCount -gt 0) {
    exit 1
}
exit 0
