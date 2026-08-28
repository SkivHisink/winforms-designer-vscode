param(
  [Parameter(Mandatory = $true)]
  [string] $VsixPath,

  [Parameter(Mandatory = $false)]
  [ValidateSet('win32-x64', 'win32-arm64')]
  [string] $ExpectedTarget = 'win32-x64',

  [Parameter(Mandatory = $false)]
  [ValidateSet('win-x64', 'win-arm64')]
  [string] $ExpectedRuntimeIdentifier = 'win-x64',

  [Parameter(Mandatory = $false)]
  [ValidateSet('0x8664', '0xAA64')]
  [string] $ExpectedModernMachine = '0x8664',

  [Parameter(Mandatory = $false)]
  [ValidateSet('0x8664')]
  [string] $ExpectedNet48Machine = '0x8664'
)

$ErrorActionPreference = 'Stop'
$resolvedVsix = (Resolve-Path -LiteralPath $VsixPath).Path

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($resolvedVsix)

try {
  $names = @()
  $entriesByName = @{}
  foreach ($entry in $zip.Entries) {
    $normalizedName = $entry.FullName -replace '\\', '/'
    $names += $normalizedName
    if (-not $entriesByName.ContainsKey($normalizedName)) {
      $entriesByName[$normalizedName] = $entry
    }
  }
  $required = @(
    'extension/engine/WinFormsDesigner.Engine.exe',
    'extension/engine/WinFormsDesigner.Engine.dll',
    'extension/engine/WinFormsDesigner.Engine.deps.json',
    'extension/engine/WinFormsDesigner.Engine.runtimeconfig.json',
    'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe',
    'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe.config',
    # attribution for redistributed third-party material (codicon font is CC BY 4.0 — attribution is mandatory)
    'extension/THIRD-PARTY-NOTICES.md'
  )
  $missing = @($required | Where-Object { $names -notcontains $_ })
  if ($missing.Count -gt 0) {
    throw "VSIX is missing required files: $($missing -join ', ')"
  }

  $duplicates = @($names | Group-Object | Where-Object { $_.Count -gt 1 } | Select-Object -ExpandProperty Name)
  if ($duplicates.Count -gt 0) {
    throw "VSIX contains duplicate entries: $($duplicates -join ', ')"
  }

  foreach ($requiredName in $required) {
    $matches = @($names | Where-Object { $_ -eq $requiredName })
    if ($matches.Count -ne 1) {
      throw "VSIX must contain exactly one $requiredName entry; found $($matches.Count)."
    }
  }

  $forbidden = @($names | Where-Object {
    $_ -match '^extension/(?:src|\.vscode-test|\.dotnet-home|\.dotnet-temp)/' -or
    $_ -match 'extension-host-suite|(?:^|/)e2e\.cjs$|webview-e2e\.cjs$|v2-headless-validate\.cjs$|v2-soak\.cjs$'
  })
  if ($forbidden.Count -gt 0) {
    throw "VSIX contains development/test files: $($forbidden -join ', ')"
  }

  $crossTargetFiles = @($names | Where-Object {
    $_ -match '^extension/engine/WinFormsDesigner\.Engine\.Net48(?:\.|$)' -or
    $_ -eq 'extension/engine/WinFormsDesigner.Engine.exe.config' -or
    $_ -match '^extension/engine-net48/WinFormsDesigner\.Engine(?:\.exe|\.dll|\.deps\.json|\.runtimeconfig\.json)$'
  })
  if ($crossTargetFiles.Count -gt 0) {
    throw "VSIX contains engine files in the wrong target directory: $($crossTargetFiles -join ', ')"
  }

  function Read-ZipText([string] $Name) {
    $entry = $entriesByName[$Name]
    if (-not $entry) { throw "VSIX entry not found: $Name" }
    $reader = [System.IO.StreamReader]::new($entry.Open())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  }

  function Get-ZipPeMachine([string] $Name) {
    $entry = $entriesByName[$Name]
    if (-not $entry) { throw "VSIX entry not found: $Name" }
    $source = $entry.Open()
    $memory = [System.IO.MemoryStream]::new()
    try {
      $source.CopyTo($memory)
      $memory.Position = 0
      $reader = [System.IO.BinaryReader]::new($memory, [System.Text.Encoding]::UTF8, $true)
      try {
        if ($memory.Length -lt 0x40) {
          throw "VSIX entry is too small to be a PE image: $Name"
        }
        if ($reader.ReadUInt16() -ne 0x5A4D) {
          throw "VSIX entry does not have an MZ header: $Name"
        }
        $memory.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or ($peOffset + 6) -gt $memory.Length) {
          throw "VSIX entry has an invalid PE header offset: $Name"
        }
        $memory.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
          throw "VSIX entry does not have a PE signature: $Name"
        }
        $memory.Position = $peOffset + 4
        return ('0x{0:X4}' -f $reader.ReadUInt16())
      } finally {
        $reader.Dispose()
      }
    } finally {
      $source.Dispose()
      $memory.Dispose()
    }
  }

  $manifest = Read-ZipText 'extension.vsixmanifest'
  if ($manifest -notmatch "TargetPlatform=`"$([regex]::Escape($ExpectedTarget))`"") {
    throw "VSIX manifest is not targeted to $ExpectedTarget."
  }

  $package = (Read-ZipText 'extension/package.json') | ConvertFrom-Json
  if ($package.preview -ne $false -or $package.version -notmatch '^\d+\.\d+\.\d+$') {
    throw "VSIX metadata is not a stable SemVer release: version=$($package.version), preview=$($package.preview)"
  }

  $runtime = (Read-ZipText 'extension/engine/WinFormsDesigner.Engine.runtimeconfig.json') | ConvertFrom-Json
  if ($runtime.runtimeOptions.tfm -ne 'net10.0') {
    throw "Unexpected modern engine TFM: $($runtime.runtimeOptions.tfm)"
  }
  $desktop = @($runtime.runtimeOptions.frameworks | Where-Object name -eq 'Microsoft.WindowsDesktop.App')
  if ($desktop.Count -ne 1 -or $desktop[0].version -notmatch '^10\.') {
    throw 'Modern engine does not require Microsoft.WindowsDesktop.App 10.x.'
  }

  $deps = Read-ZipText 'extension/engine/WinFormsDesigner.Engine.deps.json'
  if ($deps -notmatch 'StreamJsonRpc/2\.25\.29' -or $deps -notmatch 'MessagePack/2\.5\.302') {
    throw 'Bundled modern engine does not contain the audited StreamJsonRpc/MessagePack versions.'
  }
  $depsJson = $deps | ConvertFrom-Json
  $targetNames = @($depsJson.targets.PSObject.Properties | ForEach-Object { $_.Name })
  if (-not ($targetNames | Where-Object { $_.EndsWith("/$ExpectedRuntimeIdentifier") })) {
    throw "Bundled modern engine deps.json does not target $ExpectedRuntimeIdentifier."
  }
  $unexpectedRuntimeIdentifier = if ($ExpectedRuntimeIdentifier -eq 'win-x64') { 'win-arm64' } else { 'win-x64' }
  $unexpectedTargets = @($targetNames | Where-Object { $_.EndsWith("/$unexpectedRuntimeIdentifier") })
  if ($unexpectedTargets.Count -gt 0) {
    throw "Bundled modern engine deps.json also contains $unexpectedRuntimeIdentifier targets: $($unexpectedTargets -join ', ')"
  }

  $net48Config = Read-ZipText 'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe.config'
  if ($net48Config -notmatch '\.NETFramework,Version=v4\.8') {
    throw 'net48 compatibility engine config does not declare .NET Framework 4.8.'
  }

  $modernMachine = Get-ZipPeMachine 'extension/engine/WinFormsDesigner.Engine.exe'
  $net48Machine = Get-ZipPeMachine 'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe'
  if ($modernMachine -ne $ExpectedModernMachine) {
    throw "Modern engine apphost has unexpected PE machine: actual=$modernMachine, expected=$ExpectedModernMachine"
  }
  if ($net48Machine -ne $ExpectedNet48Machine) {
    throw "net48 compatibility engine has unexpected PE machine: actual=$net48Machine, expected=$ExpectedNet48Machine"
  }

  $item = Get-Item -LiteralPath $resolvedVsix
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedVsix).Hash
  Write-Host "VSIX verified: version=$($package.version), target=$ExpectedTarget, rid=$ExpectedRuntimeIdentifier, tfm=$($runtime.runtimeOptions.tfm), desktop=$($desktop[0].version), modernMachine=$modernMachine, net48Machine=$net48Machine, entries=$($zip.Entries.Count), bytes=$($item.Length), sha256=$hash"
} finally {
  $zip.Dispose()
}
