# MyTube headless backend tray app.
# Runs at user logon via scheduled task "MyTubeHeadlessServer". Shows a tray
# icon, keeps the bundled backend alive, and stands down automatically while
# the desktop app owns port 5551 (its lifecycle hands the task /end //run).
# Single instance: named mutex; late launches exit silently.

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$MyTubeHome = Join-Path $env:APPDATA 'MyTube\server-home'
$DesktopRes = 'D:\MyTube\desktop\release\win-unpacked\resources'
$NodeExe = Join-Path $DesktopRes 'bin\node.exe'
$Entry = Join-Path $DesktopRes 'server\dist\src\server.js'
$Port = 5551
$RestartDelayMs = 15000
$LogPath = Join-Path $MyTubeHome 'backend.log'
$IconColorPath = Join-Path $PSScriptRoot 'mytube.ico'
$IconGrayPath = Join-Path $PSScriptRoot 'mytube-gray.ico'
$IconColorPathPng = Join-Path $PSScriptRoot 'tray-color.png'
$IconGrayPathPng = Join-Path $PSScriptRoot 'tray-gray.png'

$script:mutex = New-Object System.Threading.Mutex($false, 'Global\MyTubeHeadlessTray')
if (-not $script:mutex.WaitOne(0)) { exit 0 }

if (-not (Test-Path $MyTubeHome)) { New-Item -ItemType Directory -Path $MyTubeHome -Force | Out-Null }

$env:NODE_ENV = 'production'
$env:MYTUBE_ADMIN_TRUST_LEVEL = 'application'
$env:YT_DLP_PATH = Join-Path $DesktopRes 'bin\yt-dlp.exe'
$env:YT_DLP_JS_RUNTIME = 'node'
$env:PATH = "$DesktopRes\bin;$env:PATH"
$jwtPath = Join-Path $MyTubeHome '.jwt-secret'
if (Test-Path $jwtPath) { $env:JWT_SECRET = (Get-Content $jwtPath -Raw).Trim() }

function Write-Log([string]$line) {
  try {
    [System.IO.File]::AppendAllText($LogPath, "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [tray] $line`r`n")
  } catch { }
}

function Test-PortBusy {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $Port)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

$script:Proc = $null
$script:DesiredRunning = $true
$script:LastStartMs = 0
$script:IconGreen = $null
$script:IconGray = $null
$script:LogLock = New-Object object

function Append-Log([string]$text) {
  [System.Threading.Monitor]::Enter($script:LogLock)
  try {
    [System.IO.File]::AppendAllText($LogPath, $text)
  } catch { }
  [System.Threading.Monitor]::Exit($script:LogLock)
}

function Start-Backend {
  $cmdLine = "`"$NodeExe`" `"$Entry`" >> `"$LogPath`" 2>&1"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:ComSpec"
  $psi.Arguments = "/d /s /c `"$cmdLine`""
  $psi.WorkingDirectory = $MyTubeHome
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:Proc = [System.Diagnostics.Process]::Start($psi)
  $script:LastStartMs = [DateTime]::UtcNow.Ticks
  Write-Log "backend started (cmd pid $($script:Proc.Id))"
}

function Stop-Backend {
  if ($script:Proc -ne $null -and -not $script:Proc.HasExited) {
    try {
      Start-Process -FilePath taskkill -ArgumentList "/F /T /PID $($script:Proc.Id)" -WindowStyle Hidden -Wait
    } catch { }
  }
  $script:Proc = $null
}

function Load-Icon([string]$preferred, [string]$fallback) {
  $path = if (Test-Path $preferred) { $preferred } else { $fallback }
  if (Test-Path $path) {
    $bmp = New-Object System.Drawing.Bitmap($path)
    $hicon = $bmp.GetHicon()
    return [System.Drawing.Icon]::FromHandle($hicon)
  }
  return [System.Drawing.Icon]::ExtractAssociatedIcon("$env:ComSpec")
}

$script:IconGreen = Load-Icon $IconColorPathPng $IconColorPath
$script:IconGray = Load-Icon $IconGrayPathPng $IconGrayPath

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $script:IconGray
$notifyIcon.Text = 'MyTube'
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem('打开 MyTube（浏览器）')
$itemOpen.Add_Click({
  try { [System.Diagnostics.Process]::Start("http://localhost:$Port") } catch { }
})
$menu.Items.Add($itemOpen) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem('服务状态：启动中…')
$itemStatus.Enabled = $false
$menu.Items.Add($itemStatus) | Out-Null
$itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem('重启服务')
$itemRestart.Add_Click({
  Write-Log 'manual restart requested'
  Stop-Backend
})
$menu.Items.Add($itemRestart) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem('停止服务并退出')
$itemExit.Add_Click({
  Write-Log 'exit requested from tray'
  $script:DesiredRunning = $false
  Stop-Backend
  $notifyIcon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($itemExit) | Out-Null
$notifyIcon.ContextMenuStrip = $menu

if (Test-PortBusy) {
  $notifyIcon.ShowBalloonTip(4000, 'MyTube', '端口已被桌面版占用，托盘进入待机。', [System.Windows.Forms.ToolTipIcon]::Info)
} else {
  Start-Backend
  $notifyIcon.ShowBalloonTip(4000, 'MyTube', '服务已随登录启动。', [System.Windows.Forms.ToolTipIcon]::Info)
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  try {
    $busy = Test-PortBusy
    $procAlive = ($script:Proc -ne $null -and -not $script:Proc.HasExited)

    if ($busy) {
      # Desktop app (or anything else) owns the port: stand by, no backend.
      if ($procAlive) { Stop-Backend }
      $notifyIcon.Icon = $script:IconGray
      $itemStatus.Text = '服务状态：由桌面版运行中'
      $notifyIcon.Text = 'MyTube - 由桌面版运行'
      return
    }

    if (-not $script:DesiredRunning) {
      $notifyIcon.Icon = $script:IconGray
      $itemStatus.Text = '服务状态：已停止'
      $notifyIcon.Text = 'MyTube - 已停止'
      return
    }

    if ($procAlive) {
      $notifyIcon.Icon = $script:IconGreen
      $itemStatus.Text = '服务状态：运行中'
      $notifyIcon.Text = 'MyTube - 运行中'
      return
    }

    # Backend dead and port free: supervise a restart (rate limited).
    $nowTicks = [DateTime]::UtcNow.Ticks
    if (($nowTicks - $script:LastStartMs) -lt ($RestartDelayMs * 10000)) { return }
    Write-Log 'supervision: backend not running, restarting'
    Start-Backend
    $notifyIcon.Icon = $script:IconGreen
    $itemStatus.Text = '服务状态：启动中…'
  } catch {
    Write-Log "tick error: $($_.Exception.Message)"
  }
})
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  if ($script:DesiredRunning) {
    # Leaving the loop without a user stop (e.g. logoff): keep the backend.
  }
  try { $notifyIcon.Visible = $false } catch { }
  $script:mutex.ReleaseMutex()
}
