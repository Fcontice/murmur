using System.Text.Json.Nodes;

namespace GloopVoice.Helper;

internal static class Program
{
    /// <summary>Protocol version; EXPECTED_HELPER_VERSION in src/main/helper.ts must match.</summary>
    private const string Version = "2";

    [STAThread]
    private static int Main()
    {
        Ipc.StartWriter();
        var hook = new KeyboardHook();
        var paster = new Paster(hook);
        hook.Start();
        Ipc.Event("ready", new JsonObject { ["version"] = Version });

        // Requests that touch the foreground app run off this thread so a slow paste never delays a shortcut update.
        foreach (var request in Ipc.ReadRequests())
        {
            var type = request["type"]?.GetValue<string>();
            if (type == "quit") break;
            switch (type)
            {
                case "setShortcuts":
                    hook.SetBindings(ParseBindings(request));
                    Reply(request, new JsonObject { ["ok"] = true });
                    break;
                case "setCapturing":
                    hook.SetCapturing(request["active"]?.GetValue<bool>() ?? false);
                    Reply(request, new JsonObject { ["ok"] = true });
                    break;
                case "recordShortcut":
                    hook.SetRecording(request["active"]?.GetValue<bool>() ?? false);
                    Reply(request, new JsonObject { ["ok"] = true });
                    break;
                default:
                    ThreadPool.QueueUserWorkItem(_ => HandleSlow(type, request, paster));
                    break;
            }
        }

        hook.Stop();
        return 0;
    }

    private static void HandleSlow(string? type, JsonObject request, Paster paster)
    {
        try
        {
            switch (type)
            {
                case "hello":
                    Reply(request, new JsonObject { ["ok"] = true, ["version"] = Version });
                    break;
                case "paste":
                    Reply(request, paster.Paste(
                        request["text"]?.GetValue<string>() ?? "",
                        request["method"]?.GetValue<string>() ?? "clipboard",
                        request["restoreDelayMs"]?.GetValue<int>() ?? 350,
                        request["restoreClipboard"]?.GetValue<bool>() ?? true,
                        request["pressEnter"]?.GetValue<bool>() ?? false,
                        request["expectProcess"]?.GetValue<string>()));
                    break;
                case "getContext":
                {
                    var maxChars = request["maxChars"]?.GetValue<int>() ?? 600;
                    Reply(request, new JsonObject
                    {
                        ["ok"] = true,
                        ["app"] = ForegroundApp.Describe(),
                        ["text"] = ForegroundApp.ReadFocusedText(maxChars),
                    });
                    break;
                }
                case "copySelection":
                    Reply(request, new JsonObject { ["ok"] = true, ["text"] = paster.CopySelection(request["expectProcess"]?.GetValue<string>()) });
                    break;
                case "listApps":
                    Reply(request, AppsFolder.List());
                    break;
                case "launchApp":
                    // Not "id": that field carries the request id.
                    Reply(request, AppsFolder.Launch(request["appId"]?.GetValue<string>() ?? ""));
                    break;
                case "getWindowText":
                    Reply(request, WindowText.Read(Math.Clamp(request["maxChars"]?.GetValue<int>() ?? 6000, 100, 20_000)));
                    break;
                case "testKeys" when KeyboardHook.AcceptInjected:
                    // Presses and releases keys in order: positive codes go down, negative come up.
                    foreach (var node in request["sequence"] as JsonArray ?? [])
                    {
                        var code = node!.GetValue<int>();
                        Input.Send(Input.Key(Math.Abs(code), code < 0));
                        Thread.Sleep(request["delayMs"]?.GetValue<int>() ?? 40);
                    }
                    Reply(request, new JsonObject { ["ok"] = true, ["foreground"] = ForegroundApp.Describe() });
                    break;
                case "pressKey":
                    Paster.Tap(request["vk"]?.GetValue<int>() ?? Native.VK_RETURN);
                    Reply(request, new JsonObject { ["ok"] = true });
                    break;
                default:
                    Reply(request, new JsonObject { ["ok"] = false, ["error"] = "unknown_request" });
                    break;
            }
        }
        catch (Exception e)
        {
            Reply(request, new JsonObject { ["ok"] = false, ["error"] = "exception", ["detail"] = e.Message });
        }
    }

    private static void Reply(JsonObject request, JsonObject response)
    {
        if (request["id"] is { } id) response["id"] = id.DeepClone();
        Ipc.Send(response);
    }

    private static List<Binding> ParseBindings(JsonObject request)
    {
        var bindings = new List<Binding>();
        if (request["bindings"] is not JsonArray array) return bindings;
        foreach (var node in array)
        {
            if (node is not JsonObject item || item["keys"] is not JsonArray keys || keys.Count == 0) continue;
            var id = item["id"]?.GetValue<string>();
            if (id is null) continue;
            var set = keys.Select(k => KeyboardHook.Normalize(k!.GetValue<int>())).ToHashSet();
            bindings.Add(new Binding(id, set, item["whileCapturing"]?.GetValue<bool>() ?? false));
        }
        return bindings;
    }
}
