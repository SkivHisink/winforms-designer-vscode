using System;
using System.Collections.Generic;
using System.IO;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Owns one child AppDomain per user-project output dir, each hosting a <see cref="RenderWorker"/>. The
    /// child domain's ApplicationBase is the target's bin dir and its ConfigurationFile comes from
    /// <see cref="ChildDomainConfig"/> — the app's own config when it has one, plus the binding redirects the domain
    /// needs so the DevExpress graph resolves as at runtime (a class-library target has no config of its own,
    /// and used to get none at all — see ChildDomainConfig for what that broke). ShadowCopyFiles is intentionally OFF
    /// (see Create — it would break delay-signed vendor assemblies), so the domain loads the user's dll IN PLACE and
    /// PINS it: their own build of that project fails with MSB3027 while a net48 designer is open, until the host
    /// explicitly releases the domain (ReleaseBinDir / ReleaseAll). When the target assembly's mtime changes after a
    /// release + rebuild, the domain is unloaded and recreated so the fresh control renders.
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
        // 1.0.0 — domains that were meant to go away but refused to AppDomain.Unload (a control started a
        // non-cooperative thread). They are no longer serviceable (a newer build replaced them, or a release dropped
        // them from _byBinDir), yet they are STILL ALIVE and STILL PINNING the user's dlls. Forgetting them entirely is
        // the bug: the release command could then report "nothing to release" while the file stayed locked. Instead we
        // remember them here, retry unloading on every ReleaseAll, and count any that remain as `failed` so the host
        // recycles the whole process — the only sure way to free them.
        private readonly List<AppDomain> _leaked = new List<AppDomain>();
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
                    // Rebuilt since last render → must load the fresh output. Drop the stale domain; if it refuses to
                    // unload, remember it in _leaked (still pinning) rather than forgetting it, so a later ReleaseAll
                    // still counts it and the host recycles. (This branch is near-unreachable — a rebuild requires the
                    // handles to have been released first — but must not silently orphan a live domain.)
                    if (!TryUnload(existing.Domain)) _leaked.Add(existing.Domain);
                    _byBinDir.Remove(binDir);
                }

                var entry = Create(full, binDir, mtime, probeDirs);
                _byBinDir[binDir] = entry;
                return entry.Worker;
            }
        }

        /// <summary>
        /// 1.0.0 — release every handle this process holds on <paramref name="assemblyPath"/>'s output directory, by
        /// unloading the child AppDomain that loaded it. Returns a <see cref="ReleaseResult"/> ({Attempted, Released,
        /// Failed}); the DTO (not a bare bool) is what lets the host separate "nothing loaded" from "found but failed".
        ///
        /// This is the ONLY way those handles come back: ShadowCopyFiles is off by necessity (see Create), so the
        /// domain loads the user's dlls in place and pins them. Until this existed, a net48 designer made the user's
        /// own project unbuildable for the lifetime of the extension host — MSBuild couldn't overwrite the pinned dll,
        /// so it failed with MSB3027, and GetWorker's mtime-reload could never fire because the mtime could never
        /// change. Every "rebuild to refresh the preview" instruction in the product depended on this.
        ///
        /// Idempotent and safe to call for an unknown path: an absent entry is simply "nothing to release" (Attempted 0).
        /// After this, the NEXT GetWorker rebuilds the domain from whatever is on disk — which is exactly the reload
        /// the mtime check was supposed to provide, now driven by the host instead of by a timestamp it never saw.
        /// </summary>
        public ReleaseResult ReleaseBinDir(string assemblyPath)
        {
            string binDir;
            // A DTO, not a bool, so the host can tell "nothing was loaded" (Attempted==0) from "found it but the unload
            // FAILED and it still pins the dll" (Failed>0) — the two used to both read as false and be logged as
            // "nothing loaded". The host recycles the process when Failed>0.
            try { binDir = Path.GetDirectoryName(Path.GetFullPath(assemblyPath))!; }
            catch { return new ReleaseResult { Attempted = 0, Released = 0, Failed = 0 }; } // unparseable → nothing
            lock (_lock)
            {
                if (!_byBinDir.TryGetValue(binDir, out var existing)) return new ReleaseResult { Attempted = 0, Released = 0, Failed = 0 };
                // Remove FIRST — once an unload has been ATTEMPTED, that AppDomain must NEVER be handed back as a
                // serviceable worker: Unload aborts the domain's threads, so even a "failed" unload can have killed its
                // STA and left the worker proxy hanging on the next call. On failure it is still alive and
                // still pinning the dll, so it goes into _leaked (quarantined, retried by ReleaseAll, never reused).
                _byBinDir.Remove(binDir);
                if (TryUnload(existing.Domain)) return new ReleaseResult { Attempted = 1, Released = 1, Failed = 0 };
                _leaked.Add(existing.Domain);
                return new ReleaseResult { Attempted = 1, Released = 0, Failed = 1 }; // still pinning → host recycles
            }
        }

        /// <summary>
        /// 1.0.0 — release EVERY loaded output directory. Returns a <see cref="ReleaseResult"/> ({Attempted, Released,
        /// Failed}); Failed &gt; 0 means a domain refused to unload and still pins its dll (the host then recycles).
        ///
        /// The host cannot enumerate this reliably: it derives release targets from the assembly each open session is
        /// CURRENTLY routed to, but a session that switched control source (or moved net48 → modern) silently forgets
        /// the directory it previously pinned, and no session then names it. That output stayed locked until the
        /// engine process exited, which is exactly the blocker the release work exists to remove. The engine
        /// is the only component that knows what it actually loaded, so the project-wide "release for rebuild"
        /// command asks it, rather than reconstructing the set from host state.
        ///
        /// Only counts domains that really unloaded (see TryUnload), so a caller can trust the number.
        /// </summary>
        public ReleaseResult ReleaseAll()
        {
            lock (_lock)
            {
                var entries = new List<KeyValuePair<string, Entry>>(_byBinDir);
                _byBinDir.Clear(); // every attempted domain leaves the serviceable cache — a failed one is quarantined
                var preLeaked = new List<AppDomain>(_leaked); // previously-failed domains, retried below
                _leaked.Clear();                              // rebuilt from THIS call's survivors only
                int attempted = entries.Count + preLeaked.Count, released = 0;
                // Each attempted domain ends up either released OR back in _leaked — exactly once — so the invariant
                // `released + Failed == Attempted` holds and a just-failed domain is not double-counted by an immediate
                // retry. A domain whose threads were aborted by the unload attempt must never
                // be reused, hence the quarantine rather than a re-add to _byBinDir.
                foreach (var kv in entries)
                {
                    if (TryUnload(kv.Value.Domain)) released++;
                    else _leaked.Add(kv.Value.Domain);
                }
                // Pre-existing leaked domains get one more try — a non-cooperative thread may have finished since.
                foreach (var d in preLeaked)
                {
                    if (TryUnload(d)) released++;
                    else _leaked.Add(d);
                }
                return new ReleaseResult { Attempted = attempted, Released = released, Failed = _leaked.Count };
            }
        }

        private static Entry Create(string assemblyFull, string binDir, long mtime, string[] probeDirs)
        {
            var setup = new AppDomainSetup
            {
                ApplicationBase = binDir,
                // NOTE: ShadowCopyFiles is intentionally OFF. Enabling it relocates assemblies to a temp shadow
                // dir, which drops the .NET Framework full-trust strong-name BYPASS for delay-signed assemblies
                // (vendor control graphs are commonly delay-signed) → FileLoadException 0x80131045. Loading
                // straight from the (full-trust) ApplicationBase keeps the bypass.
                //
                // Trade-off, stated correctly since 1.0.0: this domain HOLDS the output dlls open for as long as it
                // lives. The old note here claimed "a rebuild only briefly contends" and deferred the question with
                // "revisit if builds report locks" — builds do report locks. MSBuild cannot overwrite a loaded dll at
                // all, so it fails outright (MSB3027 "The file is locked by: WinFormsDesigner.Engine.Net48"), and the
                // mtime-reload in GetWorker can never fire because the mtime it waits for can never change. Releasing
                // the handles therefore cannot be automatic — it needs an explicit unload, which is what
                // ReleaseBinDir exists for; the host calls it when the last session using this output closes, and the
                // "release for rebuild" command calls it on demand.
            };
            // The user's own config (when they have one) PLUS synthesized binding redirects for their bin dir. Without
            // this a class-library target got NO config at all — nothing then unified our worker's dependency graph
            // with the user's, and a strong-named assembly both sides use at different versions (System.Memory) failed
            // to bind, killing the control's constructor. See ChildDomainConfig. Null → run without one, as before.
            string? cfg = ChildDomainConfig.Build(assemblyFull, binDir);
            if (cfg != null) setup.ConfigurationFile = cfg;

            var domain = AppDomain.CreateDomain("winforms-net48-render:" + binDir, null, setup);
            // Load OUR worker assembly into the child domain by PATH (it lives outside ApplicationBase).
            var worker = (RenderWorker)domain.CreateInstanceFromAndUnwrap(
                typeof(RenderWorker).Assembly.Location, typeof(RenderWorker).FullName);
            worker.Init(probeDirs ?? Array.Empty<string>());
            return new Entry { Domain = domain, Worker = worker, AsmMtimeTicks = mtime };
        }

        /// <summary>Unload a child domain. Returns FALSE if it could not be unloaded — the domain then leaks, and
        /// (crucially for ReleaseBinDir) it still holds the user's dlls open, so a caller must not report success.</summary>
        private static bool TryUnload(AppDomain domain)
        {
            // If a control started non-cooperative threads, Unload can throw CannotUnloadAppDomainException.
            // Best-effort: leak the old domain (process recycle is the backstop) rather than crash the engine.
            try { AppDomain.Unload(domain); return true; } catch { return false; /* backstop: process recycle */ }
        }
    }
}
