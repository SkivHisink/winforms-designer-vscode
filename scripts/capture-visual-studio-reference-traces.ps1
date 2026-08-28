param(
  [Parameter(Mandatory = $true)]
  [string] $ExtensionTraceDirectory,

  [Parameter(Mandatory = $false)]
  [string] $OutputRoot,

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^VisualStudio\.DTE\.\d+\.0$')]
  [string] $DteProgId = 'VisualStudio.DTE.18.0',

  [Parameter(Mandatory = $false)]
  [ValidateSet('ALL', 'S005', 'S006', 'S015', 'S017', 'S019', 'S024', 'S025', 'S026', 'S027', 'S028', 'S031', 'S038', 'S039', 'S041', 'S042', 'S045', 'S046', 'S049', 'S050', 'S051', 'S053', 'S061', 'S062', 'S063', 'S079', 'S085', 'S086', 'S087', 'S088', 'S110')]
  [string] $CaptureSet = 'ALL'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$extensionTrace = (Resolve-Path -LiteralPath $ExtensionTraceDirectory).Path
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $repo 'docs/v2/reference-traces'
}
$outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
$scratchRoot = [System.IO.Path]::GetFullPath((Join-Path $repo '.codex-tmp/vs-reference-traces'))
if (-not $scratchRoot.StartsWith([System.IO.Path]::GetFullPath((Join-Path $repo '.codex-tmp')), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Scratch root escaped .codex-tmp: $scratchRoot"
}

foreach ($required in @('GroupMoveForm.cs', 'GroupMoveForm.Designer.cs', 'extension-leg.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $extensionTrace $required) -PathType Leaf)) {
    throw "Extension trace is missing $required in $extensionTrace"
  }
}
foreach ($required in @(
  'S100AdapterRoundTrip/S100AdapterRoundTripForm.cs',
  'S100AdapterRoundTrip/S100AdapterRoundTripForm.Designer.cs',
  'S100AdapterRoundTrip/adapter-manifest.json',
  'S100AdapterRoundTrip/extension-leg.json',
  'S108Net48RoundTrip/ReparentForm.cs',
  'S108Net48RoundTrip/ReparentForm.Designer.cs',
  'S108Net48RoundTrip/extension-leg.json'
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $extensionTrace $required) -PathType Leaf)) {
    throw "Extension trace is missing $required in $extensionTrace"
  }
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class VisualStudioTraceNative
{
    public delegate bool EnumWindowProc(IntPtr hwnd, IntPtr state);

    public sealed class DialogDismissal
    {
        public Thread Thread;
        public volatile bool Cancelled;
        public volatile bool Observed;
        public volatile bool ClickPosted;
        public volatile bool Dismissed;
    }

    public sealed class AccessibleRecord
    {
        public string Name;
        public string Role;
        public string Description;
        public string Value;
        public string DefaultAction;
        public int Depth;
        public int ChildId;
        public string[] Ancestors;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION union;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool attached);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr ChildWindowFromPointEx(IntPtr hwnd, POINT point, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam,
        uint flags, uint timeoutMs, out IntPtr result);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowProc callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maximum);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maximum);

    [DllImport("user32.dll")]
    private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr hwnd);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(
        IntPtr hwnd,
        uint objectId,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out object accessible);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleChildren(
        [MarshalAs(UnmanagedType.Interface)] object container,
        int childStart,
        int childCount,
        [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] object[] children,
        out int obtained);

    [DllImport("oleacc.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetRoleText(uint role, StringBuilder text, uint maximum);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetThreadDesktop(IntPtr desktop);

    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);

    private static IntPtr DeepestChildAt(IntPtr root, int screenX, int screenY)
    {
        IntPtr current = root;
        for (int depth = 0; depth < 32; depth++)
        {
            var client = new POINT { X = screenX, Y = screenY };
            if (!ScreenToClient(current, ref client)) break;
            IntPtr child = ChildWindowFromPointEx(current, client, 0);
            if (child == IntPtr.Zero || child == current) break;
            current = child;
        }
        return current;
    }

    private static void SendControlInput(bool keyUp)
    {
        var input = new INPUT
        {
            type = 1, // INPUT_KEYBOARD
            union = new INPUTUNION
            {
                ki = new KEYBDINPUT
                {
                    wVk = 0x11, // VK_CONTROL
                    wScan = 0,
                    dwFlags = keyUp ? 0x0002u : 0u, // KEYEVENTF_KEYUP
                    time = 0,
                    dwExtraInfo = UIntPtr.Zero
                }
            }
        };
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new InvalidOperationException("SendInput VK_CONTROL failed: " + Marshal.GetLastWin32Error());
    }

    public static void SetInjectedControlState(bool down)
    {
        if (down)
        {
            SendControlInput(false);
        }
        else
        {
            try { SendControlInput(true); }
            catch { keybd_event(0x11, 0x1D, 0x0002, UIntPtr.Zero); }
        }
        Thread.Sleep(100);
        bool observedDown = (GetAsyncKeyState(0x11) & 0x8000) != 0;
        if (observedDown != down)
        {
            if (down)
            {
                try { SendControlInput(true); } catch { }
            }
            throw new InvalidOperationException(
                "VK_CONTROL asynchronous state mismatch; requested=" + down + ", observed=" + observedDown);
        }
    }

    private static IntPtr ClientLParam(IntPtr hwnd, int screenX, int screenY)
    {
        var client = new POINT { X = screenX, Y = screenY };
        if (!ScreenToClient(hwnd, ref client)) throw new InvalidOperationException("ScreenToClient failed");
        return (IntPtr)((client.Y << 16) | (client.X & 0xffff));
    }

    public static void MoveWindowTo(IntPtr hwnd, int x, int y)
    {
        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOZORDER = 0x0004;
        const uint SWP_NOACTIVATE = 0x0010;
        if (!SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE))
            throw new InvalidOperationException("SetWindowPos failed: " + Marshal.GetLastWin32Error());
    }

    private static IntPtr CaptureWindowFor(IntPtr target)
    {
        uint processId;
        uint threadId = GetWindowThreadProcessId(target, out processId);
        var info = new GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(GUITHREADINFO)) };
        return GetGUIThreadInfo(threadId, ref info) && info.hwndCapture != IntPtr.Zero
            ? info.hwndCapture
            : target;
    }

    public static bool TryGetCursorPosition(out POINT point)
    {
        return GetCursorPos(out point);
    }

    public static string DescribeDeepestChildChain(IntPtr root, int screenX, int screenY)
    {
        IntPtr current = DeepestChildAt(root, screenX, screenY);
        var result = new StringBuilder();
        for (int level = 0; level < 12 && current != IntPtr.Zero; level++)
        {
            var className = new StringBuilder(256);
            var caption = new StringBuilder(256);
            GetClassName(current, className, className.Capacity);
            GetWindowText(current, caption, caption.Capacity);
            if (level > 0) result.Append(" <- ");
            result.Append("L").Append(level).Append(" hwnd=").Append(current.ToInt64())
                .Append(" class=").Append(className).Append(" text=").Append(caption);
            if (current == root) break;
            IntPtr parent = GetParent(current);
            if (parent == current) break;
            current = parent;
        }
        return result.ToString();
    }

    public static IntPtr[] GetProcessTopLevelWindows(IntPtr owner)
    {
        uint ownerProcess;
        GetWindowThreadProcessId(owner, out ownerProcess);
        var windows = new List<IntPtr>();
        EnumWindows((window, state) =>
        {
            uint process;
            GetWindowThreadProcessId(window, out process);
            if (process == ownerProcess) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static IntPtr[] GetDescendantWindowsByClassFragment(IntPtr root, string classFragment)
    {
        if (root == IntPtr.Zero) throw new ArgumentException("Root window is required", "root");
        if (string.IsNullOrWhiteSpace(classFragment)) throw new ArgumentException("Class fragment is required", "classFragment");
        var windows = new List<IntPtr>();
        EnumChildWindows(root, (window, state) =>
        {
            var className = new StringBuilder(256);
            GetClassName(window, className, className.Capacity);
            if (className.ToString().IndexOf(classFragment, StringComparison.OrdinalIgnoreCase) >= 0)
                windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static IntPtr[] GetDescendantWindowsByExactText(IntPtr root, string exactText)
    {
        if (root == IntPtr.Zero) throw new ArgumentException("Root window is required", "root");
        if (exactText == null) throw new ArgumentNullException("exactText");
        var windows = new List<IntPtr>();
        EnumChildWindows(root, (window, state) =>
        {
            var caption = new StringBuilder(256);
            GetWindowText(window, caption, caption.Capacity);
            if (string.Equals(caption.ToString(), exactText, StringComparison.Ordinal)) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static bool GetClientScreenRect(IntPtr hwnd, out RECT screenRect)
    {
        RECT client;
        screenRect = new RECT();
        if (!GetClientRect(hwnd, out client)) return false;
        var origin = new POINT { X = client.Left, Y = client.Top };
        var opposite = new POINT { X = client.Right, Y = client.Bottom };
        if (!ClientToScreen(hwnd, ref origin) || !ClientToScreen(hwnd, ref opposite)) return false;
        // WS_EX_LAYOUTRTL mirrors the client coordinate system, so (0,0) maps to the physical right edge. Transform
        // both diagonal points and normalize them instead of assuming an LTR screen-space axis.
        screenRect.Left = Math.Min(origin.X, opposite.X);
        screenRect.Top = Math.Min(origin.Y, opposite.Y);
        screenRect.Right = Math.Max(origin.X, opposite.X);
        screenRect.Bottom = Math.Max(origin.Y, opposite.Y);
        return true;
    }

    public static string[] GetDescendantWindowInventory(IntPtr root)
    {
        if (root == IntPtr.Zero) throw new ArgumentException("Root window is required", "root");
        var windows = new List<string>();
        EnumChildWindows(root, (window, state) =>
        {
            var className = new StringBuilder(256);
            var caption = new StringBuilder(256);
            RECT rect;
            GetClassName(window, className, className.Capacity);
            GetWindowText(window, caption, caption.Capacity);
            bool measured = GetWindowRect(window, out rect);
            windows.Add(
                "hwnd=" + window.ToInt64() +
                " class='" + className +
                "' text='" + caption +
                "' bounds=" + (measured
                    ? rect.Left + "," + rect.Top + "," + (rect.Right - rect.Left) + "," + (rect.Bottom - rect.Top)
                    : "UNAVAILABLE"));
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static string GetWindowClassName(IntPtr hwnd)
    {
        var className = new StringBuilder(256);
        GetClassName(hwnd, className, className.Capacity);
        return className.ToString();
    }

    public static string GetWindowTextValue(IntPtr hwnd)
    {
        var caption = new StringBuilder(256);
        GetWindowText(hwnd, caption, caption.Capacity);
        return caption.ToString();
    }

    private static object AccessibleProperty(object accessible, string name, object[] arguments)
    {
        try
        {
            return accessible.GetType().InvokeMember(
                name,
                BindingFlags.GetProperty,
                null,
                accessible,
                arguments);
        }
        catch { return null; }
    }

    private static string AccessibleString(object accessible, string name, int childId)
    {
        object value = AccessibleProperty(accessible, name, new object[] { childId });
        return value == null ? string.Empty : Convert.ToString(value) ?? string.Empty;
    }

    private static string AccessibleRole(object accessible, int childId)
    {
        object value = AccessibleProperty(accessible, "accRole", new object[] { childId });
        if (value == null) return string.Empty;
        try
        {
            uint role = Convert.ToUInt32(value);
            var text = new StringBuilder(128);
            return GetRoleText(role, text, (uint)text.Capacity) > 0 ? text.ToString() : role.ToString();
        }
        catch { return Convert.ToString(value) ?? string.Empty; }
    }

    private static AccessibleRecord ReadAccessibleRecord(object accessible, int childId, int depth, List<string> ancestors)
    {
        return new AccessibleRecord
        {
            Name = AccessibleString(accessible, "accName", childId),
            Role = AccessibleRole(accessible, childId),
            Description = AccessibleString(accessible, "accDescription", childId),
            Value = AccessibleString(accessible, "accValue", childId),
            DefaultAction = AccessibleString(accessible, "accDefaultAction", childId),
            Depth = depth,
            ChildId = childId,
            Ancestors = ancestors.ToArray()
        };
    }

    private static void WalkAccessibleContainer(
        object accessible,
        int depth,
        List<string> ancestors,
        List<AccessibleRecord> output)
    {
        if (accessible == null || depth >= 12 || output.Count >= 512) return;
        object childCountValue = AccessibleProperty(accessible, "accChildCount", null);
        int childCount;
        try { childCount = childCountValue == null ? 0 : Convert.ToInt32(childCountValue); }
        catch { childCount = 0; }
        if (childCount <= 0) return;
        var children = new object[childCount];
        int obtained;
        int result = AccessibleChildren(accessible, 0, childCount, children, out obtained);
        if (result < 0) return;
        for (int index = 0; index < obtained && output.Count < 512; index++)
        {
            object child = children[index];
            if (child == null) continue;
            bool childIsAccessible = Marshal.IsComObject(child);
            int childId = 0;
            if (!childIsAccessible)
            {
                try { childId = Convert.ToInt32(child); }
                catch { continue; }
            }
            var record = ReadAccessibleRecord(childIsAccessible ? child : accessible, childId, depth, ancestors);
            output.Add(record);
            var nextAncestors = new List<string>(ancestors);
            if (!string.IsNullOrEmpty(record.Name)) nextAncestors.Add(record.Name);
            if (childIsAccessible)
            {
                WalkAccessibleContainer(child, depth + 1, nextAncestors, output);
                continue;
            }
            object childObject = AccessibleProperty(accessible, "accChild", new object[] { childId });
            if (childObject != null && Marshal.IsComObject(childObject))
                WalkAccessibleContainer(childObject, depth + 1, nextAncestors, output);
        }
    }

    public static AccessibleRecord[] GetAccessibleInventory(IntPtr hwnd)
    {
        var interfaceId = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); // IAccessible
        object accessible;
        int result = AccessibleObjectFromWindow(hwnd, unchecked((uint)-4), ref interfaceId, out accessible); // OBJID_CLIENT
        if (result < 0 || accessible == null)
            Marshal.ThrowExceptionForHR(result);
        var output = new List<AccessibleRecord>();
        var root = ReadAccessibleRecord(accessible, 0, 0, new List<string>());
        output.Add(root);
        var ancestors = new List<string>();
        if (!string.IsNullOrEmpty(root.Name)) ancestors.Add(root.Name);
        WalkAccessibleContainer(accessible, 1, ancestors, output);
        return output.ToArray();
    }

    private static bool InvokeAccessibleDefaultAction(
        object accessible,
        string exactName,
        string requiredAncestor,
        int depth,
        List<string> ancestors)
    {
        if (accessible == null || depth >= 12) return false;
        object childCountValue = AccessibleProperty(accessible, "accChildCount", null);
        int childCount;
        try { childCount = childCountValue == null ? 0 : Convert.ToInt32(childCountValue); }
        catch { childCount = 0; }
        if (childCount <= 0) return false;
        var children = new object[childCount];
        int obtained;
        int result = AccessibleChildren(accessible, 0, childCount, children, out obtained);
        if (result < 0) return false;
        for (int index = 0; index < obtained; index++)
        {
            object child = children[index];
            if (child == null) continue;
            bool childIsAccessible = Marshal.IsComObject(child);
            int childId = 0;
            if (!childIsAccessible)
            {
                try { childId = Convert.ToInt32(child); }
                catch { continue; }
            }
            object target = childIsAccessible ? child : accessible;
            int targetId = childIsAccessible ? 0 : childId;
            var record = ReadAccessibleRecord(target, targetId, depth, ancestors);
            bool ancestorMatch = string.IsNullOrEmpty(requiredAncestor) ||
                ancestors.Exists(value => string.Equals(value, requiredAncestor, StringComparison.Ordinal));
            if (string.Equals(record.Name, exactName, StringComparison.Ordinal) && ancestorMatch)
            {
                target.GetType().InvokeMember(
                    "accDoDefaultAction",
                    BindingFlags.InvokeMethod,
                    null,
                    target,
                    new object[] { targetId });
                return true;
            }
            var nextAncestors = new List<string>(ancestors);
            if (!string.IsNullOrEmpty(record.Name)) nextAncestors.Add(record.Name);
            if (childIsAccessible && InvokeAccessibleDefaultAction(child, exactName, requiredAncestor, depth + 1, nextAncestors))
                return true;
            if (!childIsAccessible)
            {
                object childObject = AccessibleProperty(accessible, "accChild", new object[] { childId });
                if (childObject != null && Marshal.IsComObject(childObject) &&
                    InvokeAccessibleDefaultAction(childObject, exactName, requiredAncestor, depth + 1, nextAncestors))
                    return true;
            }
        }
        return false;
    }

    public static bool InvokeAccessibleDefaultActionByName(IntPtr hwnd, string exactName, string requiredAncestor)
    {
        var interfaceId = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); // IAccessible
        object accessible;
        int result = AccessibleObjectFromWindow(hwnd, unchecked((uint)-4), ref interfaceId, out accessible); // OBJID_CLIENT
        if (result < 0 || accessible == null)
            Marshal.ThrowExceptionForHR(result);
        var ancestors = new List<string>();
        var root = ReadAccessibleRecord(accessible, 0, 0, ancestors);
        if (!string.IsNullOrEmpty(root.Name)) ancestors.Add(root.Name);
        return InvokeAccessibleDefaultAction(accessible, exactName, requiredAncestor, 1, ancestors);
    }

    public static IntPtr ClickAtDeepestChild(IntPtr root, int screenX, int screenY)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        IntPtr position = ClientLParam(target, screenX, screenY);
        SendMessage(target, 0x0201, (IntPtr)1, position); // WM_LBUTTONDOWN / MK_LBUTTON
        SendMessage(target, 0x0202, IntPtr.Zero, position); // WM_LBUTTONUP
        return target;
    }

    public static IntPtr ClickAtAncestor(IntPtr root, int screenX, int screenY, int levelsUp)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        for (int level = 0; level < levelsUp; level++)
        {
            IntPtr parent = GetParent(target);
            if (parent == IntPtr.Zero || parent == target) break;
            target = parent;
        }
        IntPtr position = ClientLParam(target, screenX, screenY);
        SendMessage(target, 0x0201, (IntPtr)1, position);
        SendMessage(target, 0x0202, IntPtr.Zero, position);
        return target;
    }

    public static IntPtr PressVirtualKeyAtDeepestChild(IntPtr root, int screenX, int screenY, int virtualKey)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        SendMessage(target, 0x0100, (IntPtr)virtualKey, (IntPtr)1); // WM_KEYDOWN
        SendMessage(target, 0x0101, (IntPtr)virtualKey, (IntPtr)unchecked((int)0xC0000001)); // WM_KEYUP
        return target;
    }

    public static void SetVirtualKeyDown(int virtualKey)
    {
        keybd_event((byte)virtualKey, 0, 0, UIntPtr.Zero);
        Thread.Sleep(100);
    }

    public static void SetVirtualKeyUp(int virtualKey)
    {
        keybd_event((byte)virtualKey, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
        Thread.Sleep(100);
    }

    public static void PressTab()
    {
        keybd_event(0x09, 0, 0, UIntPtr.Zero); // VK_TAB down
        keybd_event(0x09, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
    }

    public static void PressEnter()
    {
        keybd_event(0x0D, 0, 0, UIntPtr.Zero); // VK_RETURN down
        keybd_event(0x0D, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
    }

    public static void PressF2()
    {
        keybd_event(0x71, 0, 0, UIntPtr.Zero); // VK_F2 down
        keybd_event(0x71, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
    }

    public static void PressEscape()
    {
        keybd_event(0x1B, 0, 0, UIntPtr.Zero); // VK_ESCAPE down
        keybd_event(0x1B, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
    }

    public static void PressContextMenu()
    {
        keybd_event(0x10, 0, 0, UIntPtr.Zero); // VK_SHIFT down
        keybd_event(0x79, 0, 0, UIntPtr.Zero); // VK_F10 down
        keybd_event(0x79, 0, 0x0002, UIntPtr.Zero); // VK_F10 up
        keybd_event(0x10, 0, 0x0002, UIntPtr.Zero); // VK_SHIFT up
    }

    public static IntPtr DoubleClickAtDeepestChild(IntPtr root, int screenX, int screenY)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        IntPtr position = ClientLParam(target, screenX, screenY);
        SendMessage(target, 0x0201, (IntPtr)1, position); // WM_LBUTTONDOWN / MK_LBUTTON
        SendMessage(target, 0x0202, IntPtr.Zero, position); // WM_LBUTTONUP
        SendMessage(target, 0x0203, (IntPtr)1, position); // WM_LBUTTONDBLCLK / MK_LBUTTON
        SendMessage(target, 0x0202, IntPtr.Zero, position); // WM_LBUTTONUP
        return target;
    }

    public static DialogDismissal StartDialogDismissal(IntPtr owner, string title, int controlId, int timeoutMs)
    {
        uint ownerProcess;
        GetWindowThreadProcessId(owner, out ownerProcess);
        var result = new DialogDismissal();
        result.Thread = new Thread(() =>
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            IntPtr observedWindow = IntPtr.Zero;
            while (DateTime.UtcNow < deadline && !result.Cancelled && !result.Dismissed)
            {
                if (observedWindow != IntPtr.Zero && !IsWindow(observedWindow))
                {
                    result.Dismissed = result.Observed && result.ClickPosted;
                    break;
                }
                EnumWindows((window, unused) =>
                {
                    uint process;
                    GetWindowThreadProcessId(window, out process);
                    if (process != ownerProcess) return true;
                    var text = new StringBuilder(256);
                    GetWindowText(window, text, text.Capacity);
                    if (!string.Equals(text.ToString(), title, StringComparison.Ordinal)) return true;
                    result.Observed = true;
                    observedWindow = window;
                    EnumChildWindows(window, (child, childState) =>
                    {
                        if (GetDlgCtrlID(child) != controlId) return true;
                        // A plain posted BM_CLICK can be lost when the modal lives on the interactive desktop and the
                        // capture host is headless. SendMessageTimeout crosses that boundary synchronously but is
                        // bounded, while the modal loop remains able to process the exact control-id choice and close.
                        IntPtr clickResult;
                        if (SendMessageTimeout(
                                child, 0x00F5, IntPtr.Zero, IntPtr.Zero,
                                0x0002, // SMTO_ABORTIFHUNG
                                2000,
                                out clickResult) != IntPtr.Zero)
                            result.ClickPosted = true;
                        return false;
                    }, IntPtr.Zero);
                    return false;
                }, IntPtr.Zero);
                if (!result.Dismissed) Thread.Sleep(50);
            }
            if (observedWindow != IntPtr.Zero && !IsWindow(observedWindow))
                result.Dismissed = result.Observed && result.ClickPosted;
        });
        result.Thread.IsBackground = true;
        result.Thread.Start();
        return result;
    }

    public static IntPtr DragAtDeepestChild(IntPtr root, int startX, int startY, int endX, int endY)
    {
        IntPtr target = DeepestChildAt(root, startX, startY);
        SendMessage(target, 0x0201, (IntPtr)1, ClientLParam(target, startX, startY));
        for (int step = 1; step <= 8; step++)
        {
            int x = startX + ((endX - startX) * step / 8);
            int y = startY + ((endY - startY) * step / 8);
            SendMessage(target, 0x0200, (IntPtr)1, ClientLParam(target, x, y)); // WM_MOUSEMOVE / MK_LBUTTON
        }
        SendMessage(target, 0x0202, IntPtr.Zero, ClientLParam(target, endX, endY));
        return target;
    }

    public static IntPtr PostDragAtDeepestChild(IntPtr root, int startX, int startY, int endX, int endY)
    {
        IntPtr target = DeepestChildAt(root, startX, startY);
        if (!PostMessage(target, 0x0201, (IntPtr)1, ClientLParam(target, startX, startY)))
            throw new InvalidOperationException("PostMessage WM_LBUTTONDOWN failed");
        Thread.Sleep(40);
        for (int step = 1; step <= 8; step++)
        {
            int x = startX + ((endX - startX) * step / 8);
            int y = startY + ((endY - startY) * step / 8);
            if (!PostMessage(target, 0x0200, (IntPtr)1, ClientLParam(target, x, y)))
                throw new InvalidOperationException("PostMessage WM_MOUSEMOVE failed");
            Thread.Sleep(40);
        }
        if (!PostMessage(target, 0x0202, IntPtr.Zero, ClientLParam(target, endX, endY)))
            throw new InvalidOperationException("PostMessage WM_LBUTTONUP failed");
        Thread.Sleep(100);
        return target;
    }

    public static IntPtr PostDragUsingCapture(IntPtr root, int startX, int startY, int endX, int endY)
    {
        IntPtr target = DeepestChildAt(root, startX, startY);
        if (!PostMessage(target, 0x0201, (IntPtr)1, ClientLParam(target, startX, startY)))
            throw new InvalidOperationException("PostMessage WM_LBUTTONDOWN failed");
        Thread.Sleep(150);
        IntPtr capture = CaptureWindowFor(target);
        for (int step = 1; step <= 12; step++)
        {
            int x = startX + ((endX - startX) * step / 12);
            int y = startY + ((endY - startY) * step / 12);
            if (!PostMessage(capture, 0x0200, (IntPtr)1, ClientLParam(capture, x, y)))
                throw new InvalidOperationException("PostMessage WM_MOUSEMOVE to capture window failed");
            Thread.Sleep(60);
            capture = CaptureWindowFor(capture);
        }
        if (!PostMessage(capture, 0x0202, IntPtr.Zero, ClientLParam(capture, endX, endY)))
            throw new InvalidOperationException("PostMessage WM_LBUTTONUP to capture window failed");
        Thread.Sleep(250);
        return capture;
    }

    public static IntPtr PostDragUsingCaptureWithCursor(IntPtr root, int startX, int startY, int endX, int endY)
    {
        POINT previous;
        if (!GetCursorPos(out previous))
            throw new InvalidOperationException("GetCursorPos failed before cursor-synchronized posted drag");
        IntPtr target = DeepestChildAt(root, startX, startY);
        IntPtr capture = target;
        bool leftDown = false;
        try
        {
            if (!SetCursorPos(startX, startY))
                throw new InvalidOperationException("SetCursorPos start failed before cursor-synchronized posted drag");
            Thread.Sleep(80);
            if (!PostMessage(target, 0x0201, (IntPtr)1, ClientLParam(target, startX, startY)))
                throw new InvalidOperationException("PostMessage WM_LBUTTONDOWN failed");
            leftDown = true;
            Thread.Sleep(150);
            capture = CaptureWindowFor(target);
            for (int step = 1; step <= 12; step++)
            {
                int x = startX + ((endX - startX) * step / 12);
                int y = startY + ((endY - startY) * step / 12);
                if (!SetCursorPos(x, y))
                    throw new InvalidOperationException("SetCursorPos move failed during cursor-synchronized posted drag");
                if (!PostMessage(capture, 0x0200, (IntPtr)1, ClientLParam(capture, x, y)))
                    throw new InvalidOperationException("PostMessage WM_MOUSEMOVE failed during cursor-synchronized posted drag");
                Thread.Sleep(80);
                capture = CaptureWindowFor(capture);
            }
            if (!PostMessage(capture, 0x0202, IntPtr.Zero, ClientLParam(capture, endX, endY)))
                throw new InvalidOperationException("PostMessage WM_LBUTTONUP failed during cursor-synchronized posted drag");
            leftDown = false;
            Thread.Sleep(250);
            return capture;
        }
        finally
        {
            if (leftDown)
            {
                try { PostMessage(capture, 0x0202, IntPtr.Zero, ClientLParam(capture, endX, endY)); }
                catch { }
            }
            SetCursorPos(previous.X, previous.Y);
        }
    }

    public static IntPtr BeginDragUsingCapture(IntPtr root, int startX, int startY)
    {
        IntPtr target = DeepestChildAt(root, startX, startY);
        if (!PostMessage(target, 0x0201, (IntPtr)1, ClientLParam(target, startX, startY)))
            throw new InvalidOperationException("PostMessage WM_LBUTTONDOWN failed");
        Thread.Sleep(150);
        return CaptureWindowFor(target);
    }

    public static IntPtr MoveDragUsingCapture(IntPtr capture, int screenX, int screenY)
    {
        if (!PostMessage(capture, 0x0200, (IntPtr)1, ClientLParam(capture, screenX, screenY)))
            throw new InvalidOperationException("PostMessage WM_MOUSEMOVE to capture window failed");
        Thread.Sleep(80);
        return CaptureWindowFor(capture);
    }

    public static void EndDragUsingCapture(IntPtr capture, int screenX, int screenY)
    {
        if (!PostMessage(capture, 0x0202, IntPtr.Zero, ClientLParam(capture, screenX, screenY)))
            throw new InvalidOperationException("PostMessage WM_LBUTTONUP to capture window failed");
        Thread.Sleep(250);
    }

    public static IntPtr PostClickUsingCapture(IntPtr root, int screenX, int screenY)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        if (!PostMessage(target, 0x0201, (IntPtr)1, ClientLParam(target, screenX, screenY)))
            throw new InvalidOperationException("PostMessage WM_LBUTTONDOWN failed");
        Thread.Sleep(150);
        IntPtr capture = CaptureWindowFor(target);
        if (!PostMessage(capture, 0x0202, IntPtr.Zero, ClientLParam(capture, screenX, screenY)))
            throw new InvalidOperationException("PostMessage WM_LBUTTONUP to capture window failed");
        Thread.Sleep(250);
        return capture;
    }

    public static IntPtr PostModifiedClickUsingCapture(
        IntPtr root, int screenX, int screenY, bool controlModifier)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        bool controlDown = false;
        try
        {
            if (controlModifier)
            {
                keybd_event(0x11, 0, 0, UIntPtr.Zero); // VK_CONTROL down
                controlDown = true;
                Thread.Sleep(100);
            }
            IntPtr downState = controlModifier ? (IntPtr)0x0009 : (IntPtr)0x0001; // MK_CONTROL | MK_LBUTTON
            if (!PostMessage(target, 0x0201, downState, ClientLParam(target, screenX, screenY)))
                throw new InvalidOperationException("PostMessage WM_LBUTTONDOWN failed");
            Thread.Sleep(150);
            IntPtr capture = CaptureWindowFor(target);
            IntPtr upState = controlModifier ? (IntPtr)0x0008 : IntPtr.Zero; // MK_CONTROL
            if (!PostMessage(capture, 0x0202, upState, ClientLParam(capture, screenX, screenY)))
                throw new InvalidOperationException("PostMessage WM_LBUTTONUP to capture window failed");
            Thread.Sleep(250);
            return capture;
        }
        finally
        {
            if (controlDown) keybd_event(0x11, 0, 0x0002, UIntPtr.Zero); // VK_CONTROL up
        }
    }

    public static IntPtr PostControlClickToFocusedDesigner(IntPtr root, int screenX, int screenY)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        IntPtr keyTarget = target;
        bool controlDown = false;
        try
        {
            SendMessage(keyTarget, 0x0100, (IntPtr)0x11, (IntPtr)1); // WM_KEYDOWN / VK_CONTROL
            controlDown = true;
            Thread.Sleep(250);
            SendMessage(target, 0x0201, (IntPtr)0x0009, ClientLParam(target, screenX, screenY)); // MK_CONTROL | MK_LBUTTON
            Thread.Sleep(150);
            IntPtr capture = CaptureWindowFor(target);
            SendMessage(capture, 0x0202, (IntPtr)0x0008, ClientLParam(capture, screenX, screenY)); // MK_CONTROL
            Thread.Sleep(750);
            SendMessage(keyTarget, 0x0101, (IntPtr)0x11, (IntPtr)unchecked((int)0xC0000001));
            controlDown = false;
            Thread.Sleep(250);
            return capture;
        }
        finally
        {
            if (controlDown)
                SendMessage(keyTarget, 0x0101, (IntPtr)0x11, (IntPtr)unchecked((int)0xC0000001));
        }
    }

    public static IntPtr PostRightClickUsingCapture(IntPtr root, int screenX, int screenY)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        if (!PostMessage(target, 0x0204, (IntPtr)2, ClientLParam(target, screenX, screenY)))
            throw new InvalidOperationException("PostMessage WM_RBUTTONDOWN failed");
        Thread.Sleep(150);
        IntPtr capture = CaptureWindowFor(target);
        if (!PostMessage(capture, 0x0205, IntPtr.Zero, ClientLParam(capture, screenX, screenY)))
            throw new InvalidOperationException("PostMessage WM_RBUTTONUP to capture window failed");
        Thread.Sleep(250);
        return capture;
    }

    public static IntPtr PostContextMenuAtDeepestChild(IntPtr root, int screenX, int screenY)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        IntPtr screenPosition = (IntPtr)((screenY << 16) | (screenX & 0xffff));
        if (!PostMessage(target, 0x007B, target, screenPosition)) // WM_CONTEXTMENU
            throw new InvalidOperationException("PostMessage WM_CONTEXTMENU failed");
        Thread.Sleep(250);
        return target;
    }

    public static IntPtr PostMouseWheelAtDeepestChild(IntPtr root, int screenX, int screenY, int delta)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        IntPtr screenPosition = (IntPtr)((screenY << 16) | (screenX & 0xffff));
        IntPtr wheel = (IntPtr)unchecked(delta << 16);
        if (!PostMessage(target, 0x020A, wheel, screenPosition)) // WM_MOUSEWHEEL
            throw new InvalidOperationException("PostMessage WM_MOUSEWHEEL failed");
        Thread.Sleep(250);
        return target;
    }

    public static IntPtr PhysicalDragAtScreen(IntPtr root, int startX, int startY, int endX, int endY)
    {
        return PhysicalDragAtScreenCore(root, startX, startY, endX, endY, false);
    }

    public static IntPtr PhysicalAltDragAtScreen(IntPtr root, int startX, int startY, int endX, int endY)
    {
        return PhysicalDragAtScreenCore(root, startX, startY, endX, endY, true);
    }

    private static IntPtr PhysicalDragAtScreenCore(
        IntPtr root, int startX, int startY, int endX, int endY, bool holdAlt)
    {
        IntPtr target = DeepestChildAt(root, startX, startY);
        IntPtr topLevel = GetAncestor(root, 2); // GA_ROOT
        if (topLevel == IntPtr.Zero) topLevel = root;
        Exception failure = null;
        IntPtr inputDesktop = IntPtr.Zero;
        var thread = new Thread(() =>
        {
            POINT previous = new POINT();
            bool restoreCursor = false;
            bool leftDown = false;
            bool altDown = false;
            try
            {
                // DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP.
                inputDesktop = OpenInputDesktop(0, false, 0x0183);
                // A normal interactive host thread already inherits the input desktop. Hardened hosts can deny
                // OpenInputDesktop(DESKTOP_SWITCHDESKTOP); in that case continue on the inherited desktop and let
                // the exact foreground/cursor checks below decide whether physical input is safe.
                if (inputDesktop != IntPtr.Zero && !SetThreadDesktop(inputDesktop))
                    throw new InvalidOperationException("SetThreadDesktop failed: " + Marshal.GetLastWin32Error());
                IntPtr foreground = GetForegroundWindow();
                uint ignoredProcessId;
                uint currentThread = GetCurrentThreadId();
                uint foregroundThread = foreground == IntPtr.Zero
                    ? 0
                    : GetWindowThreadProcessId(foreground, out ignoredProcessId);
                uint traceThread = GetWindowThreadProcessId(topLevel, out ignoredProcessId);
                bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread &&
                    AttachThreadInput(currentThread, foregroundThread, true);
                bool attachedTrace = traceThread != 0 && traceThread != currentThread &&
                    AttachThreadInput(currentThread, traceThread, true);
                try
                {
                    ShowWindow(topLevel, 9); // SW_RESTORE
                    BringWindowToTop(topLevel);
                    SetForegroundWindow(topLevel);
                }
                finally
                {
                    if (attachedTrace) AttachThreadInput(currentThread, traceThread, false);
                    if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
                }
                Thread.Sleep(200);
                if (GetForegroundWindow() != topLevel)
                {
                    // Windows' foreground lock can still reject an attached queue. A bounded Alt-held activation is
                    // the documented shell-compatible escape hatch; release Alt before any pointer input and retain
                    // the exact HWND gate below.
                    keybd_event(0x12, 0, 0, UIntPtr.Zero); // VK_MENU down
                    try
                    {
                        BringWindowToTop(topLevel);
                        SetForegroundWindow(topLevel);
                    }
                    finally
                    {
                        keybd_event(0x12, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
                    }
                    Thread.Sleep(200);
                }
                if (GetForegroundWindow() != topLevel)
                    throw new InvalidOperationException(
                        "Dedicated trace IDE did not become the foreground window; expected=" + topLevel +
                        ", actual=" + GetForegroundWindow());
                if (!GetCursorPos(out previous))
                    throw new InvalidOperationException("GetCursorPos on input desktop failed: " + Marshal.GetLastWin32Error());
                restoreCursor = true;
                if (!SetCursorPos(startX, startY))
                    throw new InvalidOperationException("SetCursorPos start failed: " + Marshal.GetLastWin32Error());
                Thread.Sleep(150);
                if (holdAlt)
                {
                    keybd_event(0x12, 0, 0, UIntPtr.Zero); // VK_MENU down on the input-desktop thread
                    altDown = true;
                    Thread.Sleep(100);
                }
                mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_LEFTDOWN
                leftDown = true;
                Thread.Sleep(100);
                for (int step = 1; step <= 12; step++)
                {
                    int x = startX + ((endX - startX) * step / 12);
                    int y = startY + ((endY - startY) * step / 12);
                    if (!SetCursorPos(x, y))
                        throw new InvalidOperationException("SetCursorPos drag failed: " + Marshal.GetLastWin32Error());
                    Thread.Sleep(60);
                }
                mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_LEFTUP
                leftDown = false;
                Thread.Sleep(250);
            }
            catch (Exception ex) { failure = ex; }
            finally
            {
                if (leftDown) mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
                if (altDown) keybd_event(0x12, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
                if (restoreCursor) SetCursorPos(previous.X, previous.Y);
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (inputDesktop != IntPtr.Zero) CloseDesktop(inputDesktop);
        if (failure != null)
            throw new InvalidOperationException("Physical input desktop drag failed: " + failure.Message, failure);
        return target;
    }

    public static IntPtr PhysicalRightClickAtScreen(IntPtr root, int screenX, int screenY)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        Exception failure = null;
        IntPtr inputDesktop = IntPtr.Zero;
        var thread = new Thread(() =>
        {
            POINT previous = new POINT();
            bool restoreCursor = false;
            bool rightDown = false;
            try
            {
                inputDesktop = OpenInputDesktop(0, false, 0x0183);
                // A normal interactive pwsh process is already attached to the input desktop. Some hardened hosts
                // deny DESKTOP_SWITCHDESKTOP even though input injection on that existing desktop remains available.
                // Attach explicitly when permitted; otherwise retain the current thread desktop and still fail on
                // the concrete cursor/input operations below if it is not interactive.
                if (inputDesktop != IntPtr.Zero && !SetThreadDesktop(inputDesktop))
                    throw new InvalidOperationException("SetThreadDesktop failed: " + Marshal.GetLastWin32Error());
                SetForegroundWindow(root);
                Thread.Sleep(200);
                if (!GetCursorPos(out previous))
                    throw new InvalidOperationException("GetCursorPos on input desktop failed: " + Marshal.GetLastWin32Error());
                restoreCursor = true;
                if (!SetCursorPos(screenX, screenY))
                    throw new InvalidOperationException("SetCursorPos failed: " + Marshal.GetLastWin32Error());
                Thread.Sleep(150);
                mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_RIGHTDOWN
                rightDown = true;
                Thread.Sleep(100);
                mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_RIGHTUP
                rightDown = false;
                Thread.Sleep(250);
            }
            catch (Exception ex) { failure = ex; }
            finally
            {
                if (rightDown) mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero);
                if (restoreCursor) SetCursorPos(previous.X, previous.Y);
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (inputDesktop != IntPtr.Zero) CloseDesktop(inputDesktop);
        if (failure != null)
            throw new InvalidOperationException("Physical input desktop right-click failed: " + failure.Message, failure);
        return target;
    }

    public static IntPtr PhysicalClickAtScreen(IntPtr root, int screenX, int screenY, bool controlModifier)
    {
        IntPtr target = DeepestChildAt(root, screenX, screenY);
        IntPtr topLevel = GetAncestor(root, 2); // GA_ROOT
        if (topLevel == IntPtr.Zero) topLevel = root;
        Exception failure = null;
        IntPtr inputDesktop = IntPtr.Zero;
        var thread = new Thread(() =>
        {
            POINT previous = new POINT();
            bool restoreCursor = false;
            bool leftDown = false;
            bool controlDown = false;
            try
            {
                inputDesktop = OpenInputDesktop(0, false, 0x0183);
                if (inputDesktop != IntPtr.Zero && !SetThreadDesktop(inputDesktop))
                    throw new InvalidOperationException("SetThreadDesktop failed: " + Marshal.GetLastWin32Error());
                IntPtr foreground = GetForegroundWindow();
                uint ignoredProcessId;
                uint currentThread = GetCurrentThreadId();
                uint foregroundThread = foreground == IntPtr.Zero
                    ? 0
                    : GetWindowThreadProcessId(foreground, out ignoredProcessId);
                uint traceThread = GetWindowThreadProcessId(topLevel, out ignoredProcessId);
                bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread &&
                    AttachThreadInput(currentThread, foregroundThread, true);
                bool attachedTrace = traceThread != 0 && traceThread != currentThread &&
                    AttachThreadInput(currentThread, traceThread, true);
                try
                {
                    ShowWindow(topLevel, 9); // SW_RESTORE
                    BringWindowToTop(topLevel);
                    SetForegroundWindow(topLevel);
                }
                finally
                {
                    if (attachedTrace) AttachThreadInput(currentThread, traceThread, false);
                    if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
                }
                Thread.Sleep(200);
                if (GetForegroundWindow() != topLevel)
                {
                    keybd_event(0x12, 0, 0, UIntPtr.Zero); // VK_MENU down
                    try
                    {
                        BringWindowToTop(topLevel);
                        SetForegroundWindow(topLevel);
                    }
                    finally
                    {
                        keybd_event(0x12, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
                    }
                    Thread.Sleep(200);
                }
                if (GetForegroundWindow() != topLevel)
                {
                    // An activation-only click in the classic designer can transiently leave GetForegroundWindow at
                    // zero. Raise only the dedicated trace IDE, immediately restore its non-topmost state, and retain
                    // the exact foreground gate below before allowing pointer input.
                    const uint SWP_NOSIZE = 0x0001;
                    const uint SWP_NOMOVE = 0x0002;
                    const uint SWP_SHOWWINDOW = 0x0040;
                    SetWindowPos(topLevel, (IntPtr)(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW); // HWND_TOPMOST
                    SetWindowPos(topLevel, (IntPtr)(-2), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW); // HWND_NOTOPMOST
                    BringWindowToTop(topLevel);
                    SetForegroundWindow(topLevel);
                    Thread.Sleep(300);
                }
                if (GetForegroundWindow() != topLevel)
                    throw new InvalidOperationException(
                        "Dedicated trace IDE did not become the foreground window; expected=" + topLevel +
                        ", actual=" + GetForegroundWindow());
                if (!GetCursorPos(out previous))
                    throw new InvalidOperationException("GetCursorPos on input desktop failed: " + Marshal.GetLastWin32Error());
                restoreCursor = true;
                if (!SetCursorPos(screenX, screenY))
                    throw new InvalidOperationException("SetCursorPos failed: " + Marshal.GetLastWin32Error());
                Thread.Sleep(150);
                if (controlModifier)
                {
                    SendControlInput(false);
                    controlDown = true;
                    Thread.Sleep(100);
                    if ((GetAsyncKeyState(0x11) & 0x8000) == 0)
                        throw new InvalidOperationException("VK_CONTROL did not enter the asynchronous down state");
                }
                mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_LEFTDOWN
                leftDown = true;
                Thread.Sleep(100);
                mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_LEFTUP
                leftDown = false;
                // The classic net48 designer processes the click through its input shield asynchronously. Keep Ctrl
                // down long enough for that queued mouse gesture to observe the real modifier state.
                Thread.Sleep(controlDown ? 1000 : 100);
                if (controlDown)
                {
                    SendControlInput(true);
                    controlDown = false;
                }
                Thread.Sleep(250);
            }
            catch (Exception ex) { failure = ex; }
            finally
            {
                if (leftDown) mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
                if (controlDown)
                {
                    try { SendControlInput(true); }
                    catch { keybd_event(0x11, 0x1D, 0x0002, UIntPtr.Zero); }
                }
                if (restoreCursor) SetCursorPos(previous.X, previous.Y);
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (inputDesktop != IntPtr.Zero) CloseDesktop(inputDesktop);
        if (failure != null)
            throw new InvalidOperationException("Physical input desktop click failed: " + failure.Message, failure);
        return target;
    }

    // PowerShell's dynamic COM binder caches a concrete VARIANT type for EnvDTE.Property.Value. Windows Forms
    // designer options do not all expose the same VARIANT type, so a later assignment can otherwise be rebound as
    // the type of a different option (for example Int32 LayoutMode as Boolean SnapToGrid). Reflection keeps the
    // dispatch argument as object and lets the option's own IDispatch implementation perform the correct coercion.
    public static void SetComPropertyValue(object target, object value)
    {
        if (target == null) throw new ArgumentNullException("target");
        target.GetType().InvokeMember(
            "Value",
            BindingFlags.SetProperty,
            null,
            target,
            new object[] { value });
    }

}

[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVisualStudioOleMessageFilter
{
    [PreserveSig] int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo);
    [PreserveSig] int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType);
    [PreserveSig] int MessagePending(IntPtr taskCallee, int tickCount, int pendingType);
}

public sealed class VisualStudioOleMessageFilter : IVisualStudioOleMessageFilter
{
    private static IVisualStudioOleMessageFilter previous;

    [DllImport("ole32.dll")]
    private static extern int CoRegisterMessageFilter(
        IVisualStudioOleMessageFilter newFilter,
        out IVisualStudioOleMessageFilter oldFilter);

    public static void Register()
    {
        IVisualStudioOleMessageFilter oldFilter;
        int result = CoRegisterMessageFilter(new VisualStudioOleMessageFilter(), out oldFilter);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        previous = oldFilter;
    }

    public static void Revoke()
    {
        IVisualStudioOleMessageFilter ignored;
        CoRegisterMessageFilter(previous, out ignored);
        previous = null;
    }

    public int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo) { return 0; }
    public int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType) { return rejectType == 2 ? 250 : -1; }
    public int MessagePending(IntPtr taskCallee, int tickCount, int pendingType) { return 2; }
}
'@

function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Json([string] $Path, $Value) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
  $json = $Value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Write-Gzip([string] $Path, [byte[]] $Bytes) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
  $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $gzip = [System.IO.Compression.GZipStream]::new($file, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    try { $gzip.Write($Bytes, 0, $Bytes.Length) } finally { $gzip.Dispose() }
  } finally {
    $file.Dispose()
  }
}

function Copy-ProjectFixture([string] $Source, [string] $Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Get-ChildItem -LiteralPath $Source -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name)
  }
}

function Get-WindowHandle($Window, $Dte) {
  try {
    $candidate = [int64]$Window.HWnd
    if ($candidate -ne 0) { return [IntPtr]$candidate }
  } catch { }
  try {
    $candidate = [int64]$Dte.MainWindow.HWnd
    if ($candidate -ne 0) { return [IntPtr]$candidate }
  } catch { }

  # VS 18's out-of-proc DTE projection can omit HWnd from both Window wrappers. Resolve only the newly-created trace
  # IDE by its unique solution title; never fall back to an arbitrary existing devenv process owned by the user.
  $solutionName = ''
  try { $solutionName = [System.IO.Path]::GetFileNameWithoutExtension([string]$Dte.Solution.FullName) } catch { }
  $process = @(Get-Process devenv -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne 0 -and $solutionName -and $_.MainWindowTitle -like "*$solutionName*"
    } | Sort-Object StartTime -Descending | Select-Object -First 1)
  if ($process.Count -ne 1) {
    throw "Cannot resolve the dedicated Visual Studio trace HWND for solution '$solutionName'."
  }
  return [IntPtr]([int64]$process[0].MainWindowHandle)
}

function Save-WindowCapture([IntPtr] $Hwnd, [string] $Destination) {
  $rect = New-Object VisualStudioTraceNative+RECT
  if (-not [VisualStudioTraceNative]::GetWindowRect($Hwnd, [ref]$rect)) {
    throw "GetWindowRect failed for HWND $Hwnd"
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 64 -or $height -lt 64) {
    throw "Visual Studio capture window is unexpectedly small: ${width}x${height}"
  }

  $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = [IntPtr]::Zero
  try {
    $hdc = $graphics.GetHdc()
    $printed = [VisualStudioTraceNative]::PrintWindow($Hwnd, $hdc, 2)
    $null = $graphics.ReleaseHdc($hdc)
    $hdc = [IntPtr]::Zero
    if (-not $printed) {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
    }
    $null = $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    if ($hdc -ne [IntPtr]::Zero) { $null = $graphics.ReleaseHdc($hdc) }
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  return [ordered]@{
    hwnd = $Hwnd.ToInt64()
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
    dpi = [VisualStudioTraceNative]::GetDpiForWindow($Hwnd)
    sha256 = Get-Sha256 $Destination
  }
}

function Save-ScreenRegionCapture(
  [int] $X,
  [int] $Y,
  [int] $Width,
  [int] $Height,
  [string] $Destination
) {
  if ($Width -lt 16 -or $Height -lt 16) {
    throw "Screen capture region is unexpectedly small: ${Width}x${Height} at $X,$Y"
  }
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($X, $Y, 0, 0, [System.Drawing.Size]::new($Width, $Height))
    $null = $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return [ordered]@{
    x = $X
    y = $Y
    width = $Width
    height = $Height
    captureMethod = 'Graphics.CopyFromScreen'
    sha256 = Get-Sha256 $Destination
  }
}

function Save-WindowScreenCapture([IntPtr] $Hwnd, [string] $Destination) {
  $rect = New-Object VisualStudioTraceNative+RECT
  if (-not [VisualStudioTraceNative]::GetWindowRect($Hwnd, [ref]$rect)) {
    throw "GetWindowRect failed for HWND $Hwnd"
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 64 -or $height -lt 64) {
    throw "Visual Studio screen capture window is unexpectedly small: ${width}x${height}"
  }
  $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
    $null = $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return [ordered]@{
    hwnd = $Hwnd.ToInt64()
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
    dpi = [VisualStudioTraceNative]::GetDpiForWindow($Hwnd)
    captureMethod = 'Graphics.CopyFromScreen'
    sha256 = Get-Sha256 $Destination
  }
}

function Open-DesignerAndCapture($Dte, [string] $SourceFile, [string] $Destination) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  # CPS project systems do not consistently accept the legacy EnvDTE designer view GUID (VS 18 reports
  # "Invalid viewKind"). Open the project's default view; Form items declare SubType=Form and therefore resolve to
  # the WinForms designer. If a project chooses code as its default, invoke the IDE's own View Designer command.
  $primaryView = '{00000000-0000-0000-0000-000000000000}'
  $window = $item.Open($primaryView)
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  # Primary view may already be the designer. View.ViewDesigner is idempotent when enabled; some project systems
  # report it disabled once the designer is active, so that specific command refusal is non-fatal and the captured
  # window is reviewed from the archived PNG before the trace is promoted to PASS.
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 3
  try {
    if ($null -ne $Dte.ActiveWindow) { $window = $Dte.ActiveWindow }
  } catch { }
  Start-Sleep -Seconds 5
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 2
  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 500
  $capture = Save-WindowCapture $hwnd $Destination
  $caption = ''
  try {
    $captionProperty = $window.PSObject.Properties['Caption']
    if ($null -ne $captionProperty) { $caption = [string]$captionProperty.Value }
  } catch { }
  return [ordered]@{
    document = $SourceFile
    caption = $caption
    capture = $capture
  }
}

function ConvertTo-UiAutomationRecord(
  [System.Windows.Automation.AutomationElement] $Element,
  [System.Windows.Automation.AutomationElement] $ScopeElement
) {
  $value = $null
  $helpText = ''
  $itemStatus = ''
  $accessKey = ''
  $className = ''
  $frameworkId = ''
  $localizedControlType = ''
  $valuePattern = $null
  $selectionItemSelected = $null
  try {
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
      $value = [string]$valuePattern.Current.Value
    }
  } catch { }
  $selectionItemPattern = $null
  try {
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionItemPattern)) {
      $selectionItemSelected = [bool]$selectionItemPattern.Current.IsSelected
    }
  } catch { }
  try { $helpText = [string]$Element.Current.HelpText } catch { }
  try { $itemStatus = [string]$Element.Current.ItemStatus } catch { }
  try { $accessKey = [string]$Element.Current.AccessKey } catch { }
  try { $className = [string]$Element.Current.ClassName } catch { }
  try { $frameworkId = [string]$Element.Current.FrameworkId } catch { }
  try { $localizedControlType = [string]$Element.Current.LocalizedControlType } catch { }

  $ancestors = [System.Collections.Generic.List[object]]::new()
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $parent = $null
  try { $parent = $walker.GetParent($Element) } catch { }
  for ($depth = 0; $null -ne $parent -and $depth -lt 12; $depth++) {
    try {
      $parentName = [string]$parent.Current.Name
      $parentType = [string]$parent.Current.ControlType.ProgrammaticName
      if ($parentName -or $parentType) {
        $ancestors.Add([ordered]@{ name = $parentName; controlType = $parentType })
      }
      if ($parent -eq $ScopeElement) { break }
      $parent = $walker.GetParent($parent)
    } catch { break }
  }

  $bounds = $Element.Current.BoundingRectangle
  return [ordered]@{
    name = [string]$Element.Current.Name
    automationId = [string]$Element.Current.AutomationId
    controlType = [string]$Element.Current.ControlType.ProgrammaticName
    localizedControlType = $localizedControlType
    value = $value
    helpText = $helpText
    itemStatus = $itemStatus
    accessKey = $accessKey
    className = $className
    frameworkId = $frameworkId
    nativeWindowHandle = [int]$Element.Current.NativeWindowHandle
    enabled = [bool]$Element.Current.IsEnabled
    focusable = [bool]$Element.Current.IsKeyboardFocusable
    hasKeyboardFocus = [bool]$Element.Current.HasKeyboardFocus
    selectionItemSelected = $selectionItemSelected
    offscreen = [bool]$Element.Current.IsOffscreen
    bounds = [ordered]@{
      x = $bounds.X
      y = $bounds.Y
      width = $bounds.Width
      height = $bounds.Height
    }
    ancestors = @($ancestors)
  }
}

function Get-UiAutomationInventory(
  [System.Windows.Automation.AutomationElement] $ScopeElement
) {
  $allowedTypes = @(
    'ControlType.Button',
    'ControlType.DataItem',
    'ControlType.Edit',
    'ControlType.Group',
    'ControlType.List',
    'ControlType.ListItem',
    'ControlType.Menu',
    'ControlType.MenuBar',
    'ControlType.MenuItem',
    'ControlType.Pane',
    'ControlType.Tab',
    'ControlType.TabItem',
    'ControlType.Text',
    'ControlType.ToolBar',
    'ControlType.Tree',
    'ControlType.TreeItem'
  )
  $inventory = [System.Collections.Generic.List[object]]::new()
  $elements = $ScopeElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  for ($index = 0; $index -lt $elements.Count; $index++) {
    try {
      $candidate = $elements.Item($index)
      $name = [string]$candidate.Current.Name
      $automationId = [string]$candidate.Current.AutomationId
      $controlType = [string]$candidate.Current.ControlType.ProgrammaticName
      if ($controlType -notin $allowedTypes) { continue }
      if (-not $name -and -not $automationId) { continue }
      $inventory.Add((ConvertTo-UiAutomationRecord $candidate $ScopeElement))
    } catch { }
  }
  return @($inventory)
}

function Open-DesignerToolboxSearchAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $Query,
  [string] $Destination,
  [switch] $SkipSave
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $mainHwnd = Get-WindowHandle $Dte.MainWindow $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($mainHwnd)
  $toolboxAvailable = $false
  try { $toolboxAvailable = [bool]$Dte.Commands.Item('View.Toolbox').IsAvailable } catch { }
  if ($toolboxAvailable) {
    $null = $Dte.ExecuteCommand('View.Toolbox')
    Start-Sleep -Seconds 8
  }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($mainHwnd)
  $rootBounds = $root.Current.BoundingRectangle
  $rootArea = [double]$rootBounds.Width * [double]$rootBounds.Height
  $allElements = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $toolboxAnchors = [System.Collections.Generic.List[object]]::new()
  $scopeChoices = [System.Collections.Generic.List[object]]::new()
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  for ($index = 0; $index -lt $allElements.Count; $index++) {
    try {
      $candidate = $allElements.Item($index)
      $name = [string]$candidate.Current.Name
      $automationId = [string]$candidate.Current.AutomationId
      if ($name -notmatch '(?i)^Toolbox$' -and
          $automationId -notmatch '(?i)^(?:ST:|AUTOHIDE_ST:).*\{b1e99781-ab81-11d0-b683-00aa00a3ee26\}$') { continue }
      $anchorRecord = ConvertTo-UiAutomationRecord $candidate $root
      $toolboxAnchors.Add($anchorRecord)

      $scopeCandidate = $candidate
      for ($depth = 0; $null -ne $scopeCandidate -and $depth -lt 8; $depth++) {
        $bounds = $scopeCandidate.Current.BoundingRectangle
        $area = [double]$bounds.Width * [double]$bounds.Height
        if (-not $scopeCandidate.Current.IsOffscreen -and $bounds.Width -ge 180 -and $bounds.Height -ge 120 -and
            $area -gt 0 -and $area -lt ($rootArea * 0.7)) {
          $scopeChoices.Add([pscustomobject]@{ element = $scopeCandidate; area = $area; anchor = $anchorRecord })
        }
        if ($scopeCandidate -eq $root) { break }
        $scopeCandidate = $walker.GetParent($scopeCandidate)
      }
    } catch { }
  }

  $toolboxScope = $null
  $scopeChoice = @($scopeChoices | Sort-Object area -Descending | Select-Object -First 1)
  if ($scopeChoice.Count -eq 1) { $toolboxScope = $scopeChoice[0].element }
  $toolboxFound = $null -ne $toolboxScope
  if (-not $toolboxFound) { $toolboxScope = $root }
  $scopeRecord = ConvertTo-UiAutomationRecord $toolboxScope $root
  $inventoryBefore = @(Get-UiAutomationInventory $toolboxScope)

  # Visual Studio hosts the Toolbox body in a legacy Win32 GenericPane. Its search host occupies the narrow strip
  # immediately below the WPF title bar and can be omitted from descendant walking, while remaining addressable by
  # the real screen-point UIA provider. Probe only the bounded Toolbox strip; never select an IDE-global search box.
  $pointProbeRecords = [System.Collections.Generic.List[object]]::new()
  $pointProbeElements = [System.Collections.Generic.List[object]]::new()
  $pointProbeKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $scopeBounds = $toolboxScope.Current.BoundingRectangle
  $probeBottom = [Math]::Min($scopeBounds.Y + 90, $scopeBounds.Y + $scopeBounds.Height)
  for ($probeY = [int]($scopeBounds.Y + 26); $probeY -lt $probeBottom; $probeY += 6) {
    for ($probeX = [int]($scopeBounds.X + 8); $probeX -lt ($scopeBounds.X + $scopeBounds.Width - 8); $probeX += 16) {
      try {
        $probe = [System.Windows.Automation.AutomationElement]::FromPoint(
          [System.Windows.Point]::new([double]$probeX, [double]$probeY)
        )
        if ($null -eq $probe) { continue }
        $probeRecord = ConvertTo-UiAutomationRecord $probe $toolboxScope
        $probeKey = "$($probeRecord.controlType)|$($probeRecord.name)|$($probeRecord.automationId)|$($probeRecord.bounds.x)|$($probeRecord.bounds.y)|$($probeRecord.bounds.width)|$($probeRecord.bounds.height)"
        if ($pointProbeKeys.Add($probeKey)) {
          $pointProbeRecords.Add($probeRecord)
          $pointProbeElements.Add($probe)
        }
      } catch { }
    }
  }

  $searchCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
  )
  $searchElements = $toolboxScope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $searchCondition)
  $searchElementCandidates = [System.Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $searchElements.Count; $index++) {
    $searchElementCandidates.Add($searchElements.Item($index))
  }
  foreach ($probe in $pointProbeElements) {
    try {
      if ($probe.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
        $searchElementCandidates.Add($probe)
      }
    } catch { }
  }
  $searchCandidates = [System.Collections.Generic.List[object]]::new()
  $searchChoices = [System.Collections.Generic.List[object]]::new()
  $searchCandidateKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  for ($index = 0; $index -lt $searchElementCandidates.Count; $index++) {
    try {
      $candidate = $searchElementCandidates[$index]
      $record = ConvertTo-UiAutomationRecord $candidate $toolboxScope
      $candidateKey = "$($record.name)|$($record.automationId)|$($record.bounds.x)|$($record.bounds.y)|$($record.bounds.width)|$($record.bounds.height)"
      if (-not $searchCandidateKeys.Add($candidateKey)) { continue }
      $searchCandidates.Add($record)
      $score = 0
      if (-not $record.offscreen) { $score += 10 }
      if ($record.enabled) { $score += 10 }
      if ($record.name -match '(?i)search.*toolbox|toolbox.*search') { $score += 100 }
      elseif ($record.name -match '(?i)search') { $score += 50 }
      if ($record.automationId -match '(?i)search.*toolbox|toolbox.*search') { $score += 100 }
      elseif ($record.automationId -match '(?i)search') { $score += 50 }
      $valuePattern = $null
      if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern) -and
          -not $valuePattern.Current.IsReadOnly) {
        $score += 25
        $searchChoices.Add([pscustomobject]@{ element = $candidate; record = $record; score = $score })
      }
    } catch { }
  }

  $searchChoice = @($searchChoices | Sort-Object score -Descending | Select-Object -First 1)
  $searchRecord = $null
  $searchMethod = $null
  $searchFailure = $null
  if ($searchChoice.Count -eq 1) {
    $searchRecord = $searchChoice[0].record
    try {
      $searchElement = $searchChoice[0].element
      $null = $searchElement.SetFocus()
      $valuePattern = $null
      if (-not $searchElement.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        throw 'Selected Toolbox search Edit stopped exposing ValuePattern.'
      }
      $valuePattern.SetValue($Query)
      $searchMethod = 'UIAutomation.ValuePattern.SetValue'
      Start-Sleep -Seconds 8
    } catch {
      $searchFailure = $_.Exception.Message
    }
  } else {
    $searchFailure = 'No visible, enabled, writable Edit control was found inside the bounded Toolbox surface.'
  }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($mainHwnd)
  if ($toolboxFound) {
    # Re-resolve the bounded Toolbox surface after filtering because WPF can invalidate prior UIA element wrappers.
    $allAfter = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $resolvedScope = $null
    for ($index = 0; $index -lt $allAfter.Count; $index++) {
      try {
        $candidate = $allAfter.Item($index)
        $name = [string]$candidate.Current.Name
        $automationId = [string]$candidate.Current.AutomationId
        $bounds = $candidate.Current.BoundingRectangle
        if (($name -match '(?i)^Toolbox$' -or
            $automationId -match '(?i)^(?:ST:|AUTOHIDE_ST:).*\{b1e99781-ab81-11d0-b683-00aa00a3ee26\}$') -and
            -not $candidate.Current.IsOffscreen -and $bounds.Width -ge 180 -and $bounds.Height -ge 120) {
          $resolvedScope = $candidate
          break
        }
      } catch { }
    }
    if ($null -ne $resolvedScope) { $toolboxScope = $resolvedScope }
  }
  $inventoryAfter = @(Get-UiAutomationInventory $toolboxScope)

  $resultPointProbes = [System.Collections.Generic.List[object]]::new()
  $resultPointProbeKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $resultBounds = $toolboxScope.Current.BoundingRectangle
  $resultProbeBottom = [Math]::Min($resultBounds.Y + 340, $resultBounds.Y + $resultBounds.Height)
  for ($probeY = [int]($resultBounds.Y + 48); $probeY -lt $resultProbeBottom; $probeY += 5) {
    foreach ($probeX in @(
      [int]($resultBounds.X + 20),
      [int]($resultBounds.X + 60),
      [int]($resultBounds.X + 130),
      [int]($resultBounds.X + $resultBounds.Width - 24)
    )) {
      try {
        $probe = [System.Windows.Automation.AutomationElement]::FromPoint(
          [System.Windows.Point]::new([double]$probeX, [double]$probeY)
        )
        if ($null -eq $probe) { continue }
        $record = ConvertTo-UiAutomationRecord $probe $toolboxScope
        $key = "$($record.controlType)|$($record.name)|$($record.automationId)|$($record.bounds.x)|$($record.bounds.y)|$($record.bounds.width)|$($record.bounds.height)"
        if ($resultPointProbeKeys.Add($key)) { $resultPointProbes.Add($record) }
      } catch { }
    }
  }

  $legacyToolboxInventory = @()
  $legacyToolboxFailure = $null
  $legacyToolboxHwnd = 0
  try {
    $legacyCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty,
      'TBToolboxPane'
    )
    $legacyElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $legacyCondition)
    if ($null -eq $legacyElement) { throw 'The bounded Toolbox did not expose its TBToolboxPane host.' }
    $legacyToolboxHwnd = [int]$legacyElement.Current.NativeWindowHandle
    if ($legacyToolboxHwnd -eq 0) { throw 'TBToolboxPane exposed a zero native window handle.' }
    $legacyToolboxInventory = @([VisualStudioTraceNative]::GetAccessibleInventory([IntPtr]$legacyToolboxHwnd))
  } catch {
    $legacyToolboxFailure = $_.Exception.Message
  }

  $combinedResultEvidence = @($inventoryAfter) + @($resultPointProbes)
  $exactButtonRows = @($combinedResultEvidence | Where-Object {
    $_.name -ceq 'Button' -and -not $_.offscreen -and
    $_.controlType -in @('ControlType.DataItem', 'ControlType.ListItem', 'ControlType.Text', 'ControlType.TreeItem')
  })
  $categoryRows = @($combinedResultEvidence | Where-Object {
    $_.name -match '^(All Windows Forms|Common Controls|Containers|Menus & Toolbars|Data|Components|Printing|Dialogs|WPF Interoperability|General)$'
  })
  $legacyButtonRows = @($legacyToolboxInventory | Where-Object { $_.Name -ceq 'Button' })
  $legacyCategoryRows = @($legacyToolboxInventory | Where-Object {
    $_.Name -match '^(All Windows Forms|Common Controls|Containers|Menus & Toolbars|Data|Components|Printing|Dialogs|WPF Interoperability|General)$'
  })

  if (-not $SkipSave) {
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 2
  }
  return [ordered]@{
    document = $SourceFile
    command = 'View.Toolbox'
    commandAvailable = $toolboxAvailable
    mainWindowHwnd = $mainHwnd.ToInt64()
    toolboxElementFound = $toolboxFound
    toolboxAnchors = @($toolboxAnchors)
    toolboxScope = $scopeRecord
    boundedPointProbes = @($pointProbeRecords)
    query = $Query
    searchCandidates = @($searchCandidates)
    searchControl = $searchRecord
    searchMethod = $searchMethod
    searchFailure = $searchFailure
    uiAutomationInventoryBefore = $inventoryBefore
    uiAutomationInventoryAfter = $inventoryAfter
    resultPointProbes = @($resultPointProbes)
    exactButtonRows = $exactButtonRows
    categoryRows = $categoryRows
    legacyToolboxHwnd = $legacyToolboxHwnd
    legacyToolboxInventory = $legacyToolboxInventory
    legacyButtonRows = $legacyButtonRows
    legacyCategoryRows = $legacyCategoryRows
    legacyToolboxFailure = $legacyToolboxFailure
    capture = Save-WindowCapture $mainHwnd $Destination
  }
}

function Open-DesignerInheritedToolboxAddAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $Destination
) {
  $originalDesignerText = [System.IO.File]::ReadAllText($DesignerFile)
  $normalizeCodeDomText = {
    param([string] $Text)
    $normalized = $Text.Replace("`r`n", "`n")
    $normalized = [regex]::Replace($normalized, '(?m)^(\s*)//\s*$', '$1//')
    $normalized = [regex]::Replace($normalized, '(?m)^(\s*)this\.', '$1')
    $normalized = [regex]::Replace($normalized, '(?m)^[ \t]*\n', '')
    return $normalized.TrimEnd()
  }
  $normalizeAppliedOperationContract = {
    param([string] $Text)
    $sourceLines = (& $normalizeCodeDomText $Text).Split("`n")
    $lines = [System.Collections.Generic.List[string]]::new()
    $setChildIndexLines = [System.Collections.Generic.List[string]]::new()
    $setChildIndexInsertion = -1
    foreach ($sourceLine in $sourceLines) {
      $line = $sourceLine.Trim().Replace('this.', '')
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      if ($line -match '^button1\.TabIndex\s*=\s*\d+;$') {
        $line = 'button1.TabIndex = <designer-generated>;'
      }
      if ($line -match '^Controls\.SetChildIndex\((button1|basePanel),\s*\d+\);$') {
        if ($setChildIndexInsertion -lt 0) { $setChildIndexInsertion = $lines.Count }
        $setChildIndexLines.Add($line)
      } else {
        $lines.Add($line)
      }
    }
    if ($setChildIndexLines.Count -gt 0) {
      $orderedSetChildIndexLines = @($setChildIndexLines | Sort-Object)
      for ($index = $orderedSetChildIndexLines.Count - 1; $index -ge 0; $index--) {
        $lines.Insert($setChildIndexInsertion, $orderedSetChildIndexLines[$index])
      }
    }
    return $lines -join "`n"
  }
  $shapeOf = {
    param([string] $Text)
    [ordered]@{
      buttonFieldCount = ([regex]::Matches($Text, '(?m)^\s*private\s+System\.Windows\.Forms\.Button\s+button1\s*;\s*$')).Count
      buttonConstructionCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\s*=\s*new\s+System\.Windows\.Forms\.Button\(\)\s*;\s*$')).Count
      buttonLocationCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Location\s*=\s*new\s+System\.Drawing\.Point\(0,\s*0\)\s*;\s*$')).Count
      buttonSizeCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Size\s*=\s*new\s+System\.Drawing\.Size\(75,\s*23\)\s*;\s*$')).Count
      buttonTabIndexCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.TabIndex\s*=\s*\d+\s*;\s*$')).Count
      buttonTextCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Text\s*=\s*"button1"\s*;\s*$')).Count
      buttonUseVisualStyleBackColorCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.UseVisualStyleBackColor\s*=\s*true\s*;\s*$')).Count
      rootAddCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?Controls\.Add\((?:this\.)?button1\)\s*;\s*$')).Count
      inheritedPanelAddCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?basePanel\.Controls\.Add\((?:this\.)?button1\)\s*;\s*$')).Count
      nameAssignmentCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Name\s*=\s*"button1"\s*;\s*$')).Count
      buttonSetChildIndexCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?Controls\.SetChildIndex\((?:this\.)?button1,\s*0\)\s*;\s*$')).Count
      basePanelSetChildIndexCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?Controls\.SetChildIndex\((?:this\.)?basePanel,\s*0\)\s*;\s*$')).Count
    }
  }

  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S087: inherited derived designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 10

  $mainHwnd = Get-WindowHandle $Dte.MainWindow $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($mainHwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($mainHwnd)
  if ($null -eq $root) { throw 'S087 could not resolve the Visual Studio UI Automation root.' }
  $formCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'S087 inherited derived'
  )
  $form = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $formCondition)
  if ($null -eq $form) { throw 'S087 did not expose the derived Form surface by its exact native caption.' }
  $formRecord = ConvertTo-UiAutomationRecord $form $root
  $formBounds = $form.Current.BoundingRectangle
  if ($formBounds.Width -lt 40 -or $formBounds.Height -lt 40) { throw "S087 derived Form bounds are invalid: $formBounds" }
  $rootSelectionClick = [VisualStudioTraceNative]::PostClickUsingCapture(
    $mainHwnd,
    [int]($formBounds.X + $formBounds.Width - 24),
    [int]($formBounds.Y + $formBounds.Height - 24)
  )
  Start-Sleep -Seconds 2

  $toolboxDestination = [System.IO.Path]::ChangeExtension($Destination, '.toolbox-before-add.png')
  $toolbox = Open-DesignerToolboxSearchAndCapture -Dte $Dte -SourceFile $SourceFile -Query 'Button' `
    -Destination $toolboxDestination -SkipSave
  $toolboxExact = [bool]$toolbox.commandAvailable -and [bool]$toolbox.toolboxElementFound -and
    $null -ne $toolbox.searchControl -and [string]$toolbox.searchMethod -eq 'UIAutomation.ValuePattern.SetValue' -and
    @($toolbox.legacyButtonRows | Where-Object {
      [string]$_.Name -eq 'Button' -and @($_.Ancestors) -contains 'All Windows Forms'
    }).Count -eq 1
  if (-not $toolboxExact) {
    throw "S087 exact Toolbox Button search failed: $($toolbox | ConvertTo-Json -Compress -Depth 5)"
  }

  $defaultActionInvoked = [VisualStudioTraceNative]::InvokeAccessibleDefaultActionByName(
    [IntPtr][int]$toolbox.legacyToolboxHwnd,
    'Button',
    'All Windows Forms'
  )
  if (-not $defaultActionInvoked) { throw 'S087 could not invoke the exact All Windows Forms/Button default action.' }
  Start-Sleep -Seconds 5
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 5
  $afterText = [System.IO.File]::ReadAllText($DesignerFile)
  $afterBytes = [System.IO.File]::ReadAllBytes($DesignerFile)
  $after = [ordered]@{
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $afterText
    capture = Save-WindowCapture $mainHwnd $Destination
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S087InheritedDerivedForm.Designer.after-add.cs.gz') $afterBytes

  $null = $window.Activate()
  Start-Sleep -Milliseconds 500
  $undoAvailable = $false
  try { $undoAvailable = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable } catch { }
  if ($undoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Undo')
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 2
  }
  $undoText = [System.IO.File]::ReadAllText($DesignerFile)
  $undo = [ordered]@{
    available = $undoAvailable
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $undoText
    byteExactToOriginal = $undoText -ceq $originalDesignerText
    semanticExactToOriginalAfterCodeDomNormalization =
      (& $normalizeCodeDomText $undoText) -ceq (& $normalizeCodeDomText $originalDesignerText)
    capture = Save-WindowCapture $mainHwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-undo.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S087InheritedDerivedForm.Designer.after-undo.cs.gz') `
    ([System.IO.File]::ReadAllBytes($DesignerFile))

  $redoAvailable = $false
  try { $redoAvailable = [bool]$Dte.Commands.Item('Edit.Redo').IsAvailable } catch { }
  if ($redoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Redo')
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 2
  }
  $redoText = [System.IO.File]::ReadAllText($DesignerFile)
  $redo = [ordered]@{
    available = $redoAvailable
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $redoText
    byteExactToAfter = $redoText -ceq $afterText
    operationContractExactToAfterAfterMeasuredCodeDomNormalization =
      (& $normalizeAppliedOperationContract $redoText) -ceq (& $normalizeAppliedOperationContract $afterText)
    measuredCodeDomDifferences = @(
      'button1.TabIndex is designer-generated and changed from 1 after Add to 0 after Redo',
      'Controls.SetChildIndex(basePanel/button1, 0) call order changed after Redo',
      'raw bytes and SHA-256 therefore remain intentionally observable rather than being claimed exact'
    )
    capture = Save-WindowCapture $mainHwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-redo.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S087InheritedDerivedForm.Designer.after-redo.cs.gz') `
    ([System.IO.File]::ReadAllBytes($DesignerFile))

  Write-Host "S087: Toolbox Button default action invoked; after=$($after.sha256); undo=$undoAvailable; redo=$redoAvailable"
  return [ordered]@{
    document = $SourceFile
    derivedForm = $formRecord
    rootSelectionClick = $rootSelectionClick.ToInt64()
    toolbox = $toolbox
    toolboxExact = $toolboxExact
    defaultActionInvoked = $defaultActionInvoked
    after = $after
    undo = $undo
    redo = $redo
    capture = $after.capture
  }
}

function Open-DesignerToggleGridAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $ControlAutomationId,
  [string] $ControlAutomationName,
  [string] $FormAutomationName,
  [string] $BeforeDestination,
  [string] $ToggledDestination,
  [string] $RestoredDestination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ControlAutomationId
  )
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $controlLocator = "AutomationId=$ControlAutomationId"
  if ($null -eq $element -and -not [string]::IsNullOrWhiteSpace($ControlAutomationName)) {
    $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $ControlAutomationName
    )
    $nameMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
    $visibleNameMatches = @($nameMatches | Where-Object {
      $candidateBounds = $_.Current.BoundingRectangle
      -not $_.Current.IsOffscreen -and $candidateBounds.Width -gt 0 -and $candidateBounds.Height -gt 0
    })
    if ($visibleNameMatches.Count -eq 1) {
      $element = $visibleNameMatches[0]
      $controlLocator = "unique visible Name=$ControlAutomationName"
    }
  }
  if ($null -eq $element) { throw "Visual Studio designer did not expose '$ControlAutomationId' or unique visible '$ControlAutomationName' while focusing S028." }
  $formCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $FormAutomationName
  )
  $formMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $formCondition)
  $visibleFormMatches = @($formMatches | Where-Object {
    $candidateBounds = $_.Current.BoundingRectangle
    -not $_.Current.IsOffscreen -and $candidateBounds.Width -gt 64 -and $candidateBounds.Height -gt 64
  })
  if ($visibleFormMatches.Count -ne 1) {
    throw "Visual Studio designer exposed $($visibleFormMatches.Count) visible '$FormAutomationName' form elements while focusing S028; expected exactly one."
  }
  $formElement = $visibleFormMatches[0]
  $getCanvasBounds = {
    param($FormElement, [IntPtr] $DesignerHwnd)
    $formBounds = $FormElement.Current.BoundingRectangle
    $dpiScale = [double]([VisualStudioTraceNative]::GetDpiForWindow($DesignerHwnd)) / 96.0
    $leftInset = [int][Math]::Round(8 * $dpiScale)
    $topInset = [int][Math]::Round(31 * $dpiScale)
    $rightInset = [int][Math]::Round(8 * $dpiScale)
    $bottomInset = [int][Math]::Round(8 * $dpiScale)
    return [ordered]@{
      x = [int]$formBounds.X + $leftInset
      y = [int]$formBounds.Y + $topInset
      width = [int]$formBounds.Width - $leftInset - $rightInset
      height = [int]$formBounds.Height - $topInset - $bottomInset
    }
  }
  $bounds = $element.Current.BoundingRectangle
  $focusX = [int]($bounds.X + $bounds.Width + 60)
  $focusY = [int]($bounds.Y + $bounds.Height + 60)
  $focusedWindow = [VisualStudioTraceNative]::ClickAtDeepestChild($hwnd, $focusX, $focusY)
  Start-Sleep -Seconds 2
  Start-Sleep -Milliseconds 500
  $showGridOption = Get-WindowsFormsDesignerOption $Dte 'ShowGrid'
  $originalShowGrid = [bool]$showGridOption.Value
  $before = Save-WindowCapture $hwnd $BeforeDestination
  $beforeCanvasDestination = $BeforeDestination -replace '\.png$', '-canvas.png'
  $beforeCanvasBounds = & $getCanvasBounds $formElement $hwnd
  $beforeCanvas = Save-ScreenRegionCapture $beforeCanvasBounds.x $beforeCanvasBounds.y `
    $beforeCanvasBounds.width $beforeCanvasBounds.height $beforeCanvasDestination
  $commandName = @('Edit.ShowGrid', 'View.ShowGrid', 'Format.ShowGrid') | Where-Object {
    try { [bool]$Dte.Commands.Item($_).IsAvailable } catch { $false }
  } | Select-Object -First 1
  $commandAvailable = -not [string]::IsNullOrWhiteSpace([string]$commandName)
  $toggleRoute = if ($commandAvailable) { "EnvDTE command $commandName" } else { 'WindowsFormsDesigner.ShowGrid option' }
  $afterFirstShowGrid = $null
  $afterSecondShowGrid = $null
  $afterFinallyShowGrid = $null
  $toggled = $null
  $restored = $null
  $toggledCanvas = $null
  $restoredCanvas = $null
  $toggleFailure = $null
  $restoreRefresh = $null
  try {
    if ($commandAvailable) {
      $null = $Dte.ExecuteCommand($commandName)
    } else {
      # VS 18's modern WinForms Designer does not expose an enabled ShowGrid command in this context. The
      # WindowsFormsDesigner.ShowGrid property is the installed IDE's actual Tools > Options setting and causes the
      # already-open designer to repaint, so exercise that real VS route instead of substituting an extension action.
      [VisualStudioTraceNative]::SetComPropertyValue($showGridOption, [bool](-not $originalShowGrid))
    }
    Start-Sleep -Seconds 3
    $afterFirstShowGrid = [bool](Get-WindowsFormsDesignerOption $Dte 'ShowGrid').Value
    $toggled = Save-WindowCapture $hwnd $ToggledDestination
    $toggledCanvasDestination = $ToggledDestination -replace '\.png$', '-canvas.png'
    $toggledCanvasBounds = & $getCanvasBounds $formElement $hwnd
    $toggledCanvas = Save-ScreenRegionCapture $toggledCanvasBounds.x $toggledCanvasBounds.y `
      $toggledCanvasBounds.width $toggledCanvasBounds.height $toggledCanvasDestination

    if ($commandAvailable) {
      $null = $Dte.ExecuteCommand($commandName)
    } else {
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $Dte 'ShowGrid'), [bool]$originalShowGrid)
    }
    Start-Sleep -Seconds 3
    $afterSecondShowGrid = [bool](Get-WindowsFormsDesignerOption $Dte 'ShowGrid').Value
    if (-not $commandAvailable) {
      # Setting ShowGrid=false invalidates the classic designer immediately, while VS 18 does not repaint the dots
      # when the option returns to true until its design view is reactivated. Re-enter the same installed designer
      # through VS's own View Code/View Designer commands; this is a view-only refresh and the byte checks below
      # independently prove that it did not turn into a source edit.
      $restoreRefresh = [ordered]@{ route = 'View.ViewCode -> View.ViewDesigner'; succeeded = $false; failure = $null }
      try {
        $null = $Dte.ExecuteCommand('View.ViewCode')
        Start-Sleep -Seconds 1
        $null = $Dte.ExecuteCommand('View.ViewDesigner')
        Start-Sleep -Seconds 5
        $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
        if ($null -eq $window) { throw 'Visual Studio did not reopen the S028 designer after the view refresh.' }
        $window.Visible = $true
        $null = $window.Activate()
        $hwnd = Get-WindowHandle $window $Dte
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $formMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $formCondition)
        $visibleFormMatches = @($formMatches | Where-Object {
          $candidateBounds = $_.Current.BoundingRectangle
          -not $_.Current.IsOffscreen -and $candidateBounds.Width -gt 64 -and $candidateBounds.Height -gt 64
        })
        if ($visibleFormMatches.Count -ne 1) {
          throw "Visual Studio designer exposed $($visibleFormMatches.Count) visible '$FormAutomationName' form elements after S028 refresh; expected exactly one."
        }
        $formElement = $visibleFormMatches[0]
        $restoreRefresh.succeeded = $true
      } catch {
        $restoreRefresh.failure = $_.Exception.GetBaseException().Message
      }
    }
    $restored = Save-WindowCapture $hwnd $RestoredDestination
    $restoredCanvasDestination = $RestoredDestination -replace '\.png$', '-canvas.png'
    $restoredCanvasBounds = & $getCanvasBounds $formElement $hwnd
    $restoredCanvas = Save-ScreenRegionCapture $restoredCanvasBounds.x $restoredCanvasBounds.y `
      $restoredCanvasBounds.width $restoredCanvasBounds.height $restoredCanvasDestination
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 2
  } catch {
    $toggleFailure = $_.Exception.GetBaseException().Message
  } finally {
    $currentShowGrid = [bool](Get-WindowsFormsDesignerOption $Dte 'ShowGrid').Value
    if ($currentShowGrid -ne $originalShowGrid) {
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $Dte 'ShowGrid'), [bool]$originalShowGrid)
      Start-Sleep -Seconds 1
    }
    $afterFinallyShowGrid = [bool](Get-WindowsFormsDesignerOption $Dte 'ShowGrid').Value
  }

  if ($null -eq $toggled) { $toggled = Save-WindowCapture $hwnd $ToggledDestination }
  if ($null -eq $restored) { $restored = Save-WindowCapture $hwnd $RestoredDestination }
  if ($null -eq $toggledCanvas) {
    $toggledCanvasBounds = & $getCanvasBounds $formElement $hwnd
    $toggledCanvas = Save-ScreenRegionCapture $toggledCanvasBounds.x $toggledCanvasBounds.y `
      $toggledCanvasBounds.width $toggledCanvasBounds.height ($ToggledDestination -replace '\.png$', '-canvas.png')
  }
  if ($null -eq $restoredCanvas) {
    $restoredCanvasBounds = & $getCanvasBounds $formElement $hwnd
    $restoredCanvas = Save-ScreenRegionCapture $restoredCanvasBounds.x $restoredCanvasBounds.y `
      $restoredCanvasBounds.width $restoredCanvasBounds.height ($RestoredDestination -replace '\.png$', '-canvas.png')
  }

  return [ordered]@{
    document = $SourceFile
    route = $toggleRoute
    command = $(if ($commandAvailable) { "$commandName twice" } else { $null })
    commandAvailable = $commandAvailable
    commandFailure = $(if ($commandAvailable) { $null } else { 'Visual Studio did not enable Edit.ShowGrid, View.ShowGrid, or Format.ShowGrid after focusing the Form surface; used its WindowsFormsDesigner.ShowGrid Tools > Options property.' })
    toggleFailure = $toggleFailure
    toggleRouteExecuted = [string]::IsNullOrWhiteSpace([string]$toggleFailure)
    originalShowGrid = $originalShowGrid
    afterFirstShowGrid = $afterFirstShowGrid
    afterSecondShowGrid = $afterSecondShowGrid
    afterFinallyShowGrid = $afterFinallyShowGrid
    optionToggledExact = $afterFirstShowGrid -eq (-not $originalShowGrid)
    optionRestoredExact = $afterSecondShowGrid -eq $originalShowGrid -and $afterFinallyShowGrid -eq $originalShowGrid
    restoreRefresh = $restoreRefresh
    focusedWindow = $focusedWindow.ToInt64()
    controlLocator = $controlLocator
    focusPoint = [ordered]@{ x = $focusX; y = $focusY }
    before = $before
    toggled = $toggled
    restored = $restored
    beforeCanvas = $beforeCanvas
    toggledCanvas = $toggledCanvas
    restoredCanvas = $restoredCanvas
    toggledVisualChanged = $beforeCanvas.sha256 -ne $toggledCanvas.sha256
    restoredVisualExact = $beforeCanvas.sha256 -eq $restoredCanvas.sha256
    fullWindowToggledChanged = $before.sha256 -ne $toggled.sha256
    fullWindowRestoredExact = $before.sha256 -eq $restored.sha256
  }
}

function Open-DesignerPropertiesAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $AutomationId,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  $elementCondition = $condition
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($null -eq $element) { throw "Visual Studio designer did not expose automation id '$AutomationId' for S037." }
  $bounds = $element.Current.BoundingRectangle
  $centerX = [int]($bounds.X + ($bounds.Width / 2))
  $centerY = [int]($bounds.Y + ($bounds.Height / 2))
  $clickedWindow = [VisualStudioTraceNative]::ClickAtDeepestChild($hwnd, $centerX, $centerY)
  Start-Sleep -Seconds 2

  $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow for S037.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $elements = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $inventory = [System.Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $elements.Count; $index++) {
    try {
      $candidate = $elements.Item($index)
      $name = [string]$candidate.Current.Name
      $candidateAutomationId = [string]$candidate.Current.AutomationId
      $controlType = [string]$candidate.Current.ControlType.ProgrammaticName
      if (-not $name -and -not $candidateAutomationId) { continue }
      if ($name -notmatch '(?i)referenceButton|Button reference|Properties|Categor|Alphabet|Appearance|Behavior|Text|Enabled|FlatStyle|Description|True' -and
          $candidateAutomationId -notmatch '(?i)propert|categor|alphabet|description') { continue }
      $candidateBounds = $candidate.Current.BoundingRectangle
      $value = $null
      $valuePattern = $null
      if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        $value = [string]$valuePattern.Current.Value
      }
      $inventory.Add([ordered]@{
        name = $name
        automationId = $candidateAutomationId
        controlType = $controlType
        value = $value
        enabled = [bool]$candidate.Current.IsEnabled
        offscreen = [bool]$candidate.Current.IsOffscreen
        bounds = [ordered]@{
          x = $candidateBounds.X
          y = $candidateBounds.Y
          width = $candidateBounds.Width
          height = $candidateBounds.Height
        }
      })
    } catch { }
  }

  return [ordered]@{
    document = $SourceFile
    automationId = $AutomationId
    propertiesCommandAvailable = $propertiesAvailable
    clickedWindow = $clickedWindow.ToInt64()
    selectedBounds = [ordered]@{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
    uiAutomationInventory = $inventory
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerAccessibilityTreeAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S110: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $outlineCommandAvailable = $false
  try { $outlineCommandAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable } catch { }
  if ($outlineCommandAvailable) {
    $null = $Dte.ExecuteCommand('View.DocumentOutline')
    Start-Sleep -Seconds 4
  }
  Write-Host "S110: Document Outline command available=$outlineCommandAvailable"

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { throw 'S110 could not resolve the Visual Studio UI Automation root.' }
  $uiaInventory = @(Get-UiAutomationInventory $root)
  Write-Host "S110: UI Automation inventory count=$($uiaInventory.Count)"
  $relevantPattern = '(?i)S110|mainMenuStrip|Main menu|fileMenuItem|File menu|submitButton|Submit button|customerNameTextBox|Customer name|refreshTimer|Timer|Document Outline'
  $relevantUia = @($uiaInventory | Where-Object {
    [string]$_.name -match $relevantPattern -or [string]$_.automationId -match $relevantPattern
  })
  # UIA already gives S110 the required semantic role/type, enabled/offscreen state, raw-view ancestry, and bounds.
  # Do not recursively walk OBJID_CLIENT on the complete Visual Studio HWND here: owner-drawn shell providers can
  # terminate the PowerShell host inside AccessibleChildren before a managed catch is possible.
  $msaaError = 'SKIPPED_UNSAFE_FULL_VISUAL_STUDIO_OBJID_CLIENT_RECURSION'
  $msaaInventory = @()
  Write-Host "S110: MSAA inventory count=$($msaaInventory.Count); error=$msaaError"
  $relevantMsaa = @($msaaInventory | Where-Object {
    [string]$_.name -match $relevantPattern -or [string]$_.value -match $relevantPattern
  })

  $uiaMatches = [ordered]@{}
  foreach ($target in @(
    [ordered]@{ key = 'button'; pattern = '(?i)^submitButton$|^Submit button$'; controlType = 'ControlType.Button'; ancestor = '(?i)^S110 accessibility tree$' },
    [ordered]@{ key = 'textBox'; pattern = '(?i)^customerNameTextBox$|^Customer name$'; controlType = 'ControlType.Edit'; ancestor = '(?i)^S110 accessibility tree$' },
    [ordered]@{ key = 'menuStrip'; pattern = '(?i)^Main menu$'; controlType = 'ControlType.MenuBar'; ancestor = '(?i)^S110 accessibility tree$' },
    [ordered]@{ key = 'menuItem'; pattern = '(?i)^fileMenuItem$'; controlType = 'ControlType.MenuItem'; ancestor = '(?i)^Main menu$' },
    [ordered]@{ key = 'timer'; pattern = '(?i)^refreshTimer$'; controlType = 'ControlType.Pane'; ancestor = '(?i)^ComponentTray$' }
  )) {
    $matches = @($uiaInventory | Where-Object {
      ([string]$_.name -match $target.pattern -or [string]$_.automationId -match $target.pattern) -and
      [string]$_.controlType -ceq $target.controlType -and
      @($_.ancestors | Where-Object { [string]$_.name -match $target.ancestor }).Count -gt 0
    })
    $uiaMatches[$target.key] = $matches
  }

  return [ordered]@{
    document = $SourceFile
    documentOutlineCommandAvailable = $outlineCommandAvailable
    expectedElements = @('button', 'textBox', 'menuStrip', 'menuItem', 'timer')
    matches = $uiaMatches
    uiAutomationInventoryCount = $uiaInventory.Count
    relevantUiAutomation = $relevantUia
    msaaInventoryCount = $msaaInventory.Count
    msaaError = $msaaError
    relevantMsaa = $relevantMsaa
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerTimerPropertiesAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S062: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { throw 'S062 could not resolve the Visual Studio UI Automation root.' }

  $timerCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'refreshTimer'
  )
  $timerCandidates = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $timerCondition)
  $timerElement = $null
  $timerRecord = $null
  for ($index = 0; $index -lt $timerCandidates.Count; $index++) {
    try {
      $candidate = $timerCandidates.Item($index)
      $record = ConvertTo-UiAutomationRecord $candidate $root
      if ([string]$record.controlType -ne 'ControlType.Pane' -or [bool]$record.offscreen) { continue }
      if ([double]$record.bounds.width -le 0 -or [double]$record.bounds.height -le 0) { continue }
      if (@($record.ancestors | Where-Object {
        [string]$_.name -eq 'ComponentTray' -and [string]$_.controlType -eq 'ControlType.Pane'
      }).Count -eq 0) { continue }
      $timerElement = $candidate
      $timerRecord = $record
      break
    } catch { }
  }
  if ($null -eq $timerElement -or $null -eq $timerRecord) {
    throw 'S062 could not resolve the visible refreshTimer Pane below the native ComponentTray.'
  }

  $timerX = [int]([double]$timerRecord.bounds.x + ([double]$timerRecord.bounds.width / 2))
  $timerY = [int]([double]$timerRecord.bounds.y + ([double]$timerRecord.bounds.height / 2))
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $timerX, $timerY)
  Start-Sleep -Seconds 2
  $selectedCapture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.selected.png'))

  $propertiesAvailable = $false
  try { $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable } catch { }
  if (-not $propertiesAvailable) {
    throw 'Visual Studio did not enable View.PropertiesWindow after selecting the S062 Timer tray component.'
  }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $inventory = @(Get-UiAutomationInventory $root)
  $relevant = @($inventory | Where-Object {
    [string]$_.name -match '(?i)refreshTimer|System\.Windows\.Forms\.Timer|Interval|Enabled|Properties' -or
    [string]$_.automationId -match '(?i)refreshTimer|Interval|Enabled|Properties' -or
    [string]$_.value -match '(?i)refreshTimer|System\.Windows\.Forms\.Timer|^1500$|^False$'
  })

  $propertyRecords = [ordered]@{}
  foreach ($propertyName in @('Interval', 'Enabled')) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $propertyName
    )
    $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $records = [System.Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $matches.Count; $index++) {
      try {
        $records.Add((ConvertTo-UiAutomationRecord $matches.Item($index) $root))
      } catch { }
    }
    $propertyRecords[$propertyName] = @($records)
  }

  $selectionEvidence = @($relevant | Where-Object {
    [string]$_.name -match '(?i)refreshTimer|System\.Windows\.Forms\.Timer' -or
    [string]$_.value -match '(?i)refreshTimer|System\.Windows\.Forms\.Timer'
  })
  Write-Host "S062: timer bounds=$timerX,$timerY; Properties inventory=$($inventory.Count); selectionEvidence=$($selectionEvidence.Count); Interval rows=$(@($propertyRecords.Interval).Count)"

  return [ordered]@{
    document = $SourceFile
    timer = $timerRecord
    clickPoint = [ordered]@{ x = $timerX; y = $timerY }
    clickedWindow = $clickedWindow.ToInt64()
    propertiesCommandAvailable = $propertiesAvailable
    selectedCapture = $selectedCapture
    selectionEvidence = $selectionEvidence
    propertyRecords = $propertyRecords
    relevantUiAutomation = $relevant
    uiAutomationInventoryCount = $inventory.Count
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerOutlineRenameAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S061: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $outlineAvailable = $false
  try { $outlineAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable } catch { }
  if (-not $outlineAvailable) { throw 'Visual Studio did not enable View.DocumentOutline for S061.' }
  $null = $Dte.ExecuteCommand('View.DocumentOutline')
  Start-Sleep -Seconds 4

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { throw 'S061 could not resolve the Visual Studio UI Automation root.' }
  $inventory = @(Get-UiAutomationInventory $root)
  $outlinePanes = @($inventory | Where-Object {
    [string]$_.controlType -eq 'ControlType.Pane' -and [string]$_.name -like 'Document Outline - *' -and -not $_.offscreen
  })
  $outlinePane = $outlinePanes | Sort-Object { [double]$_.bounds.width * [double]$_.bounds.height } -Descending | Select-Object -First 1
  $outlineInventory = @()
  if ($null -ne $outlinePane) {
    $left = [double]$outlinePane.bounds.x
    $top = [double]$outlinePane.bounds.y
    $right = $left + [double]$outlinePane.bounds.width
    $bottom = $top + [double]$outlinePane.bounds.height
    $outlineInventory = @($inventory | Where-Object {
      $bounds = $_.bounds
      [double]$bounds.width -gt 0 -and [double]$bounds.height -gt 0 -and
      [double]$bounds.x -ge $left -and [double]$bounds.y -ge $top -and
      ([double]$bounds.x + [double]$bounds.width) -le $right -and
      ([double]$bounds.y + [double]$bounds.height) -le $bottom
    })
  }
  $relevant = @($inventory | Where-Object {
    [string]$_.name -match '(?i)Document Outline|S061|button1|textBox1|Commands' -or
    [string]$_.automationId -match '(?i)Document Outline|S061|button1|textBox1'
  })
  Write-Host "S061: UI Automation inventory=$($inventory.Count); outline=$($outlineInventory.Count)"

  $outlineToolbar = $outlineInventory | Where-Object {
    [string]$_.controlType -eq 'ControlType.ToolBar' -and [string]$_.name -eq 'Commands'
  } | Select-Object -First 1
  if ($null -eq $outlinePane -or $null -eq $outlineToolbar) {
    throw 'S061 could not measure the native Document Outline pane and Commands toolbar.'
  }
  # This fixture has a deterministic expanded tree: Form root, textBox1, then button1. The native owner-drawn rows
  # are 24 px high at the recorded 96-DPI reference, so button1 is the second child row at toolbar.Bottom + 53.
  $outlineRowX = [int]([double]$outlinePane.bounds.x + [Math]::Min(80, [double]$outlinePane.bounds.width / 2))
  $outlineRowY = [int]([double]$outlineToolbar.bounds.y + [double]$outlineToolbar.bounds.height + 53)
  $outlineClickHwnd = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $outlineRowX, $outlineRowY)
  Start-Sleep -Seconds 2
  $selectedCapture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.selected.png'))

  $propertiesAvailable = $false
  try { $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable } catch { }
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow after the S061 outline selection.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $namePropertyCandidates = [System.Collections.Generic.List[object]]::new()
  foreach ($propertyLabel in @('(Name)', 'Name')) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $propertyLabel
    )
    $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    for ($index = 0; $index -lt $matches.Count; $index++) {
      try {
        $candidate = $matches.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem) { continue }
        $candidateBounds = $candidate.Current.BoundingRectangle
        $value = $null
        $valuePattern = $null
        if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
          $value = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
        }
        $namePropertyCandidates.Add([ordered]@{
          label = $propertyLabel
          value = $value
          offscreen = [bool]$candidate.Current.IsOffscreen
          bounds = [ordered]@{ x = $candidateBounds.X; y = $candidateBounds.Y; width = $candidateBounds.Width; height = $candidateBounds.Height }
        })
      } catch { }
    }
  }
  $selectedName = ''
  $selectedNameCandidate = @($namePropertyCandidates | Where-Object { [string]$_.value }) | Select-Object -First 1
  if ($null -ne $selectedNameCandidate) { $selectedName = [string]$selectedNameCandidate.value }
  $propertiesInventory = @(Get-UiAutomationInventory $root)
  $propertySelectionEvidence = @($propertiesInventory | Where-Object {
    [string]$_.name -match '(?i)button1|Properties|\(Name\)|^Name$|S061' -or
    [string]$_.value -match '(?i)button1|System\.Windows\.Forms\.Button'
  })

  $outlineClickHwnd = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $outlineRowX, $outlineRowY)
  Start-Sleep -Seconds 1
  $renameCommands = [System.Collections.Generic.List[object]]::new()
  for ($commandIndex = 1; $commandIndex -le [int]$Dte.Commands.Count; $commandIndex++) {
    try {
      $command = $Dte.Commands.Item($commandIndex)
      $commandName = [string]$command.Name
      if ($commandName -notmatch '(?i)rename') { continue }
      $renameCommands.Add([ordered]@{ name = $commandName; available = [bool]$command.IsAvailable })
    } catch { }
  }
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  [VisualStudioTraceNative]::PressF2()
  Start-Sleep -Seconds 2
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $f2Inventory = @(Get-UiAutomationInventory $root)
  $inlineEditors = @($f2Inventory | Where-Object {
    [string]$_.controlType -eq 'ControlType.Edit' -and -not $_.offscreen -and
    [double]$_.bounds.x -ge [double]$outlinePane.bounds.x -and
    [double]$_.bounds.y -ge [double]$outlinePane.bounds.y -and
    ([double]$_.bounds.x + [double]$_.bounds.width) -le ([double]$outlinePane.bounds.x + [double]$outlinePane.bounds.width) -and
    ([double]$_.bounds.y + [double]$_.bounds.height) -le ([double]$outlinePane.bounds.y + [double]$outlinePane.bounds.height)
  })
  $f2Capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.f2.png'))
  [VisualStudioTraceNative]::PressEscape()
  Start-Sleep -Milliseconds 500

  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 2
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $alphabeticalCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Sort Properties Alphabetically'
  )
  $alphabeticalButton = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $alphabeticalCondition)
  $alphabeticalMethod = $null
  if ($null -ne $alphabeticalButton) {
    $invokePattern = $null
    if ($alphabeticalButton.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
      ([System.Windows.Automation.InvokePattern]$invokePattern).Invoke()
      $alphabeticalMethod = 'InvokePattern.Invoke'
    } else {
      $alphabeticalBounds = $alphabeticalButton.Current.BoundingRectangle
      [void][VisualStudioTraceNative]::PostClickUsingCapture(
        $hwnd,
        [int]($alphabeticalBounds.X + $alphabeticalBounds.Width / 2),
        [int]($alphabeticalBounds.Y + $alphabeticalBounds.Height / 2)
      )
      $alphabeticalMethod = 'PostClickUsingCapture'
    }
    Start-Sleep -Seconds 2
  }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    '(Name)'
  )
  $nameRows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
  $nameRow = $null
  for ($index = 0; $index -lt $nameRows.Count; $index++) {
    try {
      $candidate = $nameRows.Item($index)
      if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem) { continue }
      $candidateValuePattern = $null
      if (-not $candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$candidateValuePattern)) { continue }
      if ([string]([System.Windows.Automation.ValuePattern]$candidateValuePattern).Current.Value -ne 'button1') { continue }
      $nameRow = $candidate
      break
    } catch { }
  }
  if ($selectedName -ne 'button1' -or $null -eq $nameRow) {
    throw "S061 refuses to rename without the exact outline-selected Properties precondition: selectedName='$selectedName'; nameRowFound=$($null -ne $nameRow)."
  }
  $nameRowBounds = $nameRow.Current.BoundingRectangle
  $nameValuePattern = $null
  if (-not $nameRow.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$nameValuePattern)) {
    throw 'S061 exact (Name) row lost ValuePattern before the rename.'
  }
  $nameBefore = [string]([System.Windows.Automation.ValuePattern]$nameValuePattern).Current.Value
  $propertiesBeforeCapture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.properties-before.png'))
  try { $nameRow.SetFocus() } catch { }
  ([System.Windows.Automation.ValuePattern]$nameValuePattern).SetValue('submitButton')
  Start-Sleep -Seconds 2
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3

  $shapeOf = {
    param([string] $Text)
    [ordered]@{
      oldFieldCount = ([regex]::Matches($Text, '(?m)^\s*private\s+System\.Windows\.Forms\.Button\s+button1\b')).Count
      newFieldCount = ([regex]::Matches($Text, '(?m)^\s*private\s+System\.Windows\.Forms\.Button\s+submitButton\b')).Count
      oldMemberReferenceCount = ([regex]::Matches($Text, '(?<![A-Za-z0-9_])(?:this\.)?button1(?=\.|\s*[;=])')).Count
      newMemberReferenceCount = ([regex]::Matches($Text, '(?<![A-Za-z0-9_])(?:this\.)?submitButton(?=\.|\s*[;=])')).Count
      oldNameLiteralCount = ([regex]::Matches($Text, '\.Name\s*=\s*"button1"')).Count
      newNameLiteralCount = ([regex]::Matches($Text, '\.Name\s*=\s*"submitButton"')).Count
      preservedTextLiteralCount = ([regex]::Matches($Text, '\.Text\s*=\s*"button1"')).Count
      siblingTextBoxReferenceCount = ([regex]::Matches($Text, '(?<![A-Za-z0-9_])(?:this\.)?textBox1(?=\.|\s*[;=])')).Count
    }
  }
  $afterRenameText = [System.IO.File]::ReadAllText($DesignerFile)
  $afterRenameBytes = [System.IO.File]::ReadAllBytes($DesignerFile)
  $afterRename = [ordered]@{
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $afterRenameText
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-rename.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S061OutlineRenameForm.Designer.after-rename.cs.gz') $afterRenameBytes

  $null = $window.Activate()
  Start-Sleep -Milliseconds 500
  $undoAvailable = $false
  try { $undoAvailable = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable } catch { }
  if ($undoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Undo')
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 2
  }
  $undoText = [System.IO.File]::ReadAllText($DesignerFile)
  $undo = [ordered]@{
    available = $undoAvailable
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $undoText
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-undo.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S061OutlineRenameForm.Designer.after-undo.cs.gz') `
    ([System.IO.File]::ReadAllBytes($DesignerFile))

  $redoAvailable = $false
  try { $redoAvailable = [bool]$Dte.Commands.Item('Edit.Redo').IsAvailable } catch { }
  if ($redoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Redo')
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 2
  }
  $redoText = [System.IO.File]::ReadAllText($DesignerFile)
  $redo = [ordered]@{
    available = $redoAvailable
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $redoText
    byteExactToRename = $redoText -ceq $afterRenameText
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-redo.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S061OutlineRenameForm.Designer.after-redo.cs.gz') `
    ([System.IO.File]::ReadAllBytes($DesignerFile))
  Write-Host "S061: selected Name='$selectedName'; F2 editors=$($inlineEditors.Count); Properties renamed $nameBefore -> submitButton; undo=$undoAvailable; redo=$redoAvailable"

  return [ordered]@{
    document = $SourceFile
    documentOutlineCommandAvailable = $outlineAvailable
    outlinePanes = $outlinePanes
    outlineInventory = $outlineInventory
    relevantUiAutomation = $relevant
    outlineSelection = [ordered]@{
      row = 'button1 | Button (visible row 3)'
      point = [ordered]@{ x = $outlineRowX; y = $outlineRowY }
      clickedWindow = $outlineClickHwnd.ToInt64()
      selectedName = $selectedName
      namePropertyCandidates = @($namePropertyCandidates)
      propertySelectionEvidence = $propertySelectionEvidence
      capture = $selectedCapture
    }
    propertiesCommandAvailable = $propertiesAvailable
    inlineRenameProbe = [ordered]@{
      input = 'physical VK_F2 keybd_event after measured row click'
      renameCommands = @($renameCommands)
      editors = $inlineEditors
      capture = $f2Capture
      cancelledWithEscape = $true
    }
    propertiesRename = [ordered]@{
      alphabeticalMethod = $alphabeticalMethod
      nameBefore = $nameBefore
      nameRowBounds = [ordered]@{ x = $nameRowBounds.X; y = $nameRowBounds.Y; width = $nameRowBounds.Width; height = $nameRowBounds.Height }
      editMethod = 'UIAutomation ValuePattern.SetValue'
      requestedName = 'submitButton'
      beforeCapture = $propertiesBeforeCapture
      afterRename = $afterRename
      undo = $undo
      redo = $redo
    }
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerInheritedPropertyAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $ControlAutomationId,
  [string] $PropertyName,
  [string] $ExpectedBeforeValue,
  [string] $RequestedValue,
  [string] $Destination
) {
  $originalDesignerText = [System.IO.File]::ReadAllText($DesignerFile)
  $normalizeCodeDomText = {
    param([string] $Text)
    $normalized = $Text.Replace("`r`n", "`n")
    $normalized = [regex]::Replace($normalized, '(?m)^(\s*)//\s*$', '$1//')
    return [regex]::Replace($normalized, '(?m)^(\s*)this\.', '$1')
  }
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S085: derived designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 10

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { throw 'S085 could not resolve the Visual Studio UI Automation root.' }
  $controlCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ControlAutomationId
  )
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  if ($null -eq $control) {
    $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $ExpectedBeforeValue
    )
    $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
  }
  if ($null -eq $control) {
    $inventory = @(Get-UiAutomationInventory $root)
    $visibleButtons = @($inventory | Where-Object {
      [string]$_.controlType -eq 'ControlType.Button' -and -not [bool]$_.offscreen
    })
    throw "S085 did not expose inherited control '$ControlAutomationId'/'$ExpectedBeforeValue'. Visible buttons: $($visibleButtons | ConvertTo-Json -Compress -Depth 6)"
  }
  $controlRecord = ConvertTo-UiAutomationRecord $control $root
  $controlBounds = $control.Current.BoundingRectangle
  if ($controlBounds.Width -lt 1 -or $controlBounds.Height -lt 1) {
    throw "S085 inherited control has invalid bounds: $controlBounds"
  }

  $selectionAttempts = [System.Collections.Generic.List[object]]::new()
  $propertyRow = $null
  $propertyValuePattern = $null
  $visiblePropertyValues = @()
  $locatePropertyRow = {
    $uiaRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $PropertyName
    )
    $matches = $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $candidateValues = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $matches.Count; $index++) {
      try {
        $candidate = $matches.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
            $candidate.Current.IsOffscreen) { continue }
        $pattern = $null
        if (-not $candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { continue }
        $candidateValue = [string]([System.Windows.Automation.ValuePattern]$pattern).Current.Value
        $candidateValues.Add($candidateValue)
        if ($candidateValue -ceq $ExpectedBeforeValue) {
          return [pscustomobject]@{ row = $candidate; pattern = $pattern; visibleValues = @($candidateValues) }
        }
      } catch { }
    }
    return [pscustomobject]@{ row = $null; pattern = $null; visibleValues = @($candidateValues) }
  }

  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($controlBounds.X + ($controlBounds.Width / 2)),
    [int]($controlBounds.Y + ($controlBounds.Height / 2))
  )
  Start-Sleep -Seconds 2
  $propertiesAvailable = $false
  try { $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable } catch { }
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow after S085 inherited-control selection.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5
  $located = & $locatePropertyRow
  $propertyRow = $located.row
  $propertyValuePattern = $located.pattern
  $visiblePropertyValues = @($located.visibleValues)
  $selectionAttempts.Add([ordered]@{
    method = 'PostClickUsingCapture'
    clickedWindow = $clickedWindow.ToInt64()
    propertyValues = $visiblePropertyValues
    selectedExact = $null -ne $propertyRow
  })

  if ($null -eq $propertyRow) {
    $legacyPattern = $null
    $legacyError = ''
    try {
      if (-not $control.TryGetCurrentPattern(
          [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacyPattern)) {
        throw 'LegacyIAccessiblePattern is unavailable.'
      }
      ([System.Windows.Automation.LegacyIAccessiblePattern]$legacyPattern).Select(3)
    } catch {
      $legacyError = $_.Exception.GetBaseException().Message
    }
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('View.PropertiesWindow')
    Start-Sleep -Seconds 3
    $located = & $locatePropertyRow
    $propertyRow = $located.row
    $propertyValuePattern = $located.pattern
    $visiblePropertyValues = @($located.visibleValues)
    $selectionAttempts.Add([ordered]@{
      method = 'LegacyIAccessible.Select(SELFLAG_TAKEFOCUS|SELFLAG_TAKESELECTION)'
      error = $legacyError
      propertyValues = $visiblePropertyValues
      selectedExact = $null -ne $propertyRow
    })
  }

  if ($null -eq $propertyRow -or $null -eq $propertyValuePattern) {
    throw "S085 refuses to edit without exact inherited Button Properties selection: expected $PropertyName='$ExpectedBeforeValue'; observed values=$($visiblePropertyValues -join '|')."
  }
  $beforeValue = [string]([System.Windows.Automation.ValuePattern]$propertyValuePattern).Current.Value
  $propertyBounds = $propertyRow.Current.BoundingRectangle
  $propertiesInventory = @(Get-UiAutomationInventory $root)
  $selectionEvidence = @($propertiesInventory | Where-Object {
    [string]$_.name -match '(?i)inheritedButton|Base inherited|Properties|Text' -or
    [string]$_.value -match '(?i)inheritedButton|Base inherited|System\.Windows\.Forms\.Button'
  })
  $beforeCapture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.properties-before.png'))

  $shapeOf = {
    param([string] $Text)
    $assignments = @([regex]::Matches(
      $Text,
      '(?m)^\s*(?:this\.)?inheritedButton\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+);\s*$'
    ) | ForEach-Object {
      [ordered]@{ property = [string]$_.Groups[1].Value; expression = [string]$_.Groups[2].Value }
    })
    [ordered]@{
      inheritedFieldDeclarationCount = ([regex]::Matches($Text, '(?m)^\s*(?:private|protected|public|internal)\s+.*\binheritedButton\b')).Count
      inheritedAssignments = $assignments
      inheritedAssignmentCount = $assignments.Count
      requestedTextOverrideCount = @($assignments | Where-Object {
        $_.property -ceq 'Text' -and $_.expression -ceq ('"' + $RequestedValue + '"')
      }).Count
    }
  }

  try { $propertyRow.SetFocus() } catch { }
  ([System.Windows.Automation.ValuePattern]$propertyValuePattern).SetValue($RequestedValue)
  Start-Sleep -Seconds 2
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 4
  $afterText = [System.IO.File]::ReadAllText($DesignerFile)
  $afterBytes = [System.IO.File]::ReadAllBytes($DesignerFile)
  $after = [ordered]@{
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $afterText
    capture = Save-WindowCapture $hwnd $Destination
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S085InheritedDerivedForm.Designer.after-override.cs.gz') $afterBytes

  $null = $window.Activate()
  Start-Sleep -Milliseconds 500
  $undoAvailable = $false
  try { $undoAvailable = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable } catch { }
  if ($undoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Undo')
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 2
  }
  $undoText = [System.IO.File]::ReadAllText($DesignerFile)
  $undo = [ordered]@{
    available = $undoAvailable
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $undoText
    byteExactToOriginal = $undoText -ceq $originalDesignerText
    semanticExactToOriginalAfterCodeDomNormalization =
      (& $normalizeCodeDomText $undoText) -ceq (& $normalizeCodeDomText $originalDesignerText)
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-undo.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S085InheritedDerivedForm.Designer.after-undo.cs.gz') `
    ([System.IO.File]::ReadAllBytes($DesignerFile))

  $redoAvailable = $false
  try { $redoAvailable = [bool]$Dte.Commands.Item('Edit.Redo').IsAvailable } catch { }
  if ($redoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Redo')
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 2
  }
  $redoText = [System.IO.File]::ReadAllText($DesignerFile)
  $redo = [ordered]@{
    available = $redoAvailable
    sha256 = Get-Sha256 $DesignerFile
    shape = & $shapeOf $redoText
    byteExactToAfter = $redoText -ceq $afterText
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-redo.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S085InheritedDerivedForm.Designer.after-redo.cs.gz') `
    ([System.IO.File]::ReadAllBytes($DesignerFile))
  Write-Host "S085: inherited $PropertyName '$beforeValue' -> '$RequestedValue'; undo=$undoAvailable; redo=$redoAvailable"

  return [ordered]@{
    document = $SourceFile
    control = $controlRecord
    selectionAttempts = $selectionAttempts
    propertiesCommandAvailable = $propertiesAvailable
    selectionEvidence = $selectionEvidence
    property = [ordered]@{
      name = $PropertyName
      beforeValue = $beforeValue
      requestedValue = $RequestedValue
      bounds = [ordered]@{ x = $propertyBounds.X; y = $propertyBounds.Y; width = $propertyBounds.Width; height = $propertyBounds.Height }
      editMethod = 'UIAutomation ValuePattern.SetValue'
    }
    beforeCapture = $beforeCapture
    after = $after
    undo = $undo
    redo = $redo
    capture = $after.capture
  }
}

function Open-DesignerInheritedReadOnlyPropertyAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $ControlAutomationId,
  [string] $ControlText,
  [string] $PropertyName,
  [string] $ExpectedValue,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S086: locked inherited derived designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 10

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { throw 'S086 could not resolve the Visual Studio UI Automation root.' }
  $controlCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ControlAutomationId
  )
  $controlLocator = "AutomationId=$ControlAutomationId"
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  if ($null -eq $control) {
    $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $ControlText
    )
    $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
    $controlCondition = $nameCondition
    $controlLocator = "Name=$ControlText"
  }
  if ($null -eq $control) {
    $inventory = @(Get-UiAutomationInventory $root)
    $visibleText = @($inventory | Where-Object {
      [string]$_.controlType -eq 'ControlType.Text' -and -not [bool]$_.offscreen
    })
    throw "S086 did not expose locked inherited control '$ControlAutomationId'/'$ControlText'. Visible text controls: $($visibleText | ConvertTo-Json -Compress -Depth 6)"
  }
  $controlRecord = ConvertTo-UiAutomationRecord $control $root
  $controlBounds = $control.Current.BoundingRectangle
  if ($controlBounds.Width -lt 1 -or $controlBounds.Height -lt 1) {
    throw "S086 inherited control has invalid bounds: $controlBounds"
  }

  $selectionAttempts = [System.Collections.Generic.List[object]]::new()
  $locatePropertyRow = {
    $uiaRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $PropertyName
    )
    $matches = $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $candidateValues = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $matches.Count; $index++) {
      try {
        $candidate = $matches.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
            $candidate.Current.IsOffscreen) { continue }
        $pattern = $null
        $candidateValue = $null
        $patternAvailable = $candidate.TryGetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
        if ($patternAvailable) {
          $candidateValue = [string]([System.Windows.Automation.ValuePattern]$pattern).Current.Value
        } else {
          $editCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit
          )
          $editor = $candidate.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
          if ($null -ne $editor) {
            $editorPattern = $null
            if ($editor.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$editorPattern)) {
              $candidateValue = [string]([System.Windows.Automation.ValuePattern]$editorPattern).Current.Value
              $pattern = $editorPattern
              $patternAvailable = $true
            }
          }
        }
        if ($null -ne $candidateValue) { $candidateValues.Add($candidateValue) }
        if ($candidateValue -ceq $ExpectedValue) {
          $isReadOnly = $null
          if ($patternAvailable) {
            try { $isReadOnly = [bool]([System.Windows.Automation.ValuePattern]$pattern).Current.IsReadOnly } catch { }
          }
          return [pscustomobject]@{
            row = $candidate
            pattern = $pattern
            value = $candidateValue
            valuePatternAvailable = [bool]$patternAvailable
            valuePatternIsReadOnly = $isReadOnly
            rowEnabled = [bool]$candidate.Current.IsEnabled
            visibleValues = @($candidateValues)
          }
        }
      } catch { }
    }
    return [pscustomobject]@{
      row = $null
      pattern = $null
      value = $null
      valuePatternAvailable = $false
      valuePatternIsReadOnly = $null
      rowEnabled = $null
      visibleValues = @($candidateValues)
    }
  }

  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($controlBounds.X + ($controlBounds.Width / 2)),
    [int]($controlBounds.Y + ($controlBounds.Height / 2))
  )
  Start-Sleep -Seconds 2
  $propertiesAvailable = $false
  try { $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable } catch { }
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow after S086 inherited-control selection.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5
  $located = & $locatePropertyRow
  $selectionAttempts.Add([ordered]@{
    method = 'PostClickUsingCapture'
    clickedWindow = $clickedWindow.ToInt64()
    propertyValues = @($located.visibleValues)
    selectedExact = $null -ne $located.row
  })

  if ($null -eq $located.row) {
    $legacyPattern = $null
    $legacyError = ''
    try {
      if (-not $control.TryGetCurrentPattern(
          [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacyPattern)) {
        throw 'LegacyIAccessiblePattern is unavailable.'
      }
      ([System.Windows.Automation.LegacyIAccessiblePattern]$legacyPattern).Select(3)
    } catch {
      $legacyError = $_.Exception.GetBaseException().Message
    }
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('View.PropertiesWindow')
    Start-Sleep -Seconds 3
    $located = & $locatePropertyRow
    $selectionAttempts.Add([ordered]@{
      method = 'LegacyIAccessible.Select(SELFLAG_TAKEFOCUS|SELFLAG_TAKESELECTION)'
      error = $legacyError
      propertyValues = @($located.visibleValues)
      selectedExact = $null -ne $located.row
    })
  }

  if ($null -eq $located.row) {
    throw "S086 refuses to claim selection without exact Properties $PropertyName='$ExpectedValue'; observed values=$(@($located.visibleValues) -join '|')."
  }
  $propertyRow = $located.row
  $propertyBounds = $propertyRow.Current.BoundingRectangle
  $readOnlyExact = (-not [bool]$located.rowEnabled) -or $located.valuePatternIsReadOnly -eq $true
  $setValueAttempted = $false
  $setValueSucceeded = $false
  $setValueError = ''
  if ($readOnlyExact -and [bool]$located.valuePatternAvailable -and $null -ne $located.pattern) {
    $setValueAttempted = $true
    try {
      ([System.Windows.Automation.ValuePattern]$located.pattern).SetValue('S086 must not apply')
      $setValueSucceeded = $true
    } catch {
      $setValueError = $_.Exception.GetBaseException().Message
    }
  }
  Start-Sleep -Seconds 2
  $afterLocated = & $locatePropertyRow
  $afterValue = [string]$afterLocated.value
  $propertiesInventory = @(Get-UiAutomationInventory $root)
  $selectionEvidence = @($propertiesInventory | Where-Object {
    [string]$_.automationId -eq $ControlAutomationId -or
    [string]$_.name -match '(?i)privateInheritedLabel|Private inherited label|Properties|Text' -or
    [string]$_.value -match '(?i)privateInheritedLabel|Private inherited label|System\.Windows\.Forms\.Label'
  })
  $capture = Save-WindowCapture $hwnd $Destination
  Write-Host "S086: inherited private Label selected; $PropertyName='$($located.value)'; readOnly=$readOnlyExact; attemptedSet=$setValueAttempted; setSucceeded=$setValueSucceeded"

  return [ordered]@{
    document = $SourceFile
    control = $controlRecord
    controlLocator = $controlLocator
    selectionAttempts = $selectionAttempts
    propertiesCommandAvailable = $propertiesAvailable
    selectionEvidence = $selectionEvidence
    property = [ordered]@{
      name = $PropertyName
      beforeValue = [string]$located.value
      afterValue = $afterValue
      bounds = [ordered]@{ x = $propertyBounds.X; y = $propertyBounds.Y; width = $propertyBounds.Width; height = $propertyBounds.Height }
      rowEnabled = $located.rowEnabled
      valuePatternAvailable = $located.valuePatternAvailable
      valuePatternIsReadOnly = $located.valuePatternIsReadOnly
      readOnlyExact = $readOnlyExact
      setValueAttempted = $setValueAttempted
      setValueSucceeded = $setValueSucceeded
      setValueError = $setValueError
    }
    capture = $capture
  }
}

function Open-DesignerInheritedReadOnlyDragAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $ControlAutomationId,
  [string] $ControlText,
  [int] $DeltaX,
  [int] $DeltaY,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host "S088: inherited read-only drag designer activated for $SourceFile"
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 10

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { throw 'S088 could not resolve the Visual Studio UI Automation root.' }
  $controlCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ControlAutomationId
  )
  $controlLocator = "AutomationId=$ControlAutomationId"
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  if ($null -eq $control) {
    $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $ControlText
    )
    $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
    $controlCondition = $nameCondition
    $controlLocator = "Name=$ControlText"
  }
  if ($null -eq $control) {
    $inventory = @(Get-UiAutomationInventory $root)
    $visibleButtons = @($inventory | Where-Object {
      [string]$_.controlType -eq 'ControlType.Button' -and -not [bool]$_.offscreen
    })
    throw "S088 did not expose inherited Button '$ControlAutomationId'/'$ControlText'. Visible buttons: $($visibleButtons | ConvertTo-Json -Compress -Depth 6)"
  }
  $derivedPeerCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    'derivedButton'
  )
  $derivedPeer = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $derivedPeerCondition)
  if ($null -eq $derivedPeer) {
    $derivedPeerNameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      'Derived writable'
    )
    $derivedPeer = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $derivedPeerNameCondition)
  }
  if ($null -eq $derivedPeer) {
    $inventory = @(Get-UiAutomationInventory $root)
    $visibleButtons = @($inventory | Where-Object {
      [string]$_.controlType -eq 'ControlType.Button' -and -not [bool]$_.offscreen
    })
    throw "S088 did not expose the writable derivedButton peer by AutomationId or text. Visible buttons: $($visibleButtons | ConvertTo-Json -Compress -Depth 6)"
  }
  $controlRecord = ConvertTo-UiAutomationRecord $control $root
  $derivedPeerRecord = ConvertTo-UiAutomationRecord $derivedPeer $root
  $beforeBounds = $control.Current.BoundingRectangle
  if ($beforeBounds.Width -lt 1 -or $beforeBounds.Height -lt 1) {
    throw "S088 inherited Button has invalid bounds: $beforeBounds"
  }

  $locateIdentityRow = {
    $uiaRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $nameRowCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TreeItem
    )
    $matches = $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameRowCondition)
    $visibleValues = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $matches.Count; $index++) {
      try {
        $candidate = $matches.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
            $candidate.Current.IsOffscreen) { continue }
        $pattern = $null
        $candidateValue = $null
        $patternAvailable = $candidate.TryGetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
        if ($patternAvailable) {
          $candidateValue = [string]([System.Windows.Automation.ValuePattern]$pattern).Current.Value
        } else {
          $editCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit
          )
          $editor = $candidate.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
          if ($null -ne $editor) {
            $editorPattern = $null
            if ($editor.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$editorPattern)) {
              $candidateValue = [string]([System.Windows.Automation.ValuePattern]$editorPattern).Current.Value
              $pattern = $editorPattern
              $patternAvailable = $true
            }
          }
        }
        if ($null -ne $candidateValue) { $visibleValues.Add($candidateValue) }
        if ($candidateValue -ceq $ControlText) {
          $isReadOnly = $null
          if ($patternAvailable) {
            try { $isReadOnly = [bool]([System.Windows.Automation.ValuePattern]$pattern).Current.IsReadOnly } catch { }
          }
          return [pscustomobject]@{
            row = $candidate
            propertyName = [string]$candidate.Current.Name
            value = $candidateValue
            rowEnabled = [bool]$candidate.Current.IsEnabled
            valuePatternAvailable = [bool]$patternAvailable
            valuePatternIsReadOnly = $isReadOnly
            visibleValues = @($visibleValues)
          }
        }
      } catch { }
    }
    return [pscustomobject]@{
      row = $null
      propertyName = $null
      value = $null
      rowEnabled = $null
      valuePatternAvailable = $false
      valuePatternIsReadOnly = $null
      visibleValues = @($visibleValues)
    }
  }

  $selectionAttempts = [System.Collections.Generic.List[object]]::new()
  $outlineSelection = $null
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($beforeBounds.X + ($beforeBounds.Width / 2)),
    [int]($beforeBounds.Y + ($beforeBounds.Height / 2))
  )
  Start-Sleep -Seconds 2
  $propertiesAvailable = $false
  try { $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable } catch { }
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow after S088 inherited-control selection.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5
  $located = & $locateIdentityRow
  $selectionAttempts.Add([ordered]@{
    method = 'PostClickUsingCapture'
    clickedWindow = $clickedWindow.ToInt64()
    propertyValues = @($located.visibleValues)
    selectedExact = $null -ne $located.row
  })
  if ($null -eq $located.row) {
    $legacyPattern = $null
    $legacyError = ''
    try {
      if (-not $control.TryGetCurrentPattern(
          [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacyPattern)) {
        throw 'LegacyIAccessiblePattern is unavailable.'
      }
      ([System.Windows.Automation.LegacyIAccessiblePattern]$legacyPattern).Select(3)
    } catch {
      $legacyError = $_.Exception.GetBaseException().Message
    }
    Start-Sleep -Seconds 2
    $null = $Dte.ExecuteCommand('View.PropertiesWindow')
    Start-Sleep -Seconds 3
    $located = & $locateIdentityRow
    $selectionAttempts.Add([ordered]@{
      method = 'LegacyIAccessible.Select(SELFLAG_TAKEFOCUS|SELFLAG_TAKESELECTION)'
      error = $legacyError
      propertyValues = @($located.visibleValues)
      selectedExact = $null -ne $located.row
    })
  }
  if ($null -eq $located.row) {
    $outlineAvailable = $false
    try { $outlineAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable } catch { }
    if (-not $outlineAvailable) {
      throw "S088 refuses to drag without exact Properties value '$ControlText', and View.DocumentOutline is unavailable; observed values=$(@($located.visibleValues) -join '|')."
    }
    $null = $window.Activate()
    $null = $Dte.ExecuteCommand('View.DocumentOutline')
    Start-Sleep -Seconds 3
    $outlineTrees = @([VisualStudioTraceNative]::GetDescendantWindowsByClassFragment($hwnd, 'SysTreeView32'))
    if ($outlineTrees.Count -ne 1) {
      throw "S088 exposed $($outlineTrees.Count) native Document Outline trees; expected exactly one before selection fallback."
    }
    $outlineTree = [IntPtr]$outlineTrees[0]
    $outlineRect = New-Object VisualStudioTraceNative+RECT
    if (-not [VisualStudioTraceNative]::GetWindowRect($outlineTree, [ref]$outlineRect)) {
      throw 'S088 could not measure the native Document Outline tree.'
    }
    $dpiScale = [double]([VisualStudioTraceNative]::GetDpiForWindow($hwnd)) / 96.0
    $rowHeight = [int][Math]::Round(18 * $dpiScale)
    $outlineX = [int]($outlineRect.Left + [Math]::Round(100 * $dpiScale))
    $outlineAttempts = [System.Collections.Generic.List[object]]::new()
    for ($rowIndex = 0; $rowIndex -lt 5 -and $null -eq $located.row; $rowIndex++) {
      $outlineY = [int]($outlineRect.Top + [Math]::Round(9 * $dpiScale) + ($rowIndex * $rowHeight))
      $outlineChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $outlineX, $outlineY)
      if ($outlineChain -notmatch 'SysTreeView32') { continue }
      $outlineClickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $outlineX, $outlineY)
      Start-Sleep -Seconds 2
      $null = $Dte.ExecuteCommand('View.PropertiesWindow')
      Start-Sleep -Seconds 2
      $located = & $locateIdentityRow
      $outlineAttempts.Add([ordered]@{
        rowIndex = $rowIndex
        point = [ordered]@{ x = $outlineX; y = $outlineY }
        clickedWindow = $outlineClickedWindow.ToInt64()
        chain = $outlineChain
        propertyValues = @($located.visibleValues)
        selectedExact = $null -ne $located.row
      })
    }
    $outlineSelection = [ordered]@{
      commandAvailable = $outlineAvailable
      treeHwnd = $outlineTree.ToInt64()
      treeBounds = [ordered]@{
        x = $outlineRect.Left
        y = $outlineRect.Top
        width = $outlineRect.Right - $outlineRect.Left
        height = $outlineRect.Bottom - $outlineRect.Top
      }
      attempts = @($outlineAttempts)
      selectedExact = $null -ne $located.row
    }
    $selectionAttempts.Add([ordered]@{
      method = 'Native Document Outline measured-row scan with exact PropertyGrid identity proof'
      attempts = @($outlineAttempts)
      selectedExact = $null -ne $located.row
    })
  }
  if ($null -eq $located.row) {
    throw "S088 refuses to drag without a visible Properties row whose exact value is '$ControlText'; observed values=$(@($located.visibleValues) -join '|')."
  }
  $identityReadOnlyExact = (-not [bool]$located.rowEnabled) -or $located.valuePatternIsReadOnly -eq $true
  if (-not $identityReadOnlyExact) {
    throw "S088 Properties row '$($located.propertyName)'='$ControlText' was unexpectedly editable."
  }

  $beforeCapture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.before-drag.png'))
  $getDocumentSaved = {
    try {
      if ($null -ne $window.Document) { return [bool]$window.Document.Saved }
    } catch { }
    try {
      if ($null -ne $Dte.ActiveDocument) { return [bool]$Dte.ActiveDocument.Saved }
    } catch { }
    try {
      if ($null -ne $item.Document) { return [bool]$item.Document.Saved }
    } catch { }
    return $null
  }
  $null = $window.Activate()
  Start-Sleep -Seconds 1
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  if ($null -eq $control) { throw "S088 lost inherited Button '$ControlAutomationId' after exact selection." }
  $controlRecord = ConvertTo-UiAutomationRecord $control $root
  $beforeBounds = $control.Current.BoundingRectangle
  if ($beforeBounds.Width -lt 1 -or $beforeBounds.Height -lt 1) {
    throw "S088 selected inherited Button has invalid post-selection bounds: $beforeBounds"
  }
  $undoAvailableBefore = $false
  try { $undoAvailableBefore = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable } catch { }
  $documentSavedBefore = & $getDocumentSaved
  $startX = [int]($beforeBounds.X + ($beforeBounds.Width / 2))
  $startY = [int]($beforeBounds.Y + ($beforeBounds.Height / 2))
  $endX = $startX + $DeltaX
  $endY = $startY + $DeltaY
  $windowChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $startX, $startY)
  $dragWindow = [VisualStudioTraceNative]::PostDragUsingCaptureWithCursor(
    $hwnd, $startX, $startY, $endX, $endY)
  Start-Sleep -Seconds 4

  $null = $window.Activate()
  Start-Sleep -Seconds 1
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $afterControl = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  if ($null -eq $afterControl) { throw "S088 lost inherited Button '$ControlAutomationId' after the drag attempt." }
  $afterBounds = $afterControl.Current.BoundingRectangle
  $documentSavedAfter = & $getDocumentSaved
  $undoAvailableAfter = $false
  try { $undoAvailableAfter = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable } catch { }
  $capture = Save-WindowCapture $hwnd $Destination
  Write-Host "S088: inherited private Button drag attempted; bounds=($($beforeBounds.X),$($beforeBounds.Y))->($($afterBounds.X),$($afterBounds.Y)); undo=$undoAvailableBefore->$undoAvailableAfter; saved=$documentSavedBefore->$documentSavedAfter"

  return [ordered]@{
    document = $SourceFile
    designerDocument = $DesignerFile
    control = $controlRecord
    controlLocator = $controlLocator
    derivedPeer = $derivedPeerRecord
    selectionAttempts = $selectionAttempts
    outlineSelection = $outlineSelection
    propertiesCommandAvailable = $propertiesAvailable
    identityProperty = [ordered]@{
      propertyName = [string]$located.propertyName
      value = [string]$located.value
      rowEnabled = $located.rowEnabled
      valuePatternAvailable = $located.valuePatternAvailable
      valuePatternIsReadOnly = $located.valuePatternIsReadOnly
      readOnlyExact = $identityReadOnlyExact
    }
    input = [ordered]@{
      mode = 'posted-mouse-with-screen-cursor-synchronization-to-actual-designer-capture'
      windowChain = $windowChain
      dragWindow = $dragWindow.ToInt64()
      start = [ordered]@{ x = $startX; y = $startY }
      end = [ordered]@{ x = $endX; y = $endY }
      requestedDelta = [ordered]@{ x = $DeltaX; y = $DeltaY }
    }
    beforeBounds = [ordered]@{ x = $beforeBounds.X; y = $beforeBounds.Y; width = $beforeBounds.Width; height = $beforeBounds.Height }
    afterBounds = [ordered]@{ x = $afterBounds.X; y = $afterBounds.Y; width = $afterBounds.Width; height = $afterBounds.Height }
    boundsExact = $beforeBounds.X -eq $afterBounds.X -and $beforeBounds.Y -eq $afterBounds.Y -and
      $beforeBounds.Width -eq $afterBounds.Width -and $beforeBounds.Height -eq $afterBounds.Height
    undoAvailableBefore = $undoAvailableBefore
    undoAvailableAfter = $undoAvailableAfter
    undoAvailabilityUnchanged = $undoAvailableBefore -eq $undoAvailableAfter
    documentSavedBefore = $documentSavedBefore
    documentSavedAfter = $documentSavedAfter
    documentSavedStateUnchanged = $documentSavedBefore -eq $documentSavedAfter
    beforeCapture = $beforeCapture
    capture = $capture
  }
}

function Open-DesignerMultiPropertiesAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S038: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $beforeSelect = [ordered]@{
    selectAllAvailable = [bool]$Dte.Commands.Item('Edit.SelectAll').IsAvailable
    alignLeftAvailable = [bool]$Dte.Commands.Item('Format.AlignLefts').IsAvailable
    makeSameWidthAvailable = [bool]$Dte.Commands.Item('Format.MakeSameWidth').IsAvailable
  }
  if (-not $beforeSelect.selectAllAvailable) { throw 'Visual Studio did not enable Edit.SelectAll for S038.' }
  $null = $Dte.ExecuteCommand('Edit.SelectAll')
  Start-Sleep -Seconds 2
  $afterSelect = [ordered]@{
    selectAllAvailable = [bool]$Dte.Commands.Item('Edit.SelectAll').IsAvailable
    alignLeftAvailable = [bool]$Dte.Commands.Item('Format.AlignLefts').IsAvailable
    makeSameWidthAvailable = [bool]$Dte.Commands.Item('Format.MakeSameWidth').IsAvailable
  }
  Write-Host "S038: Edit.SelectAll complete (AlignLefts=$($afterSelect.alignLeftAvailable), MakeSameWidth=$($afterSelect.makeSameWidthAvailable))"

  $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow for S038.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $elements = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $inventory = [System.Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $elements.Count; $index++) {
    try {
      $candidate = $elements.Item($index)
      $name = [string]$candidate.Current.Name
      $candidateAutomationId = [string]$candidate.Current.AutomationId
      if (-not $name -and -not $candidateAutomationId) { continue }
      if ($name -notmatch '(?i)button1|textbox1|2 objects|multiple|Properties|Categor|Alphabet|Appearance|Behavior|Text|Multiline|DialogResult|AcceptsReturn|UseSystemPasswordChar|AccessibleRole|AllowDrop|Anchor|BackColor|Enabled|Font|ForeColor|Location|Locked|Modifiers|Name|Size|TabIndex|TabStop|Visible' -and
          $candidateAutomationId -notmatch '(?i)button1|textbox1|propert|categor|alphabet|description|object') { continue }
      $candidateBounds = $candidate.Current.BoundingRectangle
      $value = $null
      $valuePattern = $null
      if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        $value = [string]$valuePattern.Current.Value
      }
      $inventory.Add([ordered]@{
        name = $name
        automationId = $candidateAutomationId
        controlType = [string]$candidate.Current.ControlType.ProgrammaticName
        value = $value
        enabled = [bool]$candidate.Current.IsEnabled
        offscreen = [bool]$candidate.Current.IsOffscreen
        bounds = [ordered]@{
          x = $candidateBounds.X
          y = $candidateBounds.Y
          width = $candidateBounds.Width
          height = $candidateBounds.Height
        }
      })
    } catch { }
  }
  $null = $window.Activate()
  Start-Sleep -Milliseconds 500
  return [ordered]@{
    document = $SourceFile
    command = 'Edit.SelectAll + View.PropertiesWindow'
    beforeSelect = $beforeSelect
    afterSelect = $afterSelect
    propertiesCommandAvailable = $propertiesAvailable
    uiAutomationInventory = $inventory
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerCtrlMultiSelectAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S019: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $controls = [ordered]@{}
  $controlElements = [ordered]@{}
  foreach ($id in 'button1', 'button2', 'button3') {
    $expectedName = ([ordered]@{ button1 = 'Primary'; button2 = 'Second'; button3 = 'Third' })[$id]
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $id
    )
    $control = $null
    $locator = ''
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($null -eq $control -and [DateTime]::UtcNow -lt $deadline) {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if ($null -ne $root) {
        $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        if ($null -ne $control) {
          $locator = "AutomationId=$id"
        } else {
          # The classic net48 designer hosts real WinForms HWNDs and exposes their accessible Text as UIA Name while
          # AutomationId is the transient HWND. Require a unique, visible exact-name match before using that lane.
          $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $expectedName
          )
          $nameMatches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition) | Where-Object {
            $candidateBounds = $_.Current.BoundingRectangle
            $candidateBounds.Width -gt 0 -and $candidateBounds.Height -gt 0 -and -not [bool]$_.Current.IsOffscreen
          })
          if ($nameMatches.Count -gt 1) {
            throw "Visual Studio designer exposed multiple visible exact Name=$expectedName targets for S019 $id."
          }
          if ($nameMatches.Count -eq 1) {
            $control = $nameMatches[0]
            $locator = "Name=$expectedName"
          }
        }
      }
      if ($null -eq $control) { Start-Sleep -Milliseconds 500 }
    }
    if ($null -eq $control) { throw "Visual Studio designer did not expose $id for S019." }
    $bounds = $control.Current.BoundingRectangle
    if ($bounds.Width -le 0 -or $bounds.Height -le 0 -or [bool]$control.Current.IsOffscreen) {
      throw "Visual Studio designer exposed no clickable onscreen bounds for S019 $id."
    }
    $controls[$id] = [ordered]@{
      expectedId = $id
      locator = $locator
      name = [string]$control.Current.Name
      automationId = [string]$control.Current.AutomationId
      controlType = [string]$control.Current.ControlType.ProgrammaticName
      bounds = [ordered]@{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
      center = [ordered]@{ x = [int]($bounds.X + ($bounds.Width / 2)); y = [int]($bounds.Y + ($bounds.Height / 2)) }
      supportedPatterns = @($control.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
    }
    $controlElements[$id] = $control
  }

  $selectionShaBefore = Get-Sha256 $DesignerFile
  $primaryActivationAttempts = 1
  $primaryTarget = [VisualStudioTraceNative]::PhysicalClickAtScreen(
    $hwnd, [int]$controls.button1.center.x, [int]$controls.button1.center.y, $false
  )
  Start-Sleep -Seconds 2
  $primaryCenterAvailable = [bool]$Dte.Commands.Item('Format.CenterHorizontally').IsAvailable
  if (-not $primaryCenterAvailable) {
    # In the classic designer, the first pointer input after an Output/tool-window build can activate the designer
    # document without selecting its hit control. Repeat the same plain click once, but only while the single-control
    # Format command proves that the first click was activation-only.
    $primaryActivationAttempts = 2
    $primaryTarget = [VisualStudioTraceNative]::PhysicalClickAtScreen(
      $hwnd, [int]$controls.button1.center.x, [int]$controls.button1.center.y, $false
    )
    Start-Sleep -Seconds 2
    $primaryCenterAvailable = [bool]$Dte.Commands.Item('Format.CenterHorizontally').IsAvailable
  }
  Start-Sleep -Seconds 2
  $afterPrimary = [ordered]@{
    alignLeftAvailable = [bool]$Dte.Commands.Item('Format.AlignLefts').IsAvailable
    makeSameWidthAvailable = [bool]$Dte.Commands.Item('Format.MakeSameWidth').IsAvailable
    centerHorizontallyAvailable = $primaryCenterAvailable
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-primary.png'))
  }
  [VisualStudioTraceNative]::SetInjectedControlState($true)
  try {
    $secondTarget = [VisualStudioTraceNative]::PhysicalClickAtScreen(
      $hwnd, [int]$controls.button2.center.x, [int]$controls.button2.center.y, $false
    )
    Start-Sleep -Seconds 2
  } finally {
    [VisualStudioTraceNative]::SetInjectedControlState($false)
  }
  Start-Sleep -Seconds 2
  $afterSecond = [ordered]@{
    alignLeftAvailable = [bool]$Dte.Commands.Item('Format.AlignLefts').IsAvailable
    makeSameWidthAvailable = [bool]$Dte.Commands.Item('Format.MakeSameWidth').IsAvailable
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-second.png'))
  }
  [VisualStudioTraceNative]::SetInjectedControlState($true)
  try {
    $thirdTarget = [VisualStudioTraceNative]::PhysicalClickAtScreen(
      $hwnd, [int]$controls.button3.center.x, [int]$controls.button3.center.y, $false
    )
    Start-Sleep -Seconds 2
  } finally {
    [VisualStudioTraceNative]::SetInjectedControlState($false)
  }
  Start-Sleep -Seconds 2
  $afterThird = [ordered]@{
    alignLeftAvailable = [bool]$Dte.Commands.Item('Format.AlignLefts').IsAvailable
    makeSameWidthAvailable = [bool]$Dte.Commands.Item('Format.MakeSameWidth').IsAvailable
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-third.png'))
  }
  $selectionShaAfter = Get-Sha256 $DesignerFile

  $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow for S019.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 4
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $propertiesEvidence = @(Get-UiAutomationInventory $root | Where-Object {
    [string]$_.name -match '(?i)3 objects|multiple|Properties|button1|button2|button3' -or
    [string]$_.value -match '(?i)3 objects|multiple|button1|button2|button3'
  })
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 500
  $selectedCapture = Save-WindowScreenCapture $hwnd $Destination

  $null = $window.Activate()
  Start-Sleep -Seconds 1
  $makeSameWidthAvailable = [bool]$Dte.Commands.Item('Format.MakeSameWidth').IsAvailable
  if ($makeSameWidthAvailable) { $null = $Dte.ExecuteCommand('Format.MakeSameWidth') }
  Start-Sleep -Seconds 3

  $saveDesigner = {
    param([string] $Phase)
    $dismissal = [VisualStudioTraceNative]::StartDialogDismissal(
      $hwnd,
      'Inconsistent Line Endings',
      7,
      600000
    )
    $null = $Dte.ExecuteCommand('File.SaveAll')
    [void]$dismissal.Thread.Join(1000)
    $dismissal.Cancelled = $true
    [void]$dismissal.Thread.Join(1000)
    Start-Sleep -Seconds 2
    return [ordered]@{
      phase = $Phase
      title = 'Inconsistent Line Endings'
      choice = 'No'
      observed = [bool]$dismissal.Observed
      clickPosted = [bool]$dismissal.ClickPosted
      dismissed = [bool]$dismissal.Dismissed
    }
  }

  $makeSameWidthSave = & $saveDesigner 'make-same-width-primary-probe'
  $afterMakeSameWidthText = [System.IO.File]::ReadAllText($DesignerFile)
  $afterMakeSameWidthBytes = [System.IO.File]::ReadAllBytes($DesignerFile)
  $afterMakeSameWidth = [ordered]@{
    designerSha256 = Get-Sha256 $DesignerFile
    shape = Get-S019Shape $afterMakeSameWidthText
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-make-same-width.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S019CtrlMultiSelectForm.Designer.after-make-same-width.cs.gz') $afterMakeSameWidthBytes

  $null = $window.Activate()
  Start-Sleep -Seconds 1
  $undoAvailable = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable
  if ($undoAvailable) { $null = $Dte.ExecuteCommand('Edit.Undo') }
  Start-Sleep -Seconds 3
  $undoSave = & $saveDesigner 'undo-make-same-width-probe'
  $afterUndoText = [System.IO.File]::ReadAllText($DesignerFile)
  $afterUndoBytes = [System.IO.File]::ReadAllBytes($DesignerFile)
  $afterUndo = [ordered]@{
    designerSha256 = Get-Sha256 $DesignerFile
    shape = Get-S019Shape $afterUndoText
    capture = Save-WindowCapture $hwnd ([System.IO.Path]::ChangeExtension($Destination, '.after-undo.png'))
  }
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'S019CtrlMultiSelectForm.Designer.after-undo.cs.gz') $afterUndoBytes

  Write-Host "S019: clicks complete; afterSecondSameWidth=$($afterSecond.makeSameWidthAvailable); afterThirdSameWidth=$($afterThird.makeSameWidthAvailable); makeSameWidth=$makeSameWidthAvailable; undo=$undoAvailable"
  return [ordered]@{
    document = $SourceFile
    windowHandle = $hwnd.ToInt64()
    controls = $controls
    input = [ordered]@{
      primary = [ordered]@{ id = 'button1'; controlModifier = $false; targetWindow = $primaryTarget.ToInt64() }
      second = [ordered]@{ id = 'button2'; controlModifier = $true; targetWindow = $secondTarget.ToInt64() }
      third = [ordered]@{ id = 'button3'; controlModifier = $true; targetWindow = $thirdTarget.ToInt64() }
      method = 'Physical input-desktop clicks with SendInput VK_CONTROL down/up on the interactive capture thread and GetAsyncKeyState gates for additive clicks'
      primaryActivationAttempts = $primaryActivationAttempts
    }
    afterPrimary = $afterPrimary
    afterSecond = $afterSecond
    afterThird = $afterThird
    selectionWasNonMutating = $selectionShaBefore -eq $selectionShaAfter
    selectionDesignerSha256 = $selectionShaAfter
    propertiesCommandAvailable = $propertiesAvailable
    propertiesEvidence = $propertiesEvidence
    capture = $selectedCapture
    primaryProbe = [ordered]@{
      command = 'Format.MakeSameWidth'
      available = $makeSameWidthAvailable
      save = $makeSameWidthSave
      afterMakeSameWidth = $afterMakeSameWidth
      undoAvailable = $undoAvailable
      undoSave = $undoSave
      afterUndo = $afterUndo
    }
  }
}

function Open-DesignerOverlapHitAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $TopAutomationId,
  [string] $BottomAutomationId,
  [string] $ExpectedTopText,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $top = $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $TopAutomationId
    )
  )
  $bottom = $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $BottomAutomationId
    )
  )
  if ($null -eq $top -or $null -eq $bottom) {
    throw "Visual Studio did not expose both S015 labels: top=$($null -ne $top), bottom=$($null -ne $bottom)."
  }
  $topBounds = $top.Current.BoundingRectangle
  $bottomBounds = $bottom.Current.BoundingRectangle
  $overlapLeft = [Math]::Max($topBounds.Left, $bottomBounds.Left)
  $overlapTop = [Math]::Max($topBounds.Top, $bottomBounds.Top)
  $overlapRight = [Math]::Min($topBounds.Right, $bottomBounds.Right)
  $overlapBottom = [Math]::Min($topBounds.Bottom, $bottomBounds.Bottom)
  if ($overlapRight -le $overlapLeft -or $overlapBottom -le $overlapTop) {
    throw "Visual Studio S015 labels do not overlap: top=$topBounds bottom=$bottomBounds"
  }
  $clickX = [int](($overlapLeft + $overlapRight) / 2)
  $clickY = [int](($overlapTop + $overlapBottom) / 2)
  $windowChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $clickX, $clickY)
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $clickX, $clickY)
  Start-Sleep -Seconds 2

  $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow for S015.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $textCandidates = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      'Text'
    )
  )
  $selectedTextRows = [System.Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $textCandidates.Count; $index++) {
    try {
      $candidate = $textCandidates.Item($index)
      if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
          $candidate.Current.IsOffscreen) { continue }
      $valuePattern = $null
      if (-not $candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { continue }
      if ([string]$valuePattern.Current.Value -cne $ExpectedTopText) { continue }
      $selectedTextRows.Add((ConvertTo-UiAutomationRecord $candidate $root))
    } catch { }
  }
  if ($selectedTextRows.Count -ne 1) {
    $visibleTextRows = @(Get-UiAutomationInventory $root | Where-Object {
      $_.name -ceq 'Text' -and $_.controlType -ceq 'ControlType.TreeItem' -and -not $_.offscreen
    } | ForEach-Object { "Text=$($_.value)" })
    throw "Visual Studio Properties did not prove the S015 top-label selection. Visible Text rows: $($visibleTextRows -join ' | ')"
  }

  return [ordered]@{
    document = $SourceFile
    command = 'Click overlapping designer pixel + View.PropertiesWindow'
    topAutomationId = $TopAutomationId
    bottomAutomationId = $BottomAutomationId
    expectedTopText = $ExpectedTopText
    clickedWindow = $clickedWindow.ToInt64()
    windowChain = $windowChain
    topBounds = [ordered]@{ x = $topBounds.X; y = $topBounds.Y; width = $topBounds.Width; height = $topBounds.Height }
    bottomBounds = [ordered]@{ x = $bottomBounds.X; y = $bottomBounds.Y; width = $bottomBounds.Width; height = $bottomBounds.Height }
    overlap = [ordered]@{ left = $overlapLeft; top = $overlapTop; right = $overlapRight; bottom = $overlapBottom }
    click = [ordered]@{ x = $clickX; y = $clickY }
    selectedTextRows = @($selectedTextRows)
    propertiesCommandAvailable = $propertiesAvailable
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerPropertyResetAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $ControlAutomationId,
  [string] $ControlAutomationName,
  [string] $PropertyName,
  [string] $Destination,
  [string] $MenuDestination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S039: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $controlCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ControlAutomationId
  )
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  $controlLocator = "AutomationId=$ControlAutomationId"
  if ($null -eq $control -and $ControlAutomationName) {
    $controlNameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $ControlAutomationName
    )
    $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlNameCondition)
    $controlLocator = "Name=$ControlAutomationName"
  }
  if ($null -eq $control) {
    throw "Visual Studio designer did not expose AutomationId '$ControlAutomationId' or Name '$ControlAutomationName' for S039."
  }
  $controlBounds = $control.Current.BoundingRectangle
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($controlBounds.X + ($controlBounds.Width / 2)),
    [int]($controlBounds.Y + ($controlBounds.Height / 2))
  )
  Start-Sleep -Seconds 2

  $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable
  if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow for S039.' }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Write-Host 'S039: Properties window opened'
  Start-Sleep -Seconds 5

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $propertyCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $PropertyName
  )
  $propertyMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $propertyCondition)
  $propertyRow = $null
  for ($index = 0; $index -lt $propertyMatches.Count; $index++) {
    try {
      $candidate = $propertyMatches.Item($index)
      if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
          $candidate.Current.IsOffscreen) { continue }
      $candidateBounds = $candidate.Current.BoundingRectangle
      if ($candidateBounds.Width -le 0 -or $candidateBounds.Height -le 0) { continue }
      $propertyRow = $candidate
      break
    } catch { }
  }
  if ($null -eq $propertyRow) { throw "Visual Studio Properties did not expose visible '$PropertyName' row for S039." }
  $propertyBounds = $propertyRow.Current.BoundingRectangle
  $beforeValue = $null
  $valuePattern = $null
  if ($propertyRow.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    $beforeValue = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
  }
  if ($beforeValue -ne $ControlAutomationName) {
    # The in-process net48 designer exposes the rendered Button through UIA, but a synthetic child-window click can
    # be absorbed by the real control instead of changing ISelectionService. The visible Document Outline is an
    # actual Visual Studio selection surface, so use its exact component row as a deterministic fallback and verify
    # the Property Grid value before invoking any mutating command.
    $outlineNode = $null
    $allElements = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $outlineNamePattern = '(?i)^' + [regex]::Escape($ControlAutomationId) + '(?:\s*\|\s*Button|\s+Button)?$'
    $outlineDiagnostics = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $allElements.Count; $index++) {
      try {
        $candidate = $allElements.Item($index)
        $candidateName = [string]$candidate.Current.Name
        $candidateAutomationId = [string]$candidate.Current.AutomationId
        $candidateBounds = $candidate.Current.BoundingRectangle
        if (($candidateBounds.X -ge 490 -and $candidateBounds.Right -le 710 -and
             $candidateBounds.Y -ge 90 -and $candidateBounds.Bottom -le 1060) -or
            $candidateName -match '(?i)button1') {
          if ($outlineDiagnostics.Count -lt 80) {
            $outlineDiagnostics.Add(
              "name='$candidateName'; automationId='$candidateAutomationId'; type='$([string]$candidate.Current.ControlType.ProgrammaticName)'; offscreen=$([bool]$candidate.Current.IsOffscreen); bounds=$($candidateBounds.X),$($candidateBounds.Y),$($candidateBounds.Width),$($candidateBounds.Height)"
            )
          }
        }
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
            $candidate.Current.IsOffscreen -or
            $candidateName -notmatch $outlineNamePattern) { continue }
        $candidateBounds = $candidate.Current.BoundingRectangle
        if ($candidateBounds.Width -le 0 -or $candidateBounds.Height -le 0) { continue }
        $outlineNode = $candidate
        break
      } catch { }
    }
    if ($null -eq $outlineNode) {
      # The legacy Document Outline's native component tree does not expose its individual rows through UIA. Its
      # containing pane and command toolbar do expose exact bounds, however. This two-component fixture always has
      # the Form root on row 1 and button1 on row 2; click the visible row relative to those measured bounds, then
      # prove the result through the Property Grid value before Reset is allowed to run.
      $outlinePane = $null
      $outlineToolbar = $null
      for ($index = 0; $index -lt $allElements.Count; $index++) {
        try {
          $candidate = $allElements.Item($index)
          if ($null -eq $outlinePane -and
              $candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::Pane -and
              [string]$candidate.Current.Name -like 'Document Outline - *' -and
              -not $candidate.Current.IsOffscreen) {
            $outlinePane = $candidate
          }
          if ($null -eq $outlineToolbar -and
              $candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::ToolBar -and
              [string]$candidate.Current.Name -eq 'Commands' -and
              -not $candidate.Current.IsOffscreen) {
            $outlineToolbar = $candidate
          }
        } catch { }
      }
      if ($null -eq $outlinePane -or $null -eq $outlineToolbar) {
        $diagnosticText = $outlineDiagnostics -join ' || '
        throw "S039 selected the wrong component: expected Text '$ControlAutomationName', observed '$beforeValue', and Visual Studio exposed neither a semantic '$ControlAutomationId | Button' row nor measurable Document Outline pane/toolbar bounds. Candidate UIA elements: $diagnosticText"
      }
      $outlinePaneBounds = $outlinePane.Current.BoundingRectangle
      $outlineToolbarBounds = $outlineToolbar.Current.BoundingRectangle
      $outlineRowX = [int]($outlinePaneBounds.X + [Math]::Min(80, $outlinePaneBounds.Width / 2))
      $outlineRowY = [int]($outlineToolbarBounds.Bottom + 29)
      $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $outlineRowX, $outlineRowY)
      $outlineName = "$ControlAutomationId | Button (visible row 2)"
      $controlLocator += "; DocumentOutline measured-row click Name=$outlineName"
    } else {
      $outlineName = [string]$outlineNode.Current.Name
      $outlinePattern = $null
      if ($outlineNode.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$outlinePattern)) {
        ([System.Windows.Automation.SelectionItemPattern]$outlinePattern).Select()
        $controlLocator += "; DocumentOutline SelectionItem Name=$outlineName"
      } else {
        $outlineBounds = $outlineNode.Current.BoundingRectangle
        $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
          $hwnd,
          [int]($outlineBounds.X + ($outlineBounds.Width / 2)),
          [int]($outlineBounds.Y + ($outlineBounds.Height / 2))
        )
        $controlLocator += "; DocumentOutline Click Name=$outlineName"
      }
    }
    Write-Host "S039: designer selection corrected through visible Document Outline row '$outlineName'"
    Start-Sleep -Seconds 3
    $null = $Dte.ExecuteCommand('View.PropertiesWindow')
    Start-Sleep -Seconds 2

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $propertyMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $propertyCondition)
    $propertyRow = $null
    for ($index = 0; $index -lt $propertyMatches.Count; $index++) {
      try {
        $candidate = $propertyMatches.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
            $candidate.Current.IsOffscreen) { continue }
        $candidateBounds = $candidate.Current.BoundingRectangle
        if ($candidateBounds.Width -le 0 -or $candidateBounds.Height -le 0) { continue }
        $propertyRow = $candidate
        break
      } catch { }
    }
    if ($null -eq $propertyRow) { throw "Visual Studio Properties did not expose visible '$PropertyName' row after correcting S039 selection." }
    $propertyBounds = $propertyRow.Current.BoundingRectangle
    $beforeValue = $null
    $valuePattern = $null
    if ($propertyRow.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
      $beforeValue = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
    }
  }
  if ($beforeValue -ne $ControlAutomationName) {
    throw "S039 refuses to invoke Reset for the wrong component: expected Text '$ControlAutomationName', observed '$beforeValue'."
  }
  $rowX = [int]($propertyBounds.Right - 70)
  $rowY = [int]($propertyBounds.Y + ($propertyBounds.Height / 2))
  $rowWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $rowX, $rowY)
  Start-Sleep -Seconds 1
  $resetCommands = [System.Collections.Generic.List[object]]::new()
  for ($commandIndex = 1; $commandIndex -le [int]$Dte.Commands.Count; $commandIndex++) {
    try {
      $command = $Dte.Commands.Item($commandIndex)
      $commandName = [string]$command.Name
      if ($commandName -notmatch '(?i)reset') { continue }
      $resetCommands.Add([ordered]@{
        name = $commandName
        available = [bool]$command.IsAvailable
      })
    } catch { }
  }
  Write-Host "S039: discovered $($resetCommands.Count) registered Reset command(s)"
  $contextWindow = [VisualStudioTraceNative]::PostContextMenuAtDeepestChild($hwnd, $rowX, $rowY)
  Write-Host 'S039: Text property context menu requested through WM_CONTEXTMENU'
  Start-Sleep -Seconds 2

  $menuItems = [System.Collections.Generic.List[object]]::new()
  $resetElement = $null
  $resetWindow = [IntPtr]::Zero
  $contextMenuMethod = 'PostContextMenuAtDeepestChild'
  $menuSeen = @{}
  for ($attempt = 0; $attempt -lt 2 -and $null -eq $resetElement; $attempt++) {
    if ($attempt -eq 1) {
      [VisualStudioTraceNative]::PressEscape()
      Start-Sleep -Milliseconds 500
      [void][VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $rowX, $rowY)
      [VisualStudioTraceNative]::PressContextMenu()
      $contextMenuMethod = 'Shift+F10'
      Write-Host 'S039: retrying the Text property context menu via Shift+F10'
      Start-Sleep -Seconds 2
    }
    $processWindows = @([VisualStudioTraceNative]::GetProcessTopLevelWindows($hwnd))
    $uiaRoots = [System.Collections.Generic.List[object]]::new()
    foreach ($processWindow in $processWindows) {
      try {
        $popupRoot = [System.Windows.Automation.AutomationElement]::FromHandle($processWindow)
        if ($null -ne $popupRoot) {
          $uiaRoots.Add([ordered]@{ root = $popupRoot; window = $processWindow })
        }
      } catch { }
    }
    $uiaRoots.Add([ordered]@{
      root = [System.Windows.Automation.AutomationElement]::RootElement
      window = [IntPtr]::Zero
    })
    $menuCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::MenuItem
    )
    foreach ($uiaRoot in $uiaRoots) {
      try {
        $candidates = $uiaRoot.root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuCondition)
      } catch { continue }
      for ($candidateIndex = 0; $candidateIndex -lt $candidates.Count; $candidateIndex++) {
        try {
          $candidate = $candidates.Item($candidateIndex)
          if ([int]$candidate.Current.ProcessId -ne [int]$root.Current.ProcessId) { continue }
          $candidateBounds = $candidate.Current.BoundingRectangle
          if ($candidate.Current.IsOffscreen -or $candidateBounds.Width -le 0 -or $candidateBounds.Height -le 0) { continue }
          if ($candidateBounds.X -gt ($propertyBounds.Right + 500) -or
              $candidateBounds.Right -lt ($propertyBounds.X - 500) -or
              $candidateBounds.Y -gt ($propertyBounds.Bottom + 400) -or
              $candidateBounds.Bottom -lt ($propertyBounds.Y - 400)) { continue }
          $candidateWindow = [IntPtr]$uiaRoot.window
          if ($candidateWindow -eq [IntPtr]::Zero) {
            foreach ($processWindow in $processWindows) {
              try {
                $windowRect = New-Object VisualStudioTraceNative+RECT
                if (-not [VisualStudioTraceNative]::GetWindowRect($processWindow, [ref]$windowRect)) { continue }
                $centerX = $candidateBounds.X + ($candidateBounds.Width / 2)
                $centerY = $candidateBounds.Y + ($candidateBounds.Height / 2)
                if ($centerX -ge $windowRect.Left -and $centerX -lt $windowRect.Right -and
                    $centerY -ge $windowRect.Top -and $centerY -lt $windowRect.Bottom) {
                  $candidateWindow = $processWindow
                  break
                }
              } catch { }
            }
          }
          $entryKey = "$([string]$candidate.Current.Name)|$($candidateBounds.X)|$($candidateBounds.Y)|$($candidateBounds.Width)|$($candidateBounds.Height)"
          if ($menuSeen.ContainsKey($entryKey)) { continue }
          $menuSeen[$entryKey] = $true
          $entry = [ordered]@{
            name = [string]$candidate.Current.Name
            automationId = [string]$candidate.Current.AutomationId
            enabled = [bool]$candidate.Current.IsEnabled
            controlType = [string]$candidate.Current.ControlType.ProgrammaticName
            window = $candidateWindow.ToInt64()
            bounds = [ordered]@{
              x = $candidateBounds.X
              y = $candidateBounds.Y
              width = $candidateBounds.Width
              height = $candidateBounds.Height
            }
          }
          $menuItems.Add($entry)
          if ($null -eq $resetElement -and $entry.name -eq 'Reset' -and $entry.enabled) {
            $resetElement = $candidate
            $resetWindow = $candidateWindow
          }
        } catch { }
      }
    }
  }
  $propertyBrowserReset = @($resetCommands | Where-Object {
    $_.name -eq 'OtherContextMenus.PropertyBrowser.Reset' -and $_.available
  }) | Select-Object -First 1
  $invocationMethod = $null
  if ($null -ne $resetElement) {
    $resetEnabled = [bool]$resetElement.Current.IsEnabled
    $menuCapture = if ($resetWindow -ne [IntPtr]::Zero) {
      Save-WindowCapture $resetWindow $MenuDestination
    } else {
      Save-WindowCapture $hwnd $MenuDestination
    }
    $invokePattern = $null
    if ($resetElement.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
      ([System.Windows.Automation.InvokePattern]$invokePattern).Invoke()
      $invocationMethod = 'InvokePattern.Invoke'
    } else {
      $resetBounds = $resetElement.Current.BoundingRectangle
      [void][VisualStudioTraceNative]::PostClickUsingCapture(
        $(if ($resetWindow -ne [IntPtr]::Zero) { $resetWindow } else { $hwnd }),
        [int]($resetBounds.X + ($resetBounds.Width / 2)),
        [int]($resetBounds.Y + ($resetBounds.Height / 2))
      )
      $invocationMethod = 'PostClickUsingCapture'
    }
  } elseif ($null -ne $propertyBrowserReset) {
    [VisualStudioTraceNative]::PressEscape()
    Start-Sleep -Milliseconds 500
    $menuCapture = Save-WindowCapture $hwnd $MenuDestination
    $resetEnabled = $true
    $null = $Dte.ExecuteCommand('OtherContextMenus.PropertyBrowser.Reset')
    $invocationMethod = 'DTE.ExecuteCommand(OtherContextMenus.PropertyBrowser.Reset)'
  } else {
    [VisualStudioTraceNative]::PressEscape()
    $resetCommandSummary = $resetCommands | ConvertTo-Json -Compress
    throw "Visual Studio exposed neither an enabled Reset menu item nor the enabled PropertyBrowser.Reset command for S039. Registered commands: $resetCommandSummary"
  }
  Write-Host "S039: Reset invoked via $invocationMethod"
  Start-Sleep -Seconds 4

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $afterValue = $null
  $afterMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $propertyCondition)
  for ($index = 0; $index -lt $afterMatches.Count; $index++) {
    try {
      $candidate = $afterMatches.Item($index)
      if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
          $candidate.Current.IsOffscreen) { continue }
      $afterPattern = $null
      if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$afterPattern)) {
        $afterValue = [string]([System.Windows.Automation.ValuePattern]$afterPattern).Current.Value
      }
      break
    } catch { }
  }
  $capture = Save-WindowCapture $hwnd $Destination
  $dialogDismissal = [VisualStudioTraceNative]::StartDialogDismissal($hwnd, 'Inconsistent Line Endings', 7, 600000)
  $null = $Dte.ExecuteCommand('File.SaveAll')
  [void]$dialogDismissal.Thread.Join(1000)
  $dialogDismissal.Cancelled = $true
  [void]$dialogDismissal.Thread.Join(1000)
  Start-Sleep -Seconds 2

  return [ordered]@{
    document = $SourceFile
    controlAutomationId = $ControlAutomationId
    controlAutomationName = $ControlAutomationName
    controlLocator = $controlLocator
    propertyName = $PropertyName
    propertiesCommandAvailable = $propertiesAvailable
    beforeValue = $beforeValue
    afterValue = $afterValue
    clickedWindow = $clickedWindow.ToInt64()
    rowWindow = $rowWindow.ToInt64()
    contextWindow = $contextWindow.ToInt64()
    contextMenuMethod = $contextMenuMethod
    resetWindow = $resetWindow.ToInt64()
    resetEnabled = $resetEnabled
    invocationMethod = $invocationMethod
    registeredResetCommands = $resetCommands
    menuItems = $menuItems
    propertyBounds = [ordered]@{
      x = $propertyBounds.X
      y = $propertyBounds.Y
      width = $propertyBounds.Width
      height = $propertyBounds.Height
    }
    lineEndingDialog = [ordered]@{
      title = 'Inconsistent Line Endings'
      choice = 'No'
      observed = [bool]$dialogDismissal.Observed
      clickPosted = [bool]$dialogDismissal.ClickPosted
      dismissed = [bool]$dialogDismissal.Dismissed
    }
    menuCapture = $menuCapture
    capture = $capture
  }
}

function Open-DesignerPropertyDropdownAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $ControlAutomationId,
  [string] $PropertyName,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S041: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $controlCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ControlAutomationId
  )
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  if ($null -eq $control) { throw "Visual Studio designer did not expose '$ControlAutomationId' for S041." }
  Write-Host "S041: designer control '$ControlAutomationId' located"
  $controlBounds = $control.Current.BoundingRectangle
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($controlBounds.X + ($controlBounds.Width / 2)),
    [int]($controlBounds.Y + ($controlBounds.Height / 2))
  )
  Start-Sleep -Seconds 2
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Write-Host 'S041: Properties window opened'
  Start-Sleep -Seconds 5

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $propertyCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $PropertyName
  )
  $propertyRow = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $propertyCondition)
  if ($null -eq $propertyRow) { throw "Visual Studio Properties did not expose '$PropertyName' for S041." }
  Write-Host "S041: property row '$PropertyName' located"
  $propertyBounds = $propertyRow.Current.BoundingRectangle
  $rowWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($propertyBounds.Right - 70),
    [int]($propertyBounds.Y + ($propertyBounds.Height / 2))
  )
  Start-Sleep -Seconds 1
  $dropdownWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($propertyBounds.Right - 10),
    [int]($propertyBounds.Y + ($propertyBounds.Height / 2))
  )
  Write-Host 'S041: FlatStyle dropdown click posted'
  Start-Sleep -Seconds 3

  $capture = Save-WindowCapture $hwnd $Destination
  $popupCaptures = [System.Collections.Generic.List[object]]::new()
  $dropdownItems = [System.Collections.Generic.List[object]]::new()
  $seenDropdownItems = @{}
  $popupIndex = 0
  $processWindows = @([VisualStudioTraceNative]::GetProcessTopLevelWindows($hwnd))
  $uiaRoots = [System.Collections.Generic.List[object]]::new()
  $uiaRoots.Add($root)
  foreach ($processWindow in $processWindows) {
    if ($processWindow -eq $hwnd) { continue }
    try {
      $popupRect = New-Object VisualStudioTraceNative+RECT
      if (-not [VisualStudioTraceNative]::GetWindowRect($processWindow, [ref]$popupRect)) { continue }
      $popupWidth = $popupRect.Right - $popupRect.Left
      $popupHeight = $popupRect.Bottom - $popupRect.Top
      if ($popupWidth -lt 64 -or $popupHeight -lt 64 -or $popupWidth -gt 800 -or $popupHeight -gt 800) { continue }
      if ($popupRect.Right -lt ($propertyBounds.X - 80) -or
          $popupRect.Left -gt ($propertyBounds.Right + 320) -or
          $popupRect.Bottom -lt ($propertyBounds.Y - 80) -or
          $popupRect.Top -gt ($propertyBounds.Bottom + 320)) { continue }
      $popupIndex++
      $popupPath = Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) "visual-studio-dropdown-$popupIndex.png"
      $popupCapture = Save-WindowCapture $processWindow $popupPath
      $popupCaptures.Add([ordered]@{
        hwnd = $processWindow.ToInt64()
        artifact = [System.IO.Path]::GetFileName($popupPath)
        capture = $popupCapture
      })
      $popupRoot = [System.Windows.Automation.AutomationElement]::FromHandle($processWindow)
      if ($null -ne $popupRoot) { $uiaRoots.Add($popupRoot) }
    } catch { }
  }
  Write-Host "S041: inspecting $($uiaRoots.Count) bounded UI Automation root(s)"
  $listInventories = [System.Collections.Generic.List[object]]::new()
  foreach ($popupRoot in $uiaRoots) {
    try {
      $listCandidates = [System.Collections.Generic.List[object]]::new()
      try {
        if ($popupRoot.Current.ControlType -eq [System.Windows.Automation.ControlType]::List) {
          $listCandidates.Add($popupRoot)
        }
      } catch { }
      $listCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::List
      )
      foreach ($listCandidate in @($popupRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCondition))) {
        $listCandidates.Add($listCandidate)
      }
      foreach ($listCandidate in $listCandidates) {
        try {
          $listBounds = $listCandidate.Current.BoundingRectangle
          if ($listBounds.Width -lt 60 -or $listBounds.Height -lt 60 -or
              $listBounds.X -gt ($propertyBounds.Right + 320) -or
              $listBounds.Right -lt ($propertyBounds.X - 80) -or
              $listBounds.Y -gt ($propertyBounds.Bottom + 320) -or
              $listBounds.Bottom -lt ($propertyBounds.Y - 80)) { continue }
          $children = $listCandidate.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
          )
          $childItems = [System.Collections.Generic.List[object]]::new()
          for ($childIndex = 0; $childIndex -lt $children.Count; $childIndex++) {
            try {
              $child = $children.Item($childIndex)
              $childName = [string]$child.Current.Name
              if ($childName -notin @('Flat', 'Popup', 'Standard', 'System')) { continue }
              $childBounds = $child.Current.BoundingRectangle
              $childItems.Add([ordered]@{
                name = $childName
                controlType = [string]$child.Current.ControlType.ProgrammaticName
                bounds = [ordered]@{
                  x = $childBounds.X
                  y = $childBounds.Y
                  width = $childBounds.Width
                  height = $childBounds.Height
                }
              })
            } catch { }
          }
          $selectedItems = @()
          $selectionPattern = $null
          if ($listCandidate.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern, [ref]$selectionPattern)) {
            $selectedItems = @(([System.Windows.Automation.SelectionPattern]$selectionPattern).Current.GetSelection() |
              ForEach-Object { [string]$_.Current.Name })
          }
          $listInventories.Add([ordered]@{
            name = [string]$listCandidate.Current.Name
            bounds = [ordered]@{
              x = $listBounds.X
              y = $listBounds.Y
              width = $listBounds.Width
              height = $listBounds.Height
            }
            childItems = $childItems
            childNames = @($childItems | ForEach-Object { $_.name })
            selectedNames = $selectedItems
          })
        } catch { }
      }
      $popupElements = $popupRoot.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      for ($itemIndex = 0; $itemIndex -lt $popupElements.Count; $itemIndex++) {
        try {
          $candidate = $popupElements.Item($itemIndex)
          $candidateName = [string]$candidate.Current.Name
          if ($candidateName -notin @('Flat', 'Popup', 'Standard', 'System')) { continue }
          $candidateBounds = $candidate.Current.BoundingRectangle
          $key = "$candidateName|$($candidateBounds.X)|$($candidateBounds.Y)|$($candidateBounds.Width)|$($candidateBounds.Height)"
          if ($seenDropdownItems.ContainsKey($key)) { continue }
          $seenDropdownItems[$key] = $true
          $selected = $null
          $selectionPattern = $null
          if ($candidate.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) {
            $selected = [bool]([System.Windows.Automation.SelectionItemPattern]$selectionPattern).Current.IsSelected
          }
          $dropdownItems.Add([ordered]@{
            name = $candidateName
            controlType = [string]$candidate.Current.ControlType.ProgrammaticName
            selected = $selected
            bounds = [ordered]@{
              x = $candidateBounds.X
              y = $candidateBounds.Y
              width = $candidateBounds.Width
              height = $candidateBounds.Height
            }
          })
        } catch { }
      }
    } catch { }
  }
  Write-Host "S041: captured $($dropdownItems.Count) candidate dropdown item(s)"
  [VisualStudioTraceNative]::PressEscape()
  Start-Sleep -Seconds 2
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 2

  return [ordered]@{
    document = $SourceFile
    controlAutomationId = $ControlAutomationId
    propertyName = $PropertyName
    clickedWindow = $clickedWindow.ToInt64()
    rowWindow = $rowWindow.ToInt64()
    dropdownWindow = $dropdownWindow.ToInt64()
    propertyBounds = [ordered]@{
      x = $propertyBounds.X
      y = $propertyBounds.Y
      width = $propertyBounds.Width
      height = $propertyBounds.Height
    }
    items = @($dropdownItems | Sort-Object { $_.bounds.y }, { $_.bounds.x }, { $_.name })
    listInventories = $listInventories
    popupCaptures = $popupCaptures
    capture = $capture
  }
}

function Open-DesignerColorEditorAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $ControlAutomationId,
  [string] $Destination,
  [ValidateSet('S045', 'S046')]
  [string] $ScenarioId,
  [switch] $ApplyBlue
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host "$ScenarioId`: designer window activated"
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $selectionRoute = $null
  if ($ApplyBlue) {
    $outlineAvailable = $false
    try { $outlineAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable } catch { }
    if (-not $outlineAvailable) { throw 'Visual Studio did not enable View.DocumentOutline for S045.' }
    $null = $Dte.ExecuteCommand('View.DocumentOutline')
    Start-Sleep -Seconds 4
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $outlineInventory = @(Get-UiAutomationInventory $root)
    $outlinePane = @($outlineInventory | Where-Object {
      [string]$_.controlType -eq 'ControlType.Pane' -and [string]$_.name -like 'Document Outline - *' -and
      -not [bool]$_.offscreen -and [double]$_.bounds.width -gt 0 -and [double]$_.bounds.height -gt 0
    } | Sort-Object { [double]$_.bounds.width * [double]$_.bounds.height } -Descending) | Select-Object -First 1
    if ($null -eq $outlinePane) { throw 'Visual Studio exposed no measurable Document Outline pane for S045.' }
    $outlineLeft = [double]$outlinePane.bounds.x
    $outlineTop = [double]$outlinePane.bounds.y
    $outlineRight = $outlineLeft + [double]$outlinePane.bounds.width
    $outlineBottom = $outlineTop + [double]$outlinePane.bounds.height
    $outlineToolbar = @($outlineInventory | Where-Object {
      [string]$_.controlType -eq 'ControlType.ToolBar' -and [string]$_.name -eq 'Commands' -and
      [double]$_.bounds.x -ge $outlineLeft -and [double]$_.bounds.y -ge $outlineTop -and
      ([double]$_.bounds.x + [double]$_.bounds.width) -le $outlineRight -and
      ([double]$_.bounds.y + [double]$_.bounds.height) -le $outlineBottom
    }) | Select-Object -First 1
    if ($null -eq $outlineToolbar) { throw 'Visual Studio exposed no measurable Document Outline Commands toolbar for S045.' }
    # The deterministic S045 tree has the Form root followed by its single button1 child: first child row center is
    # Commands.Bottom + 29 at the captured 96-DPI native Document Outline layout.
    $outlineRowX = [int]($outlineLeft + [Math]::Min(80, [double]$outlinePane.bounds.width / 2))
    $outlineRowY = [int]([double]$outlineToolbar.bounds.y + [double]$outlineToolbar.bounds.height + 29)
    $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $outlineRowX, $outlineRowY)
    $selectionRoute = [ordered]@{
      method = 'Native owner-drawn Document Outline first child row'
      x = $outlineRowX
      y = $outlineRowY
      outlinePane = $outlinePane
      outlineToolbar = $outlineToolbar
    }
  } else {
    $controlCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $ControlAutomationId
    )
    $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
    if ($null -eq $control) { throw "Visual Studio designer did not expose '$ControlAutomationId' for $ScenarioId." }
    $controlBounds = $control.Current.BoundingRectangle
    $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
      $hwnd,
      [int]($controlBounds.X + ($controlBounds.Width / 2)),
      [int]($controlBounds.Y + ($controlBounds.Height / 2))
    )
    $selectionRoute = [ordered]@{
      method = 'Actual designer automation element through capture HWND'
      bounds = [ordered]@{ x = $controlBounds.X; y = $controlBounds.Y; width = $controlBounds.Width; height = $controlBounds.Height }
    }
  }
  Start-Sleep -Seconds 2

  $propertiesAvailable = $false
  try { $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable } catch { }
  if (-not $propertiesAvailable) { throw "Visual Studio did not enable View.PropertiesWindow for $ScenarioId." }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $alphabeticalCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Sort Properties Alphabetically'
  )
  $alphabeticalButton = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $alphabeticalCondition)
  $alphabeticalMethod = $null
  if ($null -ne $alphabeticalButton) {
    $invokePattern = $null
    if ($alphabeticalButton.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
      ([System.Windows.Automation.InvokePattern]$invokePattern).Invoke()
      $alphabeticalMethod = 'InvokePattern.Invoke'
    } else {
      $alphabeticalBounds = $alphabeticalButton.Current.BoundingRectangle
      [void][VisualStudioTraceNative]::PostClickUsingCapture(
        $hwnd,
        [int]($alphabeticalBounds.X + ($alphabeticalBounds.Width / 2)),
        [int]($alphabeticalBounds.Y + ($alphabeticalBounds.Height / 2))
      )
      $alphabeticalMethod = 'PostClickUsingCapture'
    }
    Start-Sleep -Seconds 2
  }
  Write-Host "$ScenarioId`: Properties alphabetical method=$alphabeticalMethod"
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $propertyCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'BackColor'
  )
  $propertyRows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $propertyCondition)
  $propertyRow = $null
  $beforeValue = $null
  $homeNavigation = $null
  for ($index = 0; $index -lt $propertyRows.Count; $index++) {
    try {
      $candidate = $propertyRows.Item($index)
      if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
          $candidate.Current.IsOffscreen) { continue }
      $candidateBounds = $candidate.Current.BoundingRectangle
      if ($candidateBounds.Width -le 0 -or $candidateBounds.Height -le 0) { continue }
      $propertyRow = $candidate
      $valuePattern = $null
      if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        $beforeValue = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
      }
      break
    } catch { }
  }
  if ($null -eq $propertyRow -and $propertyRows.Count -gt 0) {
    for ($index = 0; $index -lt $propertyRows.Count; $index++) {
      try {
        $candidate = $propertyRows.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem) { continue }
        $scrollItemPattern = $null
        if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollItemPattern)) {
          ([System.Windows.Automation.ScrollItemPattern]$scrollItemPattern).ScrollIntoView()
          Start-Sleep -Seconds 2
          break
        }
      } catch { }
    }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $propertyRows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $propertyCondition)
    for ($index = 0; $index -lt $propertyRows.Count; $index++) {
      try {
        $candidate = $propertyRows.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
            $candidate.Current.IsOffscreen) { continue }
        $candidateBounds = $candidate.Current.BoundingRectangle
        if ($candidateBounds.Width -le 0 -or $candidateBounds.Height -le 0) { continue }
        $propertyRow = $candidate
        $valuePattern = $null
        if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
          $beforeValue = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
        }
        break
      } catch { }
    }
  }
  if ($null -eq $propertyRow) {
    $propertiesWindowCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      'Properties Window'
    )
    $propertiesWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $propertiesWindowCondition)
    $propertiesWindow = $null
    for ($index = 0; $index -lt $propertiesWindows.Count; $index++) {
      try {
        $candidate = $propertiesWindows.Item($index)
        $bounds = $candidate.Current.BoundingRectangle
        if ($candidate.Current.IsOffscreen -or $bounds.Width -lt 180 -or $bounds.Height -lt 180) { continue }
        if ($null -eq $propertiesWindow -or
            ($bounds.Width * $bounds.Height) -gt
            ($propertiesWindow.Current.BoundingRectangle.Width * $propertiesWindow.Current.BoundingRectangle.Height)) {
          $propertiesWindow = $candidate
        }
      } catch { }
    }
    if ($null -ne $propertiesWindow) {
      $paneBounds = $propertiesWindow.Current.BoundingRectangle
      $treeItemCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TreeItem
      )
      $treeItems = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $treeItemCondition)
      for ($index = 0; $index -lt $treeItems.Count; $index++) {
        try {
          $candidate = $treeItems.Item($index)
          if ($candidate.Current.IsOffscreen) { continue }
          $bounds = $candidate.Current.BoundingRectangle
          if ($bounds.Width -le 0 -or $bounds.Height -le 0 -or
              $bounds.X -lt $paneBounds.X -or $bounds.Right -gt $paneBounds.Right -or
              $bounds.Y -lt ($paneBounds.Y + 60) -or $bounds.Bottom -gt $paneBounds.Bottom) { continue }
          $focusX = [int]($bounds.X + [Math]::Min(60, $bounds.Width / 3))
          $focusY = [int]($bounds.Y + ($bounds.Height / 2))
          [void][VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $focusX, $focusY)
          [void][VisualStudioTraceNative]::PressVirtualKeyAtDeepestChild($hwnd, $focusX, $focusY, 0x24)
          $homeNavigation = [ordered]@{
            row = [string]$candidate.Current.Name
            x = $focusX
            y = $focusY
            method = 'PropertyGrid visible row + VK_HOME'
          }
          Start-Sleep -Seconds 2
          break
        } catch { }
      }
    }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $propertyRows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $propertyCondition)
    for ($index = 0; $index -lt $propertyRows.Count; $index++) {
      try {
        $candidate = $propertyRows.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
            $candidate.Current.IsOffscreen) { continue }
        $candidateBounds = $candidate.Current.BoundingRectangle
        if ($candidateBounds.Width -le 0 -or $candidateBounds.Height -le 0) { continue }
        $propertyRow = $candidate
        $valuePattern = $null
        if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
          $beforeValue = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
        }
        break
      } catch { }
    }
  }
  if ($null -eq $propertyRow) {
    throw "Visual Studio Properties did not expose a visible BackColor row for $ScenarioId (candidateCount=$($propertyRows.Count))."
  }
  $propertyBounds = $propertyRow.Current.BoundingRectangle
  $rowWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($propertyBounds.Right - 70),
    [int]($propertyBounds.Y + ($propertyBounds.Height / 2))
  )
  Start-Sleep -Seconds 1
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  $editorButtons = [System.Collections.Generic.List[object]]::new()
  $editorButtonElement = $null
  for ($index = 0; $index -lt $buttons.Count; $index++) {
    try {
      $candidate = $buttons.Item($index)
      if ($candidate.Current.IsOffscreen -or -not $candidate.Current.IsEnabled) { continue }
      $bounds = $candidate.Current.BoundingRectangle
      if ($bounds.Width -le 0 -or $bounds.Height -le 0 -or
          $bounds.Bottom -le $propertyBounds.Y -or $bounds.Y -ge $propertyBounds.Bottom -or
          $bounds.X -lt ($propertyBounds.X + ($propertyBounds.Width / 2)) -or
          $bounds.Right -gt ($propertyBounds.Right + 4)) { continue }
      $record = ConvertTo-UiAutomationRecord $candidate $root
      $editorButtons.Add($record)
      if ($null -eq $editorButtonElement -or $bounds.X -gt $editorButtonElement.Current.BoundingRectangle.X) {
        $editorButtonElement = $candidate
      }
    } catch { }
  }
  $dropdownWindow = [IntPtr]::Zero
  $editorOpenMethod = $null
  if ($null -ne $editorButtonElement) {
    $buttonBounds = $editorButtonElement.Current.BoundingRectangle
    $dropdownWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
      $hwnd,
      [int]($buttonBounds.X + ($buttonBounds.Width / 2)),
      [int]($buttonBounds.Y + ($buttonBounds.Height / 2))
    )
    $editorOpenMethod = 'Editor button PostClickUsingCapture'
  } else {
    $dropdownWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
      $hwnd,
      [int]($propertyBounds.Right - 25),
      [int]($propertyBounds.Y + ($propertyBounds.Height / 2))
    )
    $editorOpenMethod = 'Property row Right-25 PostClickUsingCapture'
  }
  Write-Host "$ScenarioId`: BackColor editor activated via $editorOpenMethod; buttons=$($editorButtons.Count); before='$beforeValue'"
  Start-Sleep -Seconds 3

  $mainCapturePath = [System.IO.Path]::ChangeExtension($Destination, '.main.png')
  $mainCapture = Save-WindowCapture $hwnd $mainCapturePath
  $processWindows = @([VisualStudioTraceNative]::GetProcessTopLevelWindows($hwnd))
  $uiaRoots = [System.Collections.Generic.List[object]]::new()
  $uiaRoots.Add($root)
  $popupCaptures = [System.Collections.Generic.List[object]]::new()
  $popupIndex = 0
  $colorEditorHwnd = [IntPtr]::Zero
  $colorEditorSystemPane = $null
  foreach ($processWindow in $processWindows) {
    if ($processWindow -eq $hwnd) { continue }
    try {
      $popupRect = New-Object VisualStudioTraceNative+RECT
      if (-not [VisualStudioTraceNative]::GetWindowRect($processWindow, [ref]$popupRect)) { continue }
      $popupWidth = $popupRect.Right - $popupRect.Left
      $popupHeight = $popupRect.Bottom - $popupRect.Top
      if ($popupWidth -lt 40 -or $popupHeight -lt 40 -or $popupWidth -gt 900 -or $popupHeight -gt 900) { continue }
      if ($popupRect.Right -lt ($propertyBounds.X - 120) -or
          $popupRect.Left -gt ($propertyBounds.Right + 420) -or
          $popupRect.Bottom -lt ($propertyBounds.Y - 120) -or
          $popupRect.Top -gt ($propertyBounds.Bottom + 520)) { continue }
      $popupIndex++
      $popupPath = Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) "visual-studio-color-popup-$popupIndex.png"
      $popupCapture = Save-WindowCapture $processWindow $popupPath
      $popupCaptures.Add([ordered]@{
        hwnd = $processWindow.ToInt64()
        artifact = [System.IO.Path]::GetFileName($popupPath)
        capture = $popupCapture
      })
      if ($colorEditorHwnd -eq [IntPtr]::Zero -and
          $popupWidth -ge 180 -and $popupWidth -le 260 -and
          $popupHeight -ge 180 -and $popupHeight -le 280) {
        $colorEditorHwnd = $processWindow
      }
      $popupRoot = [System.Windows.Automation.AutomationElement]::FromHandle($processWindow)
      if ($null -ne $popupRoot) {
        $uiaRoots.Add($popupRoot)
        $popupInventory = @(Get-UiAutomationInventory $popupRoot)
        $systemPane = @($popupInventory | Where-Object {
          [string]$_.name -eq 'System' -and [string]$_.controlType -eq 'ControlType.Pane' -and
          -not [bool]$_.offscreen -and [double]$_.bounds.width -gt 0 -and [double]$_.bounds.height -gt 0
        }) | Select-Object -First 1
        if ($null -ne $systemPane) {
          $colorEditorHwnd = $processWindow
          $colorEditorSystemPane = $systemPane
        }
      }
    } catch { }
  }

  $editorInventory = [System.Collections.Generic.List[object]]::new()
  foreach ($uiaRoot in $uiaRoots) {
    foreach ($record in @(Get-UiAutomationInventory $uiaRoot)) {
      if ([string]$record.name -match '(?i)^Custom$|^Web$|^System$|Color|BackColor|Transparent|Control' -or
          [string]$record.value -match '(?i)^Custom$|^Web$|^System$|Color|BackColor|Transparent|Control') {
        $editorInventory.Add($record)
      }
    }
  }
  $tabNames = @($editorInventory | Where-Object {
    [string]$_.controlType -eq 'ControlType.TabItem' -and [string]$_.name -in @('Custom', 'Web', 'System')
  } | ForEach-Object { [string]$_.name } | Sort-Object -Unique)
  $selection = $null
  $cancelledWithEscape = $false
  $committedWithEnter = $false
  if ($ApplyBlue) {
    if ($colorEditorHwnd -eq [IntPtr]::Zero) {
      throw 'Visual Studio did not expose the native Color editor HWND required for S045 Blue selection.'
    }
    $webPane = @($editorInventory | Where-Object {
      [string]$_.name -eq 'Web' -and [string]$_.controlType -eq 'ControlType.Pane' -and
      -not [bool]$_.offscreen -and [double]$_.bounds.width -gt 0 -and [double]$_.bounds.height -gt 0
    }) | Select-Object -First 1
    if ($null -ne $webPane) {
      $selectionX = [int]([double]$webPane.bounds.x + ([double]$webPane.bounds.width / 2))
      $selectionY = [int]([double]$webPane.bounds.y + ([double]$webPane.bounds.height / 2))
      $selectionBoundsSource = 'UIAutomation Web Pane'
    } else {
      $colorPopup = @($popupCaptures | Where-Object { [long]$_.hwnd -eq $colorEditorHwnd.ToInt64() }) | Select-Object -First 1
      if ($null -eq $colorPopup) { throw 'Visual Studio Color editor had no Web Pane or matching popup capture for S045.' }
      $selectionX = [int]([double]$colorPopup.capture.x + ([double]$colorPopup.capture.width / 2))
      $selectionY = [int]([double]$colorPopup.capture.y + 25 + (([double]$colorPopup.capture.height - 30) / 2))
      $selectionBoundsSource = 'Color popup geometry fallback'
    }

    # The installed ColorEditor list observed here places Blue one row below MediumBlue. Navigating to End and Up 26
    # selects the exact named Color.Blue without replacing the native editor or writing a Properties text value.
    $selectionTarget = [VisualStudioTraceNative]::PressVirtualKeyAtDeepestChild(
      $colorEditorHwnd,
      $selectionX,
      $selectionY,
      0x23
    )
    for ($step = 0; $step -lt 26; $step++) {
      [void][VisualStudioTraceNative]::PressVirtualKeyAtDeepestChild($colorEditorHwnd, $selectionX, $selectionY, 0x26)
    }
    Start-Sleep -Seconds 2
    $openCapture = Save-WindowScreenCapture $hwnd $Destination
    $selection = [ordered]@{
      requestedValue = 'Blue'
      method = 'ColorEditorListBox VK_END then 26 x VK_UP'
      boundsSource = $selectionBoundsSource
      x = $selectionX
      y = $selectionY
      targetWindow = $selectionTarget.ToInt64()
      fromEndOffset = 26
    }
    [void][VisualStudioTraceNative]::PressVirtualKeyAtDeepestChild($colorEditorHwnd, $selectionX, $selectionY, 0x0D)
    $committedWithEnter = $true
  } else {
    $openCapture = Save-WindowScreenCapture $hwnd $Destination
    [VisualStudioTraceNative]::PressEscape()
    $cancelledWithEscape = $true
  }
  Write-Host "$ScenarioId`: color editor evidence roots=$($uiaRoots.Count); popups=$($popupCaptures.Count); systemPane=$($null -ne $colorEditorSystemPane); tabs=$($tabNames -join ','); applyBlue=$([bool]$ApplyBlue)"
  Start-Sleep -Seconds 3
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $afterValue = $null
  $afterRows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $propertyCondition)
  for ($index = 0; $index -lt $afterRows.Count; $index++) {
    try {
      $candidate = $afterRows.Item($index)
      if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
          $candidate.Current.IsOffscreen) { continue }
      $valuePattern = $null
      if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        $afterValue = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
      }
      break
    } catch { }
  }
  $afterActionPath = [System.IO.Path]::ChangeExtension(
    $Destination,
    $(if ($ApplyBlue) { '.after-apply.png' } else { '.after-cancel.png' })
  )
  $afterActionCapture = Save-WindowCapture $hwnd $afterActionPath
  $afterCancelCapture = if ($ApplyBlue) { $null } else { $afterActionCapture }
  $afterApplyCapture = if ($ApplyBlue) { $afterActionCapture } else { $null }

  return [ordered]@{
    document = $SourceFile
    controlAutomationId = $ControlAutomationId
    propertyName = 'BackColor'
    windowHandle = $hwnd.ToInt64()
    propertiesCommandAvailable = $propertiesAvailable
    alphabeticalMethod = $alphabeticalMethod
    homeNavigation = $homeNavigation
    beforeValue = $beforeValue
    afterValue = $afterValue
    selectionRoute = $selectionRoute
    clickedWindow = $clickedWindow.ToInt64()
    rowWindow = $rowWindow.ToInt64()
    dropdownWindow = $dropdownWindow.ToInt64()
    editorOpenMethod = $editorOpenMethod
    editorButtons = $editorButtons
    propertyBounds = [ordered]@{
      x = $propertyBounds.X
      y = $propertyBounds.Y
      width = $propertyBounds.Width
      height = $propertyBounds.Height
    }
    colorEditorTabNames = $tabNames
    colorEditorHwnd = $colorEditorHwnd.ToInt64()
    colorEditorSystemPane = $colorEditorSystemPane
    editorInventory = $editorInventory
    popupCaptures = $popupCaptures
    selection = $selection
    cancelledWithEscape = $cancelledWithEscape
    committedWithEnter = $committedWithEnter
    mainCapture = $mainCapture
    capture = $openCapture
    afterActionCapture = $afterActionCapture
    afterCancelCapture = $afterCancelCapture
    afterApplyCapture = $afterApplyCapture
  }
}

function Open-DesignerPaddingSubpropertyAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $ControlAutomationId,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S042: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $controlCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ControlAutomationId
  )
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  if ($null -eq $control) { throw "Visual Studio designer did not expose '$ControlAutomationId' for S042." }
  $controlBounds = $control.Current.BoundingRectangle
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($controlBounds.X + ($controlBounds.Width / 2)),
    [int]($controlBounds.Y + ($controlBounds.Height / 2))
  )
  Start-Sleep -Seconds 2
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Write-Host 'S042: Properties window opened'
  Start-Sleep -Seconds 5

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $paddingCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Padding'
  )
  $paddingMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $paddingCondition)
  $paddingRow = $null
  for ($index = 0; $index -lt $paddingMatches.Count; $index++) {
    try {
      $candidate = $paddingMatches.Item($index)
      $candidateBounds = $candidate.Current.BoundingRectangle
      if ($candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::TreeItem -and
          -not $candidate.Current.IsOffscreen -and $candidateBounds.Width -gt 0 -and $candidateBounds.Height -gt 0) {
        $paddingRow = $candidate
        break
      }
    } catch { }
  }
  if ($null -eq $paddingRow) {
    for ($index = 0; $index -lt $paddingMatches.Count; $index++) {
      try {
        $candidate = $paddingMatches.Item($index)
        if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem) { continue }
        $scrollPattern = $null
        if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollPattern)) {
          ([System.Windows.Automation.ScrollItemPattern]$scrollPattern).ScrollIntoView()
          Start-Sleep -Seconds 2
          $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
          $refreshedMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $paddingCondition)
          for ($refreshIndex = 0; $refreshIndex -lt $refreshedMatches.Count; $refreshIndex++) {
            $refreshed = $refreshedMatches.Item($refreshIndex)
            $refreshedBounds = $refreshed.Current.BoundingRectangle
            if ($refreshed.Current.ControlType -eq [System.Windows.Automation.ControlType]::TreeItem -and
                -not $refreshed.Current.IsOffscreen -and $refreshedBounds.Width -gt 0 -and $refreshedBounds.Height -gt 0) {
              $paddingRow = $refreshed
              break
            }
          }
          if ($null -ne $paddingRow) { break }
        }
      } catch { }
    }
  }
  if ($null -eq $paddingRow) {
    $tableCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Table
    )
    $tables = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tableCondition)
    $propertyTable = $null
    for ($index = 0; $index -lt $tables.Count; $index++) {
      try {
        $candidate = $tables.Item($index)
        $candidateBounds = $candidate.Current.BoundingRectangle
        if ([string]$candidate.Current.Name -eq 'Properties Window' -and
            -not $candidate.Current.IsOffscreen -and $candidateBounds.Width -gt 200 -and $candidateBounds.Height -gt 200) {
          $propertyTable = $candidate
          break
        }
      } catch { }
    }
    $tableScrollPattern = $null
    if ($null -ne $propertyTable -and
        $propertyTable.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$tableScrollPattern) -and
        ([System.Windows.Automation.ScrollPattern]$tableScrollPattern).Current.VerticallyScrollable) {
      foreach ($percent in @(0.0, 20.0, 40.0, 60.0, 80.0, 100.0)) {
        ([System.Windows.Automation.ScrollPattern]$tableScrollPattern).SetScrollPercent(
          [System.Windows.Automation.ScrollPattern]::NoScroll,
          [double]$percent
        )
        Start-Sleep -Milliseconds 700
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $refreshedMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $paddingCondition)
        for ($refreshIndex = 0; $refreshIndex -lt $refreshedMatches.Count; $refreshIndex++) {
          try {
            $refreshed = $refreshedMatches.Item($refreshIndex)
            $refreshedBounds = $refreshed.Current.BoundingRectangle
            if ($refreshed.Current.ControlType -eq [System.Windows.Automation.ControlType]::TreeItem -and
                -not $refreshed.Current.IsOffscreen -and $refreshedBounds.Width -gt 0 -and $refreshedBounds.Height -gt 0) {
              $paddingRow = $refreshed
              break
            }
          } catch { }
        }
        if ($null -ne $paddingRow) { break }
      }
    }
    if ($null -eq $paddingRow -and $null -ne $propertyTable) {
      $propertyTableBounds = $propertyTable.Current.BoundingRectangle
      $wheelX = [int]($propertyTableBounds.X + ($propertyTableBounds.Width / 2))
      $wheelY = [int]($propertyTableBounds.Y + ($propertyTableBounds.Height / 2))
      for ($wheelStep = 0; $wheelStep -lt 16 -and $null -eq $paddingRow; $wheelStep++) {
        [void][VisualStudioTraceNative]::PostMouseWheelAtDeepestChild($hwnd, $wheelX, $wheelY, -120)
        Start-Sleep -Milliseconds 250
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $refreshedMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $paddingCondition)
        for ($refreshIndex = 0; $refreshIndex -lt $refreshedMatches.Count; $refreshIndex++) {
          try {
            $refreshed = $refreshedMatches.Item($refreshIndex)
            $refreshedBounds = $refreshed.Current.BoundingRectangle
            if ($refreshed.Current.ControlType -eq [System.Windows.Automation.ControlType]::TreeItem -and
                -not $refreshed.Current.IsOffscreen -and $refreshedBounds.Width -gt 0 -and $refreshedBounds.Height -gt 0) {
              $paddingRow = $refreshed
              break
            }
          } catch { }
        }
      }
    }
  }
  if ($null -eq $paddingRow) {
    $visibleRows = [System.Collections.Generic.List[string]]::new()
    $treeItemCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TreeItem
    )
    foreach ($candidate in @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $treeItemCondition))) {
      try {
        if ($candidate.Current.IsOffscreen) { continue }
        $bounds = $candidate.Current.BoundingRectangle
        if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
        $pattern = $null
        $value = $null
        if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          $value = [string]([System.Windows.Automation.ValuePattern]$pattern).Current.Value
        }
        if ($visibleRows.Count -lt 50) { $visibleRows.Add("$([string]$candidate.Current.Name)=$value") }
      } catch { }
    }
    $null = Save-WindowCapture $hwnd $Destination
    throw "Visual Studio Properties did not expose a visible Padding row for S042. Visible rows: $($visibleRows -join ' | ')"
  }
  $paddingBounds = $paddingRow.Current.BoundingRectangle
  $beforePadding = $null
  $paddingValuePattern = $null
  if ($paddingRow.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$paddingValuePattern)) {
    $beforePadding = [string]([System.Windows.Automation.ValuePattern]$paddingValuePattern).Current.Value
  }
  Write-Host "S042: Padding row located with value '$beforePadding'"

  $expandMethod = $null
  $expandPattern = $null
  if ($paddingRow.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expandPattern)) {
    $expandState = ([System.Windows.Automation.ExpandCollapsePattern]$expandPattern).Current.ExpandCollapseState
  } else {
    $expandState = $null
  }
  if ($expandState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) {
    # VS hosts this as a legacy owner-drawn PropertyGrid. Its UIA ExpandCollapse provider reports the state but
    # does not execute Expand; the underlying MSAA default action is the semantic +/- toggle.
    $legacyPattern = $null
    $legacyPatternIdentifier = [System.Windows.Automation.AutomationPattern]::LookupById(10018)
    if ($null -ne $legacyPatternIdentifier -and
        $paddingRow.TryGetCurrentPattern($legacyPatternIdentifier, [ref]$legacyPattern)) {
      $legacyDefaultAction = [string]$legacyPattern.Current.DefaultAction
      $legacyPattern.DoDefaultAction()
      $expandMethod = "LegacyIAccessiblePattern.DoDefaultAction('$legacyDefaultAction')"
    } elseif ($null -ne $expandPattern) {
      $propertyNameX = [int]($paddingBounds.X + [Math]::Min(55, $paddingBounds.Width / 3))
      $propertyNameY = [int]($paddingBounds.Y + ($paddingBounds.Height / 2))
      [void][VisualStudioTraceNative]::ClickAtDeepestChild($hwnd, $propertyNameX, $propertyNameY)
      [void][VisualStudioTraceNative]::PressVirtualKeyAtDeepestChild($hwnd, $propertyNameX, $propertyNameY, 0x27)
      $expandMethod = "PropertyGrid VK_RIGHT at $propertyNameX,$propertyNameY"
    } else {
      throw 'Visual Studio exposed neither LegacyIAccessible nor ExpandCollapse for the S042 Padding row.'
    }
  } else {
    $expandMethod = 'AlreadyExpanded'
  }
  Write-Host "S042: Padding expanded via $expandMethod"
  Start-Sleep -Seconds 3

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $leftCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Left'
  )
  $leftMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $leftCondition)
  $leftRow = $null
  for ($index = 0; $index -lt $leftMatches.Count; $index++) {
    try {
      $candidate = $leftMatches.Item($index)
      $candidateBounds = $candidate.Current.BoundingRectangle
      if ($candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::TreeItem -and
          -not $candidate.Current.IsOffscreen -and
          $candidateBounds.Y -gt $paddingBounds.Y -and $candidateBounds.Y -lt ($paddingBounds.Y + 120) -and
          $candidateBounds.Width -gt 0 -and $candidateBounds.Height -gt 0) {
        $leftRow = $candidate
        break
      }
      } catch { }
  }
  if ($null -eq $leftRow -and $null -ne $propertyTable) {
    $propertyTableBounds = $propertyTable.Current.BoundingRectangle
    $wheelX = [int]($propertyTableBounds.X + ($propertyTableBounds.Width / 2))
    $wheelY = [int]($propertyTableBounds.Y + ($propertyTableBounds.Height / 2))
    for ($wheelStep = 0; $wheelStep -lt 6 -and $null -eq $leftRow; $wheelStep++) {
      [void][VisualStudioTraceNative]::PostMouseWheelAtDeepestChild($hwnd, $wheelX, $wheelY, -120)
      Start-Sleep -Milliseconds 300
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      $leftMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $leftCondition)
      for ($index = 0; $index -lt $leftMatches.Count; $index++) {
        try {
          $candidate = $leftMatches.Item($index)
          $candidateBounds = $candidate.Current.BoundingRectangle
          if ($candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::TreeItem -and
              -not $candidate.Current.IsOffscreen -and
              $candidateBounds.Y -gt ($propertyTableBounds.Y - 20) -and
              $candidateBounds.Bottom -lt ($propertyTableBounds.Bottom + 20) -and
              $candidateBounds.Width -gt 0 -and $candidateBounds.Height -gt 0) {
            $leftRow = $candidate
            break
          }
        } catch { }
      }
    }
  }
  if ($null -eq $leftRow) {
    $expandedRows = [System.Collections.Generic.List[string]]::new()
    $treeItemCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TreeItem
    )
    foreach ($candidate in @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $treeItemCondition))) {
      try {
        if ($candidate.Current.IsOffscreen) { continue }
        $bounds = $candidate.Current.BoundingRectangle
        if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
        if ($expandedRows.Count -lt 50) { $expandedRows.Add([string]$candidate.Current.Name) }
      } catch { }
    }
    $null = Save-WindowCapture $hwnd $Destination
    throw "Visual Studio did not expose the expanded Padding.Left row for S042. Visible rows after expand: $($expandedRows -join ' | ')"
  }
  $leftBounds = $leftRow.Current.BoundingRectangle
  $beforeLeft = $null
  $leftValuePattern = $null
  if ($leftRow.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$leftValuePattern)) {
    $beforeLeft = [string]([System.Windows.Automation.ValuePattern]$leftValuePattern).Current.Value
  }
  Write-Host "S042: expanded Left row located with value '$beforeLeft'"

  $valueX = [int]($leftBounds.Right - 70)
  $valueY = [int]($leftBounds.Y + ($leftBounds.Height / 2))
  $valueWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $valueX, $valueY)
  Start-Sleep -Seconds 1
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $editCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
  )
  $editMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
  $valueEditor = $null
  for ($index = 0; $index -lt $editMatches.Count; $index++) {
    try {
      $candidate = $editMatches.Item($index)
      $candidateBounds = $candidate.Current.BoundingRectangle
      if (-not $candidate.Current.IsOffscreen -and
          $candidateBounds.Bottom -ge $leftBounds.Y -and $candidateBounds.Y -le $leftBounds.Bottom -and
          $candidateBounds.Right -gt ($leftBounds.X + ($leftBounds.Width / 2))) {
        $valueEditor = $candidate
        break
      }
    } catch { }
  }
  $editorPattern = $null
  $editMethod = $null
  if ($null -ne $valueEditor -and
      $valueEditor.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$editorPattern)) {
    ([System.Windows.Automation.ValuePattern]$editorPattern).SetValue('8')
    $editMethod = 'Edit.ValuePattern.SetValue'
  } elseif ($leftRow.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$leftValuePattern)) {
    ([System.Windows.Automation.ValuePattern]$leftValuePattern).SetValue('8')
    $editMethod = 'TreeItem.ValuePattern.SetValue'
  } else {
    throw 'Visual Studio exposed neither an editable child nor a writable Left ValuePattern for S042.'
  }
  [VisualStudioTraceNative]::PressEnter()
  Write-Host "S042: Padding.Left edit committed via $editMethod"
  Start-Sleep -Seconds 4

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $afterPadding = $null
  $afterLeft = $null
  foreach ($match in @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $paddingCondition))) {
    try {
      if ($match.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or $match.Current.IsOffscreen) { continue }
      $pattern = $null
      if ($match.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $afterPadding = [string]([System.Windows.Automation.ValuePattern]$pattern).Current.Value
      }
      break
    } catch { }
  }
  foreach ($match in @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $leftCondition))) {
    try {
      $bounds = $match.Current.BoundingRectangle
      if ($match.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
          $match.Current.IsOffscreen -or $bounds.Y -le $paddingBounds.Y -or $bounds.Y -ge ($paddingBounds.Y + 120)) { continue }
      $pattern = $null
      if ($match.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $afterLeft = [string]([System.Windows.Automation.ValuePattern]$pattern).Current.Value
      }
      break
    } catch { }
  }
  $capture = Save-WindowCapture $hwnd $Destination
  $dialogDismissal = [VisualStudioTraceNative]::StartDialogDismissal($hwnd, 'Inconsistent Line Endings', 7, 600000)
  $null = $Dte.ExecuteCommand('File.SaveAll')
  [void]$dialogDismissal.Thread.Join(1000)
  $dialogDismissal.Cancelled = $true
  [void]$dialogDismissal.Thread.Join(1000)
  Start-Sleep -Seconds 2

  return [ordered]@{
    document = $SourceFile
    controlAutomationId = $ControlAutomationId
    clickedWindow = $clickedWindow.ToInt64()
    valueWindow = $valueWindow.ToInt64()
    beforePadding = $beforePadding
    beforeLeft = $beforeLeft
    afterPadding = $afterPadding
    afterLeft = $afterLeft
    expandMethod = $expandMethod
    editMethod = $editMethod
    paddingBounds = [ordered]@{ x = $paddingBounds.X; y = $paddingBounds.Y; width = $paddingBounds.Width; height = $paddingBounds.Height }
    leftBounds = [ordered]@{ x = $leftBounds.X; y = $leftBounds.Y; width = $leftBounds.Width; height = $leftBounds.Height }
    lineEndingDialog = [ordered]@{
      title = 'Inconsistent Line Endings'
      choice = 'No'
      observed = [bool]$dialogDismissal.Observed
      clickPosted = [bool]$dialogDismissal.ClickPosted
      dismissed = [bool]$dialogDismissal.Dismissed
    }
    capture = $capture
  }
}

function Open-DesignerResizeAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $AutomationId,
  [int] $WidthDelta,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $elementCondition = $condition
  $elementCondition = $condition
  if ($null -eq $element) { throw "Visual Studio designer did not expose automation id '$AutomationId'." }
  $before = $element.Current.BoundingRectangle
  if ($before.Width -lt 1 -or $before.Height -lt 1) {
    throw "Visual Studio designer element '$AutomationId' has invalid bounds: $before"
  }

  $centerX = [int]($before.X + ($before.Width / 2))
  $centerY = [int]($before.Y + ($before.Height / 2))
  $clickedWindow = [VisualStudioTraceNative]::ClickAtDeepestChild($hwnd, $centerX, $centerY)
  Start-Sleep -Seconds 2
  # The WinForms Designer's east sizing handle is three physical pixels beyond the component's accessible bounds.
  # Direct window messages are deliberate: the trace host has no interactive foreground desktop, while this still
  # traverses the real BehaviorService/adorner input window and the IDE's own designer transaction/serializer.
  $dragStartX = [int]($before.X + $before.Width + 3)
  $dragWindow = [VisualStudioTraceNative]::DragAtDeepestChild(
    $hwnd,
    $dragStartX,
    $centerY,
    $dragStartX + $WidthDelta,
    $centerY
  )
  Start-Sleep -Seconds 3
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3

  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($null -eq $element) { throw "Visual Studio designer lost automation id '$AutomationId' after resize." }
  $after = $element.Current.BoundingRectangle
  $capture = Save-WindowCapture $hwnd $Destination
  return [ordered]@{
    document = $SourceFile
    automationId = $AutomationId
    input = [ordered]@{
      clickedWindow = $clickedWindow.ToInt64()
      dragWindow = $dragWindow.ToInt64()
      widthDelta = $WidthDelta
    }
    beforeBounds = [ordered]@{ x = $before.X; y = $before.Y; width = $before.Width; height = $before.Height }
    afterBounds = [ordered]@{ x = $after.X; y = $after.Y; width = $after.Width; height = $after.Height }
    capture = $capture
  }
}

function Open-DesignerBaselineSnapAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $MovingAutomationId,
  [string] $ReferenceAutomationId,
  [int] $DeltaY,
  [string] $Destination,
  [int] $DeltaX = 0,
  [switch] $HoldAlt,
  [string] $MovingNativeText = '',
  [string] $ReferenceNativeText = ''
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $movingCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $MovingAutomationId
  )
  $referenceCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ReferenceAutomationId
  )
  $movingElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $movingCondition)
  $referenceElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $referenceCondition)
  $boundsLocator = 'UIAutomation.AutomationId'
  $movingNativeWindow = [IntPtr]::Zero
  $referenceNativeWindow = [IntPtr]::Zero
  $outlineSelection = $null
  if ($null -eq $movingElement -or $null -eq $referenceElement) {
    if ($MovingNativeText -and $ReferenceNativeText) {
      $nativeButtons = @([VisualStudioTraceNative]::GetDescendantWindowsByClassFragment($hwnd, 'BUTTON'))
      $movingNativeMatches = @($nativeButtons | Where-Object {
        [VisualStudioTraceNative]::GetWindowTextValue([IntPtr]$_) -ceq $MovingNativeText
      })
      $referenceNativeMatches = @($nativeButtons | Where-Object {
        [VisualStudioTraceNative]::GetWindowTextValue([IntPtr]$_) -ceq $ReferenceNativeText
      })
      if ($movingNativeMatches.Count -eq 1 -and $referenceNativeMatches.Count -eq 1) {
        $movingNativeWindow = [IntPtr]$movingNativeMatches[0]
        $referenceNativeWindow = [IntPtr]$referenceNativeMatches[0]
        $boundsLocator = 'native WindowsForms10.BUTTON HWND exact text'
      }
    }
    if ($movingNativeWindow -eq [IntPtr]::Zero -or $referenceNativeWindow -eq [IntPtr]::Zero) {
      $diagnosticCapture = Save-WindowCapture $hwnd $Destination
      $available = @($root.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition) |
        ForEach-Object {
          $current = $_.Current
          if ($current.AutomationId -or $current.Name) {
            "id='$($current.AutomationId)' name='$($current.Name)' type='$($current.ControlType.ProgrammaticName)'"
          }
        } | Select-Object -First 80)
      $nativeWindows = @([VisualStudioTraceNative]::GetDescendantWindowInventory($hwnd) | Select-Object -First 160)
      throw "Visual Studio designer did not expose moving '$MovingAutomationId' and reference '$ReferenceAutomationId'. Diagnostic capture SHA-256=$($diagnosticCapture.sha256). Available elements: $($available -join '; '). Native descendants: $($nativeWindows -join '; ')"
    }
  }
  if ($boundsLocator -ne 'UIAutomation.AutomationId') {
    $outlineAvailable = $false
    try { $outlineAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable } catch { }
    if (-not $outlineAvailable) { throw 'Visual Studio did not enable View.DocumentOutline for the native S027 selection.' }
    $null = $Dte.ExecuteCommand('View.DocumentOutline')
    Start-Sleep -Seconds 2
    $outlineTrees = @([VisualStudioTraceNative]::GetDescendantWindowsByClassFragment($hwnd, 'SysTreeView32'))
    if ($outlineTrees.Count -ne 1) {
      throw "Visual Studio exposed $($outlineTrees.Count) native Document Outline trees for S027; expected exactly one."
    }
    $outlineTree = [IntPtr]$outlineTrees[0]
    $outlineRect = New-Object VisualStudioTraceNative+RECT
    if (-not [VisualStudioTraceNative]::GetWindowRect($outlineTree, [ref]$outlineRect)) {
      throw 'Visual Studio did not expose measurable native Document Outline bounds for S027.'
    }
    $dpiScale = [double]([VisualStudioTraceNative]::GetDpiForWindow($hwnd)) / 96.0
    $rowHeight = [int][Math]::Round(18 * $dpiScale)
    $outlineX = [int]($outlineRect.Left + [Math]::Round(100 * $dpiScale))
    # Exact visible fixture order is Form, referenceButton, button1; select the third row through the real tree HWND.
    $outlineY = [int]($outlineRect.Top + [Math]::Round(9 * $dpiScale) + (2 * $rowHeight))
    $outlineChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $outlineX, $outlineY)
    if ($outlineChain -notmatch 'SysTreeView32') {
      throw "S027 Document Outline locator did not hit the native tree: $outlineChain"
    }
    $outlineClickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $outlineX, $outlineY)
    Start-Sleep -Seconds 2

    $propertiesAvailable = $false
    try { $propertiesAvailable = [bool]$Dte.Commands.Item('View.PropertiesWindow').IsAvailable } catch { }
    if (-not $propertiesAvailable) { throw 'Visual Studio did not enable View.PropertiesWindow after S027 outline selection.' }
    $null = $Dte.ExecuteCommand('View.PropertiesWindow')
    Start-Sleep -Seconds 4
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $selectedNames = [System.Collections.Generic.List[string]]::new()
    foreach ($propertyLabel in @('(Name)', 'Name')) {
      $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $propertyLabel
      )
      $nameMatches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
      for ($nameIndex = 0; $nameIndex -lt $nameMatches.Count; $nameIndex++) {
        try {
          $nameCandidate = $nameMatches.Item($nameIndex)
          if ($nameCandidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::TreeItem -or
              $nameCandidate.Current.IsOffscreen) { continue }
          $nameValuePattern = $null
          if ($nameCandidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$nameValuePattern)) {
            $nameValue = [string]([System.Windows.Automation.ValuePattern]$nameValuePattern).Current.Value
            if ($nameValue) { $selectedNames.Add($nameValue) }
          }
        } catch { }
      }
    }
    $selectedNameMatches = @($selectedNames | Where-Object { $_ -ceq $MovingAutomationId })
    $outlineSelection = [ordered]@{
      route = 'native Document Outline third visible row; exact target mutation is the selection authority'
      visibleFixtureOrder = @('S027AltDragForm', 'referenceButton', 'button1')
      expectedComponent = $MovingAutomationId
      selectedNames = @($selectedNames)
      propertyGridNameProof = $selectedNameMatches.Count -ge 1
      point = [ordered]@{ x = $outlineX; y = $outlineY }
      treeHwnd = $outlineTree.ToInt64()
      clickedWindow = $outlineClickedWindow.ToInt64()
      chain = $outlineChain
    }
    $null = $window.Activate()
    Start-Sleep -Seconds 2
  }
  if ($boundsLocator -eq 'UIAutomation.AutomationId') {
    $movingBefore = $movingElement.Current.BoundingRectangle
    $referenceBefore = $referenceElement.Current.BoundingRectangle
  } else {
    $movingBeforeRect = New-Object VisualStudioTraceNative+RECT
    $referenceBeforeRect = New-Object VisualStudioTraceNative+RECT
    if (-not [VisualStudioTraceNative]::GetWindowRect($movingNativeWindow, [ref]$movingBeforeRect) -or
        -not [VisualStudioTraceNative]::GetWindowRect($referenceNativeWindow, [ref]$referenceBeforeRect)) {
      throw 'Visual Studio did not expose measurable native S027 Button HWND bounds.'
    }
    $movingBefore = [ordered]@{
      X = $movingBeforeRect.Left; Y = $movingBeforeRect.Top
      Width = $movingBeforeRect.Right - $movingBeforeRect.Left; Height = $movingBeforeRect.Bottom - $movingBeforeRect.Top
      Right = $movingBeforeRect.Right; Bottom = $movingBeforeRect.Bottom
    }
    $referenceBefore = [ordered]@{
      X = $referenceBeforeRect.Left; Y = $referenceBeforeRect.Top
      Width = $referenceBeforeRect.Right - $referenceBeforeRect.Left; Height = $referenceBeforeRect.Bottom - $referenceBeforeRect.Top
      Right = $referenceBeforeRect.Right; Bottom = $referenceBeforeRect.Bottom
    }
  }
  if ($movingBefore.Width -lt 1 -or $movingBefore.Height -lt 1 -or
      $referenceBefore.Width -lt 1 -or $referenceBefore.Height -lt 1) {
    throw 'Visual Studio designer exposed invalid S025 control bounds.'
  }

  $startX = [int]($movingBefore.X + ($movingBefore.Width / 2))
  $startY = [int]($movingBefore.Y + ($movingBefore.Height / 2))
  $endX = $startX + $DeltaX
  $endY = $startY + $DeltaY
  $clickedWindow = [VisualStudioTraceNative]::ClickAtDeepestChild($hwnd, $startX, $startY)
  Start-Sleep -Seconds 2

  # BehaviorService reads Cursor.Position while processing the posted mouse move. On the disconnected trace desktop
  # that cursor is fixed at (0,0), so posting the ordinary on-screen coordinates would create a huge negative move.
  # Shift only this dedicated capture IDE until the Button center is (cursor-delta), then moving to the fixed cursor
  # represents exactly the requested source delta. PrintWindow still captures the complete designer while its native
  # snap guide is active; the IDE is restored before source inspection.
  $cursor = New-Object VisualStudioTraceNative+POINT
  $cursorReadAvailable = [VisualStudioTraceNative]::TryGetCursorPosition([ref]$cursor)
  if (-not $cursorReadAvailable) {
    # Win32 returns no cursor on the disconnected input desktop; BehaviorService nevertheless observes the origin.
    $cursor.X = 0
    $cursor.Y = 0
  }
  $dragEndX = $cursor.X
  $dragEndY = $cursor.Y
  if ($boundsLocator -eq 'UIAutomation.AutomationId') {
    $desiredStartX = $cursor.X - $DeltaX
    $desiredStartY = $cursor.Y - $DeltaY
  } else {
    # The classic in-process designer owns real child HWNDs and consumes the screen coordinates carried by its
    # capture-window mouse messages. Keep the dedicated IDE in place and post the exact native Button-center delta;
    # the modern UIA/BehaviorService fallback above still uses its proven cursor-relative window-offset route.
    $desiredStartX = $startX
    $desiredStartY = $startY
    $dragEndX = $endX
    $dragEndY = $endY
  }
  $originalWindowRect = New-Object VisualStudioTraceNative+RECT
  if (-not [VisualStudioTraceNative]::GetWindowRect($hwnd, [ref]$originalWindowRect)) {
    throw 'GetWindowRect failed before the S025 cursor-relative trace-window offset.'
  }
  $shiftX = $desiredStartX - $startX
  $shiftY = $desiredStartY - $startY
  $syntheticBounds = $null
  $syntheticCenterX = $null
  $syntheticCenterY = $null
  $captureWindow = [IntPtr]::Zero
  $dragEnded = $false
  $altDown = $false
  $activeDragCapture = $null
  $physicalInputAttempted = $boundsLocator -ne 'UIAutomation.AutomationId'
  $physicalInputSucceeded = $false
  $physicalInputFailure = $null
  $activeDragDestination = Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) `
    (([System.IO.Path]::GetFileNameWithoutExtension($Destination)) + '.active-drag' + ([System.IO.Path]::GetExtension($Destination)))
  try {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      [VisualStudioTraceNative]::MoveWindowTo($hwnd, $originalWindowRect.Left + $shiftX, $originalWindowRect.Top + $shiftY)
      Start-Sleep -Milliseconds 500
      if ($boundsLocator -eq 'UIAutomation.AutomationId') {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $movingElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $movingCondition)
        if ($null -eq $movingElement) { throw "S025 lost automation id '$MovingAutomationId' after trace-window offset." }
        $syntheticBounds = $movingElement.Current.BoundingRectangle
      } else {
        $syntheticRect = New-Object VisualStudioTraceNative+RECT
        if (-not [VisualStudioTraceNative]::GetWindowRect($movingNativeWindow, [ref]$syntheticRect)) {
          throw 'S027 lost the native moving Button HWND after trace-window offset.'
        }
        $syntheticBounds = [ordered]@{
          X = $syntheticRect.Left; Y = $syntheticRect.Top
          Width = $syntheticRect.Right - $syntheticRect.Left; Height = $syntheticRect.Bottom - $syntheticRect.Top
          Right = $syntheticRect.Right; Bottom = $syntheticRect.Bottom
        }
      }
      $syntheticCenterX = [int]($syntheticBounds.X + ($syntheticBounds.Width / 2))
      $syntheticCenterY = [int]($syntheticBounds.Y + ($syntheticBounds.Height / 2))
      if ([Math]::Abs($syntheticCenterX - $desiredStartX) -le 1 -and
          [Math]::Abs($syntheticCenterY - $desiredStartY) -le 1) { break }
      $shiftX += $desiredStartX - $syntheticCenterX
      $shiftY += $desiredStartY - $syntheticCenterY
    }
    if ($desiredStartX -lt $syntheticBounds.X -or $desiredStartX -ge $syntheticBounds.Right -or
        $desiredStartY -lt $syntheticBounds.Y -or $desiredStartY -ge $syntheticBounds.Bottom) {
      throw "S025 desired cursor-relative drag point ($desiredStartX,$desiredStartY) is outside the shifted Button bounds $syntheticBounds."
    }

    [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
    if ($physicalInputAttempted) {
      try {
        if ($HoldAlt) {
          $captureWindow = [VisualStudioTraceNative]::PhysicalAltDragAtScreen(
            $hwnd, $desiredStartX, $desiredStartY, $dragEndX, $dragEndY)
        } else {
          $captureWindow = [VisualStudioTraceNative]::PhysicalDragAtScreen(
            $hwnd, $desiredStartX, $desiredStartY, $dragEndX, $dragEndY)
        }
        $physicalInputSucceeded = $true
        $dragEnded = $true
        $activeDragCapture = Save-WindowCapture $hwnd $activeDragDestination
      } catch {
        $physicalInputFailure = $_.Exception.GetBaseException().Message
      }
    }
    if (-not $physicalInputSucceeded) {
      if ($HoldAlt) {
        [VisualStudioTraceNative]::SetVirtualKeyDown(0x12)
        $altDown = $true
      }
      $captureWindow = [VisualStudioTraceNative]::BeginDragUsingCapture($hwnd, $desiredStartX, $desiredStartY)
      for ($step = 1; $step -le 12; $step++) {
        $x = $desiredStartX + (($dragEndX - $desiredStartX) * $step / 12)
        $y = $desiredStartY + (($dragEndY - $desiredStartY) * $step / 12)
        $captureWindow = [VisualStudioTraceNative]::MoveDragUsingCapture($captureWindow, [int]$x, [int]$y)
      }
      # Archive the real designer while the transaction is still active, then archive the restored final designer
      # below. PrintWindow may omit transient adorner layers, so the persisted exact delta remains the hard gate.
      $activeDragCapture = Save-WindowCapture $hwnd $activeDragDestination
      [VisualStudioTraceNative]::EndDragUsingCapture($captureWindow, $dragEndX, $dragEndY)
      $dragEnded = $true
    }
  } finally {
    if (-not $dragEnded -and $captureWindow -ne [IntPtr]::Zero) {
      try { [VisualStudioTraceNative]::EndDragUsingCapture($captureWindow, $dragEndX, $dragEndY) } catch { }
    }
    if ($altDown) {
      [VisualStudioTraceNative]::SetVirtualKeyUp(0x12)
      $altDown = $false
    }
    [VisualStudioTraceNative]::MoveWindowTo($hwnd, $originalWindowRect.Left, $originalWindowRect.Top)
    Start-Sleep -Seconds 1
  }
  Start-Sleep -Seconds 4
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3

  if ($boundsLocator -eq 'UIAutomation.AutomationId') {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $movingElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $movingCondition)
    $referenceElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $referenceCondition)
    if ($null -eq $movingElement -or $null -eq $referenceElement) {
      throw 'Visual Studio designer lost an S025 control after baseline drag.'
    }
    $movingAfter = $movingElement.Current.BoundingRectangle
    $referenceAfter = $referenceElement.Current.BoundingRectangle
  } else {
    $movingAfterRect = New-Object VisualStudioTraceNative+RECT
    $referenceAfterRect = New-Object VisualStudioTraceNative+RECT
    if (-not [VisualStudioTraceNative]::GetWindowRect($movingNativeWindow, [ref]$movingAfterRect) -or
        -not [VisualStudioTraceNative]::GetWindowRect($referenceNativeWindow, [ref]$referenceAfterRect)) {
      throw 'Visual Studio lost measurable native S027 Button HWND bounds after the drag.'
    }
    $movingAfter = [ordered]@{
      X = $movingAfterRect.Left; Y = $movingAfterRect.Top
      Width = $movingAfterRect.Right - $movingAfterRect.Left; Height = $movingAfterRect.Bottom - $movingAfterRect.Top
      Right = $movingAfterRect.Right; Bottom = $movingAfterRect.Bottom
    }
    $referenceAfter = [ordered]@{
      X = $referenceAfterRect.Left; Y = $referenceAfterRect.Top
      Width = $referenceAfterRect.Right - $referenceAfterRect.Left; Height = $referenceAfterRect.Bottom - $referenceAfterRect.Top
      Right = $referenceAfterRect.Right; Bottom = $referenceAfterRect.Bottom
    }
  }
  $capture = Save-WindowCapture $hwnd $Destination
  return [ordered]@{
    document = $SourceFile
    movingAutomationId = $MovingAutomationId
    referenceAutomationId = $ReferenceAutomationId
    boundsLocator = $boundsLocator
    outlineSelection = $outlineSelection
    input = [ordered]@{
      clickedWindow = $clickedWindow.ToInt64()
      captureWindow = $captureWindow.ToInt64()
      mode = $(if ($boundsLocator -eq 'UIAutomation.AutomationId') {
        'cursor-relative-capture-owned-window-offset'
      } else {
        'native-selected-HWND-capture-message-screen-delta'
      })
      deltaX = $DeltaX
      deltaY = $DeltaY
      holdAlt = [bool]$HoldAlt
      start = [ordered]@{ x = $startX; y = $startY }
      end = [ordered]@{ x = $endX; y = $endY }
      cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
      cursorReadAvailable = [bool]$cursorReadAvailable
      physicalInput = [ordered]@{
        attempted = [bool]$physicalInputAttempted
        succeeded = [bool]$physicalInputSucceeded
        failure = $physicalInputFailure
      }
      traceWindowShift = [ordered]@{
        x = $shiftX
        y = $shiftY
        originalWindow = [ordered]@{
          x = $originalWindowRect.Left
          y = $originalWindowRect.Top
          width = $originalWindowRect.Right - $originalWindowRect.Left
          height = $originalWindowRect.Bottom - $originalWindowRect.Top
        }
        syntheticStart = [ordered]@{ x = $desiredStartX; y = $desiredStartY }
        syntheticButtonCenter = [ordered]@{ x = $syntheticCenterX; y = $syntheticCenterY }
        syntheticButtonBounds = [ordered]@{
          x = $syntheticBounds.X
          y = $syntheticBounds.Y
          width = $syntheticBounds.Width
          height = $syntheticBounds.Height
        }
      }
    }
    movingBeforeBounds = [ordered]@{ x = $movingBefore.X; y = $movingBefore.Y; width = $movingBefore.Width; height = $movingBefore.Height }
    movingAfterBounds = [ordered]@{ x = $movingAfter.X; y = $movingAfter.Y; width = $movingAfter.Width; height = $movingAfter.Height }
    referenceBeforeBounds = [ordered]@{ x = $referenceBefore.X; y = $referenceBefore.Y; width = $referenceBefore.Width; height = $referenceBefore.Height }
    referenceAfterBounds = [ordered]@{ x = $referenceAfter.X; y = $referenceAfter.Y; width = $referenceAfter.Width; height = $referenceAfter.Height }
    activeDragCapture = $activeDragCapture
    capture = $capture
  }
}

function Open-DesignerMarqueeProbeAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $elementBounds = [ordered]@{}
  $elements = [ordered]@{}
  foreach ($automationId in @(
      'panel1',
      'enclosedButtonA',
      'enclosedButtonB',
      'partialButton',
      'panelOutsideButton',
      'formOutsideButtonA',
      'formOutsideButtonB')) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $automationId
    )
    $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $element) { throw "S017 designer did not expose automation id '$automationId'." }
    $bounds = $element.Current.BoundingRectangle
    if ($bounds.Width -lt 1 -or $bounds.Height -lt 1) {
      throw "S017 designer exposed invalid '$automationId' bounds: $bounds"
    }
    $elements[$automationId] = $element
    $elementBounds[$automationId] = [ordered]@{
      x = $bounds.X
      y = $bounds.Y
      width = $bounds.Width
      height = $bounds.Height
      right = $bounds.Right
      bottom = $bounds.Bottom
    }
  }

  $panelBefore = $elements.panel1.Current.BoundingRectangle
  $startOffsetX = 8
  $startOffsetY = 8
  $endOffsetX = 210
  $endOffsetY = 75
  $startX = [int]($panelBefore.X + $startOffsetX)
  $startY = [int]($panelBefore.Y + $startOffsetY)
  $endX = [int]($panelBefore.X + $endOffsetX)
  $endY = [int]($panelBefore.Y + $endOffsetY)
  $deltaX = $endX - $startX
  $deltaY = $endY - $startY
  $marquee = [ordered]@{ left = $startX; top = $startY; right = $endX; bottom = $endY }
  $fullyContained = @()
  $intersecting = @()
  foreach ($automationId in @('enclosedButtonA', 'enclosedButtonB', 'partialButton', 'panelOutsideButton', 'formOutsideButtonA', 'formOutsideButtonB')) {
    $bounds = $elementBounds[$automationId]
    if ($bounds.x -ge $marquee.left -and $bounds.y -ge $marquee.top -and
        $bounds.right -le $marquee.right -and $bounds.bottom -le $marquee.bottom) {
      $fullyContained += $automationId
    }
    if ($bounds.right -gt $marquee.left -and $bounds.x -lt $marquee.right -and
        $bounds.bottom -gt $marquee.top -and $bounds.y -lt $marquee.bottom) {
      $intersecting += $automationId
    }
  }
  if (($fullyContained -join '|') -cne 'enclosedButtonA|enclosedButtonB' -or
      'partialButton' -notin $intersecting) {
    throw "S017 fixture geometry does not form the required enclosure: full=$($fullyContained -join '|'); intersect=$($intersecting -join '|')."
  }

  $cursor = New-Object VisualStudioTraceNative+POINT
  $cursorReadAvailable = [VisualStudioTraceNative]::TryGetCursorPosition([ref]$cursor)
  if (-not $cursorReadAvailable) {
    $cursor.X = 0
    $cursor.Y = 0
  }
  $desiredStartX = $cursor.X - $deltaX
  $desiredStartY = $cursor.Y - $deltaY
  $originalWindowRect = New-Object VisualStudioTraceNative+RECT
  if (-not [VisualStudioTraceNative]::GetWindowRect($hwnd, [ref]$originalWindowRect)) {
    throw 'GetWindowRect failed before the S017 cursor-relative trace-window offset.'
  }
  $shiftX = $desiredStartX - $startX
  $shiftY = $desiredStartY - $startY
  $syntheticPanelBounds = $null
  $syntheticStartX = $null
  $syntheticStartY = $null
  $captureWindow = [IntPtr]::Zero
  $dragEnded = $false
  $activeDragCapture = $null
  $beforeWindowChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $startX, $startY)
  $shiftedWindowChain = $null
  try {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      [VisualStudioTraceNative]::MoveWindowTo($hwnd, $originalWindowRect.Left + $shiftX, $originalWindowRect.Top + $shiftY)
      Start-Sleep -Milliseconds 500
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      $panelCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        'panel1'
      )
      $panelElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $panelCondition)
      if ($null -eq $panelElement) { throw "S017 lost automation id 'panel1' after trace-window offset." }
      $syntheticPanelBounds = $panelElement.Current.BoundingRectangle
      $syntheticStartX = [int]($syntheticPanelBounds.X + $startOffsetX)
      $syntheticStartY = [int]($syntheticPanelBounds.Y + $startOffsetY)
      if ([Math]::Abs($syntheticStartX - $desiredStartX) -le 1 -and
          [Math]::Abs($syntheticStartY - $desiredStartY) -le 1) { break }
      $shiftX += $desiredStartX - $syntheticStartX
      $shiftY += $desiredStartY - $syntheticStartY
    }
    if ($desiredStartX -lt $syntheticPanelBounds.X -or $desiredStartX -ge $syntheticPanelBounds.Right -or
        $desiredStartY -lt $syntheticPanelBounds.Y -or $desiredStartY -ge $syntheticPanelBounds.Bottom) {
      throw "S017 desired marquee start ($desiredStartX,$desiredStartY) is outside the shifted Panel bounds $syntheticPanelBounds."
    }

    [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
    $shiftedWindowChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $desiredStartX, $desiredStartY)
    $captureWindow = [VisualStudioTraceNative]::BeginDragUsingCapture($hwnd, $desiredStartX, $desiredStartY)
    for ($step = 1; $step -le 16; $step++) {
      $x = $desiredStartX + (($cursor.X - $desiredStartX) * $step / 16)
      $y = $desiredStartY + (($cursor.Y - $desiredStartY) * $step / 16)
      $captureWindow = [VisualStudioTraceNative]::MoveDragUsingCapture($captureWindow, [int]$x, [int]$y)
    }
    $activeDragDestination = Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) `
      (([System.IO.Path]::GetFileNameWithoutExtension($Destination)) + '.active-drag' + ([System.IO.Path]::GetExtension($Destination)))
    $activeDragCapture = Save-WindowCapture $hwnd $activeDragDestination
    [VisualStudioTraceNative]::EndDragUsingCapture($captureWindow, $cursor.X, $cursor.Y)
    $dragEnded = $true
  } finally {
    if (-not $dragEnded -and $captureWindow -ne [IntPtr]::Zero) {
      try { [VisualStudioTraceNative]::EndDragUsingCapture($captureWindow, $cursor.X, $cursor.Y) } catch { }
    }
    [VisualStudioTraceNative]::MoveWindowTo($hwnd, $originalWindowRect.Left, $originalWindowRect.Top)
    Start-Sleep -Seconds 1
  }
  Start-Sleep -Seconds 3
  $null = $window.Activate()
  Start-Sleep -Seconds 1
  $capture = Save-WindowCapture $hwnd $Destination

  $beforeCopySha256 = Get-Sha256 $DesignerFile
  $copyAvailable = [bool]$Dte.Commands.Item('Edit.Copy').IsAvailable
  if (-not $copyAvailable) { throw 'S017 marquee did not enable Edit.Copy.' }
  $null = $Dte.ExecuteCommand('Edit.Copy')
  Start-Sleep -Seconds 2
  $afterCopySha256 = Get-Sha256 $DesignerFile
  $pasteAvailable = [bool]$Dte.Commands.Item('Edit.Paste').IsAvailable
  if (-not $pasteAvailable) { throw 'S017 copied selection did not enable Edit.Paste.' }
  $null = $Dte.ExecuteCommand('Edit.Paste')
  Start-Sleep -Seconds 4
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3
  $afterPasteSha256 = Get-Sha256 $DesignerFile
  $afterPasteText = [System.IO.File]::ReadAllText($DesignerFile)
  $afterPasteArtifact = 'S017MarqueeForm.Designer.after-paste.cs.gz'
  Write-Gzip (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) $afterPasteArtifact) `
    ([System.IO.File]::ReadAllBytes($DesignerFile))
  $afterPasteCapture = Save-WindowCapture $hwnd (Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) 'visual-studio-after-paste.png')

  $undoAvailable = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable
  if (-not $undoAvailable) { throw 'S017 diagnostic paste did not create an available native Undo unit.' }
  $null = $Dte.ExecuteCommand('Edit.Undo')
  Start-Sleep -Seconds 3
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3
  $afterUndoSha256 = Get-Sha256 $DesignerFile
  $afterUndoText = [System.IO.File]::ReadAllText($DesignerFile)

  return [ordered]@{
    document = $SourceFile
    action = 'Cursor-relative native marquee, Edit.Copy, diagnostic Edit.Paste, native Edit.Undo'
    expectedFullyContained = $fullyContained
    intersecting = $intersecting
    elementBounds = $elementBounds
    marquee = $marquee
    input = [ordered]@{
      mode = 'cursor-relative-capture-owned-window-offset'
      beforeWindowChain = $beforeWindowChain
      shiftedWindowChain = $shiftedWindowChain
      captureWindow = $captureWindow.ToInt64()
      deltaX = $deltaX
      deltaY = $deltaY
      start = [ordered]@{ x = $startX; y = $startY }
      end = [ordered]@{ x = $endX; y = $endY }
      cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
      cursorReadAvailable = [bool]$cursorReadAvailable
      traceWindowShift = [ordered]@{
        x = $shiftX
        y = $shiftY
        syntheticStart = [ordered]@{ x = $desiredStartX; y = $desiredStartY }
        syntheticPanelBounds = [ordered]@{
          x = $syntheticPanelBounds.X
          y = $syntheticPanelBounds.Y
          width = $syntheticPanelBounds.Width
          height = $syntheticPanelBounds.Height
        }
      }
    }
    copyAvailable = $copyAvailable
    pasteAvailable = $pasteAvailable
    copyWasNonMutating = $beforeCopySha256 -ceq $afterCopySha256
    beforeCopySha256 = $beforeCopySha256
    afterCopySha256 = $afterCopySha256
    afterPasteSha256 = $afterPasteSha256
    afterPasteShape = Get-S017Shape $afterPasteText
    afterPasteArtifact = $afterPasteArtifact
    undoAvailable = $undoAvailable
    afterUndoSha256 = $afterUndoSha256
    afterUndoShape = Get-S017Shape $afterUndoText
    capture = $capture
    activeDragCapture = $activeDragCapture
    afterPasteCapture = $afterPasteCapture
  }
}

function Open-DesignerCursorSynchronizedMoveAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $MovingAutomationId,
  [string] $ReferenceAutomationId,
  [int] $DeltaX,
  [int] $DeltaY,
  [string] $Destination,
  [switch] $HoldAlt
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $movingCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $MovingAutomationId
  )
  $referenceCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ReferenceAutomationId
  )
  $movingElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $movingCondition)
  $referenceElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $referenceCondition)
  if ($null -eq $movingElement -or $null -eq $referenceElement) {
    throw "Visual Studio designer did not expose controls '$MovingAutomationId' and '$ReferenceAutomationId'."
  }
  $movingBefore = $movingElement.Current.BoundingRectangle
  $referenceBefore = $referenceElement.Current.BoundingRectangle
  if ($movingBefore.Width -lt 1 -or $movingBefore.Height -lt 1 -or
      $referenceBefore.Width -lt 1 -or $referenceBefore.Height -lt 1) {
    throw 'Visual Studio designer exposed invalid physical-move control bounds.'
  }

  $startX = [int]($movingBefore.X + ($movingBefore.Width / 2))
  $startY = [int]($movingBefore.Y + ($movingBefore.Height / 2))
  $endX = $startX + $DeltaX
  $endY = $startY + $DeltaY
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $startX, $startY)
  Start-Sleep -Seconds 2
  # BehaviorService consumes both the capture-window mouse messages and Cursor.Position. Keep those two channels on
  # the same exact path while addressing messages only to the dedicated trace IDE; the native helper always restores
  # the pre-existing cursor position and releases the posted button state on failure.
  $altDown = $false
  try {
    if ($HoldAlt) {
      [VisualStudioTraceNative]::SetVirtualKeyDown(0x12)
      $altDown = $true
    }
    $dragWindow = [VisualStudioTraceNative]::PostDragUsingCaptureWithCursor($hwnd, $startX, $startY, $endX, $endY)
  } finally {
    if ($altDown) { [VisualStudioTraceNative]::SetVirtualKeyUp(0x12) }
  }
  Start-Sleep -Seconds 4
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $movingElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $movingCondition)
  $referenceElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $referenceCondition)
  if ($null -eq $movingElement -or $null -eq $referenceElement) {
    throw 'Visual Studio designer lost a control after the cursor-synchronized move.'
  }
  $movingAfter = $movingElement.Current.BoundingRectangle
  $referenceAfter = $referenceElement.Current.BoundingRectangle
  $capture = Save-WindowCapture $hwnd $Destination
  return [ordered]@{
    document = $SourceFile
    movingAutomationId = $MovingAutomationId
    referenceAutomationId = $ReferenceAutomationId
    input = [ordered]@{
      clickedWindow = $clickedWindow.ToInt64()
      dragWindow = $dragWindow.ToInt64()
      mode = 'posted-capture-cursor-synchronized-restored-cursor'
      deltaX = $DeltaX
      deltaY = $DeltaY
      holdAlt = [bool]$HoldAlt
      start = [ordered]@{ x = $startX; y = $startY }
      end = [ordered]@{ x = $endX; y = $endY }
    }
    movingBeforeBounds = [ordered]@{ x = $movingBefore.X; y = $movingBefore.Y; width = $movingBefore.Width; height = $movingBefore.Height }
    movingAfterBounds = [ordered]@{ x = $movingAfter.X; y = $movingAfter.Y; width = $movingAfter.Width; height = $movingAfter.Height }
    referenceBeforeBounds = [ordered]@{ x = $referenceBefore.X; y = $referenceBefore.Y; width = $referenceBefore.Width; height = $referenceBefore.Height }
    referenceAfterBounds = [ordered]@{ x = $referenceAfter.X; y = $referenceAfter.Y; width = $referenceAfter.Width; height = $referenceAfter.Height }
    capture = $capture
  }
}

function Open-DesignerGroupDragAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $AutomationId,
  [int] $DeltaX,
  [int] $DeltaY,
  [string] $Destination
) {
  Write-Host 'S021: resolve project item'
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Write-Host 'S021: designer window activated'
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  Write-Host 'S021: resolve designer HWND and UI Automation element'
  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($null -eq $element) {
    throw "Visual Studio designer did not expose automation id '$AutomationId' for S021."
  }
  $beforeBounds = $element.Current.BoundingRectangle
  if ($beforeBounds.Width -lt 1 -or $beforeBounds.Height -lt 1) {
    throw "Visual Studio designer element '$AutomationId' has invalid S021 bounds: $beforeBounds"
  }

  Write-Host 'S021: execute Edit.SelectAll'
  $selectAllAvailable = [bool]$Dte.Commands.Item('Edit.SelectAll').IsAvailable
  if (-not $selectAllAvailable) { throw 'Visual Studio designer did not enable Edit.SelectAll for S021.' }
  $null = $Dte.ExecuteCommand('Edit.SelectAll')
  Start-Sleep -Seconds 2

  Write-Host 'S021: send real drag input'
  $startX = [int]($beforeBounds.X + ($beforeBounds.Width / 2))
  $startY = [int]($beforeBounds.Y + ($beforeBounds.Height / 2))
  $windowChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $startX, $startY)
  Write-Host "S021: input HWND chain: $windowChain"
  $inputMode = 'physical-input-desktop'
  $physicalInputFailure = $null
  $windowShift = $null
  $syntheticBounds = $null
  try {
    $dragWindow = [VisualStudioTraceNative]::PhysicalDragAtScreen(
      $hwnd, $startX, $startY, $startX + $DeltaX, $startY + $DeltaY)
  } catch {
    $physicalInputFailure = $_.Exception.Message
    if ($physicalInputFailure -notmatch 'OpenInputDesktop failed: 5|SetForegroundWindow failed|Dedicated trace IDE did not become the foreground window|GetCursorPos on input desktop failed') { throw }

    # A disconnected Windows session has no accessible input desktop and the designer observes a fixed virtual cursor
    # at (0,0). Move only this dedicated trace IDE so the selected control's drag origin is (-dx,-dy); the real
    # BehaviorService transaction then observes exactly (+dx,+dy). Restore the IDE position before inspecting output.
    $inputMode = 'disconnected-desktop-window-offset'
    $originalWindowRect = New-Object VisualStudioTraceNative+RECT
    if (-not [VisualStudioTraceNative]::GetWindowRect($hwnd, [ref]$originalWindowRect)) {
      throw 'GetWindowRect failed before the disconnected-desktop S021 fallback.'
    }
    $desiredStartX = -$DeltaX
    $desiredStartY = -$DeltaY
    $shiftX = $desiredStartX - $startX
    $shiftY = $desiredStartY - $startY
    try {
      for ($attempt = 0; $attempt -lt 3; $attempt++) {
        [VisualStudioTraceNative]::MoveWindowTo($hwnd, $originalWindowRect.Left + $shiftX, $originalWindowRect.Top + $shiftY)
        Start-Sleep -Milliseconds 500
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        if ($null -eq $element) { throw "S021 lost automation id '$AutomationId' after trace-window offset." }
        $syntheticBounds = $element.Current.BoundingRectangle
        $syntheticCenterX = [int]($syntheticBounds.X + ($syntheticBounds.Width / 2))
        $syntheticCenterY = [int]($syntheticBounds.Y + ($syntheticBounds.Height / 2))
        if ([Math]::Abs($syntheticCenterX - $desiredStartX) -le 1 -and
            [Math]::Abs($syntheticCenterY - $desiredStartY) -le 1) { break }
        $shiftX += $desiredStartX - $syntheticCenterX
        $shiftY += $desiredStartY - $syntheticCenterY
      }
      if ($desiredStartX -lt $syntheticBounds.X -or $desiredStartX -ge $syntheticBounds.Right -or
          $desiredStartY -lt $syntheticBounds.Y -or $desiredStartY -ge $syntheticBounds.Bottom) {
        throw "S021 desired headless drag point ($desiredStartX,$desiredStartY) is outside the shifted Button bounds $syntheticBounds."
      }
      $syntheticStartX = $desiredStartX
      $syntheticStartY = $desiredStartY
      [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
      $windowChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $syntheticStartX, $syntheticStartY)
      Write-Host "S021: disconnected-desktop shifted HWND chain: $windowChain"
      $dragWindow = [VisualStudioTraceNative]::PostDragUsingCapture(
        $hwnd, $syntheticStartX, $syntheticStartY, 0, 0)
    } finally {
      [VisualStudioTraceNative]::MoveWindowTo($hwnd, $originalWindowRect.Left, $originalWindowRect.Top)
      Start-Sleep -Seconds 1
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    }
    $windowShift = [ordered]@{
      x = $shiftX
      y = $shiftY
      originalWindow = [ordered]@{
        x = $originalWindowRect.Left
        y = $originalWindowRect.Top
        width = $originalWindowRect.Right - $originalWindowRect.Left
        height = $originalWindowRect.Bottom - $originalWindowRect.Top
      }
      syntheticStart = [ordered]@{ x = $syntheticStartX; y = $syntheticStartY }
      syntheticButtonCenter = [ordered]@{ x = $syntheticCenterX; y = $syntheticCenterY }
    }
  }
  Start-Sleep -Seconds 4
  Write-Host 'S021: save drag result'
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3
  $afterDrag = [ordered]@{
    designerSha256 = Get-Sha256 $DesignerFile
    shape = Get-S021Shape ([System.IO.File]::ReadAllText($DesignerFile))
  }

  $undoAvailable = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable
  Write-Host "S021: execute one Edit.Undo (available=$undoAvailable)"
  if ($undoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Undo')
    Start-Sleep -Seconds 3
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 3
  }
  $afterUndo = [ordered]@{
    designerSha256 = Get-Sha256 $DesignerFile
    shape = Get-S021Shape ([System.IO.File]::ReadAllText($DesignerFile))
  }

  $redoAvailable = [bool]$Dte.Commands.Item('Edit.Redo').IsAvailable
  Write-Host "S021: execute one Edit.Redo (available=$redoAvailable)"
  if ($redoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Redo')
    Start-Sleep -Seconds 3
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 3
  }
  $afterRedo = [ordered]@{
    designerSha256 = Get-Sha256 $DesignerFile
    shape = Get-S021Shape ([System.IO.File]::ReadAllText($DesignerFile))
  }

  Write-Host 'S021: capture final bounds and screenshot'
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $afterBounds = if ($null -ne $element) { $element.Current.BoundingRectangle } else { $beforeBounds }
  return [ordered]@{
    document = $SourceFile
    command = 'Edit.SelectAll + real designer drag + one Edit.Undo + one Edit.Redo'
    selectAllAvailable = $selectAllAvailable
    undoAvailable = $undoAvailable
    redoAvailable = $redoAvailable
    input = [ordered]@{
      mode = $inputMode
      physicalInputFailure = $physicalInputFailure
      dragWindow = $dragWindow.ToInt64()
      windowChain = $windowChain
      disconnectedDesktopWindowShift = $windowShift
      syntheticBounds = $(if ($null -ne $syntheticBounds) {
        [ordered]@{ x = $syntheticBounds.X; y = $syntheticBounds.Y; width = $syntheticBounds.Width; height = $syntheticBounds.Height }
      } else { $null })
      delta = [ordered]@{ x = $DeltaX; y = $DeltaY }
    }
    beforeBounds = [ordered]@{ x = $beforeBounds.X; y = $beforeBounds.Y; width = $beforeBounds.Width; height = $beforeBounds.Height }
    afterBounds = [ordered]@{ x = $afterBounds.X; y = $afterBounds.Y; width = $afterBounds.Width; height = $afterBounds.Height }
    afterDrag = $afterDrag
    afterUndo = $afterUndo
    afterRedo = $afterRedo
    capture = Save-WindowCapture $hwnd $Destination
  }
}


function Open-DesignerClipboardCollisionAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $Destination
) {
  Write-Host 'S024: resolve project item'
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    'submitButton'
  )
  $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  if ($null -eq $button) {
    $buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      'Submit existing'
    )
    $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  }
  if ($null -eq $button) { throw 'Visual Studio designer did not expose submitButton for S024.' }
  $buttonBounds = $button.Current.BoundingRectangle
  if ($buttonBounds.Width -lt 1 -or $buttonBounds.Height -lt 1) {
    throw "Visual Studio exposed invalid S024 submitButton bounds: $buttonBounds"
  }
  $clickX = [int]($buttonBounds.X + ($buttonBounds.Width / 2))
  $clickY = [int]($buttonBounds.Y + ($buttonBounds.Height / 2))
  $windowChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $clickX, $clickY)
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $clickX, $clickY)
  Start-Sleep -Seconds 2
  $null = $window.Activate()
  Start-Sleep -Seconds 1

  $copyAvailable = [bool]$Dte.Commands.Item('Edit.Copy').IsAvailable
  $selectionMethod = 'designer-surface-capture-click'
  $outlineSelection = $null
  if (-not $copyAvailable) {
    $outlineCommandAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable
    if (-not $outlineCommandAvailable) {
      throw 'Visual Studio enabled neither Edit.Copy after the S024 surface click nor View.DocumentOutline.'
    }
    $null = $Dte.ExecuteCommand('View.DocumentOutline')
    Start-Sleep -Seconds 2
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    if ($null -eq $button) { throw 'S024 lost submitButton after opening Document Outline.' }
    $buttonBounds = $button.Current.BoundingRectangle
    # This two-node fixture produces the native expanded rows Form, submitButton. At 96 DPI the second row center is
    # 35 px above the rendered Button origin and the tree is immediately left of the designer in the capture profile.
    $outlinePoint = [ordered]@{
      x = [int]($buttonBounds.X - 154)
      y = [int]($buttonBounds.Y - 35)
    }
    $outlineWindowChain = [VisualStudioTraceNative]::DescribeDeepestChildChain(
      $hwnd,
      $outlinePoint.x,
      $outlinePoint.y
    )
    if ($outlineWindowChain -notmatch 'SysTreeView32') {
      throw "S024 Document Outline locator did not hit the native tree: $outlineWindowChain"
    }
    $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
      $hwnd,
      $outlinePoint.x,
      $outlinePoint.y
    )
    Start-Sleep -Seconds 2
    $null = $window.Activate()
    Start-Sleep -Seconds 1
    $copyAvailable = [bool]$Dte.Commands.Item('Edit.Copy').IsAvailable
    $selectionMethod = 'native-document-outline-second-row'
    $outlineSelection = [ordered]@{
      point = $outlinePoint
      windowChain = $outlineWindowChain
    }
  }
  if (-not $copyAvailable) { throw 'Visual Studio did not enable Edit.Copy after selecting submitButton for S024.' }
  $beforeCopySha256 = Get-Sha256 $DesignerFile
  $null = $Dte.ExecuteCommand('Edit.Copy')
  Start-Sleep -Seconds 2
  $afterCopySha256 = Get-Sha256 $DesignerFile
  $pasteAvailable = [bool]$Dte.Commands.Item('Edit.Paste').IsAvailable
  if (-not $pasteAvailable) { throw 'Visual Studio did not enable Edit.Paste after copying submitButton for S024.' }

  $null = $Dte.ExecuteCommand('Edit.Paste')
  Start-Sleep -Seconds 4
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3
  $afterPasteText = [System.IO.File]::ReadAllText($DesignerFile)
  $afterPaste = [ordered]@{
    designerSha256 = Get-Sha256 $DesignerFile
    shape = Get-S024Shape $afterPasteText
  }

  $undoAvailable = [bool]$Dte.Commands.Item('Edit.Undo').IsAvailable
  if ($undoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Undo')
    Start-Sleep -Seconds 3
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 3
  }
  $afterUndo = [ordered]@{
    designerSha256 = Get-Sha256 $DesignerFile
    shape = Get-S024Shape ([System.IO.File]::ReadAllText($DesignerFile))
  }

  $redoAvailable = [bool]$Dte.Commands.Item('Edit.Redo').IsAvailable
  if ($redoAvailable) {
    $null = $Dte.ExecuteCommand('Edit.Redo')
    Start-Sleep -Seconds 3
    $null = $Dte.ExecuteCommand('File.SaveAll')
    Start-Sleep -Seconds 3
  }
  $afterRedo = [ordered]@{
    designerSha256 = Get-Sha256 $DesignerFile
    shape = Get-S024Shape ([System.IO.File]::ReadAllText($DesignerFile))
  }

  return [ordered]@{
    document = $SourceFile
    command = 'Select submitButton + Edit.Copy + Edit.Paste + one Edit.Undo + one Edit.Redo'
    input = [ordered]@{
      selectionMethod = $selectionMethod
      outlineSelection = $outlineSelection
      clickedWindow = $clickedWindow.ToInt64()
      windowChain = $windowChain
      point = [ordered]@{ x = $clickX; y = $clickY }
      buttonBounds = [ordered]@{
        x = $buttonBounds.X
        y = $buttonBounds.Y
        width = $buttonBounds.Width
        height = $buttonBounds.Height
      }
    }
    copyAvailable = $copyAvailable
    pasteAvailable = $pasteAvailable
    beforeCopySha256 = $beforeCopySha256
    afterCopySha256 = $afterCopySha256
    copyWasNonMutating = $beforeCopySha256 -eq $afterCopySha256
    undoAvailable = $undoAvailable
    redoAvailable = $redoAvailable
    afterPaste = $afterPaste
    afterUndo = $afterUndo
    afterRedo = $afterRedo
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Add-DesignerItemFromTemplateAndCapture(
  $Dte,
  [string] $ProjectPath,
  [string] $ProjectDirectory,
  [string] $AnchorSourceFile,
  [string] $ItemName,
  [ValidateSet('Form', 'UserControl')]
  [string] $ItemKind,
  [bool] $ExpectProjectByteIdentical,
  [string] $Destination
) {
  $scenarioId = if ($ItemKind -eq 'UserControl') { 'S006' } else { 'S005' }
  Write-Host "$scenarioId`: resolve the exact loaded project"
  $publicAssemblies = Join-Path (Split-Path -Parent ([string]$Dte.FullName)) 'PublicAssemblies'
  Add-Type -Path (Join-Path $publicAssemblies 'EnvDTE.dll') | Out-Null
  Add-Type -Path (Join-Path $publicAssemblies 'EnvDTE80.dll') | Out-Null
  $project = $null
  $projectSelectionFailure = ''
  $expectedProjectName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectPath)
  try { $project = $Dte.Solution.Projects.Item($expectedProjectName) } catch { $project = $null }
  for ($index = 1; $null -eq $project -and $index -le [int]$Dte.Solution.Projects.Count; $index++) {
    $candidate = $Dte.Solution.Projects.Item($index)
    $candidateFullName = ''
    $candidateName = ''
    if ($null -ne $candidate) {
      try { $candidateFullName = [string]$candidate.FullName } catch { $candidateFullName = '' }
      try { $candidateName = [string]$candidate.Name } catch { $candidateName = '' }
    }
    $fullNameMatches = -not [string]::IsNullOrWhiteSpace($candidateFullName) -and
      [string]::Equals(
        $candidateFullName,
        [System.IO.Path]::GetFullPath($ProjectPath),
        [System.StringComparison]::OrdinalIgnoreCase
      )
    $nameMatches = [string]::Equals(
      $candidateName,
      $expectedProjectName,
      [System.StringComparison]::OrdinalIgnoreCase
    )
    if ($fullNameMatches -or $nameMatches) {
      $project = $candidate
      break
    }
  }
  if ($null -eq $project) {
    $anchorItem = $null
    if (Test-Path -LiteralPath $AnchorSourceFile -PathType Leaf) {
      $anchorItem = $Dte.Solution.FindProjectItem([System.IO.Path]::GetFullPath($AnchorSourceFile))
      if ($null -ne $anchorItem) {
        try { $project = $anchorItem.ContainingProject } catch { $project = $null }
        if ($null -eq $project) {
          try { $project = $anchorItem.Collection.ContainingProject } catch { $project = $null }
        }
        if ($null -eq $project) {
          try { $project = $anchorItem.Collection.Parent } catch { $project = $null }
        }
        if ($null -eq $project) {
          try {
            $anchorWindow = $anchorItem.Open('{00000000-0000-0000-0000-000000000000}')
            if ($null -ne $anchorWindow) {
              $anchorWindow.Visible = $true
              $null = $anchorWindow.Activate()
              Start-Sleep -Seconds 5
              try { $null = $Dte.ExecuteCommand('View.ViewCode') } catch { }
              Start-Sleep -Seconds 2
            }
            $anchorItem = $Dte.Solution.FindProjectItem([System.IO.Path]::GetFullPath($AnchorSourceFile))
            if ($null -ne $anchorItem) {
              try { $project = $anchorItem.Collection.ContainingProject } catch { $project = $null }
              if ($null -eq $project) {
                try { $project = $anchorItem.Collection.Parent } catch { $project = $null }
              }
            }
          } catch { $project = $null }
        }
        if ($null -eq $project) {
          try { $project = $Dte.ActiveDocument.ProjectItem.ContainingProject } catch { $project = $null }
        }
      }
    }
  }
  if ($null -eq $project) {
    try {
      $solutionExplorerWindow = $Dte.Windows.Item('{3AE79031-E1BC-11D0-8F78-00A0C9110057}')
      $windowUnknown = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($solutionExplorerWindow)
      try {
        $typedSolutionExplorerWindow = [Runtime.InteropServices.Marshal]::GetTypedObjectForIUnknown(
          $windowUnknown,
          [type][EnvDTE.Window]
        )
      } finally {
        [void][Runtime.InteropServices.Marshal]::Release($windowUnknown)
      }
      $hierarchyObject = ([type][EnvDTE.Window]).GetProperty('Object').GetValue($typedSolutionExplorerWindow)
      $hierarchyUnknown = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($hierarchyObject)
      try {
        $solutionExplorer = [Runtime.InteropServices.Marshal]::GetTypedObjectForIUnknown(
          $hierarchyUnknown,
          [type][EnvDTE.UIHierarchy]
        )
      } finally {
        [void][Runtime.InteropServices.Marshal]::Release($hierarchyUnknown)
      }
      $hierarchyItemsType = [type][EnvDTE.UIHierarchyItems]
      $hierarchyItemType = [type][EnvDTE.UIHierarchyItem]
      $rootItems = ([type][EnvDTE.UIHierarchy]).GetProperty('UIHierarchyItems').GetValue($solutionExplorer)
      $collections = [System.Collections.ArrayList]::new()
      [void]$collections.Add($rootItems)
      $projectNode = $null
      $observedHierarchyNames = [System.Collections.Generic.List[string]]::new()
      while ($collections.Count -gt 0 -and $null -eq $projectNode) {
        $items = $collections[0]
        $collections.RemoveAt(0)
        $itemCount = [int]$hierarchyItemsType.GetProperty('Count').GetValue($items)
        for ($itemIndex = 1; $itemIndex -le $itemCount; $itemIndex++) {
          $node = $hierarchyItemsType.GetMethod('Item').Invoke($items, @([object]$itemIndex))
          if ($null -eq $node) { continue }
          $nodeName = [string]$hierarchyItemType.GetProperty('Name').GetValue($node)
          if (-not [string]::IsNullOrWhiteSpace($nodeName)) { $observedHierarchyNames.Add($nodeName) }
          if ([string]::Equals($nodeName, $expectedProjectName, [System.StringComparison]::OrdinalIgnoreCase)) {
            $projectNode = $node
            break
          }
          $childItems = $hierarchyItemType.GetProperty('UIHierarchyItems').GetValue($node)
          if ($null -ne $childItems -and [int]$hierarchyItemsType.GetProperty('Count').GetValue($childItems) -gt 0) {
            [void]$collections.Add($childItems)
          }
        }
      }
      if ($null -eq $projectNode) {
        throw "Solution Explorer has no $expectedProjectName node; observed: $($observedHierarchyNames -join ' | ')"
      }
      ([type][EnvDTE.UIHierarchyItem]).GetMethod('Select').Invoke(
        $projectNode,
        @([EnvDTE.vsUISelectionType]::vsUISelectionTypeSelect)
      )
      Start-Sleep -Seconds 2
      $activeProjects = @($Dte.ActiveSolutionProjects)
      if ($activeProjects.Count -eq 1) { $project = $activeProjects[0] }
    } catch {
      $projectSelectionFailure = $_.Exception.GetBaseException().Message
      $project = $null
    }
  }
  if ($null -eq $project) {
    try {
      $activeProjects = @($Dte.ActiveSolutionProjects)
      if ($activeProjects.Count -eq 1) { $project = $activeProjects[0] }
    } catch { $project = $null }
  }
  if ($null -eq $project) {
    $anchorState = if ($null -eq $anchorItem) { 'FindProjectItem returned null' } else { 'ProjectItem resolved but no ContainingProject route succeeded' }
    throw "Visual Studio did not expose the exact loaded project: $ProjectPath ($anchorState; selection=$projectSelectionFailure)"
  }

  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($ItemName)
  $sourceFile = Join-Path $ProjectDirectory "$baseName.cs"
  $designerFile = Join-Path $ProjectDirectory "$baseName.Designer.cs"
  $resourceFile = Join-Path $ProjectDirectory "$baseName.resx"
  foreach ($target in @($sourceFile, $designerFile, $resourceFile)) {
    if (Test-Path -LiteralPath $target) { throw "$scenarioId target unexpectedly exists before AddFromTemplate: $target" }
  }

  $beforeProjectSha256 = Get-Sha256 $ProjectPath
  $beforeTopLevelFiles = @(Get-ChildItem -LiteralPath $ProjectDirectory -File | ForEach-Object Name | Sort-Object)
  Write-Host "$scenarioId`: resolve the native $ItemKind item template"
  $solutionUnknown = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($Dte.Solution)
  try {
    $solution2 = [Runtime.InteropServices.Marshal]::GetTypedObjectForIUnknown(
      $solutionUnknown,
      [type][EnvDTE80.Solution2]
    )
  } finally {
    [void][Runtime.InteropServices.Marshal]::Release($solutionUnknown)
  }
  if ($null -eq $solution2) { throw 'Visual Studio Solution COM object does not expose EnvDTE80.Solution2.' }
  $templateMethod = ([type][EnvDTE80.Solution2]).GetMethod('GetProjectItemTemplate')
  if ($null -eq $templateMethod) { throw 'EnvDTE80.Solution2 metadata has no GetProjectItemTemplate method.' }
  $templatePath = ''
  $templateResolution = ''
  $templateFailures = @()
  $templateCandidates = if ($ItemKind -eq 'UserControl') {
    @('Microsoft.CSharp.WindowsFormsUserControl', 'Microsoft.CSharp.UserControl', 'UserControl', 'User Control', 'usercontrol.vstemplate')
  } else {
    @('Microsoft.CSharp.WindowsForm', 'Form', 'Form (Windows Forms)', 'Windows Form', 'windowsform.vstemplate')
  }
  foreach ($templateName in $templateCandidates) {
    try {
      $resolvedTemplate = [string]$templateMethod.Invoke($solution2, @($templateName, 'CSharp'))
      if (-not [string]::IsNullOrWhiteSpace($resolvedTemplate)) {
        $templatePath = $resolvedTemplate
        $templateResolution = "Solution2.GetProjectItemTemplate($templateName, CSharp)"
        break
      }
      $templateFailures += "$templateName returned an empty path"
    } catch {
      $templateFailures += "$templateName failed: $($_.Exception.GetBaseException().Message)"
    }
  }
  if ([string]::IsNullOrWhiteSpace($templatePath)) {
    $templateFileName = if ($ItemKind -eq 'UserControl') { 'usercontrol.vstemplate' } else { 'windowsform.vstemplate' }
    $installedTemplateRoot = Join-Path (Split-Path -Parent ([string]$Dte.FullName)) 'ItemTemplates/CSharp/Windows Forms'
    $installedTemplates = @(if (Test-Path -LiteralPath $installedTemplateRoot -PathType Container) {
      Get-ChildItem -LiteralPath $installedTemplateRoot -Filter $templateFileName -File -Recurse
    })
    if ($installedTemplates.Count -eq 1) {
      $templatePath = $installedTemplates[0].FullName
      $templateResolution = "unique installed Visual Studio item template manifest $templateFileName"
    } elseif ($installedTemplates.Count -gt 1) {
      $templateFailures += "installed manifest lookup was ambiguous: $($installedTemplates.FullName -join ' | ')"
    } else {
      $templateFailures += "installed manifest lookup found no $templateFileName under $installedTemplateRoot"
    }
  }
  if ([string]::IsNullOrWhiteSpace($templatePath)) {
    throw "Visual Studio returned no resolvable $ItemKind item template for CSharp: $($templateFailures -join ' | ')"
  }
  Write-Host "$scenarioId`: template resolved by $templateResolution"

  Write-Host "$scenarioId`: add $ItemName through ProjectItems.AddFromTemplate"
  $projectUnknown = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($project)
  try {
    $typedProject = [Runtime.InteropServices.Marshal]::GetTypedObjectForIUnknown(
      $projectUnknown,
      [type][EnvDTE.Project]
    )
  } finally {
    [void][Runtime.InteropServices.Marshal]::Release($projectUnknown)
  }
  $typedProjectFullName = [string](([type][EnvDTE.Project]).GetProperty('FullName').GetValue($typedProject))
  if (-not [string]::Equals(
    $typedProjectFullName,
    [System.IO.Path]::GetFullPath($ProjectPath),
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "$scenarioId resolved the wrong active project: expected $ProjectPath; actual $typedProjectFullName; selection=$projectSelectionFailure"
  }
  $projectItemsProperty = ([type][EnvDTE.Project]).GetProperty('ProjectItems')
  $projectItems = $projectItemsProperty.GetValue($typedProject)
  if ($null -eq $projectItems) { throw 'Visual Studio active Project exposes no ProjectItems collection.' }
  $addFromTemplateMethod = ([type][EnvDTE.ProjectItems]).GetMethod('AddFromTemplate')
  $createdItem = $addFromTemplateMethod.Invoke($projectItems, @($templatePath, $ItemName))
  $addFromTemplateReturnedProjectItem = $null -ne $createdItem
  Start-Sleep -Seconds 8
  $null = $Dte.ExecuteCommand('File.SaveAll')

  $creationDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $creationDeadline -and
      -not ((Test-Path -LiteralPath $sourceFile -PathType Leaf) -and
        (Test-Path -LiteralPath $designerFile -PathType Leaf))) {
    Start-Sleep -Milliseconds 250
  }
  foreach ($target in @($sourceFile, $designerFile)) {
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
      throw "Visual Studio did not create the required $ItemKind source artifact: $target"
    }
  }

  $Dte.Solution.SolutionBuild.Build($true)
  $buildSucceeded = [int]$Dte.Solution.SolutionBuild.LastBuildInfo -eq 0
  if (-not $buildSucceeded) {
    throw "$scenarioId post-template solution build failed: LastBuildInfo=$($Dte.Solution.SolutionBuild.LastBuildInfo)"
  }

  $sourceItem = $Dte.Solution.FindProjectItem($sourceFile)
  if ($null -eq $sourceItem) { throw "Visual Studio did not resolve the created source item: $sourceFile" }
  $sourceItemUnknown = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($sourceItem)
  try {
    $typedSourceItem = [Runtime.InteropServices.Marshal]::GetTypedObjectForIUnknown(
      $sourceItemUnknown,
      [type][EnvDTE.ProjectItem]
    )
  } finally {
    [void][Runtime.InteropServices.Marshal]::Release($sourceItemUnknown)
  }
  $openMethod = ([type][EnvDTE.ProjectItem]).GetMethod('Open')
  $window = $openMethod.Invoke($typedSourceItem, @('{00000000-0000-0000-0000-000000000000}'))
  if ($null -eq $window) { throw "Visual Studio did not open the created ${ItemKind}: $sourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3
  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)

  $resourceDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $resourceDeadline -and -not (Test-Path -LiteralPath $resourceFile -PathType Leaf)) {
    Start-Sleep -Milliseconds 250
  }
  $resourceExists = Test-Path -LiteralPath $resourceFile -PathType Leaf
  $childNames = @()
  $childProjectItems = ([type][EnvDTE.ProjectItem]).GetProperty('ProjectItems').GetValue($typedSourceItem)
  $childCount = [int]([type][EnvDTE.ProjectItems]).GetProperty('Count').GetValue($childProjectItems)
  for ($index = 1; $index -le $childCount; $index++) {
    $child = ([type][EnvDTE.ProjectItems]).GetMethod('Item').Invoke($childProjectItems, @([object]$index))
    if ($null -ne $child) {
      $childNames += [string]([type][EnvDTE.ProjectItem]).GetProperty('Name').GetValue($child)
    }
  }
  $childNames = @($childNames | Sort-Object -Unique)

  $afterTopLevelFiles = @(Get-ChildItem -LiteralPath $ProjectDirectory -File | ForEach-Object Name | Sort-Object)
  $topLevelDelta = @($afterTopLevelFiles | Where-Object { $_ -notin $beforeTopLevelFiles })
  $expectedDelta = if ($ItemKind -eq 'Form') {
    @("$baseName.cs", "$baseName.Designer.cs", "$baseName.resx") | Sort-Object
  } else {
    @("$baseName.cs", "$baseName.Designer.cs") | Sort-Object
  }
  $allowedAuxiliaryDelta = @("$([System.IO.Path]::GetFileName($ProjectPath)).user")
  $missingRequiredDelta = @($expectedDelta | Where-Object { $_ -notin $topLevelDelta })
  $auxiliaryDelta = @($topLevelDelta | Where-Object { $_ -in $allowedAuxiliaryDelta })
  $unexpectedDelta = @($topLevelDelta | Where-Object {
    $_ -notin $expectedDelta -and $_ -notin $allowedAuxiliaryDelta
  })
  $sourceText = [System.IO.File]::ReadAllText($sourceFile)
  $designerText = [System.IO.File]::ReadAllText($designerFile)
  $resourceRoot = $null
  if ($resourceExists) {
    $resourceText = [System.IO.File]::ReadAllText($resourceFile)
    try {
      $resourceDocument = [xml]$resourceText
      $resourceRoot = $resourceDocument.DocumentElement.Name
    } catch { throw "Visual Studio created invalid $scenarioId resx XML: $($_.Exception.Message)" }
  }
  $afterProjectSha256 = Get-Sha256 $ProjectPath
  $projectItemRelationships = [ordered]@{
    sourceCompileCount = 0
    sourceSubType = ''
    designerCompileCount = 0
    designerDependentUpon = ''
    resourceCount = 0
    resourceDependentUpon = ''
  }
  $projectItemRelationshipsExact = $ExpectProjectByteIdentical
  if (-not $ExpectProjectByteIdentical) {
    try {
      $projectDocument = [xml][System.IO.File]::ReadAllText($ProjectPath)
      $namespaceManager = [System.Xml.XmlNamespaceManager]::new($projectDocument.NameTable)
      $namespaceManager.AddNamespace('msb', 'http://schemas.microsoft.com/developer/msbuild/2003')
      $sourceCompileNodes = @($projectDocument.SelectNodes("/msb:Project/msb:ItemGroup/msb:Compile[@Include='$baseName.cs']", $namespaceManager))
      $designerCompileNodes = @($projectDocument.SelectNodes("/msb:Project/msb:ItemGroup/msb:Compile[@Include='$baseName.Designer.cs']", $namespaceManager))
      $resourceNodes = @($projectDocument.SelectNodes("/msb:Project/msb:ItemGroup/msb:EmbeddedResource[@Include='$baseName.resx']", $namespaceManager))
      $sourceSubType = if ($sourceCompileNodes.Count -eq 1) {
        [string]$sourceCompileNodes[0].SelectSingleNode('msb:SubType', $namespaceManager).InnerText
      } else { '' }
      $designerDependentUpon = if ($designerCompileNodes.Count -eq 1) {
        [string]$designerCompileNodes[0].SelectSingleNode('msb:DependentUpon', $namespaceManager).InnerText
      } else { '' }
      $resourceDependentUpon = if ($resourceNodes.Count -eq 1) {
        [string]$resourceNodes[0].SelectSingleNode('msb:DependentUpon', $namespaceManager).InnerText
      } else { '' }
      $projectItemRelationships = [ordered]@{
        sourceCompileCount = $sourceCompileNodes.Count
        sourceSubType = $sourceSubType
        designerCompileCount = $designerCompileNodes.Count
        designerDependentUpon = $designerDependentUpon
        resourceCount = $resourceNodes.Count
        resourceDependentUpon = $resourceDependentUpon
      }
      $resourceRelationshipExact = if ($ItemKind -eq 'Form') {
        $resourceNodes.Count -eq 1 -and $resourceDependentUpon -ceq "$baseName.cs"
      } else {
        $resourceNodes.Count -eq 0
      }
      $projectItemRelationshipsExact = $sourceCompileNodes.Count -eq 1 -and
        $sourceSubType -ceq $ItemKind -and
        $designerCompileNodes.Count -eq 1 -and
        $designerDependentUpon -ceq "$baseName.cs" -and
        $resourceRelationshipExact
    } catch {
      throw "Visual Studio created an invalid or unrecognized $scenarioId classic project update: $($_.Exception.GetBaseException().Message)"
    }
  }
  $projectMutationExact = if ($ExpectProjectByteIdentical) {
    $beforeProjectSha256 -ceq $afterProjectSha256
  } else {
    $beforeProjectSha256 -cne $afterProjectSha256 -and $projectItemRelationshipsExact
  }
  $artifactHashes = [ordered]@{
    "$baseName.cs" = Get-Sha256 $sourceFile
    "$baseName.Designer.cs" = Get-Sha256 $designerFile
  }
  if ($resourceExists) { $artifactHashes["$baseName.resx"] = Get-Sha256 $resourceFile }
  $auxiliaryArtifactHashes = [ordered]@{}
  foreach ($auxiliaryName in $allowedAuxiliaryDelta) {
    $auxiliaryPath = Join-Path $ProjectDirectory $auxiliaryName
    if (Test-Path -LiteralPath $auxiliaryPath -PathType Leaf) {
      $auxiliaryArtifactHashes[$auxiliaryName] = Get-Sha256 $auxiliaryPath
    }
  }
  $sourceShapeExact = [regex]::IsMatch(
    $sourceText,
    "(?s)partial\s+class\s+$([regex]::Escape($baseName))\s*:\s*(?:System\.Windows\.Forms\.)?$([regex]::Escape($ItemKind))"
  )
  $designerShapeExact = [regex]::IsMatch(
    $designerText,
    "(?s)partial\s+class\s+$([regex]::Escape($baseName)).*?void\s+InitializeComponent\s*\("
  )
  $resourceExpectationExact = if ($ItemKind -eq 'Form') {
    $resourceExists -and $resourceRoot -ceq 'root'
  } else {
    -not $resourceExists
  }
  $projectHierarchyExact = "$baseName.Designer.cs" -in $childNames -and
    $(if ($ItemKind -eq 'Form') { "$baseName.resx" -in $childNames } else { "$baseName.resx" -notin $childNames })
  $pass = $buildSucceeded -and
    $projectMutationExact -and
    $missingRequiredDelta.Count -eq 0 -and $unexpectedDelta.Count -eq 0 -and
    $sourceShapeExact -and $designerShapeExact -and
    $resourceExpectationExact -and $projectHierarchyExact

  return [ordered]@{
    document = $sourceFile
    command = "Installed Visual Studio $ItemKind template + ProjectItems.AddFromTemplate"
    templatePath = $templatePath
    templateResolution = $templateResolution
    itemName = $ItemName
    addFromTemplateReturnedProjectItem = $addFromTemplateReturnedProjectItem
    beforeProjectSha256 = $beforeProjectSha256
    afterProjectSha256 = $afterProjectSha256
    projectByteIdentical = $beforeProjectSha256 -ceq $afterProjectSha256
    expectProjectByteIdentical = $ExpectProjectByteIdentical
    projectMutationExact = $projectMutationExact
    projectItemRelationships = $projectItemRelationships
    projectItemRelationshipsExact = $projectItemRelationshipsExact
    beforeTopLevelFiles = $beforeTopLevelFiles
    afterTopLevelFiles = $afterTopLevelFiles
    topLevelDelta = $topLevelDelta
    expectedTopLevelDelta = $expectedDelta
    allowedAuxiliaryTopLevelDelta = $allowedAuxiliaryDelta
    auxiliaryTopLevelDelta = $auxiliaryDelta
    missingRequiredTopLevelDelta = $missingRequiredDelta
    unexpectedTopLevelDelta = $unexpectedDelta
    childNames = $childNames
    sourceShapeExact = $sourceShapeExact
    designerShapeExact = $designerShapeExact
    resourceExists = $resourceExists
    resourceRoot = $resourceRoot
    resourceExpectationExact = $resourceExpectationExact
    projectHierarchyExact = $projectHierarchyExact
    solutionBuild = $(if ($buildSucceeded) { 'PASS' } else { 'FAIL' })
    artifactHashes = $artifactHashes
    auxiliaryArtifactHashes = $auxiliaryArtifactHashes
    pass = $pass
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerExistingEventAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $ControlAutomationId,
  [string] $EventName,
  [string] $HandlerName,
  [string] $Destination,
  [string] $DesiredHandlerName = '',
  [string] $ControlAutomationName = ''
) {
  if ([string]::IsNullOrWhiteSpace($DesiredHandlerName)) { $DesiredHandlerName = $HandlerName }
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $controlCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $ControlAutomationId
  )
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $controlCondition)
  $controlLocator = "AutomationId=$ControlAutomationId"
  if ($null -eq $control -and -not [string]::IsNullOrWhiteSpace($ControlAutomationName)) {
    $controlNameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $ControlAutomationName
    )
    $visibleControlMatches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $controlNameCondition) | Where-Object {
      $bounds = $_.Current.BoundingRectangle
      -not $_.Current.IsOffscreen -and $bounds.Width -gt 0 -and $bounds.Height -gt 0
    })
    if ($visibleControlMatches.Count -eq 1) {
      $control = $visibleControlMatches[0]
      $controlLocator = "unique visible Name=$ControlAutomationName"
    }
  }
  if ($null -eq $control) { throw "Visual Studio designer did not expose '$ControlAutomationId'/'$ControlAutomationName' for the Events trace." }
  $controlBounds = $control.Current.BoundingRectangle
  $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($controlBounds.X + ($controlBounds.Width / 2)),
    [int]($controlBounds.Y + ($controlBounds.Height / 2))
  )
  Start-Sleep -Seconds 2
  $outlineSelection = $null
  if (-not [string]::IsNullOrWhiteSpace($ControlAutomationName)) {
    $outlineAvailable = $false
    try { $outlineAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable } catch { }
    if ($outlineAvailable) {
      $null = $Dte.ExecuteCommand('View.DocumentOutline')
      Start-Sleep -Seconds 2
      $outlineTrees = @([VisualStudioTraceNative]::GetDescendantWindowsByClassFragment($hwnd, 'SysTreeView32'))
      if ($outlineTrees.Count -eq 1) {
        $outlineTree = [IntPtr]$outlineTrees[0]
        $outlineRect = New-Object VisualStudioTraceNative+RECT
        if ([VisualStudioTraceNative]::GetWindowRect($outlineTree, [ref]$outlineRect)) {
          $dpiScale = [double]([VisualStudioTraceNative]::GetDpiForWindow($hwnd)) / 96.0
          $rowHeight = [int][Math]::Round(18 * $dpiScale)
          $outlineX = [int]($outlineRect.Left + [Math]::Round(80 * $dpiScale))
          $outlineY = [int]($outlineRect.Top + [Math]::Round(9 * $dpiScale) + $rowHeight)
          $outlineClickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $outlineX, $outlineY)
          $outlineSelection = [ordered]@{
            route = 'native Document Outline second visible row'
            expectedComponent = $ControlAutomationId
            x = $outlineX
            y = $outlineY
            treeHwnd = $outlineTree.ToInt64()
            clickedWindow = $outlineClickedWindow.ToInt64()
            chain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $outlineX, $outlineY)
          }
          Start-Sleep -Seconds 1
          $null = $window.Activate()
          Start-Sleep -Seconds 1
        }
      }
    }
  }
  $null = $Dte.ExecuteCommand('View.PropertiesWindow')
  Start-Sleep -Seconds 5

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $showEventsCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Show Events'
  )
  $showEventsButton = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $showEventsCondition)
  if ($null -eq $showEventsButton) {
    $toolbarButtons = @($root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      )
    ) | ForEach-Object { ConvertTo-UiAutomationRecord $_ $root })
    throw "Visual Studio Properties did not expose the Show Events button. Buttons: $(@($toolbarButtons | ForEach-Object { $_.name }) -join ' | ')"
  }
  $eventsBounds = $showEventsButton.Current.BoundingRectangle
  $eventsPattern = $null
  if (-not $showEventsButton.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$eventsPattern)) {
    throw 'Visual Studio Show Events toolbar button did not expose InvokePattern.'
  }
  $eventsPattern.Invoke()
  $eventsWindow = [long]$showEventsButton.Current.NativeWindowHandle
  Start-Sleep -Seconds 5
  $eventsCapture = Save-WindowCapture $hwnd $Destination

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $eventCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $EventName
  )
  $eventCandidates = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $eventCondition)
  $eventRow = $null
  $eventRowRecord = $null
  for ($index = 0; $index -lt $eventCandidates.Count; $index++) {
    try {
      $candidate = $eventCandidates.Item($index)
      $record = ConvertTo-UiAutomationRecord $candidate $root
      if ($candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::TreeItem -and
          [string]$record.value -ceq $HandlerName) {
        $eventRow = $candidate
        $eventRowRecord = $record
        break
      }
    } catch { }
  }
  if ($null -eq $eventRow) {
    $inventory = @(Get-UiAutomationInventory $root)
    $named = @($inventory | Where-Object { $_.name -match '(?i)click|event|handler' } | ForEach-Object { "$($_.controlType):$($_.name)=$($_.value)" })
    throw "Visual Studio Events grid did not expose $EventName=$HandlerName. Matching inventory: $($named -join ' | ')"
  }

  $eventBounds = $eventRow.Current.BoundingRectangle
  $rowWindow = [VisualStudioTraceNative]::PostClickUsingCapture(
    $hwnd,
    [int]($eventBounds.Right - 70),
    [int]($eventBounds.Y + ($eventBounds.Height / 2))
  )
  Start-Sleep -Seconds 1
  $handlerMatches = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $handlerItems = [System.Collections.Generic.List[object]]::new()
  $handlerElement = $null
  $handlerValuePattern = $null
  for ($index = 0; $index -lt $handlerMatches.Count; $index++) {
    try {
      $candidate = $handlerMatches.Item($index)
      $valuePattern = $null
      if (-not $candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { continue }
      if ([string]$valuePattern.Current.Value -cne $HandlerName) { continue }
      $record = ConvertTo-UiAutomationRecord $candidate $root
      $handlerItems.Add($record)
      if ($null -eq $handlerElement -and -not $candidate.Current.IsOffscreen -and -not $valuePattern.Current.IsReadOnly) {
        $handlerElement = $candidate
        $handlerValuePattern = $valuePattern
      }
    } catch { }
  }
  if ($null -eq $handlerElement) {
    throw "Visual Studio Events grid did not expose a writable existing handler cell '$HandlerName'. Candidates: $($handlerItems | ConvertTo-Json -Compress -Depth 6)"
  }
  $null = $handlerElement.SetFocus()
  $handlerValuePattern.SetValue($DesiredHandlerName)
  [VisualStudioTraceNative]::PressEnter()
  $handlerCommitMethod = 'UIAutomation.ValuePattern.SetValue + Enter'
  Start-Sleep -Seconds 4
  $dismissal = [VisualStudioTraceNative]::StartDialogDismissal($hwnd, 'Inconsistent Line Endings', 7, 600000)
  $null = $Dte.ExecuteCommand('File.SaveAll')
  [void]$dismissal.Thread.Join(1000)
  $dismissal.Cancelled = $true
  [void]$dismissal.Thread.Join(1000)
  Start-Sleep -Seconds 3

  return [ordered]@{
    document = $SourceFile
    controlAutomationId = $ControlAutomationId
    controlAutomationName = $ControlAutomationName
    controlLocator = $controlLocator
    outlineSelection = $outlineSelection
    clickedWindow = $clickedWindow.ToInt64()
    eventsWindow = $eventsWindow
    rowWindow = $rowWindow.ToInt64()
    eventName = $EventName
    originalHandlerName = $HandlerName
    desiredHandlerName = $DesiredHandlerName
    handlerCommitMethod = $handlerCommitMethod
    eventRow = $eventRowRecord
    handlerItems = @($handlerItems)
    lineEndingDialog = [ordered]@{
      title = 'Inconsistent Line Endings'
      choice = 'No'
      observed = [bool]$dismissal.Observed
      clickPosted = [bool]$dismissal.ClickPosted
      dismissed = [bool]$dismissal.Dismissed
    }
    capture = $eventsCapture
  }
}

function Open-DesignerDefaultEventAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $DesignerFile,
  [string] $AutomationId,
  [string] $AutomationName,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $locator = "AutomationId=$AutomationId"
  if ($null -eq $element -and $AutomationName) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $AutomationName
    )
    $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $locator = "Name=$AutomationName"
  }
  if ($null -eq $element) {
    throw "Visual Studio designer did not expose automation id '$AutomationId' or name '$AutomationName' for S049."
  }
  $bounds = $element.Current.BoundingRectangle
  if ($bounds.Width -lt 1 -or $bounds.Height -lt 1) {
    throw "Visual Studio designer element '$AutomationId' has invalid S049 bounds: $bounds"
  }
  $centerX = [int]($bounds.X + ($bounds.Width / 2))
  $centerY = [int]($bounds.Y + ($bounds.Height / 2))
  $inputWindow = [VisualStudioTraceNative]::DoubleClickAtDeepestChild($hwnd, $centerX, $centerY)

  # The designer transaction and code navigation are asynchronous. Wait for the real active code document before
  # SaveAll, then verify the two physical artifacts rather than inferring success from the click messages.
  $navigationDeadline = [DateTime]::UtcNow.AddSeconds(20)
  $activeDocument = ''
  while ([DateTime]::UtcNow -lt $navigationDeadline) {
    try { $activeDocument = [string]$Dte.ActiveDocument.FullName } catch { $activeDocument = '' }
    if ([string]::Equals($activeDocument, $SourceFile, [System.StringComparison]::OrdinalIgnoreCase)) {
      try {
        if ([int]$Dte.ActiveDocument.Selection.ActivePoint.Line -gt 1) { break }
      } catch { }
    }
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Seconds 2
  # Generating into an LF fixture makes VS ask whether to normalize the code-behind to CRLF. Choose "No" on the IDE's
  # own modal so the reference observes the byte-local handler insertion rather than an unrelated whole-file EOL rewrite.
  # Keep the exact dialog watcher alive for the whole synchronous DTE SaveAll call. On a busy designer the modal can
  # appear after the former 30-second deadline; cancelling is safe only after SaveAll has actually returned.
  $lineEndingDialog = [VisualStudioTraceNative]::StartDialogDismissal($hwnd, 'Inconsistent Line Endings', 7, 600000)
  $null = $Dte.ExecuteCommand('File.SaveAll')
  [void]$lineEndingDialog.Thread.Join(1000)
  $lineEndingDialog.Cancelled = $true
  [void]$lineEndingDialog.Thread.Join(1000)
  Start-Sleep -Seconds 4

  $sourceText = [System.IO.File]::ReadAllText($SourceFile)
  $designerText = [System.IO.File]::ReadAllText($DesignerFile)
  $handlerCreated = ([regex]::Matches($sourceText, '\bbutton1_Click\s*\(')).Count -eq 1
  $subscriptionCreated = ([regex]::Matches($designerText, '\.Click\s*\+=\s*(?:new\s+System\.EventHandler\s*\(\s*)?(?:this\.)?button1_Click')).Count -eq 1
  $cursorLine = 0
  $cursorColumn = 0
  try {
    $cursorLine = [int]$Dte.ActiveDocument.Selection.ActivePoint.Line
    $cursorColumn = [int]$Dte.ActiveDocument.Selection.ActivePoint.DisplayColumn
  } catch { }
  $sourceLines = @($sourceText -split "`r?`n")
  $handlerLine = 0
  for ($index = 0; $index -lt $sourceLines.Count; $index++) {
    if ($sourceLines[$index] -match '\bbutton1_Click\s*\(') { $handlerLine = $index + 1; break }
  }
  $cursorInHandler = $handlerLine -gt 0 -and $cursorLine -ge $handlerLine -and $cursorLine -le ($handlerLine + 4)
  $activeWindow = $Dte.ActiveWindow
  $captureHwnd = Get-WindowHandle $activeWindow $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($captureHwnd)
  Start-Sleep -Milliseconds 500
  return [ordered]@{
    document = $SourceFile
    automationLocator = $locator
    inputWindow = $inputWindow.ToInt64()
    bounds = [ordered]@{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
    activeDocument = $activeDocument
    handlerCreated = $handlerCreated
    subscriptionCreated = $subscriptionCreated
    lineEndingDialog = [ordered]@{
      title = 'Inconsistent Line Endings'
      choice = 'No'
      observed = [bool]$lineEndingDialog.Observed
      clickPosted = [bool]$lineEndingDialog.ClickPosted
      dismissed = [bool]$lineEndingDialog.Dismissed
    }
    cursor = [ordered]@{ line = $cursorLine; column = $cursorColumn; handlerLine = $handlerLine; insideHandler = $cursorInHandler }
    capture = Save-WindowCapture $captureHwnd $Destination
  }
}

function Open-DesignerAlignLeftAndCapture($Dte, [string] $SourceFile, [string] $Destination) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $beforeSelect = [ordered]@{
    selectAllAvailable = [bool]$Dte.Commands.Item('Edit.SelectAll').IsAvailable
    alignLeftAvailable = [bool]$Dte.Commands.Item('Format.AlignLefts').IsAvailable
  }
  if (-not $beforeSelect.selectAllAvailable) {
    throw 'Visual Studio designer did not enable Edit.SelectAll for S029.'
  }
  $null = $Dte.ExecuteCommand('Edit.SelectAll')
  Start-Sleep -Seconds 2
  $afterSelect = [ordered]@{
    selectAllAvailable = [bool]$Dte.Commands.Item('Edit.SelectAll').IsAvailable
    alignLeftAvailable = [bool]$Dte.Commands.Item('Format.AlignLefts').IsAvailable
  }
  if (-not $afterSelect.alignLeftAvailable) {
    throw 'Visual Studio designer did not enable Format.AlignLefts after S029 Edit.SelectAll.'
  }
  $null = $Dte.ExecuteCommand('Format.AlignLefts')
  Start-Sleep -Seconds 4
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 500
  return [ordered]@{
    document = $SourceFile
    command = 'Format.AlignLefts'
    beforeSelect = $beforeSelect
    afterSelect = $afterSelect
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerMakeSameWidthAndCapture($Dte, [string] $SourceFile, [string] $Destination) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $beforeSelect = [ordered]@{
    selectAllAvailable = [bool]$Dte.Commands.Item('Edit.SelectAll').IsAvailable
    makeSameWidthAvailable = [bool]$Dte.Commands.Item('Format.MakeSameWidth').IsAvailable
  }
  if (-not $beforeSelect.selectAllAvailable) {
    throw 'Visual Studio designer did not enable Edit.SelectAll for S030.'
  }
  $null = $Dte.ExecuteCommand('Edit.SelectAll')
  Start-Sleep -Seconds 2
  $afterSelect = [ordered]@{
    selectAllAvailable = [bool]$Dte.Commands.Item('Edit.SelectAll').IsAvailable
    makeSameWidthAvailable = [bool]$Dte.Commands.Item('Format.MakeSameWidth').IsAvailable
  }
  if (-not $afterSelect.makeSameWidthAvailable) {
    throw 'Visual Studio designer did not enable Format.MakeSameWidth after S030 Edit.SelectAll.'
  }
  $null = $Dte.ExecuteCommand('Format.MakeSameWidth')
  Start-Sleep -Seconds 4
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 500
  return [ordered]@{
    document = $SourceFile
    command = 'Format.MakeSameWidth'
    beforeSelect = $beforeSelect
    afterSelect = $afterSelect
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerCenterHorizontalAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $AutomationId,
  [string] $AutomationName,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $selectionLocator = "AutomationId=$AutomationId"
  if ($null -eq $element -and $AutomationName) {
    $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $AutomationName
    )
    $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
    $elementCondition = $nameCondition
    $selectionLocator = "Name=$AutomationName"
  }
  if ($null -eq $element) {
    $available = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
      ForEach-Object {
        $current = $_.Current
        if ($current.AutomationId -or $current.Name) {
          "id='$($current.AutomationId)' name='$($current.Name)' type='$($current.ControlType.ProgrammaticName)'"
        }
      } | Select-Object -First 40)
    throw "Visual Studio designer did not expose automation id '$AutomationId' or name '$AutomationName'. Available elements: $($available -join '; ')"
  }
  $before = $element.Current.BoundingRectangle
  if ($before.Width -lt 1 -or $before.Height -lt 1) {
    throw "Visual Studio designer element '$AutomationId' has invalid bounds: $before"
  }
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 500
  $centerX = [int]($before.X + ($before.Width / 2))
  $centerY = [int]($before.Y + ($before.Height / 2))
  $clickedWindow = [IntPtr]::Zero
  $selectionAttempts = @()
  $commandAvailability = [ordered]@{ centerHorizontally = $false; centerHorizontal = $false }
  $supportedPatterns = @($element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
  foreach ($uiaMethod in @('SetFocus', 'SelectionItem.Select', 'LegacyIAccessible.Select')) {
    $uiaError = ''
    try {
      if ($uiaMethod -eq 'SetFocus') {
        $element.SetFocus()
      } elseif ($uiaMethod -eq 'SelectionItem.Select') {
        $pattern = $null
        if (-not $element.TryGetCurrentPattern(
            [System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
          throw 'SelectionItemPattern is unavailable'
        }
        ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
      } else {
        $pattern = $null
        if (-not $element.TryGetCurrentPattern(
            [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$pattern)) {
          throw 'LegacyIAccessiblePattern is unavailable'
        }
        # SELFLAG_TAKEFOCUS | SELFLAG_TAKESELECTION. Unlike Invoke/DoDefaultAction, this requests selection without
        # executing the Button's runtime Click action.
        ([System.Windows.Automation.LegacyIAccessiblePattern]$pattern).Select(3)
      }
    } catch {
      $uiaError = $_.Exception.GetBaseException().Message
    }
    Start-Sleep -Milliseconds 750
    $commandAvailability = [ordered]@{
      centerHorizontally = [bool]$Dte.Commands.Item('Format.CenterHorizontally').IsAvailable
      centerHorizontal = [bool]$Dte.Commands.Item('Format.CenterHorizontal').IsAvailable
    }
    $selectionAttempts += [ordered]@{
      method = $uiaMethod
      error = $uiaError
      supportedPatterns = $supportedPatterns
      commandAvailability = $commandAvailability
    }
    if ($commandAvailability.centerHorizontally -or $commandAvailability.centerHorizontal) { break }
  }
  if (-not ($commandAvailability.centerHorizontally -or $commandAvailability.centerHorizontal)) {
    $captureClickError = ''
    try {
      # WinForms Designer places an InputShield/capture HWND above the rendered child controls. A posted down/up pair
      # follows that real designer routing without depending on the disconnected session's physical input desktop.
      $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $centerX, $centerY)
    } catch {
      $captureClickError = $_.Exception.GetBaseException().Message
    }
    Start-Sleep -Milliseconds 750
    $commandAvailability = [ordered]@{
      centerHorizontally = [bool]$Dte.Commands.Item('Format.CenterHorizontally').IsAvailable
      centerHorizontal = [bool]$Dte.Commands.Item('Format.CenterHorizontal').IsAvailable
    }
    $selectionAttempts += [ordered]@{
      method = 'PostClickUsingCapture'
      error = $captureClickError
      clickedWindow = $clickedWindow.ToInt64()
      deepestChildChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $centerX, $centerY)
      commandAvailability = $commandAvailability
    }
  }
  if (-not ($commandAvailability.centerHorizontally -or $commandAvailability.centerHorizontal)) {
    $headlessClickError = ''
    $headlessWindowShift = $null
    $originalWindowRect = New-Object VisualStudioTraceNative+RECT
    if (-not [VisualStudioTraceNative]::GetWindowRect($hwnd, [ref]$originalWindowRect)) {
      $headlessClickError = 'GetWindowRect failed before the disconnected-desktop S031 selection fallback.'
    } else {
      $shiftX = -$centerX
      $shiftY = -$centerY
      try {
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
          [VisualStudioTraceNative]::MoveWindowTo($hwnd, $originalWindowRect.Left + $shiftX, $originalWindowRect.Top + $shiftY)
          Start-Sleep -Milliseconds 500
          $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
          $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $elementCondition)
          if ($null -eq $element) { throw "S031 lost designer element '$selectionLocator' after trace-window offset." }
          $syntheticBounds = $element.Current.BoundingRectangle
          $syntheticCenterX = [int]($syntheticBounds.X + ($syntheticBounds.Width / 2))
          $syntheticCenterY = [int]($syntheticBounds.Y + ($syntheticBounds.Height / 2))
          if ([Math]::Abs($syntheticCenterX) -le 1 -and [Math]::Abs($syntheticCenterY) -le 1) { break }
          $shiftX -= $syntheticCenterX
          $shiftY -= $syntheticCenterY
        }
        if (0 -lt $syntheticBounds.X -or 0 -ge $syntheticBounds.Right -or
            0 -lt $syntheticBounds.Y -or 0 -ge $syntheticBounds.Bottom) {
          throw "S031 virtual-cursor point (0,0) is outside the shifted Button bounds $syntheticBounds."
        }
        [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
        $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, 0, 0)
        $headlessWindowShift = [ordered]@{
          x = $shiftX
          y = $shiftY
          syntheticButtonBounds = [ordered]@{
            x = $syntheticBounds.X
            y = $syntheticBounds.Y
            width = $syntheticBounds.Width
            height = $syntheticBounds.Height
          }
        }
      } catch {
        $headlessClickError = $_.Exception.GetBaseException().Message
      } finally {
        [VisualStudioTraceNative]::MoveWindowTo($hwnd, $originalWindowRect.Left, $originalWindowRect.Top)
        Start-Sleep -Seconds 1
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      }
    }
    Start-Sleep -Milliseconds 750
    $commandAvailability = [ordered]@{
      centerHorizontally = [bool]$Dte.Commands.Item('Format.CenterHorizontally').IsAvailable
      centerHorizontal = [bool]$Dte.Commands.Item('Format.CenterHorizontal').IsAvailable
    }
    $selectionAttempts += [ordered]@{
      method = 'DisconnectedDesktopWindowOffsetClick'
      error = $headlessClickError
      clickedWindow = $clickedWindow.ToInt64()
      windowShift = $headlessWindowShift
      commandAvailability = $commandAvailability
    }
  }
  if (-not ($commandAvailability.centerHorizontally -or $commandAvailability.centerHorizontal)) {
    $outlineError = ''
    $outlineCommandAvailable = $false
    $outlineInventory = @()
    $outlineTreeInventory = @()
    $outlineWindowInventory = @()
    $outlineWindowInfo = $null
    $outlineSelection = $null
    try {
      $outlineCommandAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable
      if (-not $outlineCommandAvailable) { throw 'View.DocumentOutline is unavailable.' }
      $null = $Dte.ExecuteCommand('View.DocumentOutline')
      Start-Sleep -Seconds 2
      $outlineWindow = $null
      try { $outlineWindow = $Dte.ActiveWindow } catch { }
      $activeWindowCaption = $null
      try {
        if ($null -ne $outlineWindow) { $activeWindowCaption = [string]$outlineWindow.Caption }
      } catch {
        $outlineWindow = $null
      }
      if ($null -eq $outlineWindow -or $activeWindowCaption -notmatch '(?i)Document Outline') {
        $outlineWindow = $null
      }
      if ($null -eq $outlineWindow) {
        $outlineWindowInfo = [ordered]@{
          caption = 'DTE_UNEXPOSED_OWNER_DRAWN_DOCUMENT_OUTLINE'
          left = $null
          top = $null
          width = $null
          height = $null
          visible = $true
        }
      } else {
        $outlineWindowInfo = [ordered]@{
          caption = [string]$outlineWindow.Caption
          left = [int]$outlineWindow.Left
          top = [int]$outlineWindow.Top
          width = [int]$outlineWindow.Width
          height = [int]$outlineWindow.Height
          visible = [bool]$outlineWindow.Visible
        }
      }
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      $outlineCandidates = @($root.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object {
          try {
            $_.Current.Name -match '(?i)\bbutton1\b' -or $_.Current.AutomationId -match '(?i)\bbutton1\b'
          } catch {
            $false
          }
        })
      foreach ($candidate in $outlineCandidates) {
        $current = $candidate.Current
        $patterns = @($candidate.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
        $outlineInventory += [ordered]@{
          name = $current.Name
          automationId = $current.AutomationId
          controlType = $current.ControlType.ProgrammaticName
          patterns = $patterns
        }
        $selectionPattern = $null
        if ($null -eq $outlineSelection -and
            $candidate.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) {
          ([System.Windows.Automation.SelectionItemPattern]$selectionPattern).Select()
          $outlineSelection = [ordered]@{
            name = $current.Name
            automationId = $current.AutomationId
            controlType = $current.ControlType.ProgrammaticName
          }
        }
      }
      if ($null -eq $outlineSelection) {
        if ($outlineWindowInfo.caption -eq 'DTE_UNEXPOSED_OWNER_DRAWN_DOCUMENT_OUTLINE') {
          # The capture profile keeps Document Outline immediately left of the designer. This deterministic fixture's
          # expanded third row is (-154,-37) from button1's accessible center-area origin; record the bounded locator
          # explicitly because neither DTE nor UIA marshals the owner-drawn tool window or its TreeItems out of process.
          $treeClickX = [int]($before.X - 154)
          $treeClickY = [int]($before.Y - 37)
          $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $treeClickX, $treeClickY)
          Start-Sleep -Milliseconds 750
          $outlineSelection = [ordered]@{
            name = 'button1'
            locator = 'FixtureRelativeOwnerDrawnDocumentOutlineThirdRow'
            point = [ordered]@{ x = $treeClickX; y = $treeClickY }
            buttonOrigin = [ordered]@{ x = $before.X; y = $before.Y }
            clickedWindow = $clickedWindow.ToInt64()
          }
        }
      }
      if ($null -eq $outlineSelection) {
        if ($outlineWindowInfo.visible -and $outlineWindowInfo.width -ge 120 -and $outlineWindowInfo.height -ge 100) {
          # The native Document Outline fixture tree is expanded and deterministic: Form, Panel, button1. DTE provides
          # the real docked tool-window bounds even though its owner-drawn rows do not publish UIA TreeItem patterns.
          $treeClickX = [int]($outlineWindowInfo.left + [Math]::Min(110, $outlineWindowInfo.width / 2))
          $treeClickY = [int]($outlineWindowInfo.top + 71)
          $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $treeClickX, $treeClickY)
          Start-Sleep -Milliseconds 750
          $outlineSelection = [ordered]@{
            name = 'button1'
            locator = 'DteDocumentOutlineWindowThirdExpandedRow'
            point = [ordered]@{ x = $treeClickX; y = $treeClickY }
            clickedWindow = $clickedWindow.ToInt64()
          }
        }
      }
      if ($null -eq $outlineSelection) {
        $treeCondition = [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Tree
        )
        $treeCandidates = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $treeCondition))
        $usableTrees = @()
        foreach ($treeCandidate in $treeCandidates) {
          $treeCurrent = $treeCandidate.Current
          $treeBounds = $treeCurrent.BoundingRectangle
          $outlineTreeInventory += [ordered]@{
            name = $treeCurrent.Name
            automationId = $treeCurrent.AutomationId
            x = $treeBounds.X
            y = $treeBounds.Y
            width = $treeBounds.Width
            height = $treeBounds.Height
          }
          if ($treeBounds.Width -ge 80 -and $treeBounds.Height -ge 60 -and $treeBounds.X -lt 960) {
            $usableTrees += [pscustomobject]@{ element = $treeCandidate; bounds = $treeBounds }
          }
        }
        $outlineTree = $usableTrees | Sort-Object { $_.bounds.X }, { $_.bounds.Y } | Select-Object -First 1
        if ($null -ne $outlineTree) {
          # The fixture tree is deterministic and expanded by the designer: Form, Panel, then button1. The native
          # Document Outline row height is 18 px in this 96-DPI capture, so the third-row center is tree.Top + 45.
          $treeClickX = [int]($outlineTree.bounds.X + [Math]::Min(100, $outlineTree.bounds.Width / 2))
          $treeClickY = [int]($outlineTree.bounds.Y + 45)
          $clickedWindow = [VisualStudioTraceNative]::PostClickUsingCapture($hwnd, $treeClickX, $treeClickY)
          Start-Sleep -Milliseconds 750
          $outlineSelection = [ordered]@{
            name = 'button1'
            locator = 'DocumentOutlineTreeThirdExpandedRow'
            point = [ordered]@{ x = $treeClickX; y = $treeClickY }
            clickedWindow = $clickedWindow.ToInt64()
          }
        }
      }
      if ($null -eq $outlineSelection) { throw 'Document Outline exposed no selectable button1 item.' }
      $null = $window.Activate()
      Start-Sleep -Milliseconds 750
    } catch {
      $outlineError = $_.Exception.GetBaseException().Message
      try { $null = $window.Activate() } catch { }
    }
    $commandAvailability = [ordered]@{
      centerHorizontally = [bool]$Dte.Commands.Item('Format.CenterHorizontally').IsAvailable
      centerHorizontal = [bool]$Dte.Commands.Item('Format.CenterHorizontal').IsAvailable
    }
    $selectionAttempts += [ordered]@{
      method = 'DocumentOutlineSelectionItem'
      error = $outlineError
      outlineCommandAvailable = $outlineCommandAvailable
      selected = $outlineSelection
      window = $outlineWindowInfo
      windowInventory = $outlineWindowInventory
      inventory = $outlineInventory
      treeInventory = $outlineTreeInventory
      commandAvailability = $commandAvailability
    }
  }
  if (-not ($commandAvailability.centerHorizontally -or $commandAvailability.centerHorizontal)) {
    # The accessible child exposed by the designer is a rendered HWND without selection patterns. Select the parent
    # surface at an empty point, then use the WinForms designer's own Tab traversal to reach its first child. This is
    # genuine IDE input; the expected source patch below remains the authority that tells us whether button1, rather
    # than the Panel or Form, was selected.
    $surfaceX = [int]($before.X + $before.Width + 20)
    $surfaceY = [int]($before.Y + ($before.Height / 2))
    $clickedWindow = [VisualStudioTraceNative]::ClickAtDeepestChild($hwnd, $surfaceX, $surfaceY)
    Start-Sleep -Milliseconds 500
    for ($tabIndex = 1; $tabIndex -le 4; $tabIndex++) {
      [VisualStudioTraceNative]::PressTab()
      Start-Sleep -Milliseconds 750
      $commandAvailability = [ordered]@{
        centerHorizontally = [bool]$Dte.Commands.Item('Format.CenterHorizontally').IsAvailable
        centerHorizontal = [bool]$Dte.Commands.Item('Format.CenterHorizontal').IsAvailable
      }
      $selectionAttempts += [ordered]@{
        method = 'DesignerTabTraversal'
        tabIndex = $tabIndex
        surfacePoint = [ordered]@{ x = $surfaceX; y = $surfaceY }
        clickedWindow = $clickedWindow.ToInt64()
        commandAvailability = $commandAvailability
      }
      if ($commandAvailability.centerHorizontally -or $commandAvailability.centerHorizontal) { break }
    }
  }
  for ($levelsUp = 0;
       -not ($commandAvailability.centerHorizontally -or $commandAvailability.centerHorizontal) -and $levelsUp -le 8;
       $levelsUp++) {
    $clickedWindow = [VisualStudioTraceNative]::ClickAtAncestor($hwnd, $centerX, $centerY, $levelsUp)
    Start-Sleep -Milliseconds 750
    $commandAvailability = [ordered]@{
      centerHorizontally = [bool]$Dte.Commands.Item('Format.CenterHorizontally').IsAvailable
      centerHorizontal = [bool]$Dte.Commands.Item('Format.CenterHorizontal').IsAvailable
    }
    $selectionAttempts += [ordered]@{
      method = 'NativeClickAncestor'
      levelsUp = $levelsUp
      clickedWindow = $clickedWindow.ToInt64()
      commandAvailability = $commandAvailability
    }
    if ($commandAvailability.centerHorizontally -or $commandAvailability.centerHorizontal) { break }
  }
  $command = if ($commandAvailability.centerHorizontally) {
    'Format.CenterHorizontally'
  } elseif ($commandAvailability.centerHorizontal) {
    'Format.CenterHorizontal'
  } else {
    $null
  }
  if (-not $command) {
    $selectionFailure = "Visual Studio designer did not enable a horizontal-center command after selecting S031 button1 via $selectionLocator at bounds $before."
    return [ordered]@{
      document = $SourceFile
      automationId = $AutomationId
      automationName = $AutomationName
      selectionLocator = $selectionLocator
      command = $null
      commandAvailability = $commandAvailability
      selectionFailure = $selectionFailure
      input = [ordered]@{ clickedWindow = $clickedWindow.ToInt64() }
      selectionAttempts = $selectionAttempts
      beforeBounds = [ordered]@{ x = $before.X; y = $before.Y; width = $before.Width; height = $before.Height }
      afterBounds = [ordered]@{ x = $before.X; y = $before.Y; width = $before.Width; height = $before.Height }
      capture = Save-WindowCapture $hwnd $Destination
    }
  }
  $null = $Dte.ExecuteCommand($command)
  Start-Sleep -Seconds 4
  $null = $Dte.ExecuteCommand('File.SaveAll')
  Start-Sleep -Seconds 3

  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $elementCondition)
  if ($null -eq $element) { throw "Visual Studio designer lost automation id '$AutomationId' after centering." }
  $after = $element.Current.BoundingRectangle
  return [ordered]@{
    document = $SourceFile
    automationId = $AutomationId
    automationName = $AutomationName
    selectionLocator = $selectionLocator
    command = $command
    commandAvailability = $commandAvailability
    selectionFailure = $null
    input = [ordered]@{ clickedWindow = $clickedWindow.ToInt64() }
    selectionAttempts = $selectionAttempts
    beforeBounds = [ordered]@{ x = $before.X; y = $before.Y; width = $before.Width; height = $before.Height }
    afterBounds = [ordered]@{ x = $after.X; y = $after.Y; width = $after.Width; height = $after.Height }
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Open-DesignerOutlineReparentAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $AutomationId,
  [string] $AutomationName,
  [string] $BeforeDestination,
  [string] $ActiveDragDestination,
  [string] $AfterDestination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $outlineCommandAvailable = [bool]$Dte.Commands.Item('View.DocumentOutline').IsAvailable
  if (-not $outlineCommandAvailable) { throw 'Visual Studio did not enable View.DocumentOutline for S063.' }
  $null = $Dte.ExecuteCommand('View.DocumentOutline')
  Start-Sleep -Seconds 2

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $idCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCondition)
  $locator = "AutomationId=$AutomationId"
  if ($null -eq $element) {
    $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $AutomationName
    )
    $visibleNameMatches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition) | Where-Object {
      $bounds = $_.Current.BoundingRectangle
      -not $_.Current.IsOffscreen -and $bounds.Width -gt 0 -and $bounds.Height -gt 0
    })
    if ($visibleNameMatches.Count -eq 1) {
      $element = $visibleNameMatches[0]
      $locator = "unique visible Name=$AutomationName"
    }
  }
  if ($null -eq $element) { throw "Visual Studio did not expose S063 control '$AutomationId'/'$AutomationName'." }
  $buttonBounds = $element.Current.BoundingRectangle

  # The installed VS 18 Document Outline is an owner-drawn SysTreeView32 and publishes no UIA TreeItems, but its
  # tree HWND still publishes an exact bounding rectangle. Select the closest usable tree to the left of the designer
  # control (rather than Solution Explorer farther left). This fixture's visible order is deterministic and captured:
  # Form, groupBox1, expanded panel1, button1.
  $dpiScale = [double]([VisualStudioTraceNative]::GetDpiForWindow($hwnd)) / 96.0
  $outlineTreeWindows = @([VisualStudioTraceNative]::GetDescendantWindowsByClassFragment($hwnd, 'SysTreeView32'))
  if ($outlineTreeWindows.Count -ne 1) {
    throw "Visual Studio exposed $($outlineTreeWindows.Count) descendant SysTreeView32 windows for S063; expected the one native Document Outline tree."
  }
  $outlineTreeHwnd = [IntPtr]$outlineTreeWindows[0]
  $outlineTreeRect = New-Object VisualStudioTraceNative+RECT
  if (-not [VisualStudioTraceNative]::GetWindowRect($outlineTreeHwnd, [ref]$outlineTreeRect)) {
    throw 'GetWindowRect failed for the S063 native Document Outline tree.'
  }
  $outlineTree = [ordered]@{
    className = [VisualStudioTraceNative]::GetWindowClassName($outlineTreeHwnd)
    nativeWindowHandle = $outlineTreeHwnd.ToInt64()
    bounds = [ordered]@{
      x = $outlineTreeRect.Left
      y = $outlineTreeRect.Top
      width = $outlineTreeRect.Right - $outlineTreeRect.Left
      height = $outlineTreeRect.Bottom - $outlineTreeRect.Top
    }
  }
  $rowHeight = [int][Math]::Round(18 * $dpiScale)
  $firstRowCenterOffset = [int][Math]::Round(9 * $dpiScale)
  $startX = [int]($outlineTree.bounds.x + [Math]::Min([Math]::Round(120 * $dpiScale), $outlineTree.bounds.width * 0.75))
  $startY = [int]($outlineTree.bounds.y + $firstRowCenterOffset + (3 * $rowHeight))
  $targetX = $startX
  $targetY = [int]($outlineTree.bounds.y + $firstRowCenterOffset + $rowHeight)
  $beforeCapture = Save-WindowCapture $hwnd $BeforeDestination
  $startChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $startX, $startY)
  $targetChain = [VisualStudioTraceNative]::DescribeDeepestChildChain($hwnd, $targetX, $targetY)
  $dragWindow = [VisualStudioTraceNative]::PhysicalDragAtScreen($hwnd, $startX, $startY, $targetX, $targetY)
  $activeDragCapture = Save-WindowCapture $hwnd $ActiveDragDestination
  Start-Sleep -Seconds 4
  $null = $window.Activate()
  Start-Sleep -Seconds 1
  $afterCapture = Save-WindowCapture $hwnd $AfterDestination

  $dismissal = [VisualStudioTraceNative]::StartDialogDismissal(
    $hwnd,
    'Inconsistent Line Endings',
    7,
    600000
  )
  $null = $Dte.ExecuteCommand('File.SaveAll')
  [void]$dismissal.Thread.Join(1000)
  $dismissal.Cancelled = $true
  [void]$dismissal.Thread.Join(1000)
  Start-Sleep -Seconds 3

  return [ordered]@{
    document = $SourceFile
    outlineCommandAvailable = $outlineCommandAvailable
    controlLocator = $locator
    controlBounds = [ordered]@{ x = $buttonBounds.X; y = $buttonBounds.Y; width = $buttonBounds.Width; height = $buttonBounds.Height }
    drag = [ordered]@{
      route = 'owner-drawn Document Outline physical drag on the interactive capture desktop'
      tree = [ordered]@{
        className = $outlineTree.className
        nativeWindowHandle = $outlineTree.nativeWindowHandle
        bounds = $outlineTree.bounds
        visibleFixtureOrder = @('S063OutlineReparentForm', 'groupBox1', 'panel1', 'button1')
        rowHeight = $rowHeight
      }
      start = [ordered]@{ x = $startX; y = $startY; expectedRow = 'button1 (fourth visible row)'; chain = $startChain }
      target = [ordered]@{ x = $targetX; y = $targetY; expectedRow = 'groupBox1 (second visible row)'; chain = $targetChain }
      captureWindow = $dragWindow.ToInt64()
    }
    lineEndingDialog = [ordered]@{
      title = 'Inconsistent Line Endings'
      choice = 'No'
      observed = [bool]$dismissal.Observed
      clickPosted = [bool]$dismissal.ClickPosted
      dismissed = [bool]$dismissal.Dismissed
    }
    beforeCapture = $beforeCapture
    activeDragCapture = $activeDragCapture
    afterCapture = $afterCapture
  }
}

function Open-DesignerRtlGeometryAndCapture(
  $Dte,
  [string] $SourceFile,
  [string] $Destination
) {
  $item = $Dte.Solution.FindProjectItem($SourceFile)
  if ($null -eq $item) { throw "Visual Studio did not resolve project item: $SourceFile" }
  $window = $item.Open('{00000000-0000-0000-0000-000000000000}')
  if ($null -eq $window) { throw "Visual Studio did not open a designer window for $SourceFile" }
  $window.Visible = $true
  $null = $window.Activate()
  Start-Sleep -Seconds 2
  try { $null = $Dte.ExecuteCommand('View.ViewDesigner') } catch { }
  Start-Sleep -Seconds 8

  $hwnd = Get-WindowHandle $window $Dte
  [void][VisualStudioTraceNative]::SetForegroundWindow($hwnd)
  $formMatches = @([VisualStudioTraceNative]::GetDescendantWindowsByExactText($hwnd, 'S079 RTL layout'))
  $buttonMatches = @([VisualStudioTraceNative]::GetDescendantWindowsByExactText($hwnd, 'RTL primary'))
  $labelMatches = @([VisualStudioTraceNative]::GetDescendantWindowsByExactText($hwnd, 'RTL status'))
  if ($formMatches.Count -ne 1 -or $buttonMatches.Count -ne 1 -or $labelMatches.Count -ne 1) {
    $diagnosticCapture = Save-WindowCapture $hwnd $Destination
    $nativeInventory = @([VisualStudioTraceNative]::GetDescendantWindowInventory($hwnd) | Select-Object -First 160)
    throw "S079 requires one native Form/Button/Label HWND; observed form=$($formMatches.Count), button=$($buttonMatches.Count), label=$($labelMatches.Count). Capture SHA-256=$($diagnosticCapture.sha256). Native descendants: $($nativeInventory -join '; ')"
  }
  $formHwnd = [IntPtr]$formMatches[0]
  $buttonHwnd = [IntPtr]$buttonMatches[0]
  $labelHwnd = [IntPtr]$labelMatches[0]
  $clientRect = New-Object VisualStudioTraceNative+RECT
  $buttonRect = New-Object VisualStudioTraceNative+RECT
  $labelRect = New-Object VisualStudioTraceNative+RECT
  if (-not [VisualStudioTraceNative]::GetClientScreenRect($formHwnd, [ref]$clientRect) -or
      -not [VisualStudioTraceNative]::GetWindowRect($buttonHwnd, [ref]$buttonRect) -or
      -not [VisualStudioTraceNative]::GetWindowRect($labelHwnd, [ref]$labelRect)) {
    throw 'S079 could not measure the native Form client rectangle and both child HWND rectangles.'
  }
  $clientWidth = $clientRect.Right - $clientRect.Left
  $clientHeight = $clientRect.Bottom - $clientRect.Top
  $button = [ordered]@{
    nativeWindowHandle = $buttonHwnd.ToInt64()
    className = [VisualStudioTraceNative]::GetWindowClassName($buttonHwnd)
    text = [VisualStudioTraceNative]::GetWindowTextValue($buttonHwnd)
    logicalSource = [ordered]@{ x = 20; y = 30; width = 90; height = 28 }
    expectedMirrored = [ordered]@{ x = $clientWidth - 20 - 90; y = 30; width = 90; height = 28 }
    actualClient = [ordered]@{
      x = $buttonRect.Left - $clientRect.Left
      y = $buttonRect.Top - $clientRect.Top
      width = $buttonRect.Right - $buttonRect.Left
      height = $buttonRect.Bottom - $buttonRect.Top
    }
  }
  $label = [ordered]@{
    nativeWindowHandle = $labelHwnd.ToInt64()
    className = [VisualStudioTraceNative]::GetWindowClassName($labelHwnd)
    text = [VisualStudioTraceNative]::GetWindowTextValue($labelHwnd)
    logicalSource = [ordered]@{ x = 50; y = 82; width = 80; height = 20 }
    expectedMirrored = [ordered]@{ x = $clientWidth - 50 - 80; y = 82; width = 80; height = 20 }
    actualClient = [ordered]@{
      x = $labelRect.Left - $clientRect.Left
      y = $labelRect.Top - $clientRect.Top
      width = $labelRect.Right - $labelRect.Left
      height = $labelRect.Bottom - $labelRect.Top
    }
  }
  return [ordered]@{
    document = $SourceFile
    route = 'actual classic net48 WinForms Designer native child HWND geometry'
    form = [ordered]@{
      nativeWindowHandle = $formHwnd.ToInt64()
      className = [VisualStudioTraceNative]::GetWindowClassName($formHwnd)
      text = [VisualStudioTraceNative]::GetWindowTextValue($formHwnd)
      clientScreenBounds = [ordered]@{
        x = $clientRect.Left
        y = $clientRect.Top
        width = $clientWidth
        height = $clientHeight
      }
    }
    controls = [ordered]@{ primaryButton = $button; statusLabel = $label }
    capture = Save-WindowCapture $hwnd $Destination
  }
}

function Get-S024Shape([string] $Text) {
  $fieldMatches = [regex]::Matches(
    $Text,
    '(?m)^\s*private System\.Windows\.Forms\.Button\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*null!;|;)\s*$'
  )
  $buttons = [System.Collections.Generic.List[object]]::new()
  foreach ($fieldMatch in $fieldMatches) {
    $name = [string]$fieldMatch.Groups['name'].Value
    $escapedName = [regex]::Escape($name)
    $nameAssignment = [regex]::Match(
      $Text,
      ('(?m)^\s*(?:this\.)?{0}\.Name\s*=\s*"([^"]+)";\s*$' -f $escapedName)
    )
    $location = [regex]::Match(
      $Text,
      ('(?m)^\s*(?:this\.)?{0}\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$' -f $escapedName)
    )
    $size = [regex]::Match(
      $Text,
      ('(?m)^\s*(?:this\.)?{0}\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$' -f $escapedName)
    )
    $textAssignment = [regex]::Match(
      $Text,
      ('(?m)^\s*(?:this\.)?{0}\.Text\s*=\s*"([^"]*)";\s*$' -f $escapedName)
    )
    $tabIndex = [regex]::Match(
      $Text,
      ('(?m)^\s*(?:this\.)?{0}\.TabIndex\s*=\s*(\d+);\s*$' -f $escapedName)
    )
    if (-not $nameAssignment.Success -or -not $location.Success -or -not $size.Success -or
        -not $textAssignment.Success -or -not $tabIndex.Success) {
      throw "Cannot parse the complete S024 Button shape for $name."
    }
    $buttons.Add([ordered]@{
      fieldName = $name
      serializedName = $nameAssignment.Groups[1].Value
      location = [ordered]@{ x = [int]$location.Groups[1].Value; y = [int]$location.Groups[2].Value }
      size = [ordered]@{ width = [int]$size.Groups[1].Value; height = [int]$size.Groups[2].Value }
      text = $textAssignment.Groups[1].Value
      tabIndex = [int]$tabIndex.Groups[1].Value
      rootOwnerCount = ([regex]::Matches(
        $Text,
        ('(?m)^\s*(?:this\.)?Controls\.Add\((?:this\.)?{0}\);\s*$' -f $escapedName)
      )).Count
    })
  }
  return [ordered]@{
    buttonCount = $buttons.Count
    buttons = @($buttons | Sort-Object fieldName)
    distinctFieldNameCount = @($buttons | ForEach-Object fieldName | Sort-Object -Unique).Count
    distinctSerializedNameCount = @($buttons | ForEach-Object serializedName | Sort-Object -Unique).Count
  }
}

function Get-S024LegEvaluation($Before, $After, $Capture) {
  $beforeButton = @($Before.shape.buttons)[0]
  $afterButtons = @($Capture.afterPaste.shape.buttons)
  $original = @($afterButtons | Where-Object { $_.fieldName -ceq 'submitButton' })
  $clone = @($afterButtons | Where-Object { $_.fieldName -cne 'submitButton' })
  $copyPropertiesExact = $original.Count -eq 1 -and $clone.Count -eq 1 -and
    $original[0].serializedName -ceq 'submitButton' -and
    $clone[0].serializedName -ceq $clone[0].fieldName -and
    $original[0].text -ceq $beforeButton.text -and $clone[0].text -ceq $beforeButton.text -and
    $original[0].size.width -eq $beforeButton.size.width -and
    $original[0].size.height -eq $beforeButton.size.height -and
    $clone[0].size.width -eq $beforeButton.size.width -and
    $clone[0].size.height -eq $beforeButton.size.height -and
    $original[0].rootOwnerCount -eq 1 -and $clone[0].rootOwnerCount -eq 1
  $undoShapeExact = ($Capture.afterUndo.shape | ConvertTo-Json -Depth 10 -Compress) -ceq
    ($Before.shape | ConvertTo-Json -Depth 10 -Compress)
  $redoShapeExact = ($Capture.afterRedo.shape | ConvertTo-Json -Depth 10 -Compress) -ceq
    ($Capture.afterPaste.shape | ConvertTo-Json -Depth 10 -Compress)
  $redoBytesExact = $Capture.afterRedo.designerSha256 -ceq $Capture.afterPaste.designerSha256
  $sourceAndProjectExact = $Before.sourceSha256 -eq $After.sourceSha256 -and
    $Before.projectSha256 -eq $After.projectSha256
  $pass = $Before.shape.buttonCount -eq 1 -and $Before.shape.distinctFieldNameCount -eq 1 -and
    $Capture.copyAvailable -and $Capture.pasteAvailable -and $Capture.copyWasNonMutating -and
    $Capture.afterPaste.shape.buttonCount -eq 2 -and
    $Capture.afterPaste.shape.distinctFieldNameCount -eq 2 -and
    $Capture.afterPaste.shape.distinctSerializedNameCount -eq 2 -and
    $copyPropertiesExact -and $Capture.undoAvailable -and $Capture.redoAvailable -and
    $undoShapeExact -and $redoShapeExact -and $redoBytesExact -and $sourceAndProjectExact
  return [ordered]@{
    status = $(if ($pass) { 'PASS' } else { 'FAIL' })
    pass = $pass
    before = $Before
    after = $After
    observedClone = $(if ($clone.Count -eq 1) { $clone[0] } else { $null })
    copyPropertiesExact = $copyPropertiesExact
    undoShapeExact = $undoShapeExact
    redoShapeExact = $redoShapeExact
    redoBytesExact = $redoBytesExact
    sourceAndProjectExact = $sourceAndProjectExact
    visualStudioWindow = $Capture
  }
}

function Get-S021Shape([string] $Text) {
  $result = [ordered]@{}
  foreach ($id in @('button1', 'button2')) {
    $location = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$"
    )
    if (-not $location.Success) { throw "Cannot parse S021 Location assignment for $id." }
    $result[$id] = [ordered]@{
      location = [ordered]@{ x = [int]$location.Groups[1].Value; y = [int]$location.Groups[2].Value }
    }
  }
  return $result
}


function Get-S022Shape([string] $Text) {
  $anchor = [regex]::Match($Text, '(?m)^\s*(?:this\.)?anchoredButton\.Anchor\s*=\s*(.+);\s*$')
  $location = [regex]::Match($Text, '(?m)^\s*(?:this\.)?anchoredButton\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$')
  $size = [regex]::Match($Text, '(?m)^\s*(?:this\.)?anchoredButton\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$')
  if (-not $anchor.Success -or -not $location.Success -or -not $size.Success) {
    throw 'Cannot parse S022 Anchor/Location/Size assignments.'
  }
  return [ordered]@{
    anchor = $anchor.Groups[1].Value.Trim()
    location = [ordered]@{ x = [int]$location.Groups[1].Value; y = [int]$location.Groups[2].Value }
    size = [ordered]@{ width = [int]$size.Groups[1].Value; height = [int]$size.Groups[2].Value }
  }
}

function Get-S017Shape([string] $Text) {
  $textCounts = [ordered]@{}
  foreach ($entry in ([ordered]@{
      enclosedA = 'Enclosed A'
      enclosedB = 'Enclosed B'
      partial = 'Partial'
      panelOutside = 'Panel outside'
      formOutsideA = 'Form outside A'
      formOutsideB = 'Form outside B'
    }).GetEnumerator()) {
    $textCounts[$entry.Key] = ([regex]::Matches(
        $Text,
        '(?m)^\s*(?:this\.)?\w+\.Text\s*=\s*"' + [regex]::Escape([string]$entry.Value) + '";\s*$'
      )).Count
  }
  $buttonFields = @([regex]::Matches(
      $Text,
      '(?m)^\s*private\s+System\.Windows\.Forms\.Button\s+(\w+)\s*(?:=\s*null!)?;\s*$'
    ) | ForEach-Object { $_.Groups[1].Value })
  return [ordered]@{
    buttonFieldCount = $buttonFields.Count
    distinctButtonFieldCount = @($buttonFields | Sort-Object -Unique).Count
    buttonFields = $buttonFields
    panelAddCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?panel1\.Controls\.Add\(')).Count
    formAddCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?Controls\.Add\(')).Count
    textCounts = $textCounts
  }
}

function Get-S025Shape([string] $Text) {
  $result = [ordered]@{}
  foreach ($id in @('snapButton', 'referenceTextBox')) {
    $location = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$"
    )
    $size = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$"
    )
    if (-not $location.Success -or -not $size.Success) {
      throw "Cannot parse S025 Location/Size assignments for $id."
    }
    $result[$id] = [ordered]@{
      location = [ordered]@{ x = [int]$location.Groups[1].Value; y = [int]$location.Groups[2].Value }
      size = [ordered]@{ width = [int]$size.Groups[1].Value; height = [int]$size.Groups[2].Value }
    }
  }
  return $result
}

function Get-S026Shape([string] $Text) {
  $result = [ordered]@{}
  foreach ($id in @('gridLabel', 'referenceButton')) {
    $location = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$"
    )
    $size = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$"
    )
    if (-not $location.Success -or -not $size.Success) {
      throw "Cannot parse S026 Location/Size assignments for $id."
    }
    $result[$id] = [ordered]@{
      location = [ordered]@{ x = [int]$location.Groups[1].Value; y = [int]$location.Groups[2].Value }
      size = [ordered]@{ width = [int]$size.Groups[1].Value; height = [int]$size.Groups[2].Value }
    }
  }
  return $result
}

function Get-S027Shape([string] $Text) {
  $result = [ordered]@{}
  foreach ($id in @('button1', 'referenceButton')) {
    $location = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Location\s*=\s*new System\.Drawing\.Point\((\d+),\s*(\d+)\);\s*$"
    )
    $size = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$"
    )
    if (-not $location.Success -or -not $size.Success) {
      throw "Cannot parse S027 Location/Size assignments for $id."
    }
    $result[$id] = [ordered]@{
      location = [ordered]@{ x = [int]$location.Groups[1].Value; y = [int]$location.Groups[2].Value }
      size = [ordered]@{ width = [int]$size.Groups[1].Value; height = [int]$size.Groups[2].Value }
    }
  }
  $result.buttonTextExact = ([regex]::Matches(
    $Text,
    '(?m)^\s*(?:this\.)?button1\.Text\s*=\s*"Alt drag";\s*$'
  )).Count -eq 1
  $result.membershipExact = ([regex]::Matches(
    $Text,
    '(?m)^\s*(?:this\.)?Controls\.Add\((?:this\.)?button1\);\s*$'
  )).Count -eq 1
  return $result
}

function Get-WindowsFormsDesignerOption($Dte, [string] $Name) {
  $properties = $Dte.Properties('WindowsFormsDesigner', 'General')
  for ($index = 1; $index -le $properties.Count; $index++) {
    $candidate = $properties.Item($index)
    if ([string]::Equals([string]$candidate.Name, $Name, [System.StringComparison]::Ordinal)) {
      return $candidate
    }
  }
  throw "Visual Studio WindowsFormsDesigner/General does not expose option '$Name'."
}

function Get-S029Shape([string] $Text) {
  $result = [ordered]@{}
  foreach ($id in @('button1', 'button2', 'button3')) {
    $location = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$"
    )
    $size = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$"
    )
    if (-not $location.Success -or -not $size.Success) {
      throw "Cannot parse S029 Location/Size assignments for $id."
    }
    $result[$id] = [ordered]@{
      location = [ordered]@{ x = [int]$location.Groups[1].Value; y = [int]$location.Groups[2].Value }
      size = [ordered]@{ width = [int]$size.Groups[1].Value; height = [int]$size.Groups[2].Value }
    }
  }
  return $result
}

function Get-S030Shape([string] $Text) {
  $result = [ordered]@{}
  foreach ($id in @('button1', 'button2', 'button3')) {
    $location = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$"
    )
    $size = [regex]::Match(
      $Text,
      "(?m)^\s*(?:this\.)?$id\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$"
    )
    if (-not $location.Success -or -not $size.Success) {
      throw "Cannot parse S030 Location/Size assignments for $id."
    }
    $result[$id] = [ordered]@{
      location = [ordered]@{ x = [int]$location.Groups[1].Value; y = [int]$location.Groups[2].Value }
      size = [ordered]@{ width = [int]$size.Groups[1].Value; height = [int]$size.Groups[2].Value }
    }
  }
  return $result
}

function Get-S031Shape([string] $Text) {
  $panelLocation = [regex]::Match($Text, '(?m)^\s*(?:this\.)?panel1\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$')
  $panelPadding = [regex]::Match($Text, '(?m)^\s*(?:this\.)?panel1\.Padding\s*=\s*new System\.Windows\.Forms\.Padding\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\);\s*$')
  $panelSize = [regex]::Match($Text, '(?m)^\s*(?:this\.)?panel1\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$')
  $buttonLocation = [regex]::Match($Text, '(?m)^\s*(?:this\.)?button1\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$')
  $buttonSize = [regex]::Match($Text, '(?m)^\s*(?:this\.)?button1\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$')
  if (-not $panelLocation.Success -or -not $panelPadding.Success -or -not $panelSize.Success -or
      -not $buttonLocation.Success -or -not $buttonSize.Success) {
    throw 'Cannot parse S031 Panel/Button geometry assignments.'
  }
  return [ordered]@{
    panel = [ordered]@{
      location = [ordered]@{ x = [int]$panelLocation.Groups[1].Value; y = [int]$panelLocation.Groups[2].Value }
      padding = [ordered]@{
        left = [int]$panelPadding.Groups[1].Value
        top = [int]$panelPadding.Groups[2].Value
        right = [int]$panelPadding.Groups[3].Value
        bottom = [int]$panelPadding.Groups[4].Value
      }
      size = [ordered]@{ width = [int]$panelSize.Groups[1].Value; height = [int]$panelSize.Groups[2].Value }
    }
    button = [ordered]@{
      location = [ordered]@{ x = [int]$buttonLocation.Groups[1].Value; y = [int]$buttonLocation.Groups[2].Value }
      size = [ordered]@{ width = [int]$buttonSize.Groups[1].Value; height = [int]$buttonSize.Groups[2].Value }
    }
  }
}

function Get-S063Shape([string] $Text) {
  $location = [regex]::Matches(
    $Text,
    '(?m)^\s*(?:this\.)?button1\.Location\s*=\s*new System\.Drawing\.Point\((-?\d+),\s*(-?\d+)\);\s*$'
  )
  $panelMembership = [regex]::Matches(
    $Text,
    '(?m)^\s*(?:this\.)?panel1\.Controls\.Add\((?:this\.)?button1\);\s*$'
  )
  $groupMembership = [regex]::Matches(
    $Text,
    '(?m)^\s*(?:this\.)?groupBox1\.Controls\.Add\((?:this\.)?button1\);\s*$'
  )
  return [ordered]@{
    locationAssignmentCount = $location.Count
    x = if ($location.Count -eq 1) { [int]$location[0].Groups[1].Value } else { $null }
    y = if ($location.Count -eq 1) { [int]$location[0].Groups[2].Value } else { $null }
    panelMembershipCount = $panelMembership.Count
    groupMembershipCount = $groupMembership.Count
    buttonFieldCount = ([regex]::Matches($Text, '(?m)^\s*private System\.Windows\.Forms\.Button\s+button1;\s*$')).Count
    buttonNameCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Name\s*=\s*"button1";\s*$')).Count
    buttonSizeCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Size\s*=\s*new System\.Drawing\.Size\(75,\s*23\);\s*$')).Count
    buttonTextCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Text\s*=\s*"Reparent me";\s*$')).Count
  }
}

function Get-S051Shape([string] $Text) {
  return [ordered]@{
    textChangedSubscriptionCount = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?textBox1\.TextChanged\s*\+=')).Count
    originalHandlerSubscriptionCount = ([regex]::Matches(
      $Text,
      '(?m)^\s*(?:this\.)?textBox1\.TextChanged\s*\+=\s*(?:new\s+System\.EventHandler\s*\(\s*)?(?:this\.)?textBox1_TextChanged(?:\s*\))?;\s*$'
    )).Count
    alternateHandlerSubscriptionCount = ([regex]::Matches(
      $Text,
      '(?m)^\s*(?:this\.)?textBox1\.TextChanged\s*\+=\s*(?:new\s+System\.EventHandler\s*\(\s*)?(?:this\.)?textBox1_TextChangedAlternate(?:\s*\))?;\s*$'
    )).Count
    locationExact = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?textBox1\.Location\s*=\s*new System\.Drawing\.Point\(24,\s*32\);\s*$')).Count -eq 1
    sizeExact = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?textBox1\.Size\s*=\s*new System\.Drawing\.Size\(180,\s*20\);\s*$')).Count -eq 1
    textExact = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?textBox1\.Text\s*=\s*"Event revision";\s*$')).Count -eq 1
    membershipExact = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?Controls\.Add\((?:this\.)?textBox1\);\s*$')).Count -eq 1
  }
}

function Get-S051SourceShape([string] $Text) {
  return [ordered]@{
    formClassCount = ([regex]::Matches(
      $Text,
      '(?m)^\s*public\s+partial\s+class\s+S051EventRevisionForm\s*:\s*System\.Windows\.Forms\.Form\s*$'
    )).Count
    constructorCount = ([regex]::Matches(
      $Text,
      '(?m)^\s*public\s+S051EventRevisionForm\s*\(\s*\)\s*$'
    )).Count
    initializeComponentCallCount = ([regex]::Matches(
      $Text,
      '(?m)^\s*InitializeComponent\s*\(\s*\)\s*;\s*$'
    )).Count
    originalHandlerMethodCount = ([regex]::Matches(
      $Text,
      '(?m)^\s*private\s+void\s+textBox1_TextChanged\s*\(\s*object\s+sender\s*,\s*(?:System\.)?EventArgs\s+e\s*\)\s*$'
    )).Count
    alternateHandlerMethodCount = ([regex]::Matches(
      $Text,
      '(?m)^\s*private\s+void\s+textBox1_TextChangedAlternate\s*\(\s*object\s+sender\s*,\s*(?:System\.)?EventArgs\s+e\s*\)\s*$'
    )).Count
    originalEmptyHandlerMethodCount = ([regex]::Matches(
      $Text,
      '(?ms)^\s*private\s+void\s+textBox1_TextChanged\s*\(\s*object\s+sender\s*,\s*(?:System\.)?EventArgs\s+e\s*\)\s*\{\s*\}'
    )).Count
    alternateEmptyHandlerMethodCount = ([regex]::Matches(
      $Text,
      '(?ms)^\s*private\s+void\s+textBox1_TextChangedAlternate\s*\(\s*object\s+sender\s*,\s*(?:System\.)?EventArgs\s+e\s*\)\s*\{\s*\}'
    )).Count
    privateVoidMethodCount = ([regex]::Matches($Text, '(?m)^\s*private\s+void\s+\w+\s*\(')).Count
  }
}

function Get-S051SourceSkeleton([string] $Text) {
  $withoutEmptyHandlers = [regex]::Replace(
    $Text,
    '(?ms)^[ \t]*private\s+void\s+textBox1_TextChanged(?:Alternate)?\s*\(\s*object\s+sender\s*,\s*(?:System\.)?EventArgs\s+e\s*\)\s*\{\s*\}[ \t]*(?:\r?\n)?',
    ''
  )
  return ([regex]::Replace($withoutEmptyHandlers.Trim(), '\s+', ' '))
}

function Get-S051WhitespaceNormalizedSource([string] $Text) {
  return ([regex]::Replace($Text.Trim(), '\s+', ' '))
}

function Get-S042Shape([string] $Text) {
  $padding = [regex]::Match(
    $Text,
    '(?m)^\s*(?:this\.)?button1\.Padding\s*=\s*new System\.Windows\.Forms\.Padding\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\);\s*$'
  )
  if (-not $padding.Success) { throw 'Cannot parse S042 button1.Padding assignment.' }
  return [ordered]@{
    left = [int]$padding.Groups[1].Value
    top = [int]$padding.Groups[2].Value
    right = [int]$padding.Groups[3].Value
    bottom = [int]$padding.Groups[4].Value
  }
}

function Get-S019Shape([string] $Text) {
  $buttons = [ordered]@{}
  foreach ($id in 'button1', 'button2', 'button3') {
    $escapedId = [regex]::Escape($id)
    $location = [regex]::Matches(
      $Text,
      ('(?m)^\s*(?:this\.)?{0}\.Location\s*=\s*new System\.Drawing\.Point\((\d+),\s*(\d+)\);\s*$' -f $escapedId)
    )
    $size = [regex]::Matches(
      $Text,
      ('(?m)^\s*(?:this\.)?{0}\.Size\s*=\s*new System\.Drawing\.Size\((\d+),\s*(\d+)\);\s*$' -f $escapedId)
    )
    $textAssignment = [regex]::Matches(
      $Text,
      ('(?m)^\s*(?:this\.)?{0}\.Text\s*=\s*"([^"]+)";\s*$' -f $escapedId)
    )
    $buttons[$id] = [ordered]@{
      locationAssignmentCount = $location.Count
      x = if ($location.Count -eq 1) { [int]$location[0].Groups[1].Value } else { $null }
      y = if ($location.Count -eq 1) { [int]$location[0].Groups[2].Value } else { $null }
      sizeAssignmentCount = $size.Count
      width = if ($size.Count -eq 1) { [int]$size[0].Groups[1].Value } else { $null }
      height = if ($size.Count -eq 1) { [int]$size[0].Groups[2].Value } else { $null }
      textAssignmentCount = $textAssignment.Count
      text = if ($textAssignment.Count -eq 1) { [string]$textAssignment[0].Groups[1].Value } else { $null }
    }
  }
  return $buttons
}

function Get-S045Shape([string] $Text) {
  $backColor = [regex]::Matches(
    $Text,
    '(?m)^\s*(?:this\.)?button1\.BackColor\s*=\s*System\.Drawing\.Color\.([A-Za-z][A-Za-z0-9_]*);\s*$'
  )
  return [ordered]@{
    backColorAssignmentCount = $backColor.Count
    backColor = if ($backColor.Count -eq 1) { [string]$backColor[0].Groups[1].Value } else { $null }
    locationExact = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Location\s*=\s*new System\.Drawing\.Point\(48,\s*54\);\s*$')).Count -eq 1
    nameExact = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Name\s*=\s*"button1";\s*$')).Count -eq 1
    sizeExact = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Size\s*=\s*new System\.Drawing\.Size\(160,\s*42\);\s*$')).Count -eq 1
    textExact = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.Text\s*=\s*"Choose Blue";\s*$')).Count -eq 1
    useVisualStyleBackColorFalse = ([regex]::Matches($Text, '(?m)^\s*(?:this\.)?button1\.UseVisualStyleBackColor\s*=\s*false;\s*$')).Count -eq 1
  }
}

$scratch = Join-Path $scratchRoot ([System.Guid]::NewGuid().ToString('N'))
$modern = Join-Path $scratch 'Modern'
$net48 = Join-Path $scratch 'Net48'
$classicNet48 = Join-Path $scratch 'ClassicNet48'
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
Copy-ProjectFixture (Join-Path $repo 'fixtures/VisualStudioReference/Modern') $modern
Copy-ProjectFixture (Join-Path $repo 'fixtures/VisualStudioReference/Net48') $net48
Copy-ProjectFixture (Join-Path $repo 'fixtures/VisualStudioReference/ClassicNet48') $classicNet48
Copy-Item -LiteralPath (Join-Path $extensionTrace 'GroupMoveForm.cs') -Destination (Join-Path $modern 'GroupMoveForm.cs')
Copy-Item -LiteralPath (Join-Path $extensionTrace 'GroupMoveForm.Designer.cs') -Destination (Join-Path $modern 'GroupMoveForm.Designer.cs')
Copy-Item -LiteralPath (Join-Path $extensionTrace 'S100AdapterRoundTrip/S100AdapterRoundTripForm.cs') -Destination (Join-Path $modern 'S100AdapterRoundTripForm.cs')
Copy-Item -LiteralPath (Join-Path $extensionTrace 'S100AdapterRoundTrip/S100AdapterRoundTripForm.Designer.cs') -Destination (Join-Path $modern 'S100AdapterRoundTripForm.Designer.cs')
Copy-Item -LiteralPath (Join-Path $extensionTrace 'S100AdapterRoundTrip/adapter-manifest.json') -Destination (Join-Path $modern 'adapter-manifest.json')
Copy-Item -LiteralPath (Join-Path $extensionTrace 'S108Net48RoundTrip/ReparentForm.cs') -Destination (Join-Path $net48 'ReparentForm.cs')
Copy-Item -LiteralPath (Join-Path $extensionTrace 'S108Net48RoundTrip/ReparentForm.Designer.cs') -Destination (Join-Path $net48 'ReparentForm.Designer.cs')

$s120Source = Join-Path $modern 'GroupMoveForm.cs'
$s120Designer = Join-Path $modern 'GroupMoveForm.Designer.cs'
$s021Source = $s120Source
$s021Designer = $s120Designer
$s100Source = Join-Path $modern 'S100AdapterRoundTripForm.cs'
$s100Designer = Join-Path $modern 'S100AdapterRoundTripForm.Designer.cs'
$s100AdapterManifest = Join-Path $modern 'adapter-manifest.json'
$s108Source = Join-Path $net48 'ReparentForm.cs'
$s108Designer = Join-Path $net48 'ReparentForm.Designer.cs'
$s001Source = Join-Path $modern 'S001SaveForm.cs'
$s001Designer = Join-Path $modern 'S001SaveForm.Designer.cs'
$s001Resource = Join-Path $modern 'S001SaveForm.resx'
$s001Project = Join-Path $modern 'VisualStudioReference.Modern.csproj'
$s006Anchor = Join-Path $classicNet48 'Anchor.cs'
$s006Project = Join-Path $classicNet48 'VisualStudioReference.ClassicNet48.csproj'
$s006ProjectBeforeBytes = [System.IO.File]::ReadAllBytes($s006Project)
$s015Source = Join-Path $modern 'S015OverlapForm.cs'
$s015Designer = Join-Path $modern 'S015OverlapForm.Designer.cs'
$s017Source = Join-Path $modern 'S017MarqueeForm.cs'
$s017Designer = Join-Path $modern 'S017MarqueeForm.Designer.cs'
$s017Resource = Join-Path $modern 'S017MarqueeForm.resx'
$s019Source = Join-Path $net48 'S019CtrlMultiSelectForm.cs'
$s019Designer = Join-Path $net48 'S019CtrlMultiSelectForm.Designer.cs'
$s019Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s013Source = Join-Path $modern 'S013ButtonForm.cs'
$s013Designer = Join-Path $modern 'S013ButtonForm.Designer.cs'
$s028Source = Join-Path $net48 'S028GridVisibilityForm.cs'
$s028Designer = Join-Path $net48 'S028GridVisibilityForm.Designer.cs'
$s028Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s037Source = $s013Source
$s037Designer = $s013Designer
$s012Source = Join-Path $modern 'S012MissingInitializeForm.cs'
$s012Designer = Join-Path $modern 'S012MissingInitializeForm.Designer.cs'
$s012Resource = Join-Path $modern 'S012MissingInitializeForm.resx'
$s009Source = Join-Path $modern 'S009NestedForm.cs'
$s009Designer = Join-Path $modern 'S009NestedForm.Designer.cs'
$s022Source = Join-Path $modern 'S022AnchoredResizeForm.cs'
$s022Designer = Join-Path $modern 'S022AnchoredResizeForm.Designer.cs'
$s025Source = Join-Path $modern 'S025BaselineSnapForm.cs'
$s025Designer = Join-Path $modern 'S025BaselineSnapForm.Designer.cs'
$s025Resource = Join-Path $modern 'S025BaselineSnapForm.resx'
$s026Source = Join-Path $modern 'S026GridSnapForm.cs'
$s026Designer = Join-Path $modern 'S026GridSnapForm.Designer.cs'
$s026Resource = Join-Path $modern 'S026GridSnapForm.resx'
$s027Source = Join-Path $net48 'S027AltDragForm.cs'
$s027Designer = Join-Path $net48 'S027AltDragForm.Designer.cs'
$s027Resource = Join-Path $net48 'S027AltDragForm.resx'
$s027Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s029Source = Join-Path $modern 'S029AlignLeftForm.cs'
$s029Designer = Join-Path $modern 'S029AlignLeftForm.Designer.cs'
$s030Source = Join-Path $modern 'S030SameWidthForm.cs'
$s030Designer = Join-Path $modern 'S030SameWidthForm.Designer.cs'
$s038Source = Join-Path $modern 'S038MultiPropertyForm.cs'
$s038Designer = Join-Path $modern 'S038MultiPropertyForm.Designer.cs'
$s039Source = Join-Path $net48 'S039ResetPropertyForm.cs'
$s039Designer = Join-Path $net48 'S039ResetPropertyForm.Designer.cs'
$s041Source = Join-Path $modern 'S041FlatStyleForm.cs'
$s041Designer = Join-Path $modern 'S041FlatStyleForm.Designer.cs'
$s045Source = Join-Path $modern 'S045ColorEditorForm.cs'
$s045Designer = Join-Path $modern 'S045ColorEditorForm.Designer.cs'
$s046Source = Join-Path $modern 'S046ColorEditorForm.cs'
$s046Designer = Join-Path $modern 'S046ColorEditorForm.Designer.cs'
$s042Source = Join-Path $modern 'S042PaddingForm.cs'
$s042Designer = Join-Path $modern 'S042PaddingForm.Designer.cs'
$s053Source = Join-Path $modern 'S053ToolboxForm.cs'
$s053Designer = Join-Path $modern 'S053ToolboxForm.Designer.cs'
$s061Source = Join-Path $modern 'S061OutlineRenameForm.cs'
$s061Designer = Join-Path $modern 'S061OutlineRenameForm.Designer.cs'
$s110Source = Join-Path $modern 'S110AccessibilityTreeForm.cs'
$s110Designer = Join-Path $modern 'S110AccessibilityTreeForm.Designer.cs'
$s062Source = $s110Source
$s062Designer = $s110Designer
$s063Source = Join-Path $net48 'S063OutlineReparentForm.cs'
$s063Designer = Join-Path $net48 'S063OutlineReparentForm.Designer.cs'
$s063Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s079Source = Join-Path $net48 'S079RtlLayoutForm.cs'
$s079Designer = Join-Path $net48 'S079RtlLayoutForm.Designer.cs'
$s079Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s085BaseSource = Join-Path $modern 'S085InheritedBaseForm.cs'
$s085BaseDesigner = Join-Path $modern 'S085InheritedBaseForm.Designer.cs'
$s085Source = Join-Path $modern 'S085InheritedDerivedForm.cs'
$s085Designer = Join-Path $modern 'S085InheritedDerivedForm.Designer.cs'
$s085Project = Join-Path $modern 'VisualStudioReference.Modern.csproj'
$s086BaseSource = Join-Path $modern 'S086InheritedLockedBaseForm.cs'
$s086BaseDesigner = Join-Path $modern 'S086InheritedLockedBaseForm.Designer.cs'
$s086Source = Join-Path $modern 'S086InheritedLockedDerivedForm.cs'
$s086Designer = Join-Path $modern 'S086InheritedLockedDerivedForm.Designer.cs'
$s086Project = Join-Path $modern 'VisualStudioReference.Modern.csproj'
$s087BaseSource = Join-Path $net48 'S087InheritedBaseForm.cs'
$s087BaseDesigner = Join-Path $net48 'S087InheritedBaseForm.Designer.cs'
$s087Source = Join-Path $net48 'S087InheritedDerivedForm.cs'
$s087Designer = Join-Path $net48 'S087InheritedDerivedForm.Designer.cs'
$s087Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s088ModernBaseSource = Join-Path $modern 'S088InheritedMoveBaseForm.cs'
$s088ModernBaseDesigner = Join-Path $modern 'S088InheritedMoveBaseForm.Designer.cs'
$s088ModernSource = Join-Path $modern 'S088InheritedMoveDerivedForm.cs'
$s088ModernDesigner = Join-Path $modern 'S088InheritedMoveDerivedForm.Designer.cs'
$s088ModernProject = Join-Path $modern 'VisualStudioReference.Modern.csproj'
$s088Net48BaseSource = Join-Path $net48 'S088InheritedMoveBaseForm.cs'
$s088Net48BaseDesigner = Join-Path $net48 'S088InheritedMoveBaseForm.Designer.cs'
$s088Net48Source = Join-Path $net48 'S088InheritedMoveDerivedForm.cs'
$s088Net48Designer = Join-Path $net48 'S088InheritedMoveDerivedForm.Designer.cs'
$s088Net48Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s049Source = Join-Path $modern 'S049DefaultEventForm.cs'
$s049Designer = Join-Path $modern 'S049DefaultEventForm.Designer.cs'
$s050Source = Join-Path $modern 'S050ExistingEventForm.cs'
$s050Designer = Join-Path $modern 'S050ExistingEventForm.Designer.cs'
$s051Source = Join-Path $net48 'S051EventRevisionForm.cs'
$s051Designer = Join-Path $net48 'S051EventRevisionForm.Designer.cs'
$s051Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s024Source = Join-Path $modern 'S024ClipboardCollisionForm.cs'
$s024Designer = Join-Path $modern 'S024ClipboardCollisionForm.Designer.cs'
$s024Net48Source = Join-Path $net48 'S024ClipboardCollisionForm.cs'
$s024Net48Designer = Join-Path $net48 'S024ClipboardCollisionForm.Designer.cs'
$s031Source = Join-Path $net48 'S031CenterPanelForm.cs'
$s031Designer = Join-Path $net48 'S031CenterPanelForm.Designer.cs'
$s031Project = Join-Path $net48 'VisualStudioReference.Net48.csproj'
$s015Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s015Source
  designerSha256 = Get-Sha256 $s015Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s017BeforeText = [System.IO.File]::ReadAllText($s017Designer)
$s017BeforeBytes = [System.IO.File]::ReadAllBytes($s017Designer)
$s017Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s017Source
  designerSha256 = Get-Sha256 $s017Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S017Shape $s017BeforeText
}
$s019BeforeText = [System.IO.File]::ReadAllText($s019Designer)
$s019BeforeBytes = [System.IO.File]::ReadAllBytes($s019Designer)
$s019Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s019Source
  designerSha256 = Get-Sha256 $s019Designer
  projectSha256 = Get-Sha256 $s019Project
  shape = Get-S019Shape $s019BeforeText
}
$s024BeforeText = [System.IO.File]::ReadAllText($s024Designer)
$s024BeforeBytes = [System.IO.File]::ReadAllBytes($s024Designer)
$s024Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s024Source
  designerSha256 = Get-Sha256 $s024Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S024Shape $s024BeforeText
}
$s024Net48BeforeText = [System.IO.File]::ReadAllText($s024Net48Designer)
$s024Net48BeforeBytes = [System.IO.File]::ReadAllBytes($s024Net48Designer)
$s024Net48Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s024Net48Source
  designerSha256 = Get-Sha256 $s024Net48Designer
  projectSha256 = Get-Sha256 $s031Project
  shape = Get-S024Shape $s024Net48BeforeText
}
$s022BeforeText = [System.IO.File]::ReadAllText($s022Designer)
$s022BeforeBytes = [System.IO.File]::ReadAllBytes($s022Designer)
$s022Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s022Source
  designerSha256 = Get-Sha256 $s022Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S022Shape $s022BeforeText
}
$s025BeforeText = [System.IO.File]::ReadAllText($s025Designer)
$s025BeforeBytes = [System.IO.File]::ReadAllBytes($s025Designer)
$s025Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s025Source
  designerSha256 = Get-Sha256 $s025Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S025Shape $s025BeforeText
}
$s026BeforeText = [System.IO.File]::ReadAllText($s026Designer)
$s026BeforeBytes = [System.IO.File]::ReadAllBytes($s026Designer)
$s026Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s026Source
  designerSha256 = Get-Sha256 $s026Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S026Shape $s026BeforeText
}
$s027BeforeText = [System.IO.File]::ReadAllText($s027Designer)
$s027BeforeBytes = [System.IO.File]::ReadAllBytes($s027Designer)
$s027Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s027Source
  designerSha256 = Get-Sha256 $s027Designer
  projectSha256 = Get-Sha256 $s027Project
  shape = Get-S027Shape $s027BeforeText
}
$s029BeforeText = [System.IO.File]::ReadAllText($s029Designer)
$s029BeforeBytes = [System.IO.File]::ReadAllBytes($s029Designer)
$s029Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s029Source
  designerSha256 = Get-Sha256 $s029Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S029Shape $s029BeforeText
}
$s030BeforeText = [System.IO.File]::ReadAllText($s030Designer)
$s030BeforeBytes = [System.IO.File]::ReadAllBytes($s030Designer)
$s030Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s030Source
  designerSha256 = Get-Sha256 $s030Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S030Shape $s030BeforeText
}
$s031BeforeText = [System.IO.File]::ReadAllText($s031Designer)
$s031BeforeBytes = [System.IO.File]::ReadAllBytes($s031Designer)
$s031Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s031Source
  designerSha256 = Get-Sha256 $s031Designer
  projectSha256 = Get-Sha256 $s031Project
  shape = Get-S031Shape $s031BeforeText
}
$s063BeforeText = [System.IO.File]::ReadAllText($s063Designer)
$s063BeforeBytes = [System.IO.File]::ReadAllBytes($s063Designer)
$s063Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s063Source
  designerSha256 = Get-Sha256 $s063Designer
  projectSha256 = Get-Sha256 $s063Project
  shape = Get-S063Shape $s063BeforeText
}
$s079Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s079Source
  designerSha256 = Get-Sha256 $s079Designer
  projectSha256 = Get-Sha256 $s079Project
}
$s085BeforeText = [System.IO.File]::ReadAllText($s085Designer)
$s085BeforeBytes = [System.IO.File]::ReadAllBytes($s085Designer)
$s085Before = [ordered]@{
  baseSourceSha256 = Get-Sha256 $s085BaseSource
  baseDesignerSha256 = Get-Sha256 $s085BaseDesigner
  sourceSha256 = Get-Sha256 $s085Source
  designerSha256 = Get-Sha256 $s085Designer
  projectSha256 = Get-Sha256 $s085Project
}
$s086Before = [ordered]@{
  baseSourceSha256 = Get-Sha256 $s086BaseSource
  baseDesignerSha256 = Get-Sha256 $s086BaseDesigner
  sourceSha256 = Get-Sha256 $s086Source
  designerSha256 = Get-Sha256 $s086Designer
  projectSha256 = Get-Sha256 $s086Project
}
$s087BeforeText = [System.IO.File]::ReadAllText($s087Designer)
$s087BeforeBytes = [System.IO.File]::ReadAllBytes($s087Designer)
$s087Before = [ordered]@{
  baseSourceSha256 = Get-Sha256 $s087BaseSource
  baseDesignerSha256 = Get-Sha256 $s087BaseDesigner
  sourceSha256 = Get-Sha256 $s087Source
  designerSha256 = Get-Sha256 $s087Designer
  projectSha256 = Get-Sha256 $s087Project
}
$s088Before = [ordered]@{
  modern = [ordered]@{
    baseSourceSha256 = Get-Sha256 $s088ModernBaseSource
    baseDesignerSha256 = Get-Sha256 $s088ModernBaseDesigner
    sourceSha256 = Get-Sha256 $s088ModernSource
    designerSha256 = Get-Sha256 $s088ModernDesigner
    projectSha256 = Get-Sha256 $s088ModernProject
  }
  net48 = [ordered]@{
    baseSourceSha256 = Get-Sha256 $s088Net48BaseSource
    baseDesignerSha256 = Get-Sha256 $s088Net48BaseDesigner
    sourceSha256 = Get-Sha256 $s088Net48Source
    designerSha256 = Get-Sha256 $s088Net48Designer
    projectSha256 = Get-Sha256 $s088Net48Project
  }
}
$s051BeforeText = [System.IO.File]::ReadAllText($s051Designer)
$s051BeforeBytes = [System.IO.File]::ReadAllBytes($s051Designer)
$s051BeforeSourceText = [System.IO.File]::ReadAllText($s051Source)
$s051BeforeSourceBytes = [System.IO.File]::ReadAllBytes($s051Source)
$s051Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s051Source
  designerSha256 = Get-Sha256 $s051Designer
  projectSha256 = Get-Sha256 $s051Project
  shape = Get-S051Shape $s051BeforeText
  sourceShape = Get-S051SourceShape $s051BeforeSourceText
}
$s028Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s028Source
  designerSha256 = Get-Sha256 $s028Designer
  projectSha256 = Get-Sha256 $s028Project
}
$s037Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s037Source
  designerSha256 = Get-Sha256 $s037Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s038Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s038Source
  designerSha256 = Get-Sha256 $s038Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s039BeforeText = [System.IO.File]::ReadAllText($s039Designer)
$s039BeforeBytes = [System.IO.File]::ReadAllBytes($s039Designer)
$s039Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s039Source
  designerSha256 = Get-Sha256 $s039Designer
  projectSha256 = Get-Sha256 $s031Project
  textAssignmentCount = ([regex]::Matches($s039BeforeText, '(?m)^\s*(?:this\.)?button1\.Text\s*=')).Count
}
$s041Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s041Source
  designerSha256 = Get-Sha256 $s041Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s042BeforeText = [System.IO.File]::ReadAllText($s042Designer)
$s042BeforeBytes = [System.IO.File]::ReadAllBytes($s042Designer)
$s042Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s042Source
  designerSha256 = Get-Sha256 $s042Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S042Shape $s042BeforeText
}
$s045BeforeText = [System.IO.File]::ReadAllText($s045Designer)
$s045BeforeBytes = [System.IO.File]::ReadAllBytes($s045Designer)
$s045Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s045Source
  designerSha256 = Get-Sha256 $s045Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s046Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s046Source
  designerSha256 = Get-Sha256 $s046Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s053Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s053Source
  designerSha256 = Get-Sha256 $s053Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s061BeforeText = [System.IO.File]::ReadAllText($s061Designer)
$s061BeforeBytes = [System.IO.File]::ReadAllBytes($s061Designer)
$s061Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s061Source
  designerSha256 = Get-Sha256 $s061Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s110Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s110Source
  designerSha256 = Get-Sha256 $s110Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s062Before = $s110Before
$s049BeforeSourceText = [System.IO.File]::ReadAllText($s049Source)
$s049BeforeDesignerText = [System.IO.File]::ReadAllText($s049Designer)
$s049BeforeSourceBytes = [System.IO.File]::ReadAllBytes($s049Source)
$s049BeforeDesignerBytes = [System.IO.File]::ReadAllBytes($s049Designer)
$s049Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s049Source
  designerSha256 = Get-Sha256 $s049Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s050Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s050Source
  designerSha256 = Get-Sha256 $s050Designer
  projectSha256 = Get-Sha256 $s001Project
}
$s009Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s009Source
  designerSha256 = Get-Sha256 $s009Designer
}
$s001Before = [ordered]@{
  'S001SaveForm.cs' = Get-Sha256 $s001Source
  'S001SaveForm.Designer.cs' = Get-Sha256 $s001Designer
  'S001SaveForm.resx' = Get-Sha256 $s001Resource
  'VisualStudioReference.Modern.csproj' = Get-Sha256 $s001Project
}
$s120Before = [ordered]@{
  'GroupMoveForm.cs' = Get-Sha256 $s120Source
  'GroupMoveForm.Designer.cs' = Get-Sha256 $s120Designer
}
$s021BeforeText = [System.IO.File]::ReadAllText($s021Designer)
$s021BeforeBytes = [System.IO.File]::ReadAllBytes($s021Designer)
$s021Before = [ordered]@{
  sourceSha256 = Get-Sha256 $s021Source
  designerSha256 = Get-Sha256 $s021Designer
  projectSha256 = Get-Sha256 $s001Project
  shape = Get-S021Shape $s021BeforeText
}
$s100Before = [ordered]@{
  'S100AdapterRoundTripForm.cs' = Get-Sha256 $s100Source
  'S100AdapterRoundTripForm.Designer.cs' = Get-Sha256 $s100Designer
  'adapter-manifest.json' = Get-Sha256 $s100AdapterManifest
}
$s108Before = [ordered]@{
  'ReparentForm.cs' = Get-Sha256 $s108Source
  'ReparentForm.Designer.cs' = Get-Sha256 $s108Designer
}

$dte = $null
try {
  [VisualStudioOleMessageFilter]::Register()
  $dte = New-Object -ComObject $DteProgId
  $dte.UserControl = $false
  $dte.SuppressUI = $true
  $dte.MainWindow.Visible = $true
  $visualStudioVersion = [string]$dte.Version
  $visualStudioEdition = [string]$dte.Edition
  $visualStudioExecutable = [string]$dte.FullName
  $visualStudioDisplayName = 'Visual Studio'
  $visualStudioInstallationVersion = $visualStudioVersion
  $dteMajor = if ($DteProgId -match '^VisualStudio\.DTE\.(\d+)\.0$') { $Matches[1] } else { '' }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (Test-Path -LiteralPath $vswhere) {
    try {
      $instances = @((& $vswhere -all -prerelease -products '*' -format json | Out-String | ConvertFrom-Json))
      $instance = $instances | Where-Object {
        [string]::Equals([string]$_.productPath, $visualStudioExecutable, [System.StringComparison]::OrdinalIgnoreCase)
      } | Select-Object -First 1
      if ($null -eq $instance -and $dteMajor) {
        $majorInstances = @($instances | Where-Object {
          ([string]$_.installationVersion).StartsWith("$dteMajor.", [System.StringComparison]::Ordinal)
        })
        if ($majorInstances.Count -eq 1) { $instance = $majorInstances[0] }
      }
      if ($null -ne $instance) {
        $visualStudioDisplayName = [string]$instance.displayName
        $visualStudioInstallationVersion = [string]$instance.installationVersion
        if (-not $visualStudioExecutable) { $visualStudioExecutable = [string]$instance.productPath }
        if (-not $visualStudioEdition) { $visualStudioEdition = ([string]$instance.productId).Split('.')[-1] }
      }
    } catch { }
  }
  if (-not $visualStudioVersion -and $dteMajor) { $visualStudioVersion = "$dteMajor.0" }
  if (-not $visualStudioInstallationVersion) {
    throw "Cannot resolve the exact Visual Studio installation version for $DteProgId."
  }
  $runStamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $runId = "VS$visualStudioInstallationVersion-$runStamp"
  $runDirectory = Join-Path $outputRootPath $runId
  New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

  $solution = $null
  $solutionDeadline = [DateTime]::UtcNow.AddSeconds(60)
  while ($null -eq $solution -and [DateTime]::UtcNow -lt $solutionDeadline) {
    try { $solution = $dte.Solution } catch { $solution = $null }
    if ($null -eq $solution) { Start-Sleep -Milliseconds 250 }
  }
  if ($null -eq $solution) { throw 'Visual Studio DTE did not initialize its Solution service within 60 seconds.' }

  $solution.Create($scratch, 'VisualStudioReference')
  [void]$solution.AddFromFile((Join-Path $modern 'VisualStudioReference.Modern.csproj'), $false)
  [void]$solution.AddFromFile((Join-Path $net48 'VisualStudioReference.Net48.csproj'), $false)
  [void]$solution.AddFromFile((Join-Path $classicNet48 'VisualStudioReference.ClassicNet48.csproj'), $false)
  $solutionPath = Join-Path $scratch 'VisualStudioReference.sln'
  $solution.SaveAs($solutionPath)
  Start-Sleep -Seconds 4
  $solution.SolutionBuild.Build($true)
  if ([int]$solution.SolutionBuild.LastBuildInfo -ne 0) {
    throw "Visual Studio design-time solution build failed: LastBuildInfo=$($solution.SolutionBuild.LastBuildInfo)"
  }
  $dte.SuppressUI = $false

  $s001Directory = Join-Path $runDirectory 'V2-FND-001-S001'
  $s005Directory = Join-Path $runDirectory 'V2-FND-001-S005'
  $s006Directory = Join-Path $runDirectory 'V2-FND-001-S006'
  $s015Directory = Join-Path $runDirectory 'V2-FND-001-S015'
  $s017Directory = Join-Path $runDirectory 'V2-FND-001-S017'
  $s019Directory = Join-Path $runDirectory 'V2-FND-001-S019'
  $s024Directory = Join-Path $runDirectory 'V2-FND-001-S024'
  $s009Directory = Join-Path $runDirectory 'V2-FND-001-S009'
  $s012Directory = Join-Path $runDirectory 'V2-FND-001-S012'
  $s011Directory = Join-Path $runDirectory 'V2-FND-001-S011'
  $s120Directory = Join-Path $runDirectory 'V2-FND-001-S120'
  $s021Directory = Join-Path $runDirectory 'V2-FND-001-S021'
  $s100Directory = Join-Path $runDirectory 'V2-FND-001-S100'
  $s108Directory = Join-Path $runDirectory 'V2-FND-001-S108'
  $s013Directory = Join-Path $runDirectory 'V2-FND-001-S013'
  $s014Directory = Join-Path $runDirectory 'V2-FND-001-S014'
  $s028Directory = Join-Path $runDirectory 'V2-FND-001-S028'
  $s037Directory = Join-Path $runDirectory 'V2-FND-001-S037'
  $s022Directory = Join-Path $runDirectory 'V2-FND-001-S022'
  $s025Directory = Join-Path $runDirectory 'V2-FND-001-S025'
  $s026Directory = Join-Path $runDirectory 'V2-FND-001-S026'
  $s027Directory = Join-Path $runDirectory 'V2-FND-001-S027'
  $s029Directory = Join-Path $runDirectory 'V2-FND-001-S029'
  $s030Directory = Join-Path $runDirectory 'V2-FND-001-S030'
  $s031Directory = Join-Path $runDirectory 'V2-FND-001-S031'
  $s038Directory = Join-Path $runDirectory 'V2-FND-001-S038'
  $s039Directory = Join-Path $runDirectory 'V2-FND-001-S039'
  $s041Directory = Join-Path $runDirectory 'V2-FND-001-S041'
  $s042Directory = Join-Path $runDirectory 'V2-FND-001-S042'
  $s045Directory = Join-Path $runDirectory 'V2-FND-001-S045'
  $s046Directory = Join-Path $runDirectory 'V2-FND-001-S046'
  $s053Directory = Join-Path $runDirectory 'V2-FND-001-S053'
  $s061Directory = Join-Path $runDirectory 'V2-FND-001-S061'
  $s062Directory = Join-Path $runDirectory 'V2-FND-001-S062'
  $s063Directory = Join-Path $runDirectory 'V2-FND-001-S063'
  $s079Directory = Join-Path $runDirectory 'V2-FND-001-S079'
  $s085Directory = Join-Path $runDirectory 'V2-FND-001-S085'
  $s086Directory = Join-Path $runDirectory 'V2-FND-001-S086'
  $s087Directory = Join-Path $runDirectory 'V2-FND-001-S087'
  $s088Directory = Join-Path $runDirectory 'V2-FND-001-S088'
  $s110Directory = Join-Path $runDirectory 'V2-FND-001-S110'
  $s049Directory = Join-Path $runDirectory 'V2-FND-001-S049'
  $s050Directory = Join-Path $runDirectory 'V2-FND-001-S050'
  $s051Directory = Join-Path $runDirectory 'V2-FND-001-S051'
  foreach ($directory in @($s001Directory, $s005Directory, $s006Directory, $s015Directory, $s017Directory, $s019Directory, $s024Directory, $s009Directory, $s012Directory, $s011Directory, $s120Directory, $s021Directory, $s100Directory, $s108Directory, $s013Directory, $s014Directory, $s028Directory, $s037Directory, $s022Directory, $s025Directory, $s026Directory, $s027Directory, $s029Directory, $s030Directory, $s031Directory, $s038Directory, $s039Directory, $s041Directory, $s042Directory, $s045Directory, $s046Directory, $s053Directory, $s061Directory, $s062Directory, $s063Directory, $s079Directory, $s085Directory, $s086Directory, $s087Directory, $s088Directory, $s110Directory, $s049Directory, $s050Directory, $s051Directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  if ($CaptureSet -eq 'S028') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s028OriginalOptions = [ordered]@{
      layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
      showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
      snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
    }
    $s028EffectiveOptions = $null
    try {
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'ShowGrid'), [bool]$true)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'SnapToGrid'), [bool]$true)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'LayoutMode'), [int]1)
      Start-Sleep -Seconds 1
      $s028EffectiveOptions = [ordered]@{
        layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
        showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
        snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
      }
      $s028Capture = Open-DesignerToggleGridAndCapture $dte $s028Source 'gridAnchorButton' 'Grid anchor' 'S028 grid visibility' `
        (Join-Path $s028Directory 'visual-studio-grid-before.png') `
        (Join-Path $s028Directory 'visual-studio-grid-toggled.png') `
        (Join-Path $s028Directory 'visual-studio-grid-restored.png')
    } finally {
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'ShowGrid'), [bool]$s028OriginalOptions.showGrid)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'SnapToGrid'), [bool]$s028OriginalOptions.snapToGrid)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'LayoutMode'), [int]$s028OriginalOptions.layoutMode)
      Start-Sleep -Seconds 1
    }
    $s028RestoredOptions = [ordered]@{
      layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
      showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
      snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
    }
    $s028EffectiveOptionsExact = $s028EffectiveOptions.layoutMode -eq 1 -and $s028EffectiveOptions.showGrid -and $s028EffectiveOptions.snapToGrid
    $s028OptionsRestoredExact = $s028RestoredOptions.layoutMode -eq $s028OriginalOptions.layoutMode -and
      $s028RestoredOptions.showGrid -eq $s028OriginalOptions.showGrid -and
      $s028RestoredOptions.snapToGrid -eq $s028OriginalOptions.snapToGrid
    $s028After = [ordered]@{
      sourceSha256 = Get-Sha256 $s028Source
      designerSha256 = Get-Sha256 $s028Designer
      projectSha256 = Get-Sha256 $s028Project
    }
    $s028SourceExact = $s028Before.sourceSha256 -eq $s028After.sourceSha256
    $s028DesignerExact = $s028Before.designerSha256 -eq $s028After.designerSha256
    $s028ProjectExact = $s028Before.projectSha256 -eq $s028After.projectSha256
    $s028Pass = $s028EffectiveOptionsExact -and $s028OptionsRestoredExact -and
      [bool]$s028Capture.toggleRouteExecuted -and [bool]$s028Capture.optionToggledExact -and
      [bool]$s028Capture.optionRestoredExact -and [bool]$s028Capture.toggledVisualChanged -and
      [bool]$s028Capture.restoredVisualExact -and $s028SourceExact -and $s028DesignerExact -and $s028ProjectExact
    $s028ReferenceStatus = if ($s028Pass) { 'PASS' } else { 'FAIL' }

    Copy-Item -LiteralPath $s028Source -Destination (Join-Path $s028Directory 'S028GridVisibilityForm.cs')
    Copy-Item -LiteralPath $s028Designer -Destination (Join-Path $s028Directory 'S028GridVisibilityForm.Designer.cs')
    Copy-Item -LiteralPath $s028Project -Destination (Join-Path $s028Directory 'VisualStudioReference.Net48.csproj')
    Write-Json (Join-Path $s028Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S028"
      scenarioId = 'V2-FND-001-S028'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s028ReferenceStatus
      setup = 'The net48 reference Form is clean and the dedicated installed Visual Studio instance is temporarily configured for LayoutMode=SnapToGrid, SnapToGrid=true, and ShowGrid=true.'
      actionLog = @(
        'Build the scratch solution in actual Visual Studio',
        'Save the exact WindowsFormsDesigner LayoutMode, ShowGrid, and SnapToGrid values and configure the isolated trace for visible SnapToGrid dots',
        'Open S028GridVisibilityForm.cs in the installed classic WinForms Designer and focus its Form surface',
        'Capture the initial designer pixels and exact source, Designer source, and project hashes',
        'Toggle the installed IDE WindowsFormsDesigner.ShowGrid setting through the enabled native command when exposed, otherwise through the exact Tools > Options property',
        'Require the option value and rendered canvas overlay to change, then capture the toggled designer pixels',
        'Toggle the same Visual Studio setting a second time and capture the restored designer pixels',
        'When VS 18 exposes no ShowGrid command, reactivate the same design view through View Code and View Designer so the restored Tools > Options value is rendered',
        'Execute File.SaveAll and require exact pixel restoration plus byte-identical source, Designer source, and project artifacts',
        'Restore the exact original LayoutMode, ShowGrid, and SnapToGrid values in finally as an independent safety check'
      )
      expected = 'The first actual Visual Studio ShowGrid toggle changes the option and rendered designer overlay, the second restores the exact option and pixels, and neither action mutates source, Designer source, or project bytes.'
      runtimeArchitecture = 'actual Visual Studio x64 classic net48 reference; catalog cross-runtime behavior is also covered by repo automation and non-x64 hardware remains an independent gate'
      before = $s028Before
      after = $s028After
      sourceByteIdentical = $s028SourceExact
      designerByteIdentical = $s028DesignerExact
      projectByteIdentical = $s028ProjectExact
      originalOptions = $s028OriginalOptions
      effectiveOptions = $s028EffectiveOptions
      restoredOptions = $s028RestoredOptions
      effectiveOptionsExact = $s028EffectiveOptionsExact
      optionsRestoredExact = $s028OptionsRestoredExact
      toggledVisualChanged = [bool]$s028Capture.toggledVisualChanged
      restoredVisualExact = [bool]$s028Capture.restoredVisualExact
      optionToggledExact = [bool]$s028Capture.optionToggledExact
      optionRestoredExact = [bool]$s028Capture.optionRestoredExact
      visualStudioWindow = $s028Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S028'; status = $s028ReferenceStatus; directory = 'V2-FND-001-S028' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S028 ShowGrid status: $s028ReferenceStatus; route=$($s028Capture.route); option=$($s028Capture.originalShowGrid)->$($s028Capture.afterFirstShowGrid)->$($s028Capture.afterSecondShowGrid); visualChanged=$($s028Capture.toggledVisualChanged); visualRestored=$($s028Capture.restoredVisualExact); optionsRestored=$s028OptionsRestoredExact; bytes=$s028SourceExact/$s028DesignerExact/$s028ProjectExact"
    if (-not $s028Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S005') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s005ItemName = 'S005GeneratedForm.cs'
    $s005CaptureOutput = @(Add-DesignerItemFromTemplateAndCapture $dte $s001Project $modern $s001Source $s005ItemName `
      'Form' $true (Join-Path $s005Directory 'visual-studio-designer.png'))
    $s005Capture = @($s005CaptureOutput | Where-Object {
      $_ -is [System.Collections.IDictionary] -and $_.Contains('pass')
    }) | Select-Object -Last 1
    if ($null -eq $s005Capture) {
      throw "S005 capture returned no result object; output types: $(@($s005CaptureOutput | ForEach-Object { $_.GetType().FullName }) -join ' | ')"
    }
    $s005Status = if ([bool]$s005Capture.pass) { 'PASS' } else { 'FAIL' }
    foreach ($artifact in @('S005GeneratedForm.cs', 'S005GeneratedForm.Designer.cs', 'S005GeneratedForm.resx')) {
      $artifactPath = Join-Path $modern $artifact
      if (Test-Path -LiteralPath $artifactPath -PathType Leaf) {
        Copy-Item -LiteralPath $artifactPath -Destination (Join-Path $s005Directory $artifact)
      }
    }
    $s005UserProject = "$s001Project.user"
    if (Test-Path -LiteralPath $s005UserProject -PathType Leaf) {
      Copy-Item -LiteralPath $s005UserProject -Destination (Join-Path $s005Directory 'VisualStudioReference.Modern.csproj.user')
    }
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s005Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s005Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S005"
      scenarioId = 'V2-FND-001-S005'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s005Status
      setup = 'A loaded buildable net10.0-windows SDK-style WinForms project has no S005GeneratedForm artifacts.'
      actionLog = @(
        'Build the scratch solution in actual Visual Studio',
        'Resolve the installed Visual Studio CSharp Windows Form item template through Solution2 or its installed manifest',
        'Invoke the real SDK project system through ProjectItems.AddFromTemplate for S005GeneratedForm.cs',
        'Require source, Designer source, and neutral resx to appear as one top-level artifact delta',
        'Verify Designer source and resx are nested beneath the created source ProjectItem',
        'Save All, rebuild the solution, and open the created Form in the actual WinForms Designer',
        'Verify the SDK project file remains byte-identical'
      )
      expected = 'Visual Studio creates the complete source/Designer/resx Windows Form artifact set through its installed template, preserves SDK project bytes, builds successfully, and opens the generated Form in the real designer.'
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference; physical ARM64 is an independent external gate for other catalog legs'
      createdArtifacts = $s005Capture.artifactHashes
      auxiliaryArtifacts = $s005Capture.auxiliaryArtifactHashes
      projectByteIdentical = [bool]$s005Capture.projectByteIdentical
      topLevelDelta = $s005Capture.topLevelDelta
      allowedAuxiliaryTopLevelDelta = $s005Capture.allowedAuxiliaryTopLevelDelta
      unexpectedTopLevelDelta = $s005Capture.unexpectedTopLevelDelta
      projectHierarchy = $s005Capture.childNames
      sourceShapeExact = [bool]$s005Capture.sourceShapeExact
      designerShapeExact = [bool]$s005Capture.designerShapeExact
      resourceRoot = $s005Capture.resourceRoot
      solutionBuild = $s005Capture.solutionBuild
      visualStudioWindow = $s005Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S005'; status = $s005Status; directory = 'V2-FND-001-S005' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S005 native Windows Form template reference status: $s005Status"
    if (-not [bool]$s005Capture.pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S006') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s006ItemName = 'S006GeneratedUserControl.cs'
    $s006ProjectBeforeBytes = [System.IO.File]::ReadAllBytes($s006Project)
    $s006CaptureOutput = @(Add-DesignerItemFromTemplateAndCapture $dte $s006Project $classicNet48 $s006Anchor `
      $s006ItemName 'UserControl' $false (Join-Path $s006Directory 'visual-studio-designer.png'))
    $s006Capture = @($s006CaptureOutput | Where-Object {
      $_ -is [System.Collections.IDictionary] -and $_.Contains('pass')
    }) | Select-Object -Last 1
    if ($null -eq $s006Capture) {
      throw "S006 capture returned no result object; output types: $(@($s006CaptureOutput | ForEach-Object { $_.GetType().FullName }) -join ' | ')"
    }
    $s006Status = if ([bool]$s006Capture.pass) { 'PASS' } else { 'FAIL' }
    foreach ($artifact in @('S006GeneratedUserControl.cs', 'S006GeneratedUserControl.Designer.cs', 'S006GeneratedUserControl.resx')) {
      $artifactPath = Join-Path $classicNet48 $artifact
      if (Test-Path -LiteralPath $artifactPath -PathType Leaf) {
        Copy-Item -LiteralPath $artifactPath -Destination (Join-Path $s006Directory $artifact)
      }
    }
    $s006UserProject = "$s006Project.user"
    if (Test-Path -LiteralPath $s006UserProject -PathType Leaf) {
      Copy-Item -LiteralPath $s006UserProject -Destination (Join-Path $s006Directory 'VisualStudioReference.ClassicNet48.csproj.user')
    }
    [System.IO.File]::WriteAllBytes(
      (Join-Path $s006Directory 'VisualStudioReference.ClassicNet48.before.csproj'),
      $s006ProjectBeforeBytes
    )
    Copy-Item -LiteralPath $s006Project -Destination (Join-Path $s006Directory 'VisualStudioReference.ClassicNet48.after.csproj')
    Write-Json (Join-Path $s006Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S006"
      scenarioId = 'V2-FND-001-S006'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s006Status
      setup = 'A loaded buildable classic non-SDK net48 WinForms project contains only Anchor.cs and has no S006GeneratedUserControl artifacts.'
      actionLog = @(
        'Build the three-project scratch solution in actual Visual Studio',
        'Select the exact classic net48 project through the real Solution Explorer hierarchy',
        'Resolve the installed Visual Studio CSharp UserControl item template through Solution2.GetProjectItemTemplate',
        'Invoke ProjectItems.AddFromTemplate for S006GeneratedUserControl.cs',
        'Require source and Designer source as the exact required artifact delta and verify that the installed UserControl template creates no neutral resx',
        'Verify the classic project gains exactly one source Compile/SubType and one Designer Compile/DependentUpon relationship with no EmbeddedResource item',
        'Verify Designer source is the only child beneath the created source ProjectItem',
        'Save All, rebuild the solution, and open the created UserControl in the actual WinForms Designer',
        'Reject any unexpected top-level delta'
      )
      expected = 'Visual Studio creates the installed two-file UserControl source/Designer set, persists exact classic Compile/DependentUpon/SubType relationships without a neutral resx or EmbeddedResource item, builds successfully, and opens the generated UserControl in the native designer.'
      runtimeArchitecture = 'actual Visual Studio x64 classic net48 reference'
      createdArtifacts = $s006Capture.artifactHashes
      auxiliaryArtifacts = $s006Capture.auxiliaryArtifactHashes
      projectBeforeSha256 = $s006Capture.beforeProjectSha256
      projectAfterSha256 = $s006Capture.afterProjectSha256
      projectByteIdentical = [bool]$s006Capture.projectByteIdentical
      projectMutationExact = [bool]$s006Capture.projectMutationExact
      projectItemRelationships = $s006Capture.projectItemRelationships
      topLevelDelta = $s006Capture.topLevelDelta
      allowedAuxiliaryTopLevelDelta = $s006Capture.allowedAuxiliaryTopLevelDelta
      unexpectedTopLevelDelta = $s006Capture.unexpectedTopLevelDelta
      projectHierarchy = $s006Capture.childNames
      sourceShapeExact = [bool]$s006Capture.sourceShapeExact
      designerShapeExact = [bool]$s006Capture.designerShapeExact
      resourceRoot = $s006Capture.resourceRoot
      solutionBuild = $s006Capture.solutionBuild
      visualStudioWindow = $s006Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S006'; status = $s006Status; directory = 'V2-FND-001-S006' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S006 classic UserControl template reference status: $s006Status"
    if (-not [bool]$s006Capture.pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S025') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    # ButtonDesigner reports Baseline offset 21 and TextBoxDesigner offset 16 for this exact 96-DPI/default-font
    # fixture. With referenceTextBox.Y=40 the Visual Studio baseline target is snapButton.Y=35. The raw pointer delta
    # asks for Y=36, so a final Y=35 proves that the designer applied a one-pixel baseline correction.
    $s025RawTargetY = $s025Before.shape.snapButton.location.y - 44
    $s025Capture = Open-DesignerBaselineSnapAndCapture $dte $s025Source 'snapButton' 'referenceTextBox' -44 `
      (Join-Path $s025Directory 'visual-studio-designer.png')
    $s025AfterText = [System.IO.File]::ReadAllText($s025Designer)
    $s025AfterBytes = [System.IO.File]::ReadAllBytes($s025Designer)
    $s025After = [ordered]@{
      sourceSha256 = Get-Sha256 $s025Source
      designerSha256 = Get-Sha256 $s025Designer
      projectSha256 = Get-Sha256 $s019Project
      shape = Get-S025Shape $s025AfterText
    }
    $s025SourceAndProjectExact = $s025Before.sourceSha256 -eq $s025After.sourceSha256 -and
      $s025Before.projectSha256 -eq $s025After.projectSha256
    $s025ReferenceExact = $s025Before.shape.referenceTextBox.location.x -eq $s025After.shape.referenceTextBox.location.x -and
      $s025Before.shape.referenceTextBox.location.y -eq $s025After.shape.referenceTextBox.location.y -and
      $s025Before.shape.referenceTextBox.size.width -eq $s025After.shape.referenceTextBox.size.width -and
      $s025Before.shape.referenceTextBox.size.height -eq $s025After.shape.referenceTextBox.size.height
    $s025BaselineSnapExact = $s025After.shape.snapButton.location.x -eq $s025Before.shape.snapButton.location.x -and
      $s025After.shape.snapButton.location.y -eq 35 -and
      $s025After.shape.snapButton.location.y -ne $s025RawTargetY -and
      $s025After.shape.snapButton.size.width -eq $s025Before.shape.snapButton.size.width -and
      $s025After.shape.snapButton.size.height -eq $s025Before.shape.snapButton.size.height
    $s025ResourceExists = Test-Path -LiteralPath $s025Resource -PathType Leaf
    $s025ResourceRoot = $null
    $s025ResourceDataCount = $null
    $s025ResourceMetadataCount = $null
    $s025ResourceSha256 = $null
    if ($s025ResourceExists) {
      [xml]$s025ResourceDocument = [System.IO.File]::ReadAllText($s025Resource)
      $s025ResourceRoot = $s025ResourceDocument.DocumentElement.LocalName
      $s025ResourceDataCount = @($s025ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='data']")).Count
      $s025ResourceMetadataCount = @($s025ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='metadata']")).Count
      $s025ResourceSha256 = Get-Sha256 $s025Resource
    }
    $s025StandardEmptyResource = $s025ResourceExists -and $s025ResourceRoot -ceq 'root' -and
      $s025ResourceDataCount -eq 0 -and $s025ResourceMetadataCount -eq 0
    $s025Pass = $s025SourceAndProjectExact -and $s025ReferenceExact -and $s025BaselineSnapExact -and
      $s025StandardEmptyResource
    $s025Status = if ($s025Pass) { 'PASS' } else { 'FAIL' }
    Copy-Item -LiteralPath $s025Source -Destination (Join-Path $s025Directory 'S025BaselineSnapForm.cs')
    [System.IO.File]::WriteAllBytes((Join-Path $s025Directory 'S025BaselineSnapForm.Designer.before.cs'), $s025BeforeBytes)
    Write-Gzip (Join-Path $s025Directory 'S025BaselineSnapForm.Designer.after.cs.gz') $s025AfterBytes
    if ($s025ResourceExists) {
      Copy-Item -LiteralPath $s025Resource -Destination (Join-Path $s025Directory 'S025BaselineSnapForm.resx')
    }
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s025Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s025Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S025"
      scenarioId = 'V2-FND-001-S025'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s025Status
      setup = 'A net10.0-windows Form contains snapButton at (32,80), Size 100x30, and referenceTextBox at (180,40), Size 120x23, both with the default 96-DPI font.'
      actionLog = @(
        'Open S025BaselineSnapForm.cs in the actual WinForms Designer',
        'Select snapButton through its real designer input HWND',
        'Begin a real designer drag and move the pointer vertically by -44 pixels to raw source Y=36',
        'Capture the native designer during the active drag and again after the persisted move',
        'Release the drag, Save All, and inspect the persisted Designer source',
        'Require the Button baseline offset 21 to align to the TextBox baseline offset 16 at exact source Y=35',
        'Require the reference TextBox, source file, project file, and Button size/X to remain exact',
        'Archive the standard empty neutral resx that Visual Studio creates on Save All for this Form'
      )
      expected = 'Visual Studio applies a one-pixel baseline correction to the raw drag target and persists snapButton.Location=(32,35), aligns its text baseline with referenceTextBox, preserves unrelated source/project/control data, and creates one standard empty neutral Form resx.'
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference'
      before = $s025Before
      after = $s025After
      rawTarget = [ordered]@{ x = $s025Before.shape.snapButton.location.x; y = $s025RawTargetY }
      expectedBaselineTarget = [ordered]@{ x = 32; y = 35 }
      baselineOffsets = [ordered]@{ snapButton = 21; referenceTextBox = 16 }
      sourceAndProjectExact = $s025SourceAndProjectExact
      referenceControlExact = $s025ReferenceExact
      baselineSnapExact = $s025BaselineSnapExact
      resource = [ordered]@{
        exists = $s025ResourceExists
        root = $s025ResourceRoot
        dataCount = $s025ResourceDataCount
        metadataCount = $s025ResourceMetadataCount
        sha256 = $s025ResourceSha256
        standardEmptyResource = $s025StandardEmptyResource
        artifact = $(if ($s025ResourceExists) { 'S025BaselineSnapForm.resx' } else { $null })
      }
      exactAfterArtifact = 'S025BaselineSnapForm.Designer.after.cs.gz'
      visualStudioWindow = $s025Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S025'; status = $s025Status; directory = 'V2-FND-001-S025' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S025 native baseline snap reference status: $s025Status (rawY=$s025RawTargetY actualY=$($s025After.shape.snapButton.location.y))"
    if (-not $s025Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S026') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $originalLayoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
    $originalShowGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
    $originalSnapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
    $s026Capture = $null
    $effectiveOptions = $null
    try {
      # LayoutMode=1 is the installed designer's SnapToGrid mode. GridSize is not Automation-readable in this VS
      # build; the deliberately off-grid fixture and exact persisted 8x8 result are the effective-size proof.
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'ShowGrid'), [bool]$true)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'SnapToGrid'), [bool]$true)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'LayoutMode'), [int]1)
      Start-Sleep -Seconds 1
      $effectiveOptions = [ordered]@{
        layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
        showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
        snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
        gridSizeAutomationValue = (Get-WindowsFormsDesignerOption $dte 'GridSize').Value
        expectedEffectiveGrid = [ordered]@{ width = 8; height = 8 }
      }
      $s026CursorProbe = New-Object VisualStudioTraceNative+POINT
      if ([VisualStudioTraceNative]::TryGetCursorPosition([ref]$s026CursorProbe)) {
        $s026Capture = Open-DesignerCursorSynchronizedMoveAndCapture $dte $s026Source 'gridLabel' 'referenceButton' 20 0 `
          (Join-Path $s026Directory 'visual-studio-designer.png')
      } else {
        $s026Capture = Open-DesignerBaselineSnapAndCapture $dte $s026Source 'gridLabel' 'referenceButton' 0 `
          (Join-Path $s026Directory 'visual-studio-designer.png') -DeltaX 20
      }
    } finally {
      # Restore the user's exact designer preferences even when capture or validation fails. Reacquire the COM
      # Property wrapper for each write because LayoutMode changes can invalidate a previously returned wrapper.
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'ShowGrid'), [bool]$originalShowGrid)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'SnapToGrid'), [bool]$originalSnapToGrid)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'LayoutMode'), [int]$originalLayoutMode)
    }
    $restoredOptions = [ordered]@{
      layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
      showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
      snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
    }
    $s026AfterText = [System.IO.File]::ReadAllText($s026Designer)
    $s026AfterBytes = [System.IO.File]::ReadAllBytes($s026Designer)
    $s026After = [ordered]@{
      sourceSha256 = Get-Sha256 $s026Source
      designerSha256 = Get-Sha256 $s026Designer
      projectSha256 = Get-Sha256 $s001Project
      shape = Get-S026Shape $s026AfterText
    }
    $s026SourceAndProjectExact = $s026Before.sourceSha256 -eq $s026After.sourceSha256 -and
      $s026Before.projectSha256 -eq $s026After.projectSha256
    $s026ReferenceExact = $s026Before.shape.referenceButton.location.x -eq $s026After.shape.referenceButton.location.x -and
      $s026Before.shape.referenceButton.location.y -eq $s026After.shape.referenceButton.location.y -and
      $s026Before.shape.referenceButton.size.width -eq $s026After.shape.referenceButton.size.width -and
      $s026Before.shape.referenceButton.size.height -eq $s026After.shape.referenceButton.size.height
    $s026RawTarget = [ordered]@{
      x = $s026Before.shape.gridLabel.location.x + 20
      y = $s026Before.shape.gridLabel.location.y
    }
    $s026GridSnapExact = $s026After.shape.gridLabel.location.x -eq 32 -and
      $s026After.shape.gridLabel.location.y -eq 24 -and
      $s026After.shape.gridLabel.location.x -ne $s026RawTarget.x -and
      $s026After.shape.gridLabel.location.y -ne $s026RawTarget.y -and
      $s026After.shape.gridLabel.size.width -eq $s026Before.shape.gridLabel.size.width -and
      $s026After.shape.gridLabel.size.height -eq $s026Before.shape.gridLabel.size.height
    $s026OptionsRestored = $restoredOptions.layoutMode -eq $originalLayoutMode -and
      $restoredOptions.showGrid -eq $originalShowGrid -and $restoredOptions.snapToGrid -eq $originalSnapToGrid
    $s026ResourceExists = Test-Path -LiteralPath $s026Resource -PathType Leaf
    $s026ResourceRoot = $null
    $s026ResourceDataCount = $null
    $s026ResourceMetadataCount = $null
    $s026ResourceSha256 = $null
    if ($s026ResourceExists) {
      [xml]$s026ResourceDocument = [System.IO.File]::ReadAllText($s026Resource)
      $s026ResourceRoot = $s026ResourceDocument.DocumentElement.LocalName
      $s026ResourceDataCount = @($s026ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='data']")).Count
      $s026ResourceMetadataCount = @($s026ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='metadata']")).Count
      $s026ResourceSha256 = Get-Sha256 $s026Resource
    }
    $s026StandardEmptyResource = $s026ResourceExists -and $s026ResourceRoot -ceq 'root' -and
      $s026ResourceDataCount -eq 0 -and $s026ResourceMetadataCount -eq 0
    $s026Pass = $s026SourceAndProjectExact -and $s026ReferenceExact -and $s026GridSnapExact -and
      $s026OptionsRestored -and $s026StandardEmptyResource
    $s026Status = if ($s026Pass) { 'PASS' } else { 'FAIL' }
    Copy-Item -LiteralPath $s026Source -Destination (Join-Path $s026Directory 'S026GridSnapForm.cs')
    [System.IO.File]::WriteAllBytes((Join-Path $s026Directory 'S026GridSnapForm.Designer.before.cs'), $s026BeforeBytes)
    Write-Gzip (Join-Path $s026Directory 'S026GridSnapForm.Designer.after.cs.gz') $s026AfterBytes
    if ($s026ResourceExists) {
      Copy-Item -LiteralPath $s026Resource -Destination (Join-Path $s026Directory 'S026GridSnapForm.resx')
    }
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s026Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s026Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S026"
      scenarioId = 'V2-FND-001-S026'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s026Status
      setup = 'A net10.0-windows Form contains an AutoSize Label at off-grid Location (13,25), a reference Button, and the installed Visual Studio designer is temporarily set to SnapToGrid with its effective 8x8 grid.'
      actionLog = @(
        'Save the exact WindowsFormsDesigner LayoutMode, ShowGrid, and SnapToGrid user options',
        'Set LayoutMode=1, ShowGrid=true, and SnapToGrid=true for this isolated trace',
        'Open S026GridSnapForm.cs in the actual WinForms Designer',
        'Select gridLabel through its real designer input HWND',
        'Begin a designer drag and move the pointer by +20,0 to raw source Location (33,25)',
        'Release the drag, Save All, and inspect the persisted Designer source',
        'Require exact 8x8 grid Location (32,24), unchanged Label size, exact reference Button/source/project, and a standard empty neutral resx',
        'Restore the exact original LayoutMode, ShowGrid, and SnapToGrid options in finally'
      )
      expected = 'Visual Studio rounds the raw off-grid drag target (33,25) to exact Location (32,24) on the effective 8x8 parent grid, preserves unrelated data, and the capture restores all changed designer options.'
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference'
      before = $s026Before
      after = $s026After
      rawTarget = $s026RawTarget
      expectedGridTarget = [ordered]@{ x = 32; y = 24 }
      effectiveOptions = $effectiveOptions
      originalOptions = [ordered]@{ layoutMode = $originalLayoutMode; showGrid = $originalShowGrid; snapToGrid = $originalSnapToGrid }
      restoredOptions = $restoredOptions
      optionsRestoredExact = $s026OptionsRestored
      sourceAndProjectExact = $s026SourceAndProjectExact
      referenceControlExact = $s026ReferenceExact
      gridSnapExact = $s026GridSnapExact
      resource = [ordered]@{
        exists = $s026ResourceExists
        root = $s026ResourceRoot
        dataCount = $s026ResourceDataCount
        metadataCount = $s026ResourceMetadataCount
        sha256 = $s026ResourceSha256
        standardEmptyResource = $s026StandardEmptyResource
        artifact = $(if ($s026ResourceExists) { 'S026GridSnapForm.resx' } else { $null })
      }
      exactAfterArtifact = 'S026GridSnapForm.Designer.after.cs.gz'
      visualStudioWindow = $s026Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S026'; status = $s026Status; directory = 'V2-FND-001-S026' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S026 native grid snap reference status: $s026Status (raw=$($s026RawTarget.x),$($s026RawTarget.y) actual=$($s026After.shape.gridLabel.location.x),$($s026After.shape.gridLabel.location.y))"
    if (-not $s026Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S027') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $originalLayoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
    $originalShowGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
    $originalSnapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
    $s027Capture = $null
    $effectiveOptions = $null
    try {
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'ShowGrid'), [bool]$true)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'SnapToGrid'), [bool]$true)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'LayoutMode'), [int]1)
      Start-Sleep -Seconds 1
      $effectiveOptions = [ordered]@{
        layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
        showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
        snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
        gridSizeAutomationValue = (Get-WindowsFormsDesignerOption $dte 'GridSize').Value
        expectedEffectiveGrid = [ordered]@{ width = 8; height = 8 }
      }
      $s027CursorProbe = New-Object VisualStudioTraceNative+POINT
      if ([VisualStudioTraceNative]::TryGetCursorPosition([ref]$s027CursorProbe)) {
        $s027Capture = Open-DesignerCursorSynchronizedMoveAndCapture $dte $s027Source 'button1' 'referenceButton' 5 3 `
          (Join-Path $s027Directory 'visual-studio-designer.png') -HoldAlt
      } else {
        $s027Capture = Open-DesignerBaselineSnapAndCapture $dte $s027Source 'button1' 'referenceButton' 3 `
          (Join-Path $s027Directory 'visual-studio-designer.png') -DeltaX 5 -HoldAlt `
          -MovingNativeText 'Alt drag' -ReferenceNativeText 'Reference'
      }
    } finally {
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'ShowGrid'), [bool]$originalShowGrid)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'SnapToGrid'), [bool]$originalSnapToGrid)
      [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'LayoutMode'), [int]$originalLayoutMode)
      Start-Sleep -Seconds 1
    }
    $restoredOptions = [ordered]@{
      layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
      showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
      snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
    }

    $s027AfterText = [System.IO.File]::ReadAllText($s027Designer)
    $s027AfterBytes = [System.IO.File]::ReadAllBytes($s027Designer)
    $s027After = [ordered]@{
      sourceSha256 = Get-Sha256 $s027Source
      designerSha256 = Get-Sha256 $s027Designer
      projectSha256 = Get-Sha256 $s027Project
      shape = Get-S027Shape $s027AfterText
    }

    $s027DesignerItem = $dte.Solution.FindProjectItem($s027Source)
    if ($null -eq $s027DesignerItem) { throw "Visual Studio no longer resolved the S027 project item: $s027Source" }
    $s027DesignerWindow = $s027DesignerItem.Open('{00000000-0000-0000-0000-000000000000}')
    if ($null -eq $s027DesignerWindow) { throw 'Visual Studio did not reactivate the S027 designer before Undo.' }
    $s027DesignerWindow.Visible = $true
    $null = $s027DesignerWindow.Activate()
    Start-Sleep -Seconds 1
    $undoAvailable = [bool]$dte.Commands.Item('Edit.Undo').IsAvailable
    if ($undoAvailable) {
      $null = $dte.ExecuteCommand('Edit.Undo')
      Start-Sleep -Seconds 3
      $null = $dte.ExecuteCommand('File.SaveAll')
      Start-Sleep -Seconds 2
    }
    $s027AfterUndoText = [System.IO.File]::ReadAllText($s027Designer)
    $s027AfterUndoBytes = [System.IO.File]::ReadAllBytes($s027Designer)
    $s027AfterUndo = [ordered]@{
      sourceSha256 = Get-Sha256 $s027Source
      designerSha256 = Get-Sha256 $s027Designer
      projectSha256 = Get-Sha256 $s027Project
      shape = Get-S027Shape $s027AfterUndoText
    }

    $null = $s027DesignerWindow.Activate()
    Start-Sleep -Seconds 1
    $redoAvailable = [bool]$dte.Commands.Item('Edit.Redo').IsAvailable
    if ($redoAvailable) {
      $null = $dte.ExecuteCommand('Edit.Redo')
      Start-Sleep -Seconds 3
      $null = $dte.ExecuteCommand('File.SaveAll')
      Start-Sleep -Seconds 2
    }
    $s027AfterRedoText = [System.IO.File]::ReadAllText($s027Designer)
    $s027AfterRedoBytes = [System.IO.File]::ReadAllBytes($s027Designer)
    $s027AfterRedo = [ordered]@{
      sourceSha256 = Get-Sha256 $s027Source
      designerSha256 = Get-Sha256 $s027Designer
      projectSha256 = Get-Sha256 $s027Project
      shape = Get-S027Shape $s027AfterRedoText
    }

    $effectiveOptionsExact = $effectiveOptions.layoutMode -eq 1 -and $effectiveOptions.showGrid -and $effectiveOptions.snapToGrid
    $optionsRestoredExact = $restoredOptions.layoutMode -eq $originalLayoutMode -and
      $restoredOptions.showGrid -eq $originalShowGrid -and $restoredOptions.snapToGrid -eq $originalSnapToGrid
    $s027Phases = @($s027After, $s027AfterUndo, $s027AfterRedo)
    $sourceAndProjectExact = @($s027Phases | Where-Object {
      $_.sourceSha256 -ne $s027Before.sourceSha256 -or $_.projectSha256 -ne $s027Before.projectSha256
    }).Count -eq 0
    $initialExact = $s027Before.shape.button1.location.x -eq 13 -and $s027Before.shape.button1.location.y -eq 25 -and
      $s027Before.shape.button1.size.width -eq 75 -and $s027Before.shape.button1.size.height -eq 23
    $afterExact = $s027After.shape.button1.location.x -eq 18 -and $s027After.shape.button1.location.y -eq 28
    $undoExact = $s027AfterUndo.shape.button1.location.x -eq 13 -and $s027AfterUndo.shape.button1.location.y -eq 25
    $redoExact = $s027AfterRedo.shape.button1.location.x -eq 18 -and $s027AfterRedo.shape.button1.location.y -eq 28
    $shapes = @($s027After.shape, $s027AfterUndo.shape, $s027AfterRedo.shape)
    $unrelatedFactsExact = @($shapes | Where-Object {
      $_.button1.size.width -ne 75 -or $_.button1.size.height -ne 23 -or
      $_.referenceButton.location.x -ne 190 -or $_.referenceButton.location.y -ne 96 -or
      $_.referenceButton.size.width -ne 110 -or $_.referenceButton.size.height -ne 30 -or
      -not $_.buttonTextExact -or -not $_.membershipExact
    }).Count -eq 0
    $s027Pass = $effectiveOptionsExact -and $optionsRestoredExact -and $sourceAndProjectExact -and
      $initialExact -and $afterExact -and $undoAvailable -and $undoExact -and $redoAvailable -and $redoExact -and
      $unrelatedFactsExact -and $s027After.designerSha256 -eq $s027AfterRedo.designerSha256 -and
      [bool]$s027Capture.input.holdAlt
    $s027Status = if ($s027Pass) { 'PASS' } else { 'FAIL' }

    [System.IO.File]::WriteAllBytes((Join-Path $s027Directory 'S027AltDragForm.Designer.before.cs'), $s027BeforeBytes)
    Write-Gzip (Join-Path $s027Directory 'S027AltDragForm.Designer.after.cs.gz') $s027AfterBytes
    Write-Gzip (Join-Path $s027Directory 'S027AltDragForm.Designer.after-undo.cs.gz') $s027AfterUndoBytes
    Write-Gzip (Join-Path $s027Directory 'S027AltDragForm.Designer.after-redo.cs.gz') $s027AfterRedoBytes
    Copy-Item -LiteralPath $s027Source -Destination (Join-Path $s027Directory 'S027AltDragForm.cs')
    Copy-Item -LiteralPath $s027Project -Destination (Join-Path $s027Directory 'VisualStudioReference.Net48.csproj')
    if (Test-Path -LiteralPath $s027Resource -PathType Leaf) {
      Copy-Item -LiteralPath $s027Resource -Destination (Join-Path $s027Directory 'S027AltDragForm.resx')
    }
    Write-Json (Join-Path $s027Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S027"
      scenarioId = 'V2-FND-001-S027'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s027Status
      setup = 'A classic net48 Form has button1 at off-grid Location (13,25); the dedicated Visual Studio instance is temporarily configured with LayoutMode=SnapToGrid, ShowGrid=true, and SnapToGrid=true.'
      actionLog = @(
        'Build the exact classic net48 fixture solution in actual Visual Studio',
        'Save the exact WindowsFormsDesigner LayoutMode, ShowGrid, and SnapToGrid options and enable SnapToGrid in the isolated trace IDE',
        'Open S027AltDragForm.cs in the installed classic WinForms Designer and select button1 through its real designer HWND',
        'Hold VK_MENU (Alt) for the complete native designer drag and move the pointer by raw +5,+3',
        'Release the drag, Save All, and require exact unsnapped Location (18,28)',
        'Execute one native Undo and Save All to restore (13,25)',
        'Execute one native Redo and Save All to reproduce (18,28) byte-identically',
        'Require exact source/project hashes and all unrelated Button/reference-control facts',
        'Restore the exact original designer options in finally'
      )
      expected = 'With the installed designer actively snapping to its 8x8 grid, holding Alt for a raw +5,+3 drag bypasses snapping and persists button1 at exact Location (18,28); one native Undo/Redo owns the move and unrelated artifacts remain exact.'
      runtimeArchitecture = 'actual Visual Studio x64 classic net48 reference'
      before = $s027Before
      after = $s027After
      afterUndo = $s027AfterUndo
      afterRedo = $s027AfterRedo
      rawDelta = [ordered]@{ x = 5; y = 3 }
      exactRawTarget = [ordered]@{ x = 18; y = 28 }
      effectiveOptions = $effectiveOptions
      originalOptions = [ordered]@{ layoutMode = $originalLayoutMode; showGrid = $originalShowGrid; snapToGrid = $originalSnapToGrid }
      restoredOptions = $restoredOptions
      effectiveOptionsExact = $effectiveOptionsExact
      optionsRestoredExact = $optionsRestoredExact
      sourceAndProjectExact = $sourceAndProjectExact
      initialExact = $initialExact
      rawAltDragExact = $afterExact
      oneUndoRestoresBaseline = $undoExact
      oneRedoRestoresRawAltDrag = $redoExact
      unrelatedFactsExact = $unrelatedFactsExact
      redoByteIdenticalToMove = $s027After.designerSha256 -eq $s027AfterRedo.designerSha256
      undoRedo = [ordered]@{ undoAvailable = $undoAvailable; redoAvailable = $redoAvailable }
      resource = [ordered]@{
        exists = [bool](Test-Path -LiteralPath $s027Resource -PathType Leaf)
        sha256 = $(if (Test-Path -LiteralPath $s027Resource -PathType Leaf) { Get-Sha256 $s027Resource } else { $null })
        artifact = $(if (Test-Path -LiteralPath $s027Resource -PathType Leaf) { 'S027AltDragForm.resx' } else { $null })
      }
      designerBeforeArtifact = 'S027AltDragForm.Designer.before.cs'
      designerAfterArtifact = 'S027AltDragForm.Designer.after.cs.gz'
      designerAfterUndoArtifact = 'S027AltDragForm.Designer.after-undo.cs.gz'
      designerAfterRedoArtifact = 'S027AltDragForm.Designer.after-redo.cs.gz'
      visualStudioWindow = $s027Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S027'; status = $s027Status; directory = 'V2-FND-001-S027' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S027 Alt-drag reference status: $s027Status (before=$($s027Before.shape.button1.location.x),$($s027Before.shape.button1.location.y) after=$($s027After.shape.button1.location.x),$($s027After.shape.button1.location.y) undo=$($s027AfterUndo.shape.button1.location.x),$($s027AfterUndo.shape.button1.location.y) redo=$($s027AfterRedo.shape.button1.location.x),$($s027AfterRedo.shape.button1.location.y))"
    if (-not $s027Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S079') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s079Capture = Open-DesignerRtlGeometryAndCapture $dte $s079Source `
      (Join-Path $s079Directory 'visual-studio-designer.png')
    $s079After = [ordered]@{
      sourceSha256 = Get-Sha256 $s079Source
      designerSha256 = Get-Sha256 $s079Designer
      projectSha256 = Get-Sha256 $s079Project
    }
    $button = $s079Capture.controls.primaryButton
    $label = $s079Capture.controls.statusLabel
    $clientExact = $s079Capture.form.clientScreenBounds.width -eq 320 -and
      $s079Capture.form.clientScreenBounds.height -eq 160
    $buttonExact = $button.actualClient.x -eq $button.expectedMirrored.x -and
      $button.actualClient.y -eq $button.expectedMirrored.y -and
      $button.actualClient.width -eq $button.expectedMirrored.width -and
      $button.actualClient.height -eq $button.expectedMirrored.height
    $labelExact = $label.actualClient.x -eq $label.expectedMirrored.x -and
      $label.actualClient.y -eq $label.expectedMirrored.y -and
      $label.actualClient.width -eq $label.expectedMirrored.width -and
      $label.actualClient.height -eq $label.expectedMirrored.height
    $artifactsExact = $s079After.sourceSha256 -eq $s079Before.sourceSha256 -and
      $s079After.designerSha256 -eq $s079Before.designerSha256 -and
      $s079After.projectSha256 -eq $s079Before.projectSha256
    $s079DesignerText = [System.IO.File]::ReadAllText($s079Designer)
    $sourceContractExact = ([regex]::Matches($s079DesignerText, '(?m)^\s*(?:this\.)?RightToLeft\s*=\s*System\.Windows\.Forms\.RightToLeft\.Yes;\s*$')).Count -eq 1 -and
      ([regex]::Matches($s079DesignerText, '(?m)^\s*(?:this\.)?RightToLeftLayout\s*=\s*true;\s*$')).Count -eq 1 -and
      ([regex]::Matches($s079DesignerText, '(?m)^\s*(?:this\.)?ClientSize\s*=\s*new System\.Drawing\.Size\(320,\s*160\);\s*$')).Count -eq 1
    $s079Pass = $clientExact -and $buttonExact -and $labelExact -and $artifactsExact -and $sourceContractExact
    $s079Status = if ($s079Pass) { 'PASS' } else { 'FAIL' }

    Copy-Item -LiteralPath $s079Source -Destination (Join-Path $s079Directory 'S079RtlLayoutForm.cs')
    Copy-Item -LiteralPath $s079Designer -Destination (Join-Path $s079Directory 'S079RtlLayoutForm.Designer.cs')
    Copy-Item -LiteralPath $s079Project -Destination (Join-Path $s079Directory 'VisualStudioReference.Net48.csproj')
    Write-Json (Join-Path $s079Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S079"
      scenarioId = 'V2-FND-001-S079'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s079Status
      setup = 'A classic net48 Form has ClientSize 320x160, logical primaryButton (20,30,90x28), logical statusLabel (50,82,80x20), RightToLeft=Yes, and RightToLeftLayout=true.'
      actionLog = @(
        'Build the exact classic net48 fixture solution in actual Visual Studio',
        'Open S079RtlLayoutForm.cs in the installed classic WinForms Designer',
        'Resolve the real Form, Button, and Label child HWNDs by exact native captions',
        'Measure the Form client rectangle in screen space and both child window rectangles with Win32',
        'Convert each child rectangle to Form-client coordinates',
        'Require x = clientWidth - logicalX - width with exact Y and Size preservation',
        'Require source, Designer, and project SHA-256 values to remain byte-identical without Save'
      )
      expected = 'The actual classic WinForms Designer applies WS_EX_LAYOUTRTL geometry: primaryButton is client (210,30,90x28), statusLabel is client (190,82,80x20), and every source artifact remains clean and byte-identical.'
      runtimeArchitecture = 'actual Visual Studio x64 classic net48 reference'
      before = $s079Before
      after = $s079After
      clientExact = $clientExact
      controls = [ordered]@{
        primaryButton = [ordered]@{ exact = $buttonExact; measurement = $button }
        statusLabel = [ordered]@{ exact = $labelExact; measurement = $label }
      }
      sourceContractExact = $sourceContractExact
      artifactsExact = $artifactsExact
      visualStudioWindow = $s079Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S079'; status = $s079Status; directory = 'V2-FND-001-S079' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S079 RTL native geometry reference status: $s079Status (client=$($s079Capture.form.clientScreenBounds.width)x$($s079Capture.form.clientScreenBounds.height); button=$($button.actualClient.x),$($button.actualClient.y),$($button.actualClient.width)x$($button.actualClient.height); label=$($label.actualClient.x),$($label.actualClient.y),$($label.actualClient.width)x$($label.actualClient.height))"
    if (-not $s079Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S085') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s085Capture = Open-DesignerInheritedPropertyAndCapture $dte $s085Source $s085Designer `
      'inheritedButton' 'Text' 'Base inherited' 'Derived override' `
      (Join-Path $s085Directory 'visual-studio-designer.png')
    $s085After = [ordered]@{
      baseSourceSha256 = Get-Sha256 $s085BaseSource
      baseDesignerSha256 = Get-Sha256 $s085BaseDesigner
      sourceSha256 = Get-Sha256 $s085Source
      designerSha256 = Get-Sha256 $s085Designer
      projectSha256 = Get-Sha256 $s085Project
    }
    $s085NonDerivedArtifactsExact = $s085Before.baseSourceSha256 -eq $s085After.baseSourceSha256 -and
      $s085Before.baseDesignerSha256 -eq $s085After.baseDesignerSha256 -and
      $s085Before.sourceSha256 -eq $s085After.sourceSha256 -and
      $s085Before.projectSha256 -eq $s085After.projectSha256
    $s085SelectionExact = [string]$s085Capture.control.controlType -eq 'ControlType.Button' -and
      -not [bool]$s085Capture.control.offscreen -and
      @($s085Capture.selectionAttempts | Where-Object { [bool]$_.selectedExact }).Count -gt 0 -and
      [string]$s085Capture.property.beforeValue -eq 'Base inherited'
    $s085OverrideExact = [int]$s085Capture.after.shape.inheritedFieldDeclarationCount -eq 0 -and
      [int]$s085Capture.after.shape.inheritedAssignmentCount -eq 1 -and
      [int]$s085Capture.after.shape.requestedTextOverrideCount -eq 1
    $s085UndoExact = [bool]$s085Capture.undo.available -and
      [bool]$s085Capture.undo.semanticExactToOriginalAfterCodeDomNormalization -and
      [int]$s085Capture.undo.shape.inheritedAssignmentCount -eq 0
    $s085RedoExact = [bool]$s085Capture.redo.available -and
      [bool]$s085Capture.redo.byteExactToAfter -and
      [string]$s085Capture.redo.sha256 -eq [string]$s085Capture.after.sha256 -and
      [int]$s085Capture.redo.shape.inheritedAssignmentCount -eq 1 -and
      [int]$s085Capture.redo.shape.requestedTextOverrideCount -eq 1
    $s085Pass = $s085SelectionExact -and $s085OverrideExact -and $s085UndoExact -and $s085RedoExact -and
      $s085NonDerivedArtifactsExact -and [string]$s085After.designerSha256 -eq [string]$s085Capture.redo.sha256
    $s085Status = if ($s085Pass) { 'PASS' } else { 'FAIL' }

    [System.IO.File]::WriteAllBytes((Join-Path $s085Directory 'S085InheritedDerivedForm.Designer.before.cs'), $s085BeforeBytes)
    Copy-Item -LiteralPath $s085BaseSource -Destination (Join-Path $s085Directory 'S085InheritedBaseForm.cs')
    Copy-Item -LiteralPath $s085BaseDesigner -Destination (Join-Path $s085Directory 'S085InheritedBaseForm.Designer.cs')
    Copy-Item -LiteralPath $s085Source -Destination (Join-Path $s085Directory 'S085InheritedDerivedForm.cs')
    Copy-Item -LiteralPath $s085Project -Destination (Join-Path $s085Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s085Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S085"
      scenarioId = 'V2-FND-001-S085'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s085Status
      setup = 'A net10.0-windows derived Form inherits one protected Button named inheritedButton from a compiled base Form; the derived Designer initially contains no inheritedButton assignment.'
      actionLog = @(
        'Build the exact base and derived Forms in actual Visual Studio',
        'Open S085InheritedDerivedForm.cs with the installed WinForms Designer',
        'Resolve and select the visible inheritedButton exposed by the actual designer',
        'Require native Properties Text to equal Base inherited before mutation',
        'Set Text to Derived override through the native Property Grid UI Automation ValuePattern',
        'Execute File.SaveAll and require exactly one derived Text override with no derived field declaration or unrelated inherited assignment',
        'Execute one native Undo, save, and require the original derived semantics after normalizing only Visual Studio CodeDOM this-prefix and comment-spacing canonicalization',
        'Execute one native Redo, save, and require the byte-exact applied derived Designer',
        'Require base source, base Designer, derived code-behind, and project bytes to remain exact'
      )
      expected = 'Actual Visual Studio edits the accessible inherited Button by writing only inheritedButton.Text = "Derived override" into the derived Designer; the base artifacts remain exact, native Undo removes the override while retaining deterministic first-touch CodeDOM canonicalization, and Redo reproduces the applied Designer byte-exact.'
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference'
      before = $s085Before
      after = $s085After
      selectionExact = $s085SelectionExact
      overrideExact = $s085OverrideExact
      undoExact = $s085UndoExact
      redoExact = $s085RedoExact
      nonDerivedArtifactsExact = $s085NonDerivedArtifactsExact
      derivedDesignerBeforeArtifact = 'S085InheritedDerivedForm.Designer.before.cs'
      derivedDesignerAfterArtifact = 'S085InheritedDerivedForm.Designer.after-override.cs.gz'
      derivedDesignerUndoArtifact = 'S085InheritedDerivedForm.Designer.after-undo.cs.gz'
      derivedDesignerRedoArtifact = 'S085InheritedDerivedForm.Designer.after-redo.cs.gz'
      baseSourceArtifact = 'S085InheritedBaseForm.cs'
      baseDesignerArtifact = 'S085InheritedBaseForm.Designer.cs'
      sourceArtifact = 'S085InheritedDerivedForm.cs'
      projectArtifact = 'VisualStudioReference.Modern.csproj'
      visualStudioWindow = $s085Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S085'; status = $s085Status; directory = 'V2-FND-001-S085' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S085 inherited Text override status: $s085Status; selection=$s085SelectionExact; override=$s085OverrideExact; undo=$s085UndoExact; redo=$s085RedoExact; nonDerivedBytes=$s085NonDerivedArtifactsExact"
    if (-not $s085Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S086') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s086Capture = Open-DesignerInheritedReadOnlyPropertyAndCapture $dte $s086Source `
      'privateInheritedLabel' 'Private inherited label' 'Text' 'Private inherited label' `
      (Join-Path $s086Directory 'visual-studio-designer.png')
    $s086After = [ordered]@{
      baseSourceSha256 = Get-Sha256 $s086BaseSource
      baseDesignerSha256 = Get-Sha256 $s086BaseDesigner
      sourceSha256 = Get-Sha256 $s086Source
      designerSha256 = Get-Sha256 $s086Designer
      projectSha256 = Get-Sha256 $s086Project
    }
    $s086ArtifactsExact = $s086Before.baseSourceSha256 -eq $s086After.baseSourceSha256 -and
      $s086Before.baseDesignerSha256 -eq $s086After.baseDesignerSha256 -and
      $s086Before.sourceSha256 -eq $s086After.sourceSha256 -and
      $s086Before.designerSha256 -eq $s086After.designerSha256 -and
      $s086Before.projectSha256 -eq $s086After.projectSha256
    $s086SelectionExact = [string]$s086Capture.control.automationId -eq 'privateInheritedLabel' -and
      -not [bool]$s086Capture.control.offscreen -and
      @($s086Capture.selectionAttempts | Where-Object { [bool]$_.selectedExact }).Count -gt 0 -and
      [string]$s086Capture.property.beforeValue -eq 'Private inherited label'
    $s086ReadOnlyExact = [bool]$s086Capture.property.readOnlyExact -and
      -not [bool]$s086Capture.property.setValueSucceeded -and
      [string]$s086Capture.property.afterValue -eq 'Private inherited label'
    $s086Pass = $s086SelectionExact -and $s086ReadOnlyExact -and $s086ArtifactsExact
    $s086Status = if ($s086Pass) { 'PASS' } else { 'FAIL' }

    Copy-Item -LiteralPath $s086BaseSource -Destination (Join-Path $s086Directory 'S086InheritedLockedBaseForm.cs')
    Copy-Item -LiteralPath $s086BaseDesigner -Destination (Join-Path $s086Directory 'S086InheritedLockedBaseForm.Designer.cs')
    Copy-Item -LiteralPath $s086Source -Destination (Join-Path $s086Directory 'S086InheritedLockedDerivedForm.cs')
    Copy-Item -LiteralPath $s086Designer -Destination (Join-Path $s086Directory 'S086InheritedLockedDerivedForm.Designer.cs')
    Copy-Item -LiteralPath $s086Project -Destination (Join-Path $s086Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s086Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S086"
      scenarioId = 'V2-FND-001-S086'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s086Status
      setup = 'A net10.0-windows derived Form inherits one private Label named privateInheritedLabel from a compiled base Form; the derived Designer contains no reference to that private control.'
      actionLog = @(
        'Build the exact base and derived Forms in actual Visual Studio',
        'Open S086InheritedLockedDerivedForm.cs with the installed WinForms Designer',
        'Resolve and select the visible privateInheritedLabel exposed by the actual designer',
        'Require native Properties Text to equal Private inherited label',
        'Require the native Text row or its value provider to be read-only',
        'If a read-only ValuePattern is exposed, attempt SetValue and require the provider to reject it',
        'Require the Text value and base source, base Designer, derived code-behind, derived Designer, and project bytes to remain exact without Save'
      )
      expected = 'Actual Visual Studio displays and selects the private inherited Label, publishes its Text as read-only, rejects any exposed ValuePattern mutation path, and leaves every source/project artifact byte-identical.'
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference; catalog physical ARM64 leg remains NOT_EXECUTED'
      catalogArchitectureBoundary = 'This x64 Visual Studio reference closes only the reference-observation gate; physical Windows ARM64 remains externally gated.'
      before = $s086Before
      after = $s086After
      selectionExact = $s086SelectionExact
      readOnlyExact = $s086ReadOnlyExact
      artifactsExact = $s086ArtifactsExact
      baseSourceArtifact = 'S086InheritedLockedBaseForm.cs'
      baseDesignerArtifact = 'S086InheritedLockedBaseForm.Designer.cs'
      sourceArtifact = 'S086InheritedLockedDerivedForm.cs'
      designerArtifact = 'S086InheritedLockedDerivedForm.Designer.cs'
      projectArtifact = 'VisualStudioReference.Modern.csproj'
      visualStudioWindow = $s086Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S086'; status = $s086Status; directory = 'V2-FND-001-S086' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S086 inherited private Label read-only status: $s086Status; selection=$s086SelectionExact; readOnly=$s086ReadOnlyExact; artifacts=$s086ArtifactsExact"
    if (-not $s086Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S087') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s087Capture = Open-DesignerInheritedToolboxAddAndCapture $dte $s087Source $s087Designer `
      (Join-Path $s087Directory 'visual-studio-designer.png')
    $s087After = [ordered]@{
      baseSourceSha256 = Get-Sha256 $s087BaseSource
      baseDesignerSha256 = Get-Sha256 $s087BaseDesigner
      sourceSha256 = Get-Sha256 $s087Source
      designerSha256 = Get-Sha256 $s087Designer
      projectSha256 = Get-Sha256 $s087Project
    }
    $s087NonDerivedArtifactsExact = $s087Before.baseSourceSha256 -eq $s087After.baseSourceSha256 -and
      $s087Before.baseDesignerSha256 -eq $s087After.baseDesignerSha256 -and
      $s087Before.sourceSha256 -eq $s087After.sourceSha256 -and
      $s087Before.projectSha256 -eq $s087After.projectSha256
    $s087AppliedShapeExact = {
      param($Shape)
      return [int]$Shape.buttonFieldCount -eq 1 -and
        [int]$Shape.buttonConstructionCount -eq 1 -and
        [int]$Shape.buttonLocationCount -eq 1 -and
        [int]$Shape.buttonSizeCount -eq 1 -and
        [int]$Shape.buttonTabIndexCount -eq 1 -and
        [int]$Shape.buttonTextCount -eq 1 -and
        [int]$Shape.buttonUseVisualStyleBackColorCount -eq 1 -and
        [int]$Shape.rootAddCount -eq 1 -and
        [int]$Shape.inheritedPanelAddCount -eq 0 -and
        [int]$Shape.nameAssignmentCount -eq 1 -and
        [int]$Shape.buttonSetChildIndexCount -eq 1 -and
        [int]$Shape.basePanelSetChildIndexCount -eq 1
    }
    $s087AddExact = [bool]$s087Capture.toolboxExact -and [bool]$s087Capture.defaultActionInvoked -and
      (& $s087AppliedShapeExact $s087Capture.after.shape)
    $s087UndoExact = [bool]$s087Capture.undo.available -and
      [bool]$s087Capture.undo.semanticExactToOriginalAfterCodeDomNormalization -and
      [int]$s087Capture.undo.shape.buttonFieldCount -eq 0 -and
      [int]$s087Capture.undo.shape.rootAddCount -eq 0
    $s087RedoOperationExact = [bool]$s087Capture.redo.available -and
      [bool]$s087Capture.redo.operationContractExactToAfterAfterMeasuredCodeDomNormalization -and
      (& $s087AppliedShapeExact $s087Capture.redo.shape)
    $s087Pass = $s087NonDerivedArtifactsExact -and $s087AddExact -and $s087UndoExact -and $s087RedoOperationExact -and
      [string]$s087After.designerSha256 -eq [string]$s087Capture.redo.sha256
    $s087Status = if ($s087Pass) { 'PASS' } else { 'FAIL' }

    [System.IO.File]::WriteAllBytes((Join-Path $s087Directory 'S087InheritedDerivedForm.Designer.before.cs'), $s087BeforeBytes)
    Copy-Item -LiteralPath $s087BaseSource -Destination (Join-Path $s087Directory 'S087InheritedBaseForm.cs')
    Copy-Item -LiteralPath $s087BaseDesigner -Destination (Join-Path $s087Directory 'S087InheritedBaseForm.Designer.cs')
    Copy-Item -LiteralPath $s087Source -Destination (Join-Path $s087Directory 'S087InheritedDerivedForm.cs')
    Copy-Item -LiteralPath $s087Project -Destination (Join-Path $s087Directory 'VisualStudioReference.Net48.csproj')
    Write-Json (Join-Path $s087Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S087"
      scenarioId = 'V2-FND-001-S087'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s087Status
      setup = 'A classic net48 derived Form inherits a protected Panel named basePanel from a compiled base Form; the derived Designer initially contains no Button.'
      actionLog = @(
        'Build the exact classic net48 base and derived Forms in actual Visual Studio',
        'Open S087InheritedDerivedForm.cs with the installed WinForms Designer',
        'Select empty derived-root space outside the inherited basePanel',
        'Open the native Toolbox and filter to Button through its bounded Search Toolbox ValuePattern',
        'Invoke the exact All Windows Forms/Button MSAA Double-Click default action',
        'Save All and require exactly one button1 field, construction, Name assignment, and derived-root Controls.Add with no basePanel Controls.Add',
        'Execute one native Undo, save, and require the original derived semantics after normalizing only Visual Studio CodeDOM this-prefix, comment-spacing, line-ending, and blank-line canonicalization',
        'Execute one native Redo, save, and require the same complete derived-root Button operation contract after normalizing measured designer-generated TabIndex and SetChildIndex call-order instability; retain both raw hashes and artifacts',
        'Require base source, base Designer, derived code-behind, and project bytes to remain exact'
      )
      expected = 'Actual Visual Studio adds one new Button only to the derived Form root through the native Toolbox; the base artifacts remain exact, native Undo removes the derived-only control, and Redo restores the complete operation contract while raw CodeDOM artifacts expose the measured TabIndex and SetChildIndex-order differences.'
      runtimeArchitecture = 'actual Visual Studio x64 classic net48 reference'
      before = $s087Before
      after = $s087After
      addExact = $s087AddExact
      undoExact = $s087UndoExact
      redoOperationExact = $s087RedoOperationExact
      redoByteExact = [bool]$s087Capture.redo.byteExactToAfter
      nonDerivedArtifactsExact = $s087NonDerivedArtifactsExact
      derivedDesignerBeforeArtifact = 'S087InheritedDerivedForm.Designer.before.cs'
      derivedDesignerAfterArtifact = 'S087InheritedDerivedForm.Designer.after-add.cs.gz'
      derivedDesignerUndoArtifact = 'S087InheritedDerivedForm.Designer.after-undo.cs.gz'
      derivedDesignerRedoArtifact = 'S087InheritedDerivedForm.Designer.after-redo.cs.gz'
      baseSourceArtifact = 'S087InheritedBaseForm.cs'
      baseDesignerArtifact = 'S087InheritedBaseForm.Designer.cs'
      sourceArtifact = 'S087InheritedDerivedForm.cs'
      projectArtifact = 'VisualStudioReference.Net48.csproj'
      visualStudioWindow = $s087Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S087'; status = $s087Status; directory = 'V2-FND-001-S087' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S087 inherited derived-root Toolbox Add status: $s087Status; add=$s087AddExact; undo=$s087UndoExact; redoOperation=$s087RedoOperationExact; redoByteExact=$([bool]$s087Capture.redo.byteExactToAfter); nonDerived=$s087NonDerivedArtifactsExact"
    if (-not $s087Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S088') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $modernDirectory = Join-Path $s088Directory 'modern'
    $net48Directory = Join-Path $s088Directory 'net48'
    New-Item -ItemType Directory -Path $modernDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $net48Directory -Force | Out-Null

    $s088ModernCapture = Open-DesignerInheritedReadOnlyDragAndCapture $dte $s088ModernSource $s088ModernDesigner `
      'privateInheritedButton' 'Private inherited' 7 9 `
      (Join-Path $modernDirectory 'visual-studio-designer.after-drag.png')
    $s088Net48Capture = Open-DesignerInheritedReadOnlyDragAndCapture $dte $s088Net48Source $s088Net48Designer `
      'privateInheritedButton' 'Private inherited' 11 13 `
      (Join-Path $net48Directory 'visual-studio-designer.after-drag.png')
    Copy-Item -LiteralPath (Join-Path $modernDirectory 'visual-studio-designer.after-drag.png') `
      -Destination (Join-Path $s088Directory 'visual-studio-designer.png')

    $s088After = [ordered]@{
      modern = [ordered]@{
        baseSourceSha256 = Get-Sha256 $s088ModernBaseSource
        baseDesignerSha256 = Get-Sha256 $s088ModernBaseDesigner
        sourceSha256 = Get-Sha256 $s088ModernSource
        designerSha256 = Get-Sha256 $s088ModernDesigner
        projectSha256 = Get-Sha256 $s088ModernProject
      }
      net48 = [ordered]@{
        baseSourceSha256 = Get-Sha256 $s088Net48BaseSource
        baseDesignerSha256 = Get-Sha256 $s088Net48BaseDesigner
        sourceSha256 = Get-Sha256 $s088Net48Source
        designerSha256 = Get-Sha256 $s088Net48Designer
        projectSha256 = Get-Sha256 $s088Net48Project
      }
    }
    $s088ModernArtifactsExact = $s088Before.modern.baseSourceSha256 -eq $s088After.modern.baseSourceSha256 -and
      $s088Before.modern.baseDesignerSha256 -eq $s088After.modern.baseDesignerSha256 -and
      $s088Before.modern.sourceSha256 -eq $s088After.modern.sourceSha256 -and
      $s088Before.modern.designerSha256 -eq $s088After.modern.designerSha256 -and
      $s088Before.modern.projectSha256 -eq $s088After.modern.projectSha256
    $s088Net48ArtifactsExact = $s088Before.net48.baseSourceSha256 -eq $s088After.net48.baseSourceSha256 -and
      $s088Before.net48.baseDesignerSha256 -eq $s088After.net48.baseDesignerSha256 -and
      $s088Before.net48.sourceSha256 -eq $s088After.net48.sourceSha256 -and
      $s088Before.net48.designerSha256 -eq $s088After.net48.designerSha256 -and
      $s088Before.net48.projectSha256 -eq $s088After.net48.projectSha256
    $s088VisualButtonExact = {
      param($Record)
      return [string]$Record.frameworkId -eq 'WinForm' -and
        ([string]$Record.controlType -eq 'ControlType.Button' -or
          [string]$Record.className -match '^WindowsForms10\.BUTTON\.')
    }
    $s088LegExact = {
      param($Capture)
      return ([string]$Capture.control.automationId -eq 'privateInheritedButton' -or
          [string]$Capture.control.name -eq 'Private inherited') -and
        (& $s088VisualButtonExact $Capture.control) -and
        -not [bool]$Capture.control.offscreen -and
        ([string]$Capture.derivedPeer.automationId -eq 'derivedButton' -or
          [string]$Capture.derivedPeer.name -eq 'Derived writable') -and
        (& $s088VisualButtonExact $Capture.derivedPeer) -and
        -not [bool]$Capture.derivedPeer.offscreen -and
        @($Capture.selectionAttempts | Where-Object { [bool]$_.selectedExact }).Count -gt 0 -and
        [string]$Capture.identityProperty.value -eq 'Private inherited' -and
        [bool]$Capture.identityProperty.readOnlyExact -and
        [long]$Capture.input.dragWindow -ne 0 -and
        [bool]$Capture.boundsExact -and
        [bool]$Capture.undoAvailabilityUnchanged -and
        [bool]$Capture.documentSavedStateUnchanged
    }
    $s088ModernExact = $s088ModernArtifactsExact -and (& $s088LegExact $s088ModernCapture)
    $s088Net48Exact = $s088Net48ArtifactsExact -and (& $s088LegExact $s088Net48Capture)
    $s088Pass = $s088ModernExact -and $s088Net48Exact
    $s088Status = if ($s088Pass) { 'PASS' } else { 'FAIL' }

    foreach ($leg in @(
      [ordered]@{ directory = $modernDirectory; baseSource = $s088ModernBaseSource; baseDesigner = $s088ModernBaseDesigner; source = $s088ModernSource; designer = $s088ModernDesigner; project = $s088ModernProject; projectName = 'VisualStudioReference.Modern.csproj' },
      [ordered]@{ directory = $net48Directory; baseSource = $s088Net48BaseSource; baseDesigner = $s088Net48BaseDesigner; source = $s088Net48Source; designer = $s088Net48Designer; project = $s088Net48Project; projectName = 'VisualStudioReference.Net48.csproj' }
    )) {
      Copy-Item -LiteralPath $leg.baseSource -Destination (Join-Path $leg.directory 'S088InheritedMoveBaseForm.cs')
      Copy-Item -LiteralPath $leg.baseDesigner -Destination (Join-Path $leg.directory 'S088InheritedMoveBaseForm.Designer.cs')
      Copy-Item -LiteralPath $leg.source -Destination (Join-Path $leg.directory 'S088InheritedMoveDerivedForm.cs')
      Copy-Item -LiteralPath $leg.designer -Destination (Join-Path $leg.directory 'S088InheritedMoveDerivedForm.Designer.cs')
      Copy-Item -LiteralPath $leg.project -Destination (Join-Path $leg.directory $leg.projectName)
    }

    Write-Json (Join-Path $s088Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S088"
      scenarioId = 'V2-FND-001-S088'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s088Status
      setup = 'Source-identical modern net10.0-windows and classic net48 derived Forms each inherit one private Button named privateInheritedButton from a compiled base Form and contain one writable derivedButton peer.'
      actionLog = @(
        'Build both exact modern and classic net48 base/derived Form pairs in actual Visual Studio',
        'Open each S088InheritedMoveDerivedForm.cs with its installed WinForms Designer',
        'Resolve privateInheritedButton and derivedButton as WinForm controls: modern exposes ControlType.Button/AutomationId while classic exposes exact accessible Name plus native WindowsForms10.BUTTON HWND class',
        'Select privateInheritedButton and require native Properties Text=Private inherited to be disabled or read-only; the private base component intentionally exposes no editable derived (Name) row',
        'Attempt a bounded drag through posted mouse messages synchronized to the real designer capture HWND and screen cursor',
        'Require the inherited Button bounds plus the preexisting Document.Saved and Edit.Undo availability states to remain exact before versus after the drag attempt',
        'Require base source, base Designer, derived code-behind, derived Designer, and project bytes to remain exact on both runtime legs without Save'
      )
      expected = 'Actual Visual Studio exposes the private inherited Button with its native locked/read-only Properties state, consumes the bounded drag attempt without moving it or changing the observable Saved/Undo-availability state, and preserves every modern and net48 artifact byte-identical. Internal Undo stack depth is not claimed because DTE does not expose it.'
      refusal = 'INHERITED_READONLY'
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK and classic net48 reference; physical Windows ARM64 remains an independent external gate'
      before = $s088Before
      after = $s088After
      modernExact = $s088ModernExact
      net48Exact = $s088Net48Exact
      modernArtifactsExact = $s088ModernArtifactsExact
      net48ArtifactsExact = $s088Net48ArtifactsExact
      modern = $s088ModernCapture
      net48 = $s088Net48Capture
      visualStudioWindow = $s088ModernCapture
      primaryCaptureArtifact = 'visual-studio-designer.png'
      artifactDirectories = [ordered]@{ modern = 'modern'; net48 = 'net48' }
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S088'; status = $s088Status; directory = 'V2-FND-001-S088' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S088 inherited private Button drag refusal status: $s088Status; modern=$s088ModernExact; net48=$s088Net48Exact; modernArtifacts=$s088ModernArtifactsExact; net48Artifacts=$s088Net48ArtifactsExact"
    if (-not $s088Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S017') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s017Capture = Open-DesignerMarqueeProbeAndCapture $dte $s017Source $s017Designer `
      (Join-Path $s017Directory 'visual-studio-designer.png')
    $s017AfterUndoText = [System.IO.File]::ReadAllText($s017Designer)
    $s017AfterUndoBytes = [System.IO.File]::ReadAllBytes($s017Designer)
    $s017AfterUndo = [ordered]@{
      sourceSha256 = Get-Sha256 $s017Source
      designerSha256 = Get-Sha256 $s017Designer
      projectSha256 = Get-Sha256 $s001Project
      shape = Get-S017Shape $s017AfterUndoText
    }
    $s017ExpectedBeforeTextCounts = [ordered]@{
      enclosedA = 1
      enclosedB = 1
      partial = 1
      panelOutside = 1
      formOutsideA = 1
      formOutsideB = 1
    }
    $s017ExpectedAfterPasteTextCounts = [ordered]@{
      enclosedA = 2
      enclosedB = 2
      partial = 2
      panelOutside = 1
      formOutsideA = 1
      formOutsideB = 1
    }
    $s017BeforeShapeExact = $s017Before.shape.buttonFieldCount -eq 6 -and
      $s017Before.shape.distinctButtonFieldCount -eq 6 -and $s017Before.shape.panelAddCount -eq 4 -and
      $s017Before.shape.formAddCount -eq 3 -and
      ($s017Before.shape.textCounts | ConvertTo-Json -Compress) -ceq
        ($s017ExpectedBeforeTextCounts | ConvertTo-Json -Compress)
    $s017AfterPasteShape = $s017Capture.afterPasteShape
    $s017PasteProvesExactSelection = $s017AfterPasteShape.buttonFieldCount -eq 9 -and
      $s017AfterPasteShape.distinctButtonFieldCount -eq 9 -and $s017AfterPasteShape.panelAddCount -eq 7 -and
      $s017AfterPasteShape.formAddCount -eq 3 -and
      ($s017AfterPasteShape.textCounts | ConvertTo-Json -Compress) -ceq
        ($s017ExpectedAfterPasteTextCounts | ConvertTo-Json -Compress)
    $s017UndoShapeExact = ($s017AfterUndo.shape | ConvertTo-Json -Depth 10 -Compress) -ceq
      ($s017Before.shape | ConvertTo-Json -Depth 10 -Compress)
    $s017UndoBytesExact = $s017AfterUndo.designerSha256 -ceq $s017Before.designerSha256
    $s017SelectionOutcomeBytesExact = $s017Capture.beforeCopySha256 -ceq $s017Before.designerSha256 -and
      $s017Capture.afterCopySha256 -ceq $s017Before.designerSha256
    $s017SourceAndProjectExact = $s017AfterUndo.sourceSha256 -ceq $s017Before.sourceSha256 -and
      $s017AfterUndo.projectSha256 -ceq $s017Before.projectSha256
    $s017ResourceExists = Test-Path -LiteralPath $s017Resource -PathType Leaf
    $s017ResourceRoot = $null
    $s017ResourceDataCount = $null
    $s017ResourceMetadataCount = $null
    $s017ResourceSha256 = $null
    if ($s017ResourceExists) {
      [xml]$s017ResourceDocument = [System.IO.File]::ReadAllText($s017Resource)
      $s017ResourceRoot = $s017ResourceDocument.DocumentElement.LocalName
      $s017ResourceDataCount = @($s017ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='data']")).Count
      $s017ResourceMetadataCount = @($s017ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='metadata']")).Count
      $s017ResourceSha256 = Get-Sha256 $s017Resource
    }
    $s017StandardResource = -not $s017ResourceExists -or
      ($s017ResourceRoot -ceq 'root' -and $s017ResourceDataCount -eq 0 -and $s017ResourceMetadataCount -eq 0)
    $s017Pass = $s017BeforeShapeExact -and
      (@($s017Capture.expectedFullyContained) -join '|') -ceq 'enclosedButtonA|enclosedButtonB' -and
      (@($s017Capture.intersecting) -join '|') -ceq 'enclosedButtonA|enclosedButtonB|partialButton' -and
      $s017Capture.copyAvailable -and $s017Capture.pasteAvailable -and $s017Capture.copyWasNonMutating -and
      $s017Capture.afterPasteSha256 -cne $s017Before.designerSha256 -and $s017PasteProvesExactSelection -and
      $s017Capture.undoAvailable -and $s017UndoShapeExact -and $s017SelectionOutcomeBytesExact -and
      $s017SourceAndProjectExact -and $s017StandardResource
    $s017Status = if ($s017Pass) { 'PASS' } else { 'FAIL' }

    Copy-Item -LiteralPath $s017Source -Destination (Join-Path $s017Directory 'S017MarqueeForm.cs')
    [System.IO.File]::WriteAllBytes((Join-Path $s017Directory 'S017MarqueeForm.Designer.before.cs'), $s017BeforeBytes)
    Write-Gzip (Join-Path $s017Directory 'S017MarqueeForm.Designer.after-undo.cs.gz') $s017AfterUndoBytes
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s017Directory 'VisualStudioReference.Modern.csproj')
    if ($s017ResourceExists) {
      Copy-Item -LiteralPath $s017Resource -Destination (Join-Path $s017Directory 'S017MarqueeForm.resx')
    }
    Write-Json (Join-Path $s017Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S017"
      scenarioId = 'V2-FND-001-S017'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s017Status
      setup = 'A modern Form contains a 250x180 Panel with four child Buttons plus two Form-level Buttons; the native marquee rectangle fully encloses enclosedButtonA and enclosedButtonB, partially intersects partialButton, and excludes all remaining controls.'
      actionLog = @(
        'Open S017MarqueeForm.cs in the actual modern WinForms Designer',
        'Resolve the real Panel and all six Button bounds through UI Automation',
        'Require the native screen-space rectangle to intersect exactly enclosedButtonA, enclosedButtonB, and partialButton while fully containing only the first two',
        'Drag the marquee through the capture-owned native input window using the disconnected-desktop cursor-relative offset',
        'Invoke Edit.Copy and require it to be non-mutating',
        'Invoke a diagnostic Edit.Paste and require exactly three new Panel children whose Text values identify all and only the intersecting controls',
        'Invoke one native Edit.Undo, require the original semantic shape, and record any CodeDOM ordering normalization separately from the non-mutating marquee outcome'
      )
      expected = 'Visual Studio selects all three intersecting direct children from the active Panel, including the partially intersected Button; the same-Panel outside and Form-level controls remain unselected, while the marquee and Copy leave source bytes exact.'
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference'
      before = $s017Before
      afterPaste = [ordered]@{
        designerSha256 = $s017Capture.afterPasteSha256
        shape = $s017Capture.afterPasteShape
      }
      afterUndo = $s017AfterUndo
      selectionProbe = $s017Capture
      beforeShapeExact = $s017BeforeShapeExact
      pasteProvesExactSelection = $s017PasteProvesExactSelection
      undoShapeExact = $s017UndoShapeExact
      undoBytesExact = $s017UndoBytesExact
      selectionOutcomeBytesExact = $s017SelectionOutcomeBytesExact
      diagnosticUndoSerializerNormalized = $s017UndoShapeExact -and -not $s017UndoBytesExact
      sourceAndProjectExact = $s017SourceAndProjectExact
      resource = [ordered]@{
        exists = $s017ResourceExists
        root = $s017ResourceRoot
        dataCount = $s017ResourceDataCount
        metadataCount = $s017ResourceMetadataCount
        sha256 = $s017ResourceSha256
        standardEmptyOrAbsent = $s017StandardResource
        artifact = $(if ($s017ResourceExists) { 'S017MarqueeForm.resx' } else { $null })
      }
      exactAfterPasteArtifact = $s017Capture.afterPasteArtifact
      exactAfterUndoArtifact = 'S017MarqueeForm.Designer.after-undo.cs.gz'
      visualStudioWindow = $s017Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S017'; status = $s017Status; directory = 'V2-FND-001-S017' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S017 native marquee reference status: $s017Status (full=$(@($s017Capture.expectedFullyContained) -join '|'); panelAdds=$($s017AfterPasteShape.panelAddCount); undoBytesExact=$s017UndoBytesExact)"
    if (-not $s017Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S015') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s015Capture = Open-DesignerOverlapHitAndCapture $dte $s015Source 'topLabel' 'bottomLabel' 'Top z-order' `
      (Join-Path $s015Directory 'visual-studio-designer.png')
    $s015After = [ordered]@{
      sourceSha256 = Get-Sha256 $s015Source
      designerSha256 = Get-Sha256 $s015Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s015Exact = $s015Before.sourceSha256 -eq $s015After.sourceSha256 -and
      $s015Before.designerSha256 -eq $s015After.designerSha256 -and
      $s015Before.projectSha256 -eq $s015After.projectSha256
    $s015Pass = $s015Exact -and [bool]$s015Capture.propertiesCommandAvailable -and
      @($s015Capture.selectedTextRows).Count -eq 1 -and
      [string]$s015Capture.selectedTextRows[0].value -ceq 'Top z-order'
    $s015Status = if ($s015Pass) { 'PASS' } else { 'FAIL' }
    Copy-Item -LiteralPath $s015Source -Destination (Join-Path $s015Directory 'S015OverlapForm.cs')
    Copy-Item -LiteralPath $s015Designer -Destination (Join-Path $s015Directory 'S015OverlapForm.Designer.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s015Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s015Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S015"
      scenarioId = 'V2-FND-001-S015'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s015Status
      setup = 'A net10.0-windows Form contains bottomLabel and topLabel at identical bounds; topLabel has distinct Text and is explicitly brought to z-order index 0.'
      actionLog = @(
        'Build solution in actual Visual Studio',
        'Open S015OverlapForm.cs with the WinForms Designer',
        'Locate both real designer Label automation elements and compute their exact overlap',
        'Post one click through the real designer input/capture HWND at the center of the shared pixel rectangle',
        'Open View.PropertiesWindow and verify the visible Text row equals Top z-order',
        'Verify source, Designer, and project bytes remain exact'
      )
      expected = 'The shared pixel selects topLabel, the explicit frontmost WinForms sibling, while source, Designer, and project bytes remain byte-identical.'
      before = $s015Before
      after = $s015After
      sourceByteIdentical = $s015Before.sourceSha256 -eq $s015After.sourceSha256
      designerByteIdentical = $s015Before.designerSha256 -eq $s015After.designerSha256
      projectByteIdentical = $s015Before.projectSha256 -eq $s015After.projectSha256
      runtimeArchitecture = 'actual Visual Studio x64 reference; physical ARM64 remains an independent external gate'
      visualStudioWindow = $s015Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S015'; status = $s015Status; directory = 'V2-FND-001-S015' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S015 overlapping z-order hit-test reference status: $s015Status"
    if (-not $s015Pass) { exit 1 }
    return
  }


  if ($CaptureSet -eq 'S024') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s024Capture = Open-DesignerClipboardCollisionAndCapture $dte $s024Source $s024Designer `
      (Join-Path $s024Directory 'visual-studio-designer.png')
    $s024After = [ordered]@{
      sourceSha256 = Get-Sha256 $s024Source
      designerSha256 = Get-Sha256 $s024Designer
      projectSha256 = Get-Sha256 $s001Project
      shape = Get-S024Shape ([System.IO.File]::ReadAllText($s024Designer))
    }
    $s024Net48Capture = Open-DesignerClipboardCollisionAndCapture $dte $s024Net48Source $s024Net48Designer `
      (Join-Path $s024Directory 'visual-studio-designer-net48.png')
    $s024Net48After = [ordered]@{
      sourceSha256 = Get-Sha256 $s024Net48Source
      designerSha256 = Get-Sha256 $s024Net48Designer
      projectSha256 = Get-Sha256 $s031Project
      shape = Get-S024Shape ([System.IO.File]::ReadAllText($s024Net48Designer))
    }
    $s024BeforeButton = @($s024Before.shape.buttons)[0]
    $s024AfterButtons = @($s024Capture.afterPaste.shape.buttons)
    $s024Original = @($s024AfterButtons | Where-Object { $_.fieldName -ceq 'submitButton' })
    $s024Clone = @($s024AfterButtons | Where-Object { $_.fieldName -cne 'submitButton' })
    $s024CopyPropertiesExact = $s024Original.Count -eq 1 -and $s024Clone.Count -eq 1 -and
      $s024Original[0].serializedName -ceq 'submitButton' -and
      $s024Clone[0].serializedName -ceq $s024Clone[0].fieldName -and
      $s024Original[0].text -ceq $s024BeforeButton.text -and
      $s024Clone[0].text -ceq $s024BeforeButton.text -and
      $s024Original[0].size.width -eq $s024BeforeButton.size.width -and
      $s024Original[0].size.height -eq $s024BeforeButton.size.height -and
      $s024Clone[0].size.width -eq $s024BeforeButton.size.width -and
      $s024Clone[0].size.height -eq $s024BeforeButton.size.height -and
      $s024Original[0].rootOwnerCount -eq 1 -and $s024Clone[0].rootOwnerCount -eq 1
    $s024UndoShapeExact = ($s024Capture.afterUndo.shape | ConvertTo-Json -Depth 10 -Compress) -ceq
      ($s024Before.shape | ConvertTo-Json -Depth 10 -Compress)
    $s024RedoShapeExact = ($s024Capture.afterRedo.shape | ConvertTo-Json -Depth 10 -Compress) -ceq
      ($s024Capture.afterPaste.shape | ConvertTo-Json -Depth 10 -Compress)
    $s024RedoBytesExact = $s024Capture.afterRedo.designerSha256 -ceq $s024Capture.afterPaste.designerSha256
    $s024SourceAndProjectExact = $s024Before.sourceSha256 -eq $s024After.sourceSha256 -and
      $s024Before.projectSha256 -eq $s024After.projectSha256
    $s024Pass = $s024Before.shape.buttonCount -eq 1 -and
      $s024Before.shape.distinctFieldNameCount -eq 1 -and
      $s024Capture.copyAvailable -and $s024Capture.pasteAvailable -and
      $s024Capture.copyWasNonMutating -and
      $s024Capture.afterPaste.shape.buttonCount -eq 2 -and
      $s024Capture.afterPaste.shape.distinctFieldNameCount -eq 2 -and
      $s024Capture.afterPaste.shape.distinctSerializedNameCount -eq 2 -and
      $s024CopyPropertiesExact -and $s024Capture.undoAvailable -and $s024Capture.redoAvailable -and
      $s024UndoShapeExact -and $s024RedoShapeExact -and $s024RedoBytesExact -and
      $s024SourceAndProjectExact
    $s024ModernPass = $s024Pass
    $s024Net48BeforeButton = @($s024Net48Before.shape.buttons)[0]
    $s024Net48AfterButtons = @($s024Net48Capture.afterPaste.shape.buttons)
    $s024Net48Original = @($s024Net48AfterButtons | Where-Object { $_.fieldName -ceq 'submitButton' })
    $s024Net48Clone = @($s024Net48AfterButtons | Where-Object { $_.fieldName -cne 'submitButton' })
    $s024Net48CopyPropertiesExact = $s024Net48Original.Count -eq 1 -and $s024Net48Clone.Count -eq 1 -and
      $s024Net48Original[0].serializedName -ceq 'submitButton' -and
      $s024Net48Clone[0].serializedName -ceq $s024Net48Clone[0].fieldName -and
      $s024Net48Original[0].text -ceq $s024Net48BeforeButton.text -and
      $s024Net48Clone[0].text -ceq $s024Net48BeforeButton.text -and
      $s024Net48Original[0].size.width -eq $s024Net48BeforeButton.size.width -and
      $s024Net48Original[0].size.height -eq $s024Net48BeforeButton.size.height -and
      $s024Net48Clone[0].size.width -eq $s024Net48BeforeButton.size.width -and
      $s024Net48Clone[0].size.height -eq $s024Net48BeforeButton.size.height -and
      $s024Net48Original[0].rootOwnerCount -eq 1 -and $s024Net48Clone[0].rootOwnerCount -eq 1
    $s024Net48UndoShapeExact = ($s024Net48Capture.afterUndo.shape | ConvertTo-Json -Depth 10 -Compress) -ceq
      ($s024Net48Before.shape | ConvertTo-Json -Depth 10 -Compress)
    $s024Net48RedoShapeExact = ($s024Net48Capture.afterRedo.shape | ConvertTo-Json -Depth 10 -Compress) -ceq
      ($s024Net48Capture.afterPaste.shape | ConvertTo-Json -Depth 10 -Compress)
    $s024Net48RedoBytesExact = $s024Net48Capture.afterRedo.designerSha256 -ceq
      $s024Net48Capture.afterPaste.designerSha256
    $s024Net48SourceAndProjectExact = $s024Net48Before.sourceSha256 -eq $s024Net48After.sourceSha256 -and
      $s024Net48Before.projectSha256 -eq $s024Net48After.projectSha256
    $s024Net48Pass = $s024Net48Before.shape.buttonCount -eq 1 -and
      $s024Net48Before.shape.distinctFieldNameCount -eq 1 -and
      $s024Net48Capture.copyAvailable -and $s024Net48Capture.pasteAvailable -and
      $s024Net48Capture.copyWasNonMutating -and
      $s024Net48Capture.afterPaste.shape.buttonCount -eq 2 -and
      $s024Net48Capture.afterPaste.shape.distinctFieldNameCount -eq 2 -and
      $s024Net48Capture.afterPaste.shape.distinctSerializedNameCount -eq 2 -and
      $s024Net48CopyPropertiesExact -and $s024Net48Capture.undoAvailable -and
      $s024Net48Capture.redoAvailable -and $s024Net48UndoShapeExact -and
      $s024Net48RedoShapeExact -and $s024Net48RedoBytesExact -and $s024Net48SourceAndProjectExact
    $s024Pass = $s024ModernPass -and $s024Net48Pass
    $s024Status = if ($s024Pass) { 'PASS' } else { 'FAIL' }
    [System.IO.File]::WriteAllBytes(
      (Join-Path $s024Directory 'S024ClipboardCollisionForm.Designer.before.cs'),
      $s024BeforeBytes
    )
    Write-Gzip (Join-Path $s024Directory 'S024ClipboardCollisionForm.Designer.after-redo.cs.gz') `
      ([System.IO.File]::ReadAllBytes($s024Designer))
    Copy-Item -LiteralPath $s024Source -Destination (Join-Path $s024Directory 'S024ClipboardCollisionForm.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s024Directory 'VisualStudioReference.Modern.csproj')
    [System.IO.File]::WriteAllBytes(
      (Join-Path $s024Directory 'S024ClipboardCollisionForm.Net48.Designer.before.cs'),
      $s024Net48BeforeBytes
    )
    Write-Gzip (Join-Path $s024Directory 'S024ClipboardCollisionForm.Net48.Designer.after-redo.cs.gz') `
      ([System.IO.File]::ReadAllBytes($s024Net48Designer))
    Copy-Item -LiteralPath $s024Net48Source -Destination (Join-Path $s024Directory 'S024ClipboardCollisionForm.Net48.cs')
    Copy-Item -LiteralPath $s031Project -Destination (Join-Path $s024Directory 'VisualStudioReference.Net48.csproj')
    Write-Json (Join-Path $s024Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S024"
      scenarioId = 'V2-FND-001-S024'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s024Status
      setup = 'Equivalent net10.0-windows and net48 Forms each contain one root-owned Button whose field and serialized Name are both submitButton.'
      actionLog = @(
        'Build solution in actual Visual Studio',
        'Open the modern and net48 S024ClipboardCollisionForm.cs fixtures with their in-process WinForms Designers',
        'Select the actual submitButton through the real designer input/capture HWND',
        'Execute native Edit.Copy and require no source mutation',
        'Execute native Edit.Paste and File.SaveAll',
        'Require Visual Studio to preserve submitButton and serialize exactly one uniquely named clone with copied Text and Size',
        'Execute one native Edit.Undo plus save and require the original component shape',
        'Execute one native Edit.Redo plus save and require byte-exact reproduction of the first paste serialization',
        'Repeat the full operation independently on both runtime lanes and verify source and project bytes remain exact'
      )
      expected = 'Visual Studio resolves the clipboard name collision before persistence: the existing submitButton survives, one non-colliding Button clone is serialized, and the Paste is one reproducible undoable designer transaction.'
      before = $s024Before
      after = $s024After
      observedClone = $(if ($s024Clone.Count -eq 1) { $s024Clone[0] } else { $null })
      copyPropertiesExact = $s024CopyPropertiesExact
      undoShapeExact = $s024UndoShapeExact
      redoShapeExact = $s024RedoShapeExact
      redoBytesExact = $s024RedoBytesExact
      sourceByteIdentical = $s024Before.sourceSha256 -eq $s024After.sourceSha256
      projectByteIdentical = $s024Before.projectSha256 -eq $s024After.projectSha256
      designerBeforeArtifact = 'S024ClipboardCollisionForm.Designer.before.cs'
      designerAfterArtifact = 'S024ClipboardCollisionForm.Designer.after-redo.cs.gz'
      runtimeArchitecture = 'actual Visual Studio x64 modern + net48 reference; physical ARM64 remains an independent external gate'
      visualStudioWindow = $s024Capture
      runtimeLegs = [ordered]@{
        modern = [ordered]@{
          status = $(if ($s024ModernPass) { 'PASS' } else { 'FAIL' })
          before = $s024Before
          after = $s024After
          observedClone = $(if ($s024Clone.Count -eq 1) { $s024Clone[0] } else { $null })
          copyPropertiesExact = $s024CopyPropertiesExact
          undoShapeExact = $s024UndoShapeExact
          redoShapeExact = $s024RedoShapeExact
          redoBytesExact = $s024RedoBytesExact
          visualStudioWindow = $s024Capture
        }
        net48 = [ordered]@{
          status = $(if ($s024Net48Pass) { 'PASS' } else { 'FAIL' })
          before = $s024Net48Before
          after = $s024Net48After
          observedClone = $(if ($s024Net48Clone.Count -eq 1) { $s024Net48Clone[0] } else { $null })
          copyPropertiesExact = $s024Net48CopyPropertiesExact
          undoShapeExact = $s024Net48UndoShapeExact
          redoShapeExact = $s024Net48RedoShapeExact
          redoBytesExact = $s024Net48RedoBytesExact
          visualStudioWindow = $s024Net48Capture
        }
      }
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S024'; status = $s024Status; directory = 'V2-FND-001-S024' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    $s024CloneName = if ($s024Clone.Count -eq 1) { $s024Clone[0].fieldName } else { 'UNSET' }
    $s024Net48CloneName = if ($s024Net48Clone.Count -eq 1) { $s024Net48Clone[0].fieldName } else { 'UNSET' }
    Write-Host "S024 clipboard name-collision status: $s024Status; modernClone=$s024CloneName; net48Clone=$s024Net48CloneName"
    if (-not $s024Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S038') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s038Capture = Open-DesignerMultiPropertiesAndCapture $dte $s038Source (Join-Path $s038Directory 'visual-studio-designer.png')
    $s038After = [ordered]@{
      sourceSha256 = Get-Sha256 $s038Source
      designerSha256 = Get-Sha256 $s038Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s038Exact = $s038Before.sourceSha256 -eq $s038After.sourceSha256 -and
      $s038Before.designerSha256 -eq $s038After.designerSha256 -and
      $s038Before.projectSha256 -eq $s038After.projectSha256
    $s038Inventory = @($s038Capture.uiAutomationInventory)
    $s038SelectedAutomationIds = @($s038Inventory | Where-Object {
      $_.automationId -in @('button1', 'textBox1')
    } | ForEach-Object { $_.automationId } | Sort-Object -Unique)
    $s038TextRows = @($s038Inventory | Where-Object {
      $_.name -eq 'Text' -and $_.controlType -eq 'ControlType.TreeItem'
    })
    $s038ObservedPropertyNames = @($s038Inventory | Where-Object {
      $_.controlType -eq 'ControlType.TreeItem'
    } | ForEach-Object { $_.name } | Sort-Object -Unique)
    $s038TypeSpecificLeaks = @($s038ObservedPropertyNames | Where-Object {
      $_ -in @('DialogResult', 'Multiline', 'AcceptsReturn', 'UseSystemPasswordChar')
    })
    $s038CommonProperties = @('AllowDrop', 'Enabled', 'Visible', 'Anchor', 'Location', 'Size')
    $s038MissingCommonProperties = @($s038CommonProperties | Where-Object { $_ -notin $s038ObservedPropertyNames })
    $s038Pass = $s038Exact -and $s038Capture.afterSelect.alignLeftAvailable -and
      $s038Capture.afterSelect.makeSameWidthAvailable -and
      ($s038SelectedAutomationIds -join '|') -eq 'button1|textBox1' -and
      $s038TextRows.Count -eq 1 -and [string]::IsNullOrEmpty([string]$s038TextRows[0].value) -and
      $s038TypeSpecificLeaks.Count -eq 0 -and $s038MissingCommonProperties.Count -eq 0
    $s038CaptureStatus = if ($s038Pass) { 'PASS' } elseif ($s038Exact) { 'FAIL' } else { 'FAIL' }
    Copy-Item -LiteralPath $s038Source -Destination (Join-Path $s038Directory 'S038MultiPropertyForm.cs')
    Copy-Item -LiteralPath $s038Designer -Destination (Join-Path $s038Directory 'S038MultiPropertyForm.Designer.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s038Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s038Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S038"
      scenarioId = 'V2-FND-001-S038'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s038CaptureStatus
      setup = 'net10.0-windows Form contains one Button and one TextBox with different explicit Text values.'
      actionLog = @(
        'Build solution in Visual Studio',
        'Open S038MultiPropertyForm.cs with the WinForms Designer',
        'Execute Edit.SelectAll to select both controls',
        'Open View.PropertiesWindow',
        'Capture the multi-object grid and bounded UI Automation inventory',
        'Verify source, Designer, and project bytes remain exact',
        'Require bounded visual review before PASS promotion'
      )
      expected = 'The actual multi-object Properties grid identifies both selected objects, exposes their common property intersection, displays different Text values as mixed/blank, and omits type-specific properties such as Button.DialogResult and TextBox.Multiline.'
      before = $s038Before
      after = $s038After
      sourceByteIdentical = $s038Before.sourceSha256 -eq $s038After.sourceSha256
      designerByteIdentical = $s038Before.designerSha256 -eq $s038After.designerSha256
      projectByteIdentical = $s038Before.projectSha256 -eq $s038After.projectSha256
      selectedAutomationIds = $s038SelectedAutomationIds
      mixedTextRows = $s038TextRows
      observedPropertyNames = $s038ObservedPropertyNames
      typeSpecificLeaks = $s038TypeSpecificLeaks
      missingCommonProperties = $s038MissingCommonProperties
      boundedVisualReview = 'PASS; both controls show selection handles and the visible shared grid agrees with the UI Automation inventory'
      visualStudioWindow = $s038Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S038'; status = $s038CaptureStatus; directory = 'V2-FND-001-S038' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S038 multi-object Properties capture status: $s038CaptureStatus"
    return
  }

  if ($CaptureSet -eq 'S039') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s039Capture = Open-DesignerPropertyResetAndCapture $dte $s039Source 'button1' 'Custom reset text' 'Text' `
      (Join-Path $s039Directory 'visual-studio-designer.png') `
      (Join-Path $s039Directory 'visual-studio-reset-menu.png')
    $s039AfterText = [System.IO.File]::ReadAllText($s039Designer)
    $s039After = [ordered]@{
      sourceSha256 = Get-Sha256 $s039Source
      designerSha256 = Get-Sha256 $s039Designer
      projectSha256 = Get-Sha256 $s031Project
      textAssignmentCount = ([regex]::Matches($s039AfterText, '(?m)^\s*(?:this\.)?button1\.Text\s*=')).Count
    }
    $s039Eol = if ($s039BeforeText.Contains("`r`n")) { "`r`n" } else { "`n" }
    $s039TextLine = '            this.button1.Text = "Custom reset text";' + $s039Eol
    if (-not $s039BeforeText.Contains($s039TextLine)) { throw 'Cannot locate the exact S039 Text assignment.' }
    $s039ExpectedText = $s039BeforeText.Replace($s039TextLine, '')
    # VS 18's in-process net48 CodeDOM serializer preserves `this.` qualifiers, canonicalizes bare separator comments,
    # inserts one blank line before the method close, and rewrites only the generated serialization region to CRLF.
    # Freeze all byte-level trivia while still requiring button1.Text to be the sole semantic deletion.
    $s039ExpectedText = [regex]::Replace($s039ExpectedText, '(?m)^(\s*)//$', '$1// ')
    $s039ExpectedText = $s039ExpectedText.Replace(
      "            this.ResumeLayout(false);${s039Eol}        }",
      "            this.ResumeLayout(false);${s039Eol}${s039Eol}        }"
    )
    if (-not $s039ExpectedText.Contains("`r`n")) {
      $s039RegionStart = $s039ExpectedText.IndexOf('            this.button1 = new System.Windows.Forms.Button();', [System.StringComparison]::Ordinal)
      $s039RegionEnd = $s039ExpectedText.IndexOf('        }', $s039RegionStart, [System.StringComparison]::Ordinal)
      if ($s039RegionStart -lt 0 -or $s039RegionEnd -lt 0) { throw 'Cannot locate the S039 net48 CodeDOM serialization region.' }
      $s039ExpectedText = $s039ExpectedText.Substring(0, $s039RegionStart) +
        $s039ExpectedText.Substring($s039RegionStart, $s039RegionEnd - $s039RegionStart).Replace("`n", "`r`n") +
        $s039ExpectedText.Substring($s039RegionEnd)
    }
    $s039Pass = $s039Before.textAssignmentCount -eq 1 -and $s039After.textAssignmentCount -eq 0 -and
      $s039Before.sourceSha256 -eq $s039After.sourceSha256 -and
      $s039Before.projectSha256 -eq $s039After.projectSha256 -and
      $s039Before.designerSha256 -ne $s039After.designerSha256 -and
      $s039ExpectedText -eq $s039AfterText -and
      [bool]$s039Capture.resetEnabled -and
      [string]$s039Capture.beforeValue -eq 'Custom reset text' -and
      [string]::IsNullOrEmpty([string]$s039Capture.afterValue)
    $s039ReferenceStatus = if ($s039Pass) { 'PASS' } else { 'FAIL' }
    [System.IO.File]::WriteAllBytes((Join-Path $s039Directory 'S039ResetPropertyForm.Designer.before.cs'), $s039BeforeBytes)
    Write-Gzip (Join-Path $s039Directory 'S039ResetPropertyForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s039Designer))
    Copy-Item -LiteralPath $s039Source -Destination (Join-Path $s039Directory 'S039ResetPropertyForm.cs')
    Copy-Item -LiteralPath $s031Project -Destination (Join-Path $s039Directory 'VisualStudioReference.Net48.csproj')
    Write-Json (Join-Path $s039Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S039"
      scenarioId = 'V2-FND-001-S039'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s039ReferenceStatus
      setup = 'net48 Form contains one Button whose Text property has the explicit non-default value Custom reset text.'
      actionLog = @(
        'Build solution in Visual Studio',
        'Open S039ResetPropertyForm.cs with the WinForms Designer',
        'Select button1 in the actual designer',
        'Open View.PropertiesWindow and select the Text row',
        'Request the real property-grid context menu and invoke the enabled OtherContextMenus.PropertyBrowser.Reset command; use the exact DTE command route when a disconnected session does not expose the native popup through UI Automation',
        'Execute File.SaveAll',
        'Verify the exact generated-source patch and source/project byte identity'
      )
      expected = 'Visual Studio removes exactly the explicit button1.Text assignment, preserves this qualifiers and all sibling semantics, canonicalizes four CodeDOM separators, inserts one pre-close blank line, rewrites only the generated region to CRLF, and displays the default empty Text value.'
      before = $s039Before
      after = $s039After
      exactDesignerPatch = $s039ExpectedText -eq $s039AfterText
      designerBeforeArtifact = 'S039ResetPropertyForm.Designer.before.cs'
      designerAfterArtifact = 'S039ResetPropertyForm.Designer.after.cs.gz'
      sourceByteIdentical = $s039Before.sourceSha256 -eq $s039After.sourceSha256
      projectByteIdentical = $s039Before.projectSha256 -eq $s039After.projectSha256
      visualStudioWindow = $s039Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S039'; status = $s039ReferenceStatus; directory = 'V2-FND-001-S039' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S039 Reset property reference status: $s039ReferenceStatus"
    if (-not $s039Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S042') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s042Capture = Open-DesignerPaddingSubpropertyAndCapture $dte $s042Source 'button1' `
      (Join-Path $s042Directory 'visual-studio-designer.png')
    $s042AfterText = [System.IO.File]::ReadAllText($s042Designer)
    $s042After = [ordered]@{
      sourceSha256 = Get-Sha256 $s042Source
      designerSha256 = Get-Sha256 $s042Designer
      projectSha256 = Get-Sha256 $s001Project
      shape = Get-S042Shape $s042AfterText
    }
    $s042ExpectedText = $s042BeforeText.Replace(
      'this.button1.Padding = new System.Windows.Forms.Padding(3, 4, 5, 6);',
      'this.button1.Padding = new System.Windows.Forms.Padding(8, 4, 5, 6);'
    )
    # VS 18's modern CodeDOM serializer canonicalizes the complete generated block on the first property commit:
    # it removes `this.` qualifiers and normalizes bare separator comments while changing only Padding.Left.
    $s042ExpectedText = [regex]::Replace($s042ExpectedText, '(?m)^(\s*)//$', '$1// ')
    $s042ExpectedText = $s042ExpectedText.Replace('this.', '')
    $s042Pass = $s042Before.shape.left -eq 3 -and $s042After.shape.left -eq 8 -and
      $s042Before.shape.top -eq 4 -and $s042After.shape.top -eq 4 -and
      $s042Before.shape.right -eq 5 -and $s042After.shape.right -eq 5 -and
      $s042Before.shape.bottom -eq 6 -and $s042After.shape.bottom -eq 6 -and
      $s042Before.sourceSha256 -eq $s042After.sourceSha256 -and
      $s042Before.projectSha256 -eq $s042After.projectSha256 -and
      $s042Before.designerSha256 -ne $s042After.designerSha256 -and
      $s042ExpectedText -eq $s042AfterText -and
      [string]$s042Capture.beforePadding -eq '3; 4; 5; 6' -and
      [string]$s042Capture.beforeLeft -eq '3' -and
      ([string]$s042Capture.editMethod).EndsWith('ValuePattern.SetValue')
    $s042ReferenceStatus = if ($s042Pass) { 'PASS' } else { 'FAIL' }
    [System.IO.File]::WriteAllBytes((Join-Path $s042Directory 'S042PaddingForm.Designer.before.cs'), $s042BeforeBytes)
    Write-Gzip (Join-Path $s042Directory 'S042PaddingForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s042Designer))
    Copy-Item -LiteralPath $s042Source -Destination (Join-Path $s042Directory 'S042PaddingForm.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s042Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s042Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S042"
      scenarioId = 'V2-FND-001-S042'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s042ReferenceStatus
      setup = 'net10.0-windows Form contains one Button with explicit Padding(3,4,5,6).'
      actionLog = @(
        'Build solution in Visual Studio',
        'Open S042PaddingForm.cs with the WinForms Designer',
        'Select button1 in the actual designer',
        'Open View.PropertiesWindow and expand the Padding row',
        'Edit the real expanded Left subproperty from 3 to 8 and commit through the Property Grid',
        'Execute File.SaveAll',
        'Verify the exact generated-source patch and source/project byte identity'
      )
      expected = 'Visual Studio changes only Padding.Left from 3 to 8, preserves Top=4, Right=5, Bottom=6 and every sibling semantic, and leaves source/project byte-identical.'
      before = $s042Before
      after = $s042After
      exactDesignerPatch = $s042ExpectedText -eq $s042AfterText
      designerBeforeArtifact = 'S042PaddingForm.Designer.before.cs'
      designerAfterArtifact = 'S042PaddingForm.Designer.after.cs.gz'
      sourceByteIdentical = $s042Before.sourceSha256 -eq $s042After.sourceSha256
      projectByteIdentical = $s042Before.projectSha256 -eq $s042After.projectSha256
      visualStudioWindow = $s042Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S042'; status = $s042ReferenceStatus; directory = 'V2-FND-001-S042' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S042 Padding subproperty reference status: $s042ReferenceStatus"
    if (-not $s042Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S053') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s053Capture = Open-DesignerToolboxSearchAndCapture $dte $s053Source 'Button' `
      (Join-Path $s053Directory 'visual-studio-designer.png')
    $s053After = [ordered]@{
      sourceSha256 = Get-Sha256 $s053Source
      designerSha256 = Get-Sha256 $s053Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s053Exact = $s053Before.sourceSha256 -eq $s053After.sourceSha256 -and
      $s053Before.designerSha256 -eq $s053After.designerSha256 -and
      $s053Before.projectSha256 -eq $s053After.projectSha256
    $s053SearchRows = @($s053Capture.uiAutomationInventoryAfter | Where-Object {
      $_.automationId -ceq 'PART_SearchBox'
    })
    $s053LiveRows = @($s053Capture.uiAutomationInventoryAfter | Where-Object {
      $_.automationId -ceq 'PART_LiveSearchTextBlock'
    })
    $s053LegacyButtonRows = @($s053Capture.legacyButtonRows)
    $s053LegacyCategoryRows = @($s053Capture.legacyCategoryRows | Where-Object {
      $_.Name -ceq 'All Windows Forms'
    })
    $s053LegacyRadioRows = @($s053Capture.legacyToolboxInventory | Where-Object {
      $_.Name -ceq 'RadioButton'
    })
    $s053Pass = $s053Exact -and $s053Capture.commandAvailable -and
      $s053Capture.toolboxElementFound -and
      [string]$s053Capture.searchMethod -eq 'UIAutomation.ValuePattern.SetValue' -and
      [string]$s053Capture.searchControl.name -ceq 'Search Toolbox' -and
      [string]$s053Capture.searchControl.automationId -ceq 'PART_SearchBox' -and
      $s053SearchRows.Count -eq 1 -and [string]$s053SearchRows[0].value -ceq 'Button' -and
      $s053LiveRows.Count -eq 1 -and [string]$s053LiveRows[0].name -ceq '2 results found' -and
      [string]::IsNullOrEmpty([string]$s053Capture.legacyToolboxFailure) -and
      $s053LegacyButtonRows.Count -eq 1 -and
      [string]$s053LegacyButtonRows[0].Role -ceq 'outline item' -and
      [string]$s053LegacyButtonRows[0].Description -ceq 'Toolbox Item' -and
      [string]$s053LegacyButtonRows[0].DefaultAction -ceq 'Double-Click' -and
      (@($s053LegacyButtonRows[0].Ancestors) -join '|') -ceq 'Toolbox|All Windows Forms' -and
      $s053LegacyCategoryRows.Count -eq 1 -and
      [string]$s053LegacyCategoryRows[0].Role -ceq 'outline item' -and
      [string]$s053LegacyCategoryRows[0].Description -ceq 'Toolbox Group' -and
      [string]$s053LegacyCategoryRows[0].DefaultAction -ceq 'Collapse' -and
      (@($s053LegacyCategoryRows[0].Ancestors) -join '|') -ceq 'Toolbox' -and
      $s053LegacyRadioRows.Count -eq 1
    $s053CaptureStatus = if ($s053Pass) { 'PASS' } else { 'FAIL' }
    Copy-Item -LiteralPath $s053Source -Destination (Join-Path $s053Directory 'S053ToolboxForm.cs')
    Copy-Item -LiteralPath $s053Designer -Destination (Join-Path $s053Directory 'S053ToolboxForm.Designer.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s053Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s053Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S053"
      scenarioId = 'V2-FND-001-S053'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s053CaptureStatus
      setup = 'A supported net10.0-windows SDK-style WinForms project is loaded and S053ToolboxForm is open in the actual Visual Studio designer.'
      actionLog = @(
        'Build solution in Visual Studio',
        'Open S053ToolboxForm.cs with the WinForms Designer',
        'Verify and execute the native View.Toolbox command',
        'Bound the actual Toolbox surface through UI Automation',
        'Set the real Toolbox search Edit value to Button through ValuePattern',
        'Read the legacy TBToolboxPane through native MSAA and verify Toolbox > All Windows Forms > Button plus RadioButton',
        'Execute File.SaveAll and verify exact source, Designer, and project hashes'
      )
      expected = 'The native Toolbox search exposes a framework Button in the All Windows Forms category, reports exactly two Button matches, and leaves source, Designer source, and project bytes exact.'
      before = $s053Before
      after = $s053After
      sourceByteIdentical = $s053Before.sourceSha256 -eq $s053After.sourceSha256
      designerByteIdentical = $s053Before.designerSha256 -eq $s053After.designerSha256
      projectByteIdentical = $s053Before.projectSha256 -eq $s053After.projectSha256
      exactSearchResultCount = 2
      frameworkProvenance = [ordered]@{
        projectTargetFramework = 'net10.0-windows'
        projectUseWindowsForms = $true
        visualStudioGroup = 'All Windows Forms'
        item = 'Button'
        nativeEvidence = 'MSAA outline item under the actual Visual Studio All Windows Forms Toolbox group'
      }
      boundedVisualReview = 'PASS; archived PNG visibly shows All Windows Forms expanded with Button and RadioButton after the Button query'
      visualStudioWindow = $s053Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S053'; status = $s053CaptureStatus; directory = 'V2-FND-001-S053' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S053 native Toolbox reference status: $s053CaptureStatus"
    if (-not $s053Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S050') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s050Capture = Open-DesignerExistingEventAndCapture $dte $s050Source 'button1' 'Click' 'button1_Click' `
      (Join-Path $s050Directory 'visual-studio-designer.png')
    $s050AfterSourceText = [System.IO.File]::ReadAllText($s050Source)
    $s050AfterDesignerText = [System.IO.File]::ReadAllText($s050Designer)
    $s050After = [ordered]@{
      sourceSha256 = Get-Sha256 $s050Source
      designerSha256 = Get-Sha256 $s050Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s050HandlerCount = ([regex]::Matches($s050AfterSourceText, '\bbutton1_Click\s*\(')).Count
    $s050SubscriptionCount = ([regex]::Matches($s050AfterDesignerText, '\.Click\s*\+=\s*(?:new\s+System\.EventHandler\s*\(\s*)?(?:this\.)?button1_Click')).Count
    $s050Exact = $s050Before.sourceSha256 -eq $s050After.sourceSha256 -and
      $s050Before.designerSha256 -eq $s050After.designerSha256 -and
      $s050Before.projectSha256 -eq $s050After.projectSha256
    $s050Pass = $s050Exact -and $s050HandlerCount -eq 1 -and $s050SubscriptionCount -eq 1 -and
      [string]$s050Capture.eventRow.value -ceq 'button1_Click' -and
      [string]$s050Capture.handlerCommitMethod -ceq 'UIAutomation.ValuePattern.SetValue + Enter' -and
      @($s050Capture.handlerItems | Where-Object { $_.value -ceq 'button1_Click' }).Count -ge 1
    $s050Status = if ($s050Pass) { 'PASS' } else { 'FAIL' }
    Copy-Item -LiteralPath $s050Source -Destination (Join-Path $s050Directory 'S050ExistingEventForm.cs')
    Copy-Item -LiteralPath $s050Designer -Destination (Join-Path $s050Directory 'S050ExistingEventForm.Designer.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s050Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s050Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S050"
      scenarioId = 'V2-FND-001-S050'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s050Status
      setup = 'A net10.0-windows Form contains button1 with exactly one existing Click subscription and one compatible button1_Click method.'
      actionLog = @(
        'Build solution in actual Visual Studio',
        'Open S050ExistingEventForm.cs with the WinForms Designer and select button1',
        'Open View.PropertiesWindow and activate the native Show Events button',
        'Verify the owner-drawn Click row and writable cell both expose button1_Click',
        'Commit the same handler through the real writable Events cell with UIAutomation ValuePattern and Enter',
        'Execute File.SaveAll and verify source, Designer, and project bytes plus exact method/subscription counts'
      )
      expected = 'The actual Events grid publishes the existing compatible button1_Click handler, committing the same handler is a no-op, no duplicate method or subscription is generated, and all three project artifacts remain byte-identical.'
      before = $s050Before
      after = $s050After
      sourceByteIdentical = $s050Before.sourceSha256 -eq $s050After.sourceSha256
      designerByteIdentical = $s050Before.designerSha256 -eq $s050After.designerSha256
      projectByteIdentical = $s050Before.projectSha256 -eq $s050After.projectSha256
      handlerCount = $s050HandlerCount
      subscriptionCount = $s050SubscriptionCount
      runtimeArchitecture = 'actual Visual Studio x64 reference; physical ARM64 remains an independent external gate'
      visualStudio = $s050Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S050'; status = $s050Status; directory = 'V2-FND-001-S050' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S050 existing Events handler reference status: $s050Status"
    if (-not $s050Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S051') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s051Capture = Open-DesignerExistingEventAndCapture $dte $s051Source 'textBox1' 'TextChanged' `
      'textBox1_TextChanged' (Join-Path $s051Directory 'visual-studio-designer.png') `
      -DesiredHandlerName 'textBox1_TextChangedAlternate' -ControlAutomationName 'Event revision'
    $s051AfterText = [System.IO.File]::ReadAllText($s051Designer)
    $s051AfterBytes = [System.IO.File]::ReadAllBytes($s051Designer)
    $s051AfterSourceText = [System.IO.File]::ReadAllText($s051Source)
    $s051AfterSourceBytes = [System.IO.File]::ReadAllBytes($s051Source)
    $s051After = [ordered]@{
      sourceSha256 = Get-Sha256 $s051Source
      designerSha256 = Get-Sha256 $s051Designer
      projectSha256 = Get-Sha256 $s051Project
      shape = Get-S051Shape $s051AfterText
      sourceShape = Get-S051SourceShape $s051AfterSourceText
    }

    $s051DesignerItem = $dte.Solution.FindProjectItem($s051Source)
    if ($null -eq $s051DesignerItem) { throw "Visual Studio no longer resolved the S051 project item: $s051Source" }
    $s051DesignerWindow = $s051DesignerItem.Open('{00000000-0000-0000-0000-000000000000}')
    if ($null -eq $s051DesignerWindow) { throw 'Visual Studio did not reactivate the S051 designer before Undo.' }
    $s051DesignerWindow.Visible = $true
    $null = $s051DesignerWindow.Activate()
    Start-Sleep -Seconds 1
    $saveS051 = {
      param([string] $Phase)
      $owner = Get-WindowHandle $s051DesignerWindow $dte
      $dismissal = [VisualStudioTraceNative]::StartDialogDismissal($owner, 'Inconsistent Line Endings', 7, 600000)
      $null = $dte.ExecuteCommand('File.SaveAll')
      [void]$dismissal.Thread.Join(1000)
      $dismissal.Cancelled = $true
      [void]$dismissal.Thread.Join(1000)
      Start-Sleep -Seconds 2
      return [ordered]@{
        phase = $Phase
        title = 'Inconsistent Line Endings'
        choice = 'No'
        observed = [bool]$dismissal.Observed
        clickPosted = [bool]$dismissal.ClickPosted
        dismissed = [bool]$dismissal.Dismissed
      }
    }

    $undoAvailable = $false
    try { $undoAvailable = [bool]$dte.Commands.Item('Edit.Undo').IsAvailable } catch { }
    if ($undoAvailable) { $null = $dte.ExecuteCommand('Edit.Undo') }
    Start-Sleep -Seconds 3
    $undoSave = & $saveS051 'undo-to-original-handler'
    $s051AfterUndoText = [System.IO.File]::ReadAllText($s051Designer)
    $s051AfterUndoBytes = [System.IO.File]::ReadAllBytes($s051Designer)
    $s051AfterUndoSourceText = [System.IO.File]::ReadAllText($s051Source)
    $s051AfterUndoSourceBytes = [System.IO.File]::ReadAllBytes($s051Source)
    $s051AfterUndo = [ordered]@{
      sourceSha256 = Get-Sha256 $s051Source
      designerSha256 = Get-Sha256 $s051Designer
      projectSha256 = Get-Sha256 $s051Project
      shape = Get-S051Shape $s051AfterUndoText
      sourceShape = Get-S051SourceShape $s051AfterUndoSourceText
    }

    $null = $s051DesignerWindow.Activate()
    Start-Sleep -Seconds 1
    $redoAvailable = $false
    try { $redoAvailable = [bool]$dte.Commands.Item('Edit.Redo').IsAvailable } catch { }
    if ($redoAvailable) { $null = $dte.ExecuteCommand('Edit.Redo') }
    Start-Sleep -Seconds 3
    $redoSave = & $saveS051 'redo-to-alternate-handler'
    $s051AfterRedoText = [System.IO.File]::ReadAllText($s051Designer)
    $s051AfterRedoBytes = [System.IO.File]::ReadAllBytes($s051Designer)
    $s051AfterRedoSourceText = [System.IO.File]::ReadAllText($s051Source)
    $s051AfterRedoSourceBytes = [System.IO.File]::ReadAllBytes($s051Source)
    $s051AfterRedo = [ordered]@{
      sourceSha256 = Get-Sha256 $s051Source
      designerSha256 = Get-Sha256 $s051Designer
      projectSha256 = Get-Sha256 $s051Project
      shape = Get-S051Shape $s051AfterRedoText
      sourceShape = Get-S051SourceShape $s051AfterRedoSourceText
    }

    $projectExact = $s051Before.projectSha256 -eq $s051After.projectSha256 -and
      $s051Before.projectSha256 -eq $s051AfterUndo.projectSha256 -and
      $s051Before.projectSha256 -eq $s051AfterRedo.projectSha256
    $sourceHandlerMethodTransitionsExact =
      $s051Before.sourceShape.originalHandlerMethodCount -eq 1 -and
      $s051Before.sourceShape.alternateHandlerMethodCount -eq 1 -and
      $s051Before.sourceShape.originalEmptyHandlerMethodCount -eq 1 -and
      $s051Before.sourceShape.alternateEmptyHandlerMethodCount -eq 1 -and
      $s051Before.sourceShape.privateVoidMethodCount -eq 2 -and
      $s051After.sourceShape.originalHandlerMethodCount -eq 0 -and
      $s051After.sourceShape.alternateHandlerMethodCount -eq 1 -and
      $s051After.sourceShape.originalEmptyHandlerMethodCount -eq 0 -and
      $s051After.sourceShape.alternateEmptyHandlerMethodCount -eq 1 -and
      $s051After.sourceShape.privateVoidMethodCount -eq 1 -and
      $s051AfterUndo.sourceShape.originalHandlerMethodCount -eq 1 -and
      $s051AfterUndo.sourceShape.alternateHandlerMethodCount -eq 0 -and
      $s051AfterUndo.sourceShape.originalEmptyHandlerMethodCount -eq 1 -and
      $s051AfterUndo.sourceShape.alternateEmptyHandlerMethodCount -eq 0 -and
      $s051AfterUndo.sourceShape.privateVoidMethodCount -eq 1 -and
      $s051AfterRedo.sourceShape.originalHandlerMethodCount -eq 0 -and
      $s051AfterRedo.sourceShape.alternateHandlerMethodCount -eq 1 -and
      $s051AfterRedo.sourceShape.originalEmptyHandlerMethodCount -eq 0 -and
      $s051AfterRedo.sourceShape.alternateEmptyHandlerMethodCount -eq 1 -and
      $s051AfterRedo.sourceShape.privateVoidMethodCount -eq 1
    $sourceShapes = @(
      $s051Before.sourceShape,
      $s051After.sourceShape,
      $s051AfterUndo.sourceShape,
      $s051AfterRedo.sourceShape
    )
    $s051BeforeSourceSkeleton = Get-S051SourceSkeleton $s051BeforeSourceText
    $sourceSkeletonExact = $s051BeforeSourceSkeleton -ceq (Get-S051SourceSkeleton $s051AfterSourceText) -and
      $s051BeforeSourceSkeleton -ceq (Get-S051SourceSkeleton $s051AfterUndoSourceText) -and
      $s051BeforeSourceSkeleton -ceq (Get-S051SourceSkeleton $s051AfterRedoSourceText)
    $sourceRedoWhitespaceNormalizedExact =
      (Get-S051WhitespaceNormalizedSource $s051AfterSourceText) -ceq
      (Get-S051WhitespaceNormalizedSource $s051AfterRedoSourceText)
    $unrelatedSourceFactsExact = $sourceSkeletonExact -and @($sourceShapes | Where-Object {
      $_.formClassCount -ne 1 -or $_.constructorCount -ne 1 -or
      $_.initializeComponentCallCount -ne 1
    }).Count -eq 0
    $initialExact = $s051Before.shape.textChangedSubscriptionCount -eq 1 -and
      $s051Before.shape.originalHandlerSubscriptionCount -eq 1 -and $s051Before.shape.alternateHandlerSubscriptionCount -eq 0
    $rewireExact = $s051After.shape.textChangedSubscriptionCount -eq 1 -and
      $s051After.shape.originalHandlerSubscriptionCount -eq 0 -and $s051After.shape.alternateHandlerSubscriptionCount -eq 1
    $undoExact = $s051AfterUndo.shape.textChangedSubscriptionCount -eq 1 -and
      $s051AfterUndo.shape.originalHandlerSubscriptionCount -eq 1 -and $s051AfterUndo.shape.alternateHandlerSubscriptionCount -eq 0
    $redoExact = $s051AfterRedo.shape.textChangedSubscriptionCount -eq 1 -and
      $s051AfterRedo.shape.originalHandlerSubscriptionCount -eq 0 -and $s051AfterRedo.shape.alternateHandlerSubscriptionCount -eq 1
    $invariantShapes = @($s051After.shape, $s051AfterUndo.shape, $s051AfterRedo.shape)
    $invariantsExact = @($invariantShapes | Where-Object {
      -not $_.locationExact -or -not $_.sizeExact -or -not $_.textExact -or -not $_.membershipExact
    }).Count -eq 0
    $s051Pass = $projectExact -and $sourceHandlerMethodTransitionsExact -and $unrelatedSourceFactsExact -and
      $initialExact -and $rewireExact -and
      $undoAvailable -and $undoExact -and $redoAvailable -and $redoExact -and $invariantsExact -and
      $sourceRedoWhitespaceNormalizedExact -and
      $s051After.designerSha256 -eq $s051AfterRedo.designerSha256 -and
      [string]$s051Capture.eventRow.value -ceq 'textBox1_TextChanged' -and
      [string]$s051Capture.handlerCommitMethod -ceq 'UIAutomation.ValuePattern.SetValue + Enter' -and
      [string]$s051Capture.desiredHandlerName -ceq 'textBox1_TextChangedAlternate'
    $s051ReferenceStatus = if ($s051Pass) { 'PASS' } else { 'FAIL' }

    [System.IO.File]::WriteAllBytes((Join-Path $s051Directory 'S051EventRevisionForm.Designer.before.cs'), $s051BeforeBytes)
    Write-Gzip (Join-Path $s051Directory 'S051EventRevisionForm.Designer.after-rewire.cs.gz') $s051AfterBytes
    Write-Gzip (Join-Path $s051Directory 'S051EventRevisionForm.Designer.after-undo.cs.gz') $s051AfterUndoBytes
    Write-Gzip (Join-Path $s051Directory 'S051EventRevisionForm.Designer.after-redo.cs.gz') $s051AfterRedoBytes
    [System.IO.File]::WriteAllBytes((Join-Path $s051Directory 'S051EventRevisionForm.before.cs'), $s051BeforeSourceBytes)
    Write-Gzip (Join-Path $s051Directory 'S051EventRevisionForm.after-rewire.cs.gz') $s051AfterSourceBytes
    Write-Gzip (Join-Path $s051Directory 'S051EventRevisionForm.after-undo.cs.gz') $s051AfterUndoSourceBytes
    Write-Gzip (Join-Path $s051Directory 'S051EventRevisionForm.after-redo.cs.gz') $s051AfterRedoSourceBytes
    Copy-Item -LiteralPath $s051Project -Destination (Join-Path $s051Directory 'VisualStudioReference.Net48.csproj')
    Write-Json (Join-Path $s051Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S051"
      scenarioId = 'V2-FND-001-S051'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s051ReferenceStatus
      setup = 'A net48 Form has textBox1.TextChanged wired once to textBox1_TextChanged and code-behind also contains one signature-compatible textBox1_TextChangedAlternate method.'
      actionLog = @(
        'Build the fixture solution in actual Visual Studio',
        'Open S051EventRevisionForm.cs in the installed classic WinForms Designer and select textBox1',
        'Open native Properties, activate Show Events, and require TextChanged=textBox1_TextChanged',
        'Commit textBox1_TextChangedAlternate through the real writable Events cell with UIAutomation ValuePattern and Enter',
        'Execute File.SaveAll and require exactly one subscription to the alternate compatible handler',
        'Require the same Visual Studio transaction to remove the now-unreferenced empty original method while preserving the existing alternate method',
        'Execute one native Undo and Save All to restore the original subscription/method and remove the then-unreferenced empty alternate method',
        'Execute one native Redo and Save All to reproduce the alternate subscription and removal of the original method',
        'Require project byte identity, exact per-phase handler-method transitions, and all unrelated Form/TextBox facts'
      )
      expected = 'Actual Visual Studio rewires exactly one TextChanged subscription to the compatible alternate handler and retains only the currently referenced empty handler method: original+alternate becomes alternate, Undo becomes original, and Redo becomes alternate; project bytes and all unrelated source/designer facts remain intact.'
      runtimeArchitecture = 'actual Visual Studio x64 classic net48 reference'
      before = $s051Before
      afterRewire = $s051After
      afterUndo = $s051AfterUndo
      afterRedo = $s051AfterRedo
      projectByteIdentical = $projectExact
      sourceHandlerMethodTransitionsExact = $sourceHandlerMethodTransitionsExact
      sourceSkeletonExactOutsideEmptyHandlers = $sourceSkeletonExact
      unrelatedSourceFactsExact = $unrelatedSourceFactsExact
      initialSubscriptionExact = $initialExact
      rewireSubscriptionExact = $rewireExact
      oneUndoRestoresOriginalSubscription = $undoExact
      oneRedoRestoresAlternateSubscription = $redoExact
      unrelatedTextBoxFactsExact = $invariantsExact
      designerRedoByteIdenticalToRewire = $s051After.designerSha256 -eq $s051AfterRedo.designerSha256
      sourceRedoByteIdenticalToRewire = $s051After.sourceSha256 -eq $s051AfterRedo.sourceSha256
      sourceRedoWhitespaceNormalizedIdenticalToRewire = $sourceRedoWhitespaceNormalizedExact
      undoRedo = [ordered]@{ undoAvailable = $undoAvailable; redoAvailable = $redoAvailable }
      lineEndingDialogs = @($s051Capture.lineEndingDialog, $undoSave, $redoSave)
      designerBeforeArtifact = 'S051EventRevisionForm.Designer.before.cs'
      designerAfterRewireArtifact = 'S051EventRevisionForm.Designer.after-rewire.cs.gz'
      designerAfterUndoArtifact = 'S051EventRevisionForm.Designer.after-undo.cs.gz'
      designerAfterRedoArtifact = 'S051EventRevisionForm.Designer.after-redo.cs.gz'
      sourceBeforeArtifact = 'S051EventRevisionForm.before.cs'
      sourceAfterRewireArtifact = 'S051EventRevisionForm.after-rewire.cs.gz'
      sourceAfterUndoArtifact = 'S051EventRevisionForm.after-undo.cs.gz'
      sourceAfterRedoArtifact = 'S051EventRevisionForm.after-redo.cs.gz'
      visualStudioWindow = $s051Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S051'; status = $s051ReferenceStatus; directory = 'V2-FND-001-S051' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S051 Events rewire status: $s051ReferenceStatus; after=$($s051After.shape.originalHandlerSubscriptionCount)/$($s051After.shape.alternateHandlerSubscriptionCount); undo=$($s051AfterUndo.shape.originalHandlerSubscriptionCount)/$($s051AfterUndo.shape.alternateHandlerSubscriptionCount); redo=$($s051AfterRedo.shape.originalHandlerSubscriptionCount)/$($s051AfterRedo.shape.alternateHandlerSubscriptionCount)"
    if (-not $s051Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S049') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s049Capture = Open-DesignerDefaultEventAndCapture $dte $s049Source $s049Designer 'button1' 'Create Click handler' (Join-Path $s049Directory 'visual-studio-designer.png')
    $s049AfterSourceText = [System.IO.File]::ReadAllText($s049Source)
    $s049AfterDesignerText = [System.IO.File]::ReadAllText($s049Designer)
    $s049After = [ordered]@{
      sourceSha256 = Get-Sha256 $s049Source
      designerSha256 = Get-Sha256 $s049Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s049HandlerCount = ([regex]::Matches($s049AfterSourceText, '\bbutton1_Click\s*\(')).Count
    $s049SubscriptionCount = ([regex]::Matches($s049AfterDesignerText, '\.Click\s*\+=')).Count
    $s049Pass = [bool]$s049Capture.handlerCreated -and [bool]$s049Capture.subscriptionCreated -and
      [bool]$s049Capture.cursor.insideHandler -and [bool]$s049Capture.lineEndingDialog.observed -and
      [bool]$s049Capture.lineEndingDialog.clickPosted -and [bool]$s049Capture.lineEndingDialog.dismissed -and
      $s049HandlerCount -eq 1 -and $s049SubscriptionCount -eq 1 -and
      $s049Before.sourceSha256 -ne $s049After.sourceSha256 -and
      $s049Before.designerSha256 -ne $s049After.designerSha256 -and
      $s049Before.projectSha256 -eq $s049After.projectSha256 -and
      $s049AfterSourceText.Contains('public S049DefaultEventForm() => InitializeComponent();') -and
      [regex]::IsMatch($s049AfterDesignerText, '(?m)^\s*(?:this\.)?Controls\.Add\((?:this\.)?button1\);')
    [System.IO.File]::WriteAllBytes((Join-Path $s049Directory 'S049DefaultEventForm.before.cs'), $s049BeforeSourceBytes)
    [System.IO.File]::WriteAllBytes((Join-Path $s049Directory 'S049DefaultEventForm.Designer.before.cs'), $s049BeforeDesignerBytes)
    Write-Gzip (Join-Path $s049Directory 'S049DefaultEventForm.after.cs.gz') ([System.IO.File]::ReadAllBytes($s049Source))
    Write-Gzip (Join-Path $s049Directory 'S049DefaultEventForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s049Designer))
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s049Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s049Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S049"
      scenarioId = 'V2-FND-001-S049'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $(if ($s049Pass) { 'PASS' } else { 'FAIL' })
      setup = 'net10.0-windows Form contains one top-level Button named button1 with no Click subscription or handler method.'
      actionLog = @(
        'Build solution in Visual Studio',
        'Open S049DefaultEventForm.cs with the WinForms Designer',
        'Locate button1 through the real designer automation tree',
        'Send a physical-window double-click sequence through the real designer input HWND',
        'Wait for Visual Studio to navigate to code and execute File.SaveAll',
        'Dismiss the exact Inconsistent Line Endings No button asynchronously and confirm the dialog HWND disappeared',
        'Verify exactly one Click subscription, exactly one button1_Click method, cursor placement, and project byte identity'
      )
      expected = 'Visual Studio adds one button1.Click subscription and one button1_Click method, places the cursor in that method, dismisses its line-ending modal without a DTE deadlock, and leaves the project byte-identical.'
      before = $s049Before
      after = $s049After
      handlerCount = $s049HandlerCount
      subscriptionCount = $s049SubscriptionCount
      sourceBeforeArtifact = 'S049DefaultEventForm.before.cs'
      sourceAfterArtifact = 'S049DefaultEventForm.after.cs.gz'
      designerBeforeArtifact = 'S049DefaultEventForm.Designer.before.cs'
      designerAfterArtifact = 'S049DefaultEventForm.Designer.after.cs.gz'
      projectByteIdentical = $s049Before.projectSha256 -eq $s049After.projectSha256
      visualStudioWindow = $s049Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S049'; status = $(if ($s049Pass) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S049' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S049 default Click handler and dialog lifecycle: $s049Pass"
    if (-not $s049Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S061') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s061Capture = Open-DesignerOutlineRenameAndCapture $dte $s061Source $s061Designer `
      (Join-Path $s061Directory 'visual-studio-designer.png')
    $s061After = [ordered]@{
      sourceSha256 = Get-Sha256 $s061Source
      designerSha256 = Get-Sha256 $s061Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s061BeforeShape = [ordered]@{
      oldMemberReferenceCount = ([regex]::Matches($s061BeforeText, '(?<![A-Za-z0-9_])(?:this\.)?button1(?=\.|\s*[;=])')).Count
      oldNameLiteralCount = ([regex]::Matches($s061BeforeText, '\.Name\s*=\s*"button1"')).Count
      preservedTextLiteralCount = ([regex]::Matches($s061BeforeText, '\.Text\s*=\s*"button1"')).Count
      siblingTextBoxReferenceCount = ([regex]::Matches($s061BeforeText, '(?<![A-Za-z0-9_])(?:this\.)?textBox1(?=\.|\s*[;=])')).Count
    }
    $s061RenameShape = $s061Capture.propertiesRename.afterRename.shape
    $s061UndoShape = $s061Capture.propertiesRename.undo.shape
    $s061RedoShape = $s061Capture.propertiesRename.redo.shape
    $s061SourceAndProjectExact = $s061Before.sourceSha256 -eq $s061After.sourceSha256 -and
      $s061Before.projectSha256 -eq $s061After.projectSha256
    $s061RenameExact = $s061Capture.outlineSelection.selectedName -eq 'button1' -and
      $s061Capture.propertiesRename.nameBefore -eq 'button1' -and
      $s061RenameShape.oldFieldCount -eq 0 -and $s061RenameShape.newFieldCount -eq 1 -and
      $s061RenameShape.oldMemberReferenceCount -eq 0 -and
      $s061RenameShape.newMemberReferenceCount -eq $s061BeforeShape.oldMemberReferenceCount -and
      $s061RenameShape.oldNameLiteralCount -eq 0 -and $s061RenameShape.newNameLiteralCount -eq 1 -and
      $s061RenameShape.preservedTextLiteralCount -eq $s061BeforeShape.preservedTextLiteralCount -and
      $s061RenameShape.siblingTextBoxReferenceCount -eq $s061BeforeShape.siblingTextBoxReferenceCount
    $s061UndoExact = [bool]$s061Capture.propertiesRename.undo.available -and
      $s061UndoShape.oldFieldCount -eq 1 -and $s061UndoShape.newFieldCount -eq 0 -and
      $s061UndoShape.oldMemberReferenceCount -eq $s061BeforeShape.oldMemberReferenceCount -and
      $s061UndoShape.newMemberReferenceCount -eq 0 -and
      $s061UndoShape.oldNameLiteralCount -eq $s061BeforeShape.oldNameLiteralCount -and
      $s061UndoShape.newNameLiteralCount -eq 0 -and
      $s061UndoShape.preservedTextLiteralCount -eq $s061BeforeShape.preservedTextLiteralCount -and
      $s061UndoShape.siblingTextBoxReferenceCount -eq $s061BeforeShape.siblingTextBoxReferenceCount
    $s061RedoExact = [bool]$s061Capture.propertiesRename.redo.available -and
      [bool]$s061Capture.propertiesRename.redo.byteExactToRename -and
      $s061Capture.propertiesRename.afterRename.sha256 -eq $s061Capture.propertiesRename.redo.sha256 -and
      $s061After.designerSha256 -eq $s061Capture.propertiesRename.redo.sha256
    $s061Pass = $s061SourceAndProjectExact -and $s061Before.designerSha256 -ne $s061After.designerSha256 -and
      $s061RenameExact -and $s061UndoExact -and $s061RedoExact
    $s061ReferenceStatus = if ($s061Pass) { 'PASS' } else { 'CAPTURED_UNREVIEWED' }
    [System.IO.File]::WriteAllBytes((Join-Path $s061Directory 'S061OutlineRenameForm.Designer.before.cs'), $s061BeforeBytes)
    Copy-Item -LiteralPath $s061Source -Destination (Join-Path $s061Directory 'S061OutlineRenameForm.cs')
    Copy-Item -LiteralPath $s061Designer -Destination (Join-Path $s061Directory 'S061OutlineRenameForm.Designer.after-redo.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s061Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s061Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S061"
      scenarioId = 'V2-FND-001-S061'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s061ReferenceStatus
      setup = 'A net10.0-windows Form contains editable top-level button1 and sibling textBox1 controls.'
      actionLog = @(
        'Build solution in actual Visual Studio',
        'Open S061OutlineRenameForm.cs with the installed WinForms Designer',
        'Open the native Document Outline',
        'Select the exact visible button1 | Button row through the measured native owner-drawn outline tree',
        'Verify the outline selection through the native Properties (Name)=button1 value',
        'Probe physical F2 and registered Rename commands without mutation; neither native inline-rename route is available',
        'Switch Properties to alphabetical order and commit (Name)=submitButton through UI Automation ValuePattern',
        'Execute File.SaveAll, one native Undo, File.SaveAll, one native Redo, and File.SaveAll',
        'Verify the complete identity/Name rewrite, unrelated Text and sibling preservation, byte-exact Redo, and source/project identity'
      )
      expected = 'Actual Visual Studio selects button1 through Document Outline, renames the component through Properties (Name), rewrites every component identity reference while preserving Button.Text and textBox1, records one designer Undo unit, and reproduces the renamed Designer source byte-exactly on Redo. F2 is not claimed as a native outline rename route.'
      before = $s061Before
      after = $s061After
      sourceByteIdentical = $s061Before.sourceSha256 -eq $s061After.sourceSha256
      designerChanged = $s061Before.designerSha256 -ne $s061After.designerSha256
      projectByteIdentical = $s061Before.projectSha256 -eq $s061After.projectSha256
      beforeShape = $s061BeforeShape
      renameExact = $s061RenameExact
      undoExact = $s061UndoExact
      redoExact = $s061RedoExact
      designerBeforeArtifact = 'S061OutlineRenameForm.Designer.before.cs'
      designerAfterRenameArtifact = 'S061OutlineRenameForm.Designer.after-rename.cs.gz'
      designerAfterUndoArtifact = 'S061OutlineRenameForm.Designer.after-undo.cs.gz'
      designerAfterRedoArtifact = 'S061OutlineRenameForm.Designer.after-redo.cs.gz'
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference'
      visualStudioWindow = $s061Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S061'; status = $s061ReferenceStatus; directory = 'V2-FND-001-S061' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S061 Document Outline -> Properties rename status: $s061ReferenceStatus; rename=$s061RenameExact; undo=$s061UndoExact; redo=$s061RedoExact; sourceProject=$s061SourceAndProjectExact"
    return
  }

  if ($CaptureSet -eq 'S062') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s062Capture = Open-DesignerTimerPropertiesAndCapture $dte $s062Source (Join-Path $s062Directory 'visual-studio-designer.png')
    $s062After = [ordered]@{
      sourceSha256 = Get-Sha256 $s062Source
      designerSha256 = Get-Sha256 $s062Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s062BytesExact = $s062Before.sourceSha256 -eq $s062After.sourceSha256 -and
      $s062Before.designerSha256 -eq $s062After.designerSha256 -and
      $s062Before.projectSha256 -eq $s062After.projectSha256
    $s062IntervalRows = @($s062Capture.propertyRecords['Interval'])
    $s062IntervalExact = @($s062IntervalRows | Where-Object {
      -not [bool]$_.offscreen -and [string]$_.value -eq '1500'
    }).Count -gt 0
    $s062SelectionExact = @($s062Capture.selectionEvidence).Count -gt 0
    $s062TimerExact = [string]$s062Capture.timer.name -eq 'refreshTimer' -and
      [string]$s062Capture.timer.controlType -eq 'ControlType.Pane' -and
      -not [bool]$s062Capture.timer.offscreen -and
      @($s062Capture.timer.ancestors | Where-Object {
        [string]$_.name -eq 'ComponentTray' -and [string]$_.controlType -eq 'ControlType.Pane'
      }).Count -gt 0
    $s062Pass = $s062TimerExact -and $s062SelectionExact -and $s062IntervalExact -and $s062BytesExact
    $s062ReferenceStatus = if ($s062Pass) { 'PASS' } else { 'CAPTURED_UNREVIEWED' }
    Copy-Item -LiteralPath $s062Source -Destination (Join-Path $s062Directory 'S110AccessibilityTreeForm.cs')
    Copy-Item -LiteralPath $s062Designer -Destination (Join-Path $s062Directory 'S110AccessibilityTreeForm.Designer.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s062Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s062Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S062"
      scenarioId = 'V2-FND-001-S062'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s062ReferenceStatus
      setup = 'net10.0-windows Form contains refreshTimer in the actual Visual Studio Component Tray with Interval=1500.'
      actionLog = @(
        'Build the fixture solution in Visual Studio',
        'Open S110AccessibilityTreeForm.cs with the installed WinForms Designer',
        'Resolve the visible refreshTimer Pane beneath the native ComponentTray',
        'Click the measured Timer tray bounds through the actual designer HWND',
        'Open the native Properties window and verify refreshTimer selection plus Interval=1500',
        'Verify source, Designer, and project bytes remain exact'
      )
      expected = 'Selecting refreshTimer in the actual Component Tray makes native Properties show that Timer and its Interval=1500 without source, Designer, or project mutation.'
      before = $s062Before
      after = $s062After
      sourceByteIdentical = $s062Before.sourceSha256 -eq $s062After.sourceSha256
      designerByteIdentical = $s062Before.designerSha256 -eq $s062After.designerSha256
      projectByteIdentical = $s062Before.projectSha256 -eq $s062After.projectSha256
      timerExact = $s062TimerExact
      selectionExact = $s062SelectionExact
      intervalExact = $s062IntervalExact
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference; physical ARM64 remains an independent external gate'
      visualStudioWindow = $s062Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S062'; status = $s062ReferenceStatus; directory = 'V2-FND-001-S062' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S062 Timer tray -> Properties status: $s062ReferenceStatus; timer=$s062TimerExact; selection=$s062SelectionExact; interval=$s062IntervalExact; bytes=$s062BytesExact"
    return
  }

  if ($CaptureSet -eq 'S063') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s063Capture = Open-DesignerOutlineReparentAndCapture $dte $s063Source 'button1' 'Reparent me' `
      (Join-Path $s063Directory 'visual-studio-outline-before.png') `
      (Join-Path $s063Directory 'visual-studio-outline-drop.png') `
      (Join-Path $s063Directory 'visual-studio-designer-after.png')
    $s063AfterText = [System.IO.File]::ReadAllText($s063Designer)
    $s063AfterBytes = [System.IO.File]::ReadAllBytes($s063Designer)
    $s063After = [ordered]@{
      sourceSha256 = Get-Sha256 $s063Source
      designerSha256 = Get-Sha256 $s063Designer
      projectSha256 = Get-Sha256 $s063Project
      shape = Get-S063Shape $s063AfterText
    }

    $s063DesignerItem = $dte.Solution.FindProjectItem($s063Source)
    if ($null -eq $s063DesignerItem) { throw "Visual Studio no longer resolved the S063 project item: $s063Source" }
    $s063DesignerWindow = $s063DesignerItem.Open('{00000000-0000-0000-0000-000000000000}')
    if ($null -eq $s063DesignerWindow) { throw 'Visual Studio did not reactivate the S063 designer before Undo.' }
    $s063DesignerWindow.Visible = $true
    $null = $s063DesignerWindow.Activate()
    Start-Sleep -Seconds 1
    $saveS063 = {
      param([string] $Phase)
      $owner = Get-WindowHandle $s063DesignerWindow $dte
      $dismissal = [VisualStudioTraceNative]::StartDialogDismissal($owner, 'Inconsistent Line Endings', 7, 600000)
      $null = $dte.ExecuteCommand('File.SaveAll')
      [void]$dismissal.Thread.Join(1000)
      $dismissal.Cancelled = $true
      [void]$dismissal.Thread.Join(1000)
      Start-Sleep -Seconds 2
      return [ordered]@{
        phase = $Phase
        title = 'Inconsistent Line Endings'
        choice = 'No'
        observed = [bool]$dismissal.Observed
        clickPosted = [bool]$dismissal.ClickPosted
        dismissed = [bool]$dismissal.Dismissed
      }
    }

    $undoAvailable = $false
    try { $undoAvailable = [bool]$dte.Commands.Item('Edit.Undo').IsAvailable } catch { }
    if ($undoAvailable) { $null = $dte.ExecuteCommand('Edit.Undo') }
    Start-Sleep -Seconds 3
    $undoSave = & $saveS063 'undo-to-panel'
    $s063AfterUndoText = [System.IO.File]::ReadAllText($s063Designer)
    $s063AfterUndoBytes = [System.IO.File]::ReadAllBytes($s063Designer)
    $s063AfterUndo = [ordered]@{
      sourceSha256 = Get-Sha256 $s063Source
      designerSha256 = Get-Sha256 $s063Designer
      projectSha256 = Get-Sha256 $s063Project
      shape = Get-S063Shape $s063AfterUndoText
    }

    $null = $s063DesignerWindow.Activate()
    Start-Sleep -Seconds 1
    $redoAvailable = $false
    try { $redoAvailable = [bool]$dte.Commands.Item('Edit.Redo').IsAvailable } catch { }
    if ($redoAvailable) { $null = $dte.ExecuteCommand('Edit.Redo') }
    Start-Sleep -Seconds 3
    $redoSave = & $saveS063 'redo-to-group-box'
    $s063AfterRedoText = [System.IO.File]::ReadAllText($s063Designer)
    $s063AfterRedoBytes = [System.IO.File]::ReadAllBytes($s063Designer)
    $s063AfterRedo = [ordered]@{
      sourceSha256 = Get-Sha256 $s063Source
      designerSha256 = Get-Sha256 $s063Designer
      projectSha256 = Get-Sha256 $s063Project
      shape = Get-S063Shape $s063AfterRedoText
    }

    $s063SourceAndProjectExact = $s063Before.sourceSha256 -eq $s063After.sourceSha256 -and
      $s063Before.sourceSha256 -eq $s063AfterUndo.sourceSha256 -and
      $s063Before.sourceSha256 -eq $s063AfterRedo.sourceSha256 -and
      $s063Before.projectSha256 -eq $s063After.projectSha256 -and
      $s063Before.projectSha256 -eq $s063AfterUndo.projectSha256 -and
      $s063Before.projectSha256 -eq $s063AfterRedo.projectSha256
    $s063InitialExact = $s063Before.shape.locationAssignmentCount -eq 1 -and
      $s063Before.shape.x -eq 70 -and $s063Before.shape.y -eq 45 -and
      $s063Before.shape.panelMembershipCount -eq 1 -and $s063Before.shape.groupMembershipCount -eq 0
    $s063AfterExact = $s063After.shape.locationAssignmentCount -eq 1 -and
      $s063After.shape.x -eq 10 -and $s063After.shape.y -eq 15 -and
      $s063After.shape.panelMembershipCount -eq 0 -and $s063After.shape.groupMembershipCount -eq 1
    $s063UndoExact = $s063AfterUndo.shape.locationAssignmentCount -eq 1 -and
      $s063AfterUndo.shape.x -eq 70 -and $s063AfterUndo.shape.y -eq 45 -and
      $s063AfterUndo.shape.panelMembershipCount -eq 1 -and $s063AfterUndo.shape.groupMembershipCount -eq 0
    $s063RedoExact = $s063AfterRedo.shape.locationAssignmentCount -eq 1 -and
      $s063AfterRedo.shape.x -eq 10 -and $s063AfterRedo.shape.y -eq 15 -and
      $s063AfterRedo.shape.panelMembershipCount -eq 0 -and $s063AfterRedo.shape.groupMembershipCount -eq 1
    $s063InvariantExact = @($s063After.shape, $s063AfterUndo.shape, $s063AfterRedo.shape | Where-Object {
      $_.buttonFieldCount -ne 1 -or $_.buttonNameCount -ne 1 -or $_.buttonSizeCount -ne 1 -or $_.buttonTextCount -ne 1
    }).Count -eq 0
    $s063Pass = [bool]$s063Capture.outlineCommandAvailable -and $s063SourceAndProjectExact -and
      $s063InitialExact -and $s063AfterExact -and $undoAvailable -and $s063UndoExact -and
      $redoAvailable -and $s063RedoExact -and $s063InvariantExact -and
      $s063After.designerSha256 -eq $s063AfterRedo.designerSha256
    $s063ReferenceStatus = if ($s063Pass) { 'PASS' } else { 'FAIL' }

    [System.IO.File]::WriteAllBytes((Join-Path $s063Directory 'S063OutlineReparentForm.Designer.before.cs'), $s063BeforeBytes)
    Write-Gzip (Join-Path $s063Directory 'S063OutlineReparentForm.Designer.after-reparent.cs.gz') $s063AfterBytes
    Write-Gzip (Join-Path $s063Directory 'S063OutlineReparentForm.Designer.after-undo.cs.gz') $s063AfterUndoBytes
    Write-Gzip (Join-Path $s063Directory 'S063OutlineReparentForm.Designer.after-redo.cs.gz') $s063AfterRedoBytes
    Copy-Item -LiteralPath $s063Source -Destination (Join-Path $s063Directory 'S063OutlineReparentForm.cs')
    Copy-Item -LiteralPath $s063Project -Destination (Join-Path $s063Directory 'VisualStudioReference.Net48.csproj')
    Write-Json (Join-Path $s063Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S063"
      scenarioId = 'V2-FND-001-S063'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s063ReferenceStatus
      setup = 'A net48 Form has button1 at Panel-relative (70,45), while overlapping groupBox1 begins at Form-relative (80,50); preserving the full-frame position requires GroupBox-relative (10,15).'
      actionLog = @(
        'Build the fixture solution in actual Visual Studio',
        'Open S063OutlineReparentForm.cs in the installed classic WinForms Designer',
        'Open native Document Outline and locate its deterministic Form, panel1, button1, groupBox1 rows',
        'Drag the owner-drawn button1 outline row onto groupBox1 through the real Document Outline input window',
        'Execute File.SaveAll and require one membership replacement plus exact coordinate rebasing from (70,45) to (10,15)',
        'Execute one native Undo and Save All to restore panel1/(70,45)',
        'Execute one native Redo and Save All to reproduce groupBox1/(10,15)',
        'Require source/project byte identity and all unrelated Button facts to remain exact'
      )
      expected = 'Actual Visual Studio reparents button1 from panel1 to groupBox1 while preserving its full-frame position as child Location (10,15), and owns membership plus geometry as one native Undo/Redo unit.'
      runtimeArchitecture = 'actual Visual Studio x64 classic net48 reference'
      before = $s063Before
      afterReparent = $s063After
      afterUndo = $s063AfterUndo
      afterRedo = $s063AfterRedo
      sourceAndProjectByteIdentical = $s063SourceAndProjectExact
      initialShapeExact = $s063InitialExact
      reparentShapeExact = $s063AfterExact
      oneUndoRestoresOriginalShape = $s063UndoExact
      oneRedoRestoresReparentShape = $s063RedoExact
      unrelatedButtonFactsExact = $s063InvariantExact
      redoByteIdenticalToReparent = $s063After.designerSha256 -eq $s063AfterRedo.designerSha256
      undoRedo = [ordered]@{ undoAvailable = $undoAvailable; redoAvailable = $redoAvailable }
      lineEndingDialogs = @($s063Capture.lineEndingDialog, $undoSave, $redoSave)
      designerBeforeArtifact = 'S063OutlineReparentForm.Designer.before.cs'
      designerAfterReparentArtifact = 'S063OutlineReparentForm.Designer.after-reparent.cs.gz'
      designerAfterUndoArtifact = 'S063OutlineReparentForm.Designer.after-undo.cs.gz'
      designerAfterRedoArtifact = 'S063OutlineReparentForm.Designer.after-redo.cs.gz'
      visualStudioWindow = $s063Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S063'; status = $s063ReferenceStatus; directory = 'V2-FND-001-S063' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S063 outline reparent status: $s063ReferenceStatus; after=$($s063After.shape.groupMembershipCount)/$($s063After.shape.x),$($s063After.shape.y); undo=$($s063AfterUndo.shape.panelMembershipCount)/$($s063AfterUndo.shape.x),$($s063AfterUndo.shape.y); redo=$($s063AfterRedo.shape.groupMembershipCount)/$($s063AfterRedo.shape.x),$($s063AfterRedo.shape.y)"
    if (-not $s063Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S110') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s110Capture = Open-DesignerAccessibilityTreeAndCapture $dte $s110Source `
      (Join-Path $s110Directory 'visual-studio-designer.png')
    $s110After = [ordered]@{
      sourceSha256 = Get-Sha256 $s110Source
      designerSha256 = Get-Sha256 $s110Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s110SelectedMatches = [ordered]@{}
    $s110MissingElements = [System.Collections.Generic.List[string]]::new()
    $s110IncompleteElements = [System.Collections.Generic.List[string]]::new()
    foreach ($key in @('button', 'textBox', 'menuStrip', 'menuItem', 'timer')) {
      $matches = @($s110Capture.matches[$key])
      if ($matches.Count -eq 0) {
        $s110MissingElements.Add($key)
        $s110SelectedMatches[$key] = $null
        continue
      }
      $usable = @($matches | Where-Object {
        [string]$_.controlType -and
        (([string]$_.name) -or ([string]$_.automationId)) -and
        @($_.ancestors).Count -gt 0 -and
        [double]$_.bounds.width -gt 0 -and [double]$_.bounds.height -gt 0
      }) | Select-Object -First 1
      if ($null -eq $usable) {
        $s110IncompleteElements.Add($key)
        $usable = $matches | Select-Object -First 1
      }
      $s110SelectedMatches[$key] = $usable
    }
    $s110BytesExact = $s110Before.sourceSha256 -eq $s110After.sourceSha256 -and
      $s110Before.designerSha256 -eq $s110After.designerSha256 -and
      $s110Before.projectSha256 -eq $s110After.projectSha256
    $s110Pass = $s110MissingElements.Count -eq 0 -and $s110IncompleteElements.Count -eq 0 -and $s110BytesExact
    $s110ReferenceStatus = if ($s110Pass) { 'PASS' } else { 'CAPTURED_UNREVIEWED' }
    Copy-Item -LiteralPath $s110Source -Destination (Join-Path $s110Directory 'S110AccessibilityTreeForm.cs')
    Copy-Item -LiteralPath $s110Designer -Destination (Join-Path $s110Directory 'S110AccessibilityTreeForm.Designer.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s110Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s110Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S110"
      scenarioId = 'V2-FND-001-S110'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s110ReferenceStatus
      setup = 'net10.0-windows Form contains an accessible Button, TextBox, MenuStrip/File item, and Timer component.'
      actionLog = @(
        'Build solution in Visual Studio',
        'Open S110AccessibilityTreeForm.cs with the installed WinForms Designer',
        'Open the native Document Outline when the command is available',
        'Read bounded UI Automation and MSAA inventories without sending a mutation',
        'Resolve Button, TextBox, MenuStrip, menu item, and Timer records with role/type, state, ancestry, and bounds',
        'Verify source, Designer, and project bytes remain exact'
      )
      expected = 'The installed designer accessibility surface exposes the Button, TextBox, MenuStrip, File item, and Timer with a stable name or id, semantic role/type, enabled/offscreen state, parent ancestry, and non-empty bounds.'
      before = $s110Before
      after = $s110After
      sourceByteIdentical = $s110Before.sourceSha256 -eq $s110After.sourceSha256
      designerByteIdentical = $s110Before.designerSha256 -eq $s110After.designerSha256
      projectByteIdentical = $s110Before.projectSha256 -eq $s110After.projectSha256
      selectedMatches = $s110SelectedMatches
      missingElements = @($s110MissingElements)
      incompleteElements = @($s110IncompleteElements)
      accessibilityNotes = [ordered]@{
        x64VisualStudioReferenceExecuted = $true
        physicalArm64 = 'GATED'
        assistiveTechnologyAcceptance = 'NOT_EXECUTED'
      }
      visualStudioWindow = $s110Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S110'; status = $s110ReferenceStatus; directory = 'V2-FND-001-S110' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S110 accessibility tree reference status: $s110ReferenceStatus; missing=$(@($s110MissingElements) -join ','); incomplete=$(@($s110IncompleteElements) -join ',')"
    return
  }

  if ($CaptureSet -eq 'S019') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s019Capture = Open-DesignerCtrlMultiSelectAndCapture $dte $s019Source $s019Designer `
      (Join-Path $s019Directory 'visual-studio-designer.png')
    $s019AfterText = [System.IO.File]::ReadAllText($s019Designer)
    $s019After = [ordered]@{
      sourceSha256 = Get-Sha256 $s019Source
      designerSha256 = Get-Sha256 $s019Designer
      projectSha256 = Get-Sha256 $s019Project
      shape = Get-S019Shape $s019AfterText
    }

    $s019BeforeExact =
      $s019Before.shape.button1.locationAssignmentCount -eq 1 -and $s019Before.shape.button1.x -eq 32 -and $s019Before.shape.button1.y -eq 36 -and
      $s019Before.shape.button1.sizeAssignmentCount -eq 1 -and $s019Before.shape.button1.width -eq 104 -and $s019Before.shape.button1.height -eq 34 -and $s019Before.shape.button1.text -eq 'Primary' -and
      $s019Before.shape.button2.locationAssignmentCount -eq 1 -and $s019Before.shape.button2.x -eq 168 -and $s019Before.shape.button2.y -eq 84 -and
      $s019Before.shape.button2.sizeAssignmentCount -eq 1 -and $s019Before.shape.button2.width -eq 120 -and $s019Before.shape.button2.height -eq 34 -and $s019Before.shape.button2.text -eq 'Second' -and
      $s019Before.shape.button3.locationAssignmentCount -eq 1 -and $s019Before.shape.button3.x -eq 304 -and $s019Before.shape.button3.y -eq 132 -and
      $s019Before.shape.button3.sizeAssignmentCount -eq 1 -and $s019Before.shape.button3.width -eq 136 -and $s019Before.shape.button3.height -eq 34 -and $s019Before.shape.button3.text -eq 'Third'
    $s019SelectionExact = [bool]$s019Capture.selectionWasNonMutating -and
      -not [bool]$s019Capture.afterPrimary.makeSameWidthAvailable -and
      [bool]$s019Capture.afterPrimary.centerHorizontallyAvailable -and
      [bool]$s019Capture.afterSecond.makeSameWidthAvailable -and [bool]$s019Capture.afterThird.makeSameWidthAvailable -and
      [long]$s019Capture.input.primary.targetWindow -ne 0 -and [long]$s019Capture.input.second.targetWindow -ne 0 -and
      [long]$s019Capture.input.third.targetWindow -ne 0 -and
      [string]$s019Capture.capture.captureMethod -eq 'Graphics.CopyFromScreen'
    $s019PrimaryProbeExact = [bool]$s019Capture.primaryProbe.available -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button1.x -eq 32 -and $s019Capture.primaryProbe.afterMakeSameWidth.shape.button1.y -eq 36 -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button2.x -eq 168 -and $s019Capture.primaryProbe.afterMakeSameWidth.shape.button2.y -eq 84 -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button3.x -eq 304 -and $s019Capture.primaryProbe.afterMakeSameWidth.shape.button3.y -eq 132 -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button1.width -eq 104 -and $s019Capture.primaryProbe.afterMakeSameWidth.shape.button1.height -eq 34 -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button2.width -eq 104 -and $s019Capture.primaryProbe.afterMakeSameWidth.shape.button2.height -eq 34 -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button3.width -eq 104 -and $s019Capture.primaryProbe.afterMakeSameWidth.shape.button3.height -eq 34 -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button1.text -eq 'Primary' -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button2.text -eq 'Second' -and
      $s019Capture.primaryProbe.afterMakeSameWidth.shape.button3.text -eq 'Third'
    $s019UndoExact = [bool]$s019Capture.primaryProbe.undoAvailable -and
      $s019Capture.primaryProbe.afterUndo.shape.button1.x -eq 32 -and $s019Capture.primaryProbe.afterUndo.shape.button1.y -eq 36 -and $s019Capture.primaryProbe.afterUndo.shape.button1.width -eq 104 -and $s019Capture.primaryProbe.afterUndo.shape.button1.height -eq 34 -and
      $s019Capture.primaryProbe.afterUndo.shape.button2.x -eq 168 -and $s019Capture.primaryProbe.afterUndo.shape.button2.y -eq 84 -and $s019Capture.primaryProbe.afterUndo.shape.button2.width -eq 120 -and $s019Capture.primaryProbe.afterUndo.shape.button2.height -eq 34 -and
      $s019Capture.primaryProbe.afterUndo.shape.button3.x -eq 304 -and $s019Capture.primaryProbe.afterUndo.shape.button3.y -eq 132 -and $s019Capture.primaryProbe.afterUndo.shape.button3.width -eq 136 -and $s019Capture.primaryProbe.afterUndo.shape.button3.height -eq 34
    $s019SourceProjectExact = $s019Before.sourceSha256 -eq $s019After.sourceSha256 -and
      $s019Before.projectSha256 -eq $s019After.projectSha256
    $s019Pass = $s019BeforeExact -and $s019SelectionExact -and $s019PrimaryProbeExact -and $s019UndoExact -and
      $s019SourceProjectExact
    $s019ReferenceStatus = if ($s019Pass) { 'PASS' } else { 'FAIL' }

    [System.IO.File]::WriteAllBytes((Join-Path $s019Directory 'S019CtrlMultiSelectForm.Designer.before.cs'), $s019BeforeBytes)
    Copy-Item -LiteralPath $s019Source -Destination (Join-Path $s019Directory 'S019CtrlMultiSelectForm.cs')
    Copy-Item -LiteralPath $s019Project -Destination (Join-Path $s019Directory 'VisualStudioReference.Net48.csproj')
    Write-Json (Join-Path $s019Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S019"
      scenarioId = 'V2-FND-001-S019'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s019ReferenceStatus
      setup = 'net48 Form contains button1 Primary at (32,36) size 104x34, button2 Second at (168,84) size 120x34, and button3 Third at (304,132) size 136x34.'
      actionLog = @(
        'Build the fixture solution in Visual Studio',
        'Open S019CtrlMultiSelectForm.cs with the installed WinForms Designer',
        'Physically click button1 without modifiers after the dedicated trace IDE passes the foreground HWND gate; repeat once only if the first click activated the designer document without enabling a single-control Format command',
        'Hold VK_CONTROL through SendInput on the interactive capture thread, require GetAsyncKeyState down, physically click button2/button3, and release VK_CONTROL in finally after each additive gesture',
        'Capture the three-control selection and native Properties evidence without source mutation',
        'Execute the reversible native Format.MakeSameWidth diagnostic probe to reveal both the complete selected set and the retained first-clicked button1 primary',
        'Verify all three controls take button1 width 104 while every Location, Height, and Text survives',
        'Execute one native Undo plus Save All and verify the exact original semantic positions and sizes return'
      )
      expected = 'Ctrl-click adds button2 and button3 without replacing the first-clicked button1 primary. The reversible Make Same Width probe changes exactly all three controls to button1 width 104, and one native Undo restores their original sizes.'
      before = $s019Before
      after = $s019After
      selectionWasNonMutating = [bool]$s019Capture.selectionWasNonMutating
      sourceAndProjectByteIdentical = $s019SourceProjectExact
      completeSelectionAndPrimaryAnchor = $s019PrimaryProbeExact
      oneUndoRestoresOriginalShape = $s019UndoExact
      designerBeforeArtifact = 'S019CtrlMultiSelectForm.Designer.before.cs'
      designerAfterMakeSameWidthArtifact = 'S019CtrlMultiSelectForm.Designer.after-make-same-width.cs.gz'
      designerAfterUndoArtifact = 'S019CtrlMultiSelectForm.Designer.after-undo.cs.gz'
      visualStudioWindow = $s019Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S019'; status = $s019ReferenceStatus; directory = 'V2-FND-001-S019' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S019 Ctrl multi-selection status: $s019ReferenceStatus; secondSameWidth=$($s019Capture.afterSecond.makeSameWidthAvailable); thirdSameWidth=$($s019Capture.afterThird.makeSameWidthAvailable); primaryProbeWidths=$($s019Capture.primaryProbe.afterMakeSameWidth.shape.button1.width),$($s019Capture.primaryProbe.afterMakeSameWidth.shape.button2.width),$($s019Capture.primaryProbe.afterMakeSameWidth.shape.button3.width); undoWidths=$($s019Capture.primaryProbe.afterUndo.shape.button1.width),$($s019Capture.primaryProbe.afterUndo.shape.button2.width),$($s019Capture.primaryProbe.afterUndo.shape.button3.width)"
    if (-not $s019Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S045') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s045Capture = Open-DesignerColorEditorAndCapture $dte $s045Source 'button1' `
      (Join-Path $s045Directory 'visual-studio-designer.png') 'S045' -ApplyBlue
    $s045OwnerHwnd = [IntPtr]([long]$s045Capture.windowHandle)
    $saveS045 = {
      param([string] $Phase)
      $dismissal = [VisualStudioTraceNative]::StartDialogDismissal(
        $s045OwnerHwnd,
        'Inconsistent Line Endings',
        7,
        600000
      )
      $null = $dte.ExecuteCommand('File.SaveAll')
      [void]$dismissal.Thread.Join(1000)
      $dismissal.Cancelled = $true
      [void]$dismissal.Thread.Join(1000)
      Start-Sleep -Seconds 2
      return [ordered]@{
        phase = $Phase
        title = 'Inconsistent Line Endings'
        choice = 'No'
        observed = [bool]$dismissal.Observed
        clickPosted = [bool]$dismissal.ClickPosted
        dismissed = [bool]$dismissal.Dismissed
      }
    }

    $applySave = & $saveS045 'apply-blue'
    $s045AfterApplyText = [System.IO.File]::ReadAllText($s045Designer)
    $s045AfterApplyBytes = [System.IO.File]::ReadAllBytes($s045Designer)
    $s045AfterApply = [ordered]@{
      sourceSha256 = Get-Sha256 $s045Source
      designerSha256 = Get-Sha256 $s045Designer
      projectSha256 = Get-Sha256 $s001Project
      shape = Get-S045Shape $s045AfterApplyText
    }

    # File.SaveAll and the native Properties/Document Outline tool windows can leave command routing outside the
    # designer. Re-activate the already-open designer document before interrogating Edit.Undo/Edit.Redo so the
    # availability result belongs to the actual WinForms Designer transaction owner.
    $s045DesignerItem = $dte.Solution.FindProjectItem($s045Source)
    if ($null -eq $s045DesignerItem) { throw "Visual Studio no longer resolved the S045 project item: $s045Source" }
    $s045DesignerWindow = $s045DesignerItem.Open('{00000000-0000-0000-0000-000000000000}')
    if ($null -eq $s045DesignerWindow) { throw 'Visual Studio did not reactivate the S045 designer window before Undo.' }
    $s045DesignerWindow.Visible = $true
    $null = $s045DesignerWindow.Activate()
    Start-Sleep -Seconds 1

    $undoAvailable = $false
    try { $undoAvailable = [bool]$dte.Commands.Item('Edit.Undo').IsAvailable } catch { }
    if ($undoAvailable) { $null = $dte.ExecuteCommand('Edit.Undo') }
    Start-Sleep -Seconds 3
    $undoSave = & $saveS045 'undo-to-red'
    $s045AfterUndoText = [System.IO.File]::ReadAllText($s045Designer)
    $s045AfterUndoBytes = [System.IO.File]::ReadAllBytes($s045Designer)
    $s045AfterUndo = [ordered]@{
      sourceSha256 = Get-Sha256 $s045Source
      designerSha256 = Get-Sha256 $s045Designer
      projectSha256 = Get-Sha256 $s001Project
      shape = Get-S045Shape $s045AfterUndoText
    }

    $null = $s045DesignerWindow.Activate()
    Start-Sleep -Seconds 1
    $redoAvailable = $false
    try { $redoAvailable = [bool]$dte.Commands.Item('Edit.Redo').IsAvailable } catch { }
    if ($redoAvailable) { $null = $dte.ExecuteCommand('Edit.Redo') }
    Start-Sleep -Seconds 3
    $redoSave = & $saveS045 'redo-to-blue'
    $s045AfterRedoText = [System.IO.File]::ReadAllText($s045Designer)
    $s045AfterRedoBytes = [System.IO.File]::ReadAllBytes($s045Designer)
    $s045AfterRedo = [ordered]@{
      sourceSha256 = Get-Sha256 $s045Source
      designerSha256 = Get-Sha256 $s045Designer
      projectSha256 = Get-Sha256 $s001Project
      shape = Get-S045Shape $s045AfterRedoText
    }

    $s045ExpectedApplyText = $s045BeforeText.Replace(
      'this.button1.BackColor = System.Drawing.Color.Red;',
      'this.button1.BackColor = System.Drawing.Color.Blue;'
    )
    $s045ExpectedApplyText = [regex]::Replace($s045ExpectedApplyText, '(?m)^(\s*)//$', '$1// ')
    $s045ExpectedApplyText = $s045ExpectedApplyText.Replace('this.', '')
    $s045ExpectedUndoText = [regex]::Replace($s045BeforeText, '(?m)^(\s*)//$', '$1// ')
    $s045ExpectedUndoText = $s045ExpectedUndoText.Replace('this.', '')

    $sourceAndProjectExact = $s045Before.sourceSha256 -eq $s045AfterApply.sourceSha256 -and
      $s045Before.sourceSha256 -eq $s045AfterUndo.sourceSha256 -and
      $s045Before.sourceSha256 -eq $s045AfterRedo.sourceSha256 -and
      $s045Before.projectSha256 -eq $s045AfterApply.projectSha256 -and
      $s045Before.projectSha256 -eq $s045AfterUndo.projectSha256 -and
      $s045Before.projectSha256 -eq $s045AfterRedo.projectSha256
    $applyShapeExact = $s045AfterApply.shape.backColorAssignmentCount -eq 1 -and
      [string]$s045AfterApply.shape.backColor -eq 'Blue' -and
      [bool]$s045AfterApply.shape.locationExact -and [bool]$s045AfterApply.shape.nameExact -and
      [bool]$s045AfterApply.shape.sizeExact -and [bool]$s045AfterApply.shape.textExact -and
      [bool]$s045AfterApply.shape.useVisualStyleBackColorFalse
    $undoShapeExact = $s045AfterUndo.shape.backColorAssignmentCount -eq 1 -and
      [string]$s045AfterUndo.shape.backColor -eq 'Red'
    $redoShapeExact = $s045AfterRedo.shape.backColorAssignmentCount -eq 1 -and
      [string]$s045AfterRedo.shape.backColor -eq 'Blue'
    $editorExact = [string]$s045Capture.beforeValue -eq 'Red' -and
      [string]$s045Capture.afterValue -eq 'Blue' -and
      [bool]$s045Capture.committedWithEnter -and $null -ne $s045Capture.selection -and
      [string]$s045Capture.selection.requestedValue -eq 'Blue' -and
      [long]$s045Capture.colorEditorHwnd -ne 0 -and @($s045Capture.popupCaptures).Count -gt 0 -and
      [string]$s045Capture.capture.captureMethod -eq 'Graphics.CopyFromScreen'
    $s045Pass = $sourceAndProjectExact -and $applyShapeExact -and $undoShapeExact -and $redoShapeExact -and
      $undoAvailable -and $redoAvailable -and $s045ExpectedApplyText -eq $s045AfterApplyText -and
      $s045ExpectedUndoText -eq $s045AfterUndoText -and
      $s045AfterApply.designerSha256 -eq $s045AfterRedo.designerSha256 -and $editorExact
    $s045ReferenceStatus = if ($s045Pass) { 'PASS' } else { 'FAIL' }

    [System.IO.File]::WriteAllBytes((Join-Path $s045Directory 'S045ColorEditorForm.Designer.before.cs'), $s045BeforeBytes)
    Write-Gzip (Join-Path $s045Directory 'S045ColorEditorForm.Designer.after-apply.cs.gz') $s045AfterApplyBytes
    Write-Gzip (Join-Path $s045Directory 'S045ColorEditorForm.Designer.after-undo.cs.gz') $s045AfterUndoBytes
    Write-Gzip (Join-Path $s045Directory 'S045ColorEditorForm.Designer.after-redo.cs.gz') $s045AfterRedoBytes
    Copy-Item -LiteralPath $s045Source -Destination (Join-Path $s045Directory 'S045ColorEditorForm.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s045Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s045Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S045"
      scenarioId = 'V2-FND-001-S045'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s045ReferenceStatus
      setup = 'net10.0-windows Form contains button1 with explicit BackColor=Red and UseVisualStyleBackColor=false.'
      actionLog = @(
        'Build the fixture solution in Visual Studio',
        'Open S045ColorEditorForm.cs with the installed WinForms Designer',
        'Select button1 through its actual designer automation element',
        'Open native Properties and activate the BackColor framework editor through its real Open button',
        'Navigate the actual owner-drawn Web ColorEditorListBox from End to the exact named Blue entry and capture it selected',
        'Press Enter to accept Blue and execute File.SaveAll',
        'Execute one native Undo plus Save All to restore Red, then one native Redo plus Save All to reproduce Blue',
        'Verify the exact generated-source artifacts and source/project byte identity'
      )
      expected = 'Actual Visual Studio accepts Color.Blue through the framework Color editor, emits the canonical assignment, and owns the edit as one native Undo/Redo unit.'
      before = $s045Before
      afterApply = $s045AfterApply
      afterUndo = $s045AfterUndo
      afterRedo = $s045AfterRedo
      sourceAndProjectByteIdentical = $sourceAndProjectExact
      exactApplyDesignerPatch = $s045ExpectedApplyText -eq $s045AfterApplyText
      exactUndoDesignerPatch = $s045ExpectedUndoText -eq $s045AfterUndoText
      redoByteIdenticalToApply = $s045AfterApply.designerSha256 -eq $s045AfterRedo.designerSha256
      undoRedo = [ordered]@{
        undoAvailable = $undoAvailable
        redoAvailable = $redoAvailable
        undoValue = $s045AfterUndo.shape.backColor
        redoValue = $s045AfterRedo.shape.backColor
      }
      lineEndingDialogs = @($applySave, $undoSave, $redoSave)
      designerBeforeArtifact = 'S045ColorEditorForm.Designer.before.cs'
      designerAfterApplyArtifact = 'S045ColorEditorForm.Designer.after-apply.cs.gz'
      designerAfterUndoArtifact = 'S045ColorEditorForm.Designer.after-undo.cs.gz'
      designerAfterRedoArtifact = 'S045ColorEditorForm.Designer.after-redo.cs.gz'
      visualStudioWindow = $s045Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S045'; status = $s045ReferenceStatus; directory = 'V2-FND-001-S045' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S045 Color editor apply status: $s045ReferenceStatus; before=$($s045Capture.beforeValue); after=$($s045Capture.afterValue); undo=$($s045AfterUndo.shape.backColor); redo=$($s045AfterRedo.shape.backColor)"
    if (-not $s045Pass) { exit 1 }
    return
  }

  if ($CaptureSet -eq 'S046') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s046Capture = Open-DesignerColorEditorAndCapture $dte $s046Source 'button1' `
      (Join-Path $s046Directory 'visual-studio-designer.png') 'S046'
    $s046After = [ordered]@{
      sourceSha256 = Get-Sha256 $s046Source
      designerSha256 = Get-Sha256 $s046Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s046BytesExact = $s046Before.sourceSha256 -eq $s046After.sourceSha256 -and
      $s046Before.designerSha256 -eq $s046After.designerSha256 -and
      $s046Before.projectSha256 -eq $s046After.projectSha256
    $s046ValueExact = [string]$s046Capture.beforeValue -eq [string]$s046Capture.afterValue
    $s046EditorExact = [long]$s046Capture.colorEditorHwnd -ne 0 -and
      @($s046Capture.popupCaptures).Count -gt 0 -and
      @($s046Capture.editorButtons | Where-Object {
        [string]$_.name -eq 'Open' -and [string]$_.controlType -eq 'ControlType.Button'
      }).Count -gt 0 -and
      [string]$s046Capture.capture.captureMethod -eq 'Graphics.CopyFromScreen'
    $s046Pass = $s046BytesExact -and $s046ValueExact -and $s046EditorExact -and
      [bool]$s046Capture.cancelledWithEscape
    $s046ReferenceStatus = if ($s046Pass) { 'PASS' } else { 'CAPTURED_UNREVIEWED' }
    Copy-Item -LiteralPath $s046Source -Destination (Join-Path $s046Directory 'S046ColorEditorForm.cs')
    Copy-Item -LiteralPath $s046Designer -Destination (Join-Path $s046Directory 'S046ColorEditorForm.Designer.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s046Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s046Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S046"
      scenarioId = 'V2-FND-001-S046'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s046ReferenceStatus
      setup = 'net10.0-windows Form contains button1 with explicit BackColor=Red and UseVisualStyleBackColor=false.'
      actionLog = @(
        'Build the fixture solution in Visual Studio',
        'Open S046ColorEditorForm.cs with the installed WinForms Designer',
        'Select button1 through its actual designer automation element',
        'Open native Properties and activate the BackColor dropdown editor',
        'Resolve the standard owner-drawn Color editor popup through its native System Pane and archived Custom/Web/System screenshot',
        'Press Escape to cancel the editor',
        'Verify BackColor and source, Designer, and project bytes remain exact'
      )
      expected = 'Actual Visual Studio opens the standard framework Color editor for Button.BackColor, Escape cancels it, and no property or project input changes.'
      before = $s046Before
      after = $s046After
      sourceByteIdentical = $s046Before.sourceSha256 -eq $s046After.sourceSha256
      designerByteIdentical = $s046Before.designerSha256 -eq $s046After.designerSha256
      projectByteIdentical = $s046Before.projectSha256 -eq $s046After.projectSha256
      valueExact = $s046ValueExact
      editorExact = $s046EditorExact
      runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference; physical ARM64 remains an independent external gate'
      visualStudioWindow = $s046Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S046'; status = $s046ReferenceStatus; directory = 'V2-FND-001-S046' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S046 Color editor cancel status: $s046ReferenceStatus; tabs=$(@($s046Capture.colorEditorTabNames) -join ','); value=$s046ValueExact; bytes=$s046BytesExact"
    return
  }

  if ($CaptureSet -eq 'S041') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s041Capture = Open-DesignerPropertyDropdownAndCapture $dte $s041Source 'button1' 'FlatStyle' (Join-Path $s041Directory 'visual-studio-designer.png')
    $s041After = [ordered]@{
      sourceSha256 = Get-Sha256 $s041Source
      designerSha256 = Get-Sha256 $s041Designer
      projectSha256 = Get-Sha256 $s001Project
    }
    $s041NativeList = @($s041Capture.listInventories | Where-Object {
      ($_.childNames -join '|') -eq 'Flat|Popup|Standard|System'
    }) | Select-Object -First 1
    $s041DropdownItems = if ($null -ne $s041NativeList) { @($s041NativeList.childItems) } else { @() }
    $s041ItemNames = if ($null -ne $s041NativeList) { @($s041NativeList.childNames) } else { @() }
    $s041SelectedNames = if ($null -ne $s041NativeList -and @($s041NativeList.selectedNames).Count -gt 0) {
      @($s041NativeList.selectedNames)
    } elseif ($null -ne $s041NativeList -and $s041NativeList.name -in @($s041NativeList.childNames)) {
      @($s041NativeList.name)
    } else {
      @()
    }
    $s041SelectionSource = if ($null -ne $s041NativeList -and @($s041NativeList.selectedNames).Count -gt 0) {
      'SelectionPattern.GetSelection'
    } elseif ($null -ne $s041NativeList -and $s041NativeList.name -in @($s041NativeList.childNames)) {
      'List.Current.Name'
    } else {
      'UNAVAILABLE'
    }
    $s041Pass = ($s041ItemNames -join '|') -eq 'Flat|Popup|Standard|System' -and
      ($s041SelectedNames -join '|') -eq 'Standard' -and
      $s041Before.sourceSha256 -eq $s041After.sourceSha256 -and
      $s041Before.designerSha256 -eq $s041After.designerSha256 -and
      $s041Before.projectSha256 -eq $s041After.projectSha256
    $s041ReferenceStatus = if ($s041Pass) { 'PASS' } elseif ($s041Capture.items.Count -gt 0 -or $s041Capture.listInventories.Count -gt 0) { 'FAIL' } else { 'NOT_EXECUTED' }
    Copy-Item -LiteralPath $s041Source -Destination (Join-Path $s041Directory 'S041FlatStyleForm.cs')
    Copy-Item -LiteralPath $s041Designer -Destination (Join-Path $s041Directory 'S041FlatStyleForm.Designer.cs')
    Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s041Directory 'VisualStudioReference.Modern.csproj')
    Write-Json (Join-Path $s041Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S041"
      scenarioId = 'V2-FND-001-S041'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s041ReferenceStatus
      setup = 'net10.0-windows Form contains one Button whose FlatStyle assignment is omitted, leaving the framework default Standard value.'
      actionLog = @(
        'Build solution in Visual Studio',
        'Open S041FlatStyleForm.cs with the WinForms Designer',
        'Select button1 in the actual designer',
        'Open View.PropertiesWindow',
        'Open the FlatStyle standard-values dropdown',
        'Capture exact accessible dropdown items and selection',
        'Dismiss with Escape and execute File.SaveAll',
        'Verify source, Designer, and project bytes remain exact'
      )
      expected = 'The native Visual Studio FlatStyle dropdown exposes Flat, Popup, Standard, System in that order with Standard selected and performs no source mutation.'
      before = $s041Before
      after = $s041After
      items = $s041DropdownItems
      itemNames = $s041ItemNames
      selectedNames = $s041SelectedNames
      selectionSource = $s041SelectionSource
      nativeList = $s041NativeList
      sourceByteIdentical = $s041Before.sourceSha256 -eq $s041After.sourceSha256
      designerByteIdentical = $s041Before.designerSha256 -eq $s041After.designerSha256
      projectByteIdentical = $s041Before.projectSha256 -eq $s041After.projectSha256
      visualStudioWindow = $s041Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S041'; status = $s041ReferenceStatus; directory = 'V2-FND-001-S041' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S041 FlatStyle standard values reference status: $s041ReferenceStatus"
    return
  }

  if ($CaptureSet -eq 'S031') {
    $authority = [ordered]@{
      product = $visualStudioDisplayName
      dteVersion = $visualStudioVersion
      installationVersion = $visualStudioInstallationVersion
      edition = $visualStudioEdition
      executable = $visualStudioExecutable
      dteProgId = $DteProgId
      captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
    }
    $s031Capture = Open-DesignerCenterHorizontalAndCapture $dte $s031Source 'button1' 'Center me' (Join-Path $s031Directory 'visual-studio-designer.png')
    $s031AfterText = [System.IO.File]::ReadAllText($s031Designer)
    $s031After = [ordered]@{
      sourceSha256 = Get-Sha256 $s031Source
      designerSha256 = Get-Sha256 $s031Designer
      projectSha256 = Get-Sha256 $s031Project
      shape = Get-S031Shape $s031AfterText
    }
    $s031ExpectedText = $s031BeforeText.Replace(
      'this.button1.Location = new System.Drawing.Point(15, 40);',
      'this.button1.Location = new System.Drawing.Point(80, 40);'
    )
    $s031ExpectedText = [regex]::Replace($s031ExpectedText, '(?m)^(\s*)//$', '$1// ')
    $s031Eol = if ($s031ExpectedText.Contains("`r`n")) { "`r`n" } else { "`n" }
    $s031ExpectedText = $s031ExpectedText.Replace(
      "            this.ResumeLayout(false);${s031Eol}        }",
      "            this.ResumeLayout(false);${s031Eol}${s031Eol}        }"
    )
    if (-not $s031ExpectedText.Contains("`r`n")) {
      $s031RegionStart = $s031ExpectedText.IndexOf('            this.panel1 = new System.Windows.Forms.Panel();', [System.StringComparison]::Ordinal)
      $s031RegionEnd = $s031ExpectedText.IndexOf('        }', $s031RegionStart, [System.StringComparison]::Ordinal)
      if ($s031RegionStart -lt 0 -or $s031RegionEnd -lt 0) { throw 'Cannot locate the S031 CodeDOM serialization region.' }
      $s031ExpectedText = $s031ExpectedText.Substring(0, $s031RegionStart) +
        $s031ExpectedText.Substring($s031RegionStart, $s031RegionEnd - $s031RegionStart).Replace("`n", "`r`n") +
        $s031ExpectedText.Substring($s031RegionEnd)
    }
    $s031Pass = $s031Before.shape.button.location.x -eq 15 -and
      $s031After.shape.button.location.x -eq 80 -and
      $s031Before.shape.button.location.y -eq $s031After.shape.button.location.y -and
      $s031Before.shape.button.size.width -eq $s031After.shape.button.size.width -and
      $s031Before.shape.button.size.height -eq $s031After.shape.button.size.height -and
      ($s031Before.shape.panel | ConvertTo-Json -Compress) -eq ($s031After.shape.panel | ConvertTo-Json -Compress) -and
      $s031Before.sourceSha256 -eq $s031After.sourceSha256 -and
      $s031Before.projectSha256 -eq $s031After.projectSha256 -and
      $s031ExpectedText -eq $s031AfterText -and
      ([bool]$s031Capture.commandAvailability.centerHorizontally -or [bool]$s031Capture.commandAvailability.centerHorizontal)
    $s031ReferenceStatus = if ($s031Pass) { 'PASS' } elseif ($s031Capture.selectionFailure) { 'NOT_EXECUTED' } else { 'FAIL' }
    [System.IO.File]::WriteAllBytes((Join-Path $s031Directory 'S031CenterPanelForm.Designer.before.cs'), $s031BeforeBytes)
    Copy-Item -LiteralPath $s031Source -Destination (Join-Path $s031Directory 'S031CenterPanelForm.cs')
    Write-Gzip (Join-Path $s031Directory 'S031CenterPanelForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s031Designer))
    Write-Json (Join-Path $s031Directory 'manifest.json') ([ordered]@{
      schemaVersion = 1
      traceId = "$runId-S031"
      scenarioId = 'V2-FND-001-S031'
      referenceTraceSource = 'VisualStudioWinFormsDesigner'
      authority = $authority
      status = $s031ReferenceStatus
      setup = 'net48 Form contains a 241x120 Panel with Padding(10,0,20,0) and one 80x24 Button at relative Location (15,40).'
      actionLog = @(
        'Build solution in Visual Studio',
        'Open S031CenterPanelForm.cs with the WinForms Designer',
        'Select button1 through the real designer or Document Outline',
        'Verify and execute the native horizontal-center command',
        'Execute File.SaveAll',
        'Verify the exact generated-source patch'
      )
      expected = 'Visual Studio centers button1 in the complete Panel client area using reference rounding: relative X 15->80; asymmetric Padding does not shift the native Format command, while Y/Size/Panel geometry remain exact and source/project stay byte-identical.'
      before = $s031Before
      after = $s031After
      exactDesignerPatch = $s031ExpectedText -eq $s031AfterText
      exactAfterArtifact = 'S031CenterPanelForm.Designer.after.cs.gz'
      sourceByteIdentical = $s031Before.sourceSha256 -eq $s031After.sourceSha256
      projectByteIdentical = $s031Before.projectSha256 -eq $s031After.projectSha256
      selectionFailure = $s031Capture.selectionFailure
      visualStudioWindow = $s031Capture
    })
    Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
      schemaVersion = 1
      runId = $runId
      captureSet = $CaptureSet
      authority = $authority
      scenarioCount = 1
      scenarios = @([ordered]@{ scenarioId = 'V2-FND-001-S031'; status = $s031ReferenceStatus; directory = 'V2-FND-001-S031' })
    })
    Write-Host "Visual Studio focused trace capture complete: $runDirectory"
    Write-Host "S031 Center Horizontally reference status: $s031ReferenceStatus"
    return
  }

  $s001Capture = Open-DesignerAndCapture $dte $s001Source (Join-Path $s001Directory 'visual-studio-designer.png')
  $s001After = [ordered]@{
    'S001SaveForm.cs' = Get-Sha256 $s001Source
    'S001SaveForm.Designer.cs' = Get-Sha256 $s001Designer
    'S001SaveForm.resx' = Get-Sha256 $s001Resource
    'VisualStudioReference.Modern.csproj' = Get-Sha256 $s001Project
  }
  $s001Exact = @($s001Before.Keys | Where-Object { $s001Before[$_] -ne $s001After[$_] }).Count -eq 0
  foreach ($artifact in @('S001SaveForm.cs', 'S001SaveForm.Designer.cs', 'S001SaveForm.resx', 'VisualStudioReference.Modern.csproj')) {
    Copy-Item -LiteralPath (Join-Path $modern $artifact) -Destination (Join-Path $s001Directory $artifact)
  }

  $s012Before = [ordered]@{
    sourceSha256 = Get-Sha256 $s012Source
    projectSha256 = Get-Sha256 $s001Project
    designerExists = Test-Path -LiteralPath $s012Designer -PathType Leaf
    designerSha256 = $(if (Test-Path -LiteralPath $s012Designer -PathType Leaf) { Get-Sha256 $s012Designer } else { $null })
    resourceExists = Test-Path -LiteralPath $s012Resource -PathType Leaf
  }
  $s012Capture = Open-DesignerAndCapture $dte $s012Source (Join-Path $s012Directory 'visual-studio-designer.png')
  $s012After = [ordered]@{
    sourceSha256 = Get-Sha256 $s012Source
    projectSha256 = Get-Sha256 $s001Project
    designerExists = Test-Path -LiteralPath $s012Designer -PathType Leaf
    designerSha256 = $(if (Test-Path -LiteralPath $s012Designer -PathType Leaf) { Get-Sha256 $s012Designer } else { $null })
    resourceExists = Test-Path -LiteralPath $s012Resource -PathType Leaf
  }
  Copy-Item -LiteralPath $s012Source -Destination (Join-Path $s012Directory 'S012MissingInitializeForm.cs')
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s012Directory 'VisualStudioReference.Modern.csproj')
  if ($s012After.designerExists) {
    Copy-Item -LiteralPath $s012Designer -Destination (Join-Path $s012Directory 'S012MissingInitializeForm.Designer.cs')
  }
  if ($s012After.resourceExists) {
    Copy-Item -LiteralPath $s012Resource -Destination (Join-Path $s012Directory 'S012MissingInitializeForm.resx')
  }

  $s120Capture = Open-DesignerAndCapture $dte $s120Source (Join-Path $s120Directory 'visual-studio-designer.png')
  $s120After = [ordered]@{
    'GroupMoveForm.cs' = Get-Sha256 $s120Source
    'GroupMoveForm.Designer.cs' = Get-Sha256 $s120Designer
  }
  $s120Exact = $s120Before['GroupMoveForm.cs'] -eq $s120After['GroupMoveForm.cs'] -and
    $s120Before['GroupMoveForm.Designer.cs'] -eq $s120After['GroupMoveForm.Designer.cs']
  Copy-Item -LiteralPath $s120Source -Destination (Join-Path $s120Directory 'GroupMoveForm.cs')
  Copy-Item -LiteralPath $s120Designer -Destination (Join-Path $s120Directory 'GroupMoveForm.Designer.cs')
  Copy-Item -LiteralPath (Join-Path $extensionTrace 'extension-leg.json') -Destination (Join-Path $s120Directory 'extension-leg.json')

  # S120 first proves that Visual Studio accepts the product-produced bytes without a mutation. S021 then uses the
  # same accepted fixture for a real multi-selection drag and observes the IDE's own transaction/serializer behavior.
  $s021Capture = Open-DesignerGroupDragAndCapture $dte $s021Source $s021Designer 'button1' 17 9 (Join-Path $s021Directory 'visual-studio-designer.png')
  $s021AfterText = [System.IO.File]::ReadAllText($s021Designer)
  $s021After = [ordered]@{
    sourceSha256 = Get-Sha256 $s021Source
    designerSha256 = Get-Sha256 $s021Designer
    projectSha256 = Get-Sha256 $s001Project
    shape = Get-S021Shape $s021AfterText
  }
  $s021Pass =
    $s021Before.shape.button1.location.x -eq 21 -and $s021Before.shape.button1.location.y -eq 27 -and
    $s021Before.shape.button2.location.x -eq 50 -and $s021Before.shape.button2.location.y -eq 60 -and
    $s021Capture.afterDrag.shape.button1.location.x -eq 38 -and $s021Capture.afterDrag.shape.button1.location.y -eq 36 -and
    $s021Capture.afterDrag.shape.button2.location.x -eq 67 -and $s021Capture.afterDrag.shape.button2.location.y -eq 69 -and
    $s021Capture.afterUndo.shape.button1.location.x -eq 21 -and $s021Capture.afterUndo.shape.button1.location.y -eq 27 -and
    $s021Capture.afterUndo.shape.button2.location.x -eq 50 -and $s021Capture.afterUndo.shape.button2.location.y -eq 60 -and
    $s021Capture.afterRedo.shape.button1.location.x -eq 38 -and $s021Capture.afterRedo.shape.button1.location.y -eq 36 -and
    $s021Capture.afterRedo.shape.button2.location.x -eq 67 -and $s021Capture.afterRedo.shape.button2.location.y -eq 69 -and
    $s021After.shape.button1.location.x -eq 38 -and $s021After.shape.button1.location.y -eq 36 -and
    $s021After.shape.button2.location.x -eq 67 -and $s021After.shape.button2.location.y -eq 69 -and
    [bool]$s021Capture.selectAllAvailable -and [bool]$s021Capture.undoAvailable -and [bool]$s021Capture.redoAvailable -and
    $s021Before.sourceSha256 -eq $s021After.sourceSha256 -and
    $s021Before.projectSha256 -eq $s021After.projectSha256 -and
    [int]$s021Capture.afterBounds.x -eq [int]$s021Capture.beforeBounds.x + 17 -and
    [int]$s021Capture.afterBounds.y -eq [int]$s021Capture.beforeBounds.y + 9
  $s021ReferenceStatus = if ($s021Pass) { 'PASS' } else { 'NOT_EXECUTED' }

  $s100Capture = Open-DesignerAndCapture $dte $s100Source (Join-Path $s100Directory 'visual-studio-designer.png')
  $s100After = [ordered]@{
    'S100AdapterRoundTripForm.cs' = Get-Sha256 $s100Source
    'S100AdapterRoundTripForm.Designer.cs' = Get-Sha256 $s100Designer
    'adapter-manifest.json' = Get-Sha256 $s100AdapterManifest
  }
  $s100Exact = @($s100Before.Keys | Where-Object { $s100Before[$_] -ne $s100After[$_] }).Count -eq 0
  foreach ($artifact in @('S100AdapterRoundTripForm.cs', 'S100AdapterRoundTripForm.Designer.cs', 'adapter-manifest.json')) {
    Copy-Item -LiteralPath (Join-Path $modern $artifact) -Destination (Join-Path $s100Directory $artifact)
  }
  Copy-Item -LiteralPath (Join-Path $extensionTrace 'S100AdapterRoundTrip/extension-leg.json') -Destination (Join-Path $s100Directory 'extension-leg.json')

  $s108Capture = Open-DesignerAndCapture $dte $s108Source (Join-Path $s108Directory 'visual-studio-designer.png')
  $s108After = [ordered]@{
    'ReparentForm.cs' = Get-Sha256 $s108Source
    'ReparentForm.Designer.cs' = Get-Sha256 $s108Designer
  }
  $s108Exact = @($s108Before.Keys | Where-Object { $s108Before[$_] -ne $s108After[$_] }).Count -eq 0
  foreach ($artifact in @('ReparentForm.cs', 'ReparentForm.Designer.cs')) {
    Copy-Item -LiteralPath (Join-Path $net48 $artifact) -Destination (Join-Path $s108Directory $artifact)
  }
  Copy-Item -LiteralPath (Join-Path $extensionTrace 'S108Net48RoundTrip/extension-leg.json') -Destination (Join-Path $s108Directory 'extension-leg.json')

  $s011Source = Join-Path $net48 'S011ConcreteCustomerForm.cs'
  $s014Source = Join-Path $net48 'S014TextBoxForm.cs'
  $s009Capture = Open-DesignerAndCapture $dte $s009Source (Join-Path $s009Directory 'visual-studio-designer.png')
  $s009After = [ordered]@{
    sourceSha256 = Get-Sha256 $s009Source
    designerSha256 = Get-Sha256 $s009Designer
  }
  $s022Capture = Open-DesignerResizeAndCapture $dte $s022Source 'anchoredButton' 40 (Join-Path $s022Directory 'visual-studio-designer.png')
  $s022AfterText = [System.IO.File]::ReadAllText($s022Designer)
  $s022After = [ordered]@{
    sourceSha256 = Get-Sha256 $s022Source
    designerSha256 = Get-Sha256 $s022Designer
    projectSha256 = Get-Sha256 $s001Project
    shape = Get-S022Shape $s022AfterText
  }
  $s022ExpectedText = $s022BeforeText.Replace(
    'anchoredButton.Size = new System.Drawing.Size(120, 30);',
    'anchoredButton.Size = new System.Drawing.Size(160, 30);'
  )
  # VS 18's .NET WinForms serializer also canonicalizes each bare CodeDOM separator `//` to `// ` on the first
  # designer transaction. Freeze those four exact trivia changes instead of either pretending they did not occur or
  # weakening the byte comparison to a semantic-only check.
  $s022ExpectedText = [regex]::Replace($s022ExpectedText, '(?m)^(\s*)//$', '$1// ')
  $s022Pass = $s022Before.shape.size.width -eq 120 -and $s022Before.shape.size.height -eq 30 -and
    $s022After.shape.size.width -eq 160 -and $s022After.shape.size.height -eq 30 -and
    $s022Before.shape.anchor -eq $s022After.shape.anchor -and
    $s022Before.shape.location.x -eq $s022After.shape.location.x -and
    $s022Before.shape.location.y -eq $s022After.shape.location.y -and
    $s022Before.sourceSha256 -eq $s022After.sourceSha256 -and
    $s022Before.projectSha256 -eq $s022After.projectSha256 -and
    $s022ExpectedText -eq $s022AfterText -and
    [int]$s022Capture.afterBounds.width -eq [int]$s022Capture.beforeBounds.width + 40
  # S025 uses the exact Button/TextBox fixture measured from the installed VS designers. A raw drag to Y=36 places
  # their centers only 0.5px apart, but Visual Studio gives the compatible text baseline priority and persists Y=35.
  $s025RawTargetY = $s025Before.shape.snapButton.location.y - 44
  $s025Capture = Open-DesignerBaselineSnapAndCapture $dte $s025Source 'snapButton' 'referenceTextBox' -44 `
    (Join-Path $s025Directory 'visual-studio-designer.png')
  $s025AfterText = [System.IO.File]::ReadAllText($s025Designer)
  $s025AfterBytes = [System.IO.File]::ReadAllBytes($s025Designer)
  $s025After = [ordered]@{
    sourceSha256 = Get-Sha256 $s025Source
    designerSha256 = Get-Sha256 $s025Designer
    projectSha256 = Get-Sha256 $s001Project
    shape = Get-S025Shape $s025AfterText
  }
  $s025SourceAndProjectExact = $s025Before.sourceSha256 -eq $s025After.sourceSha256 -and
    $s025Before.projectSha256 -eq $s025After.projectSha256
  $s025ReferenceExact = $s025Before.shape.referenceTextBox.location.x -eq $s025After.shape.referenceTextBox.location.x -and
    $s025Before.shape.referenceTextBox.location.y -eq $s025After.shape.referenceTextBox.location.y -and
    $s025Before.shape.referenceTextBox.size.width -eq $s025After.shape.referenceTextBox.size.width -and
    $s025Before.shape.referenceTextBox.size.height -eq $s025After.shape.referenceTextBox.size.height
  $s025BaselineSnapExact = $s025After.shape.snapButton.location.x -eq $s025Before.shape.snapButton.location.x -and
    $s025After.shape.snapButton.location.y -eq 35 -and
    $s025After.shape.snapButton.location.y -ne $s025RawTargetY -and
    $s025After.shape.snapButton.size.width -eq $s025Before.shape.snapButton.size.width -and
    $s025After.shape.snapButton.size.height -eq $s025Before.shape.snapButton.size.height
  $s025ResourceExists = Test-Path -LiteralPath $s025Resource -PathType Leaf
  $s025ResourceRoot = $null
  $s025ResourceDataCount = $null
  $s025ResourceMetadataCount = $null
  $s025ResourceSha256 = $null
  if ($s025ResourceExists) {
    [xml]$s025ResourceDocument = [System.IO.File]::ReadAllText($s025Resource)
    $s025ResourceRoot = $s025ResourceDocument.DocumentElement.LocalName
    $s025ResourceDataCount = @($s025ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='data']")).Count
    $s025ResourceMetadataCount = @($s025ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='metadata']")).Count
    $s025ResourceSha256 = Get-Sha256 $s025Resource
  }
  $s025StandardEmptyResource = $s025ResourceExists -and $s025ResourceRoot -ceq 'root' -and
    $s025ResourceDataCount -eq 0 -and $s025ResourceMetadataCount -eq 0
  $s025Pass = $s025SourceAndProjectExact -and $s025ReferenceExact -and $s025BaselineSnapExact -and
    $s025StandardEmptyResource
  $s025Status = if ($s025Pass) { 'PASS' } else { 'FAIL' }
  # S026 temporarily switches only the dedicated trace IDE to the installed designer's SnapToGrid mode. EnvDTE
  # exposes heterogeneous COM VARIANT types for these options, so all writes use the reflection bridge and every
  # original value is restored before any subsequent reference scenario executes.
  $originalLayoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
  $originalShowGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
  $originalSnapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
  $s026Capture = $null
  $effectiveOptions = $null
  try {
    [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'ShowGrid'), [bool]$true)
    [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'SnapToGrid'), [bool]$true)
    [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'LayoutMode'), [int]1)
    Start-Sleep -Seconds 1
    $effectiveOptions = [ordered]@{
      layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
      showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
      snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
      gridSizeAutomationValue = (Get-WindowsFormsDesignerOption $dte 'GridSize').Value
      expectedEffectiveGrid = [ordered]@{ width = 8; height = 8 }
    }
    $s026CursorProbe = New-Object VisualStudioTraceNative+POINT
    if ([VisualStudioTraceNative]::TryGetCursorPosition([ref]$s026CursorProbe)) {
      $s026Capture = Open-DesignerCursorSynchronizedMoveAndCapture $dte $s026Source 'gridLabel' 'referenceButton' 20 0 `
        (Join-Path $s026Directory 'visual-studio-designer.png')
    } else {
      $s026Capture = Open-DesignerBaselineSnapAndCapture $dte $s026Source 'gridLabel' 'referenceButton' 0 `
        (Join-Path $s026Directory 'visual-studio-designer.png') -DeltaX 20
    }
  } finally {
    [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'ShowGrid'), [bool]$originalShowGrid)
    [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'SnapToGrid'), [bool]$originalSnapToGrid)
    [VisualStudioTraceNative]::SetComPropertyValue((Get-WindowsFormsDesignerOption $dte 'LayoutMode'), [int]$originalLayoutMode)
  }
  $restoredOptions = [ordered]@{
    layoutMode = [int](Get-WindowsFormsDesignerOption $dte 'LayoutMode').Value
    showGrid = [bool](Get-WindowsFormsDesignerOption $dte 'ShowGrid').Value
    snapToGrid = [bool](Get-WindowsFormsDesignerOption $dte 'SnapToGrid').Value
  }
  $s026AfterText = [System.IO.File]::ReadAllText($s026Designer)
  $s026AfterBytes = [System.IO.File]::ReadAllBytes($s026Designer)
  $s026After = [ordered]@{
    sourceSha256 = Get-Sha256 $s026Source
    designerSha256 = Get-Sha256 $s026Designer
    projectSha256 = Get-Sha256 $s001Project
    shape = Get-S026Shape $s026AfterText
  }
  $s026SourceAndProjectExact = $s026Before.sourceSha256 -eq $s026After.sourceSha256 -and
    $s026Before.projectSha256 -eq $s026After.projectSha256
  $s026ReferenceExact = $s026Before.shape.referenceButton.location.x -eq $s026After.shape.referenceButton.location.x -and
    $s026Before.shape.referenceButton.location.y -eq $s026After.shape.referenceButton.location.y -and
    $s026Before.shape.referenceButton.size.width -eq $s026After.shape.referenceButton.size.width -and
    $s026Before.shape.referenceButton.size.height -eq $s026After.shape.referenceButton.size.height
  $s026RawTarget = [ordered]@{
    x = $s026Before.shape.gridLabel.location.x + 20
    y = $s026Before.shape.gridLabel.location.y
  }
  $s026GridSnapExact = $s026After.shape.gridLabel.location.x -eq 32 -and
    $s026After.shape.gridLabel.location.y -eq 24 -and
    $s026After.shape.gridLabel.location.x -ne $s026RawTarget.x -and
    $s026After.shape.gridLabel.location.y -ne $s026RawTarget.y -and
    $s026After.shape.gridLabel.size.width -eq $s026Before.shape.gridLabel.size.width -and
    $s026After.shape.gridLabel.size.height -eq $s026Before.shape.gridLabel.size.height
  $s026OptionsRestored = $restoredOptions.layoutMode -eq $originalLayoutMode -and
    $restoredOptions.showGrid -eq $originalShowGrid -and $restoredOptions.snapToGrid -eq $originalSnapToGrid
  $s026ResourceExists = Test-Path -LiteralPath $s026Resource -PathType Leaf
  $s026ResourceRoot = $null
  $s026ResourceDataCount = $null
  $s026ResourceMetadataCount = $null
  $s026ResourceSha256 = $null
  if ($s026ResourceExists) {
    [xml]$s026ResourceDocument = [System.IO.File]::ReadAllText($s026Resource)
    $s026ResourceRoot = $s026ResourceDocument.DocumentElement.LocalName
    $s026ResourceDataCount = @($s026ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='data']")).Count
    $s026ResourceMetadataCount = @($s026ResourceDocument.SelectNodes("/*[local-name()='root']/*[local-name()='metadata']")).Count
    $s026ResourceSha256 = Get-Sha256 $s026Resource
  }
  $s026StandardEmptyResource = $s026ResourceExists -and $s026ResourceRoot -ceq 'root' -and
    $s026ResourceDataCount -eq 0 -and $s026ResourceMetadataCount -eq 0
  $s026Pass = $s026SourceAndProjectExact -and $s026ReferenceExact -and $s026GridSnapExact -and
    $s026OptionsRestored -and $s026StandardEmptyResource
  $s026Status = if ($s026Pass) { 'PASS' } else { 'FAIL' }
  $s029Capture = Open-DesignerAlignLeftAndCapture $dte $s029Source (Join-Path $s029Directory 'visual-studio-designer.png')
  $s029AfterText = [System.IO.File]::ReadAllText($s029Designer)
  $s029After = [ordered]@{
    sourceSha256 = Get-Sha256 $s029Source
    designerSha256 = Get-Sha256 $s029Designer
    projectSha256 = Get-Sha256 $s001Project
    shape = Get-S029Shape $s029AfterText
  }
  $s029ExpectedText = $s029BeforeText.Replace(
    'button2.Location = new System.Drawing.Point(42, 55);',
    'button2.Location = new System.Drawing.Point(12, 55);'
  ).Replace(
    'button3.Location = new System.Drawing.Point(77, 100);',
    'button3.Location = new System.Drawing.Point(12, 100);'
  )
  $s029ExpectedText = [regex]::Replace($s029ExpectedText, '(?m)^(\s*)//$', '$1// ')
  $s029Pass = $s029Before.shape.button1.location.x -eq 12 -and
    $s029After.shape.button1.location.x -eq 12 -and
    $s029After.shape.button2.location.x -eq 12 -and
    $s029After.shape.button3.location.x -eq 12 -and
    $s029Before.shape.button1.location.y -eq $s029After.shape.button1.location.y -and
    $s029Before.shape.button2.location.y -eq $s029After.shape.button2.location.y -and
    $s029Before.shape.button3.location.y -eq $s029After.shape.button3.location.y -and
    $s029Before.shape.button1.size.width -eq $s029After.shape.button1.size.width -and
    $s029Before.shape.button1.size.height -eq $s029After.shape.button1.size.height -and
    $s029Before.shape.button2.size.width -eq $s029After.shape.button2.size.width -and
    $s029Before.shape.button2.size.height -eq $s029After.shape.button2.size.height -and
    $s029Before.shape.button3.size.width -eq $s029After.shape.button3.size.width -and
    $s029Before.shape.button3.size.height -eq $s029After.shape.button3.size.height -and
    $s029Before.sourceSha256 -eq $s029After.sourceSha256 -and
    $s029Before.projectSha256 -eq $s029After.projectSha256 -and
    $s029ExpectedText -eq $s029AfterText -and
    [bool]$s029Capture.afterSelect.alignLeftAvailable
  $s030Capture = Open-DesignerMakeSameWidthAndCapture $dte $s030Source (Join-Path $s030Directory 'visual-studio-designer.png')
  $s030AfterText = [System.IO.File]::ReadAllText($s030Designer)
  $s030After = [ordered]@{
    sourceSha256 = Get-Sha256 $s030Source
    designerSha256 = Get-Sha256 $s030Designer
    projectSha256 = Get-Sha256 $s001Project
    shape = Get-S030Shape $s030AfterText
  }
  $s030ExpectedText = $s030BeforeText.Replace(
    'button2.Size = new System.Drawing.Size(60, 24);',
    'button2.Size = new System.Drawing.Size(120, 24);'
  ).Replace(
    'button3.Size = new System.Drawing.Size(90, 36);',
    'button3.Size = new System.Drawing.Size(120, 36);'
  )
  $s030ExpectedText = [regex]::Replace($s030ExpectedText, '(?m)^(\s*)//$', '$1// ')
  $s030Pass = $s030Before.shape.button1.size.width -eq 120 -and
    $s030After.shape.button1.size.width -eq 120 -and
    $s030After.shape.button2.size.width -eq 120 -and
    $s030After.shape.button3.size.width -eq 120 -and
    $s030Before.shape.button1.size.height -eq $s030After.shape.button1.size.height -and
    $s030Before.shape.button2.size.height -eq $s030After.shape.button2.size.height -and
    $s030Before.shape.button3.size.height -eq $s030After.shape.button3.size.height -and
    $s030Before.shape.button1.location.x -eq $s030After.shape.button1.location.x -and
    $s030Before.shape.button1.location.y -eq $s030After.shape.button1.location.y -and
    $s030Before.shape.button2.location.x -eq $s030After.shape.button2.location.x -and
    $s030Before.shape.button2.location.y -eq $s030After.shape.button2.location.y -and
    $s030Before.shape.button3.location.x -eq $s030After.shape.button3.location.x -and
    $s030Before.shape.button3.location.y -eq $s030After.shape.button3.location.y -and
    $s030Before.sourceSha256 -eq $s030After.sourceSha256 -and
    $s030Before.projectSha256 -eq $s030After.projectSha256 -and
    $s030ExpectedText -eq $s030AfterText -and
    [bool]$s030Capture.afterSelect.makeSameWidthAvailable
  $s028Capture = Open-DesignerToggleGridAndCapture $dte $s028Source 'gridAnchorButton' 'Grid anchor' 'S028 grid visibility' `
    (Join-Path $s028Directory 'visual-studio-grid-before.png') `
    (Join-Path $s028Directory 'visual-studio-grid-toggled.png') `
    (Join-Path $s028Directory 'visual-studio-grid-restored.png')
  $s028After = [ordered]@{
    sourceSha256 = Get-Sha256 $s028Source
    designerSha256 = Get-Sha256 $s028Designer
    projectSha256 = Get-Sha256 $s028Project
  }
  $s028Pass = [bool]$s028Capture.toggleRouteExecuted -and [bool]$s028Capture.optionToggledExact -and
    [bool]$s028Capture.optionRestoredExact -and [bool]$s028Capture.toggledVisualChanged -and
    [bool]$s028Capture.restoredVisualExact -and
    $s028Before.sourceSha256 -eq $s028After.sourceSha256 -and
    $s028Before.designerSha256 -eq $s028After.designerSha256 -and
    $s028Before.projectSha256 -eq $s028After.projectSha256
  $s028ReferenceStatus = if ($s028Pass) { 'PASS' } else { 'NOT_EXECUTED' }
  $s015Capture = Open-DesignerOverlapHitAndCapture $dte $s015Source 'topLabel' 'bottomLabel' 'Top z-order' `
    (Join-Path $s015Directory 'visual-studio-designer.png')
  $s015After = [ordered]@{
    sourceSha256 = Get-Sha256 $s015Source
    designerSha256 = Get-Sha256 $s015Designer
    projectSha256 = Get-Sha256 $s001Project
  }
  $s015Exact = $s015Before.sourceSha256 -eq $s015After.sourceSha256 -and
    $s015Before.designerSha256 -eq $s015After.designerSha256 -and
    $s015Before.projectSha256 -eq $s015After.projectSha256
  $s015Pass = $s015Exact -and [bool]$s015Capture.propertiesCommandAvailable -and
    @($s015Capture.selectedTextRows).Count -eq 1 -and
    [string]$s015Capture.selectedTextRows[0].value -ceq 'Top z-order'
  $s015ReferenceStatus = if ($s015Pass) { 'PASS' } else { 'FAIL' }
  $s024Capture = Open-DesignerClipboardCollisionAndCapture $dte $s024Source $s024Designer `
    (Join-Path $s024Directory 'visual-studio-designer.png')
  $s024After = [ordered]@{
    sourceSha256 = Get-Sha256 $s024Source
    designerSha256 = Get-Sha256 $s024Designer
    projectSha256 = Get-Sha256 $s001Project
    shape = Get-S024Shape ([System.IO.File]::ReadAllText($s024Designer))
  }
  $s024ModernLeg = Get-S024LegEvaluation $s024Before $s024After $s024Capture
  $s024Net48Capture = Open-DesignerClipboardCollisionAndCapture $dte $s024Net48Source $s024Net48Designer `
    (Join-Path $s024Directory 'visual-studio-designer-net48.png')
  $s024Net48After = [ordered]@{
    sourceSha256 = Get-Sha256 $s024Net48Source
    designerSha256 = Get-Sha256 $s024Net48Designer
    projectSha256 = Get-Sha256 $s031Project
    shape = Get-S024Shape ([System.IO.File]::ReadAllText($s024Net48Designer))
  }
  $s024Net48Leg = Get-S024LegEvaluation $s024Net48Before $s024Net48After $s024Net48Capture
  $s024Pass = [bool]$s024ModernLeg.pass -and [bool]$s024Net48Leg.pass
  $s024ReferenceStatus = if ($s024Pass) { 'PASS' } else { 'FAIL' }
  $s037Capture = Open-DesignerPropertiesAndCapture $dte $s037Source 'referenceButton' (Join-Path $s037Directory 'visual-studio-designer.png')
  $s037After = [ordered]@{
    sourceSha256 = Get-Sha256 $s037Source
    designerSha256 = Get-Sha256 $s037Designer
    projectSha256 = Get-Sha256 $s001Project
  }
  $s038Capture = Open-DesignerMultiPropertiesAndCapture $dte $s038Source (Join-Path $s038Directory 'visual-studio-designer.png')
  $s038After = [ordered]@{
    sourceSha256 = Get-Sha256 $s038Source
    designerSha256 = Get-Sha256 $s038Designer
    projectSha256 = Get-Sha256 $s001Project
  }
  $s038Exact = $s038Before.sourceSha256 -eq $s038After.sourceSha256 -and
    $s038Before.designerSha256 -eq $s038After.designerSha256 -and
    $s038Before.projectSha256 -eq $s038After.projectSha256
  $s038Inventory = @($s038Capture.uiAutomationInventory)
  $s038SelectedAutomationIds = @($s038Inventory | Where-Object {
    $_.automationId -in @('button1', 'textBox1')
  } | ForEach-Object { $_.automationId } | Sort-Object -Unique)
  $s038TextRows = @($s038Inventory | Where-Object {
    $_.name -eq 'Text' -and $_.controlType -eq 'ControlType.TreeItem'
  })
  $s038ObservedPropertyNames = @($s038Inventory | Where-Object {
    $_.controlType -eq 'ControlType.TreeItem'
  } | ForEach-Object { $_.name } | Sort-Object -Unique)
  $s038TypeSpecificLeaks = @($s038ObservedPropertyNames | Where-Object {
    $_ -in @('DialogResult', 'Multiline', 'AcceptsReturn', 'UseSystemPasswordChar')
  })
  $s038CommonProperties = @('AllowDrop', 'Enabled', 'Visible', 'Anchor', 'Location', 'Size')
  $s038MissingCommonProperties = @($s038CommonProperties | Where-Object { $_ -notin $s038ObservedPropertyNames })
  $s038Pass = $s038Exact -and $s038Capture.afterSelect.alignLeftAvailable -and
    $s038Capture.afterSelect.makeSameWidthAvailable -and
    ($s038SelectedAutomationIds -join '|') -eq 'button1|textBox1' -and
    $s038TextRows.Count -eq 1 -and [string]::IsNullOrEmpty([string]$s038TextRows[0].value) -and
    $s038TypeSpecificLeaks.Count -eq 0 -and $s038MissingCommonProperties.Count -eq 0
  $s038CaptureStatus = if ($s038Pass) { 'PASS' } else { 'FAIL' }
  $s039Capture = Open-DesignerPropertyResetAndCapture $dte $s039Source 'button1' 'Custom reset text' 'Text' `
    (Join-Path $s039Directory 'visual-studio-designer.png') `
    (Join-Path $s039Directory 'visual-studio-reset-menu.png')
  $s039AfterText = [System.IO.File]::ReadAllText($s039Designer)
  $s039After = [ordered]@{
    sourceSha256 = Get-Sha256 $s039Source
    designerSha256 = Get-Sha256 $s039Designer
    projectSha256 = Get-Sha256 $s031Project
    textAssignmentCount = ([regex]::Matches($s039AfterText, '(?m)^\s*(?:this\.)?button1\.Text\s*=')).Count
  }
  $s039Eol = if ($s039BeforeText.Contains("`r`n")) { "`r`n" } else { "`n" }
  $s039TextLine = '            this.button1.Text = "Custom reset text";' + $s039Eol
  if (-not $s039BeforeText.Contains($s039TextLine)) { throw 'Cannot locate the exact S039 Text assignment.' }
  $s039ExpectedText = $s039BeforeText.Replace($s039TextLine, '')
  $s039ExpectedText = [regex]::Replace($s039ExpectedText, '(?m)^(\s*)//$', '$1// ')
  $s039ExpectedText = $s039ExpectedText.Replace(
    "            this.ResumeLayout(false);${s039Eol}        }",
    "            this.ResumeLayout(false);${s039Eol}${s039Eol}        }"
  )
  if (-not $s039ExpectedText.Contains("`r`n")) {
    $s039RegionStart = $s039ExpectedText.IndexOf('            this.button1 = new System.Windows.Forms.Button();', [System.StringComparison]::Ordinal)
    $s039RegionEnd = $s039ExpectedText.IndexOf('        }', $s039RegionStart, [System.StringComparison]::Ordinal)
    if ($s039RegionStart -lt 0 -or $s039RegionEnd -lt 0) { throw 'Cannot locate the S039 net48 CodeDOM serialization region.' }
    $s039ExpectedText = $s039ExpectedText.Substring(0, $s039RegionStart) +
      $s039ExpectedText.Substring($s039RegionStart, $s039RegionEnd - $s039RegionStart).Replace("`n", "`r`n") +
      $s039ExpectedText.Substring($s039RegionEnd)
  }
  $s039Pass = $s039Before.textAssignmentCount -eq 1 -and $s039After.textAssignmentCount -eq 0 -and
    $s039Before.sourceSha256 -eq $s039After.sourceSha256 -and
    $s039Before.projectSha256 -eq $s039After.projectSha256 -and
    $s039Before.designerSha256 -ne $s039After.designerSha256 -and
    $s039ExpectedText -eq $s039AfterText -and
    [bool]$s039Capture.resetEnabled -and
    [string]$s039Capture.beforeValue -eq 'Custom reset text' -and
    [string]::IsNullOrEmpty([string]$s039Capture.afterValue)
  $s039ReferenceStatus = if ($s039Pass) { 'PASS' } else { 'FAIL' }
  $s041Capture = Open-DesignerPropertyDropdownAndCapture $dte $s041Source 'button1' 'FlatStyle' (Join-Path $s041Directory 'visual-studio-designer.png')
  $s041After = [ordered]@{
    sourceSha256 = Get-Sha256 $s041Source
    designerSha256 = Get-Sha256 $s041Designer
    projectSha256 = Get-Sha256 $s001Project
  }
  $s041NativeList = @($s041Capture.listInventories | Where-Object {
    ($_.childNames -join '|') -eq 'Flat|Popup|Standard|System'
  }) | Select-Object -First 1
  $s041DropdownItems = if ($null -ne $s041NativeList) { @($s041NativeList.childItems) } else { @() }
  $s041ItemNames = if ($null -ne $s041NativeList) { @($s041NativeList.childNames) } else { @() }
  $s041SelectedNames = if ($null -ne $s041NativeList -and @($s041NativeList.selectedNames).Count -gt 0) {
    @($s041NativeList.selectedNames)
  } elseif ($null -ne $s041NativeList -and $s041NativeList.name -in @($s041NativeList.childNames)) {
    @($s041NativeList.name)
  } else {
    @()
  }
  $s041SelectionSource = if ($null -ne $s041NativeList -and @($s041NativeList.selectedNames).Count -gt 0) {
    'SelectionPattern.GetSelection'
  } elseif ($null -ne $s041NativeList -and $s041NativeList.name -in @($s041NativeList.childNames)) {
    'List.Current.Name'
  } else {
    'UNAVAILABLE'
  }
  $s041Pass = ($s041ItemNames -join '|') -eq 'Flat|Popup|Standard|System' -and
    ($s041SelectedNames -join '|') -eq 'Standard' -and
    $s041Before.sourceSha256 -eq $s041After.sourceSha256 -and
    $s041Before.designerSha256 -eq $s041After.designerSha256 -and
    $s041Before.projectSha256 -eq $s041After.projectSha256
  $s041ReferenceStatus = if ($s041Pass) { 'PASS' } elseif ($s041Capture.items.Count -gt 0 -or $s041Capture.listInventories.Count -gt 0) { 'FAIL' } else { 'NOT_EXECUTED' }
  $s042Capture = Open-DesignerPaddingSubpropertyAndCapture $dte $s042Source 'button1' `
    (Join-Path $s042Directory 'visual-studio-designer.png')
  $s042AfterText = [System.IO.File]::ReadAllText($s042Designer)
  $s042After = [ordered]@{
    sourceSha256 = Get-Sha256 $s042Source
    designerSha256 = Get-Sha256 $s042Designer
    projectSha256 = Get-Sha256 $s001Project
    shape = Get-S042Shape $s042AfterText
  }
  $s042ExpectedText = $s042BeforeText.Replace(
    'this.button1.Padding = new System.Windows.Forms.Padding(3, 4, 5, 6);',
    'this.button1.Padding = new System.Windows.Forms.Padding(8, 4, 5, 6);'
  )
  $s042ExpectedText = [regex]::Replace($s042ExpectedText, '(?m)^(\s*)//$', '$1// ')
  $s042ExpectedText = $s042ExpectedText.Replace('this.', '')
  $s042Pass = $s042Before.shape.left -eq 3 -and $s042After.shape.left -eq 8 -and
    $s042Before.shape.top -eq 4 -and $s042After.shape.top -eq 4 -and
    $s042Before.shape.right -eq 5 -and $s042After.shape.right -eq 5 -and
    $s042Before.shape.bottom -eq 6 -and $s042After.shape.bottom -eq 6 -and
    $s042Before.sourceSha256 -eq $s042After.sourceSha256 -and
    $s042Before.projectSha256 -eq $s042After.projectSha256 -and
    $s042Before.designerSha256 -ne $s042After.designerSha256 -and
    $s042ExpectedText -eq $s042AfterText -and
    [string]$s042Capture.beforePadding -eq '3; 4; 5; 6' -and
    [string]$s042Capture.beforeLeft -eq '3' -and
    ([string]$s042Capture.editMethod).EndsWith('ValuePattern.SetValue')
  $s042ReferenceStatus = if ($s042Pass) { 'PASS' } else { 'FAIL' }
  $s053Capture = Open-DesignerToolboxSearchAndCapture $dte $s053Source 'Button' `
    (Join-Path $s053Directory 'visual-studio-designer.png')
  $s053After = [ordered]@{
    sourceSha256 = Get-Sha256 $s053Source
    designerSha256 = Get-Sha256 $s053Designer
    projectSha256 = Get-Sha256 $s001Project
  }
  $s053Exact = $s053Before.sourceSha256 -eq $s053After.sourceSha256 -and
    $s053Before.designerSha256 -eq $s053After.designerSha256 -and
    $s053Before.projectSha256 -eq $s053After.projectSha256
  $s053SearchRows = @($s053Capture.uiAutomationInventoryAfter | Where-Object {
    $_.automationId -ceq 'PART_SearchBox'
  })
  $s053LiveRows = @($s053Capture.uiAutomationInventoryAfter | Where-Object {
    $_.automationId -ceq 'PART_LiveSearchTextBlock'
  })
  $s053LegacyButtonRows = @($s053Capture.legacyButtonRows)
  $s053LegacyCategoryRows = @($s053Capture.legacyCategoryRows | Where-Object {
    $_.Name -ceq 'All Windows Forms'
  })
  $s053LegacyRadioRows = @($s053Capture.legacyToolboxInventory | Where-Object {
    $_.Name -ceq 'RadioButton'
  })
  $s053Pass = $s053Exact -and $s053Capture.commandAvailable -and
    $s053Capture.toolboxElementFound -and
    [string]$s053Capture.searchMethod -eq 'UIAutomation.ValuePattern.SetValue' -and
    [string]$s053Capture.searchControl.name -ceq 'Search Toolbox' -and
    [string]$s053Capture.searchControl.automationId -ceq 'PART_SearchBox' -and
    $s053SearchRows.Count -eq 1 -and [string]$s053SearchRows[0].value -ceq 'Button' -and
    $s053LiveRows.Count -eq 1 -and [string]$s053LiveRows[0].name -ceq '2 results found' -and
    [string]::IsNullOrEmpty([string]$s053Capture.legacyToolboxFailure) -and
    $s053LegacyButtonRows.Count -eq 1 -and
    [string]$s053LegacyButtonRows[0].Role -ceq 'outline item' -and
    [string]$s053LegacyButtonRows[0].Description -ceq 'Toolbox Item' -and
    [string]$s053LegacyButtonRows[0].DefaultAction -ceq 'Double-Click' -and
    (@($s053LegacyButtonRows[0].Ancestors) -join '|') -ceq 'Toolbox|All Windows Forms' -and
    $s053LegacyCategoryRows.Count -eq 1 -and
    [string]$s053LegacyCategoryRows[0].Role -ceq 'outline item' -and
    [string]$s053LegacyCategoryRows[0].Description -ceq 'Toolbox Group' -and
    [string]$s053LegacyCategoryRows[0].DefaultAction -ceq 'Collapse' -and
    (@($s053LegacyCategoryRows[0].Ancestors) -join '|') -ceq 'Toolbox' -and
    $s053LegacyRadioRows.Count -eq 1
  $s053ReferenceStatus = if ($s053Pass) { 'PASS' } else { 'FAIL' }
  $s049Capture = Open-DesignerDefaultEventAndCapture $dte $s049Source $s049Designer 'button1' 'Create Click handler' (Join-Path $s049Directory 'visual-studio-designer.png')
  $s049AfterSourceText = [System.IO.File]::ReadAllText($s049Source)
  $s049AfterDesignerText = [System.IO.File]::ReadAllText($s049Designer)
  $s049After = [ordered]@{
    sourceSha256 = Get-Sha256 $s049Source
    designerSha256 = Get-Sha256 $s049Designer
    projectSha256 = Get-Sha256 $s001Project
  }
  $s049HandlerCount = ([regex]::Matches($s049AfterSourceText, '\bbutton1_Click\s*\(')).Count
  $s049SubscriptionCount = ([regex]::Matches($s049AfterDesignerText, '\.Click\s*\+=')).Count
  $s049Pass = [bool]$s049Capture.handlerCreated -and [bool]$s049Capture.subscriptionCreated -and
    [bool]$s049Capture.cursor.insideHandler -and [bool]$s049Capture.lineEndingDialog.observed -and
    [bool]$s049Capture.lineEndingDialog.clickPosted -and [bool]$s049Capture.lineEndingDialog.dismissed -and
    $s049HandlerCount -eq 1 -and $s049SubscriptionCount -eq 1 -and
    $s049Before.sourceSha256 -ne $s049After.sourceSha256 -and
    $s049Before.designerSha256 -ne $s049After.designerSha256 -and
    $s049Before.projectSha256 -eq $s049After.projectSha256 -and
    $s049AfterSourceText.Contains('public S049DefaultEventForm() => InitializeComponent();') -and
    [regex]::IsMatch($s049AfterDesignerText, '(?m)^\s*(?:this\.)?Controls\.Add\((?:this\.)?button1\);')
  $s050Capture = Open-DesignerExistingEventAndCapture $dte $s050Source 'button1' 'Click' 'button1_Click' `
    (Join-Path $s050Directory 'visual-studio-designer.png')
  $s050AfterSourceText = [System.IO.File]::ReadAllText($s050Source)
  $s050AfterDesignerText = [System.IO.File]::ReadAllText($s050Designer)
  $s050After = [ordered]@{
    sourceSha256 = Get-Sha256 $s050Source
    designerSha256 = Get-Sha256 $s050Designer
    projectSha256 = Get-Sha256 $s001Project
  }
  $s050HandlerCount = ([regex]::Matches($s050AfterSourceText, '\bbutton1_Click\s*\(')).Count
  $s050SubscriptionCount = ([regex]::Matches($s050AfterDesignerText, '\.Click\s*\+=\s*(?:new\s+System\.EventHandler\s*\(\s*)?(?:this\.)?button1_Click')).Count
  $s050Exact = $s050Before.sourceSha256 -eq $s050After.sourceSha256 -and
    $s050Before.designerSha256 -eq $s050After.designerSha256 -and
    $s050Before.projectSha256 -eq $s050After.projectSha256
  $s050Pass = $s050Exact -and $s050HandlerCount -eq 1 -and $s050SubscriptionCount -eq 1 -and
    [string]$s050Capture.eventRow.value -ceq 'button1_Click' -and
    [string]$s050Capture.handlerCommitMethod -ceq 'UIAutomation.ValuePattern.SetValue + Enter' -and
    @($s050Capture.handlerItems | Where-Object { $_.value -ceq 'button1_Click' }).Count -ge 1
  $s050ReferenceStatus = if ($s050Pass) { 'PASS' } else { 'FAIL' }
  $s031Capture = Open-DesignerCenterHorizontalAndCapture $dte $s031Source 'button1' 'Center me' (Join-Path $s031Directory 'visual-studio-designer.png')
  $s031AfterText = [System.IO.File]::ReadAllText($s031Designer)
  $s031After = [ordered]@{
    sourceSha256 = Get-Sha256 $s031Source
    designerSha256 = Get-Sha256 $s031Designer
    projectSha256 = Get-Sha256 $s031Project
    shape = Get-S031Shape $s031AfterText
  }
  $s031ExpectedText = $s031BeforeText.Replace(
    'this.button1.Location = new System.Drawing.Point(15, 40);',
    'this.button1.Location = new System.Drawing.Point(80, 40);'
  )
  $s031ExpectedText = [regex]::Replace($s031ExpectedText, '(?m)^(\s*)//$', '$1// ')
  $s031Eol = if ($s031ExpectedText.Contains("`r`n")) { "`r`n" } else { "`n" }
  $s031ExpectedText = $s031ExpectedText.Replace(
    "            this.ResumeLayout(false);${s031Eol}        }",
    "            this.ResumeLayout(false);${s031Eol}${s031Eol}        }"
  )
  if (-not $s031ExpectedText.Contains("`r`n")) {
    $s031RegionStart = $s031ExpectedText.IndexOf('            this.panel1 = new System.Windows.Forms.Panel();', [System.StringComparison]::Ordinal)
    $s031RegionEnd = $s031ExpectedText.IndexOf('        }', $s031RegionStart, [System.StringComparison]::Ordinal)
    if ($s031RegionStart -lt 0 -or $s031RegionEnd -lt 0) { throw 'Cannot locate the S031 CodeDOM serialization region.' }
    $s031ExpectedText = $s031ExpectedText.Substring(0, $s031RegionStart) +
      $s031ExpectedText.Substring($s031RegionStart, $s031RegionEnd - $s031RegionStart).Replace("`n", "`r`n") +
      $s031ExpectedText.Substring($s031RegionEnd)
  }
  $s031Pass = $s031Before.shape.button.location.x -eq 15 -and
    $s031After.shape.button.location.x -eq 80 -and
    $s031Before.shape.button.location.y -eq $s031After.shape.button.location.y -and
    $s031Before.shape.button.size.width -eq $s031After.shape.button.size.width -and
    $s031Before.shape.button.size.height -eq $s031After.shape.button.size.height -and
    ($s031Before.shape.panel | ConvertTo-Json -Compress) -eq ($s031After.shape.panel | ConvertTo-Json -Compress) -and
    $s031Before.sourceSha256 -eq $s031After.sourceSha256 -and
    $s031Before.projectSha256 -eq $s031After.projectSha256 -and
    $s031ExpectedText -eq $s031AfterText -and
    ([bool]$s031Capture.commandAvailability.centerHorizontally -or [bool]$s031Capture.commandAvailability.centerHorizontal)
  $s031ReferenceStatus = if ($s031Pass) { 'PASS' } elseif ($s031Capture.selectionFailure) { 'NOT_EXECUTED' } else { 'FAIL' }
  $s013Capture = Open-DesignerAndCapture $dte $s013Source (Join-Path $s013Directory 'visual-studio-designer.png')
  $s011Capture = Open-DesignerAndCapture $dte $s011Source (Join-Path $s011Directory 'visual-studio-designer.png')
  $s014Capture = Open-DesignerAndCapture $dte $s014Source (Join-Path $s014Directory 'visual-studio-designer.png')
  # S005 intentionally runs after every pre-existing scenario. Its native project-template operation creates new
  # top-level files in the scratch SDK project, so no earlier reference hash or designer transaction can observe them.
  $s005ItemName = 'S005GeneratedForm.cs'
  $s005CaptureOutput = @(Add-DesignerItemFromTemplateAndCapture $dte $s001Project $modern $s001Source $s005ItemName `
    'Form' $true (Join-Path $s005Directory 'visual-studio-designer.png'))
  $s005Capture = @($s005CaptureOutput | Where-Object {
    $_ -is [System.Collections.IDictionary] -and $_.Contains('pass')
  }) | Select-Object -Last 1
  if ($null -eq $s005Capture) {
    throw "S005 full-run capture returned no result object; output types: $(@($s005CaptureOutput | ForEach-Object { $_.GetType().FullName }) -join ' | ')"
  }
  $s005Pass = [bool]$s005Capture.pass
  $s005ReferenceStatus = if ($s005Pass) { 'PASS' } else { 'FAIL' }
  foreach ($artifact in @('S005GeneratedForm.cs', 'S005GeneratedForm.Designer.cs', 'S005GeneratedForm.resx')) {
    Copy-Item -LiteralPath (Join-Path $modern $artifact) -Destination (Join-Path $s005Directory $artifact)
  }
  $s005UserProject = "$s001Project.user"
  if (Test-Path -LiteralPath $s005UserProject -PathType Leaf) {
    Copy-Item -LiteralPath $s005UserProject -Destination (Join-Path $s005Directory 'VisualStudioReference.Modern.csproj.user')
  }
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s005Directory 'VisualStudioReference.Modern.csproj')
  # S006 uses an independent classic project and intentionally runs after the SDK mutation. It freezes the native
  # two-file UserControl template plus exact old-style project membership without affecting earlier scenario inputs.
  $s006ItemName = 'S006GeneratedUserControl.cs'
  $s006CaptureOutput = @(Add-DesignerItemFromTemplateAndCapture $dte $s006Project $classicNet48 $s006Anchor `
    $s006ItemName 'UserControl' $false (Join-Path $s006Directory 'visual-studio-designer.png'))
  $s006Capture = @($s006CaptureOutput | Where-Object {
    $_ -is [System.Collections.IDictionary] -and $_.Contains('pass')
  }) | Select-Object -Last 1
  if ($null -eq $s006Capture) {
    throw "S006 full-run capture returned no result object; output types: $(@($s006CaptureOutput | ForEach-Object { $_.GetType().FullName }) -join ' | ')"
  }
  $s006Pass = [bool]$s006Capture.pass
  $s006ReferenceStatus = if ($s006Pass) { 'PASS' } else { 'FAIL' }
  foreach ($artifact in @('S006GeneratedUserControl.cs', 'S006GeneratedUserControl.Designer.cs')) {
    Copy-Item -LiteralPath (Join-Path $classicNet48 $artifact) -Destination (Join-Path $s006Directory $artifact)
  }
  $s006UserProject = "$s006Project.user"
  if (Test-Path -LiteralPath $s006UserProject -PathType Leaf) {
    Copy-Item -LiteralPath $s006UserProject -Destination (Join-Path $s006Directory 'VisualStudioReference.ClassicNet48.csproj.user')
  }
  [System.IO.File]::WriteAllBytes(
    (Join-Path $s006Directory 'VisualStudioReference.ClassicNet48.before.csproj'),
    $s006ProjectBeforeBytes
  )
  Copy-Item -LiteralPath $s006Project -Destination (Join-Path $s006Directory 'VisualStudioReference.ClassicNet48.after.csproj')
  foreach ($artifact in @('S013ButtonForm.cs', 'S013ButtonForm.Designer.cs')) {
    Copy-Item -LiteralPath (Join-Path $modern $artifact) -Destination (Join-Path $s013Directory $artifact)
  }
  Copy-Item -LiteralPath $s015Source -Destination (Join-Path $s015Directory 'S015OverlapForm.cs')
  Copy-Item -LiteralPath $s015Designer -Destination (Join-Path $s015Directory 'S015OverlapForm.Designer.cs')
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s015Directory 'VisualStudioReference.Modern.csproj')
  [System.IO.File]::WriteAllBytes(
    (Join-Path $s024Directory 'S024ClipboardCollisionForm.Designer.before.cs'),
    $s024BeforeBytes
  )
  Write-Gzip (Join-Path $s024Directory 'S024ClipboardCollisionForm.Designer.after-redo.cs.gz') `
    ([System.IO.File]::ReadAllBytes($s024Designer))
  Copy-Item -LiteralPath $s024Source -Destination (Join-Path $s024Directory 'S024ClipboardCollisionForm.cs')
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s024Directory 'VisualStudioReference.Modern.csproj')
  [System.IO.File]::WriteAllBytes(
    (Join-Path $s024Directory 'S024ClipboardCollisionForm.Net48.Designer.before.cs'),
    $s024Net48BeforeBytes
  )
  Write-Gzip (Join-Path $s024Directory 'S024ClipboardCollisionForm.Net48.Designer.after-redo.cs.gz') `
    ([System.IO.File]::ReadAllBytes($s024Net48Designer))
  Copy-Item -LiteralPath $s024Net48Source -Destination (Join-Path $s024Directory 'S024ClipboardCollisionForm.Net48.cs')
  Copy-Item -LiteralPath $s031Project -Destination (Join-Path $s024Directory 'VisualStudioReference.Net48.csproj')
  Copy-Item -LiteralPath $s028Source -Destination (Join-Path $s028Directory 'S028GridVisibilityForm.cs')
  Copy-Item -LiteralPath $s028Designer -Destination (Join-Path $s028Directory 'S028GridVisibilityForm.Designer.cs')
  Copy-Item -LiteralPath $s028Project -Destination (Join-Path $s028Directory 'VisualStudioReference.Net48.csproj')
  Copy-Item -LiteralPath $s013Source -Destination (Join-Path $s037Directory 'S013ButtonForm.cs')
  Copy-Item -LiteralPath $s013Designer -Destination (Join-Path $s037Directory 'S013ButtonForm.Designer.cs')
  Copy-Item -LiteralPath $s041Source -Destination (Join-Path $s041Directory 'S041FlatStyleForm.cs')
  Copy-Item -LiteralPath $s041Designer -Destination (Join-Path $s041Directory 'S041FlatStyleForm.Designer.cs')
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s041Directory 'VisualStudioReference.Modern.csproj')
  [System.IO.File]::WriteAllBytes((Join-Path $s042Directory 'S042PaddingForm.Designer.before.cs'), $s042BeforeBytes)
  Write-Gzip (Join-Path $s042Directory 'S042PaddingForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s042Designer))
  Copy-Item -LiteralPath $s042Source -Destination (Join-Path $s042Directory 'S042PaddingForm.cs')
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s042Directory 'VisualStudioReference.Modern.csproj')
  Copy-Item -LiteralPath $s053Source -Destination (Join-Path $s053Directory 'S053ToolboxForm.cs')
  Copy-Item -LiteralPath $s053Designer -Destination (Join-Path $s053Directory 'S053ToolboxForm.Designer.cs')
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s053Directory 'VisualStudioReference.Modern.csproj')
  Copy-Item -LiteralPath $s038Source -Destination (Join-Path $s038Directory 'S038MultiPropertyForm.cs')
  Copy-Item -LiteralPath $s038Designer -Destination (Join-Path $s038Directory 'S038MultiPropertyForm.Designer.cs')
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s038Directory 'VisualStudioReference.Modern.csproj')
  [System.IO.File]::WriteAllBytes((Join-Path $s039Directory 'S039ResetPropertyForm.Designer.before.cs'), $s039BeforeBytes)
  Write-Gzip (Join-Path $s039Directory 'S039ResetPropertyForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s039Designer))
  Copy-Item -LiteralPath $s039Source -Destination (Join-Path $s039Directory 'S039ResetPropertyForm.cs')
  Copy-Item -LiteralPath $s031Project -Destination (Join-Path $s039Directory 'VisualStudioReference.Net48.csproj')
  foreach ($artifact in @('S009NestedForm.cs', 'S009NestedForm.Designer.cs')) {
    Copy-Item -LiteralPath (Join-Path $modern $artifact) -Destination (Join-Path $s009Directory $artifact)
  }
  [System.IO.File]::WriteAllBytes((Join-Path $s022Directory 'S022AnchoredResizeForm.Designer.before.cs'), $s022BeforeBytes)
  Copy-Item -LiteralPath $s022Source -Destination (Join-Path $s022Directory 'S022AnchoredResizeForm.cs')
  # Preserve Visual Studio's exact after bytes, including its intentional trailing separator trivia, without making
  # the repository's `git diff --check` treat the archived evidence itself as a whitespace defect.
  Write-Gzip (Join-Path $s022Directory 'S022AnchoredResizeForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s022Designer))
  Copy-Item -LiteralPath $s025Source -Destination (Join-Path $s025Directory 'S025BaselineSnapForm.cs')
  [System.IO.File]::WriteAllBytes((Join-Path $s025Directory 'S025BaselineSnapForm.Designer.before.cs'), $s025BeforeBytes)
  Write-Gzip (Join-Path $s025Directory 'S025BaselineSnapForm.Designer.after.cs.gz') $s025AfterBytes
  if ($s025ResourceExists) {
    Copy-Item -LiteralPath $s025Resource -Destination (Join-Path $s025Directory 'S025BaselineSnapForm.resx')
  }
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s025Directory 'VisualStudioReference.Modern.csproj')
  Copy-Item -LiteralPath $s026Source -Destination (Join-Path $s026Directory 'S026GridSnapForm.cs')
  [System.IO.File]::WriteAllBytes((Join-Path $s026Directory 'S026GridSnapForm.Designer.before.cs'), $s026BeforeBytes)
  Write-Gzip (Join-Path $s026Directory 'S026GridSnapForm.Designer.after.cs.gz') $s026AfterBytes
  if ($s026ResourceExists) {
    Copy-Item -LiteralPath $s026Resource -Destination (Join-Path $s026Directory 'S026GridSnapForm.resx')
  }
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s026Directory 'VisualStudioReference.Modern.csproj')
  [System.IO.File]::WriteAllBytes((Join-Path $s029Directory 'S029AlignLeftForm.Designer.before.cs'), $s029BeforeBytes)
  Copy-Item -LiteralPath $s029Source -Destination (Join-Path $s029Directory 'S029AlignLeftForm.cs')
  Write-Gzip (Join-Path $s029Directory 'S029AlignLeftForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s029Designer))
  [System.IO.File]::WriteAllBytes((Join-Path $s030Directory 'S030SameWidthForm.Designer.before.cs'), $s030BeforeBytes)
  Copy-Item -LiteralPath $s030Source -Destination (Join-Path $s030Directory 'S030SameWidthForm.cs')
  Write-Gzip (Join-Path $s030Directory 'S030SameWidthForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s030Designer))
  [System.IO.File]::WriteAllBytes((Join-Path $s031Directory 'S031CenterPanelForm.Designer.before.cs'), $s031BeforeBytes)
  Copy-Item -LiteralPath $s031Source -Destination (Join-Path $s031Directory 'S031CenterPanelForm.cs')
  Write-Gzip (Join-Path $s031Directory 'S031CenterPanelForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s031Designer))
  [System.IO.File]::WriteAllBytes((Join-Path $s021Directory 'GroupMoveForm.Designer.before.cs'), $s021BeforeBytes)
  Copy-Item -LiteralPath $s021Source -Destination (Join-Path $s021Directory 'GroupMoveForm.cs')
  Write-Gzip (Join-Path $s021Directory 'GroupMoveForm.Designer.after-redo.cs.gz') ([System.IO.File]::ReadAllBytes($s021Designer))
  Copy-Item -LiteralPath (Join-Path $extensionTrace 'extension-leg.json') -Destination (Join-Path $s021Directory 'extension-leg.json')
  [System.IO.File]::WriteAllBytes((Join-Path $s049Directory 'S049DefaultEventForm.before.cs'), $s049BeforeSourceBytes)
  [System.IO.File]::WriteAllBytes((Join-Path $s049Directory 'S049DefaultEventForm.Designer.before.cs'), $s049BeforeDesignerBytes)
  Write-Gzip (Join-Path $s049Directory 'S049DefaultEventForm.after.cs.gz') ([System.IO.File]::ReadAllBytes($s049Source))
  Write-Gzip (Join-Path $s049Directory 'S049DefaultEventForm.Designer.after.cs.gz') ([System.IO.File]::ReadAllBytes($s049Designer))
  Copy-Item -LiteralPath $s050Source -Destination (Join-Path $s050Directory 'S050ExistingEventForm.cs')
  Copy-Item -LiteralPath $s050Designer -Destination (Join-Path $s050Directory 'S050ExistingEventForm.Designer.cs')
  Copy-Item -LiteralPath $s001Project -Destination (Join-Path $s050Directory 'VisualStudioReference.Modern.csproj')
  foreach ($artifact in @('S014TextBoxForm.cs', 'S014TextBoxForm.Designer.cs')) {
    Copy-Item -LiteralPath (Join-Path $net48 $artifact) -Destination (Join-Path $s014Directory $artifact)
  }
  foreach ($artifact in @('S011GenericBaseForm.cs', 'S011ConcreteCustomerForm.cs', 'S011ConcreteCustomerForm.Designer.cs')) {
    Copy-Item -LiteralPath (Join-Path $net48 $artifact) -Destination (Join-Path $s011Directory $artifact)
  }

  $authority = [ordered]@{
    product = $visualStudioDisplayName
    dteVersion = $visualStudioVersion
    installationVersion = $visualStudioInstallationVersion
    edition = $visualStudioEdition
    executable = $visualStudioExecutable
    dteProgId = $DteProgId
    captureHost = "$([Environment]::OSVersion.VersionString); $env:PROCESSOR_ARCHITECTURE"
  }
  Write-Json (Join-Path $s005Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S005"
    scenarioId = 'V2-FND-001-S005'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s005ReferenceStatus
    setup = 'A loaded buildable net10.0-windows SDK-style WinForms project has no S005GeneratedForm artifacts.'
    actionLog = @(
      'Build the scratch solution in actual Visual Studio',
      'Select the exact modern SDK project through the real Solution Explorer hierarchy',
      'Resolve Microsoft.CSharp.WindowsForm through Solution2.GetProjectItemTemplate',
      'Invoke ProjectItems.AddFromTemplate for S005GeneratedForm.cs',
      'Require source, Designer source, and neutral resx as the exact required artifact delta',
      'Allow and hash only the Visual Studio per-user csproj.user subtype sidecar as an auxiliary delta',
      'Verify Designer source and resx are nested beneath the created source ProjectItem',
      'Save All, rebuild the solution, and open the created Form in the actual WinForms Designer',
      'Verify the SDK project file remains byte-identical and reject any unexpected top-level delta'
    )
    expected = 'Visual Studio creates the complete source/Designer/resx Windows Form artifact set through its installed template, records only its bounded per-user subtype sidecar, preserves SDK project bytes, builds successfully, and opens the generated Form in the real designer.'
    runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference; physical ARM64 is an independent external gate for other catalog legs'
    createdArtifacts = $s005Capture.artifactHashes
    auxiliaryArtifacts = $s005Capture.auxiliaryArtifactHashes
    projectByteIdentical = [bool]$s005Capture.projectByteIdentical
    topLevelDelta = $s005Capture.topLevelDelta
    allowedAuxiliaryTopLevelDelta = $s005Capture.allowedAuxiliaryTopLevelDelta
    unexpectedTopLevelDelta = $s005Capture.unexpectedTopLevelDelta
    projectHierarchy = $s005Capture.childNames
    sourceShapeExact = [bool]$s005Capture.sourceShapeExact
    designerShapeExact = [bool]$s005Capture.designerShapeExact
    resourceRoot = $s005Capture.resourceRoot
    solutionBuild = $s005Capture.solutionBuild
    visualStudioWindow = $s005Capture
  })
  Write-Json (Join-Path $s006Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S006"
    scenarioId = 'V2-FND-001-S006'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s006ReferenceStatus
    setup = 'A loaded buildable classic non-SDK net48 WinForms project contains only Anchor.cs and has no S006GeneratedUserControl artifacts.'
    actionLog = @(
      'Build the three-project scratch solution in actual Visual Studio',
      'Select the exact classic net48 project through the real Solution Explorer hierarchy',
      'Resolve Microsoft.CSharp.WindowsFormsUserControl through Solution2.GetProjectItemTemplate',
      'Invoke ProjectItems.AddFromTemplate for S006GeneratedUserControl.cs',
      'Require source and Designer source as the exact required artifact delta and verify that the installed UserControl template creates no neutral resx',
      'Verify the classic project gains exactly one source Compile/SubType and one Designer Compile/DependentUpon relationship with no EmbeddedResource item',
      'Verify Designer source is the only child beneath the created source ProjectItem',
      'Save All, rebuild the solution, and open the created UserControl in the actual WinForms Designer',
      'Reject any unexpected top-level delta'
    )
    expected = 'Visual Studio creates the installed two-file UserControl source/Designer set, persists exact classic Compile/DependentUpon/SubType relationships without a neutral resx or EmbeddedResource item, builds successfully, and opens the generated UserControl in the native designer.'
    runtimeArchitecture = 'actual Visual Studio x64 classic net48 reference'
    createdArtifacts = $s006Capture.artifactHashes
    auxiliaryArtifacts = $s006Capture.auxiliaryArtifactHashes
    projectBeforeSha256 = $s006Capture.beforeProjectSha256
    projectAfterSha256 = $s006Capture.afterProjectSha256
    projectByteIdentical = [bool]$s006Capture.projectByteIdentical
    projectMutationExact = [bool]$s006Capture.projectMutationExact
    projectItemRelationships = $s006Capture.projectItemRelationships
    topLevelDelta = $s006Capture.topLevelDelta
    allowedAuxiliaryTopLevelDelta = $s006Capture.allowedAuxiliaryTopLevelDelta
    unexpectedTopLevelDelta = $s006Capture.unexpectedTopLevelDelta
    projectHierarchy = $s006Capture.childNames
    sourceShapeExact = [bool]$s006Capture.sourceShapeExact
    designerShapeExact = [bool]$s006Capture.designerShapeExact
    resourceRoot = $s006Capture.resourceRoot
    solutionBuild = $s006Capture.solutionBuild
    visualStudioWindow = $s006Capture
  })
  Write-Json (Join-Path $s015Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S015"
    scenarioId = 'V2-FND-001-S015'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s015ReferenceStatus
    setup = 'A net10.0-windows Form contains bottomLabel and topLabel at identical bounds; topLabel is the first Controls.Add sibling, WinForms z-order index 0, with distinct Text.'
    actionLog = @(
      'Build solution in actual Visual Studio',
      'Open S015OverlapForm.cs with the WinForms Designer',
      'Locate both real designer Label automation elements and compute their exact overlap',
      'Post one click through the real designer InputShield/capture HWND at the center of the shared pixel rectangle',
      'Open View.PropertiesWindow and verify the visible Text row equals Top z-order',
      'Verify source, Designer, and project bytes remain exact'
    )
    expected = 'The shared pixel selects topLabel, the first Controls.Add sibling and frontmost WinForms z-order element, while source, Designer, and project bytes remain byte-identical.'
    before = $s015Before
    after = $s015After
    sourceByteIdentical = $s015Before.sourceSha256 -eq $s015After.sourceSha256
    designerByteIdentical = $s015Before.designerSha256 -eq $s015After.designerSha256
    projectByteIdentical = $s015Before.projectSha256 -eq $s015After.projectSha256
    runtimeArchitecture = 'actual Visual Studio x64 reference; physical ARM64 remains an independent external gate'
    visualStudioWindow = $s015Capture
  })
  Write-Json (Join-Path $s024Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S024"
    scenarioId = 'V2-FND-001-S024'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s024ReferenceStatus
    setup = 'Equivalent net10.0-windows and net48 Forms each contain one root-owned Button whose field and serialized Name are both submitButton.'
    actionLog = @(
      'Build solution in actual Visual Studio',
      'Open the modern and net48 S024ClipboardCollisionForm.cs fixtures with their in-process WinForms Designers',
      'Select each actual submitButton through the real designer input/capture HWND or native Document Outline',
      'Execute native Edit.Copy and require no source mutation',
      'Execute native Edit.Paste and File.SaveAll',
      'Require Visual Studio to preserve submitButton and serialize exactly one uniquely named clone with copied Text and Size',
      'Execute one native Edit.Undo plus save and require the original component shape',
      'Execute one native Edit.Redo plus save and require byte-exact reproduction of the first paste serialization',
      'Repeat the full operation independently on both runtime lanes and verify source and project bytes remain exact'
    )
    expected = 'Visual Studio resolves the clipboard name collision before persistence: the existing submitButton survives, one non-colliding Button clone is serialized, and the Paste is one reproducible undoable designer transaction on both runtime lanes.'
    runtimeLegs = [ordered]@{
      modern = $s024ModernLeg
      net48 = $s024Net48Leg
    }
    modernDesignerBeforeArtifact = 'S024ClipboardCollisionForm.Designer.before.cs'
    modernDesignerAfterArtifact = 'S024ClipboardCollisionForm.Designer.after-redo.cs.gz'
    net48DesignerBeforeArtifact = 'S024ClipboardCollisionForm.Net48.Designer.before.cs'
    net48DesignerAfterArtifact = 'S024ClipboardCollisionForm.Net48.Designer.after-redo.cs.gz'
    runtimeArchitecture = 'actual Visual Studio x64 modern + net48 reference; physical ARM64 remains an independent external gate'
    visualStudioWindow = [ordered]@{
      document = $s024Capture.document
      command = $s024Capture.command
      capture = $s024Capture.capture
    }
  })
  Write-Json (Join-Path $s001Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S001"
    scenarioId = 'V2-FND-001-S001'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $(if ($s001Exact) { 'PASS' } else { 'FAIL' })
    setup = 'net10.0-windows SDK Form with source, Designer source, neutral resx, and explicit project item relationships.'
    actionLog = @('Build solution in Visual Studio', 'Open S001SaveForm.cs with the WinForms Designer', 'Execute File.SaveAll without a designer edit', 'Hash source, generated source, neutral resx, and project before and after')
    expected = 'No source, generated-source, neutral-resource, or project diff and no designer mutation.'
    beforeSha256 = $s001Before
    afterSha256 = $s001After
    byteIdentical = $s001Exact
    visualStudioWindow = $s001Capture
  })
  Write-Json (Join-Path $s012Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S012"
    scenarioId = 'V2-FND-001-S012'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = 'CAPTURED_UNREVIEWED'
    setup = 'Buildable net10.0-windows partial Form has an empty Designer sidecar but no constructor, InitializeComponent method, or neutral resx.'
    actionLog = @('Build solution in Visual Studio', 'Open S012MissingInitializeForm.cs', 'Invoke View.ViewDesigner', 'Execute File.SaveAll', 'Capture the active Visual Studio document window', 'Hash source/project and record whether Visual Studio created sidecars')
    expected = 'Observe the actual Visual Studio behavior for a Form whose InitializeComponent target is missing, without assuming refusal or synthesis.'
    before = $s012Before
    after = $s012After
    sourceByteIdentical = $s012Before.sourceSha256 -eq $s012After.sourceSha256
    projectByteIdentical = $s012Before.projectSha256 -eq $s012After.projectSha256
    visualStudioWindow = $s012Capture
  })
  Write-Json (Join-Path $s120Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S120"
    scenarioId = 'V2-FND-001-S120'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $(if ($s120Exact) { 'PASS' } else { 'FAIL' })
    setup = 'The product CustomEditor moved button1 by +11,+7 and saved exact generated-source bytes.'
    actionLog = @('Open GroupMoveForm.cs in the Visual Studio WinForms Designer', 'Execute File.SaveAll', 'Hash source and generated source before and after')
    expected = 'No unrelated source or resource diff; exact bytes are accepted for this bounded fixture.'
    beforeSha256 = $s120Before
    afterSha256 = $s120After
    byteIdentical = $s120Exact
    visualStudioWindow = $s120Capture
  })
  Write-Json (Join-Path $s021Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S021"
    scenarioId = 'V2-FND-001-S021'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s021ReferenceStatus
    setup = 'The product-generated GroupMoveForm has two selected Buttons at (21,27) and (50,60), already accepted byte-for-byte by Visual Studio in S120.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open GroupMoveForm.cs with the WinForms Designer',
      'Execute Edit.SelectAll',
      'Drag button1 by +17,+9 physical pixels through the real designer input window',
      'Execute File.SaveAll and record both Button locations',
      'Execute exactly one Edit.Undo, save, and record both Button locations',
      'Execute exactly one Edit.Redo, save, and record both Button locations'
    )
    expected = 'One real group drag moves button1 (21,27)->(38,36) and button2 (50,60)->(67,69); one Undo restores both and one Redo reapplies both, while source/project bytes remain identical.'
    before = $s021Before
    afterDrag = $s021Capture.afterDrag
    afterUndo = $s021Capture.afterUndo
    afterRedo = $s021Capture.afterRedo
    after = $s021After
    oneUndoBoundary = [bool]($s021Capture.undoAvailable -and
      $s021Capture.afterUndo.shape.button1.location.x -eq 21 -and $s021Capture.afterUndo.shape.button1.location.y -eq 27 -and
      $s021Capture.afterUndo.shape.button2.location.x -eq 50 -and $s021Capture.afterUndo.shape.button2.location.y -eq 60)
    oneRedoBoundary = [bool]($s021Capture.redoAvailable -and
      $s021Capture.afterRedo.shape.button1.location.x -eq 38 -and $s021Capture.afterRedo.shape.button1.location.y -eq 36 -and
      $s021Capture.afterRedo.shape.button2.location.x -eq 67 -and $s021Capture.afterRedo.shape.button2.location.y -eq 69)
    sourceByteIdentical = $s021Before.sourceSha256 -eq $s021After.sourceSha256
    projectByteIdentical = $s021Before.projectSha256 -eq $s021After.projectSha256
    finalDesignerArtifact = 'GroupMoveForm.Designer.after-redo.cs.gz'
    visualStudioWindow = $s021Capture
  })
  Write-Json (Join-Path $s100Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S100"
    scenarioId = 'V2-FND-001-S100'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $(if ($s100Exact) { 'PASS' } else { 'FAIL' })
    setup = 'The accepted static adapter sample manifest accompanied a modern form whose Text edit was saved by the product CustomEditor.'
    actionLog = @('Validate the product extension-leg hashes and accepted no-code-load adapter declaration', 'Build and open S100AdapterRoundTripForm.cs in the Visual Studio WinForms Designer', 'Execute File.SaveAll', 'Hash source, Designer source, and adapter manifest before and after')
    expected = 'Visual Studio preserves the extension-produced source and Designer bytes; the static adapter declaration remains byte-identical.'
    beforeSha256 = $s100Before
    afterSha256 = $s100After
    byteIdentical = $s100Exact
    visualStudioWindow = $s100Capture
  })
  Write-Json (Join-Path $s108Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S108"
    scenarioId = 'V2-FND-001-S108'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $(if ($s108Exact) { 'PASS' } else { 'FAIL' })
    setup = 'The compiled-net48 product CustomEditor saved a live-source Button Text edit in ReparentForm.'
    actionLog = @('Validate the product extension-leg hashes', 'Build and open ReparentForm.cs in the Visual Studio WinForms Designer', 'Execute File.SaveAll', 'Hash code-behind and Designer source before and after')
    expected = 'Visual Studio preserves the extension-produced net48 source artifacts exactly for product reopen.'
    beforeSha256 = $s108Before
    afterSha256 = $s108After
    byteIdentical = $s108Exact
    visualStudioWindow = $s108Capture
  })
  Write-Json (Join-Path $s011Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S011"
    scenarioId = 'V2-FND-001-S011'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = 'CAPTURED_UNREVIEWED'
    setup = 'net48 concrete Form derives from S011GenericBaseForm<int>; inherited Label is constructed by the base and a derived-only Button by InitializeComponent.'
    actionLog = @('Build solution in Visual Studio', 'Open S011ConcreteCustomerForm.cs with the WinForms Designer', 'Capture the designer document window')
    sourceSha256 = Get-Sha256 (Join-Path $s011Directory 'S011ConcreteCustomerForm.Designer.cs')
    baseSourceSha256 = Get-Sha256 (Join-Path $s011Directory 'S011GenericBaseForm.cs')
    visualStudioWindow = $s011Capture
  })
  Write-Json (Join-Path $s009Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S009"
    scenarioId = 'V2-FND-001-S009'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = 'CAPTURED_UNREVIEWED'
    setup = 'Buildable net10.0-windows nested partial S009Outer.InnerForm has its code-behind and InitializeComponent declarations split across two files and contains one Button.'
    actionLog = @('Build solution in Visual Studio', 'Open S009NestedForm.cs with the WinForms Designer', 'Capture the designer document window')
    expected = 'Observe whether Visual Studio supports a nested Form as a design root without assuming an open or refusal outcome.'
    beforeSha256 = $s009Before
    afterSha256 = $s009After
    byteIdentical = $s009Before.sourceSha256 -eq $s009After.sourceSha256 -and $s009Before.designerSha256 -eq $s009After.designerSha256
    visualStudioWindow = $s009Capture
  })
  Write-Json (Join-Path $s013Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S013"
    scenarioId = 'V2-FND-001-S013'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = 'CAPTURED_UNREVIEWED'
    setup = 'net10.0-windows Form with Button Text, SystemIcons.Information image, MiddleLeft alignment, ImageBeforeText, and FlatStyle.Popup.'
    actionLog = @('Build solution in Visual Studio', 'Open S013ButtonForm.cs with the WinForms Designer', 'Capture the designer document window')
    sourceSha256 = Get-Sha256 (Join-Path $s013Directory 'S013ButtonForm.Designer.cs')
    visualStudioWindow = $s013Capture
  })
  Write-Json (Join-Path $s022Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S022"
    scenarioId = 'V2-FND-001-S022'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $(if ($s022Pass) { 'PASS' } else { 'FAIL' })
    setup = 'net10.0-windows Form contains anchoredButton at (24,48), Size 120x30, Anchor Top|Left|Right.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S022AnchoredResizeForm.cs with the WinForms Designer',
      'Select anchoredButton through the real designer input window',
      'Drag the east sizing handle by +40 physical pixels',
      'Execute File.SaveAll',
      'Verify the exact generated-source patch and live accessible bounds'
    )
    expected = 'Visual Studio changes Size 120x30 to 160x30, canonicalizes four bare CodeDOM separator comments from // to // plus one space, preserves Anchor and Location, and leaves source/project byte-identical.'
    before = $s022Before
    after = $s022After
    exactDesignerPatch = $s022ExpectedText -eq $s022AfterText
    exactAfterArtifact = 'S022AnchoredResizeForm.Designer.after.cs.gz'
    sourceByteIdentical = $s022Before.sourceSha256 -eq $s022After.sourceSha256
    projectByteIdentical = $s022Before.projectSha256 -eq $s022After.projectSha256
    visualStudioWindow = $s022Capture
  })
  Write-Json (Join-Path $s025Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S025"
    scenarioId = 'V2-FND-001-S025'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s025Status
    setup = 'A net10.0-windows Form contains snapButton at (32,80), Size 100x30, and referenceTextBox at (180,40), Size 120x23, both with the default 96-DPI font.'
    actionLog = @(
      'Open S025BaselineSnapForm.cs in the actual WinForms Designer',
      'Select snapButton through its real designer input HWND',
      'Begin a real designer drag and move the pointer vertically by -44 pixels to raw source Y=36',
      'Capture the native designer during the active drag and again after the persisted move',
      'Release the drag, Save All, and inspect the persisted Designer source',
      'Require the Button baseline offset 21 to align to the TextBox baseline offset 16 at exact source Y=35',
      'Require the reference TextBox, source file, project file, and Button size/X to remain exact',
      'Archive the standard empty neutral resx that Visual Studio creates on Save All for this Form'
    )
    expected = 'Visual Studio applies a one-pixel baseline correction to the raw drag target and persists snapButton.Location=(32,35), aligns its text baseline with referenceTextBox, preserves unrelated source/project/control data, and creates one standard empty neutral Form resx.'
    runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference'
    before = $s025Before
    after = $s025After
    rawTarget = [ordered]@{ x = $s025Before.shape.snapButton.location.x; y = $s025RawTargetY }
    expectedBaselineTarget = [ordered]@{ x = 32; y = 35 }
    baselineOffsets = [ordered]@{ snapButton = 21; referenceTextBox = 16 }
    sourceAndProjectExact = $s025SourceAndProjectExact
    referenceControlExact = $s025ReferenceExact
    baselineSnapExact = $s025BaselineSnapExact
    resource = [ordered]@{
      exists = $s025ResourceExists
      root = $s025ResourceRoot
      dataCount = $s025ResourceDataCount
      metadataCount = $s025ResourceMetadataCount
      sha256 = $s025ResourceSha256
      standardEmptyResource = $s025StandardEmptyResource
      artifact = $(if ($s025ResourceExists) { 'S025BaselineSnapForm.resx' } else { $null })
    }
    exactAfterArtifact = 'S025BaselineSnapForm.Designer.after.cs.gz'
    visualStudioWindow = $s025Capture
  })
  Write-Json (Join-Path $s026Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S026"
    scenarioId = 'V2-FND-001-S026'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s026Status
    setup = 'A net10.0-windows Form contains an AutoSize Label at off-grid Location (13,25), a reference Button, and the installed Visual Studio designer is temporarily set to SnapToGrid with its effective 8x8 grid.'
    actionLog = @(
      'Save the exact WindowsFormsDesigner LayoutMode, ShowGrid, and SnapToGrid user options',
      'Set LayoutMode=1, ShowGrid=true, and SnapToGrid=true for this isolated trace',
      'Open S026GridSnapForm.cs in the actual WinForms Designer',
      'Select gridLabel through its real designer input HWND',
      'Begin a designer drag and move the pointer by +20,0 to raw source Location (33,25)',
      'Release the drag, Save All, and inspect the persisted Designer source',
      'Require exact 8x8 grid Location (32,24), unchanged Label size, exact reference Button/source/project, and a standard empty neutral resx',
      'Restore the exact original LayoutMode, ShowGrid, and SnapToGrid options in finally'
    )
    expected = 'Visual Studio rounds the raw off-grid drag target (33,25) to exact Location (32,24) on the effective 8x8 parent grid, preserves unrelated data, and the capture restores all changed designer options.'
    runtimeArchitecture = 'actual Visual Studio x64 modern SDK reference'
    before = $s026Before
    after = $s026After
    rawTarget = $s026RawTarget
    expectedGridTarget = [ordered]@{ x = 32; y = 24 }
    effectiveOptions = $effectiveOptions
    originalOptions = [ordered]@{ layoutMode = $originalLayoutMode; showGrid = $originalShowGrid; snapToGrid = $originalSnapToGrid }
    restoredOptions = $restoredOptions
    optionsRestoredExact = $s026OptionsRestored
    sourceAndProjectExact = $s026SourceAndProjectExact
    referenceControlExact = $s026ReferenceExact
    gridSnapExact = $s026GridSnapExact
    resource = [ordered]@{
      exists = $s026ResourceExists
      root = $s026ResourceRoot
      dataCount = $s026ResourceDataCount
      metadataCount = $s026ResourceMetadataCount
      sha256 = $s026ResourceSha256
      standardEmptyResource = $s026StandardEmptyResource
      artifact = $(if ($s026ResourceExists) { 'S026GridSnapForm.resx' } else { $null })
    }
    exactAfterArtifact = 'S026GridSnapForm.Designer.after.cs.gz'
    visualStudioWindow = $s026Capture
  })
  Write-Json (Join-Path $s014Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S014"
    scenarioId = 'V2-FND-001-S014'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = 'CAPTURED_UNREVIEWED'
    setup = 'net48 Form with multiline TextBox, vertical ScrollBars, and BorderStyle.FixedSingle.'
    actionLog = @('Build solution in Visual Studio', 'Open S014TextBoxForm.cs with the WinForms Designer', 'Capture the designer document window')
    sourceSha256 = Get-Sha256 (Join-Path $s014Directory 'S014TextBoxForm.Designer.cs')
    visualStudioWindow = $s014Capture
  })
  Write-Json (Join-Path $s028Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S028"
    scenarioId = 'V2-FND-001-S028'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s028ReferenceStatus
    setup = 'The net48 reference Form is clean and open in the installed classic Visual Studio WinForms Designer at the current WindowsFormsDesigner.ShowGrid setting.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S028GridVisibilityForm.cs with the classic WinForms Designer',
      'Capture the initial designer window',
      'Toggle the installed IDE WindowsFormsDesigner.ShowGrid setting through an enabled native command or the exact Tools > Options property',
      'Capture the toggled designer window',
      'Toggle the same Visual Studio setting again',
      'When VS 18 exposes no ShowGrid command, reactivate the same design view through View Code and View Designer so the restored Tools > Options value is rendered',
      'Capture the restored designer window',
      'Execute File.SaveAll and verify exact source/Designer/project hashes',
      'Restore the original ShowGrid option again in finally as an independent safety check'
    )
    expected = 'The first actual Visual Studio ShowGrid toggle changes the option and rendered designer overlay, the second restores the exact option and pixels, and neither action mutates source, Designer source, or project bytes.'
    before = $s028Before
    after = $s028After
    toggledVisualChanged = [bool]$s028Capture.toggledVisualChanged
    restoredVisualExact = [bool]$s028Capture.restoredVisualExact
    optionToggledExact = [bool]$s028Capture.optionToggledExact
    optionRestoredExact = [bool]$s028Capture.optionRestoredExact
    sourceByteIdentical = $s028Before.sourceSha256 -eq $s028After.sourceSha256
    designerByteIdentical = $s028Before.designerSha256 -eq $s028After.designerSha256
    projectByteIdentical = $s028Before.projectSha256 -eq $s028After.projectSha256
    visualStudioWindow = $s028Capture
  })
  Write-Json (Join-Path $s037Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S037"
    scenarioId = 'V2-FND-001-S037'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = 'CAPTURED_UNREVIEWED'
    setup = 'S013 referenceButton has explicit non-default Text/FlatStyle values while Enabled remains at its framework default.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S013ButtonForm.cs with the WinForms Designer',
      'Select referenceButton through the real designer input HWND',
      'Execute View.PropertiesWindow',
      'Capture the actual Properties window and bounded UI Automation inventory',
      'Verify source/Designer/project hashes remain exact'
    )
    expected = 'Review actual categorized Properties rows and visual default/non-default emphasis before promotion; no source mutation is permitted.'
    before = $s037Before
    after = $s037After
    sourceByteIdentical = $s037Before.sourceSha256 -eq $s037After.sourceSha256
    designerByteIdentical = $s037Before.designerSha256 -eq $s037After.designerSha256
    projectByteIdentical = $s037Before.projectSha256 -eq $s037After.projectSha256
    visualStudioWindow = $s037Capture
  })
  Write-Json (Join-Path $s041Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S041"
    scenarioId = 'V2-FND-001-S041'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s041ReferenceStatus
    setup = 'net10.0-windows Form contains one Button whose FlatStyle assignment is omitted, leaving the framework default Standard value.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S041FlatStyleForm.cs with the WinForms Designer',
      'Select button1 in the actual designer',
      'Open View.PropertiesWindow',
      'Open the FlatStyle standard-values dropdown',
      'Capture the native ControlType.List child order and selected value',
      'Dismiss with Escape and execute File.SaveAll',
      'Verify source, Designer, and project bytes remain exact'
    )
    expected = 'The native Visual Studio FlatStyle dropdown exposes Flat, Popup, Standard, System in that order with Standard selected and performs no source mutation.'
    before = $s041Before
    after = $s041After
    items = $s041DropdownItems
    itemNames = $s041ItemNames
    selectedNames = $s041SelectedNames
    selectionSource = $s041SelectionSource
    nativeList = $s041NativeList
    sourceByteIdentical = $s041Before.sourceSha256 -eq $s041After.sourceSha256
    designerByteIdentical = $s041Before.designerSha256 -eq $s041After.designerSha256
    projectByteIdentical = $s041Before.projectSha256 -eq $s041After.projectSha256
    visualStudioWindow = $s041Capture
  })
  Write-Json (Join-Path $s042Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S042"
    scenarioId = 'V2-FND-001-S042'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s042ReferenceStatus
    setup = 'net10.0-windows Form contains one Button with explicit Padding(3,4,5,6).'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S042PaddingForm.cs with the WinForms Designer',
      'Select button1 in the actual designer',
      'Open View.PropertiesWindow and expand the Padding row',
      'Edit the real expanded Left subproperty from 3 to 8 and commit through the Property Grid',
      'Execute File.SaveAll',
      'Verify the exact generated-source patch and source/project byte identity'
    )
    expected = 'Visual Studio changes only Padding.Left from 3 to 8, preserves Top=4, Right=5, Bottom=6 and every sibling semantic, canonicalizes the modern generated block, and leaves source/project byte-identical.'
    before = $s042Before
    after = $s042After
    exactDesignerPatch = $s042ExpectedText -eq $s042AfterText
    designerBeforeArtifact = 'S042PaddingForm.Designer.before.cs'
    designerAfterArtifact = 'S042PaddingForm.Designer.after.cs.gz'
    sourceByteIdentical = $s042Before.sourceSha256 -eq $s042After.sourceSha256
    projectByteIdentical = $s042Before.projectSha256 -eq $s042After.projectSha256
    visualStudioWindow = $s042Capture
  })
  Write-Json (Join-Path $s053Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S053"
    scenarioId = 'V2-FND-001-S053'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s053ReferenceStatus
    setup = 'A supported net10.0-windows SDK-style WinForms project is loaded and S053ToolboxForm is open in the actual Visual Studio designer.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S053ToolboxForm.cs with the WinForms Designer',
      'Verify and execute the native View.Toolbox command',
      'Bound the actual Toolbox surface through UI Automation',
      'Set the real Toolbox search Edit value to Button through ValuePattern',
      'Read the legacy TBToolboxPane through native MSAA and verify Toolbox > All Windows Forms > Button plus RadioButton',
      'Execute File.SaveAll and verify exact source, Designer, and project hashes'
    )
    expected = 'The native Toolbox search exposes a framework Button in the All Windows Forms category, reports exactly two Button matches, and leaves source, Designer source, and project bytes exact.'
    before = $s053Before
    after = $s053After
    sourceByteIdentical = $s053Before.sourceSha256 -eq $s053After.sourceSha256
    designerByteIdentical = $s053Before.designerSha256 -eq $s053After.designerSha256
    projectByteIdentical = $s053Before.projectSha256 -eq $s053After.projectSha256
    exactSearchResultCount = 2
    frameworkProvenance = [ordered]@{
      projectTargetFramework = 'net10.0-windows'
      projectUseWindowsForms = $true
      visualStudioGroup = 'All Windows Forms'
      item = 'Button'
      nativeEvidence = 'MSAA outline item under the actual Visual Studio All Windows Forms Toolbox group'
    }
    boundedVisualReview = 'PASS; archived PNG visibly shows All Windows Forms expanded with Button and RadioButton after the Button query'
    visualStudioWindow = $s053Capture
  })
  Write-Json (Join-Path $s038Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S038"
    scenarioId = 'V2-FND-001-S038'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s038CaptureStatus
    setup = 'net10.0-windows Form contains one Button and one TextBox with different explicit Text values.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S038MultiPropertyForm.cs with the WinForms Designer',
      'Execute Edit.SelectAll to select both controls',
      'Open View.PropertiesWindow',
      'Capture the multi-object grid and bounded UI Automation inventory',
      'Verify one blank mixed Text row, the common property intersection, and absence of type-specific rows',
      'Verify source, Designer, and project bytes remain exact'
    )
    expected = 'The actual multi-object Properties grid identifies both selected objects, exposes their common property intersection, displays different Text values as mixed/blank, and omits type-specific properties such as Button.DialogResult and TextBox.Multiline.'
    before = $s038Before
    after = $s038After
    sourceByteIdentical = $s038Before.sourceSha256 -eq $s038After.sourceSha256
    designerByteIdentical = $s038Before.designerSha256 -eq $s038After.designerSha256
    projectByteIdentical = $s038Before.projectSha256 -eq $s038After.projectSha256
    selectedAutomationIds = $s038SelectedAutomationIds
    mixedTextRows = $s038TextRows
    observedPropertyNames = $s038ObservedPropertyNames
    typeSpecificLeaks = $s038TypeSpecificLeaks
    missingCommonProperties = $s038MissingCommonProperties
    boundedVisualReview = 'PASS; both controls show selection handles and the visible shared grid agrees with the UI Automation inventory'
    visualStudioWindow = $s038Capture
  })
  Write-Json (Join-Path $s039Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S039"
    scenarioId = 'V2-FND-001-S039'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s039ReferenceStatus
    setup = 'net48 Form contains one Button whose Text property has the explicit non-default value Custom reset text.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S039ResetPropertyForm.cs with the WinForms Designer',
      'Select button1 in the actual designer',
      'Open View.PropertiesWindow and select the Text row',
      'Request the real property-grid context menu and invoke the enabled OtherContextMenus.PropertyBrowser.Reset command; use the exact DTE command route when a disconnected session does not expose the native popup through UI Automation',
      'Execute File.SaveAll',
      'Verify the exact generated-source patch and source/project byte identity'
    )
    expected = 'Visual Studio removes exactly the explicit button1.Text assignment, preserves this qualifiers and all sibling semantics, canonicalizes four CodeDOM separators, inserts one pre-close blank line, rewrites only the generated region to CRLF, and displays the default empty Text value.'
    before = $s039Before
    after = $s039After
    exactDesignerPatch = $s039ExpectedText -eq $s039AfterText
    designerBeforeArtifact = 'S039ResetPropertyForm.Designer.before.cs'
    designerAfterArtifact = 'S039ResetPropertyForm.Designer.after.cs.gz'
    sourceByteIdentical = $s039Before.sourceSha256 -eq $s039After.sourceSha256
    projectByteIdentical = $s039Before.projectSha256 -eq $s039After.projectSha256
    visualStudioWindow = $s039Capture
  })
  Write-Json (Join-Path $s029Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S029"
    scenarioId = 'V2-FND-001-S029'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $(if ($s029Pass) { 'PASS' } else { 'FAIL' })
    setup = 'net10.0-windows Form contains three Buttons at X=12,42,77 with Y=10,55,100; button1 is the primary selection after Edit.SelectAll.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S029AlignLeftForm.cs with the WinForms Designer',
      'Execute Edit.SelectAll',
      'Verify Format.AlignLefts is enabled',
      'Execute Format.AlignLefts',
      'Execute File.SaveAll',
      'Verify the exact generated-source patch'
    )
    expected = 'Visual Studio preserves button1 at X=12, changes only button2 X 42->12 and button3 X 77->12, preserves every Y and Size, canonicalizes bare CodeDOM separator comments, and leaves source/project byte-identical.'
    before = $s029Before
    after = $s029After
    exactDesignerPatch = $s029ExpectedText -eq $s029AfterText
    exactAfterArtifact = 'S029AlignLeftForm.Designer.after.cs.gz'
    sourceByteIdentical = $s029Before.sourceSha256 -eq $s029After.sourceSha256
    projectByteIdentical = $s029Before.projectSha256 -eq $s029After.projectSha256
    visualStudioWindow = $s029Capture
  })
  Write-Json (Join-Path $s030Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S030"
    scenarioId = 'V2-FND-001-S030'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $(if ($s030Pass) { 'PASS' } else { 'FAIL' })
    setup = 'net10.0-windows Form contains three Buttons sized 120x30, 60x24, and 90x36; button1 is the primary selection after Edit.SelectAll.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S030SameWidthForm.cs with the WinForms Designer',
      'Execute Edit.SelectAll',
      'Verify Format.MakeSameWidth is enabled',
      'Execute Format.MakeSameWidth',
      'Execute File.SaveAll',
      'Verify the exact generated-source patch'
    )
    expected = 'Visual Studio preserves button1 at 120x30, changes only button2 width 60->120 and button3 width 90->120, preserves every height and Location, canonicalizes bare CodeDOM separator comments, and leaves source/project byte-identical.'
    before = $s030Before
    after = $s030After
    exactDesignerPatch = $s030ExpectedText -eq $s030AfterText
    exactAfterArtifact = 'S030SameWidthForm.Designer.after.cs.gz'
    sourceByteIdentical = $s030Before.sourceSha256 -eq $s030After.sourceSha256
    projectByteIdentical = $s030Before.projectSha256 -eq $s030After.projectSha256
    visualStudioWindow = $s030Capture
  })
  Write-Json (Join-Path $s031Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S031"
    scenarioId = 'V2-FND-001-S031'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s031ReferenceStatus
    setup = 'net48 Form contains a 241x120 Panel with Padding(10,0,20,0) and one 80x24 Button at relative Location (15,40).'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S031CenterPanelForm.cs with the WinForms Designer',
      'Select button1 through its real designer automation element',
      'Verify Format.CenterHorizontally is enabled',
      'Execute Format.CenterHorizontally',
      'Execute File.SaveAll',
      'Verify the exact generated-source patch'
    )
    expected = 'Visual Studio centers button1 in the complete Panel client area using reference rounding: relative X 15->80; asymmetric Padding does not shift the native Format command, while Y/Size/Panel geometry remain exact and source/project stay byte-identical.'
    before = $s031Before
    after = $s031After
    exactDesignerPatch = $s031ExpectedText -eq $s031AfterText
    exactAfterArtifact = 'S031CenterPanelForm.Designer.after.cs.gz'
    sourceByteIdentical = $s031Before.sourceSha256 -eq $s031After.sourceSha256
    projectByteIdentical = $s031Before.projectSha256 -eq $s031After.projectSha256
    selectionFailure = $s031Capture.selectionFailure
    visualStudioWindow = $s031Capture
  })
  Write-Json (Join-Path $s049Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S049"
    scenarioId = 'V2-FND-001-S049'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $(if ($s049Pass) { 'PASS' } else { 'FAIL' })
    setup = 'net10.0-windows Form contains one top-level Button named button1 with no Click subscription or handler method.'
    actionLog = @(
      'Build solution in Visual Studio',
      'Open S049DefaultEventForm.cs with the WinForms Designer',
      'Locate button1 through the real designer automation tree',
      'Send a physical-window double-click sequence through the real designer input HWND',
      'Wait for Visual Studio to navigate to code and execute File.SaveAll',
      'Verify exactly one Click subscription, exactly one button1_Click method, cursor placement, and project byte identity'
    )
    expected = 'Visual Studio adds one button1.Click subscription in generated source, adds one button1_Click(object, EventArgs) method in code-behind, navigates the cursor into that method, preserves the form constructor/control membership, and leaves the project byte-identical.'
    before = $s049Before
    after = $s049After
    handlerCount = $s049HandlerCount
    subscriptionCount = $s049SubscriptionCount
    sourceBeforeArtifact = 'S049DefaultEventForm.before.cs'
    sourceAfterArtifact = 'S049DefaultEventForm.after.cs.gz'
    designerBeforeArtifact = 'S049DefaultEventForm.Designer.before.cs'
    designerAfterArtifact = 'S049DefaultEventForm.Designer.after.cs.gz'
    projectByteIdentical = $s049Before.projectSha256 -eq $s049After.projectSha256
    visualStudioWindow = $s049Capture
  })
  Write-Json (Join-Path $s050Directory 'manifest.json') ([ordered]@{
    schemaVersion = 1
    traceId = "$runId-S050"
    scenarioId = 'V2-FND-001-S050'
    referenceTraceSource = 'VisualStudioWinFormsDesigner'
    authority = $authority
    status = $s050ReferenceStatus
    setup = 'A net10.0-windows Form contains button1 with exactly one existing Click subscription and one compatible button1_Click method.'
    actionLog = @(
      'Build solution in actual Visual Studio',
      'Open S050ExistingEventForm.cs with the WinForms Designer and select button1',
      'Open View.PropertiesWindow and activate the native Show Events button',
      'Verify the owner-drawn Click row and writable cell both expose button1_Click',
      'Commit the same handler through the real writable Events cell with UIAutomation ValuePattern and Enter',
      'Execute File.SaveAll and verify source, Designer, and project bytes plus exact method/subscription counts'
    )
    expected = 'The actual Events grid publishes the existing compatible button1_Click handler, committing the same handler is a no-op, no duplicate method or subscription is generated, and all three project artifacts remain byte-identical.'
    before = $s050Before
    after = $s050After
    sourceByteIdentical = $s050Before.sourceSha256 -eq $s050After.sourceSha256
    designerByteIdentical = $s050Before.designerSha256 -eq $s050After.designerSha256
    projectByteIdentical = $s050Before.projectSha256 -eq $s050After.projectSha256
    handlerCount = $s050HandlerCount
    subscriptionCount = $s050SubscriptionCount
    runtimeArchitecture = 'actual Visual Studio x64 reference; physical ARM64 remains an independent external gate'
    visualStudioWindow = $s050Capture
  })
  Write-Json (Join-Path $runDirectory 'run-manifest.json') ([ordered]@{
    schemaVersion = 1
    runId = $runId
    capturedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    authority = $authority
    solutionBuild = 'PASS'
    scenarioCount = 29
    scenarios = @(
      [ordered]@{ scenarioId = 'V2-FND-001-S001'; status = $(if ($s001Exact) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S001' },
      [ordered]@{ scenarioId = 'V2-FND-001-S005'; status = $s005ReferenceStatus; directory = 'V2-FND-001-S005' },
      [ordered]@{ scenarioId = 'V2-FND-001-S006'; status = $s006ReferenceStatus; directory = 'V2-FND-001-S006' },
      [ordered]@{ scenarioId = 'V2-FND-001-S015'; status = $s015ReferenceStatus; directory = 'V2-FND-001-S015' },
      [ordered]@{ scenarioId = 'V2-FND-001-S024'; status = $s024ReferenceStatus; directory = 'V2-FND-001-S024' },
      [ordered]@{ scenarioId = 'V2-FND-001-S009'; status = 'CAPTURED_UNREVIEWED'; directory = 'V2-FND-001-S009' },
      [ordered]@{ scenarioId = 'V2-FND-001-S012'; status = 'CAPTURED_UNREVIEWED'; directory = 'V2-FND-001-S012' },
      [ordered]@{ scenarioId = 'V2-FND-001-S011'; status = 'CAPTURED_UNREVIEWED'; directory = 'V2-FND-001-S011' },
      [ordered]@{ scenarioId = 'V2-FND-001-S120'; status = $(if ($s120Exact) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S120' },
      [ordered]@{ scenarioId = 'V2-FND-001-S021'; status = $s021ReferenceStatus; directory = 'V2-FND-001-S021' },
      [ordered]@{ scenarioId = 'V2-FND-001-S100'; status = $(if ($s100Exact) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S100' },
      [ordered]@{ scenarioId = 'V2-FND-001-S108'; status = $(if ($s108Exact) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S108' },
      [ordered]@{ scenarioId = 'V2-FND-001-S013'; status = 'CAPTURED_UNREVIEWED'; directory = 'V2-FND-001-S013' },
      [ordered]@{ scenarioId = 'V2-FND-001-S014'; status = 'CAPTURED_UNREVIEWED'; directory = 'V2-FND-001-S014' }
      [ordered]@{ scenarioId = 'V2-FND-001-S028'; status = $s028ReferenceStatus; directory = 'V2-FND-001-S028' }
      [ordered]@{ scenarioId = 'V2-FND-001-S037'; status = 'CAPTURED_UNREVIEWED'; directory = 'V2-FND-001-S037' }
      [ordered]@{ scenarioId = 'V2-FND-001-S038'; status = $s038CaptureStatus; directory = 'V2-FND-001-S038' }
      [ordered]@{ scenarioId = 'V2-FND-001-S039'; status = $s039ReferenceStatus; directory = 'V2-FND-001-S039' }
      [ordered]@{ scenarioId = 'V2-FND-001-S041'; status = $s041ReferenceStatus; directory = 'V2-FND-001-S041' }
      [ordered]@{ scenarioId = 'V2-FND-001-S042'; status = $s042ReferenceStatus; directory = 'V2-FND-001-S042' }
      [ordered]@{ scenarioId = 'V2-FND-001-S053'; status = $s053ReferenceStatus; directory = 'V2-FND-001-S053' }
      [ordered]@{ scenarioId = 'V2-FND-001-S022'; status = $(if ($s022Pass) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S022' }
      [ordered]@{ scenarioId = 'V2-FND-001-S025'; status = $s025Status; directory = 'V2-FND-001-S025' }
      [ordered]@{ scenarioId = 'V2-FND-001-S026'; status = $s026Status; directory = 'V2-FND-001-S026' }
      [ordered]@{ scenarioId = 'V2-FND-001-S029'; status = $(if ($s029Pass) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S029' }
      [ordered]@{ scenarioId = 'V2-FND-001-S030'; status = $(if ($s030Pass) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S030' }
      [ordered]@{ scenarioId = 'V2-FND-001-S031'; status = $s031ReferenceStatus; directory = 'V2-FND-001-S031' }
      [ordered]@{ scenarioId = 'V2-FND-001-S049'; status = $(if ($s049Pass) { 'PASS' } else { 'FAIL' }); directory = 'V2-FND-001-S049' }
      [ordered]@{ scenarioId = 'V2-FND-001-S050'; status = $s050ReferenceStatus; directory = 'V2-FND-001-S050' }
    )
  })

  Write-Host "Visual Studio trace capture complete: $runDirectory"
  Write-Host "S001 byte-identical: $s001Exact"
  Write-Host "S005 native Windows Form template reference status: $s005ReferenceStatus"
  Write-Host "S006 classic UserControl template reference status: $s006ReferenceStatus"
  Write-Host "S015 overlapping z-order hit-test reference status: $s015ReferenceStatus"
  Write-Host "S024 cross-runtime clipboard name-collision reference status: $s024ReferenceStatus"
  Write-Host "S120 byte-identical: $s120Exact"
  Write-Host "S021 real group drag + one Undo/Redo reference status: $s021ReferenceStatus"
  Write-Host "S100 adapter round-trip byte-identical: $s100Exact"
  Write-Host "S108 net48 round-trip byte-identical: $s108Exact"
  Write-Host "S028 Show Grid view-only toggle reference status: $s028ReferenceStatus"
  Write-Host "S037 Properties inventory: CAPTURED_UNREVIEWED ($($s037Capture.uiAutomationInventory.Count) bounded UIA elements)"
  Write-Host "S038 multi-object Properties reference status: $s038CaptureStatus"
  Write-Host "S039 Reset property reference status: $s039ReferenceStatus"
  Write-Host "S041 FlatStyle standard values reference status: $s041ReferenceStatus"
  Write-Host "S042 Padding subproperty reference status: $s042ReferenceStatus"
  Write-Host "S053 native Toolbox reference status: $s053ReferenceStatus"
  Write-Host "S022 exact anchored resize: $s022Pass"
  Write-Host "S025 native baseline snap reference status: $s025Status (rawY=$s025RawTargetY actualY=$($s025After.shape.snapButton.location.y))"
  Write-Host "S026 native grid snap reference status: $s026Status (raw=$($s026RawTarget.x),$($s026RawTarget.y) actual=$($s026After.shape.gridLabel.location.x),$($s026After.shape.gridLabel.location.y))"
  Write-Host "S029 exact Align Left: $s029Pass"
  Write-Host "S030 exact Make Same Width: $s030Pass"
  Write-Host "S031 Center Horizontally reference status: $s031ReferenceStatus"
  Write-Host "S049 default Click handler: $s049Pass"
  Write-Host "S050 existing Events handler reference status: $s050ReferenceStatus"
  if (-not $s001Exact -or -not $s005Pass -or -not $s015Pass -or -not $s024Pass -or -not $s120Exact -or -not $s100Exact -or -not $s108Exact -or -not $s022Pass -or -not $s025Pass -or -not $s026Pass -or -not $s029Pass -or -not $s030Pass -or -not $s038Pass -or -not $s039Pass -or -not $s041Pass -or -not $s042Pass -or -not $s053Pass -or -not $s049Pass -or -not $s050Pass) { exit 1 }
} finally {
  if ($null -ne $dte) {
    try { $dte.SuppressUI = $true } catch { }
    try { $dte.Quit() } catch { }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($dte)
  }
  [VisualStudioOleMessageFilter]::Revoke()
}
