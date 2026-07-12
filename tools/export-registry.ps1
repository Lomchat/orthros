# Export a Windows registry subtree into BottleShip registry.json format.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\export-registry.ps1 `
#     -Path "HKLM\SOFTWARE\Friday's games\Natalie Brooks: Secrets of Treasure House" `
#     -Out  registry.json
#
# You can pass -Path multiple times. Both HKLM\... and HKCU\... accepted.
# Output is an array of RegistrySeed ({ root, path, values[] }), one per subkey
# that has values. Types map to REG_SZ / REG_DWORD / REG_BINARY / REG_MULTI_SZ.
# REG_EXPAND_SZ is downgraded to REG_SZ (engine doesn't distinguish).
# Unsupported types (QWORD, LINK, NONE) are skipped with a warning.

param(
    [Parameter(Mandatory=$true)]
    [string[]]$Path,

    [Parameter(Mandatory=$true)]
    [string]$Out
)

$ErrorActionPreference = "Stop"

function Normalize-Root([string]$root) {
    switch -Regex ($root.ToUpper()) {
        '^HKLM$|^HKEY_LOCAL_MACHINE$' { return 'HKLM' }
        '^HKCU$|^HKEY_CURRENT_USER$'  { return 'HKCU' }
        '^HKCR$|^HKEY_CLASSES_ROOT$'  { return 'HKCR' }
        '^HKU$|^HKEY_USERS$'          { return 'HKU' }
        default { throw "Unknown registry root: $root" }
    }
}

function Root-To-PSDrive([string]$root) {
    switch ($root) {
        'HKLM' { return 'HKLM:' }
        'HKCU' { return 'HKCU:' }
        'HKCR' { return 'HKCR:' }
        'HKU'  { return 'HKU:' }
    }
    throw "Unknown root: $root"
}

# Split "HKLM\Software\Foo" into (HKLM, Software\Foo)
function Split-RootPath([string]$p) {
    $parts = $p.Split('\', 2)
    if ($parts.Count -lt 2) { throw "Path must be ROOT\Subkey, got: $p" }
    return @((Normalize-Root $parts[0]), $parts[1])
}

$seeds = @()

foreach ($inputPath in $Path) {
    $tuple    = Split-RootPath $inputPath
    $root     = $tuple[0]
    $subPath  = $tuple[1]
    $psDrive  = Root-To-PSDrive $root
    $fullPs   = Join-Path $psDrive $subPath

    if (-not (Test-Path $fullPs)) {
        Write-Warning "Not found: $inputPath  (skipping)"
        continue
    }

    # Walk this key and all descendants.
    $keys = @($fullPs) + (Get-ChildItem -Path $fullPs -Recurse -ErrorAction SilentlyContinue |
                          Where-Object { $_.PSIsContainer -eq $true } |
                          ForEach-Object { $_.PSPath })

    foreach ($keyPath in $keys) {
        try { $item = Get-Item -LiteralPath $keyPath -ErrorAction Stop } catch { continue }

        # Compute subkey path relative to the root drive.
        # $item.Name looks like "HKEY_LOCAL_MACHINE\SOFTWARE\Foo\Bar".
        $nameParts = $item.Name.Split('\', 2)
        if ($nameParts.Count -lt 2) { continue }  # skip the bare root hive
        $relPath = $nameParts[1]

        $values = @()
        foreach ($vname in $item.GetValueNames()) {
            $kind = $item.GetValueKind($vname)
            $data = $item.GetValue($vname, $null, 'DoNotExpandEnvironmentNames')

            $displayName = if ([string]::IsNullOrEmpty($vname)) { '(default)' } else { $vname }

            switch ($kind) {
                'String' {
                    $values += [ordered]@{ name=$displayName; type='REG_SZ'; data=[string]$data }
                }
                'ExpandString' {
                    # Engine has no REG_EXPAND_SZ; emit REG_SZ with raw template.
                    $values += [ordered]@{ name=$displayName; type='REG_SZ'; data=[string]$data }
                }
                'DWord' {
                    $values += [ordered]@{ name=$displayName; type='REG_DWORD'; data=[int64]$data }
                }
                'Binary' {
                    # Emit as hex string "aabbcc..." — engine accepts REG_BINARY with string data.
                    if ($data -is [byte[]]) {
                        $hex = -join ($data | ForEach-Object { $_.ToString('x2') })
                    } else {
                        $hex = ''
                    }
                    $values += [ordered]@{ name=$displayName; type='REG_BINARY'; data=$hex }
                }
                'MultiString' {
                    # Join as "a\0b\0c" — engine splits on \0 for REG_MULTI_SZ.
                    $joined = ($data -join "`0")
                    $values += [ordered]@{ name=$displayName; type='REG_MULTI_SZ'; data=$joined }
                }
                default {
                    Write-Warning "Skipping unsupported type $kind for $keyPath\$displayName"
                }
            }
        }

        if ($values.Count -gt 0) {
            $seeds += [ordered]@{ root=$root; path=$relPath; values=$values }
        } else {
            Write-Host "  (no values) $root\$relPath" -ForegroundColor DarkGray
        }
    }
}

# Pretty-printed JSON.
$json = $seeds | ConvertTo-Json -Depth 10
# ConvertTo-Json emits a bare object when count==1; force array.
if ($seeds.Count -eq 1) { $json = "[`n$json`n]" }
if ($seeds.Count -eq 0) { $json = "[]" }

Set-Content -LiteralPath $Out -Value $json -Encoding UTF8
Write-Host "Wrote $($seeds.Count) key(s) to $Out" -ForegroundColor Green
