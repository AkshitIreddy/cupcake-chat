[CmdletBinding()]
param([switch]$ValidateOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tempRoot = [IO.Path]::GetFullPath('E:\temp\')
$logPath = 'E:\temp\cupcake-cleanup-20260905.log'
$ledgerPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'docs\worklogs\2026-09-05-e-drive-cleanup.md'))
$batchPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'Cleanup CupcakeAI E Drive.bat'))
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)

$protectedPaths = @(
    'E:\temp\cupcakeai-owner-test-20260902',
    'E:\temp\cupcakeai-owner-test-20260902-webview2',
    'E:\temp\cupcakeagi-out',
    'E:\temp\cupcakeagi-tauri-inputs',
    'E:\temp\cupcakeagi-tauri-target',
    'E:\temp\cupcake-overhaul-20260905',
    'E:\temp\cupcake-overhaul-20260905\broker-target',
    'E:\temp\CupcakeAI\normal-profile\local-models\models',
    'E:\temp\CupcakeAI\normal-profile\local-models\runtime',
    'E:\temp\CupcakeAI\quarantine'
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
    'E:\temp\cupcakeagi-tool-broker-target'
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

Set-Content -LiteralPath $logPath -Value ('CupcakeAI E: cleanup started {0}' -f (Get-Date).ToString('o')) -Encoding UTF8
$driveBefore = Get-PSDrive -Name E
$freeBefore = [int64]$driveBefore.Free
$logicalBytesDeleted = [int64]0
$deletedCount = 0
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
        -not $full.Equals($ledgerPath, [StringComparison]::OrdinalIgnoreCase)
    })

Write-Log "Free bytes before: $freeBefore"

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
            throw "Current repository reference: $($references -join ', ')"
        }
        $bytes = Get-TreeBytes -Path $validated
        if ($ValidateOnly) {
            $auditReadyCount++
            Write-Log "AUDIT ready directory ($bytes bytes): $validated"
            continue
        }
        Remove-Item -LiteralPath $validated -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $validated) {
            throw "Deletion verification failed: $validated"
        }
        $logicalBytesDeleted += $bytes
        $deletedCount++
        Write-Log "DELETED directory ($bytes bytes): $validated"
    }
    catch {
        $failedCount++
        Write-Log "PRESERVED directory: $target :: $($_.Exception.Message)"
    }
}

$installedBackends = @('cpu', 'cuda-12', 'cuda-13', 'vulkan')
$installedRoot = 'E:\temp\CupcakeAI\normal-profile\local-models\runtime\versions\b10679'
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
            $bytes = (Get-TreeBytes -Path $oldArchive) + (Get-TreeBytes -Path $oldMetadata)
            if ($ValidateOnly) {
                $auditReadyCount++
                Write-Log "AUDIT ready verified duplicate archive and metadata ($bytes bytes): $archiveName SHA256=$oldHash"
                continue
            }
            Remove-Item -LiteralPath $oldArchive -Force -ErrorAction Stop
            Remove-Item -LiteralPath $oldMetadata -Force -ErrorAction Stop
            if ((Test-Path -LiteralPath $oldArchive) -or (Test-Path -LiteralPath $oldMetadata)) {
                throw "Runtime cache deletion verification failed for $archiveName"
            }
            $logicalBytesDeleted += $bytes
            $deletedCount++
            Write-Log "DELETED verified duplicate archive and metadata ($bytes bytes): $archiveName SHA256=$oldHash"
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
Write-Log "Logical bytes deleted: $logicalBytesDeleted"
Write-Log "Deleted entries: $deletedCount; skipped absent: $skippedCount; preserved/failed: $failedCount"
Write-Log "Audit-ready entries: $auditReadyCount"

if ($failedCount -gt 0) {
    exit 1
}
exit 0
