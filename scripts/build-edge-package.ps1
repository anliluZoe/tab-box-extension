<#
.SYNOPSIS
    打包扩展为可上传到 Microsoft Edge 加载项商店（Partner Center）的 zip。

.DESCRIPTION
    实际打包逻辑在 build-store-package.ps1，本脚本保留旧的命令入口。
    输出 dist/tab-box-<version>-edge-store.zip，manifest.json 位于 zip 根目录。

.PARAMETER OutputDirectory
    输出目录，默认 dist。

.EXAMPLE
    pwsh -File scripts/build-edge-package.ps1
#>
param(
    [string]$OutputDirectory = 'dist'
)

& (Join-Path $PSScriptRoot 'build-store-package.ps1') -Browser Edge -OutputDirectory $OutputDirectory
