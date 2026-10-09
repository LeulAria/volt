#---------------------------------------------------------------------------------------------
#  Copyright (c) Volt ADK. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Authenticode-signs Volt's binaries with the PFX in WINDOWS_CERTIFICATE (base64) and
# WINDOWS_CERTIFICATE_PASSWORD. Without the secret it warns and signs nothing.
# Usage: win32-sign.ps1 -Path <file or folder> [-Recurse]
param(
	[Parameter(Mandatory = $true)][string]$Path,
	[switch]$Recurse
)
$ErrorActionPreference = "Stop"

if (-not $env:WINDOWS_CERTIFICATE) {
	Write-Host "::warning::WINDOWS_CERTIFICATE is not set: skipping Authenticode signing of $Path (SmartScreen will warn users)."
	exit 0
}

$pfx = Join-Path $env:RUNNER_TEMP "volt-signing.pfx"
[IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
	Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw "signtool.exe not found" }

if (Test-Path $Path -PathType Container) {
	$files = Get-ChildItem $Path -Recurse:$Recurse -File -Include *.exe, *.dll, *.node
} else {
	$files = @(Get-Item $Path)
}

try {
	for ($i = 0; $i -lt $files.Count; $i += 50) {
		$batch = $files[$i..([math]::Min($i + 49, $files.Count - 1))].FullName
		& $signtool.FullName sign /fd sha256 /f $pfx /p "$env:WINDOWS_CERTIFICATE_PASSWORD" /tr http://timestamp.digicert.com /td sha256 $batch
		if ($LASTEXITCODE -ne 0) { throw "signtool failed with $LASTEXITCODE" }
	}
	Write-Host "Signed $($files.Count) files"
} finally {
	Remove-Item $pfx -Force
}
