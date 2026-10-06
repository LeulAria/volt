#---------------------------------------------------------------------------------------------
#  Copyright (c) Volt ADK. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Signs the user and system setups and collects the Windows release assets
# (user setup, system setup, zip) under .build/volt-assets.
param(
	[Parameter(Mandatory = $true)][string]$Arch,
	[Parameter(Mandatory = $true)][string]$Channel,
	[Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$out = Join-Path $root ".build\volt-assets"
New-Item -ItemType Directory -Force $out | Out-Null
$base = "volt-$Channel-$Version-win32-$Arch"

foreach ($target in @("user", "system")) {
	$setup = Get-ChildItem (Join-Path $root ".build\win32-$Arch\$target-setup") -Filter *.exe | Select-Object -First 1
	if (-not $setup) { throw "No $target setup found for $Arch" }
	& (Join-Path $PSScriptRoot "win32-sign.ps1") -Path $setup.FullName
	Copy-Item $setup.FullName (Join-Path $out "$base-$target-setup.exe")
}

$app = Resolve-Path (Join-Path $root "..\VSCode-win32-$Arch")
7z.exe a -tzip -mx5 (Join-Path $out "$base.zip") "$app\*" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7z failed with $LASTEXITCODE" }

Get-ChildItem $out | Format-Table Name, Length
