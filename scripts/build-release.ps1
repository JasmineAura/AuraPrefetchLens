param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    $package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
    $version = [string]$package.version
    if ($version -notmatch '^\d+\.\d+\.\d+([-.][A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
    $baseName = "Aura-MFT-Lens-v$version-windows-x64"
    if (-not $SkipBuild) {
        & npx.cmd tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed.' }
    }
    $binary = Join-Path $projectRoot 'src-tauri\target\release\aura-mft-lens.exe'
    if (-not (Test-Path -LiteralPath $binary)) { throw 'Release executable not found.' }
    $output = Join-Path $projectRoot "artifacts\release\v$version"
    $staging = Join-Path $output 'portable'
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    $exe = Join-Path $output "$baseName.exe"
    Copy-Item -LiteralPath $binary -Destination $exe -Force
    Copy-Item -LiteralPath $binary -Destination (Join-Path $staging 'Aura-MFT-Lens.exe') -Force
    $instructions = @"
AURA / MFT LENS v$version
Windows 10 / 11 x64 portable release

1. Extract the ZIP and run Aura-MFT-Lens.exe.
2. Choose MFT or USN Journal, browse to the exported raw file, then parse it.
3. Analysis results open in a separate window.
4. Resident content: select an MFT record > Data streams > Extract.
5. USN Journal: filter events, inspect raw records, optionally link a same-volume MFT.

Requires Microsoft Edge WebView2 Runtime:
https://developer.microsoft.com/microsoft-edge/webview2/

No Node.js or Rust installation is needed to run this release.
Non-resident file content requires the original volume or disk image.

Documentation, updates and support:
https://github.com/JasmineAura/AuraPrefetchLens
"@
    [System.IO.File]::WriteAllText((Join-Path $staging 'README.txt'), $instructions, [System.Text.UTF8Encoding]::new($false))
    $zip = Join-Path $output "$baseName.zip"
    Compress-Archive -LiteralPath (Join-Path $staging 'Aura-MFT-Lens.exe'), (Join-Path $staging 'README.txt') -DestinationPath $zip -Force
    $checksums = @($exe, $zip) | ForEach-Object {
        $digest = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
        "$digest  $([System.IO.Path]::GetFileName($_))"
    }
    [System.IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), ($checksums -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Output "Release files: $output"
    Get-ChildItem -LiteralPath $output -File | Select-Object Name, Length
} finally { Pop-Location }
