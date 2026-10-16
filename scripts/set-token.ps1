$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This token setup script requires Windows.' }
$canvasData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Canvas Inbox Messenger'
$canvasSecret = Read-Host 'Enter your Canvas personal access token for byui.instructure.com (hidden)' -AsSecureString
try {
    if ($canvasSecret.Length -eq 0) { throw 'The token cannot be empty.' }
    $canvasEncrypted = ConvertFrom-SecureString -SecureString $canvasSecret
    [IO.Directory]::CreateDirectory($canvasData) | Out-Null
    [IO.File]::WriteAllText((Join-Path $canvasData 'token.dpapi'), $canvasEncrypted, [Text.Encoding]::ASCII)
    Write-Host 'Token saved using Windows data protection for this Windows account.'
} finally {
    $canvasSecret.Dispose()
}
