using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Builds the child render domain's ConfigurationFile: the user's own app config when there is one, PLUS the
    /// binding redirects that domain needs to bind at all.
    ///
    /// Why this exists. The child domain's ApplicationBase is the user's bin dir, but WE also load our worker
    /// assembly into it (by path), which drags OUR dependency graph in. When the two graphs disagree about a
    /// strong-named assembly's version, the bind fails outright — a strong name is matched exactly, so probing finds
    /// the user's copy, rejects it, and the control's constructor dies with
    ///   FileLoadException: ... 'System.Memory, Version=4.0.1.2' ... manifest definition does not match the reference
    /// even though the user's project is perfectly self-consistent (measured on a real project: 15 of their
    /// assemblies want System.Memory 4.0.1.1 and 4.0.1.1 is what they ship; 13 of OURS want 4.0.1.2). An app never
    /// hits this because its .exe.config carries redirects — but a class LIBRARY has no config, so the domain we
    /// build for it had none either, and nothing unified the versions.
    ///
    /// The redirects are synthesized MSBuild-auto-redirect style, from the assemblies actually present in the user's
    /// bin dir: every request for that identity binds to the version the project really built against. Unifying on
    /// the USER's version (not ours) is the point — this domain exists to reproduce THEIR runtime.
    ///
    /// Deliberately unbounded oldVersion. MSBuild emits 0.0.0.0-&lt;that version&gt;, which would leave a request for a
    /// HIGHER version (our 4.0.1.2) outside the range and still failing; the whole bug is a higher request needing to
    /// come down.
    ///
    /// Never overrides the user: an identity their config already declares is left exactly as they wrote it, and any
    /// failure here falls back to today's behaviour (their config, or none) rather than guessing.
    /// </summary>
    internal static class ChildDomainConfig
    {
        private static readonly XNamespace Asm = "urn:schemas-microsoft-com:asm.v1";

        /// <summary>Path to the config the child domain should use, or null to run without one (today's behaviour).</summary>
        public static string? Build(string assemblyFull, string binDir)
        {
            string? userCfg = UserConfigFor(assemblyFull, binDir);
            try
            {
                XDocument doc = userCfg != null ? XDocument.Load(userCfg) : new XDocument(new XElement("configuration"));
                XElement root = doc.Root ?? new XElement("configuration");
                if (doc.Root == null) doc.Add(root);

                XElement runtime = root.Element("runtime") ?? Added(root, new XElement("runtime"));
                XElement binding = FirstAssemblyBinding(runtime) ?? Added(runtime, new XElement(Asm + "assemblyBinding"));

                // Identities the user already pinned — theirs wins, we never restate or contradict it.
                var declared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var dep in binding.Elements(Asm + "dependentAssembly"))
                {
                    string? n = (string?)dep.Element(Asm + "assemblyIdentity")?.Attribute("name");
                    if (!string.IsNullOrEmpty(n)) declared.Add(n!);
                }

                int added = 0;
                foreach (var (name, token, culture, version) in StrongNamedIn(binDir))
                {
                    if (!declared.Add(name)) continue;   // user declared it (or a duplicate on disk) → leave alone
                    binding.Add(new XElement(Asm + "dependentAssembly",
                        new XElement(Asm + "assemblyIdentity",
                            new XAttribute("name", name),
                            new XAttribute("publicKeyToken", token),
                            new XAttribute("culture", culture)),
                        new XElement(Asm + "bindingRedirect",
                            new XAttribute("oldVersion", "0.0.0.0-65535.65535.65535.65535"),
                            new XAttribute("newVersion", version))));
                    added++;
                }
                if (added == 0 && userCfg != null) return userCfg;   // nothing to add → use theirs untouched

                string outPath = TempConfigPath(binDir);
                Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
                doc.Save(outPath);
                return outPath;
            }
            catch
            {
                // An unreadable/!well-formed user config, a locked temp dir, anything: fall back to exactly what this
                // code did before. Worst case the render fails the way it does today — with an honest message.
                return userCfg;
            }
        }

        /// <summary>The user's own config: the assembly's .config (an .exe.config for an app), else a sibling
        /// *.exe.config in the same output dir (a library built next to its host app).</summary>
        private static string? UserConfigFor(string assemblyFull, string binDir)
        {
            string own = assemblyFull + ".config";
            if (File.Exists(own)) return own;
            try
            {
                string[] hits = Directory.GetFiles(binDir, "*.exe.config");
                if (hits.Length == 1) return hits[0];   // exactly one host app → unambiguous; 0 or 2+ → don't guess
            }
            catch { }
            return null;
        }

        private static IEnumerable<(string Name, string Token, string Culture, string Version)> StrongNamedIn(string binDir)
        {
            string[] files;
            try { files = Directory.GetFiles(binDir, "*.dll"); }
            catch { yield break; }
            foreach (string f in files)
            {
                AssemblyName an;
                try { an = AssemblyName.GetAssemblyName(f); }
                catch { continue; }                       // native dll / not an assembly → skip
                byte[]? pk = an.GetPublicKeyToken();
                if (pk == null || pk.Length == 0) continue; // unsigned: the CLR does not enforce its version anyway
                var tok = new StringBuilder(pk.Length * 2);
                foreach (byte b in pk) tok.Append(b.ToString("x2"));
                string culture = string.IsNullOrEmpty(an.CultureName) ? "neutral" : an.CultureName!;
                yield return (an.Name!, tok.ToString(), culture, an.Version!.ToString());
            }
        }

        private static XElement? FirstAssemblyBinding(XElement runtime)
        {
            foreach (var e in runtime.Elements(Asm + "assemblyBinding")) return e;
            return null;
        }

        private static XElement Added(XElement parent, XElement child) { parent.Add(child); return child; }

        /// <summary>One stable file per bin dir (hashed — the path is long and may contain anything), rewritten each
        /// time the domain is created, so repeated renders don't litter temp.</summary>
        private static string TempConfigPath(string binDir)
        {
            using (var md5 = MD5.Create())
            {
                byte[] h = md5.ComputeHash(Encoding.UTF8.GetBytes(binDir.ToLowerInvariant()));
                var sb = new StringBuilder(h.Length * 2);
                foreach (byte b in h) sb.Append(b.ToString("x2"));
                return Path.Combine(Path.GetTempPath(), "winforms-designer-net48", sb + ".config");
            }
        }
    }
}
