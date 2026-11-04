<#
.SYNOPSIS
    打包扩展为可上传到 Microsoft Edge 加载项商店（Partner Center）的 zip。

.DESCRIPTION
    商店要求 zip 的根目录直接是 manifest.json，而 GitHub Release 里的 zip
    外面套了一层 tab-box/，直接上传会报「找不到 manifest.json」。
    本脚本只放运行时需要的文件，入口条目使用正斜杠、不带顶层文件夹。

.PARAMETER OutputDirectory
    输出目录，默认 dist。

.EXAMPLE
    pwsh -File scripts/build-edge-package.ps1
#>
param(
    [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

$files = @('manifest.json', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'LICENSE')
$dirs = @('icons')

$stage = Join-Path $env:TEMP ("tabbox-stage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item ($files | ForEach-Object { Join-Path $root $_ }) -Destination $stage
    Copy-Item ($dirs | ForEach-Object { Join-Path $root $_ }) -Destination $stage -Recurse

    $outDir = Join-Path $root $OutputDirectory
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    $zipPath = Join-Path $outDir ("tab-box-{0}-edge.zip" -f $manifest.version)
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
    try {
        Get-ChildItem $stage -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal') | Out-Null
        }
    }
    finally { $zip.Dispose() }

    # 自检：根目录必须有 manifest.json，且与源文件逐字节一致
    $read = $null
    $check = $null
    try {
        $read = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
        if (-not ($read.Entries | Where-Object { $_.FullName -eq 'manifest.json' })) {
            throw 'zip 根目录缺少 manifest.json'
        }
        $check = Join-Path $env:TEMP ("tabbox-check-" + [guid]::NewGuid().ToString('N'))
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $check)
        try {
            Get-ChildItem $check -Recurse -File | ForEach-Object {
                $rel = $_.FullName.Substring($check.Length + 1)
                if ((Get-FileHash $_.FullName -Algorithm SHA256).Hash -ne
                    (Get-FileHash (Join-Path $root $rel) -Algorithm SHA256).Hash) {
                    throw "内容不一致: $rel"
                }
            }
        }
        finally { if ($check) { Remove-Item $check -Recurse -Force } }
    }
    finally { if ($read) { $read.Dispose() } }

    Write-Host ("已生成: {0}" -f $zipPath)
    Write-Host ("版本: {0}  大小: {1:N0} 字节" -f $manifest.version, (Get-Item $zipPath).Length)
    $zipPath
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
