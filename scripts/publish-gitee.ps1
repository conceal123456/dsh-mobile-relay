<#
.SYNOPSIS
    在 Gitee 上自动建仓并完成推送（一条命令闭环）。

.DESCRIPTION
    1. 校验私人令牌
    2. 仓库不存在则创建（Gitee 空仓库只能是私有，推送后再改公开）
    3. 添加 gitee 远程并推送当前分支到 master
    4. 回写描述 / 主页 / 可见性
    5. 输出仓库地址

.PARAMETER Name
    仓库名（默认取当前目录名）

.PARAMETER Description
    仓库简介

.PARAMETER Token
    Gitee 私人令牌，留空则读环境变量 GITEE_TOKEN

.PARAMETER Homepage
    可选的主页地址（例如 GitHub 镜像地址）

.PARAMETER Public
    推送完成后设为公开仓库

.EXAMPLE
    $env:GITEE_TOKEN="xxxx"
    .\scripts\publish-gitee.ps1 -Name dsh-mobile-relay -Description "一键把 DSH 接到手机" -Public
#>
param(
    [string]$Name = "",
    [string]$Description = "",
    [string]$Token = "",
    [string]$Homepage = "",
    [switch]$Public,
    [string]$Path = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Token)) { $Token = $env:GITEE_TOKEN }
if ([string]::IsNullOrWhiteSpace($Token)) { throw "缺少 Gitee 私人令牌：-Token 或环境变量 GITEE_TOKEN" }
if ([string]::IsNullOrWhiteSpace($Path)) { $Path = (Get-Location).Path }
if ([string]::IsNullOrWhiteSpace($Name)) { $Name = Split-Path $Path -Leaf }

function Invoke-Gitee {
    param([string]$Method, [string]$Uri, $Body, [switch]$Raw)
    $reqArgs = @{ Method = $Method; Uri = $Uri; UseBasicParsing = $true }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Compress
        $reqArgs.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
        $reqArgs.ContentType = "application/json; charset=utf-8"
    }
    try {
        $resp = Invoke-WebRequest @reqArgs
        if ($Raw) { return $resp }
        $text = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return $text | ConvertFrom-Json
    } catch {
        return @{ __error = $_.Exception.Message; __detail = $_.ErrorDetails.Message }
    }
}

Write-Host "==> 校验令牌" -ForegroundColor Cyan
$user = Invoke-Gitee -Method Get -Uri "https://gitee.com/api/v5/user?access_token=$Token"
if ($user.__error) { throw "令牌无效：$($user.__detail)" }
$owner = $user.login
Write-Host "    账号：$owner"

Write-Host "==> 检查仓库 $owner/$Name" -ForegroundColor Cyan
$repo = Invoke-Gitee -Method Get -Uri "https://gitee.com/api/v5/repos/$owner/$Name`?access_token=$Token"
$created = $false
if ($repo.__error) {
    Write-Host "    不存在，创建中（Gitee 空仓库默认私有）"
    $repo = Invoke-Gitee -Method Post -Uri "https://gitee.com/api/v5/user/repos?access_token=$Token" -Body @{
        name = $Name; description = $Description; private = $true; has_issues = $true; has_wiki = $true; auto_init = $false
    }
    if ($repo.__error) { throw "创建失败：$($repo.__detail)" }
    $created = $true
    Write-Host "    已创建：$($repo.full_name)"
} else {
    Write-Host "    已存在：$($repo.full_name)"
}

Write-Host "==> 推送代码" -ForegroundColor Cyan
Push-Location $Path
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $remotes = git remote
    if ($remotes -notcontains "gitee") {
        git remote add gitee "https://gitee.com/$owner/$Name.git" 2>&1 | Out-Null
    } else {
        git remote set-url gitee "https://gitee.com/$owner/$Name.git" 2>&1 | Out-Null
    }
    $branch = (git branch --show-current).Trim()
    if ([string]::IsNullOrWhiteSpace($branch)) { throw "当前目录不是 git 仓库或处于游离 HEAD" }
    Write-Host "    $branch -> master"
    git push gitee "${branch}:master" 2>&1 | Out-Host
    $pushCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevEap
    Pop-Location
}
if ($pushCode -ne 0) { throw "推送失败（检查凭据管理器里 gitee.com 的账号密码/令牌）" }

Write-Host "==> 回写仓库信息" -ForegroundColor Cyan
$patch = @{ name = $Name; description = $Description; has_issues = $true; has_wiki = $true }
if ($Homepage) { $patch.homepage = $Homepage }
if ($Public) { $patch.private = $false }

# Gitee 对刚推送完的仓库有短暂延迟：此时改公开会报“空仓库不支持设置为公开仓库”，重试几次即可
$updated = $null
for ($i = 1; $i -le 8; $i++) {
    $updated = Invoke-Gitee -Method Patch -Uri "https://gitee.com/api/v5/repos/$owner/$Name?access_token=$Token" -Body $patch
    if (-not $updated.__error) { break }
    if ($i -lt 8) { Start-Sleep -Seconds 5 }
}
if ($updated.__error) {
    Write-Warning "元数据更新失败：$($updated.__detail)"
} else {
    Write-Host "    描述/主页已更新"
    if ($Public -and $updated.private -eq $true) {
        Write-Warning "仓库仍为私有：可稍后重跑本脚本（只做 PATCH，不会重复建仓）"
    }
}

Write-Host ""
Write-Host "完成：https://gitee.com/$owner/$Name" -ForegroundColor Green
if ($created) { Write-Host "（新建仓库首次推送后，如仍显示私有，可重跑本脚本或到网页改为公开）" }
