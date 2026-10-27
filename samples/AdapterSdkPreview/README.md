# Adapter SDK Preview samples

Two independent adapter packages demonstrate the action and property editor contracts. Their source and package
metadata live outside the extension sources. They use the public [Adapter SDK Preview](../../adapter-sdk/README.md)
package and do not claim vendor certification.

Run `node samples/AdapterSdkPreview/build.mjs` from the repository root with Node 24. This command builds
`action/bin/adapter-package.json` and `editor/bin/adapter-package.json`, validates the closed declarations, syntax
checks each module, and binds every executable file to SHA-256. `--sample=action` or `--sample=editor` selects one
package. No extension module, bundled extension, third-party package or engine source is imported by this build.
The same authoring tree can be copied with `adapter-sdk/` into a separate directory and built there.

| Package | Public contribution | Contract |
|---|---|---|
| `action/` | `sample.set-caption` | An explicitly invoked designer action proposes a `Text` string; `REFUSE` returns a deliberate refusal |
| `editor/` | `sample.caption-editor` | A dropdown property editor accepts one of three declared caption choices |

Both return cancellation without an intent and leave source conversion/writing/Undo to the host. The action requires
the actual `Transactions` and `ComponentChange` services; the editor requires `TypeResolution` and
`PropertySerialization`. Each package declares SDK `0.1.0` and product `2.3.0` inclusive to `2.4.0` exclusive.

`conformance.mjs` exports `runAdapterConformance(host, options)`. `host` supplies the public command executor, actual
custom document source inspection, Save, Undo and optional saved-byte inspection. Setup runs seven cases, saves the
editor result, and exits. Restore runs five cases in a new Extension Host process: saved state, persistent enablement,
action/editor Undo, revocation and explicit re-enablement. The outer release driver creates the real process boundary;
this module never simulates a restart with a private hook. The driver additionally tests wrong type, modified
entrypoint, incomplete service, trust revocation, timeout and late/stale result refusals.

The [public command guide](../../docs/adapter-sdk/public-commands.md) documents enablement acknowledgement and argument
types. Run `node --test adapter-sdk/test/*.test.mjs` for independent author-copy build and actual child-process wire
contract checks. Those Node tests complement the real product's two-launch conformance; they do not replace it.
