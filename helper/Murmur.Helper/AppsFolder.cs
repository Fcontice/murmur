using System.Diagnostics;
using System.Runtime.InteropServices;
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
    private const long RefreshAfterMs = 15_000;
    private static HashSet<string> _known = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>When the last enumeration succeeded (Environment.TickCount64), or null before the first.</summary>
    private static long? _listedAt;

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

    /// <summary>Runs on the STA thread that created the shell objects, and releases them there.</summary>
    private static JsonArray Enumerate()
    {
        var shellType = Type.GetTypeFromProgID("Shell.Application") ?? throw new InvalidOperationException("Shell.Application is unavailable");
        object? shell = null, folder = null, items = null;
        try
        {
            shell = Activator.CreateInstance(shellType) ?? throw new InvalidOperationException("Shell.Application is unavailable");
            folder = ((dynamic)shell).NameSpace("shell:AppsFolder") ?? throw new InvalidOperationException("shell:AppsFolder is unavailable");
            items = ((dynamic)folder).Items();
            var apps = new JsonArray();
            // A fresh set per enumeration, swapped in whole, so concurrent lists never share a half-built set.
            var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object? item in (dynamic)items!)
            {
                try
                {
                    string name = ((dynamic)item).Name;
                    string id = ((dynamic)item).Path;
                    if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(id) || !known.Add(id)) continue;
                    apps.Add(new JsonObject { ["name"] = name, ["id"] = id });
                }
                finally
                {
                    if (item is not null && Marshal.IsComObject(item)) Marshal.ReleaseComObject(item);
                }
            }
            lock (Gate)
            {
                _known = known;
                _listedAt = Environment.TickCount64;
            }
            return apps;
        }
        finally
        {
            foreach (var com in new[] { items, folder, shell })
                if (com is not null && Marshal.IsComObject(com)) Marshal.FinalReleaseComObject(com);
        }
    }

    public static JsonObject Launch(string id)
    {
        // The id becomes an explorer.exe argument: refuse anything that could end or split it, listed or not.
        // Explorer also splits its command line on commas.
        if (id.Length == 0 || id.IndexOfAny(['"', ',', '\r', '\n', '\0']) >= 0)
            return new JsonObject { ["ok"] = false, ["error"] = "invalid_id" };

        bool listed, stale;
        lock (Gate)
        {
            listed = _known.Contains(id);
            stale = _listedAt is not { } at || Environment.TickCount64 - at > RefreshAfterMs;
        }
        // The list may be stale (an app installed since), but a burst of unknown ids must not re-enumerate each time.
        if (!listed && stale)
        {
            List();
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
