# ============================================================
# CageTrack — local preview server (no Python/Node needed)
# Just double-click this file, or run:  powershell -File dev-server.ps1
# Then open http://localhost:5522 in your browser.
# This is ONLY for local previewing. For real hosting use VS Code
# Live Server, GitHub Pages, or any static web host.
# ============================================================

$root = $PSScriptRoot                       # serve this folder (CageTrack)
$port = 5522
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
$listener.Start()
Write-Host "CageTrack preview running at http://localhost:$port  (Ctrl+C to stop)"

$mime = @{
  ".html"="text/html"; ".css"="text/css"; ".js"="application/javascript";
  ".json"="application/json"; ".png"="image/png"; ".svg"="image/svg+xml";
  ".ico"="image/x-icon"; ".csv"="text/csv"; ".avif"="image/avif";
  ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"; ".webp"="image/webp"
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 3000               # don't let idle connections block the server
    $reader = New-Object System.IO.StreamReader($stream)
    $requestLine = $null
    try { $requestLine = $reader.ReadLine() } catch { $client.Close(); continue }
    if (-not $requestLine) { $client.Close(); continue }
    $path = (($requestLine -split ' ')[1] -split '\?')[0]
    if ($path -eq '/') { $path = '/index.html' }
    $path = [System.Uri]::UnescapeDataString($path)
    $file = Join-Path $root ($path.TrimStart('/').Replace('/','\'))
    if (Test-Path $file -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $ct = $mime[$ext]; if (-not $ct) { $ct = "application/octet-stream" }
      $header = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
      $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($hb,0,$hb.Length); $stream.Write($bytes,0,$bytes.Length)
    } else {
      $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
      $header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($hb,0,$hb.Length); $stream.Write($body,0,$body.Length)
    }
    $stream.Flush()
  } catch {} finally { try { $client.Close() } catch {} }
}
