# Internal helper. Its output is captured by start.mjs; do not run it manually.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows is required.' }
$canvasTokenPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Canvas Inbox Messenger\token.dpapi'
$canvasSecret = ConvertTo-SecureString -String ([IO.File]::ReadAllText($canvasTokenPath).Trim())
$canvasPointer = [IntPtr]::Zero
try {
    $canvasPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($canvasSecret)
    [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($canvasPointer))
} finally {
    if ($canvasPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($canvasPointer) }
    $canvasSecret.Dispose()
}
