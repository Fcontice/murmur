using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using static Murmur.Helper.Native;

namespace Murmur.Helper;

internal sealed record Binding(string Id, HashSet<int> Keys, bool WhileCapturing);

/// <summary>
/// Low-level keyboard hook. Shortcuts are matched here rather than by streaming keystrokes to the
/// app: what leaves this process is shortcut transitions and, while recording, the bare fact that
/// some other key was pressed. Which keys are typed is never reported.
/// </summary>
internal sealed class KeyboardHook
{
    private readonly object _gate = new();
    private readonly HashSet<int> _pressed = new();
    private readonly HashSet<int> _swallowed = new();
    private readonly List<Binding> _active = new();
    private List<Binding> _bindings = new();
    private bool _capturing;
    private bool _recording;
    private readonly HashSet<int> _recordedChord = new();

    /// <summary>Set by MURMUR_HELPER_TEST=1 so an automated check can press keys with SendInput.</summary>
    public static readonly bool AcceptInjected = Environment.GetEnvironmentVariable("MURMUR_HELPER_TEST") == "1";

    private LowLevelKeyboardProc? _proc;
    private IntPtr _hook;
    private uint _threadId;

    public void Start()
    {
        var ready = new ManualResetEventSlim();
        var thread = new Thread(() =>
        {
            _threadId = GetCurrentThreadId();
            _proc = HookCallback;
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero)
                Ipc.Log("error", $"Keyboard hook failed: {Marshal.GetLastWin32Error()}");
            ready.Set();
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
        })
        { IsBackground = true, Name = "keyboard-hook" };
        thread.Start();
        ready.Wait();
    }

    public void Stop()
    {
        if (_threadId != 0) PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    }

    public void SetBindings(List<Binding> bindings)
    {
        lock (_gate)
        {
            _bindings = bindings;
            foreach (var binding in _active) EmitShortcut(binding.Id, "up");
            _active.Clear();
        }
    }

    /// <summary>While capturing, capture-only bindings (cancel) are live and unrelated keys are reported.</summary>
    public void SetCapturing(bool capturing)
    {
        lock (_gate) _capturing = capturing;
    }

    /// <summary>Recording mode suspends shortcuts and reports the next chord the user presses.</summary>
    public void SetRecording(bool recording)
    {
        lock (_gate)
        {
            _recording = recording;
            _recordedChord.Clear();
        }
    }

    public bool AnyModifierDown()
    {
        return IsDown(VK_CONTROL) || IsDown(VK_SHIFT) || IsDown(VK_MENU) || IsDown(VK_LWIN) || IsDown(VK_RWIN);
    }

    /// <summary>Left and right variants of a modifier are treated as the same key.</summary>
    public static int Normalize(int vk) => vk switch
    {
        VK_LCONTROL or VK_RCONTROL => VK_CONTROL,
        VK_LSHIFT or VK_RSHIFT => VK_SHIFT,
        VK_LMENU or VK_RMENU => VK_MENU,
        VK_RWIN => VK_LWIN,
        _ => vk,
    };

    private static bool IsModifier(int vk) => vk is VK_CONTROL or VK_SHIFT or VK_MENU or VK_LWIN;

    private static bool PhysicallyDown(int normalized) => normalized switch
    {
        VK_LWIN => IsDown(VK_LWIN) || IsDown(VK_RWIN),
        _ => IsDown(normalized),
    };

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode < 0) return CallNextHookEx(_hook, nCode, wParam, lParam);

        var data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
        // Synthetic input (ours included) never drives shortcuts, except under the hook's own test.
        var injected = (data.flags & LLKHF_INJECTED) != 0;
        if (data.vkCode == VK_UNASSIGNED || (injected && !AcceptInjected)) return CallNextHookEx(_hook, nCode, wParam, lParam);

        var message = wParam.ToInt32();
        var isDown = message is WM_KEYDOWN or WM_SYSKEYDOWN;
        var isUp = message is WM_KEYUP or WM_SYSKEYUP;
        var vk = Normalize((int)data.vkCode);

        bool swallow;
        lock (_gate)
        {
            swallow = isDown ? OnKeyDown(vk) : isUp && OnKeyUp(vk);
        }
        return swallow ? 1 : CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    private bool OnKeyDown(int vk)
    {
        if (_pressed.Contains(vk)) return _swallowed.Contains(vk); // auto-repeat

        // A key-up can be missed (lock screen, elevated window, UAC prompt). Drop anything no longer held.
        // The key being handled is not reflected in the async state yet, so it is added afterwards.
        _pressed.RemoveWhere(key => !PhysicallyDown(key));
        _pressed.Add(vk);

        if (_recording)
        {
            _recordedChord.Add(vk);
            return true;
        }

        if (_capturing)
        {
            var capture = _bindings.FirstOrDefault(b => b.WhileCapturing && b.Keys.Count == 1 && b.Keys.Contains(vk));
            if (capture is not null)
            {
                EmitShortcut(capture.Id, "down");
                EmitShortcut(capture.Id, "up");
                _swallowed.Add(vk);
                return true;
            }
        }

        var match = _bindings.FirstOrDefault(b => !b.WhileCapturing && b.Keys.SetEquals(_pressed));
        if (match is not null)
        {
            if (_active.All(b => b.Id != match.Id))
            {
                _active.Add(match);
                EmitShortcut(match.Id, "down");
                if (match.Keys.Contains(VK_LWIN) || match.Keys.Contains(VK_MENU)) MaskModifierTap();
            }
            if (!IsModifier(vk))
            {
                _swallowed.Add(vk);
                return true;
            }
            return false;
        }

        if (_capturing && !IsModifier(vk)) Ipc.Event("otherKey");
        return false;
    }

    private bool OnKeyUp(int vk)
    {
        _pressed.Remove(vk);

        if (_recording)
        {
            if (_pressed.Count == 0 && _recordedChord.Count > 0)
            {
                var keys = new JsonArray();
                foreach (var key in _recordedChord.Order()) keys.Add(key);
                _recordedChord.Clear();
                _recording = false;
                Ipc.Event("recorded", new JsonObject { ["keys"] = keys });
            }
            return true;
        }

        for (var i = _active.Count - 1; i >= 0; i--)
        {
            if (!_active[i].Keys.Contains(vk)) continue;
            EmitShortcut(_active[i].Id, "up");
            _active.RemoveAt(i);
        }
        return _swallowed.Remove(vk);
    }

    private static void EmitShortcut(string id, string phase) =>
        Ipc.Event("shortcut", new JsonObject { ["id"] = id, ["phase"] = phase });

    /// <summary>
    /// A lone Win or Alt press-and-release opens the Start menu or focuses the menu bar. Tapping an
    /// unassigned key while the modifier is held makes Windows treat it as a chord instead.
    /// </summary>
    private static void MaskModifierTap()
    {
        var inputs = new[]
        {
            Input.Key(VK_UNASSIGNED, false),
            Input.Key(VK_UNASSIGNED, true),
        };
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }
}

internal static class Input
{
    public static INPUT Key(int vk, bool up, bool extended = false)
    {
        var flags = up ? KEYEVENTF_KEYUP : 0;
        if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
        return new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = (ushort)vk, dwFlags = flags } } };
    }

    public static INPUT Unicode(char unit, bool up)
    {
        var flags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        return new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = unit, dwFlags = flags } } };
    }

    public static bool Send(params INPUT[] inputs) =>
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>()) == inputs.Length;
}
