using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Reflection;
using System.Windows.Forms.Design;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// The fixed DTO-only bridge between a hosted ControlDesigner and the engine/extension process boundary.
    /// A project designer may publish simple rectangles and optionally confirm a point; no Behavior/Glyph object,
    /// delegate, service, or workspace path is accepted. This is an in-repo adapter contract, not a claim that an
    /// arbitrary Visual Studio designer can be rehosted safely.
    /// </summary>
    internal static class HostedDesignerAdornerContract
    {
        private const int MaxAdorners = 32;
        private const int MaxIdentityChars = 128;

        public static List<DesignerAdornerInfo> Read(ControlDesigner designer)
        {
            DesignerServiceKernelGuard.ThrowIfNull(designer);
            var method = designer.GetType().GetMethod(
                "GetHostedDesignerAdorners",
                BindingFlags.Public | BindingFlags.Instance,
                binder: null,
                types: Type.EmptyTypes,
                modifiers: null);
            if (method == null) return new List<DesignerAdornerInfo>();
            if (method.ReturnType == typeof(string) || !typeof(IEnumerable).IsAssignableFrom(method.ReturnType))
                throw new InvalidOperationException("Hosted adorner provider must return IEnumerable.");

            object? raw = method.Invoke(designer, Array.Empty<object>());
            if (raw is not IEnumerable items) return new List<DesignerAdornerInfo>();

            var result = new List<DesignerAdornerInfo>();
            foreach (object? item in items)
            {
                if (item == null) continue;
                if (result.Count >= MaxAdorners)
                    throw new InvalidOperationException("Hosted adorner count exceeds the fixed bound.");

                string id = Convert.ToString(ReadPublicProperty(item, "Id"),
                    System.Globalization.CultureInfo.InvariantCulture) ?? "";
                string displayName = Convert.ToString(ReadPublicProperty(item, "DisplayName"),
                    System.Globalization.CultureInfo.InvariantCulture) ?? "";
                if (string.IsNullOrWhiteSpace(id) || id.Length > MaxIdentityChars
                    || result.Any(existing => string.Equals(existing.Id, id, StringComparison.Ordinal)))
                    throw new InvalidOperationException("Hosted adorner id is invalid.");
                if (displayName.Length > MaxIdentityChars)
                    throw new InvalidOperationException("Hosted adorner display name is invalid.");

                object? boundsValue = ReadPublicProperty(item, "Bounds");
                if (boundsValue is not Rectangle bounds || bounds.Width < 0 || bounds.Height < 0)
                    throw new InvalidOperationException("Hosted adorner bounds are invalid.");
                bool hitTestable = Convert.ToBoolean(ReadPublicProperty(item, "HitTestable"),
                    System.Globalization.CultureInfo.InvariantCulture);
                result.Add(new DesignerAdornerInfo
                {
                    Id = id,
                    DisplayName = displayName,
                    Left = bounds.Left,
                    Top = bounds.Top,
                    Width = bounds.Width,
                    Height = bounds.Height,
                    HitTestable = hitTestable,
                });
            }
            return result;
        }

        public static bool ConfirmsHit(ControlDesigner designer, string id, Point point)
        {
            DesignerServiceKernelGuard.ThrowIfNull(designer);
            var method = designer.GetType().GetMethod(
                "HitTestHostedDesignerAdorner",
                BindingFlags.Public | BindingFlags.Instance,
                binder: null,
                types: new[] { typeof(string), typeof(Point) },
                modifiers: null);
            return method == null || method.Invoke(designer, new object[] { id, point }) is true;
        }

        private static object? ReadPublicProperty(object instance, string name)
        {
            var property = instance.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (property?.GetMethod == null || property.GetIndexParameters().Length != 0)
                throw new InvalidOperationException("Hosted adorner item is missing " + name + ".");
            return property.GetValue(instance);
        }
    }
}
