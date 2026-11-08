# 화면 오른쪽 아래에 Windows 알림을 띄운다. 창 없이 뜨는 비서 서버가 켜졌는지 알 수 있게 한다.
# 설치 없이 Windows 알림 기능(WinRT)을 쓰고, 보내는 앱 이름은 Windows PowerShell로 나온다.
# 예: powershell -NoProfile -File scripts/server/notify.ps1 -Title '비서-b' -Text '켜는 중이에요.'

param(
  [Parameter(Mandatory)] [string]$Title,
  [string]$Text = ''
)

$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$escape = { param($s) [Security.SecurityElement]::Escape($s) }
$xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$(& $escape $Title)</text><text>$(& $escape $Text)</text></binding></visual></toast>")
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
