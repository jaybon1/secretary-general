# Zips <Source> into <Zip> with entries under "secretary/", leaving out node_modules, databases, backups, model downloads, keys, *.local.* and .git.
# Then lists the zip and fails if any excluded thing slipped in. ASCII only on purpose (no BOM).
param([Parameter(Mandatory)] [string]$Source, [Parameter(Mandatory)] [string]$Zip)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = (Resolve-Path $Source).Path.TrimEnd('\')
$excluded = '(^|/)(node_modules|backups|models|\.git|keys)(/|$)|\.db(-wal|-shm|-journal)?$|\.embedder\.json$|\.local\.|\.env$'
if (Test-Path $Zip) { Remove-Item $Zip }
$archive = [IO.Compression.ZipFile]::Open($Zip, 'Create')
try {
  foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -Force) {
    $rel = $f.FullName.Substring($root.Length + 1) -replace '\\', '/'
    if ($rel -match $excluded) { continue }
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, "secretary/$rel", 'Optimal')
  }
} finally { $archive.Dispose() }
$read = [IO.Compression.ZipFile]::OpenRead($Zip)
try { $names = @($read.Entries | ForEach-Object FullName) } finally { $read.Dispose() }
$leaks = @($names | Where-Object { $_ -match $excluded })
$names
Write-Output "entries: $($names.Count), excluded-pattern hits: $($leaks.Count), size: $((Get-Item $Zip).Length) bytes"
if ($leaks.Count) { $leaks; exit 1 }
