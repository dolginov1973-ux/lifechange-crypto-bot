# Lifechange Crypto VIP bot — local deploy (no GitHub Actions, no server).
# Deploys the Worker to Cloudflare using your API token (no `wrangler login` needed):
#   creates/resolves D1, applies the schema, deploys with vars, uploads secrets.
# Webhook is wired separately via the bot's own /setup route (works behind RU blocks).
#
# Usage:
#   1) copy .env.example -> .env and fill the 4 secrets
#   2) in this folder:   .\deploy.ps1
#
# Re-run any time (idempotent). Requires Node.js installed.

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# ---- load .env ----
if (-not (Test-Path '.env')) {
  Write-Host "No .env found. Copy .env.example to .env and fill the secrets first." -ForegroundColor Red
  exit 1
}
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
if ($missing) {
  Write-Host "Missing in .env: $($missing -join ', ')" -ForegroundColor Red
  exit 1
}

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

function Run($cmd) { Write-Host "> $cmd" -ForegroundColor Cyan; Invoke-Expression $cmd }

Write-Host "`n[1/6] Installing dependencies..." -ForegroundColor Green
Run 'npm install --no-audit --no-fund'

Write-Host "`n[2/6] Creating / resolving D1 database..." -ForegroundColor Green
try { Invoke-Expression 'npx wrangler d1 create lifechange-crypto-bot' } catch { Write-Host "(d1 likely already exists — continuing)" }
$dbjson = npx wrangler d1 list --json | Out-String
$dbid = ($dbjson | ConvertFrom-Json | Where-Object { $_.name -eq 'lifechange-crypto-bot' }).uuid
if (-not $dbid) { Write-Host "Could not resolve D1 id — check the API token has D1:Edit." -ForegroundColor Red; exit 1 }
Write-Host "D1 id: $dbid"
$toml = (Get-Content 'wrangler.toml' -Raw) -replace 'REPLACE_WITH_D1_DATABASE_ID', $dbid
[System.IO.File]::WriteAllText((Join-Path $ScriptDir 'wrangler.toml'), $toml)

Write-Host "`n[3/6] Applying D1 schema (idempotent)..." -ForegroundColor Green
Run 'npx wrangler d1 execute lifechange-crypto-bot --remote --file=schema.sql'

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

Write-Host "`n[5/6] Uploading Worker secrets..." -ForegroundColor Green
$secrets = @{
  BOT_TOKEN             = $cfg['BOT_TOKEN']
  BITUNIX_PARTNER_TOKEN = $cfg['BITUNIX_PARTNER_TOKEN']
  WEBHOOK_SECRET        = $cfg['WEBHOOK_SECRET']
  CRYPTOPAY_TOKEN       = if ($cfg['CRYPTOPAY_TOKEN']) { $cfg['CRYPTOPAY_TOKEN'] } else { 'PLACEHOLDER' }
}
[System.IO.File]::WriteAllText((Join-Path $ScriptDir 'secrets.tmp.json'), ($secrets | ConvertTo-Json))
try { Run 'npx wrangler secret bulk secrets.tmp.json' } finally { Remove-Item 'secrets.tmp.json' -ErrorAction SilentlyContinue }

Write-Host "`n[6/6] Done." -ForegroundColor Green
Write-Host "`n=================== NEXT ===================" -ForegroundColor Yellow
if (-not $cfg['WEBHOOK_DOMAIN']) {
  Write-Host "1. Cloudflare dashboard -> Workers & Pages -> lifechange-crypto-bot -> Settings"
  Write-Host "   -> Domains & Routes -> Add Custom Domain -> your domain (e.g. lcbot.modernbroke.com)."
  Write-Host "2. Put that domain into .env as WEBHOOK_DOMAIN, then re-run:  .\deploy.ps1"
  Write-Host "3. Then open the /setup URL printed on the next run to wire the Telegram webhook."
} else {
  Write-Host "Wire the Telegram webhook (open this URL once in a browser):" -ForegroundColor Cyan
  Write-Host "   https://$($cfg['WEBHOOK_DOMAIN'])/setup?key=$($cfg['WEBHOOK_SECRET'])"
  Write-Host "A JSON {""ok"":true,...} means the webhook is set. Then message your bot /start."
}
Write-Host "===========================================" -ForegroundColor Yellow
