<#
.SYNOPSIS
    打包扩展为可上传到 Chrome Web Store 的 zip。

.DESCRIPTION
    实际打包逻辑在 build-store-package.ps1，本脚本提供 Chrome 专用的命令入口。
    输出 dist/tab-box-<version>-chrome-store.zip，manifest.json 位于 zip 根目录。

.PARAMETER OutputDirectory
    输出目录，默认 dist。

.EXAMPLE
    pwsh -File scripts/build-chrome-package.ps1
#>
param(
    [string]$OutputDirectory = 'dist'
)

& (Join-Path $PSScriptRoot 'build-store-package.ps1') -Browser Chrome -OutputDirectory $OutputDirectory
