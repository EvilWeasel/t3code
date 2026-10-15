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
$fixtureInputCodePage = 'unknown'
$fixtureInputPreamble = 'unknown'
# Closed metadata only; never format the preamble byte array or arbitrary pipe bytes.
function Get-FixturePreambleClass([AllowEmptyCollection()][byte[]]$Preamble) {
    if ($null -eq $Preamble) { return 'unavailable' }
    if ($Preamble.Length -eq 0) { return 'none' }
    if ($Preamble.Length -eq 3 -and $Preamble[0] -eq 239 -and $Preamble[1] -eq 187 -and $Preamble[2] -eq 191) { return 'utf8' }
    if ($Preamble.Length -eq 2 -and $Preamble[0] -eq 255 -and $Preamble[1] -eq 254) { return 'utf16-le' }
    if ($Preamble.Length -eq 2 -and $Preamble[0] -eq 254 -and $Preamble[1] -eq 255) { return 'utf16-be' }
    if ($Preamble.Length -eq 4 -and $Preamble[0] -eq 255 -and $Preamble[1] -eq 254 -and $Preamble[2] -eq 0 -and $Preamble[3] -eq 0) { return 'utf32-le' }
    if ($Preamble.Length -eq 4 -and $Preamble[0] -eq 0 -and $Preamble[1] -eq 0 -and $Preamble[2] -eq 254 -and $Preamble[3] -eq 255) { return 'utf32-be' }
    return 'other'
}
# Fixed privacy-classifier cases only, no console mutation or native operation.
Assert-Equal 'none' (Get-FixturePreambleClass -Preamble ([byte[]]@()))
Assert-Equal 'utf8' (Get-FixturePreambleClass -Preamble ([byte[]]@(239,187,191)))
Assert-Equal 'utf16-le' (Get-FixturePreambleClass -Preamble ([byte[]]@(255,254)))
Assert-Equal 'utf16-be' (Get-FixturePreambleClass -Preamble ([byte[]]@(254,255)))
Assert-Equal 'utf32-le' (Get-FixturePreambleClass -Preamble ([byte[]]@(255,254,0,0)))
Assert-Equal 'utf32-be' (Get-FixturePreambleClass -Preamble ([byte[]]@(0,0,254,255)))
Assert-Equal 'other' (Get-FixturePreambleClass -Preamble ([byte[]]@(239,187)))
Assert-Equal 'other' (Get-FixturePreambleClass -Preamble ([byte[]]@(1,2,3)))
# Static state only, captured before cleanup can release/dispose the owned child.
function Write-FixtureBoundary([string]$Phase) {
    $alive = 'unknown'; $exitCode = 'unknown'; $moduleAvailable = 'unknown'; $terminal = 'pending'
    $mismatchIndex = 'unknown'; $mismatchClass = 'unknown'
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
            $terminal = switch -Regex ($fixtureTerminal.Result) {
                '^MORROWBYTE_GUARD_FIXTURE_EOF$' { 'eof-before-release'; break }
                '^MORROWBYTE_GUARD_FIXTURE_MISMATCH:([0-9]{1,2}):(prefix-ef|prefix-ff|prefix-fe|nul|lf|cr|ascii-other|other)$' {
                    $index = [int]$Matches[1]
                    if ($index -lt $fixtureReleaseBytes.Length) {
                        $mismatchIndex = $index
                        $mismatchClass = $Matches[2]
                        'nonmatching-release'
                    } else { 'unclassified-terminal' }
                    break
                }
                '^MORROWBYTE_GUARD_FIXTURE_MATCHED$' { 'matched-release'; break }
                '^MORROWBYTE_GUARD_FIXTURE_CLASSIFICATION_ERROR$' { 'classification-error'; break }
                default { 'unclassified-terminal'; break }
            }
        } catch { $terminal = 'unavailable' }
    }
    Write-Output ('Morrowbyte fixture boundary: phase={0}; alive={1}; exit={2}; module={3}; release_attempted={4}; terminal={5}; pid={6}' -f $Phase, $alive, $exitCode, $moduleAvailable, $fixtureReleaseAttempted, $terminal, $(if ($null -eq $fixtureCapturedPid) { 'unknown' } else { $fixtureCapturedPid }))
    Write-Output ('Morrowbyte fixture input: code_page={0}; preamble_class={1}; mismatch_index={2}; byte_class={3}' -f $fixtureInputCodePage, $fixtureInputPreamble, $mismatchIndex, $mismatchClass)
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
    private static string ByteClass(int value) {
        if (value == 239) return "prefix-ef";
        if (value == 255) return "prefix-ff";
        if (value == 254) return "prefix-fe";
        if (value == 0) return "nul";
        if (value == 10) return "lf";
        if (value == 13) return "cr";
        return value < 128 ? "ascii-other" : "other";
    }
    private static readonly byte[] StartupHeader = new byte[] { 239, 187, 191 };
    private static readonly byte[] ReleaseToken = System.Text.Encoding.ASCII.GetBytes("MORROWBYTE_GUARD_FIXTURE_RELEASE\n");
    private static bool ReadExact(System.IO.Stream input, byte[] expected, out int index, out int value) {
        index = 0; value = -1;
        for (; index < expected.Length; index++) {
            value = input.ReadByte();
            if (value != expected[index]) return false;
        }
        return true;
    }
    private static byte[] Join(byte[] left, byte[] right) {
        var result = new byte[left.Length + right.Length];
        Buffer.BlockCopy(left, 0, result, 0, left.Length);
        Buffer.BlockCopy(right, 0, result, left.Length, right.Length);
        return result;
    }
    private static bool MatchesFrame(byte[] bytes) {
        using (var input = new System.IO.MemoryStream(bytes)) {
            int index, value;
            return ReadExact(input, StartupHeader, out index, out value)
                && ReadExact(input, ReleaseToken, out index, out value);
        }
    }
    private static bool ProtocolCasesPass() {
        var valid = Join(StartupHeader, ReleaseToken);
        var changedToken = (byte[])ReleaseToken.Clone(); changedToken[0] = 88;
        var partialToken = new byte[ReleaseToken.Length - 1];
        Buffer.BlockCopy(ReleaseToken, 0, partialToken, 0, partialToken.Length);
        return MatchesFrame(valid)
            && !MatchesFrame(ReleaseToken)
            && !MatchesFrame(new byte[0])
            && !MatchesFrame(new byte[] { 239 })
            && !MatchesFrame(new byte[] { 239, 187 })
            && !MatchesFrame(StartupHeader)
            && !MatchesFrame(Join(new byte[] { 239, 187, 190 }, ReleaseToken))
            && !MatchesFrame(Join(new byte[] { 255, 254 }, ReleaseToken))
            && !MatchesFrame(Join(StartupHeader, valid))
            && !MatchesFrame(Join(StartupHeader, partialToken))
            && !MatchesFrame(Join(StartupHeader, changedToken));
    }
    private static int Refuse(int index, int value) {
        if (value < 0) Console.Error.WriteLine("MORROWBYTE_GUARD_FIXTURE_EOF");
        else Console.Error.WriteLine("MORROWBYTE_GUARD_FIXTURE_MISMATCH:{0}:{1}", index, ByteClass(value));
        return 2;
    }
    public static int Main() {
        if (ByteClass(239) != "prefix-ef" || ByteClass(255) != "prefix-ff" ||
            ByteClass(254) != "prefix-fe" || ByteClass(0) != "nul" ||
            ByteClass(10) != "lf" || ByteClass(13) != "cr" ||
            ByteClass(77) != "ascii-other" || ByteClass(128) != "other") {
            Console.Error.WriteLine("MORROWBYTE_GUARD_FIXTURE_CLASSIFICATION_ERROR");
            return 2;
        }
        if (!ProtocolCasesPass()) {
            Console.Error.WriteLine("MORROWBYTE_GUARD_FIXTURE_CLASSIFICATION_ERROR");
            return 2;
        }
        var input = Console.OpenStandardInput();
        int mismatchIndex, received;
        // Mandatory fixed startup frame, never an optional BOM-skipping decoder.
        if (!ReadExact(input, StartupHeader, out mismatchIndex, out received)) return Refuse(mismatchIndex, received);
        Console.WriteLine("MORROWBYTE_GUARD_FIXTURE_READY");
        Console.Out.Flush();
        if (!ReadExact(input, ReleaseToken, out mismatchIndex, out received)) return Refuse(mismatchIndex, received);
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
    # Read only immediately before Start; do not change process/console encoding.
    $inputEncoding = [Console]::InputEncoding
    $fixtureInputCodePage = $inputEncoding.CodePage
    $fixtureInputPreamble = Get-FixturePreambleClass -Preamble $inputEncoding.GetPreamble()
    # Require the exact reviewed UTF8 startup frame before any native spawn.
    # Get-FixturePreambleClass returns utf8 only for exactly EF BB BF.
    Assert-Equal 65001 $fixtureInputCodePage
    Assert-Equal 'utf8' $fixtureInputPreamble
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
