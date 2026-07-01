using System;
using System.Collections.Generic;
using System.IO;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Owns one child AppDomain per user-project output dir, each hosting a <see cref="RenderWorker"/>. The
    /// child domain's ApplicationBase is the target's bin dir and its ConfigurationFile is the app's own
    /// .exe.config, so the DevExpress/PGMUI graph + binding redirects resolve as at runtime; ShadowCopyFiles
    /// lets the user rebuild the project while we hold copies (no file-lock on their build). When the target
    /// assembly's mtime changes (a rebuild), the domain is unloaded and recreated so the fresh control renders.
    /// </summary>
    public sealed class DomainManager
    {
        private sealed class Entry
        {
            public AppDomain Domain = default!;
            public RenderWorker Worker = default!;
            public long AsmMtimeTicks;
        }

        private readonly Dictionary<string, Entry> _byBinDir = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        private readonly object _lock = new object();

        public RenderWorker GetWorker(string assemblyPath, string[] probeDirs)
        {
            string full = Path.GetFullPath(assemblyPath);
            string binDir = Path.GetDirectoryName(full)!;
            long mtime = File.GetLastWriteTimeUtc(full).Ticks;

            lock (_lock)
            {
                if (_byBinDir.TryGetValue(binDir, out var existing))
                {
                    if (existing.AsmMtimeTicks == mtime) return existing.Worker;
                    // rebuilt since last render → drop the stale domain and load the fresh output
                    TryUnload(existing.Domain);
                    _byBinDir.Remove(binDir);
                }

                var entry = Create(full, binDir, mtime, probeDirs);
                _byBinDir[binDir] = entry;
                return entry.Worker;
            }
        }

        private static Entry Create(string assemblyFull, string binDir, long mtime, string[] probeDirs)
        {
            var setup = new AppDomainSetup
            {
                ApplicationBase = binDir,
                // NOTE: ShadowCopyFiles is intentionally OFF. Enabling it relocates assemblies to a temp shadow
                // dir, which drops the .NET Framework full-trust strong-name BYPASS for delay-signed assemblies
                // (the PetroGM/PGMUI graph is delay-signed) → FileLoadException 0x80131045. Loading straight from
                // the (full-trust) ApplicationBase keeps the bypass. Trade-off: we hold read handles on the
                // output dlls; we reload on mtime change, so a rebuild only briefly contends. Revisit if builds
                // report locks.
            };
            string cfg = assemblyFull + ".config";
            if (File.Exists(cfg)) setup.ConfigurationFile = cfg;

            var domain = AppDomain.CreateDomain("winforms-net48-render:" + binDir, null, setup);
            // Load OUR worker assembly into the child domain by PATH (it lives outside ApplicationBase).
            var worker = (RenderWorker)domain.CreateInstanceFromAndUnwrap(
                typeof(RenderWorker).Assembly.Location, typeof(RenderWorker).FullName);
            worker.Init(probeDirs ?? Array.Empty<string>());
            return new Entry { Domain = domain, Worker = worker, AsmMtimeTicks = mtime };
        }

        private static void TryUnload(AppDomain domain)
        {
            // If a control started non-cooperative threads, Unload can throw CannotUnloadAppDomainException.
            // Best-effort: leak the old domain (process recycle is the backstop) rather than crash the engine.
            try { AppDomain.Unload(domain); } catch { /* backstop: process recycle */ }
        }
    }
}
