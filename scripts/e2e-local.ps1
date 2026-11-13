$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$out = Join-Path $env:TEMP 'cf-logger-e2e.out.log'
$err = Join-Path $env:TEMP 'cf-logger-e2e.err.log'
Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$existing = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  throw "Port 8787 is already in use by process $($existing.OwningProcess). Stop it before running e2e."
}

$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) {
  $pnpm = (Get-Command pnpm).Source
}

Push-Location $repo
try {
  & $pnpm build
  if ($LASTEXITCODE -ne 0) {
    throw 'Logger package build failed before e2e startup.'
  }
}
finally {
  Pop-Location
}

$process = Start-Process -FilePath $pnpm -ArgumentList 'dev' -WorkingDirectory $repo -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden

try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $out) {
      $content = Get-Content $out -Raw
      if ($content -match 'Ready on http://127\.0\.0\.1:8787') {
        $ready = $true
        break
      }
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not $ready) {
    $stdout = if (Test-Path $out) { Get-Content $out -Raw } else { '' }
    $stderr = if (Test-Path $err) { Get-Content $err -Raw } else { '' }
    throw "Wrangler dev server did not become ready. Stdout: $stdout Stderr: $stderr"
  }

  $base = 'http://127.0.0.1:8787'
$traceId = '11111111111111111111111111111111'
  $parentSpanId = '2222222222222222'
  $headers = @{
    'traceparent' = "00-$traceId-$parentSpanId-01"
    'tracestate' = 'vendor=value'
    'X-Request-Id' = 'req-e2e-local'
  }

  function Convert-Body($Content) {
    if (-not $Content) { return $null }
    try { return $Content | ConvertFrom-Json } catch { return $Content }
  }

  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient

  function Get-ResponseHeader($Response, [string]$Name) {
    try {
      return $Response.Headers.GetValues($Name) | Select-Object -First 1
    }
    catch {
      try {
        return $Response.Content.Headers.GetValues($Name) | Select-Object -First 1
      }
      catch {
        return $null
      }
    }
  }

  function Probe($Path, [int]$ExpectedStatus) {
    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$base$Path")
    foreach ($header in $headers.GetEnumerator()) {
      [void]$request.Headers.TryAddWithoutValidation($header.Key, [string]$header.Value)
    }
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    [PSCustomObject]@{
      Path = $Path
      Status = [int]$response.StatusCode
      Expected = $ExpectedStatus
      Body = Convert-Body $content
      XRequestId = Get-ResponseHeader $response 'X-Request-Id'
      XTraceId = Get-ResponseHeader $response 'X-Trace-Id'
      Traceparent = Get-ResponseHeader $response 'traceparent'
      Tracestate = Get-ResponseHeader $response 'tracestate'
    }
  }

  $results = @(
    Probe '/' 200
    Probe '/multi-hop' 200
    Probe '/trace' 200
    Probe '/error' 500
  )

  $failures = New-Object System.Collections.Generic.List[string]
  foreach ($r in $results) {
    if ($r.Status -ne $r.Expected) { $failures.Add("$($r.Path) status actual=$($r.Status) expected=$($r.Expected)") }
    if ($r.XRequestId -ne 'req-e2e-local') { $failures.Add("$($r.Path) X-Request-Id actual=$($r.XRequestId)") }
    if ($r.XTraceId -ne $traceId) { $failures.Add("$($r.Path) X-Trace-Id actual=$($r.XTraceId)") }
    if ($r.Traceparent -notlike "00-$traceId-*-01") { $failures.Add("$($r.Path) traceparent actual=$($r.Traceparent)") }
    if ($r.Tracestate -ne 'vendor=value') { $failures.Add("$($r.Path) tracestate actual=$($r.Tracestate)") }
  }

  $root = $results | Where-Object Path -eq '/'
  $multi = $results | Where-Object Path -eq '/multi-hop'
  $trace = $results | Where-Object Path -eq '/trace'
  $errorProbe = $results | Where-Object Path -eq '/error'

  if ($root.Body.total -ne 12) { $failures.Add("/ total actual=$($root.Body.total)") }
  if ($root.Body.traceId -ne $traceId) { $failures.Add("/ body traceId actual=$($root.Body.traceId)") }
  if ($multi.Body.result -ne 15) { $failures.Add("/multi-hop result actual=$($multi.Body.result)") }
  if ($multi.Body.traceId -ne $traceId) { $failures.Add("/multi-hop body traceId actual=$($multi.Body.traceId)") }
  if ($trace.Body.traceId -ne $traceId) { $failures.Add("/trace body traceId actual=$($trace.Body.traceId)") }
  if ($trace.Body.parentSpanId -ne $parentSpanId) { $failures.Add("/trace parentSpanId actual=$($trace.Body.parentSpanId)") }
  if ($errorProbe.Body.error -ne 'Division by zero') { $failures.Add("/error error actual=$($errorProbe.Body.error)") }

  if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Output $_ }
    throw 'E2E assertions failed'
  }

  $results | ConvertTo-Json -Depth 6
  $client.Dispose()
}
finally {
  if ($env:CF_LOGGER_E2E_SKIP_CLEANUP -ne '1') {
    if ($process -and -not $process.HasExited) {
      Stop-ProcessTree -ProcessId $process.Id
    }
  }
}
