#Requires -Version 5.0
<#
.SYNOPSIS
    Installs agentio CLI on Windows.

.DESCRIPTION
    Downloads and installs the agentio CLI from GitHub releases.

.PARAMETER InstallDir
    Installation directory. Defaults to $env:LOCALAPPDATA\Programs\agentio

.PARAMETER Version
    Specific version to install. Defaults to latest.

.PARAMETER NoModifyPath
    Skip adding installation directory to PATH.

.EXAMPLE
    iwr -useb https://agentio.me/install.ps1 | iex

.EXAMPLE
    .\install.ps1 -InstallDir "C:\tools\agentio" -Version "0.1.8"
#>

[CmdletBinding()]
param(
    [Parameter()]
    [string]$InstallDir = $env:AGENTIO_INSTALL_DIR,

    [Parameter()]
    [string]$Version = $env:AGENTIO_VERSION,

    [Parameter()]
    [switch]$NoModifyPath = [bool]$env:AGENTIO_NO_MODIFY_PATH
)

$ErrorActionPreference = 'Stop'

$GitHubRepo = if ($env:AGENTIO_GITHUB_REPO) { $env:AGENTIO_GITHUB_REPO } else { "plosson/agentio" }
$GitHubToken = $env:AGENTIO_GITHUB_TOKEN

function Write-Info {
    param([string]$Message)
    Write-Host "[info] " -ForegroundColor Blue -NoNewline
    Write-Host $Message
}

function Write-Success {
    param([string]$Message)
    Write-Host "[success] " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[warn] " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Error-Custom {
    param([string]$Message)
    Write-Host "[error] " -ForegroundColor Red -NoNewline
    Write-Host $Message
    exit 1
}

function Get-Architecture {
    if ([System.Environment]::Is64BitOperatingSystem) {
        $arch = $env:PROCESSOR_ARCHITECTURE
        if ($arch -eq "ARM64") {
            Write-Error-Custom "ARM64 is not yet supported on Windows"
        }
        return "x64"
    }
    Write-Error-Custom "32-bit Windows is not supported"
}

function Get-InstallDirectory {
    # 1. Explicit parameter
    if ($InstallDir) {
        return $InstallDir
    }

    # 2. Existing installation
    $existing = Get-Command agentio -ErrorAction SilentlyContinue
    if ($existing) {
        return Split-Path $existing.Source
    }

    # 3. XDG_BIN_HOME (cross-platform compat)
    if ($env:XDG_BIN_HOME) {
        return $env:XDG_BIN_HOME
    }

    # 4. Windows standard location
    if ($env:LOCALAPPDATA) {
        return Join-Path $env:LOCALAPPDATA "Programs\agentio"
    }

    # 5. Fallback
    return Join-Path $env:USERPROFILE ".local\bin"
}

function Get-LatestVersion {
    $url = "https://api.github.com/repos/$GitHubRepo/releases/latest"
    $headers = @{
        "Accept" = "application/vnd.github.v3+json"
        "User-Agent" = "agentio-installer"
    }

    if ($GitHubToken) {
        $headers["Authorization"] = "Bearer $GitHubToken"
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
        return $response.tag_name -replace '^v', ''
    }
    catch {
        Write-Error-Custom "Failed to fetch latest version: $_"
    }
}

function Download-Binary {
    param(
        [string]$Version,
        [string]$Destination
    )

    $url = "https://github.com/$GitHubRepo/releases/download/v$Version/agentio-windows-x64.exe"
    $headers = @{
        "User-Agent" = "agentio-installer"
    }

    if ($GitHubToken) {
        $headers["Authorization"] = "Bearer $GitHubToken"
    }

    Write-Info "Downloading agentio v$Version for Windows x64..."

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $Destination -Headers $headers -UseBasicParsing
    }
    catch {
        Write-Error-Custom "Download failed: $_"
    }

    if (-not (Test-Path $Destination) -or (Get-Item $Destination).Length -eq 0) {
        Write-Error-Custom "Download failed or file is empty"
    }
}

function Add-ToPath {
    param([string]$Directory)

    # Check if already in PATH
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -split ';' | Where-Object { $_ -eq $Directory }) {
        return
    }

    # Add to user PATH via registry
    try {
        $newPath = "$Directory;$currentPath"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")

        # Update current session
        $env:Path = "$Directory;$env:Path"

        Write-Warn "Added $Directory to PATH"
        Write-Warn "Restart your terminal to use agentio globally"

        # Notify Windows of environment change
        if (-not ("Win32.NativeMethods" -as [Type])) {
            Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
        }
        $HWND_BROADCAST = [IntPtr] 0xffff
        $WM_SETTINGCHANGE = 0x1a
        $result = [UIntPtr]::Zero
        [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", 2, 5000, [ref] $result) | Out-Null
    }
    catch {
        Write-Warn "Failed to update PATH automatically: $_"
        Write-Warn "Please add $Directory to your PATH manually"
    }

    # Handle GitHub Actions
    if ($env:GITHUB_ACTIONS -and $env:GITHUB_PATH) {
        Add-Content -Path $env:GITHUB_PATH -Value $Directory
    }
}

function Main {
    Write-Info "agentio installer for Windows"

    # Check PowerShell version
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        Write-Error-Custom "PowerShell 5.0 or later is required"
    }

    $arch = Get-Architecture
    $installDir = Get-InstallDirectory

    # Get version
    if (-not $Version) {
        Write-Info "Fetching latest version..."
        $Version = Get-LatestVersion
    }

    Write-Info "Installing agentio v$Version to $installDir"

    # Create install directory
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    # Download to temp file
    $tempFile = Join-Path $env:TEMP "agentio-$Version.exe"
    Download-Binary -Version $Version -Destination $tempFile

    # Move to install directory
    $targetPath = Join-Path $installDir "agentio.exe"

    # Remove existing (handle symbolic links)
    if (Test-Path $targetPath) {
        Remove-Item $targetPath -Force
    }

    Move-Item -Path $tempFile -Destination $targetPath -Force

    Write-Success "Installed agentio v$Version to $targetPath"

    # Add to PATH
    if (-not $NoModifyPath) {
        Add-ToPath -Directory $installDir
    }

    # Verify installation
    $agentio = Get-Command agentio -ErrorAction SilentlyContinue
    if ($agentio) {
        Write-Success "agentio is ready to use!"
    }
    else {
        Write-Warn "agentio installed but not in PATH"
        Write-Warn "Run: $targetPath"
    }
}

Main
