/**
 * #1267 — unit coverage for the Windows pieces of `plur init`: hook command
 * quoting, recognising our own hooks in every slash/quote style, and the
 * MCP entry shape (node.exe + js entry, never a `.cmd`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { hookCommandPrefix, isPlurHookCommand } from '../src/lib/hook-command.js'
import { buildMcpServerEntry, upgradePlurMcpEntry } from '../src/mcp-config.js'
import { CLI_VERSION } from '../src/version.js'
import { buildCursorHooks, mergeCursorHooks, hasPlurCursorHooks } from '../src/cursor-hooks.js'
import { buildCodexHooks, mergeCodexHooks } from '../src/codex-hooks.js'

const WIN_SHIM = 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd'

const realPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p })
}

describe('hookCommandPrefix (#1267)', () => {
  it('quotes the shim path on win32', () => {
    expect(hookCommandPrefix(WIN_SHIM, 'win32')).toBe(`"${WIN_SHIM}"`)
    expect(hookCommandPrefix('C:\\Users\\a\\.plur\\bin\\plur-hook.cmd', 'win32')).toBe('"C:\\Users\\a\\.plur\\bin\\plur-hook.cmd"')
  })

  it('leaves a darwin/linux path without whitespace byte-identical', () => {
    expect(hookCommandPrefix('/Users/a/.plur/bin/plur-hook', 'darwin')).toBe('/Users/a/.plur/bin/plur-hook')
    expect(hookCommandPrefix('/home/a/.plur/bin/plur-hook', 'linux')).toBe('/home/a/.plur/bin/plur-hook')
  })

  it('quotes a darwin/linux path that contains a space', () => {
    expect(hookCommandPrefix('/Users/Test User/.plur/bin/plur-hook', 'darwin')).toBe('"/Users/Test User/.plur/bin/plur-hook"')
  })
})

describe('isPlurHookCommand (#1267)', () => {
  it.each([
    ['/home/a/.plur/bin/plur-hook hook-inject'],
    ['"/Users/Test User/.plur/bin/plur-hook" hook-inject'],
    [`${WIN_SHIM} hook-inject`],
    [`"${WIN_SHIM}" hook-inject`],
    ['C:/Users/a/.plur/bin/plur-hook.cmd hook-inject'],
    ['C:\\Users\\A\\.PLUR\\BIN\\PLUR-HOOK.CMD hook-inject'],
    ['npx -y @plur-ai/cli@0.20.1 hook-inject'],
  ])('recognises %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(true)
  })

  it.each([
    ['C:\\tools\\my-own-hook.exe'],
    ['/usr/local/bin/lint.sh'],
    ['echo plur'],
  ])('does not claim %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(false)
  })
})

describe('Cursor and Codex hook merges on Windows (#1267)', () => {
  it('Cursor: re-init over an older unquoted backslash set leaves one set', () => {
    const oldSet = buildCursorHooks(WIN_SHIM)
    const doubled = {
      version: 1,
      hooks: Object.fromEntries(Object.entries(oldSet).map(([ev, es]) => [ev, [...es, ...es]])),
    }
    expect(hasPlurCursorHooks(doubled)).toBe(true)
    const next = mergeCursorHooks(doubled, buildCursorHooks(hookCommandPrefix(WIN_SHIM, 'win32')))
    for (const entries of Object.values(next.hooks)) {
      expect(entries).toHaveLength(1)
      expect(entries[0].command.startsWith(`"${WIN_SHIM}" `)).toBe(true)
    }
  })

  it('Codex: re-init over an older unquoted backslash set leaves one set', () => {
    const old = mergeCodexHooks({ hooks: {} }, buildCodexHooks(WIN_SHIM))
    const next = mergeCodexHooks(old, buildCodexHooks(hookCommandPrefix(WIN_SHIM, 'win32')))
    for (const entries of Object.values(next.hooks ?? {})) {
      const specs = entries.flatMap((e) => e.hooks)
      expect(specs).toHaveLength(1)
      expect(specs[0].command.startsWith(`"${WIN_SHIM}" `)).toBe(true)
    }
  })
})

describe('buildMcpServerEntry (#1267)', () => {
  let home: string
  let savedHome: string | undefined
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'Test User-'))
    savedHome = process.env.HOME
    process.env.HOME = home
    mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
  })
  afterEach(() => {
    setPlatform(realPlatform)
    process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  function writeWinShim(entrypoint: string | null): void {
    writeFileSync(join(home, '.plur', 'bin', 'plur-mcp.cmd'), '@echo off\r\n')
    if (entrypoint !== null) {
      writeFileSync(join(home, '.plur', 'bin', 'plur-mcp.meta.json'),
        JSON.stringify({ entrypoint, node: 'C:\\old\\node.exe', installed: 'x' }))
    }
  }

  it('win32: launches node.exe with the @plur-ai/mcp js entry', () => {
    const entry = join(home, 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'mcp', 'dist'), { recursive: true })
    writeFileSync(entry, '')
    writeWinShim(entry)
    setPlatform('win32')
    expect(buildMcpServerEntry()).toEqual({ command: process.execPath, args: [entry] })
    expect(buildMcpServerEntry({ env: { PLUR_TOOL_PROFILE: 'cursor' } }))
      .toEqual({ command: process.execPath, args: [entry], env: { PLUR_TOOL_PROFILE: 'cursor' } })
  })

  it('win32: falls back to cmd.exe /c npx (pinned) when the js entry cannot be resolved — never the .cmd shim', () => {
    writeWinShim(join(home, 'gone', 'index.js'))
    setPlatform('win32')
    expect(buildMcpServerEntry()).toEqual({ command: 'cmd.exe', args: ['/c', 'npx', '-y', `@plur-ai/mcp@${CLI_VERSION}`] })
    rmSync(join(home, '.plur', 'bin', 'plur-mcp.meta.json'))
    expect(buildMcpServerEntry().command).toBe('cmd.exe')
  })

  it('win32: heals a .cmd entry an older init wrote', () => {
    const entry = join(home, 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'mcp', 'dist'), { recursive: true })
    writeFileSync(entry, '')
    writeWinShim(entry)
    setPlatform('win32')
    const config: Record<string, unknown> = {
      mcpServers: { plur: { command: 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd', args: [], cwd: 'keep' } },
    }
    expect(upgradePlurMcpEntry(config)).toBe(true)
    expect((config.mcpServers as Record<string, unknown>).plur).toEqual({ command: process.execPath, args: [entry], cwd: 'keep' })
    // Idempotent.
    expect(upgradePlurMcpEntry(config)).toBe(false)
  })

  it('win32: never touches a hand-rolled custom entry', () => {
    setPlatform('win32')
    const config: Record<string, unknown> = { mcpServers: { plur: { command: 'C:\\custom\\run-plur.cmd', args: [] } } }
    expect(upgradePlurMcpEntry(config)).toBe(false)
  })

  it('darwin/linux: shim entry unchanged', () => {
    const shim = join(home, '.plur', 'bin', 'plur-mcp')
    writeFileSync(shim, '#!/bin/sh\n')
    for (const p of ['darwin', 'linux'] as const) {
      setPlatform(p)
      expect(buildMcpServerEntry()).toEqual({ command: shim, args: [] })
    }
  })

  it('darwin/linux: npx fallback unchanged', () => {
    for (const p of ['darwin', 'linux'] as const) {
      setPlatform(p)
      expect(buildMcpServerEntry()).toEqual({ command: '/bin/sh', args: ['-lc', `exec npx -y @plur-ai/mcp@${CLI_VERSION}`] })
    }
  })
})
