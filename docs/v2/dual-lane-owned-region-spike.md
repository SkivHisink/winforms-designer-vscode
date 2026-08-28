# V2-DOC-001 dual-lane owned-region spike

Date: 2026-08-20
Status: repository kill-spike evidence

## Scope

This spike adds a bounded Lane B planner for one intentionally narrow operation: setting a property inside the
designer-owned `InitializeComponent` body. It does not write files and it is not wired into the product command path.
The output is a plan that must still be committed through the transaction runner.

The implemented proof lives in:

- `engine/DesignerOwnedRegionSerializer.cs`
- `tests/Engine.UnitTests/DesignerOwnedRegionSerializerTests.cs`
- `engine/Program.cs` (`PreviewOwnedRegionPropertySet`, preview-only JSON-RPC exposure)
- `extension/src/engineClient.ts` (`previewOwnedRegionPropertySet`, explicit opt-in client wrapper)
- `extension/src/e2e.ts` (real named-pipe JSON-RPC proof)

## Proven repository behavior

The planner accepts a full `.Designer.cs` buffer plus an exact SHA-256 fingerprint. It refuses before planning when the
fingerprint does not match the current source text.

For representative `Form` and `UserControl` designer inputs, the planner:

- resolves exactly one parameterless `InitializeComponent`;
- rejects multiple, missing, or ambiguous designer methods;
- rejects syntax errors, comments, preprocessor directives, disabled text, skipped tokens, and unmodeled
  `InitializeComponent` statements inside the owned region;
- requires full `DesignerIrBuilder` coverage and `IrValidate` acceptance before and after the edit;
- asks the existing Lane A source-first planner, `DesignerPropertyEditor.EditProperty`, to plan the same property-set
  intent;
- replaces only the bytes between the `InitializeComponent` body braces;
- proves every byte outside that owned region is preserved;
- compares the Lane B replacement result to the Lane A source text and to a stable semantic IR signature;
- emits a normalization preview containing the replaced byte span, replacement size, line-ending mode, semantic hashes,
  and outside-region preservation result.

## Refusal boundary

This is a kill-spike, not a broad hosted serializer. Shapes that cannot prove ownership or full semantic equivalence
remain Lane A/source-first or refuse. In particular, the spike refuses:

- comments or directives inside `InitializeComponent`;
- multiple or nested competing `InitializeComponent` declarations;
- unmodeled source statements such as arbitrary method calls;
- stale source fingerprints;
- calls through the JSON-RPC preview endpoint unless `optIn=true` is supplied;
- any Lane A output that changes more than the target property;
- any owned-region splice that is not byte-identical to the Lane A result outside the region.

## API exposure

The modern engine now exposes the planner as `PreviewOwnedRegionPropertySet`. The endpoint is intentionally
preview-only:

- it reads either the caller-supplied `sourceText` buffer or the current designer file text;
- it never writes the designer file or any workspace file;
- it does not call `Prewarm` or load a designer graph;
- it refuses unless the caller passes `optIn=true`;
- it returns both `plannedSourceText` and `laneASourceText`, plus `semanticEquivalence`, `outsideRegionPreserved`,
  region offsets, replacement text, and normalization preview;
- it is not called by the normal property-grid `SetProperty` path.

The TypeScript client wrapper is named `previewOwnedRegionPropertySet` and keeps the same boundary: the caller must pass
the expected SHA-256 fingerprint and `optIn=true`. A successful preview is still just a proposed text payload; a future
caller must commit it through the existing transaction/undo path.

## Not executed

Visual Studio reference round-trip is **NOT_EXECUTED** for this spike. No Visual Studio instance was used, no external
reference trace was captured, and no release claim should treat this as extension to Visual Studio to extension parity.

The spike only proves that the repository can produce and validate a constrained owned-region Lane B plan for the tested
property-set shape. Broader Lane B serialization for add/remove components, resources, hosted designers, vendor controls,
normalization consent, and Visual Studio round-trip remains future work.
