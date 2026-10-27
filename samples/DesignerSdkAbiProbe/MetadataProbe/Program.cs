using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

if (args.Length != 3) throw new ArgumentException("Supply the SDK package directory, compiled independent designer and report path.");
string package = Path.GetFullPath(args[0]);
string designerPath = Path.GetFullPath(args[1]);
string server = Path.Combine(package, "ref", "netcoreapp3.1", "Microsoft.DotNet.DesignTools.Server.dll");
var paths = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
    .Concat(Directory.GetFiles(Path.Combine(package, "ref", "netcoreapp3.1"), "*.dll"))
    .Append(designerPath).ToArray();
using var metadata = new MetadataLoadContext(new PathAssemblyResolver(paths));
var assembly = metadata.LoadFromAssemblyPath(designerPath);
var designer = assembly.GetType("Independent.ModernDesigner.ProbeDesigner", throwOnError: true)!;
var action = assembly.GetType("Independent.ModernDesigner.ProbeActions", throwOnError: true)!;
var editor = assembly.GetType("Independent.ModernDesigner.ProbeCollectionEditor", throwOnError: true)!;
var serverAssembly = metadata.LoadFromAssemblyPath(server);
var baseType = designer.BaseType!;
if (baseType.FullName != "Microsoft.DotNet.DesignTools.Designers.ControlDesigner" ||
    baseType.Assembly.GetName().Name != "Microsoft.DotNet.DesignTools.Server" ||
    editor.BaseType?.FullName != "Microsoft.DotNet.DesignTools.Editors.CollectionEditor" ||
    editor.BaseType?.BaseType?.FullName != "System.Object")
    throw new InvalidOperationException("The independent sample did not compile against the actual SDK designer ABI.");
bool referenceOnly = serverAssembly.GetCustomAttributesData().Any(a => a.AttributeType.FullName == "System.Runtime.CompilerServices.ReferenceAssemblyAttribute");
string runtimeResult;
string? runtimeException = null;
try
{
    // The public loader is allowed to reject the reference assembly. Do not bypass that technical boundary.
    AssemblyLoadContext.Default.LoadFromAssemblyPath(server);
    runtimeResult = "UNEXPECTEDLY_LOADABLE";
}
catch (BadImageFormatException ex)
{
    runtimeResult = "REFERENCE_ASSEMBLY_RUNTIME_REFUSED";
    runtimeException = ex.GetType().FullName + ": " + ex.Message;
}
if (!referenceOnly || runtimeResult != "REFERENCE_ASSEMBLY_RUNTIME_REFUSED")
    throw new InvalidOperationException("The SDK package/runtime boundary changed; reevaluate the ADR decision.");
var inventories = Directory.GetFiles(package, "*.dll", SearchOption.AllDirectories).Select(path => new
{
    path = Path.GetRelativePath(package, path).Replace('\\', '/'),
    identity = AssemblyName.GetAssemblyName(path).FullName,
    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant()
}).ToArray();
if (inventories.Length != 6 || inventories.Any(item => !item.path.StartsWith("ref/", StringComparison.Ordinal)) ||
    Directory.Exists(Path.Combine(package, "lib")) || Directory.Exists(Path.Combine(package, "runtimes")))
    throw new InvalidOperationException("The official SDK payload changed; reevaluate the executable redistribution decision.");
var report = new
{
    schemaVersion = 1, status = "REJECTED_DIRECT_INTEGRATION", probeCompleted = true, contract = "official-Microsoft.WinForms.Designer.SDK-1.6.0",
    compiledSample = new { identity = assembly.GetName().FullName, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(designerPath))).ToLowerInvariant() },
    designerBase = baseType.AssemblyQualifiedName,
    actionListBase = action.BaseType!.AssemblyQualifiedName,
    editorBase = editor.BaseType!.AssemblyQualifiedName,
    editorBaseChain = BaseChain(editor).ToArray(),
    editorPublicConstructors = editor.BaseType!.GetConstructors().Select(c => c.ToString()).ToArray(),
    editorPublicMethods = editor.BaseType!.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Select(m => m.ToString()).ToArray(),
    requiredServices = new[] { "System.ComponentModel.Design.IDesignerHost", "System.ComponentModel.Design.IComponentChangeService" },
    requiredServicesExecution = "NOT_EXECUTED: reference-only SDK does not supply an executable host.",
    commonHostService = typeof(System.ComponentModel.Design.IDesignerHost).AssemblyQualifiedName,
    publicInitialization = baseType.GetMethod("Initialize", new[] { metadata.LoadFromAssemblyName(typeof(System.ComponentModel.IComponent).Assembly.GetName()).GetType("System.ComponentModel.IComponent")! })?.ToString(),
    referenceOnly, runtimeResult, runtimeException,
    nativeUiAcceptance = "NOT_EXECUTED: SDK contains compilation references; executable Visual Studio/DesignToolsServer host is not redistributed or emulated.",
    decision = "EXPLICIT_ADAPTER_REQUIRED: the product does not execute existing Microsoft.DotNet.DesignTools.Server designer binaries.",
    inventories
};
File.WriteAllText(args[2], JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine);
Console.WriteLine("Official SDK compile/ABI/reference-only runtime refusal: PASS");

static IEnumerable<string> BaseChain(Type type)
{
    for (Type? item = type.BaseType; item != null; item = item.BaseType)
        yield return item.AssemblyQualifiedName!;
}
