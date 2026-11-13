# 비서 폴더에서 Remote Control 서버 모드를 띄운다.
# 다른 기기(claude.ai/code, Claude 앱)의 세션 목록에서 이 폴더의 새 비서 세션을 열 수 있게 된다.
# 서버는 네트워크가 오래 끊기면 스스로 끝나므로, 끝나면 잠시 뒤 다시 띄운다.
# 로그인할 때 자동 실행: scripts/scheduled/install-scheduled-tasks.ps1 -Task server
# -Provider subscription-b: 계정 a 한도가 찼을 때 다른 구독(계정 b, 셋째 계정은 subscription-c로 '비서-c')으로 '비서-b' 서버를 따로 띄운다(기능 multi-subscription, 켜는 법은 feature-toggle 스킬).
# 계정마다 서버 창·서버가 따로라서 서로를 정리하지 않는다.
# 로그인 자동 실행·바탕화면 바로가기·다시 켜기는 모두 server-control.ps1 -Now로 이 창을 숨겨 띄운다. 창을 닫아 서버가 꺼지는 일이 없게 하려는 것.
# 창 보이기·숨기기, 다시 켜기, 기록 보기: scripts/remote-server/server-control.ps1

param([string]$Provider)

. "$PSScriptRoot\..\lib\common.ps1"
. "$PSScriptRoot\server-lib.ps1"
$null = Use-Utf8Console
Clear-HostClaudeEnv
$serverName = '비서'
if ($Provider) {
  . "$PSScriptRoot\..\lib\providers.ps1"
  # 설정 폴더(CLAUDE_CONFIG_DIR)와 SECRETARY_PROVIDER가 세션까지 물려져, 훅·정지 장치가 이 계정 기록을 본다.
  $null = Use-Provider $Provider
  $serverName = "비서-$($Provider -replace '^subscription-', '')"
}
# 원격 세션은 /chrome의 "기본으로 켜기"를 무시하고, 시작 환경의 이 변수로만 Claude in Chrome을 연결한다.
# 서버가 만드는 세션이 이 변수를 물려받아 이 PC의 크롬을 쓴다.
$env:CLAUDE_CODE_ENABLE_CFC = '1'
$claude = Get-ClaudeExe
Set-Location $SecretaryRoot

# 창이 없으니 이상 신호("Session failed", "already served" 등)를 나중에 볼 수 있게 서버 출력과 이 창의 안내를 계정별 폴더에 날짜별로 남긴다.
# 서버는 1초마다 상태 화면을 다시 그리므로, 제어 문자를 지우고 서버 한 번 사이에 이미 적은 줄은 건너뛴다. 창에도 같은 줄을 찍는다.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
namespace Secretary {
  public static class ServerLog {
    public static string Dir;
    // 창이 없어 켜졌는지 모르므로, 이 창에서 처음 연결될 때 한 번 알림(windows-toast.ps1)을 띄운다. 끊겼다 다시 붙을 때는 띄우지 않는다.
    public static string NotifyArgs;
    static int notified;
    static readonly Regex Connected = new Regex(@"\bConnected\b");
    static readonly object Gate = new object();
    static readonly Encoding Utf8 = new UTF8Encoding(false);
    static readonly Regex Link = new Regex(@"\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)");
    static readonly Regex Control = new Regex(@"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]");
    public static void Write(string line) {
      string stamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ");
      lock (Gate) {
        try { Console.WriteLine(stamp + line); } catch { }
        try { File.AppendAllText(Path.Combine(Dir, DateTime.Now.ToString("yyyy-MM-dd") + ".log"), stamp + line + Environment.NewLine, Utf8); } catch { }
      }
    }
    // 읽기가 멈추면 서버가 출력을 못 써서 같이 멈추므로, 따로 계속 읽는다.
    public static void Pump(StreamReader reader) {
      Thread thread = new Thread(() => {
        HashSet<string> seen = new HashSet<string>();
        try {
          for (string raw; (raw = reader.ReadLine()) != null; ) {
            string line = Control.Replace(Link.Replace(raw, "$1 "), "").Trim();
            if (line.Length > 0 && seen.Add(line)) Write(line);
            if (NotifyArgs != null && Connected.IsMatch(line) && Interlocked.Exchange(ref notified, 1) == 0) {
              try {
                System.Diagnostics.ProcessStartInfo notify = new System.Diagnostics.ProcessStartInfo("powershell.exe", NotifyArgs);
                notify.UseShellExecute = false;
                notify.CreateNoWindow = true;
                System.Diagnostics.Process.Start(notify);
              } catch { }
            }
          }
        } catch { }
      });
      thread.IsBackground = true;
      thread.Start();
    }
  }
}
'@
$logDir = Get-ServerLogDir $Provider
$null = New-Item -ItemType Directory -Force $logDir
[Secretary.ServerLog]::Dir = $logDir
[Secretary.ServerLog]::NotifyArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\windows-toast.ps1`" -Title `"$serverName`" -Text `"서버가 연결됐어요. 앱에서 새 세션을 열 수 있어요.`""
function Write-Log([string]$message) { [Secretary.ServerLog]::Write("[비서 서버] $message") }

# 예전 서버가 남아 있으면 새 서버가 "This folder is already served"로 거절당하므로 먼저 끈다.
# 그 서버가 띄운 세션까지 함께 끈다(/T).
function Stop-Leftover([string]$label, [scriptblock]$match) {
  $found = @(Get-WinProcess | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and (& $match $_) })
  foreach ($p in $found) {
    Write-Log "남아 있던 $label 정리 (PID $($p.ProcessId))"
    taskkill /T /F /PID $p.ProcessId 2>$null | Out-Null
  }
  foreach ($p in $found) { Wait-Process -Id $p.ProcessId -Timeout 15 -ErrorAction SilentlyContinue }
}
# 이 스크립트가 두 번 떠 있으면 서로 자리를 뺏으며 계속 실패한다.
Stop-Leftover '서버 창' { param($p) $p.Name -in 'powershell.exe', 'pwsh.exe' -and (Test-ServerScriptCommand $p.CommandLine) -and (Get-ArgProvider $p.CommandLine) -eq "$Provider" }

Add-Type -Namespace Secretary -Name ConsoleCtrl -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int std);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr handle, out uint mode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr handle, uint mode);
'@

# Ctrl+C로 끝난 서버는 바꿔 둔 콘솔 설정을 되돌리지 않아 한글이 "비비서서"처럼 겹쳐 찍힌다. 서버가 끝날 때마다 처음 설정으로 되돌린다.
$consoleModes = foreach ($std in -10, -11) {
  $handle = [Secretary.ConsoleCtrl]::GetStdHandle($std); $mode = 0
  if ([Secretary.ConsoleCtrl]::GetConsoleMode($handle, [ref]$mode)) { @{ Handle = $handle; Mode = $mode } }
}
function Restore-Console {
  foreach ($c in $consoleModes) { [Secretary.ConsoleCtrl]::SetConsoleMode($c.Handle, $c.Mode) | Out-Null }
  $null = Use-Utf8Console
}

# 서버 아래 떠 있는 비서 세션 수. 세션을 보관하면 그 프로세스도 같이 끝난다.
function Get-SessionCount([int]$serverPid) {
  @(Get-WinProcess -Filter "ParentProcessId=$serverPid" | Where-Object { $_.CommandLine -match '--sdk-url' }).Count
}

# 세션이 0개면 다른 기기에서는 서버가 오프라인으로 보여 새 세션을 못 연다. 서버는 켜질 때만 세션을 미리 만들므로 다시 켠다.
# 강제로 끄면 클라우드에 등록이 몇 분 남아 거절당하므로, Ctrl+C로 정상 종료시킨다(이 창은 그동안 Ctrl+C를 무시).
function Stop-ServerGracefully([Diagnostics.Process]$server) {
  [Secretary.ConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
  try {
    [Secretary.ConsoleCtrl]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
    if (-not $server.WaitForExit(30000)) { taskkill /T /F /PID $server.Id 2>$null | Out-Null; $server.WaitForExit() }
  } finally {
    [Secretary.ConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
  }
}

while ($true) {
  # 로그인 직후에는 네트워크가 아직 없어 서버가 미리 만드는 세션이 실패한다.
  while (-not (Test-NetConnection api.anthropic.com -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
    Write-Log '인터넷 연결을 기다리는 중…'
    Start-Sleep -Seconds 10
  }
  if (-not (Test-ClaudeLogin $claude)) {
    Write-Log 'Claude 로그인이 필요해요. 새 터미널에서 "claude auth login"을 실행하세요. 5분 뒤 다시 확인합니다.'
    Start-Sleep -Seconds 300
    continue
  }
  # 서버는 이 파일에 적힌 예전 세션을 다시 붙잡는데, 그 세션이 보관됐으면 바로 죽고 새 세션을 만들지 않는다.
  # 지우면 매번 새 세션을 미리 만든다.
  $configDir = Get-ClaudeConfigDir
  $pointer = Join-Path $configDir "projects\$((Get-Location).Path -replace '[:\\/]', '-')\bridge-pointer.json"
  Remove-Item $pointer -ErrorAction SilentlyContinue
  Stop-Leftover '비서 서버' { param($p) $p.Name -eq 'claude.exe' -and $p.CommandLine -match '\sremote-control\s' -and $p.CommandLine -match "--name\s+$([regex]::Escape($serverName))(\s|$)" }
  # 의미 검색 서버(모델 약 1GB)를 이 창에 묶어 띄운다. 창이 살아 있는 동안 계속 떠 있고, 창이 꺼지면 30초 안에 따라 꺼진다.
  # 이미 떠 있으면 의미 검색 서버가 알아서 그냥 끝나므로 매번 불러도 된다(의미 검색 서버가 죽었을 때 다시 살리는 역할).
  Start-Process (Get-Command node).Source -ArgumentList 'src/cli.ts', 'semantic-search-server', '--parent', $PID -WindowStyle Hidden
  # 대시보드(기능 dashboard: 상태 화면과 결과물 읽기 전용 보기)도 같은 규칙으로 계정 a 서버 창에 묶는다. 기능이 꺼져 있거나 이미 떠 있으면 스스로 바로 끝난다.
  # 주소·포트는 이 비서 설정 this-secretary.local.json의 dashboard 키(src/dashboard/settings.ts).
  if (-not $Provider) { Start-Process (Get-Command node).Source -ArgumentList '--no-warnings', 'bin/dashboard.mjs', 'serve', '--parent', $PID -WindowStyle Hidden }
  # 사용량 조회기(기능 usage-poll: 고른 공급자 사용량을 5분마다, 토큰 0)도 같은 규칙으로 계정 a 서버 창에 묶는다. 기능이 꺼져 있거나 이 PC에서 이미 돌고 있으면 스스로 바로 끝난다.
  # 고를 공급자는 this-secretary.local.json의 usage-poll 키(src/usage/usage-settings.ts).
  if (-not $Provider) { Start-Process (Get-Command node).Source -ArgumentList '--no-warnings', 'src/cli.ts', 'usage-poll', '--parent', $PID -WindowStyle Hidden }
  # 기록은 최근 14일 치만 둔다.
  Get-ChildItem $logDir -Filter *.log | Sort-Object Name -Descending | Select-Object -Skip 14 | Remove-Item -ErrorAction SilentlyContinue
  Write-Log '서버 시작'
  # 서버 출력은 화면 대신 위 기록으로 받는다. 서버는 이 창의 콘솔을 같이 쓰므로 Ctrl+C 정상 종료는 그대로 된다.
  $start = New-Object Diagnostics.ProcessStartInfo $claude, "remote-control --name $serverName --permission-mode auto"
  $start.UseShellExecute = $false
  $start.WorkingDirectory = (Get-Location).Path
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.Encoding]::UTF8
  $start.StandardErrorEncoding = [Text.Encoding]::UTF8
  $server = [Diagnostics.Process]::Start($start)
  [Secretary.ServerLog]::Pump($server.StandardOutput)
  [Secretary.ServerLog]::Pump($server.StandardError)
  $emptySince = $null
  $restarting = $false
  # 1분마다 세션 수를 센다. 두 번 연달아 0개면(1분 넘게 0개) 다시 켠다.
  # 0개가 된 뒤 4~5분이면 다른 기기에서 새 세션을 못 열게 되므로 그보다 일찍 잡는다.
  $checkMinutes = 1
  while (-not $server.WaitForExit($checkMinutes * 60000)) {
    if ((Get-SessionCount $server.Id) -gt 0) { $emptySince = $null; continue }
    if (-not $emptySince) { $emptySince = Get-Date; continue }
    Write-Log "비서 세션이 ${checkMinutes}분 넘게 0개라 새 세션을 만들려고 서버를 다시 켭니다."
    Stop-ServerGracefully $server
    $restarting = $true
  }
  Restore-Console
  if ($restarting) { continue }
  Write-Log "서버 종료(코드 $($server.ExitCode)). 30초 뒤 다시 시작합니다."
  Start-Sleep -Seconds 30
}
