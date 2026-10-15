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
$fixturePhase = 'prepare'
$fixtureTerminal = $null
$fixtureReleaseAttempted = $false
$fixtureCreation = $null
$fixtureCapturedPid = $null
# Static state only, captured before cleanup can release/dispose the owned child.
function Write-FixtureBoundary([string]$Phase) {
    $alive = 'unknown'; $exitCode = 'unknown'; $moduleAvailable = 'unknown'; $terminal = 'pending'
    if ($fixtureStarted -and $null -ne $fixtureProcess) {
        try {
            $fixtureProcess.Refresh()
            $alive = (-not $fixtureProcess.HasExited).ToString().ToLowerInvariant()
            if ($fixtureProcess.HasExited) { $exitCode = [string]$fixtureProcess.ExitCode }
            try { $moduleAvailable = ($null -ne $fixtureProcess.MainModule).ToString().ToLowerInvariant() } catch { $moduleAvailable = 'unavailable' }
        } catch { $alive = 'unavailable' }
    }
    if ($null -ne $fixtureTerminal -and $fixtureTerminal.IsCompleted) {
        try {
            $terminal = switch ($fixtureTerminal.Result) {
                'MORROWBYTE_GUARD_FIXTURE_EOF' { 'eof-before-release'; break }
                'MORROWBYTE_GUARD_FIXTURE_MISMATCH' { 'nonmatching-release'; break }
                'MORROWBYTE_GUARD_FIXTURE_MATCHED' { 'matched-release'; break }
                default { 'unclassified-terminal'; break }
            }
        } catch { $terminal = 'unavailable' }
    }
    Write-Output ('Morrowbyte fixture boundary: phase={0}; alive={1}; exit={2}; module={3}; release_attempted={4}; terminal={5}; pid={6}' -f $Phase, $alive, $exitCode, $moduleAvailable, $fixtureReleaseAttempted, $terminal, $(if ($null -eq $fixtureCapturedPid) { 'unknown' } else { $fixtureCapturedPid }))
}
function Assert-FixtureCimIdentity([string]$Phase) {
    # Resolve only the captured PID and the unique invocation-owned image name.
    # No alternate PID selection, path fallback or owner substitution.
    $rows = @(CimCmdlets\Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $fixtureCapturedPid) -OperationTimeoutSec 5 -ErrorAction Stop)
    Assert-Equal 1 $rows.Count
    $row = $rows[0]
    if ([string]::IsNullOrWhiteSpace([string]$row.ExecutablePath) -or $null -eq $row.CreationDate) { throw 'Owned fixture CIM identity unavailable.' }
    $exactPath = [IO.Path]::GetFullPath([string]$row.ExecutablePath).Equals([IO.Path]::GetFullPath($fixtureExe), [StringComparison]::OrdinalIgnoreCase)
    $creation = [string]$row.CreationDate.ToUniversalTime().Ticks
    if ($null -eq $script:fixtureCreation) { $script:fixtureCreation = $creation }
    $sameCreation = $script:fixtureCreation -eq $creation
    $owner = CimCmdlets\Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop
    $sameOwner = $owner.ReturnValue -eq 0 -and $owner.Sid -eq $fixtureOwner.Value
    $names = @(CimCmdlets\Get-CimInstance -ClassName Win32_Process -Filter ("Name = '" + $fixtureName + "'") -OperationTimeoutSec 5 -ErrorAction Stop)
    $captured = @($names | Where-Object { $_.ProcessId -eq $fixtureCapturedPid })
    $containsCaptured = $captured.Count -eq 1
    Write-Output ('Morrowbyte fixture identity: phase={0}; exact_path={1}; same_creation={2}; same_owner={3}; name_count={4}; contains_captured={5}' -f $Phase, $exactPath, $sameCreation, $sameOwner, $names.Count, $containsCaptured)
    Assert-Equal $true $exactPath
    Assert-Equal $true $sameCreation
    Assert-Equal $true $sameOwner
    Assert-Equal $true $containsCaptured
    $fixtureProcess.Refresh()
    Assert-Equal $false $fixtureProcess.HasExited
}
$fixtureReleaseBytes = [Text.Encoding]::ASCII.GetBytes("MORROWBYTE_GUARD_FIXTURE_RELEASE`n")
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
        var expected = System.Text.Encoding.ASCII.GetBytes("MORROWBYTE_GUARD_FIXTURE_RELEASE\n");
        var input = Console.OpenStandardInput();
        for (int i = 0; i < expected.Length; i++) {
            int value = input.ReadByte();
            if (value < 0) { Console.Error.WriteLine("MORROWBYTE_GUARD_FIXTURE_EOF"); return 2; }
            if (value != expected[i]) { Console.Error.WriteLine("MORROWBYTE_GUARD_FIXTURE_MISMATCH"); return 2; }
        }
        Console.Error.WriteLine("MORROWBYTE_GUARD_FIXTURE_MATCHED");
        return 0;
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
    $fixturePhase = 'readiness'
    $fixturePid = $fixtureProcess.Id
    $fixtureCapturedPid = $fixturePid
    $fixtureTerminal = $fixtureProcess.StandardError.ReadLineAsync()
    $ready = $fixtureProcess.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait($fixtureBoundaryTimeoutMs)) { throw 'Owned fixture readiness was not observed.' }
    Assert-Equal 'MORROWBYTE_GUARD_FIXTURE_READY' $ready.Result
    Assert-Equal $false $fixtureProcess.HasExited
    Assert-Equal $fixturePid $fixtureProcess.Id
    $fixturePhase = 'initial-identity'
    Import-Module CimCmdlets -ErrorAction Stop
    Write-FixtureBoundary $fixturePhase
    Assert-FixtureCimIdentity $fixturePhase
    Write-Output ('Morrowbyte guard fixture: pid={0}; exact_image=true; ready=true; sha256={1}' -f $fixturePid, $fixtureHash)

    # Preserve the real Windows PowerShell poisoned-module-environment checks.
    $env:PSModulePath = 'C:\nonexistent-powershell7-modules'
    $env:WinPSModulePath = 'C:\nonexistent-windows-modules'
    $powershell = [IO.Path]::Combine($env:WINDIR, 'System32\WindowsPowerShell\v1.0\powershell.exe')
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\morrowbyte-installer-guard.ps1" -InstallRoot $root -AppExecutable '__morrowbyte_guard_absent_fixture__.exe' -WaitSeconds 0
    Assert-Equal 0 $LASTEXITCODE
    $fixturePhase = 'pre-held'
    Write-FixtureBoundary $fixturePhase
    Assert-FixtureCimIdentity $fixturePhase
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\morrowbyte-installer-guard.ps1" -InstallRoot $fixtureRoot -AppExecutable $fixtureName -WaitSeconds 0
    $heldGuardExit = $LASTEXITCODE
    $fixturePhase = 'post-held'
    Write-Output ('Morrowbyte fixture held query: exit={0}' -f $heldGuardExit)
    Write-FixtureBoundary $fixturePhase
    Assert-FixtureCimIdentity $fixturePhase
    Assert-Equal 10 $heldGuardExit
    Assert-Equal $false $fixtureProcess.HasExited

    $fixturePhase = 'release'
    $fixtureReleaseAttempted = $true
    $fixtureInput = $fixtureProcess.StandardInput.BaseStream
    $fixtureInput.Write($fixtureReleaseBytes, 0, $fixtureReleaseBytes.Length)
    $fixtureInput.Flush()
    $fixtureInput.Close()
    if (-not $fixtureProcess.WaitForExit($fixtureBoundaryTimeoutMs)) { throw 'Owned fixture exit was not observed.' }
    if (-not $fixtureTerminal.Wait($fixtureBoundaryTimeoutMs)) { throw 'Owned fixture terminal classification unavailable.' }
    $fixturePhase = 'post-release'
    Write-FixtureBoundary $fixturePhase
    Assert-Equal 'MORROWBYTE_GUARD_FIXTURE_MATCHED' $fixtureTerminal.Result
    Write-Output ('Morrowbyte guard fixture: release_exit={0}' -f $fixtureProcess.ExitCode)
    Assert-Equal 0 $fixtureProcess.ExitCode
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot\morrowbyte-installer-guard.ps1" -InstallRoot $fixtureRoot -AppExecutable $fixtureName -WaitSeconds 0
    Assert-Equal 0 $LASTEXITCODE
} catch {
    # Never print raw CIM/exception data. Keep the original failure semantics.
    $fixtureFailure = 'Owned fixture failed at static phase: ' + $fixturePhase
} finally {
    Write-FixtureBoundary ('before-cleanup-' + $fixturePhase)
    $env:PSModulePath = $priorModulePath
    $env:WinPSModulePath = $priorWinModulePath
    if ($fixtureStarted) {
        if (-not $fixtureProcess.HasExited) {
            $normalExit = $false
            try {
                $fixtureInput = $fixtureProcess.StandardInput.BaseStream
                $fixtureInput.Write($fixtureReleaseBytes, 0, $fixtureReleaseBytes.Length)
                $fixtureInput.Flush()
                $fixtureInput.Close()
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
