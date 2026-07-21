using System.Collections.Generic;
using System.ComponentModel;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The IDENTITY-model resolution behind interpreted describe, extracted from the net48 render worker so the
    // acceptance-critical filtering is unit-testable without spinning a live engine host. Given the executor's result
    // and the realized root, it resolves the describe TARGET, the reference-dropdown SIBLINGS, the logical NAME, and
    // the identity-backed PARENT — everything EXCEPT the final TypeDescriptor-bound CompiledDescriber.Describe call,
    // which stays in the net48 worker (it needs the real net48 type system). The contract it enforces:
    //   · root ("" / "this") → the LOGICAL designed type's short name (never the base runtime type)
    //   · a named id → its instance ONLY when Origins[id] == DeclaredInCurrentSource
    //   · an inherited (compiled-base) component OR an unknown id → null, so the host keeps that selection
    //     read-only / unavailable and NEVER presents inherited members as editable current-source ones
    //   · siblings = the current-source components only (what the derived .Designer.cs can spell as this.<field>)
    //
    // Takes the raw (IrExecutionResult, designedTypeName) rather than the InterpretedRenderPlan so it is BCL-only and
    // fully unit-testable on both runtimes straight off the executor — no plan/host/factory dependency.
    // ============================================================================================================
    public sealed class InterpretedDescribeTarget
    {
        public IComponent Target { get; }
        public bool IsRoot { get; }
        public string Name { get; }
        public string? Parent { get; }
        public List<KeyValuePair<string, IComponent>> Siblings { get; }

        public InterpretedDescribeTarget(IComponent target, bool isRoot, string name, string? parent,
            List<KeyValuePair<string, IComponent>> siblings)
        {
            Target = target; IsRoot = isRoot; Name = name; Parent = parent; Siblings = siblings;
        }
    }

    public static class InterpretedDescribeResolver
    {
        /// <summary>Resolve the describe target + siblings from the interpreter's identity model. Returns null exactly
        /// when the id is not a describable current-source identity (inherited / unknown / root not a component).</summary>
        public static InterpretedDescribeTarget? Resolve(IrExecutionResult exec, string designedTypeName, Control root, string componentId)
        {
            if (exec == null || root == null) return null;
            componentId ??= "";
            bool isRoot = componentId == "this" || componentId.Length == 0;

            object? targetObj;
            if (isRoot) targetObj = root;
            else if (exec.Instances.TryGetValue(componentId, out var v)
                && exec.Origins.TryGetValue(componentId, out var origin) && origin == IrOrigin.DeclaredInCurrentSource)
                targetObj = v;
            else targetObj = null;
            if (targetObj is not IComponent target) return null;

            var siblings = new List<KeyValuePair<string, IComponent>>();
            foreach (var kv in exec.Instances)
            {
                if (kv.Key.Length == 0) continue; // root handled separately
                if (!exec.Origins.TryGetValue(kv.Key, out var o) || o != IrOrigin.DeclaredInCurrentSource) continue;
                if (kv.Value is IComponent comp && !ReferenceEquals(comp, target))
                    siblings.Add(new KeyValuePair<string, IComponent>(kv.Key, comp));
            }
            siblings.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));

            string name = isRoot ? ShortName(designedTypeName) : componentId;
            string? parent = isRoot ? null : (target is Control tc ? ParentOf(tc, root, exec, designedTypeName) : null);
            return new InterpretedDescribeTarget(target, isRoot, name, parent, siblings);
        }

        /// <summary>Nearest identity-backed parent of an interpreted control: the LOGICAL root's short name at the root
        /// boundary (not the base runtime type), else the current-source name of the nearest ancestor found by
        /// reference in Instances; null (unavailable) rather than guessed.</summary>
        public static string? ParentOf(Control c, Control root, IrExecutionResult exec, string designedTypeName)
        {
            for (Control? p = c.Parent; p != null; p = p.Parent)
            {
                if (ReferenceEquals(p, root)) return ShortName(designedTypeName);
                foreach (var kv in exec.Instances)
                    // Only a CURRENT-SOURCE ancestor is a valid parent name — the derived .Designer.cs can spell it as
                    // this.<field>. An INHERITED container (e.g. a base panel a base OnControlAdded reparented the child
                    // into) must NOT be reported: it is not addressable in the current source. Skip it and keep walking
                    // up to the nearest current-source ancestor (ultimately the logical root).
                    if (kv.Key.Length != 0 && ReferenceEquals(kv.Value, p)
                        && exec.Origins.TryGetValue(kv.Key, out var o) && o == IrOrigin.DeclaredInCurrentSource)
                        return kv.Key;
            }
            return null;
        }

        /// <summary>The last dotted-or-nested (`.` / `+`) segment of a type name — the logical short name, so a nested
        /// designed type 'Ns.Outer+Inner' reports 'Inner' (matching the compiled describe's Type.Name).</summary>
        public static string ShortName(string fqn)
        {
            int i = fqn.LastIndexOfAny(new[] { '.', '+' });
            return i >= 0 ? fqn.Substring(i + 1) : fqn;
        }
    }
}
