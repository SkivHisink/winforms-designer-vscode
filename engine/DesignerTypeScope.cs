using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Xml;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Binds a type name as WRITTEN in a designer file to the type the C# compiler bound it to, for the modern
    /// interpreter. Visual Studio writes modern projects in the simplified style (<c>button1 = new Button();</c>,
    /// <c>new Size(…)</c>, <c>Color.Red</c>) and relies on the file's using directives and on the project's global
    /// usings. No reflection lookup can resolve such a name by itself: the CLR only knows namespace-qualified names.
    ///
    /// Two independent answers must agree before an inferred name is used:
    /// <list type="number">
    /// <item>this binder, which follows C#'s lookup (<see cref="DesignerIrBuilder.SourceScopesOf"/>) over the designer
    /// file and over a SUPERSET of the project's sources (<see cref="ProjectSourceFacts"/>), and refuses what it cannot
    /// settle the way the compiler does — two imports supplying the name, a using alias of that name, an uninspectable
    /// <c>using static</c>, a type the sources declare that the build lacks, global usings it cannot see;</item>
    /// <item>the project's build (<see cref="DesignerBuildEvidence"/>): what the compiled InitializeComponent constructs,
    /// reads, calls and casts to. It covers what no project file shows (a package's build files, a source generator,
    /// an SDK-attributed import). No build, or a build that does not show the operation, refuses the name.</item>
    /// </list>
    /// A qualified name (<c>System.Windows.Forms.Button</c>) is not inferred and keeps the interpreter's exact lookup.
    ///
    /// Names only: what may be constructed, read or invoked is still decided by the interpreter's allowlists on the
    /// resolved type, and the assemblies searched are the ones the qualified lookup already searches.
    /// </summary>
    internal sealed class DesignerTypeScope
    {
        private readonly List<SourceNameScope> _steps;
        private readonly IReadOnlyList<Assembly> _search;
        private readonly Assembly? _designedAssembly;
        private readonly Func<string, Type?> _qualified;
        private readonly Func<ProjectSourceFacts> _loadProject;
        private readonly HashSet<string> _nestedTypeNames;
        private readonly string? _simpleNamesUnknown;
        private readonly HashSet<string> _fileAliases;
        private readonly Type? _compiledDesigned;
        private readonly Type? _rootType;
        private readonly string _designedName;
        private readonly IReadOnlyDictionary<string, string?> _designedMembers;
        private readonly SyntaxNode? _initializeComponent;
        private readonly IReadOnlyList<(string Namespace, string Name)> _bufferDeclarations;
        private ProjectSourceFacts? _project;
        private DesignerBuildEvidence? _evidence;
        private StatementSyntax? _current;
        private readonly ISet<string> _fieldNames;
        private HashSet<string>? _localNames;
        private readonly Dictionary<string, (Type? Type, string? Refusal)> _cache = new(StringComparer.Ordinal);
        private readonly Dictionary<string, (bool Found, Type? Type, string? TypeText)> _memberCache = new(StringComparer.Ordinal);

        private static readonly ConditionalWeakTable<Assembly, HashSet<string>> LoadedNamespaces = new();

        internal DesignerTypeScope(List<SourceNameScope> steps, IReadOnlyList<Assembly> search, Assembly? designedAssembly,
            Func<string, Type?> qualified, Func<ProjectSourceFacts> loadProject,
            IEnumerable<string>? nestedTypeNames = null, string? simpleNamesUnknown = null,
            Type? compiledDesigned = null, Type? rootType = null, string designedName = "",
            IReadOnlyDictionary<string, string?>? designedMembers = null,
            SyntaxNode? initializeComponent = null,
            IReadOnlyList<(string Namespace, string Name)>? bufferDeclarations = null, ISet<string>? fieldNames = null)
        {
            _steps = steps;
            _search = search;
            _designedAssembly = designedAssembly;
            _qualified = qualified;
            _loadProject = loadProject;
            _nestedTypeNames = new HashSet<string>(nestedTypeNames ?? Array.Empty<string>(), StringComparer.Ordinal);
            _simpleNamesUnknown = simpleNamesUnknown;
            _fileAliases = new HashSet<string>(steps.SelectMany(s => s.Aliases), StringComparer.Ordinal);
            _compiledDesigned = compiledDesigned;
            _rootType = rootType;
            _designedName = designedName;
            _designedMembers = designedMembers ?? new Dictionary<string, string?>();
            _initializeComponent = initializeComponent;
            _bufferDeclarations = bufferDeclarations ?? Array.Empty<(string, string)>();
            _fieldNames = fieldNames ?? new HashSet<string>(StringComparer.Ordinal);
        }

        /// <summary>The scope of <paramref name="cls"/>: the class is designed onto an instance of
        /// <paramref name="rootType"/>; <paramref name="compiledDesigned"/> is the project's own build of the class
        /// when it is loaded.</summary>
        public static DesignerTypeScope For(ClassDeclarationSyntax cls, Type rootType, Type? compiledDesigned,
            IReadOnlyList<Assembly> userAsms, IReadOnlyList<Assembly> probe, Func<string, Type?> qualified,
            string designerFilePath)
        {
            Assembly? designed = compiledDesigned?.Assembly ?? (userAsms.Count > 0 ? userAsms[0] : null);
            var nested = new HashSet<string>(StringComparer.Ordinal);
            var members = new Dictionary<string, string?>(StringComparer.Ordinal);
            var fields = new HashSet<string>(FormClassResolver.FieldNamesOf(cls), StringComparer.Ordinal);
            foreach (var part in DesignerModifiers.PartialsOf(cls))
                foreach (var member in part.Members)
                    AddMember(member, nested, members);

            string? unknown = null;
            // A form declared inside another type would also see that type's members and nested types; Visual Studio
            // does not design such a form, and neither does this binder by simple name.
            if (cls.Ancestors().OfType<TypeDeclarationSyntax>().Any()) unknown = "the form is declared inside another type";
            // Text under an inactive #if may be a using or a declaration of the real build.
            else if (cls.SyntaxTree.GetRoot().DescendantTrivia().Any(t => t.IsKind(SyntaxKind.DisabledTextTrivia)))
                unknown = "the designer file has code under an inactive #if";
            // The class's own nested types (any accessibility: the designer file is inside it), then what its base
            // chain lets a derived class see. Both come before every namespace in C#'s lookup.
            if (unknown == null && !AddNestedTypes(nested, compiledDesigned, designed, true))
                unknown = "the nested types of " + compiledDesigned!.FullName + " could not be inspected";
            for (Type? b = compiledDesigned?.BaseType ?? rootType; b != null && unknown == null; b = b.BaseType)
                if (!AddNestedTypes(nested, b, designed, false)) unknown = "the nested types of " + b.FullName + " could not be inspected";

            var declarations = new List<(string, string)>();
            if (cls.SyntaxTree.GetRoot() is CompilationUnitSyntax unit)
                ProjectSourceFacts.CollectDeclarations(unit, declarations, null, null);

            // The component-model types Visual Studio writes (ComponentResourceManager, ISupportInitialize, Container)
            // are found by simple name too; what may be constructed or invoked is still the interpreter's allowlists.
            var search = userAsms.Concat(probe)
                .Append(typeof(System.ComponentModel.ComponentResourceManager).Assembly)
                .Append(typeof(System.ComponentModel.ISupportInitialize).Assembly)
                .Distinct().ToList();
            return new DesignerTypeScope(DesignerIrBuilder.SourceScopesOf(cls), search,
                designed, qualified, () => ProjectSourceFacts.For(designerFilePath), nested, unknown, compiledDesigned,
                rootType, FormClassResolver.QualifiedName(cls), members, FormClassResolver.InitMethodOf(cls), declarations, fields);
        }

        internal static void AddMember(MemberDeclarationSyntax member, HashSet<string> nested, Dictionary<string, string?> members)
        {
            switch (member)
            {
                // With the generic arity, as the CLR names them: `System<T>` does not hide the namespace `System`.
                case BaseTypeDeclarationSyntax type: nested.Add(ArityName(type.Identifier.ValueText, (type as TypeDeclarationSyntax)?.TypeParameterList)); break;
                case DelegateDeclarationSyntax del: nested.Add(ArityName(del.Identifier.ValueText, del.TypeParameterList)); break;
                case FieldDeclarationSyntax field:
                    foreach (var v in field.Declaration.Variables) members[v.Identifier.ValueText] = field.Declaration.Type.ToString();
                    break;
                case PropertyDeclarationSyntax property: members[property.Identifier.ValueText] = property.Type.ToString(); break;
                case MethodDeclarationSyntax method: members[method.Identifier.ValueText] = null; break;
                case EventFieldDeclarationSyntax evt:
                    foreach (var v in evt.Declaration.Variables) members[v.Identifier.ValueText] = null;
                    break;
                case EventDeclarationSyntax evt: members[evt.Identifier.ValueText] = null; break;
            }
        }

        // ------------------------------------------------------------------ binding ---------------------------------

        /// <summary>The type <paramref name="written"/> denotes, or null. <paramref name="refusal"/> is set when the
        /// name could not be bound the way the compiler binds it (and null is returned).</summary>
        public Type? Resolve(string written, out string? refusal)
        {
            string name = Compact(written);
            if (_cache.TryGetValue(name, out var hit))
            {
                refusal = hit.Refusal;
                return hit.Type;
            }
            var type = Bind(name, null, out refusal);
            _cache[name] = (type, refusal);
            return type;
        }

        /// <summary>
        /// The type a member access's RECEIVER denotes (<c>Color</c> in <c>Color.Red</c>). In an expression C# looks at
        /// members before types: a local, a field or a property of the form with that name is what the receiver means
        /// (<paramref name="isValue"/>), unless it has exactly the type the name denotes (the "Color Color" rule, under
        /// which both readings agree). A value receiver is no type and must not be read as one by any fallback.
        /// </summary>
        public Type? ResolveReceiver(string written, out string? refusal, out bool isValue)
        {
            isValue = false;
            var type = Resolve(written, out refusal);
            string name = Compact(written);
            string first = name.Split('.')[0];
            if (!SyntaxFacts.IsValidIdentifier(first)) return type;
            // Only a simple receiver reads the project's other partials: a qualified one (`System.Drawing.Color`) never
            // causes the project to be read.
            if (!TryFindMember(first, name.Length == first.Length, out Type? memberType, out string? memberTypeText)) return type;
            if (name.Length == first.Length && type != null)
            {
                if (memberType == type) return type;
                if (memberTypeText != null && Resolve(memberTypeText, out _) == type) return type;
            }
            isValue = true;
            refusal = null;
            return null;
        }

        /// <summary>Whether <paramref name="written"/> denotes exactly <paramref name="expected"/> — when inferred, also
        /// confirmed by the project's build of the current statement. Searches <paramref name="expected"/>'s own
        /// assembly too: a name check for a framework type the interpreter never constructs (ISupportInitialize), so
        /// looking in that assembly widens nothing.</summary>
        public bool BindsTo(string written, Type expected)
        {
            string name = Unglobal(Compact(written));
            if (name == expected.FullName) return true;
            return Bind(Compact(written), expected.Assembly, out _) == expected && Evidence().Verdict(_current) == null;
        }

        // Per build (module id), designed type and designer file: the bare layout calls, as written, that the build
        // compiled to Control's method in that type's InitializeComponent.
        private static readonly ConcurrentDictionary<(Guid Build, string Type, string File), HashSet<string>> ProvenBareCallsByBuild = new();
        private static readonly string[] LayoutMethods = { "SuspendLayout", "ResumeLayout", "PerformLayout" };

        /// <summary>
        /// Whether the current statement, a bare layout call, is one the build proves to be Control's, where the project's
        /// usings were read from the build. What a bare call binds to is decided by the declarations of the form, which
        /// for a part linked in from outside the folder only the build holds; a partial method declared there without a
        /// body is erased with its calls and leaves nothing in metadata. So it is decided on the build's own text — the
        /// designer file, when its bytes still have the hash the PDB records — against the build's IL: the build calls
        /// Control's method on the form itself (<c>ldarg.0</c>) exactly as many times as that text invokes the name on
        /// the form (bare, or through <c>this</c> or <c>base</c>). An invocation compiles to at most one call, and only an
        /// invocation on the form calls on <c>ldarg.0</c>, so equal counts mean that none of them was erased or bound to
        /// another method of that name; each bare call of the text, as written, is then proven for that build, and the
        /// proof is kept for it. A current call written the same way is replayed. The declarations of a linked part are
        /// the build's, as for every file outside the project.
        /// </summary>
        private bool ProvenBareCall()
        {
            if (_simpleNamesUnknown != null || _current is not ExpressionStatementSyntax
                { Expression: InvocationExpressionSyntax { Expression: IdentifierNameSyntax } current }) return false;
            return ProvenBareCalls() is { } proven && proven.Contains(CallText(current));
        }

        private static string CallText(InvocationExpressionSyntax invocation) =>
            ((IdentifierNameSyntax)invocation.Expression).Identifier.ValueText + "("
            + string.Join(",", invocation.ArgumentList.Arguments.Select(a => Compact(a.ToString()))) + ")";

        private HashSet<string>? ProvenBareCalls()
        {
            if (_compiledDesigned == null) return null;
            var project = Project();
            if (project.ProjectDirectory is not { } projectDir || project.DesignerPath is not { } designerPath) return null;
            var key = (_compiledDesigned.Module.ModuleVersionId, _compiledDesigned.FullName ?? _compiledDesigned.Name,
                Path.GetFullPath(designerPath).ToUpperInvariant());
            if (ProvenBareCallsByBuild.TryGetValue(key, out var known)) return known;
            var evidence = Evidence();
            if (evidence.Unavailable != null) return null;
            // Not the build's text (changed since): nothing is proven now, and nothing is kept.
            if (ProjectSourceFacts.CompiledDesignerText(_compiledDesigned, projectDir, designerPath) is not { } text) return null;

            var proven = new HashSet<string>(StringComparer.Ordinal);
            var unit = CSharpSyntaxTree.ParseText(text).GetCompilationUnitRoot();
            var methods = unit.DescendantNodes().OfType<MethodDeclarationSyntax>()
                .Where(m => m.Identifier.ValueText == "InitializeComponent" && m.ParameterList.Parameters.Count == 0
                    && m.Parent is ClassDeclarationSyntax cls
                    && FormClassResolver.QualifiedName(cls) == _compiledDesigned.FullName)
                .ToList();
            // The body the build compiled for this type, written here (a partial declaration without one proves nothing).
            if (methods.Count == 1 && methods[0].Body == null && methods[0].ExpressionBody == null) methods.Clear();
            // Code under a conditional directive is compiled by the build's symbols, which the PDB does not record.
            if (methods.Count == 1 && unit.GetFirstDirective(d => d is ConditionalDirectiveTriviaSyntax
                    or DefineDirectiveTriviaSyntax or UndefDirectiveTriviaSyntax) == null)
            {
                var method = methods[0];
                var locals = DesignerIrBuilder.DeclaredLocalNames(method);
                foreach (string name in LayoutMethods)
                {
                    if (CountOnTheForm(method, name, locals) is not { } written || written == 0) continue;
                    if (evidence.CallsOnThis(typeof(System.Windows.Forms.Control), name) != written) continue;
                    foreach (var invocation in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
                        if (invocation.Expression is IdentifierNameSyntax bare && bare.Identifier.ValueText == name)
                            proven.Add(CallText(invocation));
                }
            }
            if (ProvenBareCallsByBuild.Count > 256) ProvenBareCallsByBuild.Clear();
            ProvenBareCallsByBuild[key] = proven;
            return proven;
        }

        private static ExpressionSyntax Unparenthesized(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax parenthesized) expression = parenthesized.Expression;
            return expression;
        }

        /// <summary>How many invocations of <paramref name="method"/> call <paramref name="name"/> on the form: bare, or
        /// through <c>this</c> or <c>base</c> (parentheses and casts removed). Null when one of that name has a receiver
        /// that may be the form otherwise (a local, which an optimized build may load straight from <c>ldarg.0</c>, an
        /// <c>as</c>, a call's result) or is a conditional access; a field, property or type path is loaded by its own
        /// instruction and never counts.</summary>
        private static int? CountOnTheForm(SyntaxNode method, string name, ISet<string> locals)
        {
            int written = 0;
            foreach (var invocation in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                switch (Unparenthesized(invocation.Expression))
                {
                    case SimpleNameSyntax simple when simple.Identifier.ValueText == name:
                        written++;
                        break;
                    case MemberAccessExpressionSyntax access when access.Name.Identifier.ValueText == name:
                        var receiver = access.Expression;
                        while (receiver is ParenthesizedExpressionSyntax or CastExpressionSyntax)
                            receiver = receiver is CastExpressionSyntax cast ? cast.Expression : ((ParenthesizedExpressionSyntax)receiver).Expression;
                        switch (receiver)
                        {
                            case ThisExpressionSyntax or BaseExpressionSyntax: written++; break;
                            case IdentifierNameSyntax local when locals.Contains(local.Identifier.ValueText): return null;
                            case IdentifierNameSyntax or MemberAccessExpressionSyntax: break;
                            default: return null;
                        }
                        break;
                    case MemberBindingExpressionSyntax binding when binding.Name.Identifier.ValueText == name:
                        return null;
                }
            }
            return written;
        }

        /// <summary>Whether the designed class, or a base below <see cref="System.Windows.Forms.Control"/>, declares a
        /// member named <paramref name="name"/> — in this file, in another partial of the project, or in a loaded build.
        /// A bare call of that name binds to it, not to the framework method the interpreter would replay.</summary>
        public bool FormHidesMember(string name)
        {
            if (_designedMembers.ContainsKey(name)) return true;
            var project = Project();
            if (project.SourcesIncomplete != null || project.PartialMembers(_designedName).Any(m => m.Member == name)) return true;
            // A part of the form the project file links in is known only through the build, which erases a partial method
            // declared without a body together with its calls: the bare call is Control's only where the build proves it.
            if (project.ReadFromBuild && !ProvenBareCall()) return true;
            const BindingFlags all = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                | BindingFlags.DeclaredOnly;
            try
            {
                if (_compiledDesigned != null && _compiledDesigned.GetMember(name, all).Length > 0) return true;
                for (Type? b = _compiledDesigned?.BaseType ?? _rootType; b != null && b != typeof(System.Windows.Forms.Control); b = b.BaseType)
                    if (b.GetMember(name, all).Any(m => VisibleToDerived(m, b))) return true;
            }
            catch { return true; }
            return false;
        }

        // ------------------------------------------------------------ build evidence --------------------------------

        /// <summary>A component created by inference (<c>f = new X()</c> with X unqualified): the build must store
        /// exactly this type into the same field.</summary>
        public string? VerifyComponent(string field, string written, Type resolved)
        {
            if (!IsInferred(written, resolved)) return null;
            var built = Evidence().ConstructedInto(field, out string? refusal);
            if (refusal != null) return refusal;
            return built == resolved ? null
                : "the project's last build creates " + built!.FullName + " for " + field + "; build the project";
        }

        /// <summary>A value constructed by inference: confirmed only with its whole statement.</summary>
        public string? VerifyConstruction(string written, Type resolved) => Confirm(written, resolved);

        /// <summary>A static property or field read through an inferred receiver: confirmed only with its statement.</summary>
        public string? VerifyStaticRead(string written, Type receiver, MemberInfo member) => Confirm(written, receiver);

        /// <summary>A static method called through an inferred receiver: confirmed only with its statement.</summary>
        public string? VerifyCall(string written, Type receiver, MethodBase method) => Confirm(written, receiver);

        /// <summary>A cast or array element type named by inference: confirmed only with its statement.</summary>
        public string? VerifyTypeUse(string written, Type resolved) => Confirm(written, resolved);

        /// <summary>An enum named by inference as a member access receiver: confirmed only with its statement.</summary>
        public string? VerifyEnum(string written, Type resolved) => Confirm(written, resolved);

        /// <summary>The statement the interpreter is evaluating.</summary>
        public void SetStatement(StatementSyntax? statement) => _current = statement;

        /// <summary>
        /// Why <paramref name="statement"/> must not run, or null. A statement that names no type by inference runs as
        /// before. One that does runs only when the project's build compiled it to exactly the operations it implies
        /// (<see cref="DesignerBuildEvidence"/>) — checked before any of it runs, so nothing is applied and then taken
        /// back. The reason names the first inferred type, as a missing type.
        /// </summary>
        public string? StatementRefusal(StatementSyntax statement)
        {
            var described = Describe(statement);
            if (described.UnboundName != null)
                return "unresolved type " + described.UnboundName + " (" + (described.UnboundReason ?? Evidence().Unavailable
                    ?? "no using of the file or the project supplies it") + ")";
            if (described.InferredName == null) return null;
            return Evidence().Verdict(statement) is { } verdict
                ? "unresolved type " + described.InferredName + " (" + verdict + ")"
                : null;
        }

        private string? Confirm(string written, Type resolved) =>
            IsInferred(written, resolved) ? Evidence().Verdict(_current) : null;

        private static bool IsInferred(string written, Type resolved) =>
            !string.Equals(Unglobal(Compact(written)), resolved.FullName, StringComparison.Ordinal);

        private DesignerBuildEvidence Evidence() => _evidence ??= DesignerBuildEvidence.For(_compiledDesigned,
            (_initializeComponent as MethodDeclarationSyntax)?.Body?.Statements.ToList() ?? new List<StatementSyntax>(),
            _fieldNames, Describe);

        // ----------------------------------------------------- what a statement compiles to ---------------------------

        private readonly Dictionary<StatementSyntax, DesignerSourceStatement> _described = new();

        /// <summary>The steps <paramref name="statement"/> must compile to, in evaluation order, and the first name it
        /// leaves to inference — read from its syntax and this scope's bindings, the same bindings the interpreter
        /// uses.</summary>
        internal DesignerSourceStatement Describe(StatementSyntax statement)
        {
            if (_described.TryGetValue(statement, out var known)) return known;
            var result = new DesignerSourceStatement();
            var ops = new List<DesignerOp>();
            bool complete;
            try { complete = new OpWalker(this, ops, result).Statement(statement); }
            catch { complete = false; }
            result.Ops = complete ? ops : null;
            _described[statement] = result;
            return result;
        }

        private bool IsFieldOrLocal(string name)
        {
            _localNames ??= _initializeComponent != null
                ? DesignerIrBuilder.DeclaredLocalNames(_initializeComponent)
                : new HashSet<string>(StringComparer.Ordinal);
            return _fieldNames.Contains(name) || _localNames.Contains(name);
        }

        /// <summary>Walks one designer statement in the order C# evaluates it — receiver, arguments, then the call or
        /// construction; operand, then the cast; array length, then each index and element — and records each step:
        /// constants with their values (literals, enum members, constant fields and expressions of them, folded as the
        /// compiler folds them), constructions, static and instance members, arrays, casts and delegates. A shape
        /// outside what a designer writes makes the statement incomparable (false).</summary>
        private sealed class OpWalker : IDesignerConstantNames
        {
            private readonly DesignerTypeScope _scope;
            private readonly List<DesignerOp> _ops;
            private readonly DesignerSourceStatement _result;

            public OpWalker(DesignerTypeScope scope, List<DesignerOp> ops, DesignerSourceStatement result)
            {
                _scope = scope;
                _ops = ops;
                _result = result;
            }

            /// <summary>A simple name in a type or receiver position that does not bind, or any name the binder refused:
            /// the statement leaves a type to inference the build cannot confirm. An unbound dotted name is looked up
            /// exactly, as before.</summary>
            private void Unbound(string written, string? refusal)
            {
                string name = Compact(written);
                if (_result.UnboundName != null) return;
                if (refusal == null && !SyntaxFacts.IsValidIdentifier(name)) return;
                _result.UnboundName = name;
                _result.UnboundReason = refusal;
            }

            private void Note(string written, Type resolved)
            {
                if (_result.InferredName == null && IsInferred(written, resolved)) _result.InferredName = Compact(written);
            }

            public bool Statement(StatementSyntax statement)
            {
                switch (statement)
                {
                    case LocalDeclarationStatementSyntax local:
                        // `var` takes the initializer's type: no name, no step.
                        if (!local.Declaration.Type.IsVar && !TypeName(local.Declaration.Type, out _)) return false;
                        foreach (var v in local.Declaration.Variables)
                            if (v.Initializer != null && !Value(v.Initializer.Value)) return false;
                        return true;
                    case ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }:
                        {
                            string prefix = a.Kind() switch
                            {
                                SyntaxKind.SimpleAssignmentExpression => "set_",
                                SyntaxKind.AddAssignmentExpression => "add_",
                                SyntaxKind.SubtractAssignmentExpression => "remove_",
                                _ => "",
                            };
                            if (prefix.Length == 0 || !TargetPath(a.Left, out string? member)) return false;
                            bool valued = prefix == "set_" ? Value(a.Right) : Handler(a.Right);
                            if (!valued) return false;
                            if (member != null) _ops.Add(DesignerOp.Instance(prefix + member));
                            return true;
                        }
                    case ExpressionStatementSyntax { Expression: InvocationExpressionSyntax invocation }:
                        return Invocation(invocation);
                    default:
                        return false;
                }
            }

            // `a.b.c = …`: the members read on the way, before the value. The member set at the end comes after the value
            // (null when the target is a field of the form or a local, which is a store, not a step).
            private bool TargetPath(ExpressionSyntax left, out string? member)
            {
                member = null;
                var chain = new List<string>();
                for (ExpressionSyntax? e = left; e != null; )
                {
                    switch (e)
                    {
                        case MemberAccessExpressionSyntax m: chain.Insert(0, m.Name.Identifier.ValueText); e = m.Expression; break;
                        case IdentifierNameSyntax id: chain.Insert(0, id.Identifier.ValueText); e = null; break;
                        case ThisExpressionSyntax: e = null; break;
                        default: return false;
                    }
                }
                if (chain.Count == 0) return false;
                bool rooted = _scope.IsFieldOrLocal(chain[0]);
                if (chain.Count == 1 && rooted) return true;
                for (int i = rooted ? 1 : 0; i < chain.Count - 1; i++) _ops.Add(DesignerOp.Instance("get_" + chain[i]));
                member = chain[chain.Count - 1];
                return true;
            }

            // `+= button1_Click` / `+= new EventHandler(button1_Click)`: a delegate over a method of the form.
            private bool Handler(ExpressionSyntax right)
            {
                switch (right)
                {
                    case IdentifierNameSyntax id when !_scope.IsFieldOrLocal(id.Identifier.ValueText):
                    case MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax }:
                        _ops.Add(DesignerOp.Delegate);
                        return true;
                    case ObjectCreationExpressionSyntax creation:
                        if (!TypeName(creation.Type, out var type) || type == null || !typeof(Delegate).IsAssignableFrom(type)) return false;
                        _ops.Add(DesignerOp.Delegate);
                        return true;
                    default:
                        return false;
                }
            }

            private bool Invocation(InvocationExpressionSyntax invocation)
            {
                switch (invocation.Expression)
                {
                    case IdentifierNameSyntax bare:
                        if (!Arguments(invocation.ArgumentList)) return false;
                        _ops.Add(DesignerOp.Instance(bare.Identifier.ValueText));
                        return true;
                    case MemberAccessExpressionSyntax { Name: IdentifierNameSyntax name } access:
                        {
                            if (!Receiver(access.Expression, out Type? type, out Type? through)) return false;
                            if (!Arguments(invocation.ArgumentList)) return false;
                            string method = name.Identifier.ValueText;
                            if (type != null)
                            {
                                var declaring = StaticMethodOwner(type, method);
                                if (declaring == null) return false;
                                _ops.Add(DesignerOp.Static(declaring, method));
                            }
                            else _ops.Add(DesignerOp.Instance(method, through));
                            return true;
                        }
                    default:
                        return false;
                }
            }

            private bool Arguments(BaseArgumentListSyntax? arguments)
            {
                if (arguments == null) return true;
                foreach (var argument in arguments.Arguments)
                    if (argument.NameColon != null || !argument.RefKindKeyword.IsKind(SyntaxKind.None) || !Value(argument.Expression))
                        return false;
                return true;
            }

            /// <summary>A receiver: a type (<paramref name="type"/> set, static access) or a value whose steps are
            /// recorded. <paramref name="through"/> is the type a cast names (`((ISupportInitialize)x).BeginInit()`),
            /// which then declares the member called.</summary>
            private bool Receiver(ExpressionSyntax expression, out Type? type, out Type? through, bool nested = false)
            {
                type = null;
                through = null;
                switch (expression)
                {
                    case ThisExpressionSyntax:
                        return true;
                    case ParenthesizedExpressionSyntax p:
                        return Receiver(p.Expression, out type, out through, nested);
                    case CastExpressionSyntax cast:
                        {
                            // The interface is looked up in its own assembly too, as the bracket check does.
                            Type? castType;
                            if (!TypeName(cast.Type, out castType, reportUnbound: false))
                            {
                                string written = cast.Type.ToString();
                                castType = _scope.Bind(Compact(written), typeof(System.ComponentModel.ISupportInitialize).Assembly, out string? refusal);
                                if (refusal != null || castType == null)
                                {
                                    Unbound(written, refusal);
                                    return false;
                                }
                                Note(written, castType);
                            }
                            if (castType == null || !Value(cast.Expression)) return false;
                            if (!castType.IsInterface) _ops.Add(DesignerOp.Cast(castType));
                            through = castType;
                            return true;
                        }
                    case MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax, Name: IdentifierNameSyntax field }
                        when _scope.IsFieldOrLocal(field.Identifier.ValueText):
                        return true;
                    case MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax, Name: IdentifierNameSyntax member }:
                        _ops.Add(DesignerOp.Instance("get_" + member.Identifier.ValueText));
                        return true;
                    case IdentifierNameSyntax id when _scope.IsFieldOrLocal(id.Identifier.ValueText):
                        return true;
                    case IdentifierNameSyntax or MemberAccessExpressionSyntax:
                        {
                            string written = expression.ToString();
                            var resolved = _scope.ResolveReceiver(written, out string? refusal, out bool isValue);
                            if (refusal != null)
                            {
                                if (!nested) Unbound(written, refusal);
                                return false;
                            }
                            if (resolved != null)
                            {
                                Note(written, resolved);
                                type = resolved;
                                return true;
                            }
                            if (expression is IdentifierNameSyntax rootMember)
                            {
                                if (!isValue)
                                {
                                    // `AnchorStyles.Top` with nothing named AnchorStyles in scope. The head of a dotted
                                    // name (`Vendor` in `Vendor.Mode.Fast`) is left to the exact lookup, as before.
                                    if (!nested) Unbound(written, null);
                                    return false;
                                }
                                _ops.Add(DesignerOp.Instance("get_" + rootMember.Identifier.ValueText));
                                return true;
                            }
                            var access = (MemberAccessExpressionSyntax)expression;
                            if (!Receiver(access.Expression, out var owner, out _, nested: true)) return false;
                            if (owner != null) return StaticMember(owner, access.Name.Identifier.ValueText);
                            _ops.Add(DesignerOp.Instance("get_" + access.Name.Identifier.ValueText));
                            return true;
                        }
                    default:
                        return false;
                }
            }

            private bool Value(ExpressionSyntax expression)
            {
                if (Constant(expression, out object? constant, out Type? constantType))
                {
                    _ops.Add(DesignerOp.Constant(constant, constantType));
                    return true;
                }
                switch (expression)
                {
                    case ThisExpressionSyntax:
                        return true;
                    case ParenthesizedExpressionSyntax p:
                        return Value(p.Expression);
                    case CastExpressionSyntax cast:
                        if (!TypeName(cast.Type, out var castType) || castType == null || !Value(cast.Expression)) return false;
                        if (!castType.IsInterface) _ops.Add(DesignerOp.Cast(castType));
                        return true;
                    case ObjectCreationExpressionSyntax creation:
                        {
                            if (creation.Initializer != null || !TypeName(creation.Type, out var type) || type == null) return false;
                            // A decimal is compared as the constant it is (Constant above); one built from anything else
                            // cannot be.
                            if (type == typeof(decimal)) return false;
                            if (typeof(Delegate).IsAssignableFrom(type))
                            {
                                _ops.Add(DesignerOp.Delegate);
                                return true;
                            }
                            if (!Arguments(creation.ArgumentList)) return false;
                            _ops.Add(DesignerOp.New(type));
                            return true;
                        }
                    case ArrayCreationExpressionSyntax array:
                        {
                            // The length comes first: the initializer's count, or the size written. The indexes are the
                            // compiler's; an element equal to the element type's default is not stored at all (the array
                            // starts zeroed). What remains, in order, are the elements.
                            if (array.Type.RankSpecifiers.Count != 1 || array.Type.RankSpecifiers[0].Sizes.Count != 1
                                || !TypeName(array.Type.ElementType, out var element) || element == null) return false;
                            if (array.Initializer != null) _ops.Add(DesignerOp.Constant((long)array.Initializer.Expressions.Count, typeof(int)));
                            else if (Constant(array.Type.RankSpecifiers[0].Sizes[0], out var size, out var sizeType) && size is long)
                                _ops.Add(DesignerOp.Constant(size, sizeType));
                            else return false;
                            _ops.Add(DesignerOp.NewArray(element));
                            foreach (var item in array.Initializer?.Expressions ?? default)
                            {
                                if (Constant(item, out var itemValue) && IsDefault(itemValue, element)) continue;
                                if (!Value(item)) return false;
                            }
                            return true;
                        }
                    case TypeOfExpressionSyntax typeOf:
                        if (!TypeName(typeOf.Type, out var tokenType) || tokenType == null) return false;
                        _ops.Add(DesignerOp.Token(tokenType));
                        _ops.Add(DesignerOp.Static(typeof(Type), nameof(Type.GetTypeFromHandle)));
                        return true;
                    case InvocationExpressionSyntax invocation:
                        return Invocation(invocation);
                    case IdentifierNameSyntax id:
                        return _scope.IsFieldOrLocal(id.Identifier.ValueText);
                    case MemberAccessExpressionSyntax access:
                        {
                            if (!Receiver(access.Expression, out var owner, out _)) return false;
                            if (owner != null) return StaticMember(owner, access.Name.Identifier.ValueText);
                            _ops.Add(DesignerOp.Instance("get_" + access.Name.Identifier.ValueText));
                            return true;
                        }
                    default:
                        return false;
                }
            }

            private bool Constant(ExpressionSyntax expression, out object? value) => Constant(expression, out value, out _);

            /// <summary>The value of a compile-time constant as the build reading sees it — integral values as long,
            /// floating ones as double, decimals, strings, null — and its C# type (null for null). It is folded by
            /// <see cref="DesignerConstantFolder"/>, the folder whose value the interpreter applies, so the value confirmed
            /// is the value shown. A decimal the designer constructs from constants (<c>new decimal(new int[] { … })</c>)
            /// is compared as a constant too. Names it binds are noted like any other.</summary>
            private bool Constant(ExpressionSyntax expression, out object? value, out Type? type)
            {
                value = null;
                type = null;
                if (DesignerConstantFolder.Fold(expression, this, null, out var constant, out _) == ConstantFold.Folded)
                {
                    type = constant.Type;
                    return Normalize(constant.Value, out value);
                }
                var unwrapped = expression;
                while (unwrapped is ParenthesizedExpressionSyntax p) unwrapped = p.Expression;
                return unwrapped is ObjectCreationExpressionSyntax { Initializer: null, ArgumentList: not null } creation
                    && DecimalCreation(creation, out value, out type);
            }

            /// <summary>`new decimal(new int[] { 100, 0, 0, 0 })`, as the designer writes a NumericUpDown value, and the
            /// other decimal constructors over constants.</summary>
            private bool DecimalCreation(ObjectCreationExpressionSyntax creation, out object? value, out Type? type)
            {
                value = null;
                type = null;
                if (!TypeName(creation.Type, out var created) || created != typeof(decimal)) return false;
                var args = new List<object?>();
                foreach (var argument in creation.ArgumentList!.Arguments)
                {
                    if (argument.NameColon != null || !argument.RefKindKeyword.IsKind(SyntaxKind.None)) return false;
                    if (argument.Expression is ArrayCreationExpressionSyntax words)
                    {
                        if (!TypeName(words.Type.ElementType, out var wordType) || wordType != typeof(int)
                            || words.Initializer == null) return false;
                        var items = new List<int>();
                        foreach (var item in words.Initializer.Expressions)
                        {
                            if (!Constant(item, out var word, out _) || word is not long w || w < int.MinValue || w > int.MaxValue) return false;
                            items.Add((int)w);
                        }
                        args.Add(items.ToArray());
                    }
                    else if (Constant(argument.Expression, out var arg, out var argType)) args.Add(argType == typeof(float) ? (object?)(float)(double)arg! : arg);
                    else return false;
                }
                try
                {
                    value = args switch
                    {
                        [int[] bits] => new decimal(bits),
                        [long l] => new decimal(l),
                        [double d] => new decimal(d),
                        [float f] => new decimal(f),
                        [long lo, long mid, long hi, long negative, long scale] when scale is >= 0 and <= 28 =>
                            new decimal(unchecked((int)lo), unchecked((int)mid), unchecked((int)hi), negative != 0, (byte)scale),
                        _ => null,
                    };
                }
                catch (ArgumentException) { return false; }
                catch (OverflowException) { return false; }
                type = typeof(decimal);
                return value != null;
            }

            /// <summary>A name inside a constant expression, as the build reading binds it: an enum member or a constant
            /// field (a decimal constant included) of a type the scope binds. Anything else is not a constant here, and is
            /// walked as the step it is.</summary>
            ConstantFold IDesignerConstantNames.Name(ExpressionSyntax name, Type? hint, out DesignerConstant constant, out string? refusal)
            {
                constant = default;
                refusal = null;
                if (name is not MemberAccessExpressionSyntax access || access.Expression is ThisExpressionSyntax
                    || access.Name is not IdentifierNameSyntax) return ConstantFold.NotConstant;
                if (access.Expression is IdentifierNameSyntax head && _scope.IsFieldOrLocal(head.Identifier.ValueText)) return ConstantFold.NotConstant;
                string written = access.Expression.ToString();
                var owner = _scope.ResolveReceiver(written, out string? why, out _);
                if (why != null || owner == null) return ConstantFold.NotConstant;
                var field = owner.GetField(access.Name.Identifier.ValueText,
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy);
                if (field == null) return ConstantFold.NotConstant;
                if (field.IsLiteral)
                {
                    object? raw = field.GetRawConstantValue();
                    Note(written, owner);
                    constant = new DesignerConstant(field.FieldType.IsEnum && raw != null ? Enum.ToObject(field.FieldType, raw) : raw, field.FieldType);
                    return ConstantFold.Folded;
                }
                // A decimal constant is a static readonly field carrying its value in metadata.
                if (field.FieldType == typeof(decimal) && field.IsInitOnly && DecimalConstantOf(field) is { } known)
                {
                    Note(written, owner);
                    constant = new DesignerConstant(known, typeof(decimal));
                    return ConstantFold.Folded;
                }
                return ConstantFold.NotConstant;
            }

            /// <summary>The type a cast names, bound (and reported when unbound) as any type name the walk meets.</summary>
            Type? IDesignerConstantNames.CastType(TypeSyntax type, out string? refusal)
            {
                refusal = null;
                if (TypeName(type, out var bound)) return bound;
                refusal = "the type " + type + " is not bound";
                return null;
            }

            /// <summary>The value a <c>[DecimalConstant]</c> field records, read from its metadata; nothing is run.</summary>
            private static decimal? DecimalConstantOf(FieldInfo field)
            {
                try
                {
                    foreach (var data in field.GetCustomAttributesData())
                    {
                        if (data.AttributeType != typeof(System.Runtime.CompilerServices.DecimalConstantAttribute)
                            || data.ConstructorArguments.Count != 5) continue;
                        var a = data.ConstructorArguments.Select(x => Convert.ToInt64(x.Value, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                        if (a[0] < 0 || a[0] > 28) return null;
                        return new decimal(unchecked((int)a[4]), unchecked((int)a[3]), unchecked((int)a[2]), a[1] != 0, (byte)a[0]);
                    }
                }
                catch { }
                return null;
            }

            private static bool IsDefault(object? value, Type element) =>
                !element.IsValueType ? value == null
                : element == typeof(decimal) ? value is decimal m && m == 0m
                : value is 0L || value is 0d;

            /// <summary>A constant as the build reading sees it: integral values (bool and char included) as long,
            /// floating ones as double, decimals, strings, null.</summary>
            private static bool Normalize(object? raw, out object? value)
            {
                value = null;
                switch (raw)
                {
                    case null: return true;
                    case string s: value = s; return true;
                    case bool b: value = b ? 1L : 0L; return true;
                    case char ch: value = (long)ch; return true;
                    case float f: value = (double)f; return true;
                    case double d: value = d; return true;
                    case decimal m: value = m; return true;
                    case ulong u: value = unchecked((long)u); return true;
                    case IConvertible c when raw.GetType().IsPrimitive:
                        value = c.ToInt64(System.Globalization.CultureInfo.InvariantCulture);
                        return true;
                    case Enum e:
                        // The underlying value, a ulong one as its bit pattern like any other ulong.
                        return Normalize(Convert.ChangeType(e, Enum.GetUnderlyingType(e.GetType()), System.Globalization.CultureInfo.InvariantCulture),
                            out value);
                    default: return false;
                }
            }

            private bool StaticMember(Type owner, string member)
            {
                if (owner.IsEnum) return false; // an enum member is a constant, taken by Constant
                const BindingFlags flags = BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy;
                var getter = owner.GetProperty(member, flags)?.GetMethod;
                if (getter != null)
                {
                    _ops.Add(DesignerOp.Static(getter.DeclaringType!, getter.Name));
                    return true;
                }
                var field = owner.GetField(member, flags);
                if (field == null || field.IsLiteral || field.DeclaringType == typeof(decimal)) return false;
                _ops.Add(DesignerOp.Static(field.DeclaringType!, field.Name));
                return true;
            }

            private static Type? StaticMethodOwner(Type type, string name)
            {
                var owners = type.GetMember(name, MemberTypes.Method, BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)
                    .Select(m => m.DeclaringType).Distinct().ToList();
                return owners.Count == 1 ? owners[0] : null;
            }

            private bool TypeName(TypeSyntax syntax, out Type? type, bool reportUnbound = true)
            {
                if (syntax is PredefinedTypeSyntax predefined)
                {
                    type = predefined.Keyword.Kind() switch
                    {
                        SyntaxKind.ByteKeyword => typeof(byte), SyntaxKind.SByteKeyword => typeof(sbyte),
                        SyntaxKind.ShortKeyword => typeof(short), SyntaxKind.UShortKeyword => typeof(ushort),
                        SyntaxKind.IntKeyword => typeof(int), SyntaxKind.UIntKeyword => typeof(uint),
                        SyntaxKind.LongKeyword => typeof(long), SyntaxKind.ULongKeyword => typeof(ulong),
                        SyntaxKind.FloatKeyword => typeof(float), SyntaxKind.DoubleKeyword => typeof(double),
                        SyntaxKind.DecimalKeyword => typeof(decimal), SyntaxKind.CharKeyword => typeof(char),
                        SyntaxKind.BoolKeyword => typeof(bool), SyntaxKind.StringKeyword => typeof(string),
                        SyntaxKind.ObjectKeyword => typeof(object),
                        _ => null,
                    };
                    return type != null;
                }
                string written = syntax.ToString();
                type = _scope.Resolve(written, out string? refusal);
                if (type == null)
                {
                    if (reportUnbound) Unbound(written, refusal);
                    return false;
                }
                Note(written, type);
                return true;
            }
        }

        // --------------------------------------------------------------- the lookup ---------------------------------

        private Type? Bind(string name, Assembly? extra, out string? refusal)
        {
            refusal = null;
            if (name.StartsWith("global::", StringComparison.Ordinal))
                return Qualified(name.Substring("global::".Length), extra);
            // Generic, array, nullable, pointer and alias-qualified names are not shapes a designer writes for a
            // component or a value: the qualified lookup decides them exactly as before.
            if (name.Length == 0 || name.IndexOfAny(NonNameChars) >= 0) return Qualified(name, extra);
            string[] parts = name.Split('.');
            if (parts.Any(p => !SyntaxFacts.IsValidIdentifier(p))) return Qualified(name, extra);

            string first = parts[0];
            if (_nestedTypeNames.Contains(first))
            {
                refusal = "the form or its base class declares a nested type named " + first;
                return null;
            }

            if (parts.Length > 1)
            {
                // A qualified name: its first identifier is bound like a simple name, so a namespace nested in an
                // enclosing one (`Controls.MyButton` inside `namespace App`) comes before the global reading, and an
                // alias with that name would change what the whole name denotes. Only this file's aliases are
                // checked here — a qualified name never needs the project's sources to be read.
                if (_fileAliases.Contains(first))
                {
                    refusal = "a using alias named " + first + " is not resolved by the designer";
                    return null;
                }
                foreach (var step in _steps)
                {
                    if (!step.IsMembers || step.Namespace.Length == 0) continue;
                    var nestedHit = Member(Compact(step.Namespace) + "." + name, extra, out refusal);
                    if (nestedHit != null || refusal != null) return nestedHit;
                }
                return Qualified(name, extra);
            }

            // A simple name: a nested type the class can see would come first, so not knowing them settles nothing.
            if (_simpleNamesUnknown != null)
            {
                refusal = _simpleNamesUnknown;
                return null;
            }
            var project = Project();
            if (project.SourcesIncomplete != null)
            {
                refusal = project.SourcesIncomplete;
                return null;
            }
            if (project.PartialMembers(_designedName).Any(m => m.NestedType && m.Member == name))
            {
                refusal = "another part of the form declares a nested type named " + name;
                return null;
            }
            if (project.DeclaredUnderIf(name) is { } underIf)
            {
                refusal = name + " may be declared under an inactive #if in " + underIf;
                return null;
            }

            for (int k = 0; k < _steps.Count; k++)
            {
                var step = _steps[k];
                Type? found;
                if (step.IsMembers)
                {
                    string ns = Compact(step.Namespace);
                    found = Member(ns.Length == 0 ? name : ns + "." + name, extra, out refusal);
                }
                else found = FromDirectives(step, name, extra, project, out refusal);
                if (refusal != null) return null;
                if (found == null) continue;
                refusal = SourceConflict(name, k, found, project, extra);
                return refusal == null ? found : null;
            }
            return null;
        }

        /// <summary>The type one step of using directives supplies for <paramref name="name"/>, or a refusal.</summary>
        private Type? FromDirectives(SourceNameScope step, string name, Assembly? extra, ProjectSourceFacts project,
            out string? refusal)
        {
            refusal = null;
            IEnumerable<string> aliases = step.Aliases, statics = step.StaticImports;
            if (step.IsCompilationUnit)
            {
                if (project.UsingsIncomplete != null)
                {
                    refusal = project.UsingsIncomplete;
                    return null;
                }
                aliases = aliases.Concat(project.Aliases);
                statics = statics.Concat(project.StaticImports);
            }
            if (aliases.Contains(name, StringComparer.Ordinal))
            {
                refusal = "a using alias named " + name + " is not resolved by the designer";
                return null;
            }
            foreach (string written in statics.Distinct(StringComparer.Ordinal))
            {
                if (StartsWithAlias(written, project, out refusal)) return null;
                var imported = StaticImport(written, Compact(step.Namespace), extra);
                if (imported == null)
                {
                    refusal = "using static " + Unglobal(Compact(written)) + " could not be inspected";
                    return null;
                }
                if (DeclaresAccessibleNested(imported, name))
                {
                    refusal = name + " is also imported by using static " + imported.FullName;
                    return null;
                }
            }
            var imports = step.IsCompilationUnit ? step.Imports.Concat(project.Imports) : step.Imports;
            foreach (string written in imports)
                if (StartsWithAlias(written, project, out refusal)) return null;
            var found = new List<Type>();
            foreach (string ns in ImportedNamespaces(step, project, extra))
            {
                var candidate = Member(ns + "." + name, extra, out refusal);
                if (refusal != null) return null;
                if (candidate != null && !found.Contains(candidate)) found.Add(candidate);
            }
            if (found.Count > 1)
            {
                refusal = "ambiguous between " + string.Join(" and ", found.Select(t => t.FullName));
                return null;
            }
            return found.Count == 1 ? found[0] : null;
        }

        /// <summary>A using whose first identifier is an alias (`using NS.Controls;` after `using NS = Lib;`) names
        /// something under the alias's target, which this binder does not resolve.</summary>
        private bool StartsWithAlias(string written, ProjectSourceFacts project, out string? refusal)
        {
            refusal = null;
            string name = Compact(written);
            if (name.StartsWith("global::", StringComparison.Ordinal)) return false;
            string first = name.Split('.')[0];
            if (!_fileAliases.Contains(first) && !project.Aliases.Contains(first, StringComparer.Ordinal)) return false;
            refusal = "the using " + name + " starts with an alias, which is not resolved by the designer";
            return true;
        }

        /// <summary>The namespaces a step of directives imports. A directive written inside <c>namespace App</c> names
        /// a namespace relative to it first: <c>using Controls;</c> there is <c>App.Controls</c> when that namespace
        /// exists, and <c>Controls</c> only otherwise.</summary>
        private IEnumerable<string> ImportedNamespaces(SourceNameScope step, ProjectSourceFacts project, Assembly? extra)
        {
            var imports = step.IsCompilationUnit ? step.Imports.Concat(project.Imports) : step.Imports;
            string declaring = Compact(step.Namespace);
            return imports.Select(written => ImportedNamespace(written, declaring, project, extra)).Distinct(StringComparer.Ordinal);
        }

        private string ImportedNamespace(string written, string declaring, ProjectSourceFacts project, Assembly? extra)
        {
            string name = Compact(written);
            if (name.StartsWith("global::", StringComparison.Ordinal) || declaring.Length == 0) return Unglobal(name);
            foreach (string prefix in NamespaceAndAncestors(declaring))
            {
                string candidate = prefix + "." + name;
                if (project.SourceNamespaces.Contains(candidate) || Search(extra).Any(a => NamespacesOf(a).Contains(candidate)))
                    return candidate;
            }
            return name;
        }

        private Type? StaticImport(string written, string declaring, Assembly? extra)
        {
            string name = Compact(written);
            if (!name.StartsWith("global::", StringComparison.Ordinal) && declaring.Length > 0)
                foreach (string prefix in NamespaceAndAncestors(declaring))
                    if (Qualified(prefix + "." + name, extra) is { } relative) return relative;
            return Qualified(Unglobal(name), extra);
        }

        /// <summary>
        /// A type the project's own sources declare with this name, in a namespace C# searches no later than the step
        /// that produced <paramref name="found"/>, is what the compiler binds (a source type also wins over a
        /// referenced type of the same full name). Unless <paramref name="found"/> is that type from the project's own
        /// build, the name is refused: the build is older than the sources.
        /// </summary>
        private string? SourceConflict(string name, int foundAt, Type found, ProjectSourceFacts project, Assembly? extra)
        {
            foreach (string ns in project.NamespacesDeclaring(name)
                .Concat(_bufferDeclarations.Where(d => d.Name == name).Select(d => d.Namespace)).Distinct(StringComparer.Ordinal))
            {
                string full = ns.Length == 0 ? name : ns + "." + name;
                if (string.Equals(found.FullName, full, StringComparison.Ordinal) && found.Assembly == _designedAssembly) continue;
                for (int k = 0; k <= foundAt && k < _steps.Count; k++)
                {
                    var step = _steps[k];
                    bool reaches = step.IsMembers
                        ? Compact(step.Namespace) == ns
                        : ImportedNamespaces(step, project, extra).Contains(ns, StringComparer.Ordinal);
                    if (reaches)
                        return name + " is declared in the project's sources as " + full
                            + ", which its last build does not hold; build the project";
                }
            }
            return null;
        }

        // ------------------------------------------------------------------ members ---------------------------------

        /// <summary>A member or local named <paramref name="name"/> that C# would read in an expression, cached per
        /// name: the interpreter asks for every value it evaluates.</summary>
        private bool TryFindMember(string name, bool readProject, out Type? memberType, out string? memberTypeText)
        {
            string key = (readProject ? "p:" : "f:") + name;
            if (!_memberCache.TryGetValue(key, out var hit))
            {
                bool found = FindMember(name, readProject, out var type, out var text);
                _memberCache[key] = hit = (found, type, text);
            }
            memberType = hit.Type;
            memberTypeText = hit.TypeText;
            return hit.Found;
        }

        private bool FindMember(string name, bool readProject, out Type? memberType, out string? memberTypeText)
        {
            memberType = null;
            memberTypeText = null;
            _localNames ??= _initializeComponent != null
                ? DesignerIrBuilder.DeclaredLocalNames(_initializeComponent)
                : new HashSet<string>(StringComparer.Ordinal);
            if (_localNames.Contains(name)) return true;
            if (_designedMembers.TryGetValue(name, out memberTypeText)) return true;
            // A simple name's binding already refused when the sources could not be read; that refusal stands.
            if (readProject && Project() is { SourcesIncomplete: null } project)
                foreach (var m in project.PartialMembers(_designedName))
                    if (!m.NestedType && m.Member == name)
                    {
                        memberTypeText = m.TypeText;
                        return true;
                    }
            const BindingFlags all = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            try
            {
                if (_compiledDesigned != null)
                {
                    var own = _compiledDesigned.GetMember(name, all | BindingFlags.DeclaredOnly);
                    if (own.Length > 0)
                    {
                        memberType = MemberType(own[0]);
                        return true;
                    }
                }
                for (Type? b = _compiledDesigned?.BaseType ?? _rootType; b != null; b = b.BaseType)
                {
                    foreach (var m in b.GetMember(name, all | BindingFlags.DeclaredOnly))
                    {
                        if (!VisibleToDerived(m, b)) continue;
                        memberType = MemberType(m);
                        return true;
                    }
                }
            }
            catch { return true; }
            return false;
        }

        private bool VisibleToDerived(MemberInfo member, Type declaring)
        {
            if (member is FieldInfo field)
                return field.IsPublic || field.IsFamily || field.IsFamilyOrAssembly
                    || (declaring.Assembly == _designedAssembly && (field.IsAssembly || field.IsFamilyAndAssembly));
            if (member is Type nested)
                return nested.IsNestedPublic || nested.IsNestedFamily || nested.IsNestedFamORAssem;
            MethodBase? accessor = member switch
            {
                MethodBase method => method,
                System.Reflection.PropertyInfo property => property.GetMethod ?? property.SetMethod,
                System.Reflection.EventInfo evt => evt.AddMethod,
                _ => null,
            };
            if (accessor == null) return false;
            return accessor.IsPublic || accessor.IsFamily || accessor.IsFamilyOrAssembly
                || (declaring.Assembly == _designedAssembly && (accessor.IsAssembly || accessor.IsFamilyAndAssembly));
        }

        private static Type? MemberType(MemberInfo member) => member switch
        {
            FieldInfo field => field.FieldType,
            System.Reflection.PropertyInfo property => property.PropertyType,
            _ => null,
        };

        // ------------------------------------------------------------------ helpers ---------------------------------

        /// <summary>The accessible type with exactly this namespace-qualified name. The project's own build wins over
        /// a reference, as source does in the compiler; the same name in two other assemblies is refused.</summary>
        private Type? Member(string fullName, Assembly? extra, out string? refusal)
        {
            refusal = null;
            var found = new List<Type>();
            foreach (var asm in Search(extra))
            {
                Type? t;
                try { t = asm.GetType(fullName, throwOnError: false); }
                catch { continue; }
                if (t == null || !(t.IsPublic || t.Assembly == _designedAssembly)) continue;
                if (!found.Contains(t)) found.Add(t);
            }
            if (found.Count == 0) return null;
            var own = found.FirstOrDefault(t => t.Assembly == _designedAssembly);
            if (own != null || found.Count == 1) return own ?? found[0];
            refusal = fullName + " is defined in " + string.Join(" and ", found.Select(t => t.Assembly.GetName().Name));
            return null;
        }

        private IEnumerable<Assembly> Search(Assembly? extra)
        {
            foreach (var asm in _search) yield return asm;
            if (extra != null && !_search.Contains(extra)) yield return extra;
        }

        private Type? Qualified(string name, Assembly? extra)
        {
            var t = _qualified(name);
            if (t != null || extra == null) return t;
            try { return extra.GetType(name, throwOnError: false); }
            catch { return null; }
        }

        private ProjectSourceFacts Project()
        {
            if (_project != null) return _project;
            try
            {
                _project = _loadProject();
                _project.ReadUsingsFromBuild(_compiledDesigned);
            }
            catch { _project = ProjectSourceFacts.Unknown("the project's sources could not be read"); }
            return _project;
        }

        private bool DeclaresAccessibleNested(Type type, string name)
        {
            Type[] nested;
            try { nested = type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic); }
            catch { return true; }
            return nested.Any(n => n.Name == name
                && (n.IsNestedPublic || (type.Assembly == _designedAssembly && !n.IsNestedPrivate)));
        }

        /// <summary>Adds the nested type names a class written inside <paramref name="type"/>'s derived class can
        /// see (all of them when <paramref name="all"/>). False when they could not be listed.</summary>
        private static bool AddNestedTypes(HashSet<string> names, Type? type, Assembly? designed, bool all)
        {
            if (type == null) return true;
            Type[] nested;
            try { nested = type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic); }
            catch { return false; }
            foreach (var n in nested)
            {
                bool visible = all || n.IsNestedPublic || n.IsNestedFamily || n.IsNestedFamORAssem
                    || (n.Assembly == designed && (n.IsNestedAssembly || n.IsNestedFamANDAssem));
                if (visible) names.Add(n.Name);
            }
            return true;
        }

        /// <summary>Every namespace (and parent namespace) an assembly defines a type in, computed once per assembly.
        /// Weakly keyed, so a collectible user context is not kept alive by it.</summary>
        private static HashSet<string> NamespacesOf(Assembly assembly) => LoadedNamespaces.GetValue(assembly, asm =>
        {
            var namespaces = new HashSet<string>(StringComparer.Ordinal);
            Type?[] types;
            try { types = asm.GetTypes(); }
            catch (ReflectionTypeLoadException partial) { types = partial.Types; }
            catch { types = Array.Empty<Type?>(); }
            foreach (var t in types)
                if (t?.Namespace is { Length: > 0 } ns)
                    foreach (string prefix in NamespaceAndAncestors(ns)) namespaces.Add(prefix);
            return namespaces;
        });

        /// <summary><c>A.B.C</c>, then <c>A.B</c>, then <c>A</c>.</summary>
        internal static IEnumerable<string> NamespaceAndAncestors(string ns)
        {
            for (string cur = ns; cur.Length > 0; )
            {
                yield return cur;
                int dot = cur.LastIndexOf('.');
                if (dot <= 0) yield break;
                cur = cur.Substring(0, dot);
            }
        }

        private static readonly char[] NonNameChars = { '<', '>', '[', ']', '?', '*', ':', '(', ')', ',' };

        /// <summary>A declared type's CLR name: <c>Name</c>, or <c>Name`n</c> for <c>n</c> type parameters.</summary>
        internal static string ArityName(string name, TypeParameterListSyntax? typeParameters) =>
            typeParameters is { Parameters.Count: > 0 } list ? name + "`" + list.Parameters.Count : name;

        internal static string Compact(string text)
        {
            var builder = new StringBuilder(text.Length);
            foreach (char c in text)
                if (!char.IsWhiteSpace(c)) builder.Append(c);
            return builder.ToString();
        }

        internal static string Unglobal(string name) =>
            name.StartsWith("global::", StringComparison.Ordinal) ? name.Substring("global::".Length) : name;
    }

    /// <summary>
    /// What the sources of the project that owns a designer file contribute to name binding: their global usings, the
    /// types and namespaces they declare, and the members of partial classes. Read as a SUPERSET of what the project
    /// compiles — every C# file in its folder except dot folders, build output and nested project folders included —
    /// because an extra import or declaration can only make a name ambiguous or refused, never bind it to a different
    /// type. Reads stay inside the project folder and never follow a link
    /// (<see cref="ProjectResourceResolver.ReadFileInside"/>). Where a part cannot be proven,
    /// <see cref="UsingsIncomplete"/> or <see cref="SourcesIncomplete"/> says why. What no project file shows is the
    /// build evidence's to vouch for (<see cref="DesignerBuildEvidence"/>).
    /// </summary>
    internal sealed class ProjectSourceFacts
    {
        public List<string> Imports { get; } = new();
        public List<string> Aliases { get; } = new();
        public List<string> StaticImports { get; } = new();
        public HashSet<string> SourceNamespaces { get; } = new(StringComparer.Ordinal);
        /// <summary>Why the project's global usings cannot be proven complete; null when they can.</summary>
        public string? UsingsIncomplete { get; private set; }
        /// <summary>Why the project's sources cannot be proven complete; null when they can.</summary>
        public string? SourcesIncomplete { get; private set; }
        /// <summary>Why the folder walk cannot see every global using (the project file pulls in what it does not
        /// read); the usings then come from the build (<see cref="ReadUsingsFromBuild"/>). Null otherwise.</summary>
        public string? UsingsFromBuild { get; private set; }
        /// <summary>The global usings were read from the build: what the sources the walk did not read declare is known
        /// only through that build (<see cref="DesignerTypeScope.FormHidesMember"/>).</summary>
        public bool ReadFromBuild { get; private set; }
        private string? _projectDir;
        internal string? ProjectDirectory => _projectDir;
        /// <summary>The designer file these facts were read for, where <see cref="UsingsFromBuild"/> is set.</summary>
        internal string? DesignerPath { get; private set; }

        private readonly Dictionary<string, List<string>> _declared = new(StringComparer.Ordinal);
        private readonly Dictionary<string, List<PartialMember>> _partialMembers = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> _declaredUnderIf = new(StringComparer.Ordinal);

        public readonly record struct PartialMember(string Member, string? TypeText, bool NestedType);

        private const long MaxSourceBytes = 8L * 1024 * 1024;
        private const long MaxColdParseBytes = 256L * 1024 * 1024;
        private const int MaxCachedFiles = 50_000;
        private const int MaxProjectSearchDepth = 10;

        // What one source file contributes, keyed by path and checked against size + write time, so a re-render lists
        // the project again but parses only what changed. Entries the current walk did not touch are evicted first.
        private sealed class FileFacts
        {
            public long Stamp;
            public long Seen;
            public SourceNameScope? Usings;
            public bool ConditionalUsings;
            public List<(string Namespace, string Name)> Declarations = new();
            public List<string> Namespaces = new();
            public List<(string Type, PartialMember Member)> PartialMembers = new();
            public List<string> DeclaredUnderIf = new();
            public string? Failure;
        }

        private static readonly ConcurrentDictionary<string, FileFacts> Cache = new(StringComparer.OrdinalIgnoreCase);
        private static long _generation;
        private static readonly Regex ImplicitUsingsOn = new(@"<ImplicitUsings>\s*(?:enable|true)\s*</ImplicitUsings>",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex UsingItem = new(@"<Using[\s/>]", RegexOptions.Compiled);
        private static readonly Regex Comments = new(@"//[^\r\n]*|/\*.*?\*/", RegexOptions.Compiled | RegexOptions.Singleline);
        private static readonly Regex Identifier = new(@"@?[\p{L}_][\p{L}\p{Nd}_]*", RegexOptions.Compiled);
        private static readonly HashSet<string> TypeKeywords = new(StringComparer.Ordinal) { "class", "struct", "interface", "enum", "record" };
        private static readonly HashSet<string> ItemDefaultProperties = new(StringComparer.Ordinal)
        {
            "DefaultItemExcludes", "DefaultItemExcludesInProjectFolder", "EnableDefaultCompileItems", "EnableDefaultItems",
        };

        /// <summary>
        /// Add the global usings of <paramref name="compiledDesigned"/>'s build, when <see cref="UsingsFromBuild"/> says
        /// the folder walk cannot see them all (<see cref="BuildGlobalUsings"/>). What the walk read stays: the current
        /// sources of the folder are authoritative, and the designer file's own usings are its buffer's. Without that
        /// build, a portable PDB of it, or a way to tell its global usings from a file's own, the project is unknown
        /// exactly as before: its usings and its sources.
        /// </summary>
        internal void ReadUsingsFromBuild(Type? compiledDesigned)
        {
            if (UsingsFromBuild is not { } hidden) return;
            UsingsFromBuild = null;
            if (BuildGlobalUsings(compiledDesigned, _projectDir, out var globals) is { } why)
            {
                UsingsIncomplete = hidden + ", and " + why;
                SourcesIncomplete ??= UsingsIncomplete;
                return;
            }
            Imports.AddRange(globals.Imports);
            Aliases.AddRange(globals.Aliases);
            StaticImports.AddRange(globals.StaticImports);
            ReadFromBuild = true;
        }

        internal sealed record BuildGlobals(IReadOnlyList<string> Imports, IReadOnlyList<string> Aliases,
            IReadOnlyList<string> StaticImports)
        {
            public static readonly BuildGlobals None = new(Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());
        }

        // The global usings of a build are a fact of that build: kept by its module id once one file told them apart.
        private static readonly ConcurrentDictionary<Guid, BuildGlobals> GlobalsByBuild = new();
        private static readonly Guid Sha256Algorithm = new("8829d00f-11b8-4213-878b-770e8597ac16");
        private static readonly Guid Sha1Algorithm = new("ff1816ec-aa5e-4d10-87f7-6f4963833460");

        /// <summary>
        /// The global usings <paramref name="designed"/>'s build was compiled with, read from its portable PDB, or why
        /// they cannot be. The PDB gives each file one import scope, whose parent is the build's root scope, holding the
        /// global usings and the file's own CU-level usings as the compiler resolved them (a namespace's usings are a
        /// child scope). A file of the project whose bytes still have the hash the PDB records for it is the text the
        /// build compiled: its own usings, removed from its scope, leave global usings only. Every such file adds what
        /// it shows; a using a file repeats from the globals may be left out, which only refuses more. The DLL must
        /// still be the loaded image (its MVID), and the PDB is the one beside it or embedded in it, matched by id.
        /// </summary>
        private static string? BuildGlobalUsings(Type? designed, string? projectDir, out BuildGlobals globals)
        {
            globals = BuildGlobals.None;
            if (designed == null) return "the project has not been built; build the project";
            if (projectDir == null) return "the project folder is not known";
            string dll = ControlLoadContext.OriginOf(designed.Assembly);
            if (dll.Length == 0) return "the build's file could not be located";
            Guid mvid = designed.Module.ModuleVersionId;
            if (GlobalsByBuild.TryGetValue(mvid, out var known))
            {
                globals = known;
                return null;
            }
            const string NoPdb = "its build has no portable PDB to read the global usings from";
            try
            {
                static Stream? Open(string path) => File.Exists(path)
                    ? new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete) : null;
                using var pe = new System.Reflection.PortableExecutable.PEReader(Open(dll) ?? throw new FileNotFoundException());
                var assembly = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
                if (assembly.GetGuid(assembly.GetModuleDefinition().Mvid) != mvid)
                    return "the build changed since it was loaded; render again";
                if (!pe.TryOpenAssociatedPortablePdb(dll, Open, out var provider, out _) || provider == null) return NoPdb;
                using (provider)
                {
                    var pdb = provider.GetMetadataReader();
                    var root = default(System.Reflection.Metadata.ImportScopeHandle);
                    foreach (var scope in pdb.ImportScopes)
                    {
                        if (!pdb.GetImportScope(scope).Parent.IsNil) continue;
                        if (!root.IsNil) return "its build records more than one root import scope";
                        root = scope;
                    }
                    if (root.IsNil) return "its build records no import scopes";
                    // What the root scope imports applies to every file.
                    var global = ImportEntries(pdb, assembly, root);

                    var fileScopes = new Dictionary<System.Reflection.Metadata.DocumentHandle, System.Reflection.Metadata.ImportScopeHandle?>();
                    var typesOf = new Dictionary<System.Reflection.Metadata.DocumentHandle, HashSet<string>>();
                    foreach (var debug in pdb.MethodDebugInformation)
                    {
                        var document = pdb.GetMethodDebugInformation(debug).Document;
                        if (document.IsNil) continue;
                        var scopes = pdb.GetLocalScopes(debug.ToDefinitionHandle());
                        if (scopes.Count == 0) continue;
                        var file = FileScope(pdb, pdb.GetLocalScope(scopes.First()).ImportScope);
                        if (file.IsNil) continue;
                        // A document whose methods sit under different file scopes is not one compilation unit.
                        if (!fileScopes.TryGetValue(document, out var seen)) fileScopes[document] = file;
                        else if (seen is { } one && one != file) fileScopes[document] = null;
                        if (!typesOf.TryGetValue(document, out var types)) typesOf[document] = types = new HashSet<string>(StringComparer.Ordinal);
                        types.Add(TopLevelTypeOf(assembly, debug.ToDefinitionHandle()));
                    }
                    int witnesses = 0;
                    foreach (var (document, scope) in fileScopes)
                    {
                        if (scope is not { } file || UnchangedFileUsings(pdb, document, projectDir, typesOf[document]) is not { } own)
                            continue;
                        var entries = ImportEntries(pdb, assembly, file);
                        if (!own.IsSubsetOf(entries)) continue;
                        entries.ExceptWith(own);
                        global.UnionWith(entries);
                        witnesses++;
                    }
                    if (witnesses == 0)
                        return "no source file of the project is unchanged since that build to tell its global usings apart; build the project";

                    var imports = new List<string>();
                    var aliases = new List<string>();
                    var statics = new List<string>();
                    foreach (string entry in global.OrderBy(e => e, StringComparer.Ordinal))
                    {
                        if (entry.StartsWith("ns:", StringComparison.Ordinal)) imports.Add("global::" + entry.Substring(3));
                        else if (entry.StartsWith("alias:", StringComparison.Ordinal)) aliases.Add(entry.Substring(6));
                        else if (entry.StartsWith("static:", StringComparison.Ordinal)) statics.Add("global::" + entry.Substring(7));
                        else return "its build imports " + entry.Substring(entry.IndexOf(':') + 1) + " for every file, which the designer does not resolve";
                    }
                    globals = new BuildGlobals(imports, aliases, statics);
                    if (GlobalsByBuild.Count > 64) GlobalsByBuild.Clear();
                    GlobalsByBuild[mvid] = globals;
                    return null;
                }
            }
            catch (FileNotFoundException) { return NoPdb; }
            catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException
                or InvalidOperationException or ArgumentException)
            {
                return "its build's PDB could not be read";
            }
        }

        /// <summary>The file scope above <paramref name="scope"/>: the one whose parent is the root scope. Nil when
        /// <paramref name="scope"/> is the root.</summary>
        private static System.Reflection.Metadata.ImportScopeHandle FileScope(System.Reflection.Metadata.MetadataReader pdb,
            System.Reflection.Metadata.ImportScopeHandle scope)
        {
            for (int depth = 0; !scope.IsNil && depth < 256; depth++)
            {
                var parent = pdb.GetImportScope(scope).Parent;
                if (parent.IsNil) return default;
                if (pdb.GetImportScope(parent).Parent.IsNil) return scope;
                scope = parent;
            }
            return default;
        }

        /// <summary>One scope's imports, each as "ns:N", "alias:A", "static:T", or "other:…" for a kind the designer does
        /// not resolve. Only the fields of each kind are read.</summary>
        private static HashSet<string> ImportEntries(System.Reflection.Metadata.MetadataReader pdb,
            System.Reflection.Metadata.MetadataReader assembly, System.Reflection.Metadata.ImportScopeHandle scope)
        {
            string Blob(System.Reflection.Metadata.BlobHandle blob) => Encoding.UTF8.GetString(pdb.GetBlobBytes(blob));
            var entries = new HashSet<string>(StringComparer.Ordinal);
            foreach (var definition in pdb.GetImportScope(scope).GetImports())
            {
                entries.Add(definition.Kind switch
                {
                    System.Reflection.Metadata.ImportDefinitionKind.ImportNamespace => "ns:" + Blob(definition.TargetNamespace),
                    System.Reflection.Metadata.ImportDefinitionKind.AliasNamespace
                        or System.Reflection.Metadata.ImportDefinitionKind.AliasType => "alias:" + Blob(definition.Alias),
                    System.Reflection.Metadata.ImportDefinitionKind.ImportType =>
                        TopLevelTypeName(assembly, definition.TargetType) is { } type ? "static:" + type
                            : "other:a using static of a nested or generic type",
                    _ => "other:" + definition.Kind,
                });
            }
            return entries;
        }

        /// <summary>The name a using directive imports as the PDB records it: identifiers by value, trivia ignored,
        /// <c>global::</c> dropped. Null for what the PDB records otherwise: a generic name or another alias.</summary>
        private static string? ImportedName(NameSyntax name) => name switch
        {
            QualifiedNameSyntax qualified => ImportedName(qualified.Left) is { } left
                && ImportedName(qualified.Right) is { } right ? left + "." + right : null,
            AliasQualifiedNameSyntax alias => alias.Alias.Identifier.IsKind(SyntaxKind.GlobalKeyword)
                ? ImportedName(alias.Name) : null,
            IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
            _ => null,
        };

        /// <summary>The metadata names of the top-level types <paramref name="unit"/> declares, as
        /// <see cref="TopLevelTypeOf"/> reads them: identifiers by value (<c>@namespace</c>, <c>A</c>), a generic
        /// type with its arity, a file-local type as the compiler names it (<c>&lt;File&gt;F…__Name</c>, matched by its
        /// own name), and <c>Program</c> for top-level statements.</summary>
        private static MetadataNames MetadataTypeNames(CompilationUnitSyntax unit)
        {
            var names = new MetadataNames();
            static string Text(NameSyntax name) => name switch
            {
                QualifiedNameSyntax qualified => Text(qualified.Left) + "." + qualified.Right.Identifier.ValueText,
                AliasQualifiedNameSyntax alias => alias.Name.Identifier.ValueText,
                SimpleNameSyntax simple => simple.Identifier.ValueText,
                _ => name.ToString(),
            };
            void Walk(SyntaxList<MemberDeclarationSyntax> members, string ns)
            {
                foreach (var member in members)
                {
                    if (member is BaseNamespaceDeclarationSyntax nested)
                        Walk(nested.Members, ns.Length == 0 ? Text(nested.Name) : ns + "." + Text(nested.Name));
                    else if (member is BaseTypeDeclarationSyntax type)
                    {
                        int arity = (type as TypeDeclarationSyntax)?.TypeParameterList?.Parameters.Count ?? 0;
                        string name = arity > 0 ? type.Identifier.ValueText + "`" + arity : type.Identifier.ValueText;
                        if (type.Modifiers.Any(m => m.IsKind(SyntaxKind.FileKeyword))) names.FileLocal.Add((ns, name));
                        else names.Add(ns.Length == 0 ? name : ns + "." + name);
                    }
                }
            }
            Walk(unit.Members, "");
            if (unit.Members.OfType<GlobalStatementSyntax>().Any()) names.Add("Program");
            return names;
        }

        private sealed class MetadataNames
        {
            private static readonly Regex FileLocalName = new(@"^<[^>]*>F[0-9A-Fa-f]+__(?<name>.+)$", RegexOptions.CultureInvariant);
            private readonly HashSet<string> _names = new(StringComparer.Ordinal);
            public readonly HashSet<(string Namespace, string Name)> FileLocal = new();

            public void Add(string name) => _names.Add(name);

            public bool Contains(string item)
            {
                if (_names.Contains(item)) return true;
                int dot = item.LastIndexOf('.');
                string ns = dot < 0 ? "" : item.Substring(0, dot), last = dot < 0 ? item : item.Substring(dot + 1);
                var match = FileLocalName.Match(last);
                return match.Success && FileLocal.Contains((ns, match.Groups["name"].Value));
            }
        }

        /// <summary>The metadata name ("Ns.Type", "Type`1") of the outermost type declaring <paramref name="method"/>.</summary>
        private static string TopLevelTypeOf(System.Reflection.Metadata.MetadataReader assembly,
            System.Reflection.Metadata.MethodDefinitionHandle method)
        {
            var type = assembly.GetTypeDefinition(assembly.GetMethodDefinition(method).GetDeclaringType());
            for (int depth = 0; !type.GetDeclaringType().IsNil && depth < 256; depth++)
                type = assembly.GetTypeDefinition(type.GetDeclaringType());
            string ns = assembly.GetString(type.Namespace);
            return ns.Length == 0 ? assembly.GetString(type.Name) : ns + "." + assembly.GetString(type.Name);
        }

        /// <summary>The CU-level usings of the project file <paramref name="document"/> names, as
        /// <see cref="ImportEntries"/> writes them, when the file is inside the project and its bytes have the hash the
        /// PDB records — the text the build compiled. Null otherwise, and for a file whose usings the designer cannot
        /// write exactly (an extern alias, a conditional directive, an alias-qualified name). A <c>#line</c> in another
        /// file can attribute that file's methods, under that file's scope, to this document: every type whose methods
        /// the PDB attributes to it (<paramref name="methodTypes"/>) must be one its text declares.</summary>
        /// <summary>The text of the project file <paramref name="document"/> names, with its path spelled as the
        /// project folder is, when the file is inside the project and its bytes have the hash the PDB records: the text
        /// the build compiled. Null otherwise.</summary>
        private static (string Path, string Text)? CompiledText(System.Reflection.Metadata.MetadataReader pdb,
            System.Reflection.Metadata.DocumentHandle document, string projectDir)
        {
            var doc = pdb.GetDocument(document);
            string path = pdb.GetString(doc.Name);
            if (!Path.IsPathRooted(path)) return null;
            // The build may spell the folder in another case (a drive letter, typically) than the designer's path. Read
            // through the designer's spelling: the hash below decides whether those bytes are the compiled text.
            string root;
            try
            {
                root = Path.GetFullPath(projectDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                path = Path.GetFullPath(path);
            }
            catch { return null; }
            if (path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) path = root + path.Substring(root.Length);
            Guid algorithm = pdb.GetGuid(doc.HashAlgorithm);
            if (algorithm != Sha256Algorithm && algorithm != Sha1Algorithm) return null;
            byte[]? bytes;
            try { bytes = ProjectResourceResolver.ReadFileInside(projectDir, path, MaxSourceBytes); }
            catch { return null; }
            if (bytes == null) return null;
            byte[] hash = algorithm == Sha256Algorithm
                ? System.Security.Cryptography.SHA256.HashData(bytes)
                : System.Security.Cryptography.SHA1.HashData(bytes);
            if (!hash.AsSpan().SequenceEqual(pdb.GetBlobBytes(doc.Hash))) return null;
            using var reader = new StreamReader(new MemoryStream(bytes), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return (path, reader.ReadToEnd());
        }

        /// <summary>
        /// The text of <paramref name="designerPath"/> as <paramref name="designed"/>'s build compiled it, when the file
        /// still has the bytes the build's PDB records for it; null otherwise, or without that build or PDB.
        /// </summary>
        internal static string? CompiledDesignerText(Type designed, string projectDir, string designerPath)
        {
            string dll = ControlLoadContext.OriginOf(designed.Assembly);
            if (dll.Length == 0) return null;
            try
            {
                static Stream? Open(string path) => File.Exists(path)
                    ? new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete) : null;
                using var pe = new System.Reflection.PortableExecutable.PEReader(Open(dll) ?? throw new FileNotFoundException());
                var assembly = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
                if (assembly.GetGuid(assembly.GetModuleDefinition().Mvid) != designed.Module.ModuleVersionId) return null;
                if (!pe.TryOpenAssociatedPortablePdb(dll, Open, out var provider, out _) || provider == null) return null;
                using (provider)
                {
                    var pdb = provider.GetMetadataReader();
                    string designer = Path.GetFullPath(designerPath);
                    string? found = null;
                    foreach (var document in pdb.Documents)
                    {
                        if (CompiledText(pdb, document, projectDir) is not { } compiled
                            || !string.Equals(compiled.Path, designer, StringComparison.OrdinalIgnoreCase)) continue;
                        if (found != null) return null;
                        found = compiled.Text;
                    }
                    return found;
                }
            }
            catch (Exception ex) when (ex is FileNotFoundException or BadImageFormatException or IOException
                or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
            {
                return null;
            }
        }

        private static HashSet<string>? UnchangedFileUsings(System.Reflection.Metadata.MetadataReader pdb,
            System.Reflection.Metadata.DocumentHandle document, string projectDir, IReadOnlySet<string> methodTypes)
        {
            if (CompiledText(pdb, document, projectDir) is not { } compiled) return null;
            var unit = CSharpSyntaxTree.ParseText(compiled.Text).GetCompilationUnitRoot();
            // Which usings a conditional directive keeps depends on the build's symbols, which the PDB does not record.
            if (unit.Externs.Count > 0 || unit.GetFirstDirective(d => d is ConditionalDirectiveTriviaSyntax
                    or DefineDirectiveTriviaSyntax or UndefDirectiveTriviaSyntax) != null)
                return null;
            if (!methodTypes.All(MetadataTypeNames(unit).Contains)) return null;
            var own = new HashSet<string>(StringComparer.Ordinal);
            foreach (var u in unit.Usings)
            {
                if (u.GlobalKeyword.IsKind(SyntaxKind.GlobalKeyword)) continue;
                if (u.Alias != null)
                {
                    own.Add("alias:" + u.Alias.Name.Identifier.ValueText);
                    continue;
                }
                if (u.Name == null || ImportedName(u.Name) is not { } written) return null;
                own.Add((u.StaticKeyword.IsKind(SyntaxKind.StaticKeyword) ? "static:" : "ns:") + written);
            }
            return own;
        }

        /// <summary>Namespace.Name of a non-nested, non-generic-instance type a using static names; null otherwise.</summary>
        private static string? TopLevelTypeName(System.Reflection.Metadata.MetadataReader reader, System.Reflection.Metadata.EntityHandle handle)
        {
            System.Reflection.Metadata.StringHandle ns, name;
            if (handle.Kind == System.Reflection.Metadata.HandleKind.TypeDefinition)
            {
                var def = reader.GetTypeDefinition((System.Reflection.Metadata.TypeDefinitionHandle)handle);
                if (def.GetDeclaringType().IsNil == false) return null;
                (ns, name) = (def.Namespace, def.Name);
            }
            else if (handle.Kind == System.Reflection.Metadata.HandleKind.TypeReference)
            {
                var reference = reader.GetTypeReference((System.Reflection.Metadata.TypeReferenceHandle)handle);
                if (reference.ResolutionScope.Kind == System.Reflection.Metadata.HandleKind.TypeReference) return null;
                (ns, name) = (reference.Namespace, reference.Name);
            }
            else return null;
            string n = reader.GetString(ns);
            return n.Length == 0 ? reader.GetString(name) : n + "." + reader.GetString(name);
        }

        internal static ProjectSourceFacts Unknown(string reason) => new() { UsingsIncomplete = reason, SourcesIncomplete = reason };

        internal static ProjectSourceFacts UsingsUnknown(string reason) => new() { UsingsIncomplete = reason };

        /// <summary>Top-level types of <paramref name="name"/> (generic ones excluded) the sources declare, by namespace.</summary>
        public IEnumerable<string> NamespacesDeclaring(string name) =>
            _declared.TryGetValue(name, out var namespaces) ? namespaces : Enumerable.Empty<string>();

        /// <summary>Members and nested types the partial class <paramref name="qualifiedName"/> declares across the
        /// project's sources (the designer file being rendered excluded — its buffer is read directly).</summary>
        public IEnumerable<PartialMember> PartialMembers(string qualifiedName) =>
            _partialMembers.TryGetValue(qualifiedName, out var members) ? members : Enumerable.Empty<PartialMember>();

        /// <summary>The file in which inactive #if text declares a type of this name, if any.</summary>
        public string? DeclaredUnderIf(string name) => _declaredUnderIf.TryGetValue(name, out var file) ? file : null;

        public static ProjectSourceFacts For(string designerFilePath)
        {
            string designer = Path.GetFullPath(designerFilePath);
            var result = new ProjectSourceFacts();
            string? projectDir = ProjectResourceResolver.ProjectDirectoryOf(designer);
            if (projectDir == null)
            {
                // A file outside any project is compiled with nothing but its own usings as far as anyone can tell —
                // but a project farther up than the search reaches is still a project whose sources were not read.
                return ProjectResolver.FindCsproj(designer) == null ? result
                    : Unknown("the designer file is more than " + MaxProjectSearchDepth + " folders below its project");
            }

            string[] projects;
            try { projects = Directory.GetFiles(projectDir, "*.csproj"); }
            catch { return Unknown("the project folder could not be listed"); }
            if (projects.Length != 1) return Unknown("several project files share the folder " + projectDir);
            string projectName = Path.GetFileNameWithoutExtension(projects[0]);
            string? projectText = ReadText(projectDir, projects[0]);
            if (projectText == null) return Unknown("the project file could not be read");
            // What the project file pulls in from elsewhere (an imported props file, a linked source) can add global
            // usings no file of the folder shows. Their declarations are in the build; their usings are read from it.
            string? hidden = ProjectFileHides(projectText);

            var sources = ProjectResourceResolver.FindProjectFiles(projectDir, ".cs", out bool complete, everySdkSource: true);
            if (!complete) return Unknown("the project's source files could not all be listed");
            long generation = Interlocked.Increment(ref _generation);
            long coldBytes = 0;
            string generatedName = projectName + ".GlobalUsings.g.cs";
            int generated = 0;
            try
            {
                foreach (string source in sources)
                {
                    // The buffer being rendered is authoritative for the designer file itself.
                    if (string.Equals(source, designer, StringComparison.OrdinalIgnoreCase)) continue;
                    var facts = Facts(projectDir, source, generation, ref coldBytes);
                    if (facts.Failure != null) return Unknown(facts.Failure);
                    if (coldBytes > MaxColdParseBytes) return Unknown("the project's sources are too large to inspect");
                    string file = Path.GetFileName(source);
                    if (string.Equals(file, generatedName, StringComparison.OrdinalIgnoreCase)) generated++;
                    if (facts.ConditionalUsings) result.UsingsIncomplete ??= file + " declares global usings under #if";
                    if (facts.Usings != null)
                    {
                        result.Imports.AddRange(facts.Usings.Imports);
                        result.Aliases.AddRange(facts.Usings.Aliases);
                        result.StaticImports.AddRange(facts.Usings.StaticImports);
                    }
                    foreach (var (ns, name) in facts.Declarations)
                    {
                        if (!result._declared.TryGetValue(name, out var list)) result._declared[name] = list = new List<string>();
                        if (!list.Contains(ns)) list.Add(ns);
                    }
                    foreach (string ns in facts.Namespaces) result.SourceNamespaces.Add(ns);
                    foreach (var (type, member) in facts.PartialMembers)
                    {
                        if (!result._partialMembers.TryGetValue(type, out var list)) result._partialMembers[type] = list = new List<PartialMember>();
                        list.Add(member);
                    }
                    foreach (string name in facts.DeclaredUnderIf) result._declaredUnderIf.TryAdd(name, file);
                }
            }
            // Entries this walk did not reach are evicted however it ended, a refusal included.
            finally { Evict(generation); }

            // MSBuild Using items reach the compiler only through the generated file of a build. Absent while the
            // project declares some (or turns ImplicitUsings on) means the project has not been built here.
            if (hidden != null)
            {
                result.UsingsFromBuild = hidden;
                result._projectDir = projectDir;
                result.DesignerPath = designer;
            }
            else if (generated == 0 && (ImplicitUsingsOn.IsMatch(projectText) || UsingItem.IsMatch(projectText)))
                result.UsingsIncomplete ??= "the project's generated global usings (obj\\…\\" + generatedName
                    + ") were not found; build the project";
            return result;
        }

        private static FileFacts Facts(string projectDir, string path, long generation, ref long coldBytes)
        {
            long stamp, length;
            try
            {
                var info = new FileInfo(path);
                length = info.Length;
                if (length > MaxSourceBytes) return new FileFacts { Failure = Path.GetFileName(path) + " is too large to inspect" };
                stamp = unchecked(info.LastWriteTimeUtc.Ticks * 31 + length);
            }
            catch { return new FileFacts { Failure = Path.GetFileName(path) + " could not be read" }; }
            if (Cache.TryGetValue(path, out var cached) && cached.Stamp == stamp)
            {
                cached.Seen = generation;
                return cached;
            }
            coldBytes += length;
            var facts = Parse(projectDir, path);
            facts.Stamp = stamp;
            facts.Seen = generation;
            Cache[path] = facts;
            return facts;
        }

        private static void Evict(long generation)
        {
            if (Cache.Count <= MaxCachedFiles) return;
            foreach (var entry in Cache)
                if (entry.Value.Seen != generation) Cache.TryRemove(entry.Key, out _);
        }

        private static FileFacts Parse(string projectDir, string path)
        {
            string? text = ReadText(projectDir, path);
            if (text == null) return new FileFacts { Failure = Path.GetFileName(path) + " could not be read" };
            var facts = new FileFacts();
            var root = CSharpSyntaxTree.ParseText(text).GetCompilationUnitRoot();
            // Global usings precede every attribute and member. Text an inactive #if hides in that leading region may
            // be a global using of the real build; an active branch may be one the build leaves out, which only
            // adds to the superset.
            int prefixEnd = root.AttributeLists.Count > 0 ? root.AttributeLists[0].SpanStart
                : root.Members.Count > 0 ? root.Members[0].SpanStart
                : root.EndOfFileToken.SpanStart;
            foreach (var trivia in root.DescendantTrivia().Where(t => t.IsKind(SyntaxKind.DisabledTextTrivia)))
            {
                string disabled = trivia.ToString();
                if (trivia.SpanStart < prefixEnd && disabled.Contains("global", StringComparison.Ordinal)) facts.ConditionalUsings = true;
                facts.DeclaredUnderIf.AddRange(DeclaredNames(disabled));
            }
            var globals = root.Usings.Where(u => u.GlobalKeyword.IsKind(SyntaxKind.GlobalKeyword)).ToList();
            if (globals.Count > 0) facts.Usings = SourceNameScope.Directives(globals, true);
            CollectDeclarations(root, facts.Declarations, facts.Namespaces, facts.PartialMembers);
            return facts;
        }

        /// <summary>The names inactive #if text declares a type under: an identifier after class/struct/interface/
        /// enum/record, or the identifier before the parameter list of a delegate. Comments are removed first, so a
        /// comment between the keyword and the name does not hide it.</summary>
        private static IEnumerable<string> DeclaredNames(string disabled)
        {
            var words = Identifier.Matches(Comments.Replace(disabled, " ")).Select(m => m.Value.TrimStart('@')).ToList();
            for (int i = 0; i < words.Count; i++)
            {
                if (TypeKeywords.Contains(words[i]))
                {
                    int j = i + 1;
                    while (j < words.Count && TypeKeywords.Contains(words[j])) j++;
                    if (j < words.Count) yield return words[j];
                }
            }
            foreach (Match d in Regex.Matches(Comments.Replace(disabled, " "), @"\bdelegate\b[^;(]*?(@?[\p{L}_][\p{L}\p{Nd}_]*)\s*(?:<[^>]*>)?\s*\("))
                yield return d.Groups[1].Value.TrimStart('@');
        }

        /// <summary>The top-level types a file declares, with their namespaces (generic ones as Name`arity), every
        /// namespace it declares, and the members of its top-level partial classes.</summary>
        internal static void CollectDeclarations(CompilationUnitSyntax unit, List<(string Namespace, string Name)> declarations,
            List<string>? namespaces, List<(string Type, PartialMember Member)>? partialMembers)
        {
            void Walk(SyntaxList<MemberDeclarationSyntax> members, string ns)
            {
                foreach (var member in members)
                {
                    switch (member)
                    {
                        case BaseNamespaceDeclarationSyntax nested:
                            string full = ns.Length == 0 ? DesignerTypeScope.Compact(nested.Name.ToString())
                                : ns + "." + DesignerTypeScope.Compact(nested.Name.ToString());
                            namespaces?.AddRange(DesignerTypeScope.NamespaceAndAncestors(full));
                            Walk(nested.Members, full);
                            break;
                        case BaseTypeDeclarationSyntax type:
                            int arity = (type as TypeDeclarationSyntax)?.TypeParameterList?.Parameters.Count ?? 0;
                            declarations.Add((ns, arity > 0 ? type.Identifier.ValueText + "`" + arity : type.Identifier.ValueText));
                            if (partialMembers != null && type is ClassDeclarationSyntax cls
                                && cls.Modifiers.Any(m => m.IsKind(SyntaxKind.PartialKeyword)))
                            {
                                string qualified = FormClassResolver.QualifiedName(cls);
                                var nestedNames = new HashSet<string>(StringComparer.Ordinal);
                                var memberTypes = new Dictionary<string, string?>(StringComparer.Ordinal);
                                foreach (var m in cls.Members) DesignerTypeScope.AddMember(m, nestedNames, memberTypes);
                                foreach (string n in nestedNames) partialMembers.Add((qualified, new PartialMember(n, null, true)));
                                foreach (var kv in memberTypes) partialMembers.Add((qualified, new PartialMember(kv.Key, kv.Value, false)));
                            }
                            break;
                        case DelegateDeclarationSyntax del:
                            int delArity = del.TypeParameterList?.Parameters.Count ?? 0;
                            declarations.Add((ns, delArity > 0 ? del.Identifier.ValueText + "`" + delArity : del.Identifier.ValueText));
                            break;
                    }
                }
            }
            Walk(unit.Members, "");
        }

        private static string? ReadText(string projectDir, string path)
        {
            byte[]? bytes;
            try
            {
                bytes = ProjectResourceResolver.ReadFileInside(projectDir, path, MaxSourceBytes);
                if (bytes == null) return new FileInfo(path).Length == 0 ? "" : null;
            }
            catch { return null; }
            using var reader = new StreamReader(new MemoryStream(bytes), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return reader.ReadToEnd();
        }

        /// <summary>Why the project file pulls in sources the walk does not read, or null: any &lt;Import&gt; but the
        /// bare SDK form, a Compile item with a wildcard, a non-.cs file, a path outside the folder or under a dot
        /// folder, or one built from a property, item or metadata reference; and an override of the default item
        /// globs, which decide which folders are compiled.</summary>
        private static string? ProjectFileHides(string text)
        {
            try
            {
                var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
                using var reader = XmlReader.Create(new StringReader(text), settings);
                var document = System.Xml.Linq.XDocument.Load(reader);
                foreach (var element in document.Descendants())
                {
                    string local = element.Name.LocalName;
                    if (local == "Import")
                    {
                        string project = ((string?)element.Attribute("Project") ?? "").Trim();
                        if (element.Attribute("Sdk") == null
                            || !(project.Equals("Sdk.props", StringComparison.OrdinalIgnoreCase)
                                 || project.Equals("Sdk.targets", StringComparison.OrdinalIgnoreCase)))
                            return "the project imports MSBuild files the designer does not read";
                    }
                    if (ItemDefaultProperties.Contains(local))
                        return "the project changes which of its folders are compiled (" + local + ")";
                    if (local != "Compile" || element.Attribute("Include") == null) continue;
                    foreach (string raw in ((string?)element.Attribute("Include") ?? "").Split(';'))
                    {
                        string entry = raw.Trim().Replace('/', '\\');
                        if (entry.Length == 0) continue;
                        if (Path.IsPathRooted(entry) || entry.IndexOfAny(new[] { '$', '%', '@', '*', '?' }) >= 0
                            || !entry.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)
                            || entry.Split('\\').Any(segment => segment == ".." || segment.StartsWith(".", StringComparison.Ordinal)))
                            return "the project compiles source files the designer does not read (" + raw.Trim() + ")";
                    }
                }
                return null;
            }
            catch { return "the project file could not be read"; }
        }
    }
}
