import type { InstalledApp } from '@shared/types'

const MAX_AGE_MS = 5 * 60_000
/** After a failed read, how long to wait before asking the helper again. */
const RETRY_MS = 30_000

/**
 * The installed-apps list, read from the helper at most every few minutes; reading it takes about half a second.
 * Only the very first load waits for the helper. After that a stale list is served at once and refreshed behind it.
 */
export class AppCatalog {
  private cached: InstalledApp[] | null = null
  private fetchedAt = -Infinity
  private retryAt = -Infinity
  private pending: Promise<InstalledApp[]> | null = null

  constructor(
    private readonly listApps: () => Promise<InstalledApp[] | null>,
    private readonly now: () => number = Date.now,
  ) {}

  apps(): Promise<InstalledApp[]> {
    const now = this.now()
    const stale = now - this.fetchedAt > MAX_AGE_MS
    if (stale && now >= this.retryAt) this.refresh()
    if (this.cached) return Promise.resolve(this.cached)
    return this.pending ?? Promise.resolve([])
  }

  /** Starts a read in the background so the first command does not wait for it. */
  warm(): void {
    void this.apps()
  }

  private refresh(): void {
    this.pending ??= this.listApps()
      .catch(() => null)
      .then((apps) => {
        // A failed read keeps the last good list rather than forgetting every app.
        if (apps) {
          this.cached = apps
          this.fetchedAt = this.now()
        } else {
          this.retryAt = this.now() + RETRY_MS
        }
        return this.cached ?? []
      })
      .finally(() => {
        this.pending = null
      })
  }
}
