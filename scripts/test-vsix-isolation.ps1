param()

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$assertScript = Join-Path $repo 'scripts/assert-vsix.ps1'
$workspace = Join-Path ([System.IO.Path]::GetTempPath()) "wfd-vsix-isolation-$([System.Guid]::NewGuid().ToString('N'))"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-TestPe([string] $Path, [string] $Machine) {
  $directory = Split-Path -Parent $Path
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
  $bytes = New-Object byte[] 512
  $bytes[0] = 0x4d
  $bytes[1] = 0x5a
  [System.BitConverter]::GetBytes([int] 0x80).CopyTo($bytes, 0x3c)
  $bytes[0x80] = 0x50
  $bytes[0x81] = 0x45
  $bytes[0x82] = 0
  $bytes[0x83] = 0
  $machineValue = if ($Machine -eq '0xAA64') { [uint16] 0xAA64 } else { [uint16] 0x8664 }
  [System.BitConverter]::GetBytes($machineValue).CopyTo($bytes, 0x84)
  [System.IO.File]::WriteAllBytes($Path, $bytes)
}

function Set-TestText([string] $Path, [string] $Value) {
  $directory = Split-Path -Parent $Path
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
  Set-Content -LiteralPath $Path -Value $Value -Encoding UTF8
}

function New-TestVsix([string] $Name, [hashtable] $Options) {
  $source = Join-Path $workspace $Name
  $vsix = Join-Path $workspace "$Name.vsix"
  $zip = Join-Path $workspace "$Name.zip"
  New-Item -ItemType Directory -Path $source | Out-Null

  $target = if ($Options.ContainsKey('Target')) { $Options.Target } else { 'win32-x64' }
  $rid = if ($Options.ContainsKey('Rid')) { $Options.Rid } else { 'win-x64' }
  $machine = if ($Options.ContainsKey('Machine')) { $Options.Machine } else { '0x8664' }
  $net48Machine = if ($Options.ContainsKey('Net48Machine')) { $Options.Net48Machine } else { '0x8664' }

  Set-TestText (Join-Path $source 'extension.vsixmanifest') "<PackageManifest><InstallationTarget TargetPlatform=`"$target`" /></PackageManifest>"
  Set-TestText (Join-Path $source 'extension/package.json') '{"version":"1.15.0","preview":false}'
  Set-TestText (Join-Path $source 'extension/THIRD-PARTY-NOTICES.md') 'test notices'
  Set-TestText (Join-Path $source 'extension/engine/WinFormsDesigner.Engine.dll') 'modern dll'
  Set-TestText (Join-Path $source 'extension/engine/WinFormsDesigner.Engine.runtimeconfig.json') '{"runtimeOptions":{"tfm":"net10.0","frameworks":[{"name":"Microsoft.WindowsDesktop.App","version":"10.0.0"}]}}'

  $depsTargets = @{
    '.NETCoreApp,Version=v10.0' = @{}
    ".NETCoreApp,Version=v10.0/$rid" = @{
      'StreamJsonRpc/2.25.29' = @{}
      'MessagePack/2.5.302' = @{}
    }
  }
  if ($Options.ContainsKey('IncludeSiblingRid') -and $Options.IncludeSiblingRid) {
    $siblingRid = if ($rid -eq 'win-x64') { 'win-arm64' } else { 'win-x64' }
    $depsTargets[".NETCoreApp,Version=v10.0/$siblingRid"] = @{}
  }
  Set-TestText (Join-Path $source 'extension/engine/WinFormsDesigner.Engine.deps.json') (@{ targets = $depsTargets } | ConvertTo-Json -Depth 8)

  New-TestPe (Join-Path $source 'extension/engine/WinFormsDesigner.Engine.exe') $machine
  New-TestPe (Join-Path $source 'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe') $net48Machine
  Set-TestText (Join-Path $source 'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe.config') '<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" /></startup></configuration>'

  if ($Options.ContainsKey('ExtraEntries')) {
    foreach ($entry in @($Options.ExtraEntries)) {
      Set-TestText (Join-Path $source $entry) 'contamination'
    }
  }
  if ($Options.ContainsKey('BadNet48Config') -and $Options.BadNet48Config) {
    Set-TestText (Join-Path $source 'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe.config') '<configuration />'
  }
  if ($Options.ContainsKey('BadModernPe') -and $Options.BadModernPe) {
    Set-TestText (Join-Path $source 'extension/engine/WinFormsDesigner.Engine.exe') 'not a pe'
  }

  [System.IO.Compression.ZipFile]::CreateFromDirectory($source, $zip)
  Move-Item -LiteralPath $zip -Destination $vsix
  return $vsix
}

function Invoke-AssertVsix([string] $Vsix, [switch] $ShouldFail, [string] $ExpectedMessage) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertScript -VsixPath $Vsix -ExpectedTarget win32-x64 -ExpectedRuntimeIdentifier win-x64 -ExpectedModernMachine 0x8664 -ExpectedNet48Machine 0x8664 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($ShouldFail) {
    if ($exitCode -eq 0) {
      throw "Expected assert-vsix to fail for $Vsix."
    }
    if ($ExpectedMessage -and $output -notmatch [regex]::Escape($ExpectedMessage)) {
      throw "Expected failure containing '$ExpectedMessage'. Actual output: $output"
    }
    return
  }
  if ($exitCode -ne 0) {
    throw "Expected assert-vsix to pass for $Vsix. Actual output: $output"
  }
}

try {
  New-Item -ItemType Directory -Path $workspace | Out-Null

  Invoke-AssertVsix (New-TestVsix 'valid-x64' @{})
  Invoke-AssertVsix (New-TestVsix 'net48-in-modern-dir' @{
      ExtraEntries = @('extension/engine/WinFormsDesigner.Engine.Net48.exe')
    }) -ShouldFail -ExpectedMessage 'wrong target directory'
  Invoke-AssertVsix (New-TestVsix 'modern-in-net48-dir' @{
      ExtraEntries = @('extension/engine-net48/WinFormsDesigner.Engine.runtimeconfig.json')
    }) -ShouldFail -ExpectedMessage 'wrong target directory'
  Invoke-AssertVsix (New-TestVsix 'sibling-rid' @{
      IncludeSiblingRid = $true
    }) -ShouldFail -ExpectedMessage 'also contains win-arm64 targets'
  Invoke-AssertVsix (New-TestVsix 'bad-net48-config' @{
      BadNet48Config = $true
    }) -ShouldFail -ExpectedMessage '.NET Framework 4.8'
  Invoke-AssertVsix (New-TestVsix 'bad-modern-pe' @{
      BadModernPe = $true
    }) -ShouldFail -ExpectedMessage 'too small to be a PE image'
  Invoke-AssertVsix (New-TestVsix 'development-v2-cli' @{
      ExtraEntries = @('extension/dist/v2-headless-validate.cjs', 'extension/dist/v2-soak.cjs')
    }) -ShouldFail -ExpectedMessage 'v2-headless-validate.cjs'

  Write-Host 'assert-vsix isolation tests passed.'
} finally {
  if (Test-Path -LiteralPath $workspace) {
    Remove-Item -LiteralPath $workspace -Recurse -Force
  }
}

# The final isolation case is expected to fail in its child powershell.exe process. Do not leak that deliberately
# non-zero child status to this otherwise successful test script (and therefore to the CI step).
$global:LASTEXITCODE = 0
