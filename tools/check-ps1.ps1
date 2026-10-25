# Adds a UTF-8 BOM to secretary/scripts/*.ps1 (PowerShell 5.1 needs it to read Korean text) and syntax-checks each with the 5.1 parser.
# ASCII only on purpose: this file itself has no BOM.
param([Parameter(Mandatory)] [string]$Dir)
$utf8Bom = New-Object Text.UTF8Encoding $true
$bad = 0
foreach ($f in Get-ChildItem -Path $Dir -Filter *.ps1) {
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  if (-not $hasBom) {
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    [IO.File]::WriteAllText($f.FullName, $text, $utf8Bom)
  }
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
  $state = if ($errors.Count) { $bad++; "ERRORS $($errors.Count): $($errors[0].Message)" } else { 'parse OK' }
  Write-Output ("{0} | BOM {1} | {2}" -f $f.Name, $(if ($hasBom) { 'already' } else { 'added' }), $state)
}
Write-Output "PowerShell $($PSVersionTable.PSVersion) - files with parse errors: $bad"
exit $bad
