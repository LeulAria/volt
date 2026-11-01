#---------------------------------------------------------------------------------------------
#  Copyright (c) Volt ADK. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Starts Volt's desktop helper for Windows: compiles VoltDesktop.windows.cs (next to this script)
# into the cache folder once per version of the source, then runs it. Volt talks to it over
# stdin/stdout, so nothing else may write to stdout.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File VoltDesktop.windows.ps1 <cache folder> <Volt's pid>

param([string]$Cache, [int]$VoltPid = 0)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'VoltDesktop.windows.cs'
$code = [System.IO.File]::ReadAllText($source)
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($code))) -replace '-', '').Substring(0, 16).ToLowerInvariant()
$dll = Join-Path $Cache "volt-desktop-$hash.dll"

if (-not (Test-Path $dll)) {
	New-Item -ItemType Directory -Force -Path $Cache | Out-Null
	# Another Volt window may be compiling the same source: build under a private name, then move it in place.
	$partial = Join-Path $Cache "volt-desktop-$hash.$PID.dll"
	Add-Type -TypeDefinition $code -OutputAssembly $partial -OutputType Library -ReferencedAssemblies @(
		'System.Core', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions'
	) | Out-Null
	try { Move-Item -Path $partial -Destination $dll -ErrorAction Stop } catch { Remove-Item -Path $partial -ErrorAction SilentlyContinue }
}

Add-Type -Path $dll
[VoltDesktopHelper]::Run($VoltPid)
