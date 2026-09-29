import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

/**
 * #1268 — cross-scope recurrence matched any active engram with the same
 * content hash in a DIFFERENT scope. A shared-scope learn whose text matched a
 * personal engram was absorbed into the personal one as a "recurrence" and
 * nothing was written to the shared scope, so the team never got it. Found
 * while triaging an enterprise deployment's report of team saves that never
 * reached the team store.
 *
 * A shared-scope write must never be absorbed into a non-shared engram.
 * Shared↔shared and personal→personal recurrence are unchanged.
 */
describe('cross-scope recurrence never absorbs a shared write into a personal engram (#1268)', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-recur-shared-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  for (const personal of ['global', 'local', 'user:alice', 'agent:helper']) {
    for (const shared of ['group:example/eng', 'project:example']) {
      it(`${shared} learn after a ${personal} engram creates a ${shared} engram`, async () => {
        const mine = await plur.learn('run migrations before deploys', { scope: personal })
        const team = await plur.learn('run migrations before deploys', { scope: shared })
        expect(team.id).not.toBe(mine.id)
        expect(team.scope).toBe(shared)
        // The personal engram is left as it was — not counted as a recurrence.
        const stored = (await plur.list()).find(e => e.id === mine.id)!
        expect(stored.scope).toBe(personal)
        expect((stored as any).recurrence_count ?? 0).toBe(0)
      })
    }
  }

  it('learnRouted (the plur_learn path) behaves the same', async () => {
    const mine = await plur.learnRouted('squash before merge', { scope: 'global' })
    const team = await plur.learnRouted('squash before merge', { scope: 'group:example/eng' })
    expect(team.id).not.toBe(mine.id)
    expect(team.scope).toBe('group:example/eng')
  })

  it('shared↔shared recurrence is unchanged', async () => {
    const a = await plur.learn('pin node versions', { scope: 'group:example/eng' })
    const b = await plur.learn('pin node versions', { scope: 'project:example' })
    expect(b.id).toBe(a.id)
    expect(b.recurrence_count).toBe(1)
  })

  it('a shared engram the ladder graduated to global still takes later shared hits', async () => {
    const a = await plur.learn('tag releases', { scope: 'project:a' })
    await plur.learn('tag releases', { scope: 'project:b' })
    const graduated = await plur.learn('tag releases', { scope: 'project:c' })
    expect(graduated.scope).toBe('global')
    const next = await plur.learn('tag releases', { scope: 'group:example/eng' })
    expect(next.id).toBe(a.id)
    expect(next.recurrence_count).toBe(3)
  })

  it('a graduated engram keeps taking shared hits after a reload (marker persists)', async () => {
    const a = await plur.learn('sign release tags', { scope: 'project:a' })
    await plur.learn('sign release tags', { scope: 'project:b' })
    await plur.learn('sign release tags', { scope: 'project:c' })
    const reloaded = new Plur({ path: dir })
    const stored = (await reloaded.list()).find(e => e.id === a.id)!
    expect(stored.scope).toBe('global')
    expect((stored as any).structured_data?._graduated_from?.scope).toBe('project:a')
    const next = await reloaded.learn('sign release tags', { scope: 'group:example/eng' })
    expect(next.id).toBe(a.id)
  })

  // Review finding on #1275: the carve-out inferred "graduated" from a shared
  // `sources[0]`, and `rescope` leaves `sources` untouched — so a user who
  // moved a project engram to their personal global scope got team writes
  // absorbed into it again.
  it('a shared-origin engram the USER rescoped to global does not absorb a shared write', async () => {
    const mine = await plur.learn('rotate deploy keys monthly', { scope: 'project:x' })
    const moved = await plur.rescope([mine.id], 'global')
    expect(moved.results[0].status).toBe('rescoped')
    const team = await plur.learn('rotate deploy keys monthly', { scope: 'group:acme/eng' })
    expect(team.id).not.toBe(mine.id)
    expect(team.scope).toBe('group:acme/eng')
    const stored = (await plur.list()).find(e => e.id === mine.id)!
    expect(stored.scope).toBe('global')
    expect((stored as any).recurrence_count ?? 0).toBe(0)
  })

  it('a rescope clears the graduation marker, even when the engram is moved back to global', async () => {
    const a = await plur.learn('freeze deps on release branches', { scope: 'project:a' })
    await plur.learn('freeze deps on release branches', { scope: 'project:b' })
    await plur.learn('freeze deps on release branches', { scope: 'project:c' })
    await plur.rescope([a.id], 'local')
    await plur.rescope([a.id], 'global')
    const stored = (await plur.list()).find(e => e.id === a.id)!
    expect(stored.scope).toBe('global')
    expect((stored as any).structured_data?._graduated_from).toBeUndefined()
    const team = await plur.learn('freeze deps on release branches', { scope: 'group:acme/eng' })
    expect(team.id).not.toBe(a.id)
    expect(team.scope).toBe('group:acme/eng')
  })

  it('personal→personal recurrence is unchanged', async () => {
    const a = await plur.learn('prefer tabs', { scope: 'local' })
    const b = await plur.learn('prefer tabs', { scope: 'user:alice' })
    expect(b.id).toBe(a.id)
    expect(b.recurrence_count).toBe(1)
  })

  it('a personal learn may still record a recurrence on a shared engram (unchanged)', async () => {
    const a = await plur.learn('lint before commit', { scope: 'group:example/eng' })
    const b = await plur.learn('lint before commit', { scope: 'global' })
    expect(b.id).toBe(a.id)
    expect(b.recurrence_count).toBe(1)
  })
})
