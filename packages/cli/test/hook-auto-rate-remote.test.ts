/**
 * #1318 review — the end-of-turn auto-rate hook against a remote store.
 *
 * 4. A remote engram injected this session is rated from a FRESH hook process
 *    (the remote cache is empty there), but only when the server advertises
 *    `feedback.source`; a server without it is never even asked for the engram.
 * 5. Each rated id is recorded as soon as it is rated, so a watchdog that
 *    kills the hook mid-way does not lose the verdicts already sent.
 *
 * The StubServer lives in THIS process, so the hook is spawned ASYNC (a
 * spawnSync would block the event loop and the stub could never answer).
 * HOME, PLUR_PATH and TMPDIR are temp dirs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn, spawnSync } from 'child_process'
import yaml from 'js-yaml'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { RemoteStore } from '../../core/src/store/remote-store.js'
import { namespaceEngramId } from '../../core/src/engrams.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'auto-rate-remote-token'
const SCOPE = 'group:test'
const REMOTE_STATEMENT = 'Team rule: tag every release candidate with the sprint number'
const LOCAL_STATEMENT = 'Local rule: keep the changelog entries in plain language'

let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

describe('hook-auto-rate × remote store (#1318 review)', () => {
  let root: string
  let project: string
  let env: NodeJS.ProcessEnv
  let remoteId: string

  beforeEach(async () => {
    server.reset()
    server.setMe({ capabilities: [] })
    root = mkdtempSync(join(tmpdir(), 'plur-auto-rate-remote-'))
    project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    mkdirSync(join(root, 'home'), { recursive: true })
    mkdirSync(join(root, 'tmp'), { recursive: true })
    mkdirSync(join(root, '.plur'), { recursive: true })
    writeFileSync(join(project, '.plur.yaml'), '# test project\n')
    writeFileSync(join(root, '.plur', 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(root, '.plur', 'config.yaml'), yaml.dump({
      embeddings: { enabled: false },
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, readonly: false }],
      index: false,
    }))
    env = {
      ...process.env,
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      PLUR_PATH: join(root, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
    delete env.PLUR_AUTO_RATE
    delete env.PLUR_AUTO_CAPTURE
    await new RemoteStore(baseUrl, TOKEN, SCOPE, { ttlMs: 0 })
      .append({ id: 'tmp', scope: SCOPE, status: 'active', statement: REMOTE_STATEMENT } as any)
    remoteId = namespaceEngramId('ENG-SRV-001', SCOPE)
    server.meCalls = 0
    server.getByIdCalls = 0
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    server.setMe({ capabilities: [] })
  })

  const rateDir = () => join(root, 'tmp', 'plur-auto-rate')
  function injected(sessionId: string, ids: string[]): void {
    mkdirSync(rateDir(), { recursive: true, mode: 0o700 })
    writeFileSync(join(rateDir(), `claude-${sessionId}.injected`), ids.join('\n') + '\n', { mode: 0o600 })
  }
  function rated(sessionId: string): string[] {
    const p = join(rateDir(), `claude-${sessionId}.rated`)
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
  }

  function stop(sessionId: string, reply: string, extraEnv: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'hook-auto-rate', 'claude'], { env: { ...env, ...extraEnv }, cwd: project })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hook-auto-rate did not exit')) }, 30_000)
      child.on('close', code => { clearTimeout(timer); resolve(code ?? 1) })
      child.on('error', err => { clearTimeout(timer); reject(err) })
      child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, cwd: project, last_assistant_message: reply }))
    })
  }

  it('rates a remote engram from a fresh process when the server has feedback.source', async () => {
    server.setMe({ capabilities: ['feedback.source'] })
    injected('r-1', [remoteId])
    expect(await stop('r-1', `Following the team note: ${REMOTE_STATEMENT}.`)).toBe(0)
    expect(server.feedbackBodies).toEqual([{ signal: 'positive', source: 'auto' }])
    expect(rated('r-1')).toContain(remoteId)
  })

  it('never fetches or rates a remote engram when the server lacks the capability', async () => {
    injected('r-2', [remoteId])
    expect(await stop('r-2', `Following the team note: ${REMOTE_STATEMENT}.`)).toBe(0)
    expect(server.feedbackBodies).toEqual([])
    expect(server.getByIdCalls).toBe(0)
  })

  it('records each rated id as it goes, so a watchdog cut keeps the verdicts already sent', async () => {
    server.setMe({ capabilities: ['feedback.source'] })
    server.feedbackDelayMs = 15_000 // the remote rating hangs past the watchdog
    const learn = spawnSync(process.execPath, [CLI, 'learn', LOCAL_STATEMENT, '--scope', 'global'], { env, cwd: project, encoding: 'utf8' })
    expect(learn.status, learn.stderr).toBe(0)
    const localId = (yaml.load(readFileSync(join(root, '.plur', 'engrams.yaml'), 'utf8')) as any).engrams
      .find((e: any) => e.statement === LOCAL_STATEMENT).id
    injected('r-3', [localId, remoteId])
    const reply = `Done. ${LOCAL_STATEMENT}. Also: ${REMOTE_STATEMENT}.`
    expect(await stop('r-3', reply, { PLUR_AUTO_RATE_CEILING_MS: '3000' })).toBe(0)
    // The local verdict was sent before the remote call hung; it must be on record.
    expect(rated('r-3')).toContain(localId)
    expect(rated('r-3')).not.toContain(remoteId)
  })
})
