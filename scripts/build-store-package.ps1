<#
.SYNOPSIS
    打包扩展为可上传到 Chrome Web Store 或 Microsoft Edge 加载项商店的 zip。

.DESCRIPTION
    商店要求 zip 的根目录直接是 manifest.json，而 GitHub Release 里的本地安装包
    外面套了一层 tab-box/，直接上传会报「找不到 manifest.json」。
    本脚本只放运行时需要的文件，入口条目使用正斜杠、不带顶层文件夹。

    Chrome 与 Edge 都使用 Chromium 的 MV3 包结构，因此两个商店包内容一致，
    只是文件名不同，方便分别上传到对应后台。

.PARAMETER Browser
    Chrome、Edge 或 Both，默认 Both。

.PARAMETER OutputDirectory
    输出目录，默认 dist。

.EXAMPLE
    pwsh -File scripts/build-store-package.ps1 -Browser Chrome

.EXAMPLE
    pwsh -File scripts/build-store-package.ps1 -Browser Both
#>
param(
    [ValidateSet('Chrome', 'Edge', 'Both')]
    [string]$Browser = 'Both',

    [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

$files = @(
    'manifest.json',
    'background.js',
    'popup.html',
    'popup.css',
    'popup.js',
    'quick-search.js',
    'quick-search.css',
    'quick-search.html',
    'LICENSE'
)
$dirs = @('icons', '_locales')

$targets = switch ($Browser) {
    'Both' { @('Chrome', 'Edge') }
    default { @($Browser) }
}

$outDir = Join-Path $root $OutputDirectory
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$tempRoot = [System.IO.Path]::GetTempPath()

foreach ($target in $targets) {
    $stage = Join-Path $tempRoot ("tabbox-stage-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        Copy-Item ($files | ForEach-Object { Join-Path $root $_ }) -Destination $stage
        Copy-Item ($dirs | ForEach-Object { Join-Path $root $_ }) -Destination $stage -Recurse

        $suffix = $target.ToLowerInvariant()
        $zipPath = Join-Path $outDir ("tab-box-{0}-{1}-store.zip" -f $manifest.version, $suffix)
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
            $check = Join-Path $tempRoot ("tabbox-check-" + [guid]::NewGuid().ToString('N'))
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

        Write-Host ("已生成 {0} 商店包: {1}" -f $target, $zipPath)
        Write-Host ("版本: {0}  大小: {1:N0} 字节" -f $manifest.version, (Get-Item $zipPath).Length)
        Write-Output $zipPath
    }
    finally {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
