using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Interop.UIAutomationClient;
using static Murmur.Helper.Native;

namespace Murmur.Helper;

internal static class ForegroundApp
{
    private const int UIA_ValuePatternId = 10002;
    private const int UIA_TextPatternId = 10014;
    private const int UIA_EditControlTypeId = 50004;
    private const int UIA_DocumentControlTypeId = 50030;
    private const int ReadTimeoutMs = 400;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenElevation = 20;

    public static JsonObject Describe()
    {
        var info = new JsonObject();
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero) return info;

        var title = new StringBuilder(512);
        GetWindowText(window, title, title.Capacity);
        var className = new StringBuilder(256);
        GetClassName(window, className, className.Capacity);
        GetWindowThreadProcessId(window, out var pid);

        info["title"] = title.ToString();
        info["windowClass"] = className.ToString();
        info["pid"] = pid;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            info["process"] = process.ProcessName;
            try
            {
                var module = process.MainModule;
                info["path"] = module?.FileName;
                info["name"] = module?.FileVersionInfo.FileDescription is { Length: > 0 } description ? description : process.ProcessName;
            }
            catch (Exception) { info["name"] = process.ProcessName; } // protected or elevated process
        }
        catch (Exception) { /* window closed between calls */ }
        return info;
    }

    /// <summary>Input injected by a normal process is discarded by windows running elevated.</summary>
    public static bool IsTargetElevated() => IsElevatedWindow(GetForegroundWindow());

    /// <summary>True when the window's process runs elevated and this one does not.</summary>
    public static bool IsElevatedWindow(IntPtr window)
    {
        if (window == IntPtr.Zero) return false;
        GetWindowThreadProcessId(window, out var pid);
        return IsElevated(pid) == true && IsElevated((uint)Environment.ProcessId) != true;
    }

    private static bool? IsElevated(uint pid)
    {
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return null;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return true; // token of a higher-integrity process is unreadable
            try
            {
                return GetTokenInformation(token, TokenElevation, out var elevated, sizeof(int), out _) ? elevated != 0 : null;
            }
            finally { CloseHandle(token); }
        }
        finally { CloseHandle(process); }
    }

    /// <summary>
    /// Text around the caret in the focused control. UI Automation providers can hang, so the read runs
    /// on its own thread and is abandoned at the timeout.
    /// </summary>
    public static JsonObject ReadFocusedText(int maxChars) =>
        Reader.Run(
            automation => ReadFocusedTextCore(automation, maxChars),
            e => new JsonObject { ["available"] = false, ["reason"] = e.GetType().Name },
            out var result) switch
        {
            UiaWorker.Outcome.Done when result is not null => result,
            UiaWorker.Outcome.Busy => new JsonObject { ["available"] = false, ["reason"] = "busy" },
            _ => new JsonObject { ["available"] = false, ["reason"] = "timeout" },
        };

    private static readonly UiaWorker Reader = new("uia-read", ReadTimeoutMs);

    private static JsonObject ReadFocusedTextCore(CUIAutomation8 automation, int maxChars)
    {
        var element = automation.GetFocusedElement();
        if (element is null) return new JsonObject { ["available"] = false, ["reason"] = "no_focus" };

        var result = new JsonObject
        {
            ["available"] = false,
            ["controlType"] = element.CurrentControlType,
            ["editable"] = element.CurrentControlType is UIA_EditControlTypeId or UIA_DocumentControlTypeId,
        };

        if (element.CurrentIsPassword != 0)
        {
            result["isPassword"] = true;
            return result;
        }

        if (element.GetCurrentPattern(UIA_TextPatternId) is IUIAutomationTextPattern textPattern)
        {
            var selection = textPattern.GetSelection();
            if (selection is not null && selection.Length > 0)
            {
                var range = selection.GetElement(0);
                result["selected"] = range.GetText(maxChars) ?? "";

                var before = range.Clone();
                before.MoveEndpointByRange(TextPatternRangeEndpoint.TextPatternRangeEndpoint_End, range, TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start);
                before.MoveEndpointByUnit(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, TextUnit.TextUnit_Character, -maxChars);
                result["before"] = before.GetText(maxChars) ?? "";

                var after = range.Clone();
                after.MoveEndpointByRange(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, range, TextPatternRangeEndpoint.TextPatternRangeEndpoint_End);
                after.MoveEndpointByUnit(TextPatternRangeEndpoint.TextPatternRangeEndpoint_End, TextUnit.TextUnit_Character, maxChars);
                result["after"] = after.GetText(maxChars) ?? "";

                result["available"] = true;
                result["editable"] = true;
                return result;
            }
        }

        // No caret information here, only the whole value.
        if (element.GetCurrentPattern(UIA_ValuePatternId) is IUIAutomationValuePattern valuePattern)
        {
            var value = valuePattern.CurrentValue ?? "";
            result["contents"] = value.Length > maxChars ? value[^maxChars..] : value;
            result["editable"] = valuePattern.CurrentIsReadOnly == 0;
        }
        return result;
    }
}
