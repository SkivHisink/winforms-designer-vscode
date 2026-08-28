using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace WinFormsDesigner.Engine
{
    public sealed class GeometryRect
    {
        public int X { get; init; }
        public int Y { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }

        public static GeometryRect From(Rectangle r) => new() { X = r.X, Y = r.Y, Width = r.Width, Height = r.Height };
    }

    public sealed class GeometrySpacing
    {
        public int Left { get; init; }
        public int Top { get; init; }
        public int Right { get; init; }
        public int Bottom { get; init; }

        public static GeometrySpacing From(Padding p) => new() { Left = p.Left, Top = p.Top, Right = p.Right, Bottom = p.Bottom };
    }

    public sealed class GeometrySourceValue
    {
        public string ComponentId { get; init; } = "";
        public string PropertyName { get; init; } = "";
        public string PropertyTypeName { get; init; } = "";
        public string InvariantValue { get; init; } = "";
        public string Expression { get; init; } = "";
    }

    public sealed class GeometryDragStartResult
    {
        public bool Ok { get; init; }
        public string Reason { get; init; } = "";
        public string ComponentId { get; init; } = "";
        public string ComponentType { get; init; } = "";
        public string ParentId { get; init; } = "";
        public string ParentType { get; init; } = "";
        public string ParentLayoutKind { get; init; } = "";
        public GeometryRect? LogicalBounds { get; init; }
        public GeometryRect? WindowBounds { get; init; }
        public GeometrySpacing? Margin { get; init; }
        public GeometrySpacing? Padding { get; init; }
        public GeometrySpacing? ParentPadding { get; init; }
        public string Anchor { get; init; } = "None";
        public string Dock { get; init; } = "None";
        public bool AutoSize { get; init; }
        public int MinimumWidth { get; init; }
        public int MinimumHeight { get; init; }
        public int MaximumWidth { get; init; }
        public int MaximumHeight { get; init; }
        public bool CanMove { get; init; }
        public bool CanResize { get; init; }
        /// <summary>Opaque engine-issued base-field identity for inherited geometry. Empty for current-source controls.</summary>
        public string BaseIdentityToken { get; init; } = "";
    }

    public sealed class GeometryCommitResult
    {
        public bool Ok { get; init; }
        public string Reason { get; init; } = "";
        public string ComponentId { get; init; } = "";
        public GeometryRect? RequestedLogicalBounds { get; init; }
        public GeometryRect? CorrectedLogicalBounds { get; init; }
        public GeometryRect? CorrectedWindowBounds { get; init; }
        public bool Corrected { get; init; }
        public string? DesignerText { get; init; }
        public List<GeometrySourceValue> SourceValues { get; init; } = new();
    }

    internal static class DesignerGeometry
    {
        public static GeometryDragStartResult Begin(
            IContainer container,
            Control root,
            string className,
            string componentId,
            string sourceText,
            bool inheritedBase,
            Func<Control, GeometryRect> windowBounds)
        {
            var target = ResolveControl(container, root, componentId);
            if (target == null)
                return new GeometryDragStartResult { Ok = false, ComponentId = componentId ?? "", Reason = "component not found: " + componentId };

            string id = IdOf(target, root, className);
            var refusal = RefusalReason(target, root, sourceText, inheritedBase);
            return BuildStart(target, root, id, refusal, "", windowBounds);
        }

        public static GeometryDragStartResult BeginInherited(
            Control target,
            Control root,
            string className,
            string componentId,
            string baseIdentityToken,
            Func<Control, GeometryRect> windowBounds)
        {
            string id = IdOf(target, root, className);
            string refusal = !string.Equals(id, componentId, StringComparison.Ordinal)
                ? "inherited component identity changed"
                : string.IsNullOrWhiteSpace(baseIdentityToken)
                    ? "inherited base identity is unavailable"
                    : LiveRefusalReason(target, root);
            return BuildStart(target, root, id, refusal, baseIdentityToken, windowBounds);
        }

        private static GeometryDragStartResult BuildStart(Control target, Control root, string id, string refusal,
            string baseIdentityToken, Func<Control, GeometryRect> windowBounds)
        {
            var parent = target.Parent;
            var canEdit = refusal.Length == 0;
            bool canMove = canEdit && !ReferenceEquals(target, root) && target.Dock == DockStyle.None;
            bool canResize = canEdit && !target.AutoSize && target.Dock != DockStyle.Fill;
            string restriction = refusal;
            if (restriction.Length == 0)
            {
                if (target.AutoSize && target.Dock != DockStyle.None)
                    restriction = "AutoSize and Dock manage all direct-manipulation axes";
                else if (target.AutoSize)
                    restriction = "AutoSize controls can move but cannot be resized directly";
                else if (target.Dock == DockStyle.Fill)
                    restriction = "Dock=Fill manages all direct-manipulation axes";
                else if (target.Dock != DockStyle.None)
                    restriction = "Dock-managed control can resize only on its free axis";
            }

            return new GeometryDragStartResult
            {
                Ok = true,
                Reason = restriction,
                ComponentId = id,
                ComponentType = target.GetType().FullName ?? target.GetType().Name,
                ParentId = ParentIdOf(target, root),
                ParentType = parent?.GetType().FullName ?? "",
                ParentLayoutKind = LayoutKind(parent),
                LogicalBounds = GeometryRect.From(target.Bounds),
                WindowBounds = windowBounds(target),
                Margin = GeometrySpacing.From(target.Margin),
                Padding = GeometrySpacing.From(target.Padding),
                ParentPadding = parent == null ? null : GeometrySpacing.From(parent.Padding),
                Anchor = ReferenceEquals(target, root) ? "None" : target.Anchor.ToString(),
                Dock = ReferenceEquals(target, root) ? "None" : target.Dock.ToString(),
                AutoSize = target.AutoSize,
                MinimumWidth = target.MinimumSize.Width,
                MinimumHeight = target.MinimumSize.Height,
                MaximumWidth = target.MaximumSize.Width,
                MaximumHeight = target.MaximumSize.Height,
                CanMove = canMove,
                // An AutoSize control sizes itself from its content: Visual Studio offers no size grips for one,
                // and a drag that "resized" it would write a Size the layout engine immediately discards.
                // Docked controls retain one user-sized axis in the WinForms designer: Width for Left/Right and
                // Height for Top/Bottom. The commit path clamps every other axis back to the live layout result.
                CanResize = canResize,
                BaseIdentityToken = baseIdentityToken,
            };
        }

        public static GeometryCommitResult Commit(
            IContainer container,
            Control root,
            string className,
            string componentId,
            GeometryRect candidate,
            string sourceText,
            bool inheritedBase,
            Func<Control, GeometryRect> windowBounds)
        {
            var requested = NormalizeCandidate(candidate);
            var target = ResolveControl(container, root, componentId);
            if (target == null)
            {
                return new GeometryCommitResult
                {
                    Ok = false,
                    ComponentId = componentId ?? "",
                    RequestedLogicalBounds = requested,
                    Reason = "component not found: " + componentId,
                };
            }

            string id = IdOf(target, root, className);
            var refusal = RefusalReason(target, root, sourceText, inheritedBase);
            if (refusal.Length != 0)
            {
                return new GeometryCommitResult
                {
                    Ok = false,
                    ComponentId = id,
                    RequestedLogicalBounds = requested,
                    CorrectedLogicalBounds = GeometryRect.From(target.Bounds),
                    CorrectedWindowBounds = windowBounds(target),
                    Reason = refusal,
                };
            }

            var before = target.Bounds;
            if (!TryConstrainCandidate(target, before, requested, out var constrained, out var constraintReason))
            {
                return new GeometryCommitResult
                {
                    Ok = false,
                    ComponentId = id,
                    RequestedLogicalBounds = requested,
                    CorrectedLogicalBounds = GeometryRect.From(before),
                    CorrectedWindowBounds = windowBounds(target),
                    Reason = constraintReason,
                };
            }
            try
            {
                target.SetBounds(constrained.X, constrained.Y, constrained.Width, constrained.Height);
                target.Parent?.PerformLayout();
                root.PerformLayout();
                target.PerformLayout();
            }
            catch (Exception ex)
            {
                return new GeometryCommitResult
                {
                    Ok = false,
                    ComponentId = id,
                    RequestedLogicalBounds = requested,
                    CorrectedLogicalBounds = GeometryRect.From(target.Bounds),
                    CorrectedWindowBounds = windowBounds(target),
                    Reason = "SetBounds failed: " + ex.GetType().Name + ": " + ex.Message,
                };
            }

            var corrected = GeometryRect.From(target.Bounds);
            var sourceValues = SourceValuesFor(id, before, target.Bounds);
            if (target.Dock != DockStyle.None)
                sourceValues.RemoveAll(value => value.PropertyName == "Location");
            var edit = BuildDesignerText(sourceText, sourceValues);
            if (!edit.Ok)
            {
                return new GeometryCommitResult
                {
                    Ok = false,
                    ComponentId = id,
                    RequestedLogicalBounds = requested,
                    CorrectedLogicalBounds = corrected,
                    CorrectedWindowBounds = windowBounds(target),
                    Corrected = !Same(requested, corrected),
                    SourceValues = sourceValues,
                    Reason = edit.Reason,
                };
            }

            return new GeometryCommitResult
            {
                Ok = true,
                ComponentId = id,
                RequestedLogicalBounds = requested,
                CorrectedLogicalBounds = corrected,
                CorrectedWindowBounds = windowBounds(target),
                Corrected = !Same(requested, corrected),
                DesignerText = edit.Text,
                SourceValues = sourceValues,
            };
        }

        public static GeometryCommitResult CommitInherited(
            Control target,
            Control root,
            string className,
            string componentId,
            GeometryRect candidate,
            string sourceText,
            ComponentOwnershipInfo ownership,
            string expectedBaseIdentityToken,
            Func<Control, GeometryRect> windowBounds)
        {
            var requested = NormalizeCandidate(candidate);
            string id = IdOf(target, root, className);
            string refusal = !string.Equals(id, componentId, StringComparison.Ordinal)
                ? "inherited component identity changed"
                : string.IsNullOrWhiteSpace(expectedBaseIdentityToken)
                    || !string.Equals(expectedBaseIdentityToken, ownership.BaseIdentityToken, StringComparison.Ordinal)
                    ? "base identity token is empty, unknown, or stale"
                    : LiveRefusalReason(target, root);
            if (refusal.Length != 0)
            {
                return new GeometryCommitResult
                {
                    Ok = false,
                    ComponentId = id,
                    RequestedLogicalBounds = requested,
                    CorrectedLogicalBounds = GeometryRect.From(target.Bounds),
                    CorrectedWindowBounds = windowBounds(target),
                    Reason = refusal,
                };
            }

            var before = target.Bounds;
            if (!TryConstrainCandidate(target, before, requested, out var constrained, out var constraintReason))
            {
                return new GeometryCommitResult
                {
                    Ok = false,
                    ComponentId = id,
                    RequestedLogicalBounds = requested,
                    CorrectedLogicalBounds = GeometryRect.From(before),
                    CorrectedWindowBounds = windowBounds(target),
                    Reason = constraintReason,
                };
            }
            try
            {
                target.SetBounds(constrained.X, constrained.Y, constrained.Width, constrained.Height);
                target.Parent?.PerformLayout();
                root.PerformLayout();
                target.PerformLayout();
            }
            catch (Exception ex)
            {
                return new GeometryCommitResult
                {
                    Ok = false,
                    ComponentId = id,
                    RequestedLogicalBounds = requested,
                    CorrectedLogicalBounds = GeometryRect.From(target.Bounds),
                    CorrectedWindowBounds = windowBounds(target),
                    Reason = "SetBounds failed: " + ex.GetType().Name + ": " + ex.Message,
                };
            }

            var corrected = GeometryRect.From(target.Bounds);
            var sourceValues = SourceValuesFor(id, before, target.Bounds);
            if (target.Dock != DockStyle.None)
                sourceValues.RemoveAll(value => value.PropertyName == "Location");
            string current = sourceText;
            foreach (var value in sourceValues)
            {
                if (ownership.InheritedResolvedFieldType == null)
                {
                    return new GeometryCommitResult
                    {
                        Ok = false,
                        ComponentId = id,
                        RequestedLogicalBounds = requested,
                        CorrectedLogicalBounds = corrected,
                        CorrectedWindowBounds = windowBounds(target),
                        Corrected = !Same(requested, corrected),
                        SourceValues = sourceValues,
                        Reason = "inherited field type is no longer resolved by the live designer graph",
                    };
                }
                var edit = DesignerInheritedOverrideEditor.TryApply(new InheritedOverrideEditRequest
                {
                    SourceText = current,
                    FieldId = ownership.Id,
                    FieldTypeName = ownership.InheritedFieldType,
                    EffectiveAccessibility = ownership.EffectiveAccessibility,
                    PropertyName = value.PropertyName,
                    PropertyTypeName = value.PropertyTypeName,
                    ValueExpression = value.Expression,
                    ExpectedBaseIdentityToken = expectedBaseIdentityToken,
                    ObservedBaseIdentityToken = ownership.BaseIdentityToken,
                }, ownership.InheritedResolvedFieldType, target.GetType());
                if (!edit.Safe || edit.NewText == null)
                {
                    return new GeometryCommitResult
                    {
                        Ok = false,
                        ComponentId = id,
                        RequestedLogicalBounds = requested,
                        CorrectedLogicalBounds = corrected,
                        CorrectedWindowBounds = windowBounds(target),
                        Corrected = !Same(requested, corrected),
                        SourceValues = sourceValues,
                        Reason = "source edit failed for " + value.PropertyName + ": " + edit.Reason,
                    };
                }
                current = edit.NewText;
            }

            return new GeometryCommitResult
            {
                Ok = true,
                ComponentId = id,
                RequestedLogicalBounds = requested,
                CorrectedLogicalBounds = corrected,
                CorrectedWindowBounds = windowBounds(target),
                Corrected = !Same(requested, corrected),
                DesignerText = sourceValues.Count == 0 ? null : current,
                SourceValues = sourceValues,
            };
        }

        private static GeometryRect NormalizeCandidate(GeometryRect candidate) => new()
        {
            X = Bounded(candidate.X),
            Y = Bounded(candidate.Y),
            Width = Math.Max(1, Bounded(candidate.Width)),
            Height = Math.Max(1, Bounded(candidate.Height)),
        };

        private static int Bounded(int value)
        {
            const int Max = 100000;
            if (value < -Max) return -Max;
            if (value > Max) return Max;
            return value;
        }

        private static IComponent? ResolveComponent(IContainer container, Control root, string componentId)
        {
            if (componentId is null or "" or "this") return root;
            return container.Components.Cast<IComponent>()
                .FirstOrDefault(c => string.Equals(c.Site?.Name, componentId, StringComparison.Ordinal));
        }

        private static Control? ResolveControl(IContainer container, Control root, string componentId) =>
            ResolveComponent(container, root, componentId) as Control;

        private static string RefusalReason(Control target, Control root, string sourceText, bool inheritedBase)
        {
            string live = LiveRefusalReason(target, root);
            if (live.Length != 0) return live;
            string id = target.Site!.Name!;
            if (inheritedBase)
                return "inherited base graph is not fully addressable in the modern engine";
            if (!SourceDeclaresField(sourceText, id))
                return "component is inherited or not declared as a designer field: " + id;
            return "";
        }

        /// <summary>The shared live layout gate for inherited geometry metadata, begin, and commit.</summary>
        public static string LiveRefusalReason(Control target, Control root)
        {
            if (ReferenceEquals(target, root))
                return "root component direct manipulation is not supported";
            if (target.Site?.Name is not { Length: > 0 } id)
                return "component is not addressable by id";
            if (!DesignerControlEditor.IsValidIdentifier(id))
                return "component id is not a valid designer identifier: " + id;
            // A current-source custom/vendor Control is still authoritatively measurable: the live instance accepts
            // SetBounds, layout runs, and the engine reads the corrected bounds back before producing a bounded source
            // patch. Requiring a framework assembly here froze every managed custom control even though this exact
            // round-trip is the authority. ActiveX remains excluded by the product Tier-D gate and this defence-in-depth
            // check; it is not a managed ControlDesigner compatibility promise.
            if (target is AxHost)
                return "ActiveX geometry is excluded from the managed designer";
            if (target.Parent is TableLayoutPanel)
                return "parent layout manages child bounds: TableLayoutPanel";
            if (target.Parent is FlowLayoutPanel)
                return "parent layout manages child bounds: FlowLayoutPanel";
            return "";
        }

        private static bool TryConstrainCandidate(Control target, Rectangle before, GeometryRect requested,
            out GeometryRect constrained, out string reason)
        {
            reason = "";
            constrained = requested;

            bool requestedMove = requested.X != before.X || requested.Y != before.Y;
            bool requestedResize = requested.Width != before.Width || requested.Height != before.Height;

            if (target.AutoSize)
            {
                if (target.Dock != DockStyle.None)
                {
                    reason = "AutoSize and Dock manage all direct-manipulation axes";
                    return false;
                }
                if (requestedResize && !requestedMove)
                {
                    reason = "AutoSize controls can move but cannot be resized directly";
                    return false;
                }
                constrained = new GeometryRect
                {
                    X = requested.X,
                    Y = requested.Y,
                    Width = before.Width,
                    Height = before.Height,
                };
                return true;
            }

            switch (target.Dock)
            {
                case DockStyle.None:
                    return true;
                case DockStyle.Fill:
                    reason = "Dock=Fill manages all direct-manipulation axes";
                    return false;
                case DockStyle.Left:
                case DockStyle.Right:
                    if (requested.Width == before.Width)
                    {
                        reason = "Dock-managed Left/Right controls can resize only in width";
                        return false;
                    }
                    constrained = new GeometryRect
                    {
                        X = before.X,
                        Y = before.Y,
                        Width = requested.Width,
                        Height = before.Height,
                    };
                    return true;
                case DockStyle.Top:
                case DockStyle.Bottom:
                    if (requested.Height == before.Height)
                    {
                        reason = "Dock-managed Top/Bottom controls can resize only in height";
                        return false;
                    }
                    constrained = new GeometryRect
                    {
                        X = before.X,
                        Y = before.Y,
                        Width = before.Width,
                        Height = requested.Height,
                    };
                    return true;
                default:
                    reason = "unsupported Dock geometry";
                    return false;
            }
        }

        private static bool SourceDeclaresField(string sourceText, string componentId)
        {
            SyntaxNode root;
            try { root = CSharpSyntaxTree.ParseText(sourceText).GetRoot(); }
            catch { return false; }
            var form = FormClassResolver.FormClass(root);
            return form != null && FormClassResolver.FieldNamesOf(form).Contains(componentId);
        }

        private static string IdOf(Control target, Control root, string className) =>
            ReferenceEquals(target, root) ? "this" : (target.Site?.Name ?? className);

        private static string ParentIdOf(Control target, Control root)
        {
            if (ReferenceEquals(target, root) || target.Parent == null) return "";
            if (ReferenceEquals(target.Parent, root)) return "this";
            if (target.Parent is SplitterPanel splitterPanel
                && splitterPanel.Parent is SplitContainer split
                && split.Site?.Name is { Length: > 0 } splitId)
            {
                if (ReferenceEquals(splitterPanel, split.Panel1)) return splitId + ".Panel1";
                if (ReferenceEquals(splitterPanel, split.Panel2)) return splitId + ".Panel2";
            }
            if (target.Parent.Site?.Name is { Length: > 0 } parentId) return parentId;
            return "";
        }

        private static string LayoutKind(Control? parent) =>
            parent switch
            {
                null => "",
                TableLayoutPanel => "TableLayoutPanel",
                FlowLayoutPanel => "FlowLayoutPanel",
                _ => parent.LayoutEngine.GetType().FullName ?? parent.LayoutEngine.GetType().Name,
            };

        private static List<GeometrySourceValue> SourceValuesFor(string componentId, Rectangle before, Rectangle corrected)
        {
            var values = new List<GeometrySourceValue>();
            if (before.Location != corrected.Location)
            {
                values.Add(new GeometrySourceValue
                {
                    ComponentId = componentId,
                    PropertyName = "Location",
                    PropertyTypeName = "System.Drawing.Point",
                    InvariantValue = corrected.X.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + ", " + corrected.Y.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Expression = "new System.Drawing.Point(" + corrected.X.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + ", " + corrected.Y.ToString(System.Globalization.CultureInfo.InvariantCulture) + ")",
                });
            }
            if (before.Size != corrected.Size)
            {
                values.Add(new GeometrySourceValue
                {
                    ComponentId = componentId,
                    PropertyName = "Size",
                    PropertyTypeName = "System.Drawing.Size",
                    InvariantValue = corrected.Width.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + ", " + corrected.Height.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Expression = "new System.Drawing.Size(" + corrected.Width.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + ", " + corrected.Height.ToString(System.Globalization.CultureInfo.InvariantCulture) + ")",
                });
            }
            return values;
        }

        private static (bool Ok, string? Text, string Reason) BuildDesignerText(string sourceText, IReadOnlyList<GeometrySourceValue> values)
        {
            if (values.Count == 0) return (true, null, "");
            string current = sourceText;
            foreach (var value in values)
            {
                var edit = DesignerPropertyEditor.EditProperty(current, value.ComponentId, value.PropertyName, value.Expression);
                if (edit.Mode == EditMode.Failed)
                    return (false, null, "source edit failed for " + value.PropertyName + ": " + edit.Reason);

                bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics()
                    .Any(d => d.Severity == DiagnosticSeverity.Error);
                bool minimal = DesignerPropertyEditor.OnlyTargetChanged(current, edit.NewText, value.ComponentId, value.PropertyName, edit.Mode);
                if (!parseOk || !minimal)
                    return (false, null, !parseOk
                        ? "source edit for " + value.PropertyName + " has syntax errors"
                        : "source edit for " + value.PropertyName + " changed more than the target property");
                current = edit.NewText;
            }
            return (true, current, "");
        }

        private static bool Same(GeometryRect a, GeometryRect b) =>
            a.X == b.X && a.Y == b.Y && a.Width == b.Width && a.Height == b.Height;
    }
}
