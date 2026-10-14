using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Murmur.Helper;

/// <summary>
/// The Windows "Apps" folder: what the Start menu lists, desktop and Store apps alike. Apps are launched
/// by their parsing name under shell:AppsFolder, and only names this folder listed, so a spoken phrase can
/// never become a command line.
/// </summary>
internal static class AppsFolder
{
    private const int ListTimeoutMs = 8000;
    private static readonly object Gate = new();
    private static HashSet<string> _known = new(StringComparer.OrdinalIgnoreCase);

    public static JsonObject List()
    {
        JsonArray? apps = null;
        Exception? failure = null;
        // Shell folders expect a single-threaded apartment.
        var thread = new Thread(() =>
        {
            try { apps = Enumerate(); }
            catch (Exception e) { failure = e; }
        })
        { IsBackground = true, Name = "apps-folder" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!thread.Join(ListTimeoutMs)) return new JsonObject { ["ok"] = false, ["error"] = "timeout" };
        if (apps is null) return new JsonObject { ["ok"] = false, ["error"] = "exception", ["detail"] = failure?.Message };
        return new JsonObject { ["ok"] = true, ["apps"] = apps };
    }

    private static JsonArray Enumerate()
    {
        var shellType = Type.GetTypeFromProgID("Shell.Application") ?? throw new InvalidOperationException("Shell.Application is unavailable");
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic folder = shell.NameSpace("shell:AppsFolder");
        var apps = new JsonArray();
        // A fresh set per enumeration, swapped in whole, so concurrent lists never share a half-built set.
        var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (dynamic item in folder.Items())
        {
            string name = item.Name;
            string id = item.Path;
            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(id) || !known.Add(id)) continue;
            apps.Add(new JsonObject { ["name"] = name, ["id"] = id });
        }
        lock (Gate) _known = known;
        return apps;
    }

    public static JsonObject Launch(string id)
    {
        // The id becomes an explorer.exe argument: refuse anything that could end or split it, listed or not.
        if (id.Length == 0 || id.IndexOfAny(['"', '\r', '\n', '\0']) >= 0)
            return new JsonObject { ["ok"] = false, ["error"] = "invalid_id" };

        bool listed;
        lock (Gate) listed = _known.Contains(id);
        if (!listed)
        {
            List(); // the list may be stale: an app installed since the last refresh
            lock (Gate) listed = _known.Contains(id);
        }
        if (!listed) return new JsonObject { ["ok"] = false, ["error"] = "unknown_app" };
        try
        {
            var explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            var start = new ProcessStartInfo(explorer) { UseShellExecute = false };
            start.ArgumentList.Add($"shell:AppsFolder\\{id}");
            // explorer.exe hands the launch to the running shell and exits at once, so ok means "handed off",
            // not that the app has started.
            using var process = Process.Start(start);
            return new JsonObject { ["ok"] = process is not null };
        }
        catch (Exception e)
        {
            return new JsonObject { ["ok"] = false, ["error"] = "launch_failed", ["detail"] = e.Message };
        }
    }
}
