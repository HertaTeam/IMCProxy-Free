param(
    [string]$Configuration = "Release",
    [string]$SourceOld = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$build = Join-Path $root "build"
$dist = Join-Path $root "dist"

if (-not $SourceOld) { $SourceOld = Join-Path ([Environment]::GetFolderPath("Desktop")) "imcpfreeold\IMCProxy-Free" }
$version = (Get-Content (Join-Path $root "VERSION") -Raw).Trim()
if (-not $version) { throw "VERSION file is empty" }

$versionDir = Join-Path $dist "versions\imcproxy-$version-win64"
$lastDir = Join-Path $dist "last"
$zipPath = Join-Path $dist "versions\imcproxy-$version-win64.zip"
$lastZip = Join-Path $dist "imcproxy-last-win64.zip"

Write-Host "Building $Configuration $version..." -ForegroundColor Cyan
cmake -S $root -B $build -G "Visual Studio 18 2026" -A x64 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "configure failed" }
cmake --build $build --config $Configuration | Out-Host
if ($LASTEXITCODE -ne 0) { throw "build failed" }

function Populate-Folder([string]$target) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    try {
        Copy-Item (Join-Path $build "$Configuration\imcproxy.exe") $target -Force -ErrorAction Stop
    } catch {
        Write-Host "  ! cannot replace $target\imcproxy.exe (still running?)" -ForegroundColor Yellow
        Write-Host "    close the running imcproxy window and run pack.ps1 again" -ForegroundColor Yellow
    }
    Copy-Item (Join-Path $root "README.md") $target -Force
    Copy-Item (Join-Path $root "docs\MIGRATION.md") $target -Force -ErrorAction SilentlyContinue
    if (Test-Path (Join-Path $root "config.json")) {
        Copy-Item (Join-Path $root "config.json") $target -Force
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $target "logs") | Out-Null
    $assets = Join-Path $root "src\assets"
    if (Test-Path $assets) {
        Copy-Item $assets (Join-Path $target "src\assets") -Recurse -Force
    }
    $templates = @{
        "game-account.txt" = "# <game account> <game password>`r`n"
        "game-accounts.txt" = "# 账号 密码 [备注]`r`n"
    }
    foreach ($name in $templates.Keys) {
        $path = Join-Path $target $name
        if (-not (Test-Path $path)) {
            [IO.File]::WriteAllText($path, $templates[$name], (New-Object System.Text.UTF8Encoding($false)))
        }
    }
}

Populate-Folder $versionDir
Populate-Folder $lastDir

$personal = @("config.json", "game-account.txt", "game-accounts.txt")
$copied = @()
foreach ($unwanted in @("imc-account.txt", "bind-code.txt", ".imc-session.json", ".imc-captoken.json")) {
    $stale = Join-Path $lastDir $unwanted
    if (Test-Path $stale) { Remove-Item $stale -Force -ErrorAction SilentlyContinue }
}

if (Test-Path $SourceOld) {
    foreach ($name in $personal) {
        $source = Join-Path $SourceOld $name
        if (Test-Path $source) {
            Copy-Item $source $lastDir -Force
            $copied += $name
        }
    }
}

if (Test-Path (Join-Path $SourceOld "logs")) {
    Copy-Item (Join-Path $SourceOld "logs\*") (Join-Path $lastDir "logs") -Force -ErrorAction SilentlyContinue
}

$notice = @"
This folder is the newest build plus your own imcp data.

Included runtime data: $($copied -join ', ')

It contains real game account credentials. Do not upload it anywhere.

The clean build of the same version is in dist\versions\imcproxy-$version-win64.
"@
[IO.File]::WriteAllText((Join-Path $lastDir "LAST-README.txt"), $notice, (New-Object System.Text.UTF8Encoding($false)))

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($versionDir, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
if (Test-Path $lastZip) { Remove-Item $lastZip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($lastDir, $lastZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

Write-Host ""
Write-Host "version: $version" -ForegroundColor Green
Write-Host "clean build: $versionDir" -ForegroundColor Green
Write-Host "with my data: $lastDir" -ForegroundColor Green
Write-Host "version zip: $zipPath" -ForegroundColor Green
Write-Host "last zip: $lastZip" -ForegroundColor Green
Write-Host ""
Write-Host "clean build contents:" -ForegroundColor Cyan
Get-ChildItem $versionDir | ForEach-Object { "  " + $_.Name }
Write-Host "last contents:" -ForegroundColor Cyan
Get-ChildItem $lastDir | ForEach-Object { "  " + $_.Name }
Write-Host ""
Write-Host "sha256 clean: $((Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant())" -ForegroundColor Green
Write-Host "sha256 last : $((Get-FileHash $lastZip -Algorithm SHA256).Hash.ToLowerInvariant())" -ForegroundColor Green
