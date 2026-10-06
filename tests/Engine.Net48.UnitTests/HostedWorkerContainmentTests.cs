using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Xunit;

namespace Engine.Net48.UnitTests
{
    // Hosted-designer and hosted-service workers are launched by the engine itself. They must be confined to a
    // kill-on-close job the engine owns, whether or not the private render desktop (and its supervisor job) is in use,
    // so a recycled or crashed engine cannot leave one running with the user's assembly loaded.
    public sealed class HostedWorkerContainmentTests
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

        [Fact]
        public void LaunchedWorker_IsConfinedToTheEnginesOwnKillOnCloseJob()
        {
            Type desktop = Net48EngineAssembly().GetType("WinFormsDesigner.Engine.Net48.RenderDesktop", throwOnError: true)!;
            MethodInfo contain = desktop.GetMethod("ContainChildProcess", BindingFlags.Static | BindingFlags.NonPublic)!;
            Assert.False((bool)contain.Invoke(null, new object[] { IntPtr.Zero })!);

            using Process child = Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "ping.exe"),
                Arguments = "-n 30 127.0.0.1",
                UseShellExecute = false,
                CreateNoWindow = true,
            })!;
            try
            {
                Assert.True((bool)contain.Invoke(null, new object[] { child.Handle })!);
                IntPtr job = (IntPtr)desktop.GetField("_childJob", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
                Assert.NotEqual(IntPtr.Zero, job);
                Assert.True(IsProcessInJob(child.Handle, job, out bool inJob));
                Assert.True(inJob);
            }
            finally
            {
                try { child.Kill(); } catch { }
                child.WaitForExit(5_000);
            }
        }

        [Fact]
        public void ServingEngine_WithoutDesktopIsolation_ConfinesItselfBeforeListening()
        {
            var config = typeof(HostedWorkerContainmentTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            string exe = Path.GetFullPath(Path.Combine(RepoRoot(), "engine-net48", "bin", config, "net48", "WinFormsDesigner.Engine.Net48.exe"));
            var start = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = "--pipe wfd-net48-job-test-" + Guid.NewGuid().ToString("N"),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
            };
            start.EnvironmentVariables["WFD_NET48_DESKTOP_ISOLATION"] = "0"; // the case without a supervisor job
            using Process engine = Process.Start(start)!;
            try
            {
                string? line;
                bool confined = false;
                while ((line = engine.StandardError.ReadLine()) != null)
                {
                    if (line == "[engine-net48] processes started by the engine are confined to its lifetime") confined = true;
                    if (line.StartsWith("[engine-net48] listening on pipe: ", StringComparison.Ordinal)) break;
                }
                Assert.True(confined, "the serving engine did not confine itself before listening");
                Assert.True(IsProcessInJob(engine.Handle, IntPtr.Zero, out bool inJob));
                Assert.True(inJob);
            }
            finally
            {
                try { engine.Kill(); } catch { }
                engine.WaitForExit(10_000);
            }
        }

        private static Assembly Net48EngineAssembly()
        {
            var config = typeof(HostedWorkerContainmentTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            string path = Path.GetFullPath(Path.Combine(RepoRoot(), "engine-net48", "bin", config, "net48", "WinFormsDesigner.Engine.Net48.exe"));
            Assert.True(File.Exists(path), "Expected built net48 engine at " + path);
            return Assembly.LoadFrom(path);
        }

        private static string RepoRoot()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                if (Directory.Exists(Path.Combine(dir.FullName, "engine-net48"))) return dir.FullName;
                dir = dir.Parent;
            }
            throw new DirectoryNotFoundException("Could not locate repository root from " + AppContext.BaseDirectory);
        }
    }
}
