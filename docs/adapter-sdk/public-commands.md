# Adapter SDK Preview public command surface

SDK 0.1.0 packages are explicitly enabled trusted author code. Invocations are available through commands registered
by the extension and use the same document source transaction as ordinary edits. None of these commands accepts a
source patch, arbitrary workspace path to write, or an in-process designer object.

`packageUri` identifies the file URI of `adapter-package.json`. `documentUri` identifies the form accepted by the
designer. URI strings and `vscode.Uri` values follow the command's documented object argument; automation should use
URI strings. The package must be inside the trusted workspace and every selected file must pass the loader checks.

| Command | Argument | Result / effect |
|---|---|---|
| `winformsDesigner.inspectAdapterPackage` | `{packageUri, documentUri?}` | `{ok,code?,packageSha256,manifest?}`; inspect and verify without executing the adapter |
| `winformsDesigner.enableAdapterDevelopment` | `{packageUri,expectedPackageSha256,acknowledgeTrustedCodeExecution:true}` | Explicit enablement for the verified current package; a changed hash requires a new acknowledgement |
| `winformsDesigner.disableAdapter` | `{packageUri}` | Revoke the package's execution permission |
| `winformsDesigner.invokeAdapterAction` | `{documentUri,packageUri,contributionId,componentId,input?}` | `{status:'ok'|'refused'|'cancelled',code?,applied?}`; invoke a declared action |
| `winformsDesigner.editAdapterProperty` | Same invocation argument | Invoke a declared editor; without an explicit input value the host presents its input/dropdown UI |
| `winformsDesigner.inspectDocument` | `{documentUri}` | `{ready,disposed,documentUri,documentInstanceId,revision,sourceText,engineKind,dirty,persistenceLane,adapterEditor}` from the actual custom document model |
| `winformsDesigner.resetDesignerProperty` | `{documentUri,componentId,propertyName}` | `{status:'ok'|'refused',code?,applied?,revision?,persistenceLane?}`; reset the live editable property through the ordinary Reset path |
| `winformsDesigner.inspectHostedServices` | `{documentUri}` | The actual versioned hosted service profile and its supported contracts; unavailable profiles return a named refusal |

`input` is `{invariantValue?:string,cancel?:boolean}`. An explicit invariant value is the public automation route to
the editor contract; normal interactive use omits it and uses the host's input or dropdown. A dropdown value must be
one of the declared choices, for both an explicit input and a successful returned intent. An existing property value
may be outside the current choice list; inspecting that value does not itself mutate or normalize it. `cancel:true`
represents cancellation and cannot be turned into an applied intent.
Escape dismisses the host editor without mutation. Input is bounded data and cannot choose another component,
property, or revision inside the child response.

An invocation's current revision, property type, requested services, trust, hash-bound enablement and loader evidence
are checked before execution and again before source application. Disabling a package while its child is in flight
prevents a late result from being applied. Wrong response types, target changes, stale revisions, malformed/extra
frames, timeout, and child crashes refuse without accepting an edit.

The SDK 0.1 mutation profile is an editable, owned scalar property on a nonlocalized form: `System.String`,
`System.Boolean` or `System.Int32`. Inherited/read-only properties, enums, arbitrary objects and localized/resource
edits remain named refusals. `resetDesignerProperty` uses the existing ordinary Reset planner and reports the current
`revision` and `persistenceLane` (`ownedRegion`, `sourceFirst`, or `null` when no lane has yet been recorded).
`applied:false` indicates a valid no-op rather than an accepted source change.

`inspectDocument.documentInstanceId` identifies the actual open custom document lifetime; it changes when the
document is closed and reopened. `revision` identifies the current source within that lifetime. The host checks both
so a late result cannot target a replacement document that happens to have the same source/revision.
`adapterEditor` is `null` or `{presented,presentation,requestId}` for the current owned editor. `presented:true` records
an actual input/dropdown shown by the host; it is cleared on dismissal, refusal, revocation or disposal. Interactive
presentation is bounded separately from the child execution deadline and does not expose private native designer UI.

The samples use the built package manifest URI and public commands:

```typescript
const inspected = await vscode.commands.executeCommand('winformsDesigner.inspectAdapterPackage', { packageUri });
await vscode.commands.executeCommand('winformsDesigner.enableAdapterDevelopment', {
  packageUri, expectedPackageSha256: inspected.packageSha256,
  acknowledgeTrustedCodeExecution: true,
});
await vscode.commands.executeCommand('winformsDesigner.invokeAdapterAction', {
  documentUri, packageUri, contributionId: 'sample.set-caption', componentId: 'button1',
  input: { invariantValue: 'Updated caption' },
});
```

Ordinary public Save and Undo commands remain authoritative. Conformance reads unsaved source with
`inspectDocument.sourceText`; reading a separate ordinary text editor or disk alone does not prove a custom document
mutation. The retained acceptance driver runs setup and restore in separate Extension Host launches and reads saved
bytes independently. It never calls a private test hook to simulate restart, enablement, Save, or Undo.
