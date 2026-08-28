param(
    [string]$SchemaPath = "docs/v2/vs-parity-scenario-catalog.schema.json",
    [string]$CatalogPath = "docs/v2/vs-parity-scenario-catalog.tsv",
    [string]$EvidenceDirectory = ".codex-tmp/v2-scenario-evidence",
    [switch]$StaticOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail($message) {
    $script:errors.Add($message) | Out-Null
}

function Get-EnumValues($schema, $name) {
    $property = $schema.enums.PSObject.Properties[$name]
    if ($null -eq $property) {
        throw "Schema enum '$name' is missing."
    }

    @($property.Value)
}

function Test-InSet($value, $allowed) {
    return $allowed -contains $value
}

function Split-List($value) {
    $items = @(
        ([string]$value).Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_.Length -gt 0 }
    )
    return ,$items
}

function Get-EvidenceRefParts($value) {
    $match = [regex]::Match([string]$value, '^(?<path>[A-Za-z0-9_.\/\\-]+):(?<line>\d+)$')
    if (-not $match.Success) {
        return $null
    }

    [pscustomobject]@{
        Path = $match.Groups["path"].Value
        Line = [int]$match.Groups["line"].Value
    }
}

function Test-EvidenceRef($value) {
    return $null -ne (Get-EvidenceRefParts $value)
}

$script:errors = [System.Collections.Generic.List[string]]::new()
$repoRoot = [System.IO.Path]::GetFullPath((Get-Location).ProviderPath)
$repoRootPrefix = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not (Test-Path -LiteralPath $SchemaPath)) {
    throw "Schema file not found: $SchemaPath"
}

if (-not (Test-Path -LiteralPath $CatalogPath)) {
    throw "Catalog file not found: $CatalogPath"
}

$schema = Get-Content -LiteralPath $SchemaPath -Raw | ConvertFrom-Json
$rows = @(Import-Csv -LiteralPath $CatalogPath -Delimiter "`t")

if ($schema.catalogId -ne "V2-FND-001") {
    Fail "Schema catalogId must be V2-FND-001, got '$($schema.catalogId)'."
}

if ([string]::IsNullOrWhiteSpace($schema.schemaVersion)) {
    Fail "Schema schemaVersion is required."
}

if ([string]::IsNullOrWhiteSpace($schema.catalogVersion)) {
    Fail "Schema catalogVersion is required."
}

if ($schema.format.type -ne "tsv") {
    Fail "Schema format.type must be tsv, got '$($schema.format.type)'."
}

$minimumScenarioCount = [int]$schema.minimumScenarioCount
if ($rows.Count -lt $minimumScenarioCount) {
    Fail "Catalog has $($rows.Count) scenarios; minimum is $minimumScenarioCount."
}

$header = @()
if ($rows.Count -gt 0) {
    $header = @($rows[0].PSObject.Properties.Name)
}

foreach ($requiredColumn in @($schema.requiredColumns)) {
    if ($header -notcontains $requiredColumn) {
        Fail "Missing required column '$requiredColumn'."
    }
}

$capabilityIds = Get-EnumValues $schema "capabilityId"
$domains = Get-EnumValues $schema "domain"
$tiers = Get-EnumValues $schema "tier"
$runtimes = Get-EnumValues $schema "runtime"
$architectures = Get-EnumValues $schema "architecture"
$authorityLanes = Get-EnumValues $schema "authorityLane"
$persistenceLanes = Get-EnumValues $schema "persistenceLane"
$traceStatuses = Get-EnumValues $schema "traceStatus"
$executionStatuses = Get-EnumValues $schema "executionStatus"
$referenceTraceStates = Get-EnumValues $schema "referenceTraceState"
$repoAutomationStatuses = Get-EnumValues $schema "repoAutomationStatus"
$repoEvidenceStates = Get-EnumValues $schema "repoEvidenceState"
$testKindValues = Get-EnumValues $schema "testKind"
$architectureLegValues = Get-EnumValues $schema "architectureLeg"
$externalGateValues = Get-EnumValues $schema "externalGate"
$claimBoundaryValues = Get-EnumValues $schema "claimBoundary"
$requiredEvidenceFields = @($schema.requiredEvidenceFields)
$allowedRepoExecutionStatuses = @($schema.phase0Policy.allowedRepoExecutionStatusesForThisCatalog)

if ($schema.phase0Policy.fabricatedPassForbidden -ne $true) {
    Fail "phase0Policy.fabricatedPassForbidden must be true."
}
if ($schema.phase0Policy.repoPassRequiresEvidenceRefs -ne $true) {
    Fail "phase0Policy.repoPassRequiresEvidenceRefs must be true."
}
if ($schema.phase0Policy.tracePassRequiresExternalArtifact -ne $true) {
    Fail "phase0Policy.tracePassRequiresExternalArtifact must be true."
}
if ($schema.phase0Policy.allScenariosMustCarryConcreteSetupActionExpectedRefusal -ne $true) {
    Fail "phase0Policy.allScenariosMustCarryConcreteSetupActionExpectedRefusal must be true."
}

$ids = [System.Collections.Generic.HashSet[string]]::new()
$seenCapabilities = [System.Collections.Generic.HashSet[string]]::new()
$seenDomains = [System.Collections.Generic.HashSet[string]]::new()
$seenRuntimes = [System.Collections.Generic.HashSet[string]]::new()
$seenArchitectures = [System.Collections.Generic.HashSet[string]]::new()
$safetyOrRefusalCount = 0
$referenceTraceStatusCounts = @{}
$repoExecutionStatusCounts = @{}
$repoAutomationStatusCounts = @{}
$claimBoundaryCounts = @{}
$architectureLegCounts = @{}
$externalGateCounts = @{}

for ($index = 0; $index -lt $rows.Count; $index++) {
    $row = $rows[$index]
    $line = $index + 2

    foreach ($requiredColumn in @($schema.requiredColumns)) {
        $value = [string]$row.$requiredColumn
        if ([string]::IsNullOrWhiteSpace($value)) {
            Fail "Line $line scenario '$($row.scenarioId)' has empty required column '$requiredColumn'."
        }
    }

    if ($row.catalogVersion -ne $schema.catalogVersion) {
        Fail "Line $line scenario '$($row.scenarioId)' has catalogVersion '$($row.catalogVersion)' but expected '$($schema.catalogVersion)'."
    }

    if ($row.scenarioId -notmatch '^V2-FND-001-S\d{3}$') {
        Fail "Line $line scenarioId '$($row.scenarioId)' does not match V2-FND-001-S###."
    }

    if (-not $ids.Add($row.scenarioId)) {
        Fail "Duplicate scenarioId '$($row.scenarioId)' at line $line."
    }

    if (-not (Test-InSet $row.capabilityId $capabilityIds)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown capabilityId '$($row.capabilityId)'."
    } else {
        $seenCapabilities.Add($row.capabilityId) | Out-Null
    }

    if (-not (Test-InSet $row.domain $domains)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown domain '$($row.domain)'."
    } else {
        $seenDomains.Add($row.domain) | Out-Null
    }

    if (-not (Test-InSet $row.tier $tiers)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown tier '$($row.tier)'."
    }

    if (-not (Test-InSet $row.runtime $runtimes)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown runtime '$($row.runtime)'."
    } else {
        $seenRuntimes.Add($row.runtime) | Out-Null
    }

    if (-not (Test-InSet $row.architecture $architectures)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown architecture '$($row.architecture)'."
    } else {
        $seenArchitectures.Add($row.architecture) | Out-Null
    }

    if (-not (Test-InSet $row.authorityLane $authorityLanes)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown authorityLane '$($row.authorityLane)'."
    }

    if (-not (Test-InSet $row.persistenceLane $persistenceLanes)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown persistenceLane '$($row.persistenceLane)'."
    }

    if (-not (Test-InSet $row.referenceTraceStatus $traceStatuses)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown referenceTraceStatus '$($row.referenceTraceStatus)'."
    }

    if (-not (Test-InSet $row.repoExecutionStatus $executionStatuses)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown repoExecutionStatus '$($row.repoExecutionStatus)'."
    }

    if (-not (Test-InSet $row.referenceTraceState $referenceTraceStates)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown referenceTraceState '$($row.referenceTraceState)'."
    }

    if (-not (Test-InSet $row.repoAutomationStatus $repoAutomationStatuses)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown repoAutomationStatus '$($row.repoAutomationStatus)'."
    }

    if (-not (Test-InSet $row.repoEvidenceState $repoEvidenceStates)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown repoEvidenceState '$($row.repoEvidenceState)'."
    }

    if ([string]::IsNullOrWhiteSpace([string]$row.repoEvidenceReason)) {
        Fail "Line $line scenario '$($row.scenarioId)' has no repoEvidenceReason."
    }

    if (-not (Test-InSet $row.claimBoundary $claimBoundaryValues)) {
        Fail "Line $line scenario '$($row.scenarioId)' has unknown claimBoundary '$($row.claimBoundary)'."
    }

    $repoEvidenceRefs = Split-List $row.repoEvidenceRefs
    $testKinds = Split-List $row.testKinds
    $architectureLegs = Split-List $row.architectureLegs
    $externalGates = Split-List $row.externalGates
    foreach ($repoEvidenceRef in $repoEvidenceRefs) {
        if ($repoEvidenceRef -eq "UNSET") {
            continue
        }
        if ($repoEvidenceRef -eq "MEASURED_AT_RUNTIME") {
            continue
        }

        $evidenceRefParts = Get-EvidenceRefParts $repoEvidenceRef
        if ($null -eq $evidenceRefParts) {
            Fail "Line $line scenario '$($row.scenarioId)' has invalid repoEvidenceRef '$repoEvidenceRef'. Use repo-relative path:line or UNSET."
            continue
        }

        $evidencePath = [System.IO.Path]::GetFullPath((Join-Path -Path $repoRoot -ChildPath $evidenceRefParts.Path))
        if ($evidencePath -ne $repoRoot -and -not $evidencePath.StartsWith($repoRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            Fail "Line $line scenario '$($row.scenarioId)' has repoEvidenceRef '$repoEvidenceRef' outside the repository root."
            continue
        }

        if (-not (Test-Path -LiteralPath $evidencePath -PathType Leaf)) {
            Fail "Line $line scenario '$($row.scenarioId)' has repoEvidenceRef '$repoEvidenceRef' but the referenced file does not exist."
            continue
        }

        $lineCount = @([System.IO.File]::ReadLines($evidencePath)).Count
        if ($evidenceRefParts.Line -lt 1 -or $evidenceRefParts.Line -gt $lineCount) {
            Fail "Line $line scenario '$($row.scenarioId)' has repoEvidenceRef '$repoEvidenceRef' but the file has $lineCount lines."
        }
    }

    foreach ($testKind in $testKinds) {
        if (-not (Test-InSet $testKind $testKindValues)) {
            Fail "Line $line scenario '$($row.scenarioId)' has unknown testKind '$testKind'."
        }
    }

    foreach ($architectureLeg in $architectureLegs) {
        if (-not (Test-InSet $architectureLeg $architectureLegValues)) {
            Fail "Line $line scenario '$($row.scenarioId)' has unknown architectureLeg '$architectureLeg'."
        }
    }

    foreach ($externalGate in $externalGates) {
        if (-not (Test-InSet $externalGate $externalGateValues)) {
            Fail "Line $line scenario '$($row.scenarioId)' has unknown externalGate '$externalGate'."
        }
    }

    if ($externalGates -contains "NONE" -and $externalGates.Count -gt 1) {
        Fail "Line $line scenario '$($row.scenarioId)' combines externalGate NONE with other gates."
    }

    if (-not (Test-InSet $row.repoExecutionStatus $allowedRepoExecutionStatuses)) {
        Fail "Line $line scenario '$($row.scenarioId)' has repoExecutionStatus '$($row.repoExecutionStatus)' but Phase 0 catalog allows only '$($allowedRepoExecutionStatuses -join ", ")'."
    }

    if ($row.referenceTraceStatus -eq "PASS") {
        if ($row.referenceTraceState -ne "ARCHIVED" -or $row.referenceTraceId -eq "UNSET") {
            Fail "Line $line scenario '$($row.scenarioId)' has reference PASS without archived trace state and trace id."
        }
        $traceRelativePath = ([string]$row.referenceTraceSource).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        if ([System.IO.Path]::IsPathRooted($traceRelativePath) -or -not $traceRelativePath.EndsWith('manifest.json')) {
            Fail "Line $line scenario '$($row.scenarioId)' reference PASS must cite a repo-relative manifest.json artifact."
        } else {
            $traceManifestPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $traceRelativePath))
            if (-not $traceManifestPath.StartsWith($repoRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                Fail "Line $line scenario '$($row.scenarioId)' reference trace escapes the repository."
            } elseif (-not (Test-Path -LiteralPath $traceManifestPath -PathType Leaf)) {
                Fail "Line $line scenario '$($row.scenarioId)' reference trace manifest does not exist: $($row.referenceTraceSource)."
            } else {
                try {
                    $traceManifest = Get-Content -LiteralPath $traceManifestPath -Raw | ConvertFrom-Json
                    if ($traceManifest.scenarioId -ne $row.scenarioId) {
                        Fail "Line $line scenario '$($row.scenarioId)' trace manifest scenarioId is '$($traceManifest.scenarioId)'."
                    }
                    if ($traceManifest.traceId -ne $row.referenceTraceId) {
                        Fail "Line $line scenario '$($row.scenarioId)' trace manifest id '$($traceManifest.traceId)' does not match catalog id '$($row.referenceTraceId)'."
                    }
                    if ($traceManifest.status -ne 'PASS') {
                        Fail "Line $line scenario '$($row.scenarioId)' trace manifest status is '$($traceManifest.status)', not PASS."
                    }
                    if ([string]::IsNullOrWhiteSpace([string]$traceManifest.authority.product) -or
                        ([string]$traceManifest.authority.product -notmatch 'Visual Studio') -or
                        [string]::IsNullOrWhiteSpace([string]$traceManifest.authority.installationVersion)) {
                        Fail "Line $line scenario '$($row.scenarioId)' trace manifest lacks exact Visual Studio authority/version metadata."
                    }
                    $traceScreenshot = Join-Path (Split-Path -Parent $traceManifestPath) 'visual-studio-designer.png'
                    if (-not (Test-Path -LiteralPath $traceScreenshot -PathType Leaf)) {
                        Fail "Line $line scenario '$($row.scenarioId)' archived trace has no visual-studio-designer.png."
                    } else {
                        $expectedScreenshotHash = [string]$traceManifest.visualStudioWindow.capture.sha256
                        $actualScreenshotHash = (Get-FileHash -LiteralPath $traceScreenshot -Algorithm SHA256).Hash.ToLowerInvariant()
                        if ($expectedScreenshotHash -ne $actualScreenshotHash) {
                            Fail "Line $line scenario '$($row.scenarioId)' archived screenshot hash does not match its manifest."
                        }
                    }
                    if ($row.domain -eq 'roundtrip' -and $traceManifest.byteIdentical -ne $true) {
                        Fail "Line $line scenario '$($row.scenarioId)' round-trip reference PASS must prove byteIdentical=true."
                    }
                } catch {
                    Fail "Line $line scenario '$($row.scenarioId)' trace manifest could not be validated: $($_.Exception.Message)"
                }
            }
        }
        if ($externalGates -contains "VISUAL_STUDIO_REFERENCE_TRACE") {
            Fail "Line $line scenario '$($row.scenarioId)' has archived reference PASS but still carries the unsatisfied Visual Studio trace gate."
        }
    } else {
        if ($row.referenceTraceState -ne "NOT_CAPTURED") {
            Fail "Line $line scenario '$($row.scenarioId)' has non-PASS referenceTraceStatus but referenceTraceState '$($row.referenceTraceState)' instead of NOT_CAPTURED."
        }

        if ($row.referenceTraceId -ne "UNSET") {
            Fail "Line $line scenario '$($row.scenarioId)' must keep referenceTraceId UNSET until a real Visual Studio trace is archived."
        }

        if ($externalGates -notcontains "VISUAL_STUDIO_REFERENCE_TRACE") {
            Fail "Line $line scenario '$($row.scenarioId)' has no Visual Studio reference trace gate for unexecuted reference status."
        }
    }

    if ($row.repoExecutionStatus -eq "PASS") {
        if ($row.tier -eq "D") {
            Fail "Line $line scenario '$($row.scenarioId)' is Tier D and cannot have repo PASS in this catalog."
        }

        if ($row.repoAutomationStatus -ne "AUTOMATED") {
            Fail "Line $line scenario '$($row.scenarioId)' has repo PASS without repoAutomationStatus AUTOMATED."
        }

        if ($repoEvidenceRefs.Count -ne 1 -or $repoEvidenceRefs[0] -ne "MEASURED_AT_RUNTIME") {
            Fail "Line $line scenario '$($row.scenarioId)' has repo PASS without runtime-derived MEASURED_AT_RUNTIME evidence."
        }

        if ($testKinds.Count -eq 0 -or $testKinds -contains "none") {
            Fail "Line $line scenario '$($row.scenarioId)' has repo PASS without concrete testKinds."
        }

        if ($architectureLegs -notcontains "repo-functional") {
            Fail "Line $line scenario '$($row.scenarioId)' has repo PASS without repo-functional architectureLeg."
        }

        if ($row.claimBoundary -ne "REPO_AUTOMATED") {
            Fail "Line $line scenario '$($row.scenarioId)' has repo PASS but claimBoundary '$($row.claimBoundary)' instead of REPO_AUTOMATED."
        }

        if ($row.repoEvidenceState -ne "MEASURED_SUFFICIENT" -or $row.repoEvidenceReason -ne "NONE") {
            Fail "Line $line scenario '$($row.scenarioId)' has repo PASS without MEASURED_SUFFICIENT/NONE evidence sufficiency."
        }
    } elseif ($row.repoEvidenceState -eq "MEASURED_SUFFICIENT") {
        Fail "Line $line scenario '$($row.scenarioId)' is not PASS but declares MEASURED_SUFFICIENT."
    } elseif ($row.repoEvidenceState -eq "MEASURED_BUT_INSUFFICIENT" -and $row.repoEvidenceReason -eq "NONE") {
        Fail "Line $line scenario '$($row.scenarioId)' has MEASURED_BUT_INSUFFICIENT without a reason."
    } else {
        if ($row.repoAutomationStatus -eq "AUTOMATED") {
            Fail "Line $line scenario '$($row.scenarioId)' has repoAutomationStatus AUTOMATED without repo PASS."
        }

        if ($row.claimBoundary -eq "REPO_AUTOMATED") {
            Fail "Line $line scenario '$($row.scenarioId)' has claimBoundary REPO_AUTOMATED without repo PASS."
        }
    }

    $evidenceFields = @(
        ([string]$row.evidenceFields).Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) |
        ForEach-Object { $_.Trim() }
    )

    foreach ($requiredEvidenceField in $requiredEvidenceFields) {
        if ($evidenceFields -notcontains $requiredEvidenceField) {
            Fail "Line $line scenario '$($row.scenarioId)' is missing evidence field '$requiredEvidenceField'."
        }
    }

    foreach ($evidenceField in $evidenceFields) {
        if ($requiredEvidenceFields -notcontains $evidenceField) {
            Fail "Line $line scenario '$($row.scenarioId)' has unknown evidence field '$evidenceField'."
        }
    }

    if (($row.refusal -ne "NONE") -or ($row.persistenceLane -eq "NoMutation") -or ($row.domain -in @("safety", "security", "recovery"))) {
        $safetyOrRefusalCount++
    }

    $expectedArchitectureLeg = switch ($row.architecture) {
        "x64" { "catalog-x64" }
        "arm64" { "catalog-arm64" }
        "x86" { "catalog-x86" }
        "cross-arch" { "catalog-cross-arch" }
        "n/a" { "not-applicable" }
        default { "" }
    }
    if ($expectedArchitectureLeg -and $architectureLegs -notcontains $expectedArchitectureLeg) {
        Fail "Line $line scenario '$($row.scenarioId)' is architecture '$($row.architecture)' but lacks architectureLeg '$expectedArchitectureLeg'."
    }

    if ($row.architecture -eq "arm64") {
        if ($architectureLegs -notcontains "physical-arm64-gated") {
            Fail "Line $line scenario '$($row.scenarioId)' is arm64 but lacks physical-arm64-gated architectureLeg."
        }

        if ($externalGates -notcontains "ARM64_HARDWARE") {
            Fail "Line $line scenario '$($row.scenarioId)' is arm64 but lacks ARM64_HARDWARE externalGate."
        }
    }

    if ($row.architecture -eq "x86") {
        if ($architectureLegs -notcontains "x86-com-gated") {
            Fail "Line $line scenario '$($row.scenarioId)' is x86 but lacks x86-com-gated architectureLeg."
        }

        if ($externalGates -notcontains "X86_COM_HOST") {
            Fail "Line $line scenario '$($row.scenarioId)' is x86 but lacks X86_COM_HOST externalGate."
        }
    }

    if ($row.tier -eq "D") {
        if ($row.repoExecutionStatus -eq "PASS") {
            Fail "Line $line scenario '$($row.scenarioId)' is Tier D but has repo PASS."
        }

        if ($row.claimBoundary -ne "TIER_D_EXCLUDED") {
            Fail "Line $line scenario '$($row.scenarioId)' is Tier D but claimBoundary is '$($row.claimBoundary)' instead of TIER_D_EXCLUDED."
        }

        if ($row.repoAutomationStatus -ne "GATED" -or $row.repoExecutionStatus -ne "GATED") {
            Fail "Line $line scenario '$($row.scenarioId)' is Tier D but does not carry GATED repo state."
        }
    }

    $vendorText = "$($row.name) $($row.setup) $($row.action) $($row.expected) $($row.refusal) $($row.notes)"
    if ($vendorText -match '(?i)vendor|fakevendor|devexpress|third-party|proprietary') {
        if ($externalGates -notcontains "VENDOR_ARTIFACT") {
            Fail "Line $line scenario '$($row.scenarioId)' references vendor behavior but lacks VENDOR_ARTIFACT externalGate."
        }
    }

    $referenceTraceStatusCounts[$row.referenceTraceStatus] = 1 + [int]($referenceTraceStatusCounts[$row.referenceTraceStatus])
    $repoExecutionStatusCounts[$row.repoExecutionStatus] = 1 + [int]($repoExecutionStatusCounts[$row.repoExecutionStatus])
    $repoAutomationStatusCounts[$row.repoAutomationStatus] = 1 + [int]($repoAutomationStatusCounts[$row.repoAutomationStatus])
    $claimBoundaryCounts[$row.claimBoundary] = 1 + [int]($claimBoundaryCounts[$row.claimBoundary])
    foreach ($architectureLeg in $architectureLegs) {
        $architectureLegCounts[$architectureLeg] = 1 + [int]($architectureLegCounts[$architectureLeg])
    }
    foreach ($externalGate in $externalGates) {
        $externalGateCounts[$externalGate] = 1 + [int]($externalGateCounts[$externalGate])
    }
}

foreach ($capabilityId in $capabilityIds) {
    if (-not $seenCapabilities.Contains($capabilityId)) {
        Fail "Capability '$capabilityId' has no scenarios."
    }
}

foreach ($requiredDomain in @($schema.coverageRequirements.requiredDomains)) {
    if (-not $seenDomains.Contains($requiredDomain)) {
        Fail "Required domain '$requiredDomain' has no scenarios."
    }
}

foreach ($requiredRuntime in @($schema.coverageRequirements.requiredRuntimes)) {
    if (-not $seenRuntimes.Contains($requiredRuntime)) {
        Fail "Required runtime '$requiredRuntime' has no scenarios."
    }
}

foreach ($requiredArchitecture in @($schema.coverageRequirements.requiredArchitectures)) {
    if (-not $seenArchitectures.Contains($requiredArchitecture)) {
        Fail "Required architecture '$requiredArchitecture' has no scenarios."
    }
}

$minimumSafetyOrRefusalScenarios = [int]$schema.coverageRequirements.minimumSafetyOrRefusalScenarios
if ($safetyOrRefusalCount -lt $minimumSafetyOrRefusalScenarios) {
    Fail "Catalog has $safetyOrRefusalCount safety/refusal scenarios; minimum is $minimumSafetyOrRefusalScenarios."
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Host "ERROR: $_" }
    exit 1
}

$referenceTraceSummary = ($referenceTraceStatusCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
$repoExecutionSummary = ($repoExecutionStatusCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
$repoAutomationSummary = ($repoAutomationStatusCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
$claimBoundarySummary = ($claimBoundaryCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
$architectureLegSummary = ($architectureLegCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
$externalGateSummary = ($externalGateCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "

Write-Host "V2-FND-001 scenario catalog validation PASS"
Write-Host "Schema version: $($schema.schemaVersion)"
Write-Host "Catalog version: $($schema.catalogVersion)"
Write-Host "Scenario count: $($rows.Count)"
Write-Host "Capability count: $($seenCapabilities.Count)"
Write-Host "Domain count: $($seenDomains.Count)"
Write-Host "Safety/refusal count: $safetyOrRefusalCount"
Write-Host "Reference trace statuses: $referenceTraceSummary"
Write-Host "Repository execution statuses: $repoExecutionSummary"
Write-Host "Repository automation statuses: $repoAutomationSummary"
Write-Host "Claim boundaries: $claimBoundarySummary"
Write-Host "Architecture legs: $architectureLegSummary"
Write-Host "External gates: $externalGateSummary"

if ($StaticOnly) {
    Write-Host "STATIC-ONLY: catalog shape and archived Visual Studio traces are valid; repository PASS was not measured."
    exit 0
}

$executionValidator = Join-Path $repoRoot "scripts/validate-v2-execution-evidence.mjs"
& node $executionValidator "--repo-root=$repoRoot" "--catalog=$CatalogPath" "--evidence-dir=$EvidenceDirectory" "--static-pass-count=$($repoExecutionStatusCounts['PASS'])"
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
