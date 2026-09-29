#!/usr/bin/env node
/**
 * Windows hook probe (decision H3, #1267). Run by .github/workflows/windows-init.yml
 * on windows-latest; never run against a real home directory.
 *
 * 1. `plur init` into a temporary HOME whose path contains a space, with
 *    Claude Code, Cursor, Codex and Antigravity all set up.
 * 2. Every hook init generated is executed EXACTLY as written:
 *    - Claude Code hooks (exec form: command + args) are spawned with no shell;
 *    - Cursor, Codex and Antigravity hook strings are run through each of
 *      `bash -c`, `pwsh -NoProfile -Command` and `cmd /C`.
 * 3. PLUR_HOOK_PROBE makes the CLI append the hook subcommand it received to
 *    a file and exit without running the hook. A run passes only when that
 *    file holds exactly the subcommand the hook string names — proof the
 *    string reached the CLI through that shell, not merely that the shell
 *    exited 0 (PowerShell prints a quoted string and exits 0).
 *
 * Exits 1 when any run fails.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(repo, 'packages', 'cli', 'dist', 'index.js')
if (!existsSync(CLI)) { console.error(`built CLI not found at ${CLI}`); process.exit(1) }

const home = mkdtempSync(join(tmpdir(), 'Test User-'))
if (!/\s/.test(home)) { console.error(`temp HOME has no space: ${home}`); process.exit(1) }
const project = join(home, 'project')
mkdirSync(project, { recursive: true })
const env = { ...process.env, HOME: home, USERPROFILE: home }
console.log(`HOME: ${home}`)

const init = spawnSync(process.execPath, [CLI, 'init', '--global', '--no-desktop', '--no-opencode', '--cursor', '--codex', '--antigravity', '--no-prompt'], {
  cwd: project, env, encoding: 'utf8', timeout: 120000,
})
console.log(init.stdout)
if (init.status !== 0) { console.error(init.stderr); process.exit(1) }

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
function collect(value, out = []) {
  if (Array.isArray(value)) for (const v of value) collect(v, out)
  else if (value && typeof value === 'object') {
    if (typeof value.command === 'string') out.push({ command: value.command, args: value.args })
    for (const [k, v] of Object.entries(value)) if (k !== 'command' && k !== 'args') collect(v, out)
  }
  return out
}

const claude = collect(readJson(join(home, '.claude', 'settings.json')).hooks)
const strings = {
  Cursor: collect(readJson(join(project, '.cursor', 'hooks.json')).hooks).map((h) => h.command),
  Codex: collect(readJson(join(home, '.codex', 'hooks.json')).hooks).map((h) => h.command),
  Antigravity: collect(readJson(join(home, '.gemini', 'config', 'hooks.json'))).map((h) => h.command),
}

const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(existsSync) ?? 'bash'
const shells = {
  bash: (cmd) => [gitBash, ['-c', cmd], {}],
  pwsh: (cmd) => ['pwsh', ['-NoProfile', '-Command', cmd], {}],
  cmd: (cmd) => ['cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { windowsVerbatimArguments: true }],
}

let n = 0
const failures = []
function probe(label, expected, file, args, opts) {
  const out = join(home, `probe-${++n}.txt`)
  rmSync(out, { force: true })
  const r = spawnSync(file, args, { ...opts, env: { ...env, PLUR_HOOK_PROBE: out }, input: '{}', encoding: 'utf8', timeout: 60000, cwd: project })
  const got = existsSync(out) ? readFileSync(out, 'utf8') : ''
  const ok = got === `${expected}\n`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (exit ${r.status}${ok ? '' : `, probe=${JSON.stringify(got)}, stdout=${JSON.stringify((r.stdout ?? '').slice(0, 200))}, stderr=${JSON.stringify((r.stderr ?? '').slice(0, 200))}`})`)
  if (!ok) failures.push(label)
}

console.log(`\nClaude Code: ${claude.length} hooks, exec form (no shell)`)
for (const h of claude) {
  if (!Array.isArray(h.args)) { console.log(`FAIL  Claude Code shell-string hook on Windows: ${h.command}`); failures.push(h.command); continue }
  const sub = h.args.find((a) => /^hook-/.test(a))
  probe(`Claude Code: ${[h.command, ...h.args].join(' ')}`, sub, h.command, h.args, {})
}

for (const [editor, cmds] of Object.entries(strings)) {
  console.log(`\n${editor}: ${cmds.length} hooks`)
  for (const cmd of cmds) {
    const sub = /\s(hook-[a-z0-9-]+)/.exec(cmd)?.[1]
    for (const [shell, build] of Object.entries(shells)) {
      const [file, args, opts] = build(cmd)
      probe(`${editor} via ${shell}: ${cmd}`, sub, file, args, opts)
    }
  }
}

const doctor = spawnSync(process.execPath, [CLI, 'doctor', '--no-handshake', '--json'], { cwd: project, env, encoding: 'utf8', timeout: 120000 })
try {
  const report = JSON.parse(doctor.stdout)
  console.log(`\nplur doctor: hooksInstalled=${report.hooksInstalled} windowsHookFallback=${JSON.stringify(report.windowsHookFallback)}`)
  if (!report.hooksInstalled) failures.push('doctor: hooksInstalled false')
} catch {
  console.log(`\nplur doctor output was not JSON: ${doctor.stdout.slice(0, 500)}`)
  failures.push('doctor')
}

console.log(`\n${n} runs, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
