# Adapter SDK Preview 0.1.0

This package is the public, data-only contract for explicitly enabled local development adapters in WinForms Designer
2.3.x. It contains TypeScript declarations, strict runtime validators, the package JSON Schema, and a one-request stdio
helper. It has no third-party runtime dependencies. Node 24 is the supported authoring runtime.

The adapter executes in a separate process with normal OS privileges. Workspace trust and an explicit acknowledgement
for the exact package hash are required. A child process, checked imports, deadlines, and content hashes do not form a
security sandbox. These samples have no vendor certification and establish no compatibility with existing vendor
designer assemblies.

## Package and build

The repository's [independent samples](../samples/AdapterSdkPreview/README.md) build without importing extension
sources:

```powershell
node samples/AdapterSdkPreview/build.mjs
node --test adapter-sdk/test/*.test.mjs
```

Each output directory contains `adapter-package.json`, `adapter.mjs`, and a declared `sdk.mjs` dependency. The manifest
lists SHA-256 for every executable package file. The manifest does not hash itself; the product computes a package
identity from the manifest and independently verified file bytes. A content change requires a new inspection and
explicit enablement. Do not copy a stored enablement token to another package.

An author can package the SDK itself with `npm pack ./adapter-sdk`. The npm package includes only `index.mjs`,
`index.d.mts`, `adapter-package.schema.json`, this guide, and npm's standard package metadata. The package is a local
build artifact until it is deliberately published.

```typescript
import { responseFor, serveAdapter, type AdapterHandler } from '@winforms-designer/adapter-sdk';

const handler: AdapterHandler = request => {
  if (request.input.cancel) return responseFor(request, { status: 'cancelled' });
  return responseFor(request, {
    status: 'ok',
    intent: {
      kind: 'setProperty', componentId: request.context.componentId,
      propertyName: 'Text', propertyType: 'System.String', invariantValue: 'New caption',
    },
  });
};
await serveAdapter(handler);
```

Compile TypeScript to `.mjs` before packaging. The sample packages use executable ESM source and a deterministic copy,
syntax check, manifest validation, and hash-generation build. Every imported package module must be declared and
verified. Bare imports, undeclared files, native modules, and arbitrary built-ins are refused by the current host
profile; the SDK's `node:buffer` dependency is explicitly admitted. Child requests contain only scalar selection
metadata, never the document's source or a workspace path.

## Typed contract and bounds

`validateAdapterPackage`, `validateAdapterRequest`, and `validateAdapterResponse` return either `{ok:true,value}` or
`{ok:false,diagnostics:[{code,path}]}`. Unknown fields are refused at each object boundary. JSON Schema checks shape;
the runtime validator also checks cross-field relationships, canonical scalar invariants, entrypoint membership,
case-insensitive path aliases, and declaration consistency. Files, trust, cohort selection, live property metadata,
and commit baselines are checked independently by the product.
The host passes the selected contribution to `validateAdapterRequest(request, contribution)` before child execution
and to `validateAdapterResponse(response, request, contribution)` before application. That metadata is required to
enforce the declared dropdown choice set; the wire helper alone does not discover a package manifest.

The exact Preview capabilities are:

| Capability | Contribution | Successful proposal |
|---|---|---|
| `action.set-property` | A named designer command | One `setProperty` intent for the selected component and declared property |
| `editor.scalar` | An input or dropdown property editor | One `setProperty` intent for the selected component and declared property |

`propertyType` is `System.String`, `System.Boolean`, or `System.Int32`. All values cross the boundary as
`invariantValue`: strings are at most 8,192 UTF-8 bytes, booleans are exactly `True`/`False`, and signed Int32 values use
canonical decimal text in the exact Int32 range. A response cannot change the request's target or declared type.
An `ok` result is a proposal; the host converts it using live property metadata, revalidates its document revision,
and commits through the ordinary source transaction and Undo path. A refused or cancelled result has no intent.
For a dropdown, explicit inputs and successful returned values must belong to its declared choice list. An old current
value outside that list remains readable and is never normalized merely by opening or inspecting the editor. The
Preview mutation profile is restricted to editable owned scalar properties on nonlocalized forms; inherited/read-only,
enum, arbitrary object and localized/resource edits remain named refusals.

One process handles one line of JSON. The maximum frame is 65,536 bytes including its newline, with a 5-second
execution deadline. Termination has a separate confirmation bound of 5 seconds; an unconfirmed exit refuses and
retains the physical admission until actual close. A package declares at most 16 files, each at most 1 MiB and
together at most 4 MiB. Package paths are portable
relative paths: no parent/current traversal, empty segments, absolute or drive-relative paths, alternate streams,
backslashes, device names, or casing aliases. There are at most 16 actions, 16 editors, and 32 dropdown choices.

Optional `requiredServices` uses the closed 0.1 service IDs: `ContainerSiting`, `Naming`, `ComponentChange`, `Selection`,
`Transactions`, `MenuCommands`, `ToolboxCatalog`, `TypeResolution`, and `PropertySerialization`. This is a requirement
on the actual hosted service profile, not a request to pass those services into the child. Missing services refuse the
invocation before execution; an incomplete `IDesignerHost` does not establish the profile. `disabledReasonCode` is
stable read-only metadata and cannot grant authority.

## Compatibility and migration

| Axis | SDK 0.1 profile |
|---|---|
| Package schema | `winforms-designer.adapter-package`, schema version `1` |
| Authoring SDK | Exactly `0.1.0`; other Preview versions require a migration |
| Child protocol | `winforms-designer.adapter-stdio`, version `1` |
| Product cohort in the samples | `2.3.0` inclusive to `2.4.0` exclusive |
| Managed routes | Modern and .NET Framework 4.8; independently checked by the release's host conformance runs |
| Architectures | x64, modern ARM64 package declaration; physical ARM64 execution remains a separate release gate |
| Trust policy | Explicit `local-development`, certification `none` |
| Unsupported | Source patches, arbitrary object values, unrestricted service objects, vendor certification, direct VS designer server rehosting, COM/ActiveX and x86 |

The old `winforms-designer.v2.adapter-manifest` schema version 1 remains a static compatibility declaration. It neither
loads an executable entrypoint nor enables this SDK. Its `signed-vendor` string is not a signature or execution grant.
To migrate from that declaration, author a separate package, declare exact capabilities and files, select a cohort,
and explicitly enable that package through the public local development command. There is no automatic migration
of execution permission. A future Preview schema/SDK change must add versioned migration notes and rerun conformance.

For [public commands](../docs/adapter-sdk/public-commands.md), [diagnostics](../docs/adapter-sdk/diagnostics.md), and the
[modern/classic integration decision](../docs/adapter-sdk/abi-probe.md), see the SDK documentation.
