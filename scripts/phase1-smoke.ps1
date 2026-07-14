# Phase 1 exit-criterion smoke test (June PLAN.md §6).
#
# Verifies, against a LIVE saple-bridge, that:
#   1. a script can make bridge spawn a Claude agent in the open workspace,
#   2. retrying the same request_id spawns nothing new (idempotent replay),
#   3. observe() resumes and returns the same ordered events.
#
# Prerequisites (all manual - this is a live end-to-end check):
#   - saple-bridge is running with a project/workspace open.
#   - Settings > Workspace > "June Voice Control" is ON, and bridge was restarted
#     after enabling it (the endpoint binds once at startup).
#
# Run:  pwsh -File june/scripts/phase1-smoke.ps1

$ErrorActionPreference = 'Stop'

$record = Join-Path $env:APPDATA 'ai.saple.bridge\june-control.json'
if (-not (Test-Path $record)) {
    Write-Error "No discovery record at $record - is bridge running with June control enabled (and restarted)?"
}
$disc = Get-Content $record -Raw | ConvertFrom-Json
$endpoint = $disc.endpoint
$headers = @{ Authorization = "Bearer $($disc.token)" }
Write-Host "Discovered bridge pid=$($disc.pid) at $endpoint (protocol v$($disc.protocol_version))"

# Liveness: reject a stale record whose process is gone.
if (-not (Get-Process -Id $disc.pid -ErrorAction SilentlyContinue)) {
    Write-Error "Discovery record is stale (pid $($disc.pid) not running)."
}

# 1. capabilities
$caps = Invoke-RestMethod -Uri "$endpoint/capabilities" -Headers $headers
Write-Host "capabilities: actions=$($caps.actions -join ',') max_agents=$($caps.limits.max_concurrent_agents)"

# 2. spawn one Claude agent
$reqId = "smoke_" + [guid]::NewGuid().ToString('N').Substring(0, 8)
$body = @{
    request_id   = $reqId
    workspace_id = 'smoke_ws'
    action       = 'spawn_agents'
    arguments    = @{ provider = 'claude'; count = 1 }
} | ConvertTo-Json
$spawn = Invoke-RestMethod -Uri "$endpoint/command" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
Write-Host "spawn -> status=$($spawn.status) started=$($spawn.result.counts.started) agents=$($spawn.result.agent_ids -join ',')"
if ($spawn.status -ne 'result' -or $spawn.result.counts.started -lt 1) { Write-Error "spawn did not start an agent: $($spawn | ConvertTo-Json -Depth 6)" }

# 3. retry the SAME request_id -> must replay, spawn nothing new
$replay = Invoke-RestMethod -Uri "$endpoint/command" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
if (($replay.result.agent_ids -join ',') -ne ($spawn.result.agent_ids -join ',')) {
    Write-Error "idempotency FAILED: retry returned different agents"
}
Write-Host "idempotent replay OK (same agent ids, nothing new spawned)"

# 4. observe from 0, then resume from the last sequence -> ordered, no repeats
$obs = Invoke-RestMethod -Uri "$endpoint/observe" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ workspace_id = 'smoke_ws'; after_sequence = 0 } | ConvertTo-Json)
$seqs = $obs.events | ForEach-Object { $_.sequence }
Write-Host "observe(0): $($obs.events.Count) events seq=[$($seqs -join ',')] latest=$($obs.latest_sequence)"
$resume = Invoke-RestMethod -Uri "$endpoint/observe" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ workspace_id = 'smoke_ws'; after_sequence = $obs.latest_sequence } | ConvertTo-Json)
if ($resume.events.Count -ne 0) { Write-Error "observe resume returned already-seen events" }
Write-Host "observe resume OK (caught up, no repeats)"

Write-Host "`nPhase 1 smoke test PASSED." -ForegroundColor Green
