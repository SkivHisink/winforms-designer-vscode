using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Windows.Forms.Design;
using Newtonsoft.Json;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Product boundary for third-party ComponentDesigner activation. The JSON-RPC engine NEVER loads the designer:
    /// it validates the narrow repository certificate, starts this executable as a short-lived child on the same
    /// private desktop/job, and quarantines a failing assembly-content/type identity for the engine lifetime.
    ///
    /// This is process crash containment, not an OS security sandbox. Workspace Trust remains the boundary for
    /// loading project assemblies; the child prevents a broken designer from taking the open form/engine with it.
    /// </summary>
    internal sealed class HostedDesignerBroker
    {
        internal const string CertificationId = "repo.fakevendor.hosted-designer.v1";
        internal const string CertifiedAssemblyName = "FakeVendor";
        internal const string AssemblyFileName = "FakeVendor.dll";
        internal const string ComponentTypeName = "FakeVendor.CrashOnInitializeControl";
        internal const string DesignerTypeName = "FakeVendor.CrashOnInitializeDesigner";

        private const int WorkerTimeoutMs = 15_000;
        private readonly object _gate = new object();
        private readonly Dictionary<string, HostedDesignerProbeResult> _quarantined =
            new Dictionary<string, HostedDesignerProbeResult>(StringComparer.Ordinal);

        public HostedDesignerProbeResult Inspect(string assemblyPath, string componentTypeName, string certificationId)
        {
            int mainPid = Process.GetCurrentProcess().Id;
            HostedDesignerProbeResult refusal;
            string fullPath;
            string sha;
            if (!TryValidateCertificate(assemblyPath, componentTypeName, certificationId,
                    out fullPath, out sha, out refusal))
            {
                refusal.MainEnginePid = mainPid;
                return refusal;
            }

            string key = sha + "\n" + componentTypeName + "\n" + certificationId;
            lock (_gate)
            {
                if (_quarantined.TryGetValue(key, out var prior))
                {
                    return Copy(prior, workerStarted: false, status: "quarantined",
                        errorCode: "DESIGNER_QUARANTINED",
                        reason: "The certified hosted designer crashed and remains quarantined until its assembly content changes.");
                }
            }

            string exe = Assembly.GetEntryAssembly()?.Location ?? "";
            if (exe.Length == 0 || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                return Refused(componentTypeName, certificationId, sha, "WORKER_UNAVAILABLE",
                    "The net48 hosted-designer executable is unavailable.", mainPid);

            string resultPath = Path.Combine(Path.GetTempPath(),
                "wfd-hosted-designer-" + Guid.NewGuid().ToString("N") + ".json");
            Process? child = null;
            try
            {
                var start = new ProcessStartInfo
                {
                    FileName = exe,
                    Arguments = string.Join(" ", new[]
                    {
                        "--hosted-designer-worker",
                        "--assembly", RenderDesktop.Quote(fullPath),
                        "--component-type", RenderDesktop.Quote(componentTypeName),
                        "--certification", RenderDesktop.Quote(certificationId),
                        "--assembly-sha256", RenderDesktop.Quote(sha),
                        "--result", RenderDesktop.Quote(resultPath),
                    }),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(fullPath) ?? AppDomain.CurrentDomain.BaseDirectory,
                };
                child = Process.Start(start);
                if (child == null)
                    return Refused(componentTypeName, certificationId, sha, "WORKER_UNAVAILABLE",
                        "The certified hosted-designer worker could not be started.", mainPid);

                int launchedPid = child.Id;
                if (!child.WaitForExit(WorkerTimeoutMs))
                {
                    try { child.Kill(); } catch { }
                    try { child.WaitForExit(2_000); } catch { }
                    var timeout = Crashed(componentTypeName, certificationId, sha, mainPid, launchedPid, -1,
                        "DESIGNER_CRASH", "The certified hosted designer did not return before the product timeout.");
                    Quarantine(key, timeout);
                    return timeout;
                }

                int exitCode = child.ExitCode;
                HostedDesignerProbeResult? result = ReadWorkerResult(resultPath);
                if (exitCode != 0 || result == null)
                {
                    var crash = Crashed(componentTypeName, certificationId, sha, mainPid,
                        result?.WorkerPid > 0 ? result.WorkerPid : launchedPid, exitCode,
                        "DESIGNER_CRASH", "The certified hosted-designer process exited while initializing the designer.");
                    Quarantine(key, crash);
                    return crash;
                }

                // Treat the child as untrusted evidence: all identity fields must echo the already-validated request.
                if (!string.Equals(result.ComponentType, componentTypeName, StringComparison.Ordinal)
                    || !string.Equals(result.CertificationId, certificationId, StringComparison.Ordinal)
                    || !string.Equals(result.AssemblySha256, sha, StringComparison.OrdinalIgnoreCase))
                {
                    return Refused(componentTypeName, certificationId, sha, "INVALID_WORKER_RESULT",
                        "The hosted-designer worker returned an unrelated identity.", mainPid,
                        result.WorkerPid, exitCode, workerStarted: true);
                }

                result.MainEnginePid = mainPid;
                result.ExitCode = exitCode;
                result.WorkerStarted = true;
                if (!result.Ok || string.Equals(result.Status, "crashed", StringComparison.Ordinal))
                {
                    result.Ok = false;
                    result.Status = "crashed";
                    result.ErrorCode = "DESIGNER_CRASH";
                    result.Quarantined = true;
                    Quarantine(key, result);
                }
                return result;
            }
            catch (Exception ex)
            {
                return Refused(componentTypeName, certificationId, sha, "WORKER_UNAVAILABLE",
                    "The certified hosted-designer worker could not run: " + ex.GetBaseException().Message,
                    mainPid, child?.Id ?? 0, -1, workerStarted: child != null);
            }
            finally
            {
                child?.Dispose();
                try { if (File.Exists(resultPath)) File.Delete(resultPath); } catch { }
            }
        }

        private void Quarantine(string key, HostedDesignerProbeResult result)
        {
            result.Quarantined = true;
            lock (_gate) _quarantined[key] = Copy(result, workerStarted: result.WorkerStarted);
        }

        private static HostedDesignerProbeResult? ReadWorkerResult(string resultPath)
        {
            try
            {
                if (!File.Exists(resultPath)) return null;
                return JsonConvert.DeserializeObject<HostedDesignerProbeResult>(File.ReadAllText(resultPath, Encoding.UTF8));
            }
            catch { return null; }
        }

        private static bool TryValidateCertificate(string assemblyPath, string componentTypeName,
            string certificationId, out string fullPath, out string sha, out HostedDesignerProbeResult refusal)
        {
            fullPath = "";
            sha = "";
            refusal = Refused(componentTypeName ?? "", certificationId ?? "", "", "UNCERTIFIED_DESIGNER",
                "The hosted designer is not covered by a repository certificate.", Process.GetCurrentProcess().Id);
            if (!string.Equals(componentTypeName, ComponentTypeName, StringComparison.Ordinal)
                || !string.Equals(certificationId, CertificationId, StringComparison.Ordinal)) return false;
            try { fullPath = Path.GetFullPath(assemblyPath ?? ""); }
            catch { return false; }
            if (!Path.IsPathRooted(fullPath) || !File.Exists(fullPath)
                || !string.Equals(Path.GetFileName(fullPath), AssemblyFileName, StringComparison.OrdinalIgnoreCase))
                return false;
            try
            {
                if (!string.Equals(System.Reflection.AssemblyName.GetAssemblyName(fullPath).Name,
                        CertifiedAssemblyName, StringComparison.Ordinal))
                    return false;
                sha = Sha256FileHex(fullPath);
                if (sha.Length != 64) return false;
                return true;
            }
            catch { return false; }
        }

        /// <summary>Internal process entry. It independently revalidates the path/hash/certificate before loading any
        /// type, then creates a real DesignSurface + IDesignerHost on an STA thread. A fixture FailFast from
        /// Initialize leaves no result file, which the parent observes as an actual worker-process crash.</summary>
        internal static int RunWorker(string assemblyPath, string componentTypeName, string certificationId,
            string expectedSha256, string resultPath)
        {
            var result = new HostedDesignerProbeResult
            {
                ComponentType = componentTypeName ?? "",
                CertificationId = certificationId ?? "",
                WorkerPid = Process.GetCurrentProcess().Id,
                WorkerStarted = true,
                PrivateDesktop = RenderDesktop.IsIsolated,
            };
            try
            {
                HostedDesignerProbeResult refusal;
                string fullPath;
                string actualSha;
                if (!TryValidateCertificate(assemblyPath, componentTypeName, certificationId,
                        out fullPath, out actualSha, out refusal)
                    || !string.Equals(actualSha, expectedSha256, StringComparison.OrdinalIgnoreCase))
                {
                    result.Status = "refused";
                    result.ErrorCode = "CERTIFICATION_MISMATCH";
                    result.Reason = "The hosted-designer assembly identity changed before worker activation.";
                    result.AssemblySha256 = actualSha;
                    WriteWorkerResult(resultPath, result);
                    return 0;
                }

                result.AssemblySha256 = actualSha;
                HostedDesignerProbeResult? staResult = null;
                Exception? staError = null;
                var thread = new Thread(() =>
                {
                    try { staResult = CreateDesigner(fullPath, componentTypeName, certificationId, actualSha); }
                    catch (Exception ex) { staError = ex.GetBaseException(); }
                })
                {
                    IsBackground = false,
                    Name = "WinFormsDesigner.HostedDesigner.STA",
                };
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                if (!thread.Join(WorkerTimeoutMs - 2_000))
                {
                    // Do not leave an untrusted modal/designer thread alive behind a nominal refusal. The parent will
                    // observe this fail-fast exit and quarantine the exact assembly content/type identity.
                    Environment.FailFast("Certified hosted designer initialization timed out.");
                }
                if (staError != null)
                {
                    result.Status = "crashed";
                    result.ErrorCode = "DESIGNER_CRASH";
                    result.Reason = staError.GetType().Name + ": " + staError.Message;
                }
                else if (staResult == null)
                {
                    result.Status = "crashed";
                    result.ErrorCode = "DESIGNER_CRASH";
                    result.Reason = "The hosted designer returned no result.";
                }
                else
                {
                    result = staResult;
                    result.PrivateDesktop = RenderDesktop.IsIsolated;
                }
                WriteWorkerResult(resultPath, result);
                return 0;
            }
            catch (Exception ex)
            {
                result.Status = "crashed";
                result.ErrorCode = "DESIGNER_CRASH";
                result.Reason = ex.GetBaseException().GetType().Name + ": " + ex.GetBaseException().Message;
                try { WriteWorkerResult(resultPath, result); } catch { }
                return 0;
            }
        }

        private static HostedDesignerProbeResult CreateDesigner(string assemblyPath, string componentTypeName,
            string certificationId, string sha)
        {
            string directory = Path.GetDirectoryName(assemblyPath) ?? "";
            ResolveEventHandler resolver = (_, eventArgs) =>
            {
                try
                {
                    string candidate = Path.Combine(directory, new AssemblyName(eventArgs.Name).Name + ".dll");
                    return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
                }
                catch { return null; }
            };
            AppDomain.CurrentDomain.AssemblyResolve += resolver;
            try
            {
                Assembly assembly = Assembly.LoadFrom(assemblyPath);
                Type componentType = assembly.GetType(componentTypeName, throwOnError: true);
                if (!typeof(Control).IsAssignableFrom(componentType) || componentType.IsAbstract)
                    throw new InvalidOperationException("The certified component is not a concrete WinForms Control.");

                using (var surface = new DesignSurface(typeof(Form)))
                {
                    var host = surface.GetService(typeof(IDesignerHost)) as IDesignerHost
                        ?? throw new InvalidOperationException("IDesignerHost is unavailable.");
                    IComponent component = host.CreateComponent(componentType, "hostedComponent");
                    IDesigner designer = host.GetDesigner(component)
                        ?? throw new InvalidOperationException("The certified ComponentDesigner is unavailable.");
                    string designerType = designer.GetType().FullName ?? "";
                    if (!string.Equals(designerType, DesignerTypeName, StringComparison.Ordinal)
                        || !(designer is ControlDesigner))
                        throw new InvalidOperationException("The hosted designer type does not match its certificate.");
                    return new HostedDesignerProbeResult
                    {
                        Ok = true,
                        Status = "ready",
                        ComponentType = componentTypeName,
                        DesignerType = designerType,
                        CertificationId = certificationId,
                        AssemblySha256 = sha,
                        WorkerPid = Process.GetCurrentProcess().Id,
                        WorkerStarted = true,
                    };
                }
            }
            finally { AppDomain.CurrentDomain.AssemblyResolve -= resolver; }
        }

        private static void WriteWorkerResult(string resultPath, HostedDesignerProbeResult result)
        {
            if (string.IsNullOrWhiteSpace(resultPath) || !Path.IsPathRooted(resultPath))
                throw new InvalidOperationException("A rooted hosted-designer result path is required.");
            string directory = Path.GetDirectoryName(resultPath) ?? "";
            if (directory.Length == 0 || !Directory.Exists(directory))
                throw new InvalidOperationException("The hosted-designer result directory is unavailable.");
            File.WriteAllText(resultPath, JsonConvert.SerializeObject(result), new UTF8Encoding(false));
        }

        private static HostedDesignerProbeResult Crashed(string componentType, string certificationId, string sha,
            int mainPid, int workerPid, int exitCode, string errorCode, string reason) =>
            new HostedDesignerProbeResult
            {
                Ok = false,
                Status = "crashed",
                ErrorCode = errorCode,
                Reason = reason,
                ComponentType = componentType,
                CertificationId = certificationId,
                AssemblySha256 = sha,
                MainEnginePid = mainPid,
                WorkerPid = workerPid,
                ExitCode = exitCode,
                WorkerStarted = true,
                Quarantined = true,
                PrivateDesktop = RenderDesktop.IsIsolated,
            };

        private static HostedDesignerProbeResult Refused(string componentType, string certificationId, string sha,
            string errorCode, string reason, int mainPid, int workerPid = 0, int exitCode = 0,
            bool workerStarted = false) =>
            new HostedDesignerProbeResult
            {
                Ok = false,
                Status = "refused",
                ErrorCode = errorCode,
                Reason = reason,
                ComponentType = componentType ?? "",
                CertificationId = certificationId ?? "",
                AssemblySha256 = sha ?? "",
                MainEnginePid = mainPid,
                WorkerPid = workerPid,
                ExitCode = exitCode,
                WorkerStarted = workerStarted,
                PrivateDesktop = RenderDesktop.IsIsolated,
            };

        private static HostedDesignerProbeResult Copy(HostedDesignerProbeResult source, bool workerStarted,
            string? status = null, string? errorCode = null, string? reason = null) =>
            new HostedDesignerProbeResult
            {
                Ok = status == null ? source.Ok : string.Equals(status, "ready", StringComparison.Ordinal),
                Status = status ?? source.Status,
                ErrorCode = errorCode ?? source.ErrorCode,
                Reason = reason ?? source.Reason,
                ComponentType = source.ComponentType,
                DesignerType = source.DesignerType,
                CertificationId = source.CertificationId,
                AssemblySha256 = source.AssemblySha256,
                MainEnginePid = source.MainEnginePid,
                WorkerPid = source.WorkerPid,
                ExitCode = source.ExitCode,
                WorkerStarted = workerStarted,
                Quarantined = source.Quarantined,
                PrivateDesktop = source.PrivateDesktop,
            };

        private static string Sha256FileHex(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
            {
                byte[] hash = sha.ComputeHash(stream);
                var text = new StringBuilder(hash.Length * 2);
                foreach (byte value in hash) text.Append(value.ToString("x2"));
                return text.ToString();
            }
        }
    }
}
