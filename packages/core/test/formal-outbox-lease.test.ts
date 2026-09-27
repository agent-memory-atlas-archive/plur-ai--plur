/**
 * Outbox lease (spec/formal/issues/outbox-lease.md; formal WritePath §1c,
 * decision D2): delivery is at-most-once ACROSS processes, not only within one.
 *
 * Before the lease, the in-flight claim (`_outboxInFlight`) was an in-memory
 * set: two processes flushing the same store (an MCP server and a CLI hook)
 * each selected the same queued row and each POSTed it, so the remote held the
 * engram twice. Theorem `guarded_at_most_once` held per process only.
 *
 * Two `Plur` instances on one directory stand in for two processes: they share
 * the store file and its lock, and nothing else — each has its own in-memory
 * claim set and its own lease holder id. The remote is the in-process HTTP stub
 * (real TCP, no fetch mocking) and counts every POST and DELETE. Interleavings
 * are forced by holding one POST open on the stub (`appendHook`) while the
 * other instance runs to completion. No real service is contacted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { PLUR_BOOKKEEPING_KEYS, userStructuredData } from '../src/content-fields.js'
import { StubServer } from './helpers/stub-server.js'
import { withAsyncLock, DEFAULT_ACQUIRE_TIMEOUT } from '../src/store/async-lock.js'
import { recordWriteOutcome } from '../src/remote-recall.js'
import {
  leaseFree, canStartPush, dropOwnLease, newLeaseHolder, OUTBOX_LEASE_TTL_MS, OUTBOX_LEASE_MARGIN_MS,
} from '../src/outbox-lease.js'

const TOKEN = 'lease-token'
const SCOPE = 'group:test'

async function waitFor(pred: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('outbox lease — two processes flushing one store', () => {
  let server: StubServer
  let url: string
  let dir: string

  beforeAll(async () => {
    server = new StubServer(TOKEN)
    ;({ url } = await server.start())
  })
  afterAll(async () => { await server.stop() })

  beforeEach(() => {
    server.appendHook = null
    server.appendErrorResponse = null
    server.appendCalls = 0
    server.deleteCalls = 0
    dir = mkdtempSync(join(tmpdir(), 'plur-outbox-lease-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const engramsFile = () => join(dir, 'engrams.yaml')
  const readRows = (): any[] => {
    if (!existsSync(engramsFile())) return []
    const doc = yaml.load(readFileSync(engramsFile(), 'utf8')) as { engrams?: any[] } | null
    return doc?.engrams ?? []
  }
  const rowOf = (id: string): any => readRows().find(e => e.id === id)
  /** Hand-edit one row, as another process (or an older client) would leave it. */
  const editRow = (id: string, f: (row: any) => void) => {
    const doc = yaml.load(readFileSync(engramsFile(), 'utf8')) as { engrams: any[] }
    const row = doc.engrams.find(e => e.id === id)
    f(row)
    writeFileSync(engramsFile(), yaml.dump(doc, { lineWidth: -1, noRefs: true }))
  }

  /** Hold the next POST on the wire until `release()`. */
  function holdNextAppend() {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let arrived = false
    server.appendHook = async () => {
      if (arrived) return
      arrived = true
      await gate
    }
    return { release, arrived: () => arrived }
  }

  /** Learn while the store rejects writes, so the engram sits queued (attempt_count 1). */
  async function queued(plur: Plur, statement: string) {
    server.appendErrorResponse = { status: 503, body: 'down' }
    const e = await plur.learn(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => !!rowOf(e.id)?.structured_data?._outbox?.last_error, 'the background push to record its failure')
    await new Promise(r => setTimeout(r, 30))
    server.appendErrorResponse = null
    server.appendCalls = 0
    return e
  }

  it('two processes flushing concurrently push a queued row at most once', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact two processes try to deliver')

    const hold = holdNextAppend()
    const flushingA = a.flushOutbox()
    await waitFor(hold.arrived, "A's POST to be on the wire")

    // B runs to completion while A's POST is held open.
    const rb = await b.flushOutbox()
    expect(rb.flushed, 'B pushed a row A holds a live lease on').toBe(0)

    hold.release()
    const ra = await flushingA
    expect(ra.flushed).toBe(1)
    expect(server.appendCalls, 'the remote received the same engram twice').toBe(1)
    expect(rowOf(e.id), 'the pushed row is handed off').toBeUndefined()
  })

  it("a flush in another process skips a row whose learn() push is in flight", async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const hold = holdNextAppend()
    const e = await a.learn('a team fact whose first push is slow', { scope: SCOPE, type: 'behavioral' })
    await waitFor(hold.arrived, "learn()'s background push to be on the wire")
    expect(rowOf(e.id)?.structured_data?._outboxLease?.holder, 'learn() queues the row under its own lease').toBeTruthy()

    const rb = await b.flushOutbox()
    expect(rb.flushed).toBe(0)
    expect(server.appendCalls, "B re-POSTed a row A's learn() is delivering").toBe(1)

    hold.release()
    await waitFor(() => rowOf(e.id) === undefined, 'the local copy to be handed off')
    expect(server.appendCalls).toBe(1)
  })

  it('an expired lease is taken over', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact whose holder vanished long ago')
    editRow(e.id, row => {
      row.structured_data._outboxLease = { holder: 'crashed-process', expires_at: new Date(Date.now() - 1000).toISOString() }
    })
    const rb = await b.flushOutbox()
    expect(rb.flushed).toBe(1)
    expect(server.appendCalls).toBe(1)
    expect(rowOf(e.id)).toBeUndefined()
  })

  it('a crashed holder does not block forever: its live lease is honoured, then taken over once it expires', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact whose holder crashed mid-flush')
    const expires = new Date(Date.now() + 400).toISOString()
    editRow(e.id, row => { row.structured_data._outboxLease = { holder: 'crashed-process', expires_at: expires } })

    const first = await b.flushOutbox()
    expect(first.flushed).toBe(0)
    expect(server.appendCalls, 'a live foreign lease was ignored').toBe(0)
    expect(rowOf(e.id)?.structured_data?._outboxLease, "another process's lease was overwritten")
      .toEqual({ holder: 'crashed-process', expires_at: expires })

    await new Promise(r => setTimeout(r, 450))
    const second = await b.flushOutbox()
    expect(second.flushed).toBe(1)
    expect(server.appendCalls).toBe(1)
    expect(rowOf(e.id)).toBeUndefined()
  })

  it('the lease is cleared on merge-back after a failed push, so the next flush anywhere may retry', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact whose flush fails')
    expect(rowOf(e.id)?.structured_data?._outboxLease, "learn()'s failure path clears its lease").toBeUndefined()

    server.appendErrorResponse = { status: 503, body: 'still down' }
    const ra = await a.flushOutbox()
    expect(ra.failed).toBe(1)
    const row = rowOf(e.id)
    expect(row.structured_data._outboxLease).toBeUndefined()
    expect(row.structured_data._outbox.attempt_count).toBe(2)

    server.appendErrorResponse = null
    server.appendCalls = 0
    const rb = await b.flushOutbox()
    expect(rb.flushed).toBe(1)
    expect(server.appendCalls).toBe(1)
  })

  it('retire-on-remote entries honour a live foreign lease and are retired once it expires', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact forgotten while its push was on the wire')
    const expires = new Date(Date.now() + 400).toISOString()
    editRow(e.id, row => {
      row.status = 'retired'
      delete row.structured_data._outbox
      row.structured_data._retireRemote = {
        target_url: url, target_scope: SCOPE, server_id: 'ENG-SRV-999',
        queued_at: new Date().toISOString(), last_attempt: '', attempt_count: 0, last_error: '',
      }
      row.structured_data._outboxLease = { holder: 'other-process', expires_at: expires }
    })

    const first = await b.flushOutbox()
    expect(server.deleteCalls, 'a retirement another process holds was sent again').toBe(0)
    expect(first.flushed).toBe(0)
    expect(rowOf(e.id)?.structured_data?._retireRemote?.server_id).toBe('ENG-SRV-999')

    await new Promise(r => setTimeout(r, 450))
    const second = await b.flushOutbox()
    expect(second.flushed).toBe(1)
    expect(server.deleteCalls).toBe(1)
    const after = rowOf(e.id)
    expect(after?.structured_data?._retireRemote).toBeUndefined()
    expect(after?.structured_data?._outboxLease).toBeUndefined()
  })

  it('the lease is bookkeeping, never content, and an update cannot forge one', async () => {
    expect(PLUR_BOOKKEEPING_KEYS.has('_outboxLease')).toBe(true)
    expect(userStructuredData({ _outboxLease: { holder: 'x', expires_at: '2099-01-01T00:00:00.000Z' } })).toBeUndefined()

    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact someone tries to park')
    const stored = (await a.getById(e.id))!
    await a.updateEngram({
      ...stored,
      structured_data: {
        ...((stored as any).structured_data ?? {}),
        // Audit of #1231: a forged lease inside TTL + margin — one that WOULD
        // block the flush if it were persisted. A 2099 lease is ignored by the
        // far-future clause anyway, so the assertion below passed vacuously.
        _outboxLease: { holder: 'forged', expires_at: new Date(Date.now() + 9 * 60_000).toISOString() },
      },
    } as any)
    expect(rowOf(e.id)?.structured_data?._outboxLease, 'a caller-set lease was persisted').toBeUndefined()
    const r = await new Plur({ path: dir }).flushOutbox()
    expect(r.flushed).toBe(1)
  })

  it('a row from an older client (no lease field) is unleased and delivered', async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact queued by an older client')
    editRow(e.id, row => { delete row.structured_data._outboxLease })
    const r = await new Plur({ path: dir }).flushOutbox()
    expect(r.flushed).toBe(1)
    expect(server.appendCalls).toBe(1)
  })

  // ---- Audit of #1231 -------------------------------------------------------

  /** Shift `Date.now()` for this process by `off()` ms (clocks of all "processes" agree). */
  function shiftClock() {
    const real = Date.now
    let off = 0
    Date.now = () => real() + off
    return { add: (ms: number) => { off += ms }, restore: () => { Date.now = real } }
  }
  /** Take the store lock in-process and keep it until `release()`. */
  async function holdStoreLock() {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let inside!: () => void
    const entered = new Promise<void>(r => { inside = r })
    const held = withAsyncLock(engramsFile(), async () => { inside(); await gate })
    await entered
    return { release: async () => { release(); await held } }
  }

  it('finding 1: a flush that waited for the store lock reads the lease clock after it, not before', async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact another process leased while A waited for the lock')
    const clock = shiftClock()
    try {
      const lock = await holdStoreLock()
      const flushingA = a.flushOutbox() // waits for the lock
      await new Promise(r => setTimeout(r, 50))
      // Six minutes pass (a long sync holds the lock); meanwhile another
      // process took the row with a fresh, LIVE lease.
      clock.add(6 * 60_000)
      editRow(e.id, row => {
        row.structured_data._outboxLease = { holder: 'process-b', expires_at: new Date(Date.now() + OUTBOX_LEASE_TTL_MS).toISOString() }
      })
      await lock.release()
      const ra = await flushingA
      expect(ra.flushed).toBe(0)
      expect(server.appendCalls, "A judged B's live lease from a clock read before the lock wait").toBe(0)
      expect(rowOf(e.id)?.structured_data?._outboxLease?.holder).toBe('process-b')
    } finally { clock.restore() }
  })

  it('finding 2: a merge-back that waits on the store lock still lands inside the lease (no redelivery)', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e1 = await queued(a, 'the first team fact of a slow batch')
    const e2 = await queued(a, 'the second team fact of a slow batch')
    const gates: Array<() => void> = []
    let arrivals = 0
    server.appendHook = async () => { arrivals++; await new Promise<void>(r => gates.push(r)) }
    const clock = shiftClock()
    try {
      const flushingA = a.flushOutbox()
      await waitFor(() => arrivals === 1, "A's first POST")
      // The batch ran long: the second push starts at the last moment the
      // margin allows.
      clock.add(OUTBOX_LEASE_TTL_MS - OUTBOX_LEASE_MARGIN_MS - 5_000)
      gates[0]()
      await waitFor(() => arrivals === 2, "A's second POST")
      // A long lock holder takes the store lock; B queues behind it, A's
      // merge-back queues behind B.
      const lock = await holdStoreLock()
      clock.add(30_000) // the POST takes its full request bound
      clock.add(DEFAULT_ACQUIRE_TIMEOUT) // the lock is held for the whole acquire bound
      const flushingB = b.flushOutbox()
      await new Promise(r => setTimeout(r, 20))
      server.appendHook = null // any later POST (a redelivery) answers at once
      gates[1]()
      await new Promise(r => setTimeout(r, 50))
      await lock.release()
      const rb = await flushingB
      const ra = await flushingA
      expect(ra.flushed).toBe(2)
      expect(rb.flushed, 'B took rows A had already delivered').toBe(0)
      expect(server.appendCalls, 'a statement was delivered twice').toBe(2)
      expect(rowOf(e1.id)).toBeUndefined()
      expect(rowOf(e2.id)).toBeUndefined()
    } finally { clock.restore(); for (const g of gates) g() }
  })

  it('finding 3: a flush that attempts nothing (breaker open) writes nothing and leases nothing', async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact queued for a host whose breaker is open')
    for (let i = 0; i < 10; i++) recordWriteOutcome(url, false, Date.now(), a.remoteHealthStatePath())
    const before = readFileSync(engramsFile(), 'utf8')
    let writes = 0
    const orig = (a as any)._writeEngrams.bind(a)
    ;(a as any)._writeEngrams = async (...args: any[]) => { writes++; return orig(...args) }
    const origUpd = (a as any)._updateEngrams.bind(a)
    ;(a as any)._updateEngrams = async (...args: any[]) => { writes++; return origUpd(...args) }
    const r = await a.flushOutbox()
    expect(r.flushed).toBe(0)
    expect(r.expired_warnings.some(w => w.includes('circuit breaker open'))).toBe(true)
    expect(writes, 'the store was rewritten for a flush that attempted nothing').toBe(0)
    expect(readFileSync(engramsFile(), 'utf8')).toBe(before)
    expect(rowOf(e.id)?.structured_data?._outbox).toBeTruthy()
    expect(server.appendCalls).toBe(0)
  })

  it('finding 4: a flush that throws after leasing releases its leases', async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact whose flush blows up mid-way')
    ;(a as any)._getRemoteDriver = () => { throw new Error('driver construction failed') }
    await expect(a.flushOutbox()).rejects.toThrow('driver construction failed')
    expect(rowOf(e.id)?.structured_data?._outboxLease, 'a lease outlived the flush that took it').toBeUndefined()
    expect(rowOf(e.id)?.structured_data?._outbox).toBeTruthy()
    const r = await new Plur({ path: dir }).flushOutbox()
    expect(r.flushed).toBe(1)
  })

  it("listOutbox reports leased_until for a row being pushed now, this instance's own push included", async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact listed while its push is on the wire')
    const hold = holdNextAppend()
    const flushing = a.flushOutbox()
    await waitFor(hold.arrived, 'the POST to be on the wire')
    const own = (await a.listOutbox()).find(x => x.id === e.id)
    const other = (await new Plur({ path: dir }).listOutbox()).find(x => x.id === e.id)
    expect(own?.leased_until).toBeTruthy()
    expect(other?.leased_until).toBe(own?.leased_until)
    hold.release()
    await flushing
  })
})

describe('outbox-lease helpers', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z')
  const sd = (holder: string, msFromNow: number) =>
    ({ _outboxLease: { holder, expires_at: new Date(now + msFromNow).toISOString() } })

  it('unleased, own, expired and malformed leases are free; a live foreign one is not', () => {
    expect(leaseFree(undefined, 'me', now)).toBe(true)
    expect(leaseFree({}, 'me', now)).toBe(true)
    expect(leaseFree(sd('me', 60_000), 'me', now)).toBe(true)
    expect(leaseFree(sd('other', 0), 'me', now)).toBe(true)
    expect(leaseFree({ _outboxLease: { holder: 'other', expires_at: 'not a date' } }, 'me', now)).toBe(true)
    expect(leaseFree(sd('other', 60_000), 'me', now)).toBe(false)
  })

  it('a lease further out than TTL + margin cannot block (one bad write does not park a row forever)', () => {
    expect(leaseFree(sd('other', OUTBOX_LEASE_TTL_MS + OUTBOX_LEASE_MARGIN_MS), 'me', now)).toBe(false)
    expect(leaseFree(sd('other', OUTBOX_LEASE_TTL_MS + OUTBOX_LEASE_MARGIN_MS + 1), 'me', now)).toBe(true)
  })

  it('the margin covers a request, the store-lock wait, the merge-back write and the skew (audit of #1231)', () => {
    expect(OUTBOX_LEASE_MARGIN_MS).toBeGreaterThanOrEqual(30_000 + DEFAULT_ACQUIRE_TIMEOUT + 60_000)
    expect(OUTBOX_LEASE_MARGIN_MS).toBeLessThan(OUTBOX_LEASE_TTL_MS)
  })

  it('a push starts only while the margin still fits in the lease', () => {
    const until = now + OUTBOX_LEASE_TTL_MS
    expect(canStartPush(until, now)).toBe(true)
    expect(canStartPush(until, until - OUTBOX_LEASE_MARGIN_MS)).toBe(true)
    expect(canStartPush(until, until - OUTBOX_LEASE_MARGIN_MS + 1)).toBe(false)
  })

  it('only the holder releases its lease; holder ids are unique per instance', () => {
    const a = { ...sd('a', 1000) } as Record<string, unknown>
    expect(dropOwnLease(a, 'b')).toBe(false)
    expect(a._outboxLease).toBeDefined()
    expect(dropOwnLease(a, 'a')).toBe(true)
    expect(a._outboxLease).toBeUndefined()
    expect(newLeaseHolder()).not.toBe(newLeaseHolder())
  })
})
