using System.Diagnostics;
using System.Text.Json.Nodes;
using static Murmur.Helper.Native;

namespace Murmur.Helper;

internal sealed class Paster(KeyboardHook hook)
{
    private const int ModifierReleaseTimeoutMs = 1200;
    private readonly object _gate = new();

    public JsonObject Paste(string text, string method, int restoreDelayMs, bool restoreClipboard, bool pressEnter, string? expectProcess)
    {
        lock (_gate)
        {
            var watch = Stopwatch.StartNew();
            var result = new JsonObject();

            if (ForegroundApp.IsTargetElevated())
                return Fail(result, "target_elevated", watch);

            WaitForModifierRelease();

            // Checked last, immediately before the keystrokes, so the text cannot land in a window
            // the caller did not intend.
            if (expectProcess is not null)
            {
                var actual = ForegroundApp.Describe()["process"]?.GetValue<string>() ?? "";
                if (!actual.Contains(expectProcess, StringComparison.OrdinalIgnoreCase))
                {
                    result["foreground"] = actual;
                    return Fail(result, "focus_changed", watch);
                }
            }

            var ok = method == "type" ? TypeText(text) : PasteViaClipboard(text, restoreDelayMs, restoreClipboard, result);
            if (!ok && !result.ContainsKey("error")) return Fail(result, "input_blocked", watch);
            if (!ok) return Fail(result, result["error"]!.GetValue<string>(), watch);

            if (pressEnter)
            {
                Thread.Sleep(60);
                Tap(VK_RETURN);
            }

            result["ok"] = true;
            result["elapsedMs"] = watch.ElapsedMilliseconds;
            return result;
        }
    }

    private static JsonObject Fail(JsonObject result, string error, Stopwatch watch)
    {
        result["ok"] = false;
        result["error"] = error;
        result["elapsedMs"] = watch.ElapsedMilliseconds;
        return result;
    }

    /// <summary>
    /// The paste chord must not combine with keys the user is still holding (Win+V would open clipboard
    /// history). Wait for them to let go, then force the stragglers up.
    /// </summary>
    private void WaitForModifierRelease()
    {
        var watch = Stopwatch.StartNew();
        while (hook.AnyModifierDown() && watch.ElapsedMilliseconds < ModifierReleaseTimeoutMs) Thread.Sleep(10);
        if (!hook.AnyModifierDown()) return;

        foreach (var vk in new[] { VK_LCONTROL, VK_RCONTROL, VK_LSHIFT, VK_RSHIFT, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN })
        {
            if (IsDown(vk)) Input.Send(Input.Key(vk, true));
        }
        Thread.Sleep(20);
    }

    private static bool PasteViaClipboard(string text, int restoreDelayMs, bool restoreClipboard, JsonObject result)
    {
        var snapshot = restoreClipboard ? ClipboardAccess.Snapshot() : null;

        var sequence = ClipboardAccess.WriteText(text);
        if (sequence == 0)
        {
            result["error"] = "clipboard_write_failed";
            return false;
        }

        var sent = Input.Send(
            Input.Key(VK_CONTROL, false),
            Input.Key(VK_V, false),
            Input.Key(VK_V, true),
            Input.Key(VK_CONTROL, true));

        // Apps read the clipboard asynchronously after the chord, so the old contents go back only after a pause.
        Thread.Sleep(Math.Clamp(restoreDelayMs, 50, 5000));

        if (snapshot is not null)
        {
            // If anything else wrote to the clipboard meanwhile, that newer content wins.
            if (GetClipboardSequenceNumber() == sequence) ClipboardAccess.Restore(snapshot);
            else result["clipboardChanged"] = true;
        }
        return sent;
    }

    private static bool TypeText(string text)
    {
        const int batchSize = 32;
        var batch = new List<INPUT>(batchSize * 2);
        foreach (var unit in text.ReplaceLineEndings("\n"))
        {
            if (unit == '\n')
            {
                if (!Flush(batch)) return false;
                // Shift+Enter makes a line break in chat boxes instead of sending the message.
                if (!Input.Send(Input.Key(VK_SHIFT, false), Input.Key(VK_RETURN, false), Input.Key(VK_RETURN, true), Input.Key(VK_SHIFT, true)))
                    return false;
                Thread.Sleep(8);
                continue;
            }
            batch.Add(Input.Unicode(unit, false));
            batch.Add(Input.Unicode(unit, true));
            if (batch.Count >= batchSize * 2 && !Flush(batch)) return false;
        }
        return Flush(batch);
    }

    private static bool Flush(List<INPUT> batch)
    {
        if (batch.Count == 0) return true;
        var ok = Input.Send(batch.ToArray());
        batch.Clear();
        Thread.Sleep(4);
        return ok;
    }

    public static void Tap(int vk) => Input.Send(Input.Key(vk, false), Input.Key(vk, true));

    /// <summary>Reads the selection by simulating copy, for apps that expose no accessible text.</summary>
    public string? CopySelection()
    {
        lock (_gate)
        {
            WaitForModifierRelease();
            var snapshot = ClipboardAccess.Snapshot();
            var before = GetClipboardSequenceNumber();

            Input.Send(Input.Key(VK_CONTROL, false), Input.Key(VK_C, false), Input.Key(VK_C, true), Input.Key(VK_CONTROL, true));

            string? selected = null;
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 400)
            {
                Thread.Sleep(20);
                if (GetClipboardSequenceNumber() == before) continue;
                selected = ClipboardAccess.ReadText();
                break;
            }
            if (selected is not null && snapshot is not null) ClipboardAccess.Restore(snapshot);
            return selected;
        }
    }
}
