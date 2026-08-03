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
            var parent = target.Parent;
            var canEdit = refusal.Length == 0;

            return new GeometryDragStartResult
            {
                Ok = true,
                Reason = refusal,
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
                CanMove = canEdit && !ReferenceEquals(target, root),
                CanResize = canEdit,
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
            try
            {
                target.SetBounds(requested.X, requested.Y, requested.Width, requested.Height);
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
            if (ReferenceEquals(target, root))
                return "root component direct manipulation is not supported";
            if (target.Site?.Name is not { Length: > 0 } id)
                return "component is not addressable by id";
            if (!DesignerControlEditor.IsValidIdentifier(id))
                return "component id is not a valid designer identifier: " + id;
            if (inheritedBase)
                return "inherited base graph is not fully addressable in the modern engine";
            if (!SourceDeclaresField(sourceText, id))
                return "component is inherited or not declared as a designer field: " + id;
            if (!DesignerAllowlists.IsTrustedFrameworkType(target.GetType()))
                return "custom control geometry constraints are not engine-authoritative: " + (target.GetType().FullName ?? target.GetType().Name);
            if (target.Parent is TableLayoutPanel)
                return "parent layout manages child bounds: TableLayoutPanel";
            if (target.Parent is FlowLayoutPanel)
                return "parent layout manages child bounds: FlowLayoutPanel";
            if (target.Dock != DockStyle.None)
                return "Dock-managed controls cannot be moved or resized directly";
            if (target.AutoSize)
                return "AutoSize controls cannot be moved or resized directly";
            return "";
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
            return ReferenceEquals(target.Parent, root) ? "this" : (target.Parent.Site?.Name ?? "");
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
