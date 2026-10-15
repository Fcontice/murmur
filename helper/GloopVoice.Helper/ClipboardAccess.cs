using System.Runtime.InteropServices;
using static GloopVoice.Helper.Native;

namespace GloopVoice.Helper;

internal sealed record ClipboardSnapshot(List<(uint Format, byte[] Data)> Items);

internal static class ClipboardAccess
{
    private const long MaxSnapshotBytes = 64L * 1024 * 1024;

    // Marking the clipboard entry this way keeps dictated text out of Win+V history and cloud sync.
    private static readonly uint ExcludeFromMonitors = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");
    private static readonly uint CanIncludeInHistory = RegisterClipboardFormat("CanIncludeInClipboardHistory");
    private static readonly uint CanUploadToCloud = RegisterClipboardFormat("CanUploadToCloudClipboard");

    public static bool Open()
    {
        for (var attempt = 0; attempt < 10; attempt++)
        {
            if (OpenClipboard(IntPtr.Zero)) return true;
            Thread.Sleep(15);
        }
        return false;
    }

    /// <summary>Formats backed by GDI handles or owner callbacks cannot be copied as memory blocks.</summary>
    private static bool IsCopyable(uint format) => format switch
    {
        2 or 3 or 9 or 14 => false,           // CF_BITMAP, CF_METAFILEPICT, CF_PALETTE, CF_ENHMETAFILE
        >= 0x80 and <= 0x8E => false,         // owner display and CF_DSP*
        >= 0x0200 and <= 0x03FF => false,     // private and GDI object ranges
        _ => true,
    };

    public static ClipboardSnapshot? Snapshot()
    {
        if (!Open()) return null;
        try
        {
            var items = new List<(uint, byte[])>();
            long total = 0;
            uint format = 0;
            while ((format = EnumClipboardFormats(format)) != 0)
            {
                if (!IsCopyable(format)) continue;
                var handle = GetClipboardData(format);
                if (handle == IntPtr.Zero) continue;
                var size = (long)GlobalSize(handle).ToUInt64();
                if (size <= 0) continue;
                total += size;
                if (total > MaxSnapshotBytes) return null;
                var pointer = GlobalLock(handle);
                if (pointer == IntPtr.Zero) continue;
                try
                {
                    var bytes = new byte[size];
                    Marshal.Copy(pointer, bytes, 0, (int)size);
                    items.Add((format, bytes));
                }
                finally { GlobalUnlock(handle); }
            }
            return new ClipboardSnapshot(items);
        }
        finally { CloseClipboard(); }
    }

    public static bool Restore(ClipboardSnapshot snapshot)
    {
        if (!Open()) return false;
        try
        {
            EmptyClipboard();
            foreach (var (format, data) in snapshot.Items) SetBytes(format, data);
            return true;
        }
        finally { CloseClipboard(); }
    }

    /// <summary>Writes text and returns the clipboard sequence number afterwards, or 0 on failure.</summary>
    public static uint WriteText(string text)
    {
        if (!Open()) return 0;
        try
        {
            EmptyClipboard();
            var bytes = new byte[(text.Length + 1) * 2];
            System.Text.Encoding.Unicode.GetBytes(text, 0, text.Length, bytes, 0);
            if (!SetBytes(CF_UNICODETEXT, bytes)) return 0;
            SetBytes(ExcludeFromMonitors, new byte[4]);
            SetBytes(CanIncludeInHistory, new byte[4]);
            SetBytes(CanUploadToCloud, new byte[4]);
        }
        finally { CloseClipboard(); }
        return GetClipboardSequenceNumber();
    }

    public static string? ReadText()
    {
        if (!Open()) return null;
        try
        {
            var handle = GetClipboardData(CF_UNICODETEXT);
            if (handle == IntPtr.Zero) return null;
            var pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero) return null;
            try { return Marshal.PtrToStringUni(pointer); }
            finally { GlobalUnlock(handle); }
        }
        finally { CloseClipboard(); }
    }

    private static bool SetBytes(uint format, byte[] data)
    {
        var handle = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)data.Length);
        if (handle == IntPtr.Zero) return false;
        var pointer = GlobalLock(handle);
        if (pointer == IntPtr.Zero)
        {
            GlobalFree(handle);
            return false;
        }
        Marshal.Copy(data, 0, pointer, data.Length);
        GlobalUnlock(handle);
        if (SetClipboardData(format, handle) != IntPtr.Zero) return true;
        GlobalFree(handle); // ownership only transfers on success
        return false;
    }
}
