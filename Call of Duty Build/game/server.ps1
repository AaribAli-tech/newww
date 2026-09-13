# ============================================================================
# NUKETOWN - zero-dependency local web server
#
# The game is built from ES modules and loads its models and textures at
# runtime, so a browser will refuse to run it straight off the disk (file://).
# It needs to be served over http.
#
# This uses a raw TcpListener rather than HttpListener: HttpListener wants a URL
# reservation and therefore admin rights on many machines, while a TcpListener
# on loopback needs no permissions at all. PowerShell ships with Windows, so
# there is nothing for anyone to install.
# ============================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.webp' = 'image/webp'
    '.svg'  = 'image/svg+xml'
    '.glb'  = 'model/gltf-binary'
    '.gltf' = 'model/gltf+json'
    '.bin'  = 'application/octet-stream'
    '.ico'  = 'image/x-icon'
    '.woff' = 'font/woff'
    '.woff2' = 'font/woff2'
    '.mp3'  = 'audio/mpeg'
    '.ogg'  = 'audio/ogg'
    '.wav'  = 'audio/wav'
    '.txt'  = 'text/plain; charset=utf-8'
}

# Find a free port rather than dying if something else already holds one.
$listener = $null
$port = 0
foreach ($try in 8420..8460) {
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $try)
        $l.Start()
        $listener = $l
        $port = $try
        break
    } catch { }
}

if (-not $listener) {
    Write-Host ''
    Write-Host '  Could not open a local port. Close other copies of this game and try again.' -ForegroundColor Red
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}

$url = "http://localhost:$port/index.html"

Write-Host ''
Write-Host '   NUKETOWN' -ForegroundColor Yellow
Write-Host '   ---------------------------------------------'
Write-Host "   Playing at: $url"
Write-Host ''
Write-Host '   KEEP THIS BLACK WINDOW OPEN while you play.'
Write-Host '   Close it when you are done to shut the game down.'
Write-Host ''

Start-Process $url | Out-Null

function Send-Response {
    param($stream, [int]$code, [string]$status, [string]$type, [byte[]]$body)
    $head = "HTTP/1.1 $code $status`r`n" +
            "Content-Type: $type`r`n" +
            "Content-Length: $($body.Length)`r`n" +
            "Cache-Control: no-store`r`n" +
            "Connection: close`r`n`r`n"
    $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($headBytes, 0, $headBytes.Length)
    if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
}

while ($true) {
    $client = $null
    try {
        $client = $listener.AcceptTcpClient()
        $client.ReceiveTimeout = 5000
        $client.SendTimeout = 30000
        $stream = $client.GetStream()

        # Read just the request line; that is all we need to route a GET.
        $buffer = New-Object byte[] 4096
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { $client.Close(); continue }
        $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
        $firstLine = ($request -split "`r`n")[0]
        $parts = $firstLine -split ' '
        if ($parts.Count -lt 2) { $client.Close(); continue }

        $path = $parts[1]
        $path = ($path -split '\?')[0]          # drop any query string
        if ($path -eq '/') { $path = '/index.html' }

        # Decode %20 etc, then normalise to a real path under the game folder.
        $decoded = [System.Uri]::UnescapeDataString($path).TrimStart('/')
        $decoded = $decoded -replace '/', '\'
        $full = Join-Path $root $decoded

        # Refuse anything that tries to climb out of the game folder.
        $fullResolved = [System.IO.Path]::GetFullPath($full)
        $rootResolved = [System.IO.Path]::GetFullPath($root)
        if (-not $fullResolved.StartsWith($rootResolved, [StringComparison]::OrdinalIgnoreCase)) {
            Send-Response $stream 403 'Forbidden' 'text/plain' ([System.Text.Encoding]::ASCII.GetBytes('Forbidden'))
            $client.Close(); continue
        }

        if (Test-Path $fullResolved -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($fullResolved).ToLower()
            $type = $mime[$ext]
            if (-not $type) { $type = 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($fullResolved)
            Send-Response $stream 200 'OK' $type $bytes
        } else {
            Send-Response $stream 404 'Not Found' 'text/plain' ([System.Text.Encoding]::ASCII.GetBytes('Not found'))
        }
    } catch {
        # A browser dropping a connection mid-transfer is normal; keep serving.
    } finally {
        if ($client) { try { $client.Close() } catch { } }
    }
}
