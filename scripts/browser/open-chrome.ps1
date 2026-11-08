# 브라우저 작업용 크롬 프로필 창을 연다. Claude in Chrome이 연결돼 있지 않을 때 비서가 쓴다.
# 프로필은 크롬에 보이는 이름으로 찾는다 (폴더 이름 "Profile 1" 같은 건 PC마다 다르다).
# 이미 그 프로필 창이 열려 있으면 크롬은 새 창만 하나 더 띄우므로, 연결이 안 됐을 때만 부른다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/browser/open-chrome.ps1 -ProfileName <프로필 이름>

param(
  [Parameter(Mandatory)] [string]$ProfileName
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\lib\common.ps1"
$null = Use-Utf8Console

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw '크롬을 찾지 못했어요.' }

# ConvertFrom-Json(5.1)은 대소문자만 다른 키가 있는 Local State를 읽지 못해서 JavaScriptSerializer를 쓴다.
Add-Type -AssemblyName System.Web.Extensions
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue
$state = $json.DeserializeObject((Get-Content "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State" -Raw -Encoding UTF8))
$profiles = $state['profile']['info_cache']
$dir = $profiles.Keys | Where-Object { $profiles[$_]['name'] -eq $ProfileName } | Select-Object -First 1
if (-not $dir) { throw "크롬 프로필 '$ProfileName'을 찾지 못했어요. 있는 프로필: $(($profiles.Values | ForEach-Object { $_['name'] }) -join ', ')" }

Start-Process $chrome -ArgumentList "--profile-directory=`"$dir`""
Write-Host "크롬 '$ProfileName' 프로필($dir) 창을 열었어요."
