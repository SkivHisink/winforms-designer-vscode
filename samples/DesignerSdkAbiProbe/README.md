# Independent designer ABI probe

This sample deliberately references neither the extension nor its Adapter SDK Preview. `ModernDesigner` builds a real
`Microsoft.WinForms.Designer.SDK` 1.6.0 `ControlDesigner`, action list and server `CollectionEditor`. `ClassicDesigner`
is a separate .NET Framework 4.8 program using `System.Design`. `MetadataProbe` reads public type identities without
executing reference assemblies, then verifies that the public runtime loader refuses the official server reference.

Run on Windows with the repository's pinned .NET SDK and the .NET Framework 4.8 targeting pack:

```powershell
pwsh -NoProfile -File samples/DesignerSdkAbiProbe/run-probe.ps1
```

The script writes hash-bound JSON and command logs into the ignored checkout-local evidence directory. The official
SDK version and its transitive graph are locked. Repository NuGet auditing remains enabled. The sample does not copy
SDK binaries into product outputs or introduce a product dependency on them.

The expected result is an explicit research decision: **modern direct integration rejected**, **classic public
DesignSurface/action service invocation passed**, and **native editor UI not executed**. The headless editor service
is a named refusal boundary; it is not interactive UI acceptance. See the [ABI decision](../../docs/adapter-sdk/abi-probe.md).
