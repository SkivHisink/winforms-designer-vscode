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
        private const int MaxCoordinate = 16_384;

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
            int inspected = 0;
            foreach (object? item in items)
            {
                if (++inspected > MaxAdorners)
                    throw new InvalidOperationException("Hosted adorner count exceeds the fixed bound.");
                if (item == null) continue;

                if (ReadPublicProperty(item, "Id") is not string id
                    || ReadPublicProperty(item, "DisplayName") is not string displayName)
                    throw new InvalidOperationException("Hosted adorner identity must be text.");
                if (!IsSafeIdentity(id)
                    || result.Any(existing => string.Equals(existing.Id, id, StringComparison.Ordinal)))
                    throw new InvalidOperationException("Hosted adorner id is invalid.");
                if (displayName.Length > MaxIdentityChars || displayName.Any(char.IsControl))
                    throw new InvalidOperationException("Hosted adorner display name is invalid.");

                object? boundsValue = ReadPublicProperty(item, "Bounds");
                if (boundsValue is not Rectangle bounds || bounds.Width < 0 || bounds.Height < 0
                    || bounds.Width > MaxCoordinate || bounds.Height > MaxCoordinate
                    || bounds.Left < -MaxCoordinate || bounds.Top < -MaxCoordinate
                    || (long)bounds.Left + bounds.Width > MaxCoordinate || (long)bounds.Top + bounds.Height > MaxCoordinate)
                    throw new InvalidOperationException("Hosted adorner bounds are invalid.");
                if (ReadPublicProperty(item, "HitTestable") is not bool hitTestable)
                    throw new InvalidOperationException("Hosted adorner hit-test flag is invalid.");

                object? commandValue = ReadOptionalPublicProperty(item, "CommandId");
                if (commandValue != null && commandValue is not string)
                    throw new InvalidOperationException("Hosted adorner command identity is invalid.");
                string commandId = commandValue as string ?? "";
                string keyboardCommandId = "";
                bool enabled = false;
                string disabledReasonCode = "render_only";
                if (commandId.Length != 0)
                {
                    if (!IsSafeIdentity(commandId)
                        || ReadPublicProperty(item, "KeyboardCommandId") is not string keyboardId
                        || !string.Equals(commandId, keyboardId, StringComparison.Ordinal)
                        || ReadPublicProperty(item, "Enabled") is not bool commandEnabled
                        || string.IsNullOrWhiteSpace(displayName))
                        throw new InvalidOperationException("Hosted adorner command requires a matching keyboard command and enabled state.");
                    keyboardCommandId = keyboardId;
                    enabled = commandEnabled;
                    object? reasonValue = ReadOptionalPublicProperty(item, "DisabledReasonCode");
                    if (reasonValue != null && reasonValue is not string)
                        throw new InvalidOperationException("Hosted adorner disabled reason is invalid.");
                    disabledReasonCode = reasonValue as string ?? "";
                    if (enabled ? disabledReasonCode.Length != 0 : !IsSafeIdentity(disabledReasonCode))
                        throw new InvalidOperationException("Hosted adorner disabled state requires a stable reason code.");
                }
                result.Add(new DesignerAdornerInfo
                {
                    Id = id,
                    DisplayName = displayName,
                    Left = bounds.Left,
                    Top = bounds.Top,
                    Width = bounds.Width,
                    Height = bounds.Height,
                    HitTestable = hitTestable && (commandId.Length == 0 || enabled),
                    CommandId = commandId,
                    KeyboardCommandId = keyboardCommandId,
                    Enabled = enabled,
                    DisabledReasonCode = disabledReasonCode,
                });
            }
            return result;
        }

        public static bool ConfirmsHit(ControlDesigner designer, string id, Point point)
        {
            DesignerServiceKernelGuard.ThrowIfNull(designer);
            DesignerAdornerInfo? current = Read(designer).SingleOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.Ordinal));
            if (current == null || !current.HitTestable
                || !new Rectangle(current.Left, current.Top, current.Width, current.Height).Contains(point)) return false;
            var method = designer.GetType().GetMethod(
                "HitTestHostedDesignerAdorner",
                BindingFlags.Public | BindingFlags.Instance,
                binder: null,
                types: new[] { typeof(string), typeof(Point) },
                modifiers: null);
            return method == null || method.Invoke(designer, new object[] { id, point }) is true;
        }

        /// <summary>Re-reads the descriptor for the host command planner. It never invokes project code beyond
        /// metadata inspection and grants no write authority; the planner must still authorize and transact the intent.</summary>
        public static bool TryGetCommand(ControlDesigner designer, string id, out string commandId, out string reasonCode)
        {
            commandId = "";
            reasonCode = "invalid_adorner";
            if (!IsSafeIdentity(id)) return false;
            DesignerAdornerInfo? adorner = Read(designer).SingleOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.Ordinal));
            if (adorner == null) { reasonCode = "adorner_unavailable"; return false; }
            if (adorner.CommandId.Length == 0) { reasonCode = "render_only"; return false; }
            if (!adorner.Enabled) { reasonCode = adorner.DisabledReasonCode; return false; }
            commandId = adorner.CommandId;
            reasonCode = "";
            return true;
        }

        private static bool IsSafeIdentity(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > MaxIdentityChars) return false;
            foreach (char c in value)
                if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == ':')) return false;
            return true;
        }

        private static object? ReadOptionalPublicProperty(object instance, string name)
        {
            var property = instance.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (property == null) return null;
            if (property.GetMethod == null || !property.GetMethod.IsPublic || property.GetIndexParameters().Length != 0)
                throw new InvalidOperationException("Hosted adorner item has an invalid " + name + ".");
            return property.GetValue(instance);
        }

        private static object? ReadPublicProperty(object instance, string name)
        {
            var property = instance.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (property?.GetMethod == null || !property.GetMethod.IsPublic || property.GetIndexParameters().Length != 0)
                throw new InvalidOperationException("Hosted adorner item is missing " + name + ".");
            return property.GetValue(instance);
        }
    }
}
