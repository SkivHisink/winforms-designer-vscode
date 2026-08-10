using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Process-local selected UI culture for each opened designer. The host owns persistence; the engine keeps only a
    /// thread-safe normalized selection so render/describe calls can resolve the same per-culture .resx chain.
    /// Empty string is the neutral/invariant token and maps to the plain sibling .resx.
    /// </summary>
    public static class DesignerCultureSelection
    {
        public const string NeutralCultureName = "";

        private static readonly object Gate = new();
        private static readonly Dictionary<string, string> SelectedByDesignerPath = new(StringComparer.OrdinalIgnoreCase);

        public static string GetCultureName(string designerFilePath)
        {
            string key = NormalizePath(designerFilePath);
            lock (Gate)
            {
                return SelectedByDesignerPath.TryGetValue(key, out var value) ? value : NeutralCultureName;
            }
        }

        public static bool TrySetCultureName(string designerFilePath, string? cultureName, out string normalized, out string reason)
        {
            if (!TryNormalizeCultureName(cultureName, out normalized, out reason)) return false;
            string key = NormalizePath(designerFilePath);
            lock (Gate)
            {
                if (normalized.Length == 0) SelectedByDesignerPath.Remove(key);
                else SelectedByDesignerPath[key] = normalized;
            }
            return true;
        }

        public static void Clear(string designerFilePath)
        {
            string key = NormalizePath(designerFilePath);
            lock (Gate) SelectedByDesignerPath.Remove(key);
        }

        public static bool TryNormalizeCultureName(string? cultureName, out string normalized, out string reason)
        {
            normalized = NeutralCultureName;
            reason = "";
            string value = (cultureName ?? NeutralCultureName).Trim();
            if (value.Length == 0 || string.Equals(value, "neutral", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            try
            {
                var culture = CultureInfo.GetCultureInfo(value);
                if (culture.Equals(CultureInfo.InvariantCulture))
                {
                    normalized = NeutralCultureName;
                    return true;
                }
                normalized = culture.Name;
                return true;
            }
            catch (CultureNotFoundException)
            {
                reason = "invalid culture name: " + value;
                return false;
            }
        }

        private static string NormalizePath(string designerFilePath)
        {
            try { return Path.GetFullPath(designerFilePath ?? ""); }
            catch { return designerFilePath ?? ""; }
        }
    }
}
