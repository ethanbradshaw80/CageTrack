# ============================================================
# CageTrack — local preview server (no Python/Node needed)
# Double-click Start-CageTrack.bat, or run:
#   powershell -ExecutionPolicy Bypass -File dev-server.ps1
# Then open http://localhost:5522 in your browser.
#
# Besides serving files, it exposes one tiny API the dashboard
# uses to make Needs Review links permanent:
#   POST /api/save-link  ->  appends the link to manual_links.json
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

function Send-Bytes($stream, [string]$status, [string]$ctype, [byte[]]$bytes) {
  $header = "HTTP/1.1 $status`r`nContent-Type: $ctype`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($hb,0,$hb.Length); $stream.Write($bytes,0,$bytes.Length); $stream.Flush()
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
    $parts = $requestLine -split ' '
    $method = $parts[0]
    $path = ($parts[1] -split '\?')[0]

    # read headers; capture Content-Length for POST bodies
    $contentLength = 0
    while ($true) {
      $hline = $null
      try { $hline = $reader.ReadLine() } catch { break }
      if ($null -eq $hline -or $hline -eq '') { break }
      if ($hline -match '^Content-Length:\s*(\d+)') { $contentLength = [int]$matches[1] }
    }

    # ---- API: save a Needs Review link permanently ----
    if ($method -eq 'POST' -and $path -eq '/api/save-link') {
      $body = ''
      if ($contentLength -gt 0) {
        $buf = New-Object char[] $contentLength
        $got = 0
        while ($got -lt $contentLength) {
          $n = 0
          try { $n = $reader.Read($buf, $got, $contentLength - $got) } catch { break }
          if ($n -le 0) { break }
          $got += $n
        }
        if ($got -gt 0) { $body = -join $buf[0..($got-1)] }
      }
      $status = '400 Bad Request'; $resp = '{"ok":false}'
      try {
        $entry = $body | ConvertFrom-Json
        if ($entry -and $entry.technician) {
          $file = Join-Path $root 'manual_links.json'
          $list = @()
          if (Test-Path $file) {
            try { $existing = Get-Content $file -Raw | ConvertFrom-Json; if ($existing) { $list = @($existing) } } catch {}
          }
          $list = @($list) + @($entry)
          $json = ConvertTo-Json -InputObject $list -Depth 6
          [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
          $status = '200 OK'; $resp = '{"ok":true}'
        }
      } catch { $status = '500 Internal Server Error'; $resp = '{"ok":false}' }
      Send-Bytes $stream $status 'application/json' ([System.Text.Encoding]::UTF8.GetBytes($resp))
      $client.Close(); continue
    }

    # ---- static files ----
    if ($path -eq '/') { $path = '/index.html' }
    $decoded = [System.Uri]::UnescapeDataString($path)
    $file = Join-Path $root ($decoded.TrimStart('/').Replace('/','\'))
    if (Test-Path $file -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $ct = $mime[$ext]; if (-not $ct) { $ct = "application/octet-stream" }
      Send-Bytes $stream '200 OK' $ct $bytes
    } else {
      Send-Bytes $stream '404 Not Found' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $decoded"))
    }
  } catch {} finally { try { $client.Close() } catch {} }
}
