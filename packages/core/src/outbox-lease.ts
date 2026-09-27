/**
 * On-disk lease on outbox rows (formal WritePath §1c, decision D2).
 *
 * The in-memory in-flight claim (`Plur._outboxInFlight`) makes delivery
 * at-most-once within ONE process. Two processes flushing the same store (an
 * MCP server and a CLI hook) share neither that set nor anything else but the
 * store file, so both selected the same queued row and both POSTed it.
 *
 * The lease closes that. Before its network call, a pusher records
 * `structured_data._outboxLease = { holder, expires_at }` on each row it will
 * push or retire, under the store lock — so of two processes, the second to
 * take the lock sees the first one's lease. A row carrying a LIVE lease of
 * another holder is skipped; the lease is cleared when the pusher merges its
 * outcome back (success or failure); an EXPIRED lease may be taken over, so a
 * holder that crashed blocks its rows for at most one TTL.
 *
 * The guarantee is timed, as every lease is: a holder starts a push only while
 * at least `OUTBOX_LEASE_MARGIN_MS` of its lease remains, and that margin
 * covers one bounded request (30 s, `RemoteStore.fetchBounded`) plus the
 * merge-back. Two assumptions remain, both stated in the model: clocks of the
 * processes sharing a store agree to within the margin, and a holder that the
 * remote accepted a push from is not killed before its merge-back (a crash
 * THERE re-delivers after the TTL — the same at-least-once edge the
 * single-process path has always had and warns about).
 *
 * Format: additive. A row without the field is unleased; an older client
 * ignores the field (and so is not excluded by it — the protection holds
 * between clients that know the lease).
 */
import { randomUUID } from 'crypto'

/** How long a lease lives. Generous: it only bounds how long a crashed holder blocks its rows. */
export const OUTBOX_LEASE_TTL_MS = 10 * 60_000

/**
 * A holder starts a push or retire only while at least this much of its lease
 * remains: one bounded request (30 s) plus the merge-back, with room to spare.
 * Also the clock skew tolerated between processes sharing a store.
 */
export const OUTBOX_LEASE_MARGIN_MS = 2 * 60_000

/** The bookkeeping key the lease is stored under, in `structured_data`. */
export const OUTBOX_LEASE_KEY = '_outboxLease'

export interface OutboxLease {
  /** Opaque, unique per `Plur` instance. Carries no host name. */
  holder: string
  /** ISO timestamp. */
  expires_at: string
}

/** A fresh holder id for one `Plur` instance. */
export function newLeaseHolder(): string {
  return `${process.pid}-${randomUUID()}`
}

export function makeLease(holder: string, nowMs: number, ttlMs: number = OUTBOX_LEASE_TTL_MS): OutboxLease {
  return { holder, expires_at: new Date(nowMs + ttlMs).toISOString() }
}

/** The lease on a row's `structured_data`, or undefined when absent or malformed (= unleased). */
export function readLease(sd: unknown): OutboxLease | undefined {
  if (!sd || typeof sd !== 'object') return undefined
  const l = (sd as Record<string, unknown>)[OUTBOX_LEASE_KEY]
  if (!l || typeof l !== 'object') return undefined
  const { holder, expires_at } = l as Record<string, unknown>
  if (typeof holder !== 'string' || typeof expires_at !== 'string') return undefined
  return { holder, expires_at }
}

/**
 * May `holder` take (or keep) the row at `nowMs`? Yes when the row is
 * unleased, the lease is its own, or the lease has expired. A lease claiming
 * more than a TTL (plus the skew margin) into the future cannot have been
 * written by a live holder with a sane clock, so it does not block either —
 * otherwise one bad write would park the row forever.
 */
export function leaseFree(sd: unknown, holder: string, nowMs: number): boolean {
  const lease = readLease(sd)
  if (!lease || lease.holder === holder) return true
  const exp = Date.parse(lease.expires_at)
  if (!Number.isFinite(exp)) return true
  if (exp - nowMs > OUTBOX_LEASE_TTL_MS + OUTBOX_LEASE_MARGIN_MS) return true
  return exp <= nowMs
}

/** May a holder whose lease ends at `leaseUntilMs` START a push at `nowMs`? */
export function canStartPush(leaseUntilMs: number, nowMs: number): boolean {
  return nowMs + OUTBOX_LEASE_MARGIN_MS <= leaseUntilMs
}

/** Drop `holder`'s lease from a `structured_data` copy. Returns whether it was there. Mutates `sd`. */
export function dropOwnLease(sd: Record<string, unknown>, holder: string): boolean {
  if (readLease(sd)?.holder !== holder) return false
  delete sd[OUTBOX_LEASE_KEY]
  return true
}
