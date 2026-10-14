using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Interop.UIAutomationClient;
using static Murmur.Helper.Native;

namespace Murmur.Helper;

/// <summary>
/// Visible text of the foreground window for command mode ("reply to this", "summarize this"). Prefers the
/// document that holds the keyboard focus, keeping the text before the caret, which is what a reply or a
/// continuation refers to. UI Automation providers can hang, so the read is abandoned at the budget.
/// Password fields are never read.
/// </summary>
internal static class WindowText
{
    private const int BudgetMs = 1500;
    private const int UIA_TextPatternId = 10014;
    private const int UIA_ValuePatternId = 10002;
    private const int UIA_ControlTypePropertyId = 30003;
    private const int UIA_NamePropertyId = 30005;
    private const int UIA_IsPasswordPropertyId = 30019;
    private const int UIA_IsOffscreenPropertyId = 30022;
    private const int UIA_TextControlTypeId = 50020;
    private const int UIA_EditControlTypeId = 50004;
    private const int UIA_DocumentControlTypeId = 50030;
    /// <summary>Share of the budget given to text before the caret.</summary>
    private const double BeforeCaretShare = 0.8;

    private static readonly UiaWorker Reader = new("uia-window", BudgetMs);

    public static JsonObject Read(int maxChars)
    {
        var watch = Stopwatch.StartNew();
        // An abandoned read may still finish later; it never touches the reply sent here.
        var reply = Reader.Run(
            automation => ReadCore(automation, maxChars),
            e => new JsonObject { ["ok"] = false, ["error"] = e.GetType().Name },
            out var result) switch
        {
            UiaWorker.Outcome.Done when result is not null => result,
            UiaWorker.Outcome.Busy => new JsonObject { ["ok"] = false, ["error"] = "busy" },
            _ => new JsonObject { ["ok"] = false, ["error"] = "timeout" },
        };
        reply["elapsedMs"] = watch.ElapsedMilliseconds;
        return reply;
    }

    private static JsonObject ReadCore(CUIAutomation8 automation, int maxChars)
    {
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero) return new JsonObject { ["ok"] = false, ["error"] = "no_window" };
        // An elevated window's UI Automation tree is out of reach of this process.
        if (ForegroundApp.IsElevatedWindow(window)) return new JsonObject { ["ok"] = false, ["error"] = "elevated" };
        GetWindowThreadProcessId(window, out var pid);

        var root = automation.ElementFromHandle(window);
        if (root is null) return new JsonObject { ["ok"] = false, ["error"] = "no_window" };

        var focused = automation.GetFocusedElement();
        if (focused is not null && focused.CurrentIsPassword != 0) return Done("", "password");

        // The document around the focus: the reply box sits inside the page that holds the message.
        // Only when the focus is inside the foreground window, so the walk never reads another app.
        if (focused is not null && focused.CurrentProcessId == pid)
        {
            var walker = automation.ControlViewWalker;
            for (var element = focused; element is not null && automation.CompareElements(element, root) == 0; element = walker.GetParentElement(element))
            {
                if (element.CurrentControlType != UIA_DocumentControlTypeId) continue;
                if (element.GetCurrentPattern(UIA_TextPatternId) is IUIAutomationTextPattern pattern)
                {
                    var text = AroundCaret(pattern, maxChars);
                    if (text.Trim().Length > 0) return Done(text, "focused_document");
                }
            }
        }

        // Otherwise the largest document in the window, from its start.
        var documents = root.FindAll(TreeScope.TreeScope_Descendants, automation.CreateAndCondition(
            automation.CreatePropertyCondition(UIA_ControlTypePropertyId, UIA_DocumentControlTypeId),
            automation.CreatePropertyCondition(UIA_IsOffscreenPropertyId, false)));
        var best = "";
        for (var i = 0; documents is not null && i < documents.Length; i++)
        {
            var document = documents.GetElement(i);
            if (document.CurrentIsPassword != 0) continue;
            if (document.GetCurrentPattern(UIA_TextPatternId) is not IUIAutomationTextPattern pattern) continue;
            var text = pattern.DocumentRange.GetText(maxChars) ?? "";
            if (text.Length > best.Length) best = text;
        }
        if (best.Trim().Length > 0) return Done(best, "document");

        return Done(VisibleLabels(automation, root, maxChars), "elements");
    }

    private static string AroundCaret(IUIAutomationTextPattern pattern, int maxChars)
    {
        var selection = pattern.GetSelection();
        if (selection is null || selection.Length == 0) return pattern.DocumentRange.GetText(maxChars) ?? "";
        // The caret is the end of the selection; collapse to it so a long selection cannot eat the window.
        var range = selection.GetElement(0).Clone();
        range.MoveEndpointByRange(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, range, TextPatternRangeEndpoint.TextPatternRangeEndpoint_End);

        // Text after the caret first, then whatever share it did not use goes to the text before it.
        var afterShare = maxChars - (int)(maxChars * BeforeCaretShare);
        var after = Math.Max(0, range.MoveEndpointByUnit(TextPatternRangeEndpoint.TextPatternRangeEndpoint_End, TextUnit.TextUnit_Character, afterShare));
        range.MoveEndpointByUnit(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, TextUnit.TextUnit_Character, -(maxChars - after));
        return range.GetText(maxChars) ?? "";
    }

    /// <summary>For windows without a text document: static text and edit values in reading order.</summary>
    private static string VisibleLabels(CUIAutomation8 automation, IUIAutomationElement root, int maxChars)
    {
        var cache = automation.CreateCacheRequest();
        cache.AddProperty(UIA_NamePropertyId);
        cache.AddProperty(UIA_ControlTypePropertyId);
        cache.AddProperty(UIA_IsPasswordPropertyId);
        cache.AddPattern(UIA_ValuePatternId);
        var condition = automation.CreateAndCondition(
            automation.CreatePropertyCondition(UIA_IsOffscreenPropertyId, false),
            automation.CreateOrCondition(
                automation.CreatePropertyCondition(UIA_ControlTypePropertyId, UIA_TextControlTypeId),
                automation.CreatePropertyCondition(UIA_ControlTypePropertyId, UIA_EditControlTypeId)));
        var elements = root.FindAllBuildCache(TreeScope.TreeScope_Descendants, condition, cache);

        var text = new StringBuilder();
        var seen = new HashSet<string>();
        for (var i = 0; elements is not null && i < elements.Length && text.Length < maxChars; i++)
        {
            var element = elements.GetElement(i);
            if (element.CachedIsPassword != 0) continue;
            var piece = element.CachedControlType == UIA_EditControlTypeId && element.GetCachedPattern(UIA_ValuePatternId) is IUIAutomationValuePattern value
                ? value.CachedValue
                : element.CachedName;
            piece = piece?.Trim();
            if (string.IsNullOrEmpty(piece) || !seen.Add(piece)) continue;
            text.AppendLine(piece);
        }
        return text.Length > maxChars ? text.ToString(0, maxChars) : text.ToString();
    }

    private static JsonObject Done(string text, string source) =>
        new() { ["ok"] = true, ["text"] = text, ["source"] = source };
}
