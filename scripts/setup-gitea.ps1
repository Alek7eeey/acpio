# Creates local Gitea admin + demo repo + access token for ACProcess.
# Run after: docker compose up -d

$ErrorActionPreference = "Stop"
$Gitea = "http://localhost:3000"
$User = "acprocess"
$Pass = "acprocess"
$Email = "admin@acprocess.local"
$Repo = "demo"

Write-Host "Waiting for Gitea at $Gitea ..."
for ($i = 0; $i -lt 60; $i++) {
  try {
    $null = Invoke-RestMethod "$Gitea/api/v1/version" -TimeoutSec 2
    break
  } catch {
    Start-Sleep -Seconds 2
  }
  if ($i -eq 59) { throw "Gitea did not become ready" }
}

Write-Host "Ensuring admin user..."
docker exec -u git acprocess-gitea gitea admin user create `
  --username $User `
  --password $Pass `
  --email $Email `
  --admin `
  --must-change-password=false 2>$null

$pair = "${User}:${Pass}"
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{ Authorization = "Basic $basic" }

Write-Host "Creating access token..."
$tokenName = "acprocess-$(Get-Date -Format 'yyyyMMddHHmmss')"
try {
  $tokenRes = Invoke-RestMethod -Method Post -Uri "$Gitea/api/v1/users/$User/tokens" `
    -Headers $headers -ContentType "application/json" `
    -Body (@{ name = $tokenName; scopes = @("write:repository", "write:issue", "write:user") } | ConvertTo-Json)
  $token = $tokenRes.sha1
} catch {
  # Older Gitea token payload
  $tokenRes = Invoke-RestMethod -Method Post -Uri "$Gitea/api/v1/users/$User/tokens" `
    -Headers $headers -ContentType "application/json" `
    -Body (@{ name = $tokenName } | ConvertTo-Json)
  $token = $tokenRes.sha1
}

Write-Host "Ensuring demo repo..."
$tokenHeaders = @{ Authorization = "token $token" }
try {
  Invoke-RestMethod -Method Post -Uri "$Gitea/api/v1/user/repos" `
    -Headers $tokenHeaders -ContentType "application/json" `
    -Body (@{
      name = $Repo
      description = "ACProcess demo repo"
      private = $false
      auto_init = $true
      default_branch = "main"
      readme = "Default"
    } | ConvertTo-Json) | Out-Null
} catch {
  Write-Host "Repo may already exist"
}

Write-Host ""
Write-Host "Gitea ready:"
Write-Host "  URL:   $Gitea"
Write-Host "  User:  $User / $Pass"
Write-Host "  Repo:  $User/$Repo"
Write-Host "  Token: $token"
Write-Host ""
Write-Host "Paste token into ACProcess Settings → Gitea Token"
Write-Host "Base URL: http://localhost:3000  Owner: $User  Repo: $Repo"
