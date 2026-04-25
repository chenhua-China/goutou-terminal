# release.ps1 - 构建并上传到 GitHub Releases
# 用法: .\release.ps1 -Version "1.0.1" -Token "ghp_xxx"

param(
    [string]$Version = "1.0.0",
    [string]$Token = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# 检查 gh CLI
$hasGh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $hasGh) {
    Write-Host "❌ 需要 GitHub CLI (gh)。请先安装: https://cli.github.com/" -ForegroundColor Red
    exit 1
}

# 认证检查
gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 未登录 GitHub。请先运行: gh auth login" -ForegroundColor Red
    exit 1
}

# 构建
if (-not $SkipBuild) {
    Write-Host "`n🔨 开始构建..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 构建失败" -ForegroundColor Red
        exit 1
    }
}

# 检查 dist 目录
$installer = Get-ChildItem "dist\*.exe" -ErrorAction SilentlyContinue
if (-not $installer) {
    Write-Host "❌ 未找到安装包 (dist\*.exe)" -ForegroundColor Red
    exit 1
}

Write-Host "`n📦 找到安装包:" -ForegroundColor Cyan
$installer | ForEach-Object { Write-Host "  $($_.Name) ($([math]::Round($_.Length/1MB, 2)) MB)" }

# 创建/更新 Release
$tag = "v$Version"
Write-Host "`n🚀 上传到 GitHub Releases ($tag)..." -ForegroundColor Cyan

# 检查 release 是否已存在
$exists = gh release view $tag 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "⚠️  Release $tag 已存在，将添加文件..." -ForegroundColor Yellow
    gh release upload $tag $installer.FullName --clobber
} else {
    gh release create $tag $installer.FullName --title "v$Version" --generate-notes
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ 发布成功!" -ForegroundColor Green
    Write-Host "📎 https://github.com/chenhua-China/goutou-terminal/releases/tag/$tag" -ForegroundColor Cyan
} else {
    Write-Host "`n❌ 上传失败" -ForegroundColor Red
    exit 1
}
