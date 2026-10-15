[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$AppExecutable,
    [ValidateRange(0, 120)][int]$WaitSeconds = 30,
    [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-MorrowbyteInstallState {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$CurrentSid,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Processes,
        [Parameter(Mandatory = $true)][scriptblock]$OwnerSid
    )
    if ($Root -notmatch '^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or $Executable -ne [IO.Path]::GetFileName($Executable)) {
        throw 'Invalid installer process identity.'
    }
    $directory = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $expected = [IO.Path]::GetFullPath([IO.Path]::Combine($directory, $Executable))
    foreach ($process in $Processes) {
        # The query includes only the exact image name. An inaccessible path or
        # owner cannot establish that this is a different installation.
        if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
            throw 'Cannot determine the running application path.'
        }
        $path = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
        if (-not $path.StartsWith($directory, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (-not $path.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected matching application beneath the installation directory.'
        }
        $sid = & $OwnerSid $process
        if ([string]::IsNullOrWhiteSpace([string]$sid)) { throw 'Cannot determine application owner.' }
        if ($sid -ne $CurrentSid) { throw 'Another account owns an application in this installation.' }
        return 'running'
    }
    return 'clear'
}

if ($LibraryOnly) { return }

$verificationStage = 'module-import'
try {
    # This is the installer child environment, never a machine/user setting.
    # A PowerShell 7 parent must not redirect Windows PowerShell module loading.
    $env:PSModulePath = [IO.Path]::Combine($env:WINDIR, 'System32\WindowsPowerShell\v1.0\Modules')
    $env:WinPSModulePath = $null
    Import-Module CimCmdlets -ErrorAction Stop
    $verificationStage = 'installer-identity'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ([string]::IsNullOrWhiteSpace($identity)) { throw 'Cannot determine installer account.' }
    # Avoid embedding installation paths in PowerShell expressions or WQL.
    $verificationStage = 'arguments'
    if ([string]::IsNullOrWhiteSpace($AppExecutable) -or $AppExecutable.Contains("'")) {
        throw 'Invalid application executable name.'
    }
    $query = "Name = '" + $AppExecutable + "'"
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
        $verificationStage = 'process-query'
        $processes = @(Get-CimInstance -ClassName Win32_Process -Filter $query -OperationTimeoutSec 5 -ErrorAction Stop)
        $verificationStage = 'state-check'
        $state = Get-MorrowbyteInstallState -Root $InstallRoot -Executable $AppExecutable -CurrentSid $identity -Processes $processes -OwnerSid {
            param($process)
            $script:verificationStage = 'owner-query'
            $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop
            $script:verificationStage = 'owner-result'
            if ($owner.ReturnValue -ne 0) { throw 'Application owner lookup failed.' }
            return $owner.Sid
        }
        if ($state -eq 'clear') { exit 0 }
        if ($deadline.Elapsed.TotalSeconds -ge $WaitSeconds) { exit 10 }
        Start-Sleep -Milliseconds 250
    } while ($true)
} catch {
    # Return metadata only. Never fall back to taskkill/image-name matching.
    # Classify only fixed messages emitted above; never print exception/CIM text.
    $reason = switch ($_.Exception.Message) {
        'Invalid installer process identity.' { 'invalid-install-identity'; break }
        'Cannot determine the running application path.' { 'process-path-unavailable'; break }
        'Unexpected matching application beneath the installation directory.' { 'unexpected-nested-process'; break }
        'Cannot determine application owner.' { 'owner-sid-unavailable'; break }
        'Another account owns an application in this installation.' { 'owner-mismatch'; break }
        'Cannot determine installer account.' { 'installer-sid-unavailable'; break }
        'Invalid application executable name.' { 'invalid-executable-name'; break }
        'Application owner lookup failed.' { 'owner-query-return-failed'; break }
        default { 'unclassified-verification-failure' }
    }
    [Console]::Error.WriteLine('Morrowbyte installer could not safely verify the application process.')
    [Console]::Error.WriteLine(('Morrowbyte guard verification: stage={0}; reason={1}' -f $verificationStage, $reason))
    exit 20
}
