$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\morrowbyte-installer-guard.ps1" -LibraryOnly
$tests = 0
function Assert-Equal($Expected, $Actual) {
    if ($Expected -ne $Actual) { throw "Expected $Expected, got $Actual" }
    $script:tests++
}
function Assert-Refused([scriptblock]$Action) {
    $refused = $false
    try { & $Action | Out-Null } catch { $refused = $true }
    if (-not $refused) { throw 'An ambiguous process was accepted.' }
    $script:tests++
}
$root = 'C:\Users\Tester\AppData\Local\Programs\MorrowbyteDesktop'
$exe = 'T3 Code (Weasel Nightly).exe'
$sid = 'S-1-5-21-100-200-300-1001'
$owned = { param($Process) return 'S-1-5-21-100-200-300-1001' }
$never = { throw 'An unrelated process must not require owner lookup.' }
function Process-At([string]$Path) { return [pscustomobject]@{ ExecutablePath = $Path } }

Assert-Equal 'clear' (Get-MorrowbyteInstallState -Root $root -Executable $exe -CurrentSid $sid -Processes @() -OwnerSid $never)
Assert-Equal 'running' (Get-MorrowbyteInstallState -Root $root -Executable $exe -CurrentSid $sid -Processes @((Process-At "$root\$exe")) -OwnerSid $owned)
Assert-Equal 'running' (Get-MorrowbyteInstallState -Root "$root\" -Executable $exe -CurrentSid $sid -Processes @((Process-At ($root.ToUpperInvariant() + "\$exe"))) -OwnerSid $owned)
# Adjacent extracted versions and prefix siblings must never be matched or stopped.
foreach ($other in @(($root + '-old'), 'C:\Users\Tester\AppData\Local\Programs\morrowbyte-t3-release15')) {
    Assert-Equal 'clear' (Get-MorrowbyteInstallState -Root $root -Executable $exe -CurrentSid $sid -Processes @((Process-At "$other\$exe")) -OwnerSid $never)
}
Assert-Refused { Get-MorrowbyteInstallState -Root $root -Executable $exe -CurrentSid $sid -Processes @((Process-At '')) -OwnerSid $owned }
Assert-Refused { Get-MorrowbyteInstallState -Root $root -Executable $exe -CurrentSid $sid -Processes @((Process-At "$root\nested\$exe")) -OwnerSid $owned }
Assert-Refused { Get-MorrowbyteInstallState -Root $root -Executable $exe -CurrentSid $sid -Processes @((Process-At "$root\$exe")) -OwnerSid { throw 'CIM owner failure' } }
Assert-Refused { Get-MorrowbyteInstallState -Root $root -Executable $exe -CurrentSid $sid -Processes @((Process-At "$root\$exe")) -OwnerSid { 'S-1-5-21-999' } }
Assert-Refused { Get-MorrowbyteInstallState -Root 'relative' -Executable $exe -CurrentSid $sid -Processes @() -OwnerSid $owned }
Assert-Refused { Get-MorrowbyteInstallState -Root $root -Executable 'sub\app.exe' -CurrentSid $sid -Processes @() -OwnerSid $owned }

# Reproduce a PS7 caller's poisoned module environment, then execute the real
# guard using Windows PowerShell. No matching app process or installer is run.
$priorModulePath = $env:PSModulePath
$priorWinModulePath = $env:WinPSModulePath
try {
    $env:PSModulePath = 'C:\nonexistent-powershell7-modules'
    $env:WinPSModulePath = 'C:\nonexistent-windows-modules'
    $powershell = [IO.Path]::Combine($env:WINDIR, 'System32\WindowsPowerShell\v1.0\powershell.exe')
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\morrowbyte-installer-guard.ps1" -InstallRoot $root -AppExecutable '__morrowbyte_guard_absent_fixture__.exe' -WaitSeconds 0
    Assert-Equal 0 $LASTEXITCODE
    # The guard process itself is an exact current-user match: it must refuse
    # installation at the deadline without stopping this test or any process.
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\morrowbyte-installer-guard.ps1" -InstallRoot ([IO.Path]::GetDirectoryName($powershell)) -AppExecutable 'powershell.exe' -WaitSeconds 0
    Assert-Equal 10 $LASTEXITCODE
} finally {
    $env:PSModulePath = $priorModulePath
    $env:WinPSModulePath = $priorWinModulePath
}
Write-Output "Morrowbyte installer guard: $tests checks passed. No application process was stopped."
exit 0
