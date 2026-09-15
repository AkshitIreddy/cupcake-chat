[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$externalRoot = [IO.Path]::GetFullPath('E:\temp\')
$locations = @('out', 'docs\media', 'crates\tool-broker\target',
    'apps\desktop\src-tauri\binaries', 'apps\desktop\src-tauri\target',
    'apps\desktop\src-tauri\resources\sidecars')

function Assert-ChildPath([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the expected root: $full"
    }
    return $full
}

function Get-Inventory([string]$Root) {
    $files = @{}
    $directories = [Collections.Generic.Stack[string]]::new()
    $directories.Push($Root)
    while ($directories.Count) {
        foreach ($entry in Get-ChildItem -LiteralPath $directories.Pop() -Force) {
            # The obsolete WSL CI venv is reproducible and contains Linux-only
            # reparse points. The active Windows runtime .venv stays in services/.
            if ($entry.FullName -eq 'E:\temp\cupcakeagi-out\ci-venv') { continue }
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Nested link must be resolved before consolidation: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) { $directories.Push($entry.FullName) }
            else { $files[$entry.FullName.Substring($Root.Length).TrimStart('\')] = $entry.Length }
        }
    }
    return ,$files
}

$plan = @()
foreach ($location in $locations) {
    $destination = Assert-ChildPath (Join-Path $repoRoot $location) $repoRoot
    $entry = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    if (-not $entry -or -not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $source = Assert-ChildPath ([string]$entry.Target) $externalRoot
    if (-not $source.Substring($externalRoot.Length).StartsWith('cupcake', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Not a Cupcake working directory: $source"
    }
    $sourceEntry = Get-Item -LiteralPath $source -Force
    if ($sourceEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Source is another link: $source" }
    $files = Get-Inventory $source
    $bytes = ($files.Values | Measure-Object -Sum).Sum
    $plan += [pscustomobject]@{ Source = $source; Destination = $destination; Files = $files.Count; Bytes = $bytes }
}
$plan | Format-List Source, Destination, Files, Bytes
Write-Output ('Total to consolidate: {0:N2} GiB' -f (($plan | Measure-Object Bytes -Sum).Sum / 1GB))
if (-not $Apply) { Write-Output 'Plan only. Use -Apply to copy, verify, and remove the old locations.'; exit 0 }

# Only the six verified project links are migrated. Other projects and installed
# application profiles are outside this operation. Never follow nested links.
$active = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(cargo|rustc|makensis|CupcakeAI|cupcake-runtime|cupcake-tool-broker)\.exe$' -and
    ($_.ExecutablePath -like "$repoRoot\*" -or $_.CommandLine -like '*cupcake*')
}
if ($active) { throw 'Close the Cupcake development app and its build processes before consolidation.' }
$requiredBytes = ($plan | Measure-Object Bytes -Sum).Sum
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($repoRoot).Substring(0, 1))
if ($drive.Free -lt ($requiredBytes + 5GB)) { throw 'Insufficient free space for verified consolidation.' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'services\runtime\.venv\Scripts\python.exe'))) {
    throw 'The active Windows runtime environment must exist before discarding the obsolete WSL CI environment.'
}

foreach ($item in $plan) {
    $source = Assert-ChildPath $item.Source $externalRoot
    $destination = Assert-ChildPath $item.Destination $repoRoot
    $stage = Assert-ChildPath ($destination + '.consolidating') $repoRoot
    if (Test-Path -LiteralPath $stage) { throw "Previous staging directory needs inspection: $stage" }
    Write-Output "Consolidating $source"
    New-Item -ItemType Directory -Path $stage | Out-Null
    & robocopy.exe $source $stage /E /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NP /NJH /NJS /MT:8 /XD 'E:\temp\cupcakeagi-out\ci-venv'
    if ($LASTEXITCODE -gt 7) { throw "Copy failed ($LASTEXITCODE); original remains at $source" }
    $original = Get-Inventory $source
    $copied = Get-Inventory $stage
    if ($original.Count -ne $copied.Count) { throw "File count mismatch for $source" }
    foreach ($name in $original.Keys) {
        if (-not $copied.ContainsKey($name) -or $original[$name] -ne $copied[$name]) {
            throw "File size mismatch: $name"
        }
    }
    # Hash public media and packaged executables in addition to the full size inventory.
    foreach ($name in $original.Keys) {
        if ($destination -like '*\docs\media' -or $name -match '\.(exe|dll|json)$') {
            $a = (Get-FileHash -LiteralPath (Join-Path $source $name) -Algorithm SHA256).Hash
            $b = (Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash
            if ($a -ne $b) { throw "Hash mismatch: $name" }
        }
    }
    $link = Get-Item -LiteralPath $destination -Force
    if (-not ($link.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [string]$link.Target -ne $source) {
        throw "Destination link changed: $destination"
    }
    # Remove only the link; the original data remains until the local copy is in place.
    Remove-Item -LiteralPath $destination -Force
    Move-Item -LiteralPath $stage -Destination $destination
    $null = Assert-ChildPath $source $externalRoot
    Remove-Item -LiteralPath $source -Recurse -Force
    Write-Output "Local directory ready: $destination"
}
# These known containers should now be empty. Never remove unexpected contents.
foreach ($container in @('cupcakeagi-tauri-inputs', 'cupcake-overhaul-20260905')) {
    $path = Assert-ChildPath (Join-Path $externalRoot $container) $externalRoot
    if ((Test-Path -LiteralPath $path) -and -not (Get-ChildItem -LiteralPath $path -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $path -Force
    }
}
Write-Output 'Consolidation complete. Project files and build caches are local to this checkout.'
