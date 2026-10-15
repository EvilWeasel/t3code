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

# Use a private process image: System32 powershell.exe is shared with unrelated
# runner activity and cannot identify just this fixture's held application.
$priorModulePath = $env:PSModulePath
$priorWinModulePath = $env:WinPSModulePath
$fixtureRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('morrowbyte-guard-' + [Guid]::NewGuid().ToString('N')))
$fixtureName = 'guard-fixture-' + [Guid]::NewGuid().ToString('N') + '.exe'
$fixtureExe = [IO.Path]::Combine($fixtureRoot, $fixtureName)
$fixtureProcess = $null
$fixtureStarted = $false
$fixtureRootCreated = $false
$fixtureFailure = $null
$fixtureCleanupFallback = $false
$fixtureCleanupFailed = $false
$fixtureBoundaryTimeoutMs = 5000
try {
    New-Item -ItemType Directory -Path $fixtureRoot -ErrorAction Stop | Out-Null
    $fixtureRootCreated = $true
    $fixtureOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $fixtureAcl = [Security.AccessControl.DirectorySecurity]::new()
    $fixtureAcl.SetOwner($fixtureOwner)
    $fixtureAcl.SetAccessRuleProtection($true, $false)
    $fixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $fixtureOwner,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.Directory]::SetAccessControl($fixtureRoot, $fixtureAcl)
    $fixtureSource = @'
using System;
public static class MorrowbyteGuardFixture {
    public static int Main() {
        Console.WriteLine("MORROWBYTE_GUARD_FIXTURE_READY");
        Console.Out.Flush();
        return Console.ReadLine() == "MORROWBYTE_GUARD_FIXTURE_RELEASE" ? 0 : 2;
    }
}
'@
    # Windows PowerShell's existing .NET compiler only; no download or fallback.
    Add-Type -TypeDefinition $fixtureSource -Language CSharp -OutputAssembly $fixtureExe -OutputType ConsoleApplication -ErrorAction Stop
    if (-not [IO.File]::Exists($fixtureExe)) { throw 'Owned fixture compiler did not produce an image.' }
    $fixtureHash = (Get-FileHash -LiteralPath $fixtureExe -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    $fixtureStart = [Diagnostics.ProcessStartInfo]::new()
    $fixtureStart.FileName = $fixtureExe
    $fixtureStart.WorkingDirectory = $fixtureRoot
    $fixtureStart.UseShellExecute = $false
    $fixtureStart.CreateNoWindow = $true
    $fixtureStart.RedirectStandardInput = $true
    $fixtureStart.RedirectStandardOutput = $true
    $fixtureStart.RedirectStandardError = $true
    $fixtureProcess = [Diagnostics.Process]::new()
    $fixtureProcess.StartInfo = $fixtureStart
    $fixtureStarted = $fixtureProcess.Start()
    if (-not $fixtureStarted) { throw 'Owned fixture process did not start.' }
    $fixturePid = $fixtureProcess.Id
    $ready = $fixtureProcess.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait($fixtureBoundaryTimeoutMs)) { throw 'Owned fixture readiness was not observed.' }
    Assert-Equal 'MORROWBYTE_GUARD_FIXTURE_READY' $ready.Result
    Assert-Equal $false $fixtureProcess.HasExited
    Assert-Equal $fixturePid $fixtureProcess.Id
    Assert-Equal $true ([IO.Path]::GetFullPath($fixtureProcess.MainModule.FileName).Equals(
        [IO.Path]::GetFullPath($fixtureExe), [StringComparison]::OrdinalIgnoreCase))
    Write-Output ('Morrowbyte guard fixture: pid={0}; exact_image=true; ready=true; sha256={1}' -f $fixturePid, $fixtureHash)

    # Preserve the real Windows PowerShell poisoned-module-environment checks.
    $env:PSModulePath = 'C:\nonexistent-powershell7-modules'
    $env:WinPSModulePath = 'C:\nonexistent-windows-modules'
    $powershell = [IO.Path]::Combine($env:WINDIR, 'System32\WindowsPowerShell\v1.0\powershell.exe')
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\morrowbyte-installer-guard.ps1" -InstallRoot $root -AppExecutable '__morrowbyte_guard_absent_fixture__.exe' -WaitSeconds 0
    Assert-Equal 0 $LASTEXITCODE
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\morrowbyte-installer-guard.ps1" -InstallRoot $fixtureRoot -AppExecutable $fixtureName -WaitSeconds 0
    Assert-Equal 10 $LASTEXITCODE
    Assert-Equal $false $fixtureProcess.HasExited

    $fixtureProcess.StandardInput.WriteLine('MORROWBYTE_GUARD_FIXTURE_RELEASE')
    $fixtureProcess.StandardInput.Flush()
    $fixtureProcess.StandardInput.Close()
    if (-not $fixtureProcess.WaitForExit($fixtureBoundaryTimeoutMs)) { throw 'Owned fixture exit was not observed.' }
    Assert-Equal 0 $fixtureProcess.ExitCode
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\morrowbyte-installer-guard.ps1" -InstallRoot $fixtureRoot -AppExecutable $fixtureName -WaitSeconds 0
    Assert-Equal 0 $LASTEXITCODE
} catch {
    $fixtureFailure = $_
} finally {
    $env:PSModulePath = $priorModulePath
    $env:WinPSModulePath = $priorWinModulePath
    if ($fixtureStarted) {
        if (-not $fixtureProcess.HasExited) {
            $normalExit = $false
            try {
                $fixtureProcess.StandardInput.WriteLine('MORROWBYTE_GUARD_FIXTURE_RELEASE')
                $fixtureProcess.StandardInput.Flush()
                $fixtureProcess.StandardInput.Close()
                $normalExit = $fixtureProcess.WaitForExit($fixtureBoundaryTimeoutMs) -and $fixtureProcess.ExitCode -eq 0
            } catch { $normalExit = $false }
            if (-not $normalExit) {
                $fixtureCleanupFallback = $true
                [Console]::Error.WriteLine('Owned guard fixture required cleanup fallback; qualification failed.')
                try {
                    if (-not $fixtureProcess.HasExited) { $fixtureProcess.Kill() }
                    if (-not $fixtureProcess.WaitForExit($fixtureBoundaryTimeoutMs)) { $fixtureCleanupFailed = $true }
                } catch { $fixtureCleanupFailed = $true }
            }
        }
        $fixtureProcess.Dispose()
    }
    try {
        if ($fixtureRootCreated -and [IO.Directory]::Exists($fixtureRoot)) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction Stop }
    } catch {
        $fixtureCleanupFailed = $true
        [Console]::Error.WriteLine('Owned guard fixture directory cleanup failed; qualification failed.')
    }
}
if ($null -ne $fixtureFailure) { throw $fixtureFailure }
if ($fixtureCleanupFallback -or $fixtureCleanupFailed) { throw 'Owned guard fixture cleanup was not normal and complete.' }
Write-Output "Morrowbyte installer guard: $tests checks passed. No application process was stopped; the owned test fixture exited normally."
exit 0
