param(
  [Parameter(Mandatory = $true)]
  [string] $VsixPath
)

$ErrorActionPreference = 'Stop'
$resolvedVsix = (Resolve-Path -LiteralPath $VsixPath).Path

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($resolvedVsix)

try {
  $names = $zip.Entries.FullName
  $required = @(
    'extension/engine/WinFormsDesigner.Engine.exe',
    'extension/engine/WinFormsDesigner.Engine.dll',
    'extension/engine/WinFormsDesigner.Engine.deps.json',
    'extension/engine/WinFormsDesigner.Engine.runtimeconfig.json',
    'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe',
    # attribution for redistributed third-party material (codicon font is CC BY 4.0 — attribution is mandatory)
    'extension/THIRD-PARTY-NOTICES.md'
  )
  $missing = @($required | Where-Object { $names -notcontains $_ })
  if ($missing.Count -gt 0) {
    throw "VSIX is missing required files: $($missing -join ', ')"
  }

  $forbidden = @($names | Where-Object {
    $_ -match '^extension/(?:src|\.vscode-test|\.dotnet-home|\.dotnet-temp)/' -or
    $_ -match 'extension-host-suite|(?:^|/)e2e\.cjs$|webview-e2e\.cjs$'
  })
  if ($forbidden.Count -gt 0) {
    throw "VSIX contains development/test files: $($forbidden -join ', ')"
  }

  function Read-ZipText([string] $Name) {
    $entry = $zip.GetEntry($Name)
    if (-not $entry) { throw "VSIX entry not found: $Name" }
    $reader = [System.IO.StreamReader]::new($entry.Open())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  }

  function Get-ZipPeMachine([string] $Name) {
    $entry = $zip.GetEntry($Name)
    if (-not $entry) { throw "VSIX entry not found: $Name" }
    $source = $entry.Open()
    $memory = [System.IO.MemoryStream]::new()
    try {
      $source.CopyTo($memory)
      $memory.Position = 0
      $reader = [System.IO.BinaryReader]::new($memory, [System.Text.Encoding]::UTF8, $true)
      try {
        $memory.Position = 0x3c
        $peOffset = $reader.ReadInt32()
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
  if ($manifest -notmatch 'TargetPlatform="win32-x64"') {
    throw 'VSIX manifest is not targeted to win32-x64.'
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

  $modernMachine = Get-ZipPeMachine 'extension/engine/WinFormsDesigner.Engine.exe'
  $net48Machine = Get-ZipPeMachine 'extension/engine-net48/WinFormsDesigner.Engine.Net48.exe'
  if ($modernMachine -ne '0x8664' -or $net48Machine -ne '0x8664') {
    throw "VSIX engines are not both AMD64: modern=$modernMachine, net48=$net48Machine"
  }

  $item = Get-Item -LiteralPath $resolvedVsix
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedVsix).Hash
  Write-Host "VSIX verified: version=$($package.version), target=win32-x64, tfm=$($runtime.runtimeOptions.tfm), desktop=$($desktop[0].version), entries=$($zip.Entries.Count), bytes=$($item.Length), sha256=$hash"
} finally {
  $zip.Dispose()
}
