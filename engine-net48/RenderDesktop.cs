using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Keeps the preview's windows OFF the user's screen by running this whole engine process on a private Windows
    /// desktop — one that exists but is never displayed.
    ///
    /// Why it is needed. This engine renders a REAL compiled instance, so realizing a form calls <c>Form.Show()</c>,
    /// which runs the user's own <c>Load</c>/<c>Shown</c> code and the vendor's. That code legitimately opens windows:
    /// a splash screen, a docking panel, a "please wait" dialog, a message box. None of them know they are being
    /// rendered and none respect the off-screen placement we apply to the root. Measured on a fixture that maximizes
    /// itself and opens one window from <c>Load</c>: BOTH appeared on the interactive desktop.
    ///
    /// Why the whole PROCESS and not just the render thread. A window belongs to the desktop of the thread that
    /// created it, and a thread's desktop is assigned when the PROCESS is created — a new thread inherits the
    /// process's desktop, never its creator's (measured). SetThreadDesktop can move a thread, but only while that
    /// thread owns no window — and an STA thread already owns COM's hidden OLE window by the time any of our code
    /// runs, so it is refused with ERROR_BUSY (measured in this engine: it succeeds on an MTA thread and fails on the
    /// STA render thread). WinForms requires STA, so the thread cannot be the unit of isolation. The process can:
    /// CreateProcess takes the desktop in STARTUPINFO.
    ///
    /// So the engine re-launches ITSELF once, on a desktop it creates, and the first instance stays as a thin
    /// supervisor: it inherits nothing but its standard handles to the child (so the host keeps reading the engine's
    /// log), waits for it, and exits with its code — the host's "is the engine alive / kill it" model is unchanged.
    /// The child is held in a Job Object with KILL_ON_JOB_CLOSE, so killing the supervisor (engine recycle, window
    /// close, a crash) takes the child with it and can never leave a process behind still pinning the user's dlls.
    ///
    /// Rendering is unaffected: DrawToBitmap is a WM_PRINT into a GDI surface, and a themed form drawn on the private
    /// desktop produces a byte-identical PNG to the same form drawn on the interactive one (measured).
    ///
    /// Entirely best-effort: if the desktop cannot be created or the relaunch fails, this instance simply carries on
    /// as the engine, exactly as before the isolation existed, and says so in the log.
    /// </summary>
    internal static class RenderDesktop
    {
        /// <summary>Set on the relaunched child so it knows not to relaunch again.</summary>
        private const string ChildMarker = "WFD_NET48_RENDER_DESKTOP";
        /// <summary>Escape hatch: set to 0/false to run the engine on the interactive desktop (previews then behave
        /// as they did before — a form's own design-time windows become visible).</summary>
        private const string DisableVar = "WFD_NET48_DESKTOP_ISOLATION";

        private const int STARTF_USESTDHANDLES = 0x00000100;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint DESKTOP_ALL = 0x000F01FF;
        private const int UOI_NAME = 2;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int STD_INPUT = -10, STD_OUTPUT = -11, STD_ERROR = -12;
        private const int HANDLE_FLAG_INHERIT = 1;
        private const uint INFINITE = 0xFFFFFFFF;
        private const uint WAIT_FAILED = 0xFFFFFFFF;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateDesktop(string desktop, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetThreadDesktop(int threadId);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool GetUserObjectInformationW(IntPtr handle, int index, [Out] StringBuilder info, int length, out int needed);

        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindowsProc callback, IntPtr param);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

        private const uint WM_CLOSE = 0x0010;

        [DllImport("kernel32.dll")]
        private static extern int GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool EnumThreadWindows(int threadId, EnumWindowsProc callback, IntPtr param);

        /// <summary>Id of the thread whose windows the stray-window diagnostics look at — the render thread, captured
        /// by the caller because the rescue timer runs elsewhere (on a pool thread, while the render thread is stuck).</summary>
        public static int CurrentThreadId() => GetCurrentThreadId();

        // lpCommandLine is documented as an IN/OUT buffer that CreateProcess MAY MODIFY IN PLACE — passing a managed
        // string would hand it (a possibly interned) read-only buffer to be written through. StringBuilder marshals a
        // writable copy, which is the supported way to call this.
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
            IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
            ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetHandleInformation(IntPtr handle, out int flags);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        /// <summary>
        /// Run this engine on a private desktop by relaunching itself there ONCE.
        ///
        /// Returns the exit code to end THIS process with when it acted as the supervisor (the real engine is then the
        /// child), or null when this process should go on and be the engine — because it already is the child, because
        /// the isolation is switched off, or because anything about the relaunch failed. Never throws.
        /// </summary>
        public static int? RelaunchOnPrivateDesktop(string[] args)
        {
            try
            {
                // Already the isolated child? Only if the marker names the desktop we are ACTUALLY on. A marker alone
                // is not proof: it is an inherited environment variable, and a stale one (an earlier engine's, a shell
                // that exported it) would make this process claim isolation while rendering on the visible desktop —
                // the one failure mode that must never be reported as success.
                string marker = Environment.GetEnvironmentVariable(ChildMarker);
                if (!string.IsNullOrEmpty(marker))
                {
                    if (string.Equals(CurrentDesktopName(), marker, StringComparison.OrdinalIgnoreCase)) return null;
                    Console.Error.WriteLine("[engine:net48] render desktop: ignoring a stale " + ChildMarker
                        + " ('" + marker + "') — this process is on '" + CurrentDesktopName() + "'");
                    Environment.SetEnvironmentVariable(ChildMarker, null);
                }
                string disable = Environment.GetEnvironmentVariable(DisableVar);
                if (disable == "0" || string.Equals(disable, "false", StringComparison.OrdinalIgnoreCase))
                {
                    Console.Error.WriteLine("[engine:net48] render desktop: disabled by " + DisableVar
                        + " — a preview's own design-time windows will be visible");
                    return null;
                }

                string exe = System.Reflection.Assembly.GetEntryAssembly()?.Location;
                if (string.IsNullOrEmpty(exe) || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                {
                    Console.Error.WriteLine("[engine:net48] render desktop: skipped (no relaunchable entry assembly)");
                    return null; // hosted oddly (a test host) — carry on as the engine
                }

                string desktopName = "WinFormsDesignerRender-" + System.Diagnostics.Process.GetCurrentProcess().Id;
                IntPtr desktop = CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_ALL, IntPtr.Zero);
                if (desktop == IntPtr.Zero)
                {
                    Console.Error.WriteLine("[engine:net48] render desktop: CreateDesktop failed (win32 "
                        + Marshal.GetLastWin32Error() + ") — previews will realize on the interactive desktop");
                    return null;
                }

                Environment.SetEnvironmentVariable(ChildMarker, desktopName); // inherited by the child
                // The host reads the engine's log from these handles, so the child must write to the very same pipes.
                // They are marked inheritable only across the CreateProcess call and put back afterwards: with
                // bInheritHandles every inheritable handle travels, and leaving them so would hand this engine's log
                // pipes to whatever a design-time constructor decides to launch.
                IntPtr stdIn = GetStdHandle(STD_INPUT), stdOut = GetStdHandle(STD_OUTPUT), stdErr = GetStdHandle(STD_ERROR);
                int flagsIn = MarkInheritable(stdIn), flagsOut = MarkInheritable(stdOut), flagsErr = MarkInheritable(stdErr);
                var si = new STARTUPINFO
                {
                    cb = Marshal.SizeOf(typeof(STARTUPINFO)),
                    lpDesktop = "WinSta0\\" + desktopName,
                    dwFlags = STARTF_USESTDHANDLES,
                    hStdInput = stdIn,
                    hStdOutput = stdOut,
                    hStdError = stdErr,
                };

                PROCESS_INFORMATION pi;
                var commandLine = new StringBuilder(Quote(exe) + JoinArgs(args));
                bool created = CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref si, out pi);
                int createError = Marshal.GetLastWin32Error();
                RestoreHandleFlags(stdIn, flagsIn);
                RestoreHandleFlags(stdOut, flagsOut);
                RestoreHandleFlags(stdErr, flagsErr);
                if (!created)
                {
                    Console.Error.WriteLine("[engine:net48] render desktop: relaunch failed (win32 " + createError
                        + ") — previews will realize on the interactive desktop");
                    Environment.SetEnvironmentVariable(ChildMarker, null);
                    CloseDesktop(desktop); // this process stays the engine; the desktop it would have used is not needed
                    return null;
                }

                // Kill-on-close job: whatever ends this supervisor — the host's recycle, a window closing, a crash —
                // must take the real engine with it. A survivor would keep the user's dlls pinned with nobody left to
                // ask for them back, which is exactly the failure this product spent a release removing. So if the job
                // cannot be set up, the isolation is ABANDONED rather than risked: kill the child we just created and
                // carry on as the engine ourselves, on the interactive desktop.
                if (!ConfineToJob(pi.hProcess))
                {
                    Console.Error.WriteLine("[engine:net48] render desktop: could not confine the isolated engine to a job (win32 "
                        + Marshal.GetLastWin32Error() + ") — running on the interactive desktop instead");
                    TerminateProcess(pi.hProcess, 0);
                    CloseHandle(pi.hThread);
                    CloseHandle(pi.hProcess);
                    Environment.SetEnvironmentVariable(ChildMarker, null);
                    CloseDesktop(desktop);
                    return null;
                }

                if (ResumeThread(pi.hThread) == uint.MaxValue)
                {
                    // The child exists but will never run. Kill it rather than waiting forever on a suspended process.
                    Console.Error.WriteLine("[engine:net48] render desktop: could not resume the isolated engine (win32 "
                        + Marshal.GetLastWin32Error() + ")");
                    TerminateProcess(pi.hProcess, 1);
                    CloseHandle(pi.hThread);
                    CloseHandle(pi.hProcess);
                    return 1; // a failure the host sees as an engine that would not start, not a silent success
                }
                CloseHandle(pi.hThread);
                if (WaitForSingleObject(pi.hProcess, INFINITE) == WAIT_FAILED)
                {
                    Console.Error.WriteLine("[engine:net48] render desktop: lost track of the isolated engine (win32 "
                        + Marshal.GetLastWin32Error() + ")");
                    TerminateProcess(pi.hProcess, 1); // never leave it running behind a supervisor that stopped waiting
                    CloseHandle(pi.hProcess);
                    return 1;
                }
                uint code;
                // A failed GetExitCodeProcess must NOT be reported as exit 0: the host reads a zero exit as a clean
                // stop and would not treat it as a crash to recover from.
                if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
                CloseHandle(pi.hProcess);
                // The job handle is deliberately left open for the whole wait — closing it is what kills the child —
                // and then simply released with the process.
                return (int)code;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[engine:net48] render desktop: unavailable (" + ex.GetType().Name + ": "
                    + ex.Message + ") — previews will realize on the interactive desktop");
                return null;
            }
        }

        /// <summary>Put the isolated engine in a kill-on-close job owned by this supervisor, so it can never outlive
        /// it. The job handle is intentionally NOT closed here — it must stay open for the supervisor's whole life;
        /// the OS releases it (and kills the child) when this process ends, however it ends.</summary>
        private static bool ConfineToJob(IntPtr child)
        {
            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return false;
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, size)) { CloseHandle(job); return false; }
                // Nested jobs are supported since Windows 8, so being inside the host's own job is not a blocker; a
                // refusal here is real and must not be papered over (the child would survive us).
                if (!AssignProcessToJobObject(job, child)) { CloseHandle(job); return false; }
                _job = job; // keep the handle alive for the process lifetime
                return true;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        /// <summary>Held open on purpose: closing it kills the isolated engine.</summary>
        private static IntPtr _job = IntPtr.Zero;

        /// <summary>Mark a standard handle inheritable for one CreateProcess call; returns its previous flags (or -1
        /// when there is nothing to restore) for <see cref="RestoreHandleFlags"/>.</summary>
        private static int MarkInheritable(IntPtr handle)
        {
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return -1;
            int previous;
            if (!GetHandleInformation(handle, out previous)) previous = -1;
            return SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ? previous : -1;
        }

        private static void RestoreHandleFlags(IntPtr handle, int previous)
        {
            if (previous < 0 || handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, previous & HANDLE_FLAG_INHERIT);
        }

        /// <summary>
        /// Quote one argument the way CommandLineToArgvW parses it — the parser the child's own startup uses.
        /// Backslashes are only special before a quote, and a RUN of them before the closing quote must be doubled;
        /// plain escaping of quotes alone corrupts any argument ending in a backslash (a directory path with a
        /// trailing separator, e.g. `--probe C:\Vendor\`), which then reaches the child as a stray quote.
        /// </summary>
        private static string Quote(string value)
        {
            var sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in value ?? "")
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1).Append('"'); // escape the run AND the quote itself
                }
                else
                {
                    sb.Append('\\', backslashes).Append(c);
                }
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2); // trailing run precedes the closing quote → double it
            return sb.Append('"').ToString();
        }

        private static string JoinArgs(string[] args)
        {
            if (args == null || args.Length == 0) return "";
            var sb = new StringBuilder();
            foreach (string arg in args) sb.Append(' ').Append(Quote(arg ?? ""));
            return sb.ToString();
        }

        /// <summary>One line for the engine log: which desktop this process's windows land on.</summary>
        public static string Describe()
        {
            string name = CurrentDesktopName();
            return IsIsolated
                ? "render desktop: active ('" + name + "') — preview windows cannot reach the screen"
                : "render desktop: NOT isolated (desktop '" + name + "') — a preview's own design-time windows will be visible";
        }

        /// <summary>Whether this process really is running on its private render desktop — asserted against the
        /// desktop it is ON, never against the marker alone (which is only an inherited environment variable).</summary>
        public static bool IsIsolated
        {
            get
            {
                string marker = Environment.GetEnvironmentVariable(ChildMarker);
                return !string.IsNullOrEmpty(marker)
                    && string.Equals(CurrentDesktopName(), marker, StringComparison.OrdinalIgnoreCase);
            }
        }

        /// <summary>
        /// Rescue a render thread a form's own design-time code has blocked, by asking the windows it opened to close.
        ///
        /// Realizing a compiled form runs its <c>Load</c>/<c>Shown</c> code, and a MODAL window opened there (a message
        /// box, a licence nag, a vendor dialog) blocks inside <c>Show()</c> forever. Before the isolation the user
        /// could at least see it and close it; on a desktop that is never displayed nobody can, so the engine would be
        /// wedged until it is recycled — and would wedge again on the next render. Only reached on that timeout, and
        /// it never touches a window this engine hosts (<paramref name="ours"/>).
        ///
        /// Returns the titles it asked to close, for the log.
        /// </summary>
        public static List<string> CloseStrayWindows(ICollection<IntPtr> ours, int renderThreadId)
        {
            var closed = new List<string>();
            try
            {
                var targets = new List<IntPtr>();
                var titles = new List<string>();
                EnumThreadWindows(renderThreadId, (hwnd, _) =>
                {
                    if (ours != null && ours.Contains(hwnd)) return true;
                    if (!IsWindowVisible(hwnd)) return true;
                    var text = new StringBuilder(256);
                    GetWindowTextW(hwnd, text, text.Capacity);
                    targets.Add(hwnd);
                    titles.Add(text.ToString());
                    return true;
                }, IntPtr.Zero);
                for (int i = 0; i < targets.Count; i++)
                {
                    // POSTed, never sent: the thread we are trying to free is the one that would have to process a
                    // send, so a blocking SendMessage from here would deadlock instead of rescuing it.
                    if (PostMessageW(targets[i], WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) closed.Add(titles[i]);
                }
            }
            catch { /* a rescue that fails leaves exactly the state it found */ }
            return closed;
        }

        /// <summary>Whether a handle still names a live window — lets a caller drop dead entries from a set of known
        /// windows before a recycled handle can make it lie.</summary>
        public static bool IsWindowAlive(IntPtr hwnd)
        {
            try { return hwnd != IntPtr.Zero && IsWindow(hwnd); } catch { return false; }
        }

        /// <summary>Name of the desktop the calling thread is on ("Default" is the interactive one).</summary>
        public static string CurrentDesktopName()
        {
            try
            {
                var name = new StringBuilder(256);
                int needed;
                return GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, name, name.Capacity * 2, out needed)
                    ? name.ToString()
                    : "(unknown)";
            }
            catch { return "(unknown)"; }
        }

        /// <summary>Titles of the visible top-level windows on this process's desktop — everything a form's own
        /// design-time code opened while it was realized. Diagnostics only: those windows never reach the screen when
        /// the isolation is active, so the log is the only place they can be seen, and a modal one among them is
        /// exactly why a render would appear to hang.</summary>
        public static List<string> StrayWindows(ICollection<IntPtr> ours, int renderThreadId)
        {
            var titles = new List<string>();
            try
            {
                // Windows OF THE RENDER THREAD, not of the whole desktop. The desktop also carries the previews of
                // earlier child AppDomains, whose window registry died with them (statics are per-AppDomain), and
                // reporting those as "this form opened them" is exactly the lie this filter exists to avoid. A window
                // the form's own code opens is created on this very thread, so nothing real is missed.
                EnumThreadWindows(renderThreadId, (hwnd, _) =>
                {
                    // The previews WE host are on this thread too (one per cached live design) — reporting those as
                    // "the form opened them" would be a lie that grows with every form the session has opened.
                    if (ours != null && ours.Contains(hwnd)) return true;
                    if (!IsWindowVisible(hwnd)) return true;
                    var text = new StringBuilder(256);
                    GetWindowTextW(hwnd, text, text.Capacity);
                    string title = text.ToString();
                    if (title.Length > 0) titles.Add(title);
                    return true;
                }, IntPtr.Zero);
            }
            catch { /* diagnostics only — never let this affect a render */ }
            return titles;
        }
    }
}
