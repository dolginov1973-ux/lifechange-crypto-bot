# Lifechange Crypto VIP bot - local deploy (no GitHub Actions, no server).
# Deploys the Worker to Cloudflare using your API token (no `wrangler login` needed):
# creates/resolves D1, applies the schema, deploys with vars, uploads secrets.
# Webhook is wired separately via the bot's own /setup route (works behind RU blocks).
#
# Usage:
#   1) copy .env.example to .env and fill the 4 secrets
#   2) in this folder:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
#
# Re-run any time (idempotent). Requires Node.js installed. ASCII-only on purpose.

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function CheckExit($what) { if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)." } }

# ---- load .env ----
if (-not (Test-Path '.env')) { Fail "No .env found. Copy .env.example to .env and fill the secrets first." }
$cfg = @{}
foreach ($line in Get-Content '.env') {
  $t = $line.Trim()
  if ($t -eq '' -or $t.StartsWith('#')) { continue }
  $i = $t.IndexOf('=')
  if ($i -lt 1) { continue }
  $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
}

# ---- validate required secrets ----
$required = @('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'BOT_TOKEN', 'BITUNIX_PARTNER_TOKEN')
$missing = $required | Where-Object { -not $cfg[$_] }
if ($missing) { Fail "Missing in .env: $($missing -join ', ')" }

# ---- generate WEBHOOK_SECRET if blank (persist to .env so re-runs reuse it) ----
if (-not $cfg['WEBHOOK_SECRET']) {
  $bytes = New-Object 'byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $cfg['WEBHOOK_SECRET'] = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Add-Content '.env' "WEBHOOK_SECRET=$($cfg['WEBHOOK_SECRET'])"
  Write-Host "Generated WEBHOOK_SECRET (saved to .env)." -ForegroundColor Yellow
}

# ---- wrangler auth via API token (no browser login) + non-interactive ----
$env:CLOUDFLARE_API_TOKEN = $cfg['CLOUDFLARE_API_TOKEN']
$env:CLOUDFLARE_ACCOUNT_ID = $cfg['CLOUDFLARE_ACCOUNT_ID']
$env:CI = 'true'

# ---- optional proxy (if the ISP blocks api.cloudflare.com / npm) ----
# PROXY in .env, format: http://user:pass@host:port. npm + wrangler both honor these.
if ($cfg['PROXY']) {
  $env:HTTP_PROXY = $cfg['PROXY']
  $env:HTTPS_PROXY = $cfg['PROXY']
  $env:http_proxy = $cfg['PROXY']
  $env:https_proxy = $cfg['PROXY']
  Write-Host "Routing npm + wrangler through proxy from .env." -ForegroundColor Yellow
}

Write-Host "`n[1/6] Installing dependencies..." -ForegroundColor Green
npm install --no-audit --no-fund
CheckExit 'npm install'

Write-Host "`n[2/6] Creating / resolving D1 database..." -ForegroundColor Green
# create may fail if it already exists - that is fine, we resolve the id next.
npx wrangler d1 create lifechange-crypto-bot
$dbjson = npx wrangler d1 list --json | Out-String
$dbid = $null
try { $dbid = ($dbjson | ConvertFrom-Json | Where-Object { $_.name -eq 'lifechange-crypto-bot' }).uuid } catch {}
if (-not $dbid) { Fail "Could not resolve D1 id. Check the API token has D1:Edit permission." }
Write-Host "D1 id: $dbid"
$toml = (Get-Content 'wrangler.toml' -Raw) -replace 'REPLACE_WITH_D1_DATABASE_ID', $dbid
[System.IO.File]::WriteAllText((Join-Path $ScriptDir 'wrangler.toml'), $toml)

Write-Host "`n[3/6] Applying D1 schema (idempotent)..." -ForegroundColor Green
npx wrangler d1 execute lifechange-crypto-bot --remote --file=schema.sql
CheckExit 'd1 schema'

Write-Host "`n[4/6] Deploying Worker (vars inline)..." -ForegroundColor Green
$min = if ($cfg['MIN_BALANCE_USDT']) { $cfg['MIN_BALANCE_USDT'] } else { '50' }
npx wrangler deploy `
  --var "OUR_REF_CODE:$($cfg['OUR_REF_CODE'])" `
  --var "OUR_PARTNER_UID:$($cfg['OUR_PARTNER_UID'])" `
  --var "MIN_BALANCE_USDT:$min" `
  --var "BOT_USERNAME:$($cfg['BOT_USERNAME'])" `
  --var "REFERRAL_LINK:$($cfg['REFERRAL_LINK'])" `
  --var "VIP_CHAT_ID:$($cfg['VIP_CHAT_ID'])" `
  --var "ADMIN_CHAT_ID:$($cfg['ADMIN_CHAT_ID'])" `
  --var "WEBHOOK_DOMAIN:$($cfg['WEBHOOK_DOMAIN'])"
CheckExit 'wrangler deploy'

Write-Host "`n[5/6] Uploading Worker secrets..." -ForegroundColor Green
$cp = if ($cfg['CRYPTOPAY_TOKEN']) { $cfg['CRYPTOPAY_TOKEN'] } else { 'PLACEHOLDER' }
$secrets = @{
  BOT_TOKEN             = $cfg['BOT_TOKEN']
  BITUNIX_PARTNER_TOKEN = $cfg['BITUNIX_PARTNER_TOKEN']
  WEBHOOK_SECRET        = $cfg['WEBHOOK_SECRET']
  CRYPTOPAY_TOKEN       = $cp
}
[System.IO.File]::WriteAllText((Join-Path $ScriptDir 'secrets.tmp.json'), ($secrets | ConvertTo-Json))
try {
  npx wrangler secret bulk secrets.tmp.json
  CheckExit 'secret bulk'
} finally {
  Remove-Item 'secrets.tmp.json' -ErrorAction SilentlyContinue
}

Write-Host "`n[6/6] Done." -ForegroundColor Green
Write-Host "`n=================== NEXT ===================" -ForegroundColor Yellow
if (-not $cfg['WEBHOOK_DOMAIN']) {
  Write-Host "1. Cloudflare -> Workers and Pages -> lifechange-crypto-bot -> Settings"
  Write-Host "   -> Domains and Routes -> Add Custom Domain -> e.g. lcbot.modernbroke.com"
  Write-Host "2. Put that domain into .env as WEBHOOK_DOMAIN, then re-run this script."
  Write-Host "3. The next run prints a /setup URL - open it once to wire the webhook."
} else {
  Write-Host "Open this URL once in a browser to wire the Telegram webhook:" -ForegroundColor Cyan
  Write-Host ("   https://{0}/setup?key={1}" -f $cfg['WEBHOOK_DOMAIN'], $cfg['WEBHOOK_SECRET'])
  Write-Host 'A JSON with "ok":true means the webhook is set. Then message your bot /start.'
}
Write-Host "===========================================" -ForegroundColor Yellow
