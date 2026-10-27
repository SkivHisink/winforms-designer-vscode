param([string]$OutputDirectory = '.dotnet-temp/release23-abi-probe-run')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sampleRoot = $PSScriptRoot
$repoRoot = [IO.Path]::GetFullPath((Join-Path $sampleRoot '../..'))
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
    [IO.Path]::GetFullPath($OutputDirectory)
} else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}
$allowedRoots = @($repoRoot, $env:RUNNER_TEMP) | Where-Object { $_ }
if (-not @($allowedRoots | Where-Object {
    $outputRoot.StartsWith([IO.Path]::GetFullPath($_).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}).Count) {
    throw 'The evidence directory must stay inside this checkout or the runner temporary directory.'
}
New-Item -ItemType Directory -Force $outputRoot | Out-Null
$started = [DateTime]::UtcNow.ToString('o')
$commands = [Collections.Generic.List[object]]::new()

function Run-ProbeCommand([string]$Name, [string]$Executable, [string[]]$CommandArguments) {
    $logPath = Join-Path $outputRoot ($Name + '.log')
    $output = & $Executable @CommandArguments 2>&1
    $commandExitCode = $LASTEXITCODE
    $output | Set-Content -LiteralPath $logPath -Encoding utf8
    $commands.Add([ordered]@{
        name = $Name
        command = $Executable + ' ' + (($CommandArguments | ForEach-Object { $_.Replace($repoRoot, '<repo>') }) -join ' ')
        exitCode = $commandExitCode
        log = [IO.Path]::GetFileName($logPath)
        logSha256 = (Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash.ToLowerInvariant()
    })
    if ($commandExitCode -ne 0) { throw "$Name failed ($commandExitCode). See $logPath" }
    Write-Host "$Name : PASS"
}

$modernProject = Join-Path $sampleRoot 'ModernDesigner/ModernDesigner.csproj'
Run-ProbeCommand 'modern-locked-restore' 'dotnet' @('restore', $modernProject, '--locked-mode')
Run-ProbeCommand 'modern-build' 'dotnet' @('build', $modernProject, '-c', 'Release', '--no-restore')
Run-ProbeCommand 'classic-build' 'dotnet' @('build', (Join-Path $sampleRoot 'ClassicDesigner/ClassicDesigner.csproj'), '-c', 'Release')
Run-ProbeCommand 'metadata-build' 'dotnet' @('build', (Join-Path $sampleRoot 'MetadataProbe/MetadataProbe.csproj'), '-c', 'Release')

$assets = Get-Content -LiteralPath (Join-Path $sampleRoot 'ModernDesigner/obj/project.assets.json') -Raw | ConvertFrom-Json
$packageFolder = @($assets.packageFolders.PSObject.Properties)[0].Name
$sdkPackage = Join-Path $packageFolder 'microsoft.winforms.designer.sdk/1.6.0'
$modernDll = Join-Path $sampleRoot 'ModernDesigner/bin/Release/net10.0-windows/Independent.ModernDesigner.dll'
$classicExe = Join-Path $sampleRoot 'ClassicDesigner/bin/Release/net48/Independent.ClassicDesigner.exe'
$metadataDll = Join-Path $sampleRoot 'MetadataProbe/bin/Release/net10.0-windows/MetadataProbe.dll'
Run-ProbeCommand 'classic-execute' $classicExe @((Join-Path $outputRoot 'classic.json'))
Run-ProbeCommand 'modern-abi-and-refusal' 'dotnet' @($metadataDll, $sdkPackage, $modernDll, (Join-Path $outputRoot 'modern.json'))

$modern = Get-Content -LiteralPath (Join-Path $outputRoot 'modern.json') -Raw | ConvertFrom-Json
$classic = Get-Content -LiteralPath (Join-Path $outputRoot 'classic.json') -Raw | ConvertFrom-Json
if ($modern.status -ne 'REJECTED_DIRECT_INTEGRATION' -or -not $modern.probeCompleted -or $classic.status -ne 'PASS') {
    throw 'The independent ABI probe did not reach its expected measured decision.'
}
$sourceFiles = @(Get-ChildItem -LiteralPath $sampleRoot -File -Recurse | Where-Object {
    $_.FullName -notmatch '[\\/](bin|obj)[\\/]' -and $_.Extension -in @('.cs', '.csproj', '.ps1', '.json', '.md')
} | Sort-Object FullName | ForEach-Object {
    [ordered]@{ path = [IO.Path]::GetRelativePath($repoRoot, $_.FullName).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$reports = @('modern.json', 'classic.json') | ForEach-Object {
    [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $outputRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$report = [ordered]@{
    schemaVersion = 1
    probeCompleted = $true
    decision = 'EXPLICIT_ADAPTER_REQUIRED'
    modern = 'REJECTED_DIRECT_INTEGRATION'
    classic = 'PASS_PUBLIC_DESIGN_SURFACE_AND_HEADLESS_EDITOR_REFUSAL'
    startedUtc = $started
    finishedUtc = [DateTime]::UtcNow.ToString('o')
    sdkPackage = [ordered]@{
        id = 'Microsoft.WinForms.Designer.SDK'; version = '1.6.0'
        nupkgSha256 = (Get-FileHash -LiteralPath (Join-Path $sdkPackage 'microsoft.winforms.designer.sdk.1.6.0.nupkg') -Algorithm SHA256).Hash.ToLowerInvariant()
        licenseSha256 = (Get-FileHash -LiteralPath (Join-Path $sdkPackage 'PackageLicense.txt') -Algorithm SHA256).Hash.ToLowerInvariant()
        payload = 'Six reference assemblies only; no lib/ or runtimes/ implementation.'
        distribution = 'NOT_REDISTRIBUTED; SDK references used only for the isolated compilation/metadata probe.'
        audit = 'Repository NuGetAudit=true, all, moderate; NU1902/NU1903/NU1904 remain errors. Locked restore succeeded.'
    }
    sources = $sourceFiles
    buildConfiguration = @('global.json', 'Directory.Build.props') | ForEach-Object {
        [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $repoRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    artifacts = @(
        [ordered]@{ path = 'Independent.ModernDesigner.dll'; sha256 = (Get-FileHash -LiteralPath $modernDll -Algorithm SHA256).Hash.ToLowerInvariant() },
        [ordered]@{ path = 'Independent.ClassicDesigner.exe'; sha256 = (Get-FileHash -LiteralPath $classicExe -Algorithm SHA256).Hash.ToLowerInvariant() },
        [ordered]@{ path = 'MetadataProbe.dll'; sha256 = (Get-FileHash -LiteralPath $metadataDll -Algorithm SHA256).Hash.ToLowerInvariant() }
    )
    reports = $reports
    commands = $commands
    limits = @(
        'No modern SDK designer runtime invocation: only reference assemblies are available from this pinned SDK.'
        'No Visual Studio implementation binaries or private DesignToolsServer protocol copied, loaded or emulated.'
        'Native windows, ownership/focus/Escape and interactive dropdown/modal behavior NOT_EXECUTED.'
        'Independent samples do not certify compatibility of any existing vendor designer binary.'
        'Classic DesignSurface service availability is recorded; unavailable services are not faked as complete.'
    )
}
$report | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $outputRoot 'abi-probe.json') -Encoding utf8
Write-Host "ABI decision and evidence: $outputRoot"
