using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Reflection;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Reads a vendor control's DECLARED smart-tag menu (DevExpress "XtraTabControl Tasks") off the compiled
    /// type's attribute METADATA — the authentic labels VS shows, in the vendor's own words.
    ///
    /// Why the vendor's action is never invoked:
    /// the actions (e.g. XtraTabControlActions.AddTabPage(IComponent)) mutate the LIVE component graph through a
    /// design host. This engine's instance is a real runtime object rendered with DrawToBitmap — it is deliberately
    /// NOT sited (siting flips DesignMode for the whole tree and would shift the render away from runtime parity), and
    /// nothing would carry such a mutation back into .Designer.cs, so the edit would silently vanish on the next
    /// rebuild. Some actions are worse than useless headless: the "Tab Pages" verb opens a modal collection-editor
    /// DIALOG, which would hang this engine. So we surface the vendor's MENU and let the host run its own
    /// source-first implementation for the verbs it can express; the rest are reported and shown disabled.
    ///
    /// METADATA, not instances: read via CustomAttributeData, never Type.GetCustomAttributes.
    /// GetCustomAttributes CONSTRUCTS every attribute on the type hierarchy — arbitrary vendor ctor code on the
    /// engine's persistent STA thread, before we even learn the attribute's name — and the property getters we would
    /// then call are arbitrary code too. A ctor that blocks (a lock, a modal dialog, a spin) would wedge that STA
    /// forever and every later render with it; a try/catch cannot rescue a thread that never returns. CustomAttributeData
    /// decodes the same declaration straight from metadata, so nothing vendor-authored executes here. (RenderWorker's
    /// toolbox scan already reads attributes this way — same reason.)
    ///
    /// Duck-typed on purpose: the engine never references a vendor assembly. We match the attribute by NAME and decode
    /// positionally, so an absent/renamed/reshaped vendor attribute degrades to "no vendor tags" rather than throwing.
    /// Consequently the NAME ALONE IS NOT AUTHORITY: an unrelated assembly could declare its own type with this name.
    /// Nothing here authorizes an edit — every entry is display data, and the host independently proves a verb applies
    /// to the selected control (its own isTabHost / page facts) before any source-writing path can run.
    /// </summary>
    internal static class VendorSmartTags
    {
        private const string ActionAttrName = "SmartTagActionAttribute";
        private const string CloseAfterExecute = "CloseAfterExecute";

        /// <summary>The vendor's declared menu for this component, ordered as the vendor's panel shows it. Empty for a
        /// non-vendor control, an unreadable attribute shape, or any reflection failure (never throws).</summary>
        public static VendorSmartTag[] Read(IComponent target)
        {
            if (target == null) return Array.Empty<VendorSmartTag>();
            try { return ReadCore(target.GetType()); }
            catch { return Array.Empty<VendorSmartTag>(); }
        }

        private static VendorSmartTag[] ReadCore(Type controlType)
        {
            var found = new List<VendorSmartTag>();
            int declIndex = 0;
            // Walk the base chain ourselves: CustomAttributeData is declared-only, and inherited actions are real —
            // a plain SimpleButton inherits "Dock in parent container" from its base. Derived-first, so a derived
            // declaration keeps the position the vendor's own panel gives it.
            for (Type? t = controlType; t != null && t != typeof(object); t = t.BaseType)
            {
                IList<CustomAttributeData> cads;
                try { cads = CustomAttributeData.GetCustomAttributes(t); }
                catch { continue; }   // unresolvable attribute on this level → skip the level, keep the rest
                foreach (var cad in cads)
                {
                    VendorSmartTag? tag;
                    try
                    {
                        if (cad.AttributeType.Name != ActionAttrName) continue;
                        tag = FromAttributeData(cad, declIndex);
                    }
                    catch { continue; }   // a single unreadable declaration never costs us the others
                    if (tag != null) { found.Add(tag); declIndex++; }
                }
            }

            // Vendor panel order, derived empirically from the shipped attributes (every SortOrder is the -1 default,
            // so it alone does not order the menu): plain actions first, then the ones flagged CloseAfterExecute,
            // declaration order within each group. That reproduces the vendor panel's own ordering.
            found.Sort((x, y) =>
            {
                int c = x.SortOrder.CompareTo(y.SortOrder);
                if (c != 0) return c;
                c = (x.ClosesPanel ? 1 : 0).CompareTo(y.ClosesPanel ? 1 : 0);
                return c != 0 ? c : x.DeclarationIndex.CompareTo(y.DeclarationIndex);
            });
            return found.ToArray();
        }

        /// <summary>Decode one [SmartTagAction(actionsType, methodName, displayName[, finalAction])] from metadata.
        /// Named arguments win over positional, so a vendor that sets a property instead still reads correctly.</summary>
        private static VendorSmartTag? FromAttributeData(CustomAttributeData cad, int declIndex)
        {
            string actionsType = "", method = "", display = "";
            int sort = -1;
            bool closes = false;

            var ctor = cad.ConstructorArguments;
            if (ctor.Count >= 1) actionsType = TypeNameOf(ctor[0]);
            if (ctor.Count >= 2) method = ctor[1].Value as string ?? "";
            if (ctor.Count >= 3) display = ctor[2].Value as string ?? "";
            if (ctor.Count >= 4) closes = IsCloseAfterExecute(ctor[3]);

            foreach (var na in cad.NamedArguments)
            {
                switch (na.MemberName)
                {
                    case "Type": { string s = TypeNameOf(na.TypedValue); if (s.Length > 0) actionsType = s; break; }
                    case "MethodName": method = na.TypedValue.Value as string ?? method; break;
                    case "DisplayName": display = na.TypedValue.Value as string ?? display; break;
                    case "SortOrder": if (na.TypedValue.Value is int si) sort = si; break;
                    case "FinalAction": closes = IsCloseAfterExecute(na.TypedValue); break;
                }
            }

            if (method.Length == 0) return null;          // nothing identifies the verb → skip
            if (display.Length == 0) display = method;    // vendor omitted a label → show the verb name

            return new VendorSmartTag
            {
                MethodName = method,
                DisplayName = display,
                ActionsType = actionsType,
                SortOrder = sort,
                ClosesPanel = closes,
                DeclarationIndex = declIndex,
            };
        }

        private static string TypeNameOf(CustomAttributeTypedArgument a)
        {
            try { return (a.Value as Type)?.FullName ?? ""; } catch { return ""; }
        }

        /// <summary>True when the enum argument names CloseAfterExecute. Read by NAME off the metadata's enum type —
        /// never by a hard-coded ordinal, which a vendor could renumber.</summary>
        private static bool IsCloseAfterExecute(CustomAttributeTypedArgument a)
        {
            try
            {
                Type t = a.ArgumentType;
                if (t == null || !t.IsEnum || a.Value == null) return false;
                return string.Equals(Enum.GetName(t, a.Value), CloseAfterExecute, StringComparison.Ordinal);
            }
            catch { return false; }
        }
    }
}
