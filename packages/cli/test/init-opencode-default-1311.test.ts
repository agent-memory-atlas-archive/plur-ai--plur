/**
 * #1311 — `plur init` sets up opencode by default.
 *
 * `@plur-ai/opencode` is published, so the opt-in gate that guarded against
 * writing a dead plugin name is gone: whenever opencode's config dir exists
 * (`~/.config/opencode`, the same detection `opencode-config.ts` uses), init
 * writes the plugin entry and the MCP entry with no flag. `--opencode` still
 * forces it (and creates the dir), `--no-opencode` skips it.
 *
 * On win32 the MCP entry is built by the same builder PR #1270 added for
 * every other host, so it is `[<node.exe>, <@plur-ai/mcp js entry>]`, never a
 * bare `npx` (which a shell-less spawn cannot resolve to `npx.cmd`).
 *
 * The built CLI is spawned under a throwaway HOME, so neither the real
 * `~/.plur` nor the real opencode config is ever touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

describe('plur init sets up opencode by default (#1311)', { timeout: 60000 }, () => {
  let home: string

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-oc-1311-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const ocDir = () => join(home, '.config', 'opencode')
  const ocJson = () => join(ocDir(), 'opencode.json')
  const readOc = () => JSON.parse(readFileSync(ocJson(), 'utf-8'))

  function runInit(extra: string[] = [], win32 = false): string {
    const nodeArgs = win32 ? ['--import', WIN32_PRELOAD] : []
    return execFileSync(process.execPath, [...nodeArgs, CLI, 'init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-cursor', ...extra], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PLUR_PATH: join(home, '.plur'),
        XDG_CONFIG_HOME: join(home, '.config'),
        OPENCODE_CONFIG_DIR: ocDir(),
      },
      cwd: home,
    })
  }

  it('writes the plugin and MCP entry with no flag when the opencode config dir exists', () => {
    mkdirSync(ocDir(), { recursive: true })
    const out = runInit()
    const cfg = readOc()
    expect(cfg.plugin).toEqual(['@plur-ai/opencode'])
    expect(cfg.mcp.plur.type).toBe('local')
    expect(cfg.mcp.plur.enabled).toBe(true)
    expect(out).toContain('Opencode: config created')
    expect(out).not.toContain('not yet published')
  })

  it('leaves opencode alone when its config dir does not exist', () => {
    const out = runInit()
    expect(existsSync(ocDir())).toBe(false)
    expect(out).toContain('Opencode: skipped')
    expect(out).not.toContain('not yet published')
  })

  it('--no-opencode skips it even when the config dir exists', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit(['--no-opencode'])
    expect(existsSync(ocJson())).toBe(false)
  })

  it('--opencode still forces it when no config dir exists', () => {
    runInit(['--opencode'])
    expect(readOc().plugin).toEqual(['@plur-ai/opencode'])
  })

  it('a re-run is byte-for-byte idempotent', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit()
    const first = readFileSync(ocJson(), 'utf-8')
    const out = runInit()
    expect(readFileSync(ocJson(), 'utf-8')).toBe(first)
    expect(out).toContain('Opencode: config already up to date')
  })

  it('preserves an existing opencode.json and its unrelated keys', () => {
    mkdirSync(ocDir(), { recursive: true })
    writeFileSync(ocJson(), JSON.stringify({
      model: 'provider/some-model',
      plugin: ['some-other-plugin'],
      mcp: { other: { type: 'local', command: ['other-server'] } },
    }))
    runInit()
    const cfg = readOc()
    expect(cfg.model).toBe('provider/some-model')
    expect(cfg.plugin).toEqual(['some-other-plugin', '@plur-ai/opencode'])
    expect(cfg.mcp.other).toEqual({ type: 'local', command: ['other-server'] })
    expect(cfg.mcp.plur.type).toBe('local')
  })

  it('leaves an opencode.jsonc with comments byte-for-byte untouched and says so', () => {
    mkdirSync(ocDir(), { recursive: true })
    const p = join(ocDir(), 'opencode.jsonc')
    const original = '{\n  // my comment\n  "model": "provider/some-model"\n}\n'
    writeFileSync(p, original)
    const out = runInit()
    expect(readFileSync(p, 'utf-8')).toBe(original)
    expect(existsSync(ocJson())).toBe(false)
    expect(out).toContain('could not safely write into it')
  })

  it('uses a pinned npx MCP command on darwin/linux (unchanged)', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit()
    const command: string[] = readOc().mcp.plur.command
    expect(command[0]).toBe('npx')
    expect(command[2]).toMatch(/^@plur-ai\/mcp@\d+\.\d+\.\d+/)
  })

  it('on win32 the MCP entry is node.exe + the @plur-ai/mcp js entry, never bare npx', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit([], true)
    const command: string[] = readOc().mcp.plur.command
    expect(command[0]).not.toBe('npx')
    expect(command[0]).toBe(process.execPath)
    expect(command).toHaveLength(2)
    expect(command[1]).toMatch(/index\.js$/)
    expect(existsSync(command[1])).toBe(true)
  })

  it('on win32 a re-run is idempotent too', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit([], true)
    const first = readFileSync(ocJson(), 'utf-8')
    runInit([], true)
    expect(readFileSync(ocJson(), 'utf-8')).toBe(first)
  })
})
