# Official modern and classic designer ABI decision

The pre-Preview probe is complete. **Direct execution of existing modern WinForms Designer SDK binaries is rejected
for this product.** SDK Preview integration uses an explicit adapter that proposes a bounded result through the
document command authority. The classic `System.Design` ABI is executable through public .NET Framework APIs, but
its service and UI requirements still need operation-specific certification. Neither result certifies an existing
vendor binary.

The independent [probe projects](../../samples/DesignerSdkAbiProbe/README.md) reference neither the extension nor its
Adapter SDK. They were built and executed on Windows using .NET SDK 10.0.301, with NuGet auditing enabled and the
official SDK graph locked. All three builds completed without warnings or errors. The reproducible runner writes a
machine decision, exact source/assembly/package hashes and six command logs. The release record retains those reports.

## Modern SDK: measured rejection of direct integration

`ModernDesigner` compiles a real `ControlDesigner`, `DesignerActionList` and server-side `CollectionEditor` against
the official `Microsoft.WinForms.Designer.SDK` **1.6.0**. This is a compile and metadata probe of Microsoft's ABI;
the project's own adapter sample is not used as a substitute.

The identities read from that compiled sample and the package's public reference metadata are:

| Contract | Exact identity |
|---|---|
| Designer | `Microsoft.DotNet.DesignTools.Designers.ControlDesigner, Microsoft.DotNet.DesignTools.Server, Version=1.6.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35` |
| Action list | `Microsoft.DotNet.DesignTools.Designers.Actions.DesignerActionList` in that same Server assembly |
| Server editor | `Microsoft.DotNet.DesignTools.Editors.CollectionEditor` in that same Server assembly |
| Server editor constructor | `CollectionEditor(IServiceProvider, Type)` |
| Server editor base | `System.Object`; it is not `System.Drawing.Design.UITypeEditor` |
| Designer initialization | `void Initialize(System.ComponentModel.IComponent)` |
| Common host service on this runtime | `System.ComponentModel.Design.IDesignerHost, System.ComponentModel.TypeConverter, Version=10.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a` |

The action explicitly requires `IDesignerHost.CreateTransaction` and `IComponentChangeService.OnComponentChanging` /
`OnComponentChanged`. It uses `TypeDescriptor` to locate the component's `Text` property. These are compiled service
dependencies, **not claims that the SDK base designer was executed**. The server editor requires an `IServiceProvider`
and a collection `Type`; its full host/view-model service inventory is **UNKNOWN / NOT EXECUTED**, because no executable
SDK host is available under the selected route. Returning a non-null incomplete imitation is forbidden by ADR 0003.

The inspected NuGet payload has exactly six DLLs, all under `ref/`: Client, Protocol and Utilities for `net472`, and
Server, Protocol and Utilities for `netcoreapp3.1`. There is no `lib/` or `runtimes/` implementation. The server assembly
has `ReferenceAssemblyAttribute`. Calling the ordinary public assembly loader produces `BadImageFormatException`
**0x80131058**, explicitly stating that a reference assembly cannot be loaded for execution. The probe does not remove
that attribute, rewrite the assembly, use private protocols, search for installed Visual Studio binaries, or copy a
DesignToolsServer implementation.

The pinned package SHA-256 is `5ec59f8b82aa5dbab61fbd84f33137b05a547af8550bd7f68b5dcdb563812296`.
Its `PackageLicense.txt` SHA-256 is `8c95f1f5c458d2296245618f123e537c3579aee22a4a3ea6b72ec085c062abd8`.
The server reference SHA-256 is `c27de0609f22bc406fd3f0424518c02029cefbfe632e07c217579e8fcb81a4c6`.
The package's license grants development/testing use with specified Microsoft products and restricts redistribution
and stand-alone combination. No independent redistribution grant for an executable host was established. The product
does not ship these package binaries. This records the selected dependency boundary; it is not a general license
assessment of any vendor's package.

The official [designer differences](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-differences-framework)
and [designer overview](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-overview)
describe the modern server and .NET Framework client split. The official
[control-library package specification](https://github.com/microsoft/winforms-designer-extensibility/blob/main/docs/sdk/control-library-nuget-package-spec.md)
places server designers under `Design/WinForms/Server` and complex editor/client interactions on a separate route.
The inspected [official NuGet package](https://www.nuget.org/packages/Microsoft.WinForms.Designer.SDK/1.6.0) supplies
the compilation references; those sources do not establish a redistributable standalone execution host.

The native UI boundary therefore remains explicit: server action/adorner support and client editor UI are separate
contracts. This probe executes no modern modal/dropdown window, client proxy, view-model protocol or VS message loop.
Native ownership, focus, Escape/Cancel, nested invocation and timeout cannot be inferred from a successful compile.
The measured machine status is **`REJECTED_DIRECT_INTEGRATION`**, with modern runtime/UI **`NOT_EXECUTED`**.

## Classic ABI: real public host and refusal boundary

`ClassicDesigner` targets .NET Framework 4.8 x64 and references the platform `System.Design`, `System.Drawing` and
`System.Windows.Forms` assemblies. Its entry point is STA and constructs a real `DesignSurface(typeof(Form))` without
displaying a window. `IDesignerHost.CreateComponent` activates the sample's attributed `ControlDesigner`. The action
list is discovered through the actual designer, the selection service selects the component, and the action commits
a real designer transaction while changing its caption. The measured postconditions are caption `Classic ABI probe`,
two changing notifications, two changed notifications and one committed transaction.

| Contract | Exact identity |
|---|---|
| Designer | `System.Windows.Forms.Design.ControlDesigner, System.Design, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a` |
| Action list | `System.ComponentModel.Design.DesignerActionList` in that same System.Design assembly |
| Editor | `System.Drawing.Design.UITypeEditor, System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a` |
| Editor service | `System.Windows.Forms.Design.IWindowsFormsEditorService, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089` |
| Host, change and selection interfaces | `System.ComponentModel.Design.*` in `System, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089` |

The actual surface provides `IDesignerHost`, `IComponentChangeService` and `ISelectionService`. It does not provide
`IMenuCommandService`, `ITypeResolutionService` or `IDesignerSerializationService` in this setup; the JSON records each
as **UNAVAILABLE**. Their absence is not concealed behind no-op services. All components/designers are disposed with
the surface after the synchronous STA invocation.

`TypeDescriptor` independently activates the attributed custom `UITypeEditor`; its declared style is `DropDown`.
`EditValue` requests the public `IWindowsFormsEditorService` and makes one actual `DropDownControl` call. The supplied
headless boundary immediately refuses it with `NATIVE_UI_NOT_EXECUTED`; the editor returns the original `unchanged`
value. No native UI is displayed. If the service is unavailable, the editor also preserves the value and names
`NATIVE_EDITOR_SERVICE_UNAVAILABLE`. The headless boundary is deliberately a refusal, not a certified implementation
of interactive editor UI. Ownership, focus, Escape/Cancel and modal behavior remain separate product acceptance gates.

The measured classic result is **PASS for public DesignSurface/designer/action calls and the headless editor refusal**.
It proves this specific classic sample can use those public contracts. It does not prove an arbitrary vendor's designer
requires only those services, nor that it can bypass the product's command/transaction boundary.

## Preview decision

The [ADR 0003](../adr/0003-v2-hosted-services-and-dual-lane-persistence.md) restriction on proprietary binaries and
undocumented protocols remains in force. The Preview supports only its published capability catalogue through an
explicit adapter. Existing modern designer binaries are not accepted as though they were adapters. Classic binaries
also need explicit provenance, trust, service completeness and operation postconditions before any product execution.
Native editor UX and vendor certification require their own evidence; this probe grants neither.
