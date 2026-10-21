# Install the checksummed, single-file Grip executable for the current Windows user.
param(
    [string]$Version = $env:GRIP_VERSION,
    [string]$InstallDir = $env:GRIP_INSTALL_DIR
)
$ErrorActionPreference = 'Stop'
if (-not [string]::IsNullOrEmpty($Version) -and $Version -cnotmatch '^v[0-9][a-zA-Z0-9.+-]*$') {
    throw 'Invalid GRIP_VERSION (expected a v-prefixed release tag)'
}
$arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
    'X64' { 'x64' }
    'Arm64' { 'arm64' }
    default { throw 'Grip binary releases support Windows x64 and arm64 only' }
}
$asset = "grip-windows-$arch.exe"
$base = if ($env:GRIP_RELEASE_BASE_URL) { $env:GRIP_RELEASE_BASE_URL.TrimEnd('/') } else { 'https://github.com/greppleai/grip/releases' }
if ($base -cnotmatch '^https://[a-zA-Z0-9._:/?=&%+-]+$' -and $base -cnotmatch '^http://(localhost|127\.0\.0\.1):[0-9]+(/[a-zA-Z0-9._/-]*)?$') {
    throw 'Release URL must be HTTPS (or loopback for tests)'
}
if ($base.Contains('..')) { throw 'Invalid release URL' }
$url = if ($Version) { "$base/download/$Version" } else { "$base/latest/download" }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Grip\bin' }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
[System.IO.Directory]::CreateDirectory($InstallDir) | Out-Null
$target = Join-Path $InstallDir 'grip.exe'
if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Refusing to replace a symlink or reparse point'
}
$work = Join-Path $InstallDir ('.grip-install-' + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($work) | Out-Null
try {
    $binary = Join-Path $work $asset
    $checksum = "$binary.sha256"
    Invoke-WebRequest -Uri "$url/$asset" -OutFile $binary
    Invoke-WebRequest -Uri "$url/$asset.sha256" -OutFile $checksum
    $line = (Get-Content -LiteralPath $checksum -Raw).Trim()
    if ($line -cnotmatch "^([a-fA-F0-9]{64})\s+\*?$([regex]::Escape($asset))$") { throw 'Invalid SHA-256 checksum file' }
    $expected = $Matches[1]
    $actual = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    if ($actual -ine $expected) { throw 'SHA-256 mismatch; installation aborted' }
    if (Test-Path -LiteralPath $target) {
        if (-not (Get-Item -LiteralPath $target).PSIsContainer) {
            $backup = Join-Path $work 'previous-grip.exe'
            [System.IO.File]::Replace($binary, $target, $backup)
        } else { throw 'Refusing to replace a directory' }
    } else { [System.IO.File]::Move($binary, $target) }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -inotcontains $InstallDir) {
    $entries = @($userPath, $InstallDir) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
    Write-Host 'Added the Grip install directory to your user PATH. Open a new terminal to use it.'
}
Write-Host "Installed $target"
$resolved = Get-Command grip.exe -ErrorAction SilentlyContinue
if ($resolved -and $resolved.Source -and $resolved.Source -ine $target) {
    Write-Warning "grip.exe currently resolves to $($resolved.Source). Place $InstallDir first in PATH or remove the older installation."
}
