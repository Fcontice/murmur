using System.Text.Json.Nodes;
using Interop.UIAutomationClient;

namespace Murmur.Helper;

/// <summary>
/// Runs a UI Automation read on its own MTA thread and abandons it at the budget, because providers can hang.
/// Abandoned threads are bounded twice over: UI Automation's own timeouts end their calls, and no more than
/// <see cref="MaxInFlight"/> reads may run at once, so a hung app cannot pile up threads.
/// </summary>
internal sealed class UiaWorker(string threadName, int budgetMs)
{
    public enum Outcome { Done, Busy, Timeout }

    private const int MaxInFlight = 2;
    private const uint ConnectionTimeoutMs = 1000;
    private const uint TransactionTimeoutMs = 1500;
    private int _inFlight;

    public Outcome Run(Func<CUIAutomation8, JsonObject> work, Func<Exception, JsonObject> onError, out JsonObject? result)
    {
        result = null;
        if (Interlocked.Increment(ref _inFlight) > MaxInFlight)
        {
            Interlocked.Decrement(ref _inFlight);
            return Outcome.Busy;
        }

        JsonObject? value = null;
        // Not disposed: an abandoned read still signals it when it finishes.
        var done = new ManualResetEventSlim();
        var thread = new Thread(() =>
        {
            try { value = work(CreateAutomation()); }
            catch (Exception e) { value = onError(e); }
            finally
            {
                Interlocked.Decrement(ref _inFlight);
                done.Set();
            }
        })
        { IsBackground = true, Name = threadName };
        thread.SetApartmentState(ApartmentState.MTA);
        try { thread.Start(); }
        catch
        {
            Interlocked.Decrement(ref _inFlight);
            throw;
        }
        if (!done.Wait(budgetMs)) return Outcome.Timeout;
        result = value;
        return Outcome.Done;
    }

    private static CUIAutomation8 CreateAutomation()
    {
        var automation = new CUIAutomation8();
        if (automation is IUIAutomation2 timed)
        {
            timed.ConnectionTimeout = ConnectionTimeoutMs;
            timed.TransactionTimeout = TransactionTimeoutMs;
        }
        return automation;
    }
}
