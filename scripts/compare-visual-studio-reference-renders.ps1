param(
  [Parameter(Mandatory = $false)]
  [string] $OutputDirectory,

  [Parameter(Mandatory = $false)]
  [switch] $SkipBuild,

  [Parameter(Mandatory = $false)]
  [double] $MaxMeanAbsoluteErrorPerChannel = 1.0,

  [Parameter(Mandatory = $false)]
  [double] $MaxDifferentPixelPercent = 1.0,

  [Parameter(Mandatory = $false)]
  [string] $ScenarioEvidenceFile = $env:WFD_VISUAL_REFERENCE_EVIDENCE_FILE
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repo '.codex-tmp/vs-reference-comparison/latest'
}
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null

function Invoke-Checked([string] $Description, [scriptblock] $Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

function Invoke-Net48InterpretedRender(
  [string] $Description,
  [string] $Engine,
  [string] $Source,
  [string] $Assembly,
  [string] $TypeName,
  [string] $Destination) {
  $previousErrorActionPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $log = @(& $Engine --render-interpreted $Source --asm $Assembly --type $TypeName --out $Destination 2>&1); $exitCode = $LASTEXITCODE } finally { $ErrorActionPreference = $previousErrorActionPreference }
  foreach ($line in $log) { Write-Host $line }
  if ($exitCode -ne 0) { throw "$Description failed with exit code $exitCode" }
  if (($log -join [Environment]::NewLine) -notmatch '\[render-interpreted\]\s+mode=interpreted(?:\s|$)') {
    throw "$Description returned a compiled/fallback render instead of the required live-source interpreted mode."
  }
}

function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256([string] $Text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $hash = [System.Security.Cryptography.SHA256]::HashData($bytes)
  return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Write-Json([string] $Path, $Value) {
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

if (-not $SkipBuild) {
  Push-Location $repo
  try {
    Invoke-Checked 'modern engine build' { dotnet build engine/Engine.csproj -c Release --no-incremental }
    Invoke-Checked 'net48 engine build' { dotnet build engine-net48/Engine.Net48.csproj -c Release --no-incremental }
    Invoke-Checked 'net48 Visual Studio reference fixture build' {
      dotnet build fixtures/VisualStudioReference/Net48/VisualStudioReference.Net48.csproj -c Release --no-incremental
    }
  } finally {
    Pop-Location
  }
}

$modernEngine = Join-Path $repo 'engine/bin/Release/net10.0-windows/WinFormsDesigner.Engine.dll'
$net48Engine = Join-Path $repo 'engine-net48/bin/Release/net48/WinFormsDesigner.Engine.Net48.exe'
$net48FixtureAssembly = Join-Path $repo 'fixtures/VisualStudioReference/Net48/bin/Release/net48/VisualStudioReference.Net48.dll'
foreach ($required in @($modernEngine, $net48Engine, $net48FixtureAssembly)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required comparison input is missing: $required" }
}

$run = 'VS18.0-20260821T082946Z'
$s011Run = 'VS18.7.11911.148-20260821T124034Z'
$traceRoot = Join-Path $repo "docs/v2/reference-traces/$run"
$s011TraceRoot = Join-Path $repo "docs/v2/reference-traces/$s011Run"
$s013Source = Join-Path $repo 'fixtures/VisualStudioReference/Modern/S013ButtonForm.Designer.cs'
$s011Source = Join-Path $repo 'fixtures/VisualStudioReference/Net48/S011ConcreteCustomerForm.Designer.cs'
$s011BaseSource = Join-Path $repo 'fixtures/VisualStudioReference/Net48/S011GenericBaseForm.cs'
$s014Source = Join-Path $repo 'fixtures/VisualStudioReference/Net48/S014TextBoxForm.Designer.cs'
$s013Product = Join-Path $output 'V2-FND-001-S013-product.png'
$s011Product = Join-Path $output 'V2-FND-001-S011-product.png'
$s014Product = Join-Path $output 'V2-FND-001-S014-product.png'

Push-Location $repo
try {
  Invoke-Checked 'S013 modern product render' {
    dotnet $modernEngine --render-layout $s013Source --out $s013Product
  }
  Invoke-Net48InterpretedRender 'S011 net48 generic-base interpreted product render' $net48Engine $s011Source `
    $net48FixtureAssembly 'VisualStudioReference.Net48.S011ConcreteCustomerForm' $s011Product
  Invoke-Net48InterpretedRender 'S014 net48 interpreted product render' $net48Engine $s014Source `
    $net48FixtureAssembly 'VisualStudioReference.Net48.S014TextBoxForm' $s014Product
} finally {
  Pop-Location
}

Add-Type -AssemblyName System.Drawing

function Compare-ClientPixels($Spec) {
  $traceManifest = Get-Content -LiteralPath $Spec.Manifest -Raw | ConvertFrom-Json
  if ($traceManifest.status -ne 'PASS' -or $traceManifest.scenarioId -ne $Spec.ScenarioId) {
    throw "Reference manifest is not a PASS for $($Spec.ScenarioId): $($Spec.Manifest)"
  }
  if ((Get-Sha256 $Spec.ReferenceImage) -ne [string]$traceManifest.visualStudioWindow.capture.sha256) {
    throw "Reference screenshot hash no longer matches its manifest for $($Spec.ScenarioId)"
  }
  if ((Get-Sha256 $Spec.Source) -ne [string]$traceManifest.sourceSha256) {
    throw "Current fixture source no longer matches the archived Visual Studio input for $($Spec.ScenarioId)"
  }
  if ($Spec.Contains('BaseSource') -and $Spec.BaseSource -and
      (Get-Sha256 $Spec.BaseSource) -ne [string]$traceManifest.baseSourceSha256) {
    throw "Current fixture base source no longer matches the archived Visual Studio input for $($Spec.ScenarioId)"
  }

  $reference = [System.Drawing.Bitmap]::new($Spec.ReferenceImage)
  $product = [System.Drawing.Bitmap]::new($Spec.ProductImage)
  $referenceClient = $null
  $productClient = $null
  $difference = $null
  try {
    $referenceRect = [System.Drawing.Rectangle]::new(
      $Spec.ReferenceCrop.X, $Spec.ReferenceCrop.Y, $Spec.ReferenceCrop.Width, $Spec.ReferenceCrop.Height)
    $productRect = [System.Drawing.Rectangle]::new(
      $Spec.ProductCrop.X, $Spec.ProductCrop.Y, $Spec.ProductCrop.Width, $Spec.ProductCrop.Height)
    if ($referenceRect.Right -gt $reference.Width -or $referenceRect.Bottom -gt $reference.Height) {
      throw "Reference crop is outside the screenshot for $($Spec.ScenarioId)"
    }
    if ($productRect.Right -gt $product.Width -or $productRect.Bottom -gt $product.Height) {
      throw "Product crop is outside the render for $($Spec.ScenarioId)"
    }
    if ($referenceRect.Size -ne $productRect.Size) {
      throw "Reference/product client sizes differ for $($Spec.ScenarioId)"
    }

    $referenceClient = $reference.Clone($referenceRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $productClient = $product.Clone($productRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $difference = [System.Drawing.Bitmap]::new(
      $referenceRect.Width, $referenceRect.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

    [long]$absoluteError = 0
    [long]$differentPixels = 0
    [int]$maximumChannelDelta = 0
    for ($y = 0; $y -lt $referenceRect.Height; $y++) {
      for ($x = 0; $x -lt $referenceRect.Width; $x++) {
        $expected = $referenceClient.GetPixel($x, $y)
        $actual = $productClient.GetPixel($x, $y)
        $red = [Math]::Abs([int]$expected.R - [int]$actual.R)
        $green = [Math]::Abs([int]$expected.G - [int]$actual.G)
        $blue = [Math]::Abs([int]$expected.B - [int]$actual.B)
        $pixelMaximum = [Math]::Max($red, [Math]::Max($green, $blue))
        $absoluteError += $red + $green + $blue
        if ($pixelMaximum -ne 0) { $differentPixels++ }
        if ($pixelMaximum -gt $maximumChannelDelta) { $maximumChannelDelta = $pixelMaximum }
        $difference.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $pixelMaximum, $pixelMaximum, $pixelMaximum))
      }
    }

    $pixelCount = $referenceRect.Width * $referenceRect.Height
    $meanAbsoluteError = $absoluteError / (3.0 * $pixelCount)
    $differentPercent = 100.0 * $differentPixels / $pixelCount
    $referenceClientPath = Join-Path $output "$($Spec.ScenarioId)-reference-client.png"
    $productClientPath = Join-Path $output "$($Spec.ScenarioId)-product-client.png"
    $differencePath = Join-Path $output "$($Spec.ScenarioId)-difference.png"
    $referenceClient.Save($referenceClientPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $productClient.Save($productClientPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $difference.Save($differencePath, [System.Drawing.Imaging.ImageFormat]::Png)

    $pass = $meanAbsoluteError -le $MaxMeanAbsoluteErrorPerChannel `
      -and $differentPercent -le $MaxDifferentPixelPercent `
      -and $maximumChannelDelta -le [int]$Spec.MaximumChannelDelta
    return [ordered]@{
      scenarioId = $Spec.ScenarioId
      traceId = [string]$traceManifest.traceId
      runtime = $Spec.Runtime
      status = $(if ($pass) { 'PASS' } else { 'FAIL' })
      referenceManifest = [System.IO.Path]::GetRelativePath($repo, $Spec.Manifest).Replace('\', '/')
      referenceScreenshot = [ordered]@{
        path = [System.IO.Path]::GetRelativePath($repo, $Spec.ReferenceImage).Replace('\', '/')
        sha256 = Get-Sha256 $Spec.ReferenceImage
        crop = $Spec.ReferenceCrop
        clientSha256 = Get-Sha256 $referenceClientPath
      }
      productRender = [ordered]@{
        path = [System.IO.Path]::GetFileName($Spec.ProductImage)
        sha256 = Get-Sha256 $Spec.ProductImage
        crop = $Spec.ProductCrop
        clientSha256 = Get-Sha256 $productClientPath
      }
      comparison = [ordered]@{
        width = $referenceRect.Width
        height = $referenceRect.Height
        pixelCount = $pixelCount
        differentPixels = $differentPixels
        differentPixelPercent = [Math]::Round($differentPercent, 6)
        meanAbsoluteErrorPerChannel = [Math]::Round($meanAbsoluteError, 6)
        maximumChannelDelta = $maximumChannelDelta
        tolerance = [ordered]@{
          maximumDifferentPixelPercent = $MaxDifferentPixelPercent
          maximumMeanAbsoluteErrorPerChannel = $MaxMeanAbsoluteErrorPerChannel
          maximumChannelDelta = [int]$Spec.MaximumChannelDelta
        }
        referenceClient = [System.IO.Path]::GetFileName($referenceClientPath)
        productClient = [System.IO.Path]::GetFileName($productClientPath)
        differenceImage = [System.IO.Path]::GetFileName($differencePath)
      }
    }
  } finally {
    if ($null -ne $difference) { $difference.Dispose() }
    if ($null -ne $productClient) { $productClient.Dispose() }
    if ($null -ne $referenceClient) { $referenceClient.Dispose() }
    $product.Dispose()
    $reference.Dispose()
  }
}

$referenceCrop = [ordered]@{ x = 524; y = 146; width = 360; height = 180 }
$productCrop = [ordered]@{ x = 8; y = 31; width = 360; height = 180 }
$specs = @(
  [ordered]@{
    ScenarioId = 'V2-FND-001-S011'
    Runtime = 'net48-interpreted-generic-base'
    Source = $s011Source
    BaseSource = $s011BaseSource
    Manifest = Join-Path $s011TraceRoot 'V2-FND-001-S011/manifest.json'
    ReferenceImage = Join-Path $s011TraceRoot 'V2-FND-001-S011/visual-studio-designer.png'
    ProductImage = $s011Product
    ReferenceCrop = $referenceCrop
    ProductCrop = $productCrop
    # The inherited-control lock adorner is a known Visual Studio-only visual. Keep the measured 246 ceiling explicit:
    # this is a bounded regression gate, not a claim of pixel identity.
    MaximumChannelDelta = 246
  },
  [ordered]@{
    ScenarioId = 'V2-FND-001-S013'
    Runtime = 'modern'
    Source = $s013Source
    Manifest = Join-Path $traceRoot 'V2-FND-001-S013/manifest.json'
    ReferenceImage = Join-Path $traceRoot 'V2-FND-001-S013/visual-studio-designer.png'
    ProductImage = $s013Product
    ReferenceCrop = $referenceCrop
    ProductCrop = $productCrop
    MaximumChannelDelta = 0
  },
  [ordered]@{
    ScenarioId = 'V2-FND-001-S014'
    Runtime = 'net48-interpreted'
    Source = $s014Source
    Manifest = Join-Path $traceRoot 'V2-FND-001-S014/manifest.json'
    ReferenceImage = Join-Path $traceRoot 'V2-FND-001-S014/visual-studio-designer.png'
    ProductImage = $s014Product
    ReferenceCrop = $referenceCrop
    ProductCrop = $productCrop
    MaximumChannelDelta = 0
  }
)

$comparisons = @($specs | ForEach-Object { Compare-ClientPixels $_ })
$overallPass = @($comparisons | Where-Object status -ne 'PASS').Count -eq 0
$head = (git -C $repo rev-parse HEAD).Trim()
$dirty = @(git -C $repo status --short).Count -ne 0
$report = [ordered]@{
  schemaVersion = 1
  comparisonId = "$run-product-$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')"
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  sourceHead = $head
  sourceTreeDirty = $dirty
  referenceAuthority = [ordered]@{
    runId = $run
    product = 'Visual Studio Enterprise 2026'
    installationVersion = '18.7.11911.148'
    captureHost = 'Microsoft Windows NT 10.0.26100.0; AMD64'
  }
  referenceAuthorities = @(
    [ordered]@{ runId = $run; product = 'Visual Studio Enterprise 2026'; installationVersion = '18.7.11911.148' },
    [ordered]@{ runId = $s011Run; product = 'Visual Studio Enterprise 2026'; installationVersion = '18.7.11911.148' }
  )
  productEngines = [ordered]@{
    modern = [ordered]@{ path = [System.IO.Path]::GetRelativePath($repo, $modernEngine).Replace('\', '/'); sha256 = Get-Sha256 $modernEngine }
    net48 = [ordered]@{ path = [System.IO.Path]::GetRelativePath($repo, $net48Engine).Replace('\', '/'); sha256 = Get-Sha256 $net48Engine }
  }
  status = $(if ($overallPass) { 'PASS' } else { 'FAIL' })
  comparisons = $comparisons
}
$reportPath = Join-Path $output 'manifest.json'
Write-Json $reportPath $report

foreach ($comparison in $comparisons) {
  Write-Host ("{0}: {1}; different={2}/{3} ({4}%); MAE/channel={5}; maxDelta={6}" -f `
    $comparison.scenarioId, $comparison.status, $comparison.comparison.differentPixels,
    $comparison.comparison.pixelCount, $comparison.comparison.differentPixelPercent,
    $comparison.comparison.meanAbsoluteErrorPerChannel, $comparison.comparison.maximumChannelDelta)
}
Write-Host "Visual Studio reference comparison report: $reportPath"
if ($ScenarioEvidenceFile) {
  $provenanceHelper = Join-Path $repo 'scripts/v2-evidence-provenance.mjs'
  $provenanceJson = & node $provenanceHelper "--repo-root=$repo" '--producer=visual-reference'
  if ($LASTEXITCODE -ne 0) { throw 'Cannot capture visual-reference evidence provenance.' }
  $provenance = $provenanceJson | ConvertFrom-Json
  $scriptRelative = [System.IO.Path]::GetRelativePath($repo, $PSCommandPath).Replace('\', '/')
  $scriptLines = [System.IO.File]::ReadAllLines($PSCommandPath)
  $assertionPatterns = @(
    '$pass = $meanAbsoluteError -le $MaxMeanAbsoluteErrorPerChannel',
    '-and $differentPercent -le $MaxDifferentPixelPercent',
    '-and $maximumChannelDelta -le [int]$Spec.MaximumChannelDelta'
  )
  $assertionLines = @($assertionPatterns | ForEach-Object {
    $pattern = $_
    $index = [Array]::FindIndex($scriptLines, [Predicate[string]]{ param($line) $line.Contains($pattern) })
    if ($index -lt 0) { throw "Cannot locate executed comparison assertion: $pattern" }
    [ordered]@{
      file = $scriptRelative
      line = $index + 1
      kind = 'powershell.condition'
      executions = 1
      fileSha256 = Get-Sha256 $PSCommandPath
      lineSha256 = Get-TextSha256 $scriptLines[$index]
    }
  })
  $scenarioEvidence = [ordered]@{
    schemaVersion = 'v2-scenario-evidence.2'
    suite = 'e2e'
    invocation = 'compare-visual-studio-reference-renders.ps1'
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    completed = $overallPass
    sourceRoot = '.'
    provenance = $provenance
    results = @($comparisons | ForEach-Object {
      [ordered]@{
        scenarioId = $_.scenarioId
        status = $_.status
        assertionCount = $assertionLines.Count
        assertions = $assertionLines
        error = $(if ($_.status -eq 'PASS') { $null } else { 'render comparison exceeded a declared threshold' })
      }
    })
  }
  $evidencePath = [System.IO.Path]::GetFullPath($ScenarioEvidenceFile)
  New-Item -ItemType Directory -Path (Split-Path -Parent $evidencePath) -Force | Out-Null
  Write-Json $evidencePath $scenarioEvidence
  Write-Host "V2 scenario evidence report: $evidencePath"
}
if (-not $overallPass) { exit 1 }
