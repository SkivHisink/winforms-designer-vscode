using System;
using System.ComponentModel;
using System.ComponentModel.Design.Serialization;
using System.Text;
using Microsoft.CodeAnalysis.CSharp;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Visual-Studio-compatible naming for the locals the CodeDom serializer generates for the non-component
    /// objects a designer graph holds (<c>TreeNode</c>, <c>ListViewItem</c>, …).
    ///
    /// Without this service the framework's <c>DesignerSerializationManager</c> falls back to lower-casing the
    /// WHOLE type name (<c>TreeNode</c> → <c>treenode1</c>), while Visual Studio — and therefore every
    /// VS-generated <c>.Designer.cs</c> on disk — emits camelCase (<c>treeNode1</c>). The difference is invisible
    /// to the render, but the save gate compares statement TEXT, so every generated <c>TreeNode</c> line failed to
    /// match its source line and otherwise perfectly round-trippable TreeView forms were refused read-only with a
    /// <see cref="SaveSafetyReason.LostStatements"/> reason. Emitting the name VS emits closes that FALSE refusal
    /// at the source, leaving the gate itself untouched and just as strict.
    ///
    /// IMPORTANT — this service is deliberately shaped for exactly ONE caller: the framework's
    /// <c>DesignerSerializationManager.GetUniqueName</c>, which treats the returned value as a BASE and appends its
    /// own index + uniqueness/collision check (verified: a form with a real field named <c>treeNode1</c> makes the
    /// generated node local skip to <c>treeNode2</c>). So <see cref="CreateName"/> returns an UNNUMBERED base and is
    /// NOT a general "give me a unique component name" service.
    ///
    /// That is why <see cref="SerializerServices"/> exposes it ONLY to the serialization manager and it is NEVER
    /// registered on the <c>DesignSurface</c>. Registering it globally regressed the LOAD path, because the host
    /// consults this service even when a name is supplied explicitly:
    ///   • <c>host.CreateComponent(t, "@class")</c> → <c>ValidateName</c> → a legal verbatim identifier was rejected
    ///     and the whole form became unrepresentable;
    ///   • the ROOT got auto-named <c>form</c>, so a real field named <c>form</c> then threw "Duplicate component
    ///     name" and that form became unrepresentable too.
    /// Both are exactly the FALSE refusals this class exists to remove — keep it serializer-scoped.
    /// </summary>
    internal sealed class VsNameCreationService : INameCreationService
    {
        /// <summary>
        /// Returns the BASE name only (<c>treeNode</c>, not <c>treeNode1</c>): the framework's
        /// <c>DesignerSerializationManager.GetUniqueName</c> always appends its own 1-based index to whatever this
        /// returns, and restarts that index per serialization session (a fresh manager per Serialize call). Handing
        /// back an already-numbered name yields <c>treeNode11</c>, <c>treeNode21</c>, … — the fallback we are here
        /// to fix produced <c>treenode</c> + index for exactly the same reason.
        /// </summary>
        public string CreateName(IContainer? container, Type dataType)
        {
            ArgumentNullException.ThrowIfNull(dataType);
            return CamelCase(dataType.Name);
        }

        /// <summary>
        /// Defer to Roslyn rather than hand-rolling identifier rules: C# also allows Unicode letter-number starts
        /// (<c>Ⅰx</c>), combining marks, and the verbatim <c>@keyword</c> spelling, all of which a naive
        /// IsLetter/IsLetterOrDigit scan rejects.
        /// </summary>
        public bool IsValidName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string bare = name[0] == '@' ? name.Substring(1) : name;
            return SyntaxFacts.IsValidIdentifier(bare);
        }

        public void ValidateName(string name)
        {
            if (!IsValidName(name)) throw new ArgumentException("Invalid name: " + name, nameof(name));
        }

        /// <summary>
        /// VS's camel-casing: lower-case the leading upper-case run, stopping at the upper-case char that begins
        /// the next word (<c>TreeNode</c>→<c>treeNode</c>, <c>Button</c>→<c>button</c>, <c>UIForm</c>→<c>uiForm</c>).
        /// </summary>
        internal static string CamelCase(string name)
        {
            if (string.IsNullOrEmpty(name)) return name;
            var sb = new StringBuilder(name.Length);
            for (int i = 0; i < name.Length; i++)
            {
                if (char.IsUpper(name[i]) && (i == 0 || i == name.Length - 1 || char.IsUpper(name[i + 1])))
                {
                    sb.Append(char.ToLowerInvariant(name[i]));
                }
                else
                {
                    sb.Append(name.Substring(i));
                    break;
                }
            }
            return sb.ToString();
        }
    }

    /// <summary>
    /// Hands <see cref="VsNameCreationService"/> to the serialization manager and NOTHING else — every other service
    /// resolves straight from the design surface. Scoping it this way is what keeps VS-style generated-local naming
    /// from leaking into the LOAD path, where the host would validate/auto-name real source components with it and
    /// turn legal forms unrepresentable (see the remarks on <see cref="VsNameCreationService"/>).
    /// </summary>
    internal sealed class SerializerServices : IServiceProvider
    {
        private readonly IServiceProvider _inner;
        private readonly VsNameCreationService _names = new();

        public SerializerServices(IServiceProvider inner) => _inner = inner;

        public object? GetService(Type serviceType) =>
            serviceType == typeof(INameCreationService) ? _names : _inner.GetService(serviceType);
    }
}
