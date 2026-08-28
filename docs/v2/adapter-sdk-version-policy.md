# v2 Adapter SDK Manifest Version Policy

The adapter SDK manifest is a static compatibility declaration. The validator reads JSON only and must reject invalid or incompatible declarations before any vendor assembly, package entry point, or design-time code is loaded.

## Versioned Contract

- `schemaId` is `winforms-designer.v2.adapter-manifest`.
- `schemaVersion` is `1` for the 2.0.0 adapter SDK preview.
- `protocol.id` is `designer-protocol-v2`.
- `protocol.supportedVersions` must include the current protocol version and the N-1 protocol version. For 2.0.0 this means versions `2` and `1`.
- Unknown manifest fields are invalid at every object level. New fields require a schemaVersion bump or a new schema.

## Compatibility Cohorts

Each manifest declares product/runtime/architecture cohorts:

- `productId`: `winforms-designer-vscode`
- product version range: `minProductVersion` inclusive, `maxProductVersionExclusive` exclusive
- runtimes: `modern`, `net48`
- architectures: `x64`, `arm64`

There is no v2.0.0 x86 adapter cohort. COM, ActiveX, and x86-only adapter behavior remains explicitly unsupported.

## Capabilities And Trust

Capabilities are an allowlist. A requested adapter capability that is unknown or missing from the manifest produces a deterministic refusal with code `ADAPTER_CAPABILITY_UNDECLARED`.

`trust.loadVendorCode` and `signature: "signed-vendor"` are declarations, not permission or proof of signature. The
repository-side validator reports only whether those declarations are structurally compatible. Runtime loading must
remain disabled until a separate loader verifies an actual signature/certificate chain against an approved trust root,
workspace trust, and the selected product cohort. Local or hand-edited JSON can never authorize vendor-code loading.

Mutation authority is declared separately:

- `none`: read-only adapter metadata only
- `sourceFirst`: adapter may request source-first mutations through the designer's transaction path
- `hostedDesignTime`: adapter may request bounded hosted design-time intents

The validator never executes adapter code to decide these states.

## Bounds And Diagnostics

Manifests must declare payload and path bounds. Absolute, drive-relative, alternate-stream, empty/current-directory
segment, and `..` traversal forms are forbidden for v2.0.0. Rejected path values are not echoed into diagnostics.
Validation diagnostics are deterministic machine-readable objects with severity, code, schema path, and message.

External vendor certification, vendor license acceptance, and Visual Studio reference trace capture are not established by this manifest validator. Those remain separate release gates.
