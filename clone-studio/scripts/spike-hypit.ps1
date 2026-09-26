# Phase 0 验证一：hypit 全链路命令序列（check -> plan -> pricing -> build --follow -> get）
#
# 载体是 hypit-main/examples/complex-explainer：它的 render.svrun 用 build-record + satisfy
# 复用已有产物，只跑本地渲染与 mux，不调用任何付费 Provider，因此可以零花费跑通全链路。
#
# 用法（在仓库根执行）：
#   powershell -File clone-studio/scripts/spike-hypit.ps1 -Workspace <一个可写的空目录>
#
# 注意：本机只有 Windows PowerShell 5.1，其 Set-Content -Encoding utf8 会写 BOM，
# 会让 node 解析 hypit.runtime.json 失败，故写文件统一走 UTF8Encoding($false)。
#
# 脚本不修改 hypit-main/：它把 example 复制到 -Workspace 再操作。

[CmdletBinding()]
param(
    # spike 工作区。example 副本、455 MiB 媒体包与 build 状态都落在这里。
    [Parameter(Mandatory = $true)]
    [string]$Workspace,

    # Hypit 发行版目录，留空则取仓库内的只读副本。
    # 注意：PS 5.1 下 $PSScriptRoot 在 param 默认值里是空的，必须在函数体内解析。
    [string]$Distribution = '',

    # 渲染并发。本机实测：8 workers 在可用内存约 4.7 GB 时 SQLite 报 out of memory，
    # 2 workers 渲染进程 ACCESS_VIOLATION（3221225477），1 worker 稳定通过。
    [int]$Workers = 1
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Distribution)) {
    $Distribution = (Resolve-Path (Join-Path $PSScriptRoot '..\..\hypit-main')).Path
}
$hypit = Join-Path $Distribution 'bin\hypit.mjs'
$example = Join-Path $Distribution 'examples\complex-explainer'
$mediaUrl = 'https://storage.googleapis.com/hypit-public-assets/assets/examples/complex-explainer/v1/20260914/media.tar.gz'

function Invoke-Hypit {
    param([string[]]$Arguments, [string]$WorkingDirectory)
    Write-Host "`n> node hypit.mjs $($Arguments -join ' ')" -ForegroundColor Cyan
    Push-Location $WorkingDirectory
    try { & node $hypit @Arguments } finally { Pop-Location }
}

# 0. 准备工作区副本（hypit-main 保持只读）
if (-not (Test-Path $Workspace)) { New-Item -ItemType Directory -Path $Workspace -Force | Out-Null }
$project = Join-Path $Workspace 'complex-explainer'
if (-not (Test-Path $project)) {
    Copy-Item -Path $example -Destination $project -Recurse
}
Push-Location $project
try {
    npm ci --ignore-scripts

    # 媒体包：50 个已接受 Output 的资源文件，约 455 MiB，Git 之外单独分发
    $archive = Join-Path $project '.hypit\media.tar.gz'
    # 解包标记不能用 .hypit\execution —— 那是 hypit 自己会建的目录，用它当标记会误判成已解包。
    # 改用媒体包里必然存在的一个资源文件。
    $mediaMarker = Join-Path $project 'productions\explainer\assets\brand\hypit-logo-ink.png'
    if (-not (Test-Path $mediaMarker)) {
        New-Item -ItemType Directory -Path (Join-Path $project '.hypit') -Force | Out-Null
        if (-not (Test-Path $archive)) {
            curl.exe --fail --location $mediaUrl --output $archive
        }
        # 必须显式用系统 bsdtar：PATH 里若有 Git for Windows 的 GNU tar，
        # 它会把 'X:\...' 当成 host:path 的远程规格，报 "Cannot connect to X"。
        & "$env:SystemRoot\System32\tar.exe" -xzf $archive
    }

    # 按本机内存调低渲染并发
    $profilePath = Join-Path $project 'hypit.runtime.json'
    $profile = Get-Content $profilePath -Raw | ConvertFrom-Json
    $profile.endpoints.'hyperframes.local'.config.workers = $Workers
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($profilePath, ($profile | ConvertTo-Json -Depth 10), $utf8NoBom)

    # 只渲染第一段（900 帧 / 30 秒），整片 4112 帧在本机内存下不稳
    $partsRun = Join-Path $project 'productions\explainer\runs\export-parts.svrun'
    $spikeRun = Join-Path $project 'productions\explainer\runs\spike-one-part.svrun'
    if (-not (Test-Path $spikeRun)) {
        $kept = $false
        $lines = foreach ($line in (Get-Content $partsRun)) {
            if ($line -match '<target output=') {
                if (-not $kept) { $kept = $true; $line }
                continue
            }
            $line
        }
        [System.IO.File]::WriteAllText($spikeRun, ($lines -join "`r`n"), $utf8NoBom)
    }
}
finally { Pop-Location }

$production = Join-Path $project 'productions\explainer'
$runArg = 'runs\spike-one-part.svrun'
$runtimeArg = '..\..\hypit.runtime.json'

# 1. check：只读校验 Source，能独立于 Runtime 跑
Invoke-Hypit -Arguments @('check', $runArg, '--json') -WorkingDirectory $production

# 2. runtime up：准备本地程序（首次会装 Chrome Headless Shell）
Invoke-Hypit -Arguments @('runtime', 'up', '--runtime', $runtimeArg) -WorkingDirectory $production

# 3. plan：解析每个请求落到哪个 Endpoint，并带 preflight 体检
Invoke-Hypit -Arguments @('plan', $runArg, '--runtime', $runtimeArg, '--json') -WorkingDirectory $production

# 4. pricing：只读网络操作，读各 Provider 公布的价格材料
Invoke-Hypit -Arguments @('pricing', $runArg, '--runtime', $runtimeArg, '--json') -WorkingDirectory $production

# 5. build --follow：提交 Build 并跟随执行
Invoke-Hypit -Arguments @('build', $runArg, '--runtime', $runtimeArg, '--follow', '--json') -WorkingDirectory $production

# 6. get：导出 Output 成 mp4（build id 见上一步 JSON 的 build.id）
Write-Host "`n下一步：用上一步返回的 build.id 导出成片" -ForegroundColor Yellow
Write-Host "  node `"$hypit`" get <build-id> --output export-part-1.video --to <目标.mp4> --json"
