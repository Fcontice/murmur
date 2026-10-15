using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace GloopVoice.Helper;

/// <summary>
/// Newline-delimited JSON over stdin/stdout. Writes are queued so the keyboard hook never blocks on the pipe.
/// </summary>
internal static class Ipc
{
    private static readonly BlockingCollection<string> Outbox = new();
    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };

    public static void StartWriter()
    {
        var thread = new Thread(() =>
        {
            using var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            foreach (var line in Outbox.GetConsumingEnumerable())
            {
                try { stdout.WriteLine(line); }
                catch (IOException) { Environment.Exit(0); }
            }
        })
        { IsBackground = true, Name = "ipc-writer" };
        thread.Start();
    }

    public static void Send(JsonObject message) => Outbox.Add(message.ToJsonString(Compact));

    public static void Event(string name, JsonObject? fields = null)
    {
        var message = fields ?? new JsonObject();
        message["event"] = name;
        Send(message);
    }

    public static void Log(string level, string text) =>
        Event("log", new JsonObject { ["level"] = level, ["message"] = text });

    public static IEnumerable<JsonObject> ReadRequests()
    {
        using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        while (stdin.ReadLine() is { } line)
        {
            if (line.Length == 0) continue;
            JsonObject? parsed = null;
            try { parsed = JsonNode.Parse(line) as JsonObject; }
            catch (JsonException e) { Log("warn", $"Unparseable request: {e.Message}"); }
            if (parsed is not null) yield return parsed;
        }
    }
}
