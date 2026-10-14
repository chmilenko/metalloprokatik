# deploy.ps1 - one command: commit + push + update the server + restart the bot
# Usage (in the project root):  .\deploy.ps1 "what changed"
param([string]$Message = "update")

$Server = "root@5.188.232.223"
$RemoteDir = "/root/metalloprokatik"
$Pm2Name = "metalloprokatik"

git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { Write-Host "commit failed" -ForegroundColor Red; exit 1 }
} else {
    Write-Host "No new changes to commit - updating the server only." -ForegroundColor Yellow
}

git push
if ($LASTEXITCODE -ne 0) { Write-Host "git push failed - server not touched" -ForegroundColor Red; exit 1 }

ssh $Server "cd $RemoteDir && git pull && npm install --omit=dev && pm2 restart $Pm2Name && sleep 3 && pm2 logs $Pm2Name --lines 15 --nostream"
if ($LASTEXITCODE -ne 0) { Write-Host "server update failed - see output above" -ForegroundColor Red; exit 1 }

Write-Host "Done: server updated, bot restarted." -ForegroundColor Green
