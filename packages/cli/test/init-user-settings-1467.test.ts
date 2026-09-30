/**
 * #1467: `plur init` puts the prompt hooks and the MCP entry in user settings
 * (~/.claude/settings.json) by default, from any folder. Before, a run inside
 * a repo wrote them to <repo>/.claude/settings.json, so every other folder
 * never got the folder question and never got memory. Now that the folder map
 * gates every hook, a user-level hook is safe everywhere.
 *
 *   - default and --global: user settings; --project: the old placement;
 *   - re-running init in a repo that holds PLUR's prompt hooks moves them to
 *     user settings, removes only PLUR's hooks from the repo file, keeps its
 *     MCP entry, and records the repo as `on` in folders.yaml, so the repo
 *     keeps working and no hook runs twice;
 *   - a second run changes nothing; a folder the map has `off` stays off.
 *
 * Real spawned CLI, with HOME, USERPROFILE, TMPDIR and PLUR_PATH inside a
 * temp directory, so the real ~/.plur and ~/.claude are never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

interface Hook { command: string; timeout?: number }
interface Entry { matcher?: string; hooks: Hook[] }
interface Settings { hooks?: Record<string, Entry[]>; mcpServers?: Record<string, unknown>; [k: string]: unknown }

let home: string
let repo: string
let env: NodeJS.ProcessEnv

const userFile = () => join(home, '.claude', 'settings.json')
const repoFile = () => join(repo, '.claude', 'settings.json')
const mapFile = () => join(home, '.plur', 'folders.yaml')
const read = (p: string): Settings => JSON.parse(readFileSync(p, 'utf8'))
const raw = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '<absent>')

function init(...args: string[]): string {
  const r = runCli('node', [CLI, 'init', '--no-desktop', '--no-prompt', '--no-codex', '--no-cursor', '--no-antigravity', ...args], {
    encoding: 'utf-8', env, cwd: repo, input: '',
  })
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r.stdout ?? ''
}

/** Every PLUR hook command in a settings file, per event. */
function plurCommands(s: Settings): string[] {
  const out: string[] = []
  for (const [event, entries] of Object.entries(s.hooks ?? {})) {
    for (const e of entries) for (const h of e.hooks) {
      if (h.command.includes('.plur/bin/plur-hook') || h.command.includes('@plur-ai/cli')) out.push(`${event}:${e.matcher ?? ''}:${h.command}`)
    }
  }
  return out.sort()
}

const hasPrompt = (s: Settings) => plurCommands(s).some(c => c.startsWith('UserPromptSubmit::') && c.endsWith(' hook-inject'))
const hasRehydrate = (s: Settings) => plurCommands(s).some(c => c.startsWith('SessionStart:compact:') && c.endsWith('hook-inject --rehydrate'))

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-init-1467-')))
  mkdirSync(join(home, 'tmp'))
  repo = join(home, 'code', 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: join(home, 'tmp'), PLUR_PATH: join(home, '.plur') }
  delete env.CLAUDE_SESSION_ID
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('plur init writes the prompt hooks and the MCP entry to user settings (#1467)', () => {
  for (const withDotClaude of [false, true]) {
    it(`default, run inside a repo${withDotClaude ? ' that has a .claude/ folder' : ''}: user settings, nothing in the repo`, () => {
      if (withDotClaude) mkdirSync(join(repo, '.claude'))
      init()
      const user = read(userFile())
      expect(hasPrompt(user)).toBe(true)
      expect(hasRehydrate(user)).toBe(true)
      expect(user.mcpServers?.plur).toBeDefined()
      expect(existsSync(repoFile())).toBe(false)
    })
  }

  it('--global does the same as the new default', () => {
    init('--global')
    const viaGlobal = plurCommands(read(userFile()))
    rmSync(join(home, '.claude'), { recursive: true, force: true })
    init()
    expect(plurCommands(read(userFile()))).toEqual(viaGlobal)
    expect(read(userFile()).mcpServers?.plur).toBeDefined()
    expect(existsSync(repoFile())).toBe(false)
  })

  it('--project keeps the old placement: prompt hooks and MCP in the repo, enforcement in user settings', () => {
    init('--project')
    const project = read(repoFile())
    expect(hasPrompt(project)).toBe(true)
    expect(project.mcpServers?.plur).toBeDefined()
    const user = read(userFile())
    expect(hasPrompt(user)).toBe(false)
    expect(plurCommands(user).some(c => c.endsWith(' hook-session-end'))).toBe(true)
  })

  it('run from $HOME spelled through a symlink: user settings are not mistaken for a repo file', () => {
    // On macOS tmpdir() is /var/..., a symlink to /private/var/...; cwd comes
    // back resolved while HOME keeps the link. Twice, so the second run sees
    // PLUR hooks in "<cwd>/.claude/settings.json".
    const linked = mkdtempSync(join(tmpdir(), 'plur-init-1467-home-'))
    try {
      const e = { ...env, HOME: linked, USERPROFILE: linked, PLUR_PATH: join(linked, '.plur') }
      for (let i = 0; i < 2; i++) {
        const r = runCli('node', [CLI, 'init', '--no-desktop', '--no-prompt', '--no-codex', '--no-cursor', '--no-antigravity'], {
          encoding: 'utf-8', env: e, cwd: linked, input: '',
        })
        expect(r.status, r.stderr).toBe(0)
      }
      expect(hasPrompt(read(join(linked, '.claude', 'settings.json')))).toBe(true)
      expect(existsSync(join(linked, '.plur', 'folders.yaml'))).toBe(false)
    } finally {
      rmSync(linked, { recursive: true, force: true })
    }
  })

  it('leaves a user hook in user settings alone', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const mine = { matcher: '*', hooks: [{ type: 'command', command: 'say done' }] }
    writeFileSync(userFile(), JSON.stringify({ theme: 'dark', hooks: { Stop: [mine] } }, null, 2))
    init()
    const user = read(userFile())
    expect(user.theme).toBe('dark')
    expect(user.hooks!.Stop[0]).toEqual(mine)
  })
})

describe('re-running plur init in a repo that holds PLUR prompt hooks (#1467 migration)', () => {
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine >> /tmp/mine.log' }] }

  /** What an older `plur init` left in a repo, plus the user's own settings in the same file. */
  function olderInstall(): void {
    init('--project')
    const s = read(repoFile())
    s.permissions = { allow: ['Bash(ls:*)'] }
    s.hooks!.PreToolUse = [mine, ...s.hooks!.PreToolUse]
    writeFileSync(repoFile(), JSON.stringify(s, null, 2) + '\n')
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:repo-hint\n')
  }

  it('moves the hooks to user settings, removes only PLUR\'s hooks from the repo, keeps its MCP entry, records the repo as on', () => {
    olderInstall()
    const before = read(repoFile())
    const plurYaml = raw(join(repo, '.plur.yaml'))
    init()

    const project = read(repoFile())
    expect(plurCommands(project)).toEqual([])
    expect(project.hooks?.PreToolUse).toEqual([mine])
    expect(project.permissions).toEqual(before.permissions)
    expect(project.mcpServers).toEqual(before.mcpServers)
    const { hooks: _h, ...restAfter } = project
    const { hooks: _b, ...restBefore } = before
    expect(restAfter).toEqual(restBefore)

    const user = read(userFile())
    expect(hasPrompt(user)).toBe(true)
    expect(hasRehydrate(user)).toBe(true)
    // no hook runs twice: each PLUR command is registered once, in one file
    const cmds = plurCommands(user)
    expect(new Set(cmds).size).toBe(cmds.length)

    const map = raw(mapFile())
    expect(map).toContain(`path: ${repo}`)
    expect(map).toMatch(/plur: '?on'?\n/)
    expect(map).not.toContain('repo-hint') // the .plur.yaml stays the hint; no scope copied
    expect(raw(join(repo, '.plur.yaml'))).toBe(plurYaml)

    // The repo keeps working: its first prompt injects instead of asking. A
    // folder nobody registered is asked, once.
    const hook = (cwd: string, sid: string) => {
      const r = runCli('node', [CLI, 'hook-inject'], {
        encoding: 'utf-8', env: { ...env, PLUR_HOOK_HYBRID: 'off' }, cwd,
        input: JSON.stringify({ session_id: sid, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'how do we deploy' }),
      })
      const out = r.stdout ?? ''
      return out ? String(JSON.parse(out).hookSpecificOutput?.additionalContext ?? '') : ''
    }
    expect(hook(repo, 'repo-1467')).toContain('session started')
    const other = join(home, 'elsewhere')
    mkdirSync(other)
    expect(hook(other, 'other-1467')).toContain('no decision for this folder yet')
    expect(hook(other, 'other-1467')).toBe('')
  })

  it('a second plur init changes nothing and duplicates no hook', () => {
    olderInstall()
    init()
    // the first run migrated: prompt hooks only in user settings
    expect(hasPrompt(read(repoFile()))).toBe(false)
    expect(hasPrompt(read(userFile()))).toBe(true)
    const snap = [raw(userFile()), raw(repoFile()), raw(mapFile())]
    init()
    expect([raw(userFile()), raw(repoFile()), raw(mapFile())]).toEqual(snap)
    const cmds = plurCommands(read(userFile()))
    expect(new Set(cmds).size).toBe(cmds.length)
  })

  it('a repo the map has off stays off', () => {
    olderInstall()
    mkdirSync(join(home, '.plur'), { recursive: true })
    writeFileSync(mapFile(), `version: 1\nfolders:\n  - path: ${repo}\n    plur: off\n`)
    const map = raw(mapFile())
    init()
    expect(raw(mapFile())).toBe(map)
    // the hooks still moved; the map's off silences them everywhere
    expect(hasPrompt(read(repoFile()))).toBe(false)
    expect(hasPrompt(read(userFile()))).toBe(true)
    const policy = runCli('node', [CLI, 'hook-inject'], {
      encoding: 'utf-8', env, cwd: repo,
      input: JSON.stringify({ session_id: 'off-1467', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
    })
    expect(policy.stdout ?? '').toBe('')
  })

  it('a repo with no PLUR hooks is left alone and gets no map entry', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(repoFile(), JSON.stringify({ permissions: { allow: [] } }, null, 2) + '\n')
    const before = raw(repoFile())
    init()
    expect(raw(repoFile())).toBe(before)
    expect(raw(mapFile())).not.toContain(repo)
  })
})
