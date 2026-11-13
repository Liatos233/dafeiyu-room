param(
  [string]$Query = "thunder",
  [int]$Max = 6
)
$ErrorActionPreference = "Stop"
$proxy = "http://127.0.0.1:18809"
$base = "https://opengameart.org"
$enc = [uri]::EscapeDataString($Query)
$searchUrl = "$base/art-search-advanced?keys=$enc&field_art_type_tid%5B%5D=13&sort_by=count&sort_order=DESC"

$html = (Invoke-WebRequest -UseBasicParsing -Uri $searchUrl -Proxy $proxy -TimeoutSec 30).Content
$links = [regex]::Matches($html, 'href="(/content/[^"#?]+)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique

Write-Host "search '$Query' -> $($links.Count) pages"
$found = 0
foreach ($l in $links) {
  if ($found -ge $Max) { break }
  try {
    $page = (Invoke-WebRequest -UseBasicParsing -Uri ($base + $l) -Proxy $proxy -TimeoutSec 30).Content
  } catch { continue }
  $isCc0 = $page -match 'CC0' -or $page -match 'Public Domain'
  if (-not $isCc0) { continue }
  $files = [regex]::Matches($page, 'href="(https?://[^"]+?/sites/default/files/[^"]+\.(ogg|wav|mp3|flac))"') |
    ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
  if (-not $files) { continue }
  Write-Host "`n[$l] CC0"
  foreach ($f in $files) { Write-Host "   $f" }
  $found += 1
}
