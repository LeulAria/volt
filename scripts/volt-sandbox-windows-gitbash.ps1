# Git Bash under MXC (spec D-15 / N.1 #16, WIN-MSYS-2): can Git for Windows' bash run inside the
# same ProcessContainer policy Volt uses, without weakening it?
#
#  1. Stock Git for Windows: expected to fail with microsoft/mxc#1061
#     (NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...) 0xC0000022).
#  2. A throwaway copy of the install with the AppContainer-compatible MSYS2 runtime from
#     https://github.com/xoviat/cygwin (branch `mxc`, release v0.4.0, pinned by SHA-256) and every
#     relocatable PE image opted into ASLR (DYNAMICBASE; PSEC force-relocates images that are not,
#     which breaks Cygwin's fork). The request is identical to the stock run: no policy change.
#
# The script never modifies the installed Git. It fails only when the sandbox itself is weakened
# (a read or write outside the policy succeeds); the Git Bash outcome is recorded either way.
#
#   VOLT_WXC_EXEC=<wxc-exec.exe> pwsh scripts/volt-sandbox-windows-gitbash.ps1

$ErrorActionPreference = 'Stop'
$wxc = $env:VOLT_WXC_EXEC
$gitRoot = 'C:\Program Files\Git'
$runtimeUrl = 'https://github.com/xoviat/cygwin/releases/download/v0.4.0/msys-2.0.dll'
$runtimeSha256 = 'F8F7AF36410CCC7C724CF48570C489DE60E51EC687488E25E85D79285A0B57DF'
$root = Join-Path $env:RUNNER_TEMP 'volt-gitbash'
$work = Join-Path $root 'work'
$outside = Join-Path $root 'outside'
New-Item -ItemType Directory -Force -Path $work, $outside | Out-Null
'CANARY-OUTSIDE' | Set-Content (Join-Path $outside 'secret.txt')
$sys = $env:SystemRoot
$summary = New-Object System.Collections.Generic.List[string]
$weakened = $false

function Ancestors([string[]]$paths) {
	$out = New-Object System.Collections.Generic.HashSet[string]
	foreach ($p in $paths) {
		$parts = $p.TrimEnd('\').Split('\')
		for ($i = 1; $i -lt $parts.Length; $i++) {
			$a = ($parts[0..($i - 1)] -join '\'); if ($i -eq 1) { $a += '\' }
			[void]$out.Add($a)
		}
	}
	foreach ($p in $paths) { [void]$out.Remove($p) }
	return @($out)
}

# The same shape buildMxcRequest (src/vs/platform/voltSandbox/common/mxc.ts) produces for a
# workspace run with network off.
function Request([string]$installRoot, [string]$script) {
	$read = @($sys, $installRoot)
	$write = @($work)
	$envList = @("SystemRoot=$sys", "windir=$sys", "TEMP=$work", "TMP=$work", "LOCALAPPDATA=$work\AppData\Local", "APPDATA=$work\AppData\Roaming", "USERPROFILE=$work", "HOME=$work",
		"ComSpec=$sys\System32\cmd.exe", "PATHEXT=.COM;.EXE;.BAT;.CMD", "PATH=$installRoot\usr\bin;$installRoot\mingw64\bin;$installRoot\cmd;$sys\System32;$sys", 'NoDefaultCurrentDirectoryInExePath=1', 'MSYS=winsymlinks:native')
	return [ordered]@{
		version = '1.0.0'; containment = 'processcontainer'; lifecycle = @{ destroyOnExit = $true }
		process = [ordered]@{ commandLine = "`"$installRoot\usr\bin\bash.exe`" --noprofile --norc -c `"$script`""; cwd = $work; env = $envList; inheritDefaultEnv = $false; timeout = 120000 }
		filesystem = [ordered]@{ readonlyPaths = $read; readwritePaths = $write; deniedPaths = @() }
		network = [ordered]@{ egress = @{ default = 'deny' }; ingress = [ordered]@{ default = 'deny'; hostLoopback = 'deny' } }
		ui = [ordered]@{ disable = $false; clipboard = 'none'; injection = $false }
		processContainer = [ordered]@{ ui = [ordered]@{ isolation = 'container'; desktopSystemControl = $false; systemSettings = 'none'; ime = $false }; filesystem = @{ enumeratePaths = (Ancestors ($read + $write)) } }
		telemetry = @{ enabled = $false }
	}
}

function Run([string]$name, [string]$installRoot, [string]$script) {
	$path = Join-Path $root "$name.json"
	(Request $installRoot $script) | ConvertTo-Json -Depth 10 | Set-Content -Path $path -Encoding utf8
	$sw = [Diagnostics.Stopwatch]::StartNew()
	$out = & $wxc $path 2>&1 | ForEach-Object { "$_" }
	$code = $LASTEXITCODE
	Write-Host "[$name] exit=$code ms=$($sw.ElapsedMilliseconds)"
	$out | ForEach-Object { Write-Host "  | $_" }
	return [pscustomobject]@{ Code = $code; Out = ($out -join "`n"); Ms = $sw.ElapsedMilliseconds }
}

$battery = @(
	'echo step:echo=ok',
	'echo hi | tr a-z A-Z | sed s/^/step:pipe=/',
	'(echo step:subshell=ok)',
	'x=$(echo ok); echo step:cmdsub=$x',
	'sleep 1 & wait $! && echo step:background=ok',
	'ls / >/dev/null && echo step:ls=ok',
	'git --version >/dev/null && echo step:git=ok',
	# /tmp is %TEMP%, which MXC points at a folder it does not create (Volt's prologue restores it).
	'cd ~ && rm -rf r && git init -q r && cd r && echo a > f && git add f && git -c user.name=v -c user.email=v@x commit -qm m && echo step:commit=$(git rev-list --count HEAD)',
	"cat '$($outside.Replace('\','/'))/secret.txt' 2>/dev/null && echo step:read-outside=LEAK || echo step:read-outside=denied",
	"echo x > '$($outside.Replace('\','/'))/w.txt' 2>/dev/null && echo step:write-outside=LEAK || echo step:write-outside=denied"
) -join '; '

Write-Host "Git for Windows: $(& "$gitRoot\cmd\git.exe" --version); bash: $(& "$gitRoot\usr\bin\bash.exe" --version | Select-Object -First 1)"
Write-Host "stock msys-2.0.dll sha256: $((Get-FileHash "$gitRoot\usr\bin\msys-2.0.dll").Hash)"

# 1. Stock install.
$stock = Run 'stock' $gitRoot 'echo step:echo=ok'
$stockError = ($stock.Out -split "`n" | Where-Object { $_ -match 'fatal error' } | Select-Object -First 1)
$summary.Add("WIN-MSYS-2 stock Git Bash under MXC: exit $($stock.Code); $(if ($stock.Out -match 'step:echo=ok') { 'RAN' } else { "failed: $($stockError.Trim())" })")

# 2. Throwaway copy with the AppContainer-compatible runtime.
$copy = Join-Path $root 'git'
robocopy $gitRoot $copy /E /NFL /NDL /NJH /NJS /NP | Out-Null
$dll = Join-Path $root 'msys-2.0.dll'
for ($i = 1; $i -le 5; $i++) {
	try { Invoke-WebRequest -Uri $runtimeUrl -OutFile $dll -UseBasicParsing; break } catch { Write-Host "download attempt $i failed: $($_.Exception.Message.Split("`n")[0])"; Start-Sleep -Seconds (5 * $i) }
}
if (-not (Test-Path $dll) -and $env:GH_TOKEN) {
	# github.com release downloads sometimes answer 5xx on hosted runners; the API path is separate.
	& gh release download v0.4.0 --repo xoviat/cygwin --pattern msys-2.0.dll --dir $root --clobber
}
$got = (Get-FileHash $dll).Hash
if ($got -ne $runtimeSha256) { throw "patched runtime digest mismatch: $got" }
foreach ($rel in 'usr\bin', 'bin') {
	if (Test-Path "$copy\$rel\msys-2.0.dll") { Copy-Item $dll "$copy\$rel\msys-2.0.dll" -Force }
}
$flagged = 0
Get-ChildItem -LiteralPath $copy -Recurse -Include *.exe, *.dll -File | ForEach-Object {
	$bytes = [IO.File]::ReadAllBytes($_.FullName)
	if ($bytes.Length -lt 0x100 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { return }
	$pe = [BitConverter]::ToInt32($bytes, 0x3C)
	if ($pe -le 0 -or $pe + 0x18 + 0x70 + 48 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550) { return }
	$opt = $pe + 0x18
	if ([BitConverter]::ToUInt16($bytes, $opt) -ne 0x20B) { return }
	$chars = [BitConverter]::ToUInt16($bytes, $pe + 0x16)
	$relocRva = [BitConverter]::ToUInt32($bytes, $opt + 0x70 + 5 * 8)
	$dllChar = [BitConverter]::ToUInt16($bytes, $opt + 70)
	if (($dllChar -band 0x40) -ne 0 -or ($chars -band 1) -ne 0 -or $relocRva -eq 0) { return }
	[BitConverter]::GetBytes([uint16]($dllChar -bor 0x40)).CopyTo($bytes, $opt + 70)
	[IO.File]::WriteAllBytes($_.FullName, $bytes)
	$flagged++
}
Write-Host "patched copy: runtime $runtimeSha256, $flagged images opted into ASLR"

$patched = Run 'patched' $copy $battery
$steps = [regex]::Matches($patched.Out, 'step:([\w-]+)=(\S+)') | ForEach-Object { "$($_.Groups[1].Value)=$($_.Groups[2].Value)" }
$summary.Add("WIN-MSYS-2 patched runtime copy (xoviat/cygwin v0.4.0, DYNAMICBASE), same MXC request: exit $($patched.Code) in $($patched.Ms) ms; $($steps -join ', ')")
if ($patched.Out -match 'step:read-outside=LEAK' -or $patched.Out -match 'step:write-outside=LEAK' -or (Test-Path (Join-Path $outside 'w.txt'))) {
	$weakened = $true
	$summary.Add('WIN-MSYS-2 FAILED: a read or write outside the policy succeeded from Git Bash')
}
$expected = 'echo', 'pipe', 'subshell', 'cmdsub', 'background', 'ls', 'git', 'commit'
$passed = @($expected | Where-Object { $patched.Out -match "step:$_=(ok|1|HI)" }).Count
$summary.Add("WIN-MSYS-2 RESULT: $passed/$($expected.Count) Git Bash steps passed in the patched copy; sandbox unweakened: $(-not $weakened)")

$summary | ForEach-Object { Write-Host $_ }
if ($env:GITHUB_STEP_SUMMARY) { $summary | ForEach-Object { "- $_" } | Add-Content -Path $env:GITHUB_STEP_SUMMARY }
# The WIN-MSYS-2 case of the WIN-* suite runs this copy through Volt's own backend.
if ($env:GITHUB_ENV -and -not $weakened) { "VOLT_MSYS_RUNTIME_ROOT=$copy" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8 }
if ($weakened) { exit 1 }
