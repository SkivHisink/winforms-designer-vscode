using System;
using System.Collections.Concurrent;

namespace WinFormsDesigner.Engine
{
    /// <summary>A rejected command-line switch is an SDK capability, not a transient project evaluation failure.</summary>
    internal sealed class UnsupportedMSBuildCache
    {
        private sealed record Entry(string Version, long CheckedAt);
        private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.OrdinalIgnoreCase);
        private readonly long versionProbeInterval = TimeSpan.FromSeconds(10).Ticks;

        internal bool Remember(string project, string? sdkVersion, long now)
        {
            if (string.IsNullOrWhiteSpace(sdkVersion)) return false;
            bool changed = !entries.TryGetValue(project, out var prior) || prior.Version != sdkVersion;
            entries[project] = new Entry(sdkVersion, now);
            return changed;
        }

        internal bool ShouldSkip(string project, long now, Func<string?> selectedSdkVersion)
        {
            if (!entries.TryGetValue(project, out var prior)) return false;
            if (now - prior.CheckedAt < versionProbeInterval) return true;
            string? current = selectedSdkVersion();
            // An unreadable SDK cannot establish that the unsupported capability changed. Keep the fallback.
            if (current == null || current == prior.Version)
            {
                entries[project] = prior with { CheckedAt = now };
                return true;
            }
            entries.TryRemove(project, out _);
            return false;
        }
    }
}
