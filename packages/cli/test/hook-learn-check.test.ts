import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('hook-learn-check', () => {
  let home: string
  let tmp: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-learn-check-home-'))
    tmp = join(home, 'tmp')
    mkdirSync(tmp, { recursive: true })
    // Mark the project as plur-configured so the hook doesn't silently no-op (#247).
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { plur: { command: '/bin/sh', args: [] } } }),
    )
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runHook(sessionId: string, cwd: string = home): { stdout: string; status: number } {
    const result = runCli('node', [CLI, 'hook-learn-check'], {
      input: JSON.stringify({ cwd }),
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, CLAUDE_SESSION_ID: sessionId },
      cwd: home,
    })
    return { stdout: result.stdout ?? '', status: result.status ?? 1 }
  }

  /**
   * Drive the hook the way Claude Code does (#1266): the session id arrives in
   * the stdin payload, CLAUDE_SESSION_ID is NOT set, and the hook is launched
   * through a shell — so process.ppid is a fresh `sh` pid on every Stop.
   */
  function runStop(payload: Record<string, unknown>): { stdout: string; status: number } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp }
    delete env.CLAUDE_SESSION_ID
    const result = runCli('/bin/sh', ['-c', `"${process.execPath}" "${CLI}" hook-learn-check`], {
      input: JSON.stringify({ cwd: home, hook_event_name: 'Stop', ...payload }),
      encoding: 'utf-8',
      timeout: 10000,
      env,
      cwd: home,
    })
    return { stdout: result.stdout ?? '', status: result.status ?? 1 }
  }

  /** The Stop-event delivery shape Claude Code actually hands to the model. */
  function nudgeText(stdout: string): string | undefined {
    try {
      const out = JSON.parse(stdout)
      if (out?.hookSpecificOutput?.hookEventName !== 'Stop') return undefined
      const ctx = out.hookSpecificOutput.additionalContext
      return typeof ctx === 'string' ? ctx : undefined
    } catch {
      return undefined
    }
  }

  it('prints nothing when plur is not configured', () => {
    const bareHome = mkdtempSync(join(tmpdir(), 'plur-learn-check-bare-'))
    const bareTmp = join(bareHome, 'tmp')
    mkdirSync(bareTmp, { recursive: true })
    try {
      const result = runCli('node', [CLI, 'hook-learn-check'], {
        input: JSON.stringify({ cwd: bareHome }),
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, HOME: bareHome, USERPROFILE: bareHome, TMPDIR: bareTmp, CLAUDE_SESSION_ID: 'unconfigured' },
        cwd: bareHome,
      })
      // #1266: a Stop hook's stdout is parsed as hook OUTPUT — echoing the
      // input payload back was at best ignored. Say nothing.
      expect(result.stdout).toBe('')
    } finally {
      rmSync(bareHome, { recursive: true, force: true })
    }
  })

  it('stays silent on the 1st and 2nd stop, nudges on the 3rd (LEARN_INTERVAL)', () => {
    const id = 'learn-interval-test'
    expect(runHook(id).stdout).toBe('')
    expect(runHook(id).stdout).toBe('')
    const third = runHook(id)
    expect(nudgeText(third.stdout)).toContain('plur_learn')
  })

  // #1266: Claude Code ignores a Stop hook's TOP-LEVEL additionalContext
  // (recorded as plain hook stdout, never shown to the model). Only the
  // hookSpecificOutput form is delivered — verified in a real session.
  it('delivers the nudge as hookSpecificOutput for the Stop event, not top-level', () => {
    const id = 'shape-test'
    runHook(id)
    runHook(id)
    const out = JSON.parse(runHook(id).stdout)
    expect(out).not.toHaveProperty('additionalContext')
    expect(out.hookSpecificOutput.hookEventName).toBe('Stop')
    expect(out.hookSpecificOutput.additionalContext).toContain('plur_learn')
  })

  // #1266: the delivered form forces ONE continuation turn. That turn ends in
  // another Stop with stop_hook_active: true — nudging there would loop.
  it('never nudges when stop_hook_active is true', () => {
    const session_id = '5e0c1f7a-0000-4000-8000-000000000001'
    runStop({ session_id })
    runStop({ session_id })
    // The 3rd Stop is a continuation Stop: must stay silent.
    expect(runStop({ session_id, stop_hook_active: true }).stdout).toBe('')
    // ...and it does not consume the interval — the next real Stop nudges.
    expect(nudgeText(runStop({ session_id }).stdout)).toContain('plur_learn')
    // The continuation that nudge forces must not nudge again.
    expect(runStop({ session_id, stop_hook_active: true }).stdout).toBe('')
  })

  // #1266: Claude Code puts the session id in the payload and does not export
  // CLAUDE_SESSION_ID to hooks. Keyed on ppid, each Stop (a fresh shell) got a
  // fresh counter and the every-3rd nudge could never fire.
  it('keys the counter on the payload session_id, across different ppids', () => {
    const session_id = '5e0c1f7a-0000-4000-8000-000000000002'
    expect(runStop({ session_id }).stdout).toBe('')
    expect(runStop({ session_id }).stdout).toBe('')
    expect(nudgeText(runStop({ session_id }).stdout)).toContain('plur_learn')
    // A different session keeps its own count.
    expect(runStop({ session_id: '5e0c1f7a-0000-4000-8000-000000000003' }).stdout).toBe('')
  })

  it('writes the checkpoint under the payload session_id', () => {
    const session_id = '5e0c1f7a-0000-4000-8000-000000000004'
    for (let i = 0; i < 10; i++) runStop({ session_id })
    const checkpointPath = join(home, '.plur', 'sessions', `${session_id}.checkpoint.json`)
    expect(existsSync(checkpointPath)).toBe(true)
    expect(JSON.parse(readFileSync(checkpointPath, 'utf-8')).session_id).toBe(session_id)
  })

  it('sanitises a hostile payload session_id before using it as a path', () => {
    const session_id = '../../escape'
    for (let i = 0; i < 10; i++) runStop({ session_id })
    expect(existsSync(join(home, '.plur', 'escape.checkpoint.json'))).toBe(false)
    expect(existsSync(join(home, '.plur', 'sessions', '______escape.checkpoint.json'))).toBe(true)
  })

  it('writes a session checkpoint on the 10th stop (CHECKPOINT_INTERVAL)', () => {
    const id = 'checkpoint-test'
    for (let i = 0; i < 9; i++) runHook(id)
    const checkpointPath = join(home, '.plur', 'sessions', `${id}.checkpoint.json`)
    expect(existsSync(checkpointPath)).toBe(false)

    runHook(id) // 10th call
    expect(existsSync(checkpointPath)).toBe(true)
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'))
    expect(checkpoint.stop_count).toBe(10)
    expect(checkpoint.session_id).toBe(id)
  })

  // Audit fix, 2026-07-09 (cross-referenced from feat/cursor-integration's
  // evaluator review): the counter used to be read-int/increment/write,
  // which can lose an increment if two Stop hook processes fire close
  // together (each invocation is a fresh, independent process). This
  // doesn't reproduce true concurrency (that would be flaky-by-nature to
  // assert on), but locks in that N sequential calls advance the counter
  // by exactly N — the invariant the atomic-append fix must preserve.
  it('advances the counter by exactly one per sequential call', () => {
    const id = 'sequential-count-test'
    // 3rd, 6th, 9th, 12th stops nudge; count is otherwise only observable
    // indirectly, so drive it to the 30th stop and confirm a checkpoint
    // (10th) and nudges land on the expected boundaries, not off-by-one.
    const results: string[] = []
    for (let i = 1; i <= 12; i++) {
      const { stdout } = runHook(id)
      results.push(stdout)
    }
    const nudged = results.map((r) => {
      return nudgeText(r) !== undefined
    })
    expect(nudged).toEqual([
      false, false, true, // 1,2,3
      false, false, true, // 4,5,6
      false, false, true, // 7,8,9
      false, false, true, // 10,11,12
    ])
  })

  // MISSING (fail-open contract, PROVEN): a Stop hook MUST never throw — it is on
  // the hot path of every response. But counterPath()'s mkdir/appendFileSync of
  // $TMPDIR/plur-sessions is not wrapped in try/catch, so an unwritable $TMPDIR
  // makes the hook EXIT 1 and print {"error":...} to stdout (index.ts's top-level
  // catch). Correct behaviour: exit 0 and emit valid/empty output. it.fails until
  // the counter I/O is made fail-open; flip to it() when green.
  it('never crashes the response when the state dir is unwritable', () => {
    const roTmp = mkdtempSync(join(tmpdir(), 'plur-ro-learn-'))
    chmodSync(roTmp, 0o500) // r-x: owner cannot create plur-sessions inside
    try {
      const result = runCli('node', [CLI, 'hook-learn-check'], {
        input: JSON.stringify({ cwd: home }),
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: roTmp, CLAUDE_SESSION_ID: 'ro-learn' },
        cwd: home,
      })
      expect(result.status ?? 1).toBe(0) // fail-open: never a non-zero exit
      expect(result.stdout ?? '').not.toContain('"error"')
    } finally {
      chmodSync(roTmp, 0o700)
      rmSync(roTmp, { recursive: true, force: true })
    }
  })
})
