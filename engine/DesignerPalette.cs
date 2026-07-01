using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;

namespace WinFormsDesigner.Engine
{
    /// <summary>One entry of the color dropdown palette: a KnownColor's name plus its opaque RRGGBB hex
    /// (theme-accurate for system colors, since <see cref="Color.FromKnownColor"/> resolves them against the
    /// current Windows theme). The name is what the grid commits as the invariant string — the value
    /// converter turns "Red" → Color.Red and "Control" → SystemColors.Control.</summary>
    public sealed class ColorSwatch
    {
        public string Name { get; init; } = "";
        /// <summary>Opaque swatch color as 6-hex RRGGBB (no leading '#').</summary>
        public string Argb { get; init; } = "";
    }

    /// <summary>A GraphicsUnit member and the EXACT suffix the installed FontConverter emits for it (e.g.
    /// Point → "pt"). Derived by probing (round-tripping a Font of that unit) rather than hardcoded, so it
    /// stays correct across framework versions. The Font editor composes "&lt;name&gt;, &lt;size&gt;&lt;suffix&gt;".</summary>
    public sealed class FontUnitInfo
    {
        public string Name { get; init; } = "";
        public string Suffix { get; init; } = "";
    }

    /// <summary>Static palette data for the property grid's Color dropdown and Font editor. All fields are
    /// pure reflection/GDI (no design graph, no UI-thread affinity), so the RPC runs on the JSON-RPC thread
    /// like ConvertValue — no STA, no Prewarm.</summary>
    public sealed class DesignerPaletteInfo
    {
        /// <summary>Named (non-system) KnownColors — the "Web" palette (Red, CornflowerBlue, …).</summary>
        public List<ColorSwatch> WebColors { get; init; } = new();
        /// <summary>System KnownColors — the "System" palette (Control, Window, Highlight, …).</summary>
        public List<ColorSwatch> SystemColors { get; init; } = new();
        /// <summary>Installed font family names (for the Font editor's Name combobox), sorted, de-duplicated.</summary>
        public List<string> FontFamilies { get; init; } = new();
        /// <summary>GraphicsUnit members constructible for a Font, with their authoritative FontConverter suffix.</summary>
        public List<FontUnitInfo> FontUnits { get; init; } = new();
    }

    /// <summary>
    /// Builds <see cref="DesignerPaletteInfo"/>: the KnownColor palette (split web vs system by
    /// <see cref="Color.IsSystemColor"/>, with theme-accurate ARGB), the installed font families, and the
    /// FontConverter unit suffixes (probed, not hardcoded). Every step is individually guarded so a hostile/
    /// broken GDI environment degrades to empty lists instead of faulting the RPC.
    /// </summary>
    public static class DesignerPalette
    {
        public static DesignerPaletteInfo Build()
        {
            var info = new DesignerPaletteInfo();
            BuildColors(info);
            BuildFontFamilies(info);
            BuildFontUnits(info);
            return info;
        }

        private static void BuildColors(DesignerPaletteInfo info)
        {
            try
            {
                foreach (KnownColor kc in Enum.GetValues<KnownColor>())
                {
                    Color c;
                    try { c = Color.FromKnownColor(kc); }
                    catch { continue; }
                    var sw = new ColorSwatch { Name = kc.ToString(), Argb = (c.ToArgb() & 0xFFFFFF).ToString("X6") };
                    if (c.IsSystemColor) info.SystemColors.Add(sw);
                    else info.WebColors.Add(sw);
                }
            }
            catch { /* leave whatever was collected */ }
        }

        private static void BuildFontFamilies(DesignerPaletteInfo info)
        {
            try
            {
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (FontFamily ff in FontFamily.Families)
                {
                    try { if (!string.IsNullOrEmpty(ff.Name) && seen.Add(ff.Name)) info.FontFamilies.Add(ff.Name); }
                    catch { /* a family whose Name getter throws → skip */ }
                }
                info.FontFamilies.Sort(StringComparer.OrdinalIgnoreCase);
            }
            catch { /* no families available */ }
        }

        private static void BuildFontUnits(DesignerPaletteInfo info)
        {
            try
            {
                var conv = TypeDescriptor.GetConverter(typeof(Font));
                if (conv == null) return;
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (GraphicsUnit gu in Enum.GetValues<GraphicsUnit>())
                {
                    // Some units (e.g. Display) are invalid for Font construction and throw — probe each and
                    // read the suffix the installed FontConverter actually emits, so we never hardcode a
                    // version-sensitive suffix map. A unit that can't build a Font is simply omitted.
                    try
                    {
                        using var probe = new Font(FontFamily.GenericSansSerif, 10f, FontStyle.Regular, gu);
                        string s = conv.ConvertToInvariantString(probe) ?? "";
                        string? suffix = ExtractUnitSuffix(s);
                        if (suffix != null && seen.Add(gu.ToString()))
                            info.FontUnits.Add(new FontUnitInfo { Name = gu.ToString(), Suffix = suffix });
                    }
                    catch { /* unit not constructible for a Font → skip */ }
                }
            }
            catch { /* no unit info */ }
        }

        /// <summary>Pull the trailing unit suffix out of a FontConverter invariant string
        /// "&lt;name&gt;, &lt;size&gt;&lt;suffix&gt;[, style=…]" — the part of the size token after the numeric size.</summary>
        private static string? ExtractUnitSuffix(string invariant)
        {
            int comma = invariant.IndexOf(',');
            if (comma < 0) return null;
            string rest = invariant.Substring(comma + 1);
            int nextComma = rest.IndexOf(',');
            string sizeToken = (nextComma < 0 ? rest : rest.Substring(0, nextComma)).Trim();
            int i = 0;
            while (i < sizeToken.Length && (char.IsDigit(sizeToken[i]) || sizeToken[i] == '.')) i++;
            string suffix = sizeToken.Substring(i).Trim();
            return suffix.Length > 0 ? suffix : null;
        }
    }
}
