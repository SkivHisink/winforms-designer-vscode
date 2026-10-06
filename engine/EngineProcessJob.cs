using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Ties every process the engine starts — the MSBuild evaluation, the UITypeEditor worker and anything design-time
    /// code launches — to the engine's own lifetime. The serving engine puts itself in a kill-on-close job whose only
    /// handle it holds; children inherit the job, so a recycled, crashed or killed engine cannot leave one running with
    /// the user's project or assemblies open. Windows does not end child processes with their parent on its own.
    ///
    /// When confinement fails, the serving engine refuses to serve (fail closed), and helpers are never started by an
    /// unconfined serving engine; the command-line modes, which are not owned by the extension, are unaffected.
    /// </summary>
    internal static class EngineProcessJob
    {
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static readonly object Gate = new();
        private static IntPtr _job = IntPtr.Zero; // held for the process lifetime: closing it ends every helper
        private static bool _serving;

        /// <summary>True when the engine is serving the extension and its helpers are confined to its lifetime.</summary>
        internal static bool Confined { get; private set; }

        /// <summary>Whether a helper process may be started now: always in the command-line modes, and in the serving
        /// engine only once confinement succeeded.</summary>
        internal static bool HelpersAllowed => !_serving || Confined;

        /// <summary>Called once when the engine starts serving. Returns whether confinement was established.</summary>
        internal static bool ConfineServingEngine()
        {
            lock (Gate)
            {
                _serving = true;
                if (Confined) return true;
                if (!OperatingSystem.IsWindows()) return false;
                IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return false;
                var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                int size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(limits, buffer, false);
                    // Nested jobs are supported since Windows 8, so a host job above us does not prevent this.
                    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, size)
                        || !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
                    {
                        CloseHandle(job);
                        return false;
                    }
                }
                finally { Marshal.FreeHGlobal(buffer); }
                _job = job;
                Confined = true;
                return true;
            }
        }
    }
}
