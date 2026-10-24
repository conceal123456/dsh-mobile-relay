<#
.SYNOPSIS
    Windows 一键启动 dsh-mobile-relay

.DESCRIPTION
    检查 Node、安装依赖、启动中继，并把配对信息写到当前目录。

.EXAMPLE
    .\scripts\start.ps1
    .\scripts\start.ps1 -RelayPort 3453
#>
param(
    [int]$HarnessPort = 0,
    [int]$RelayPort = 0,
    [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

Write-Step "检查 Node.js"
try { $v = (node --version) } catch { throw "未找到 Node.js，请先安装 18.17+：https://nodejs.org" }
$major = [int]($v.TrimStart("v").Split(".")[0])
if ($major -lt 18) { throw "Node.js 版本过低（$v），需要 18.17 或更高" }
Write-Host "    Node $v"

if ($HarnessPort -gt 0) { $env:DSH_HARNESS_PORT = "$HarnessPort" }
if ($RelayPort -gt 0) { $env:DSH_RELAY_PORT = "$RelayPort" }
if ($DshHome -ne "") { $env:DSH_HOME = $DshHome }

if (-not (Test-Path "node_modules")) {
    Write-Step "安装依赖（首次需要几十秒）"
    npm install --no-audit --no-fund
}

Write-Step "启动中继（Ctrl+C 退出）"
Write-Host ""
npm start
