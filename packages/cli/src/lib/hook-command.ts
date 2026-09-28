import { platform } from 'os'

/**
 * The command prefix every PLUR hook entry starts with, given the shim path
 * `plur init` installed (#1267).
 *
 * Harnesses run hook commands through a shell, so an unquoted path splits at
 * the first space: `C:\Users\Test User\.plur\bin\plur-hook.cmd hook-inject`
 * becomes the command `C:\Users\Test`. Windows home directories contain
 * spaces often enough that the path is always quoted there. Elsewhere it is
 * quoted only when it contains whitespace, so a darwin/linux path without
 * one stays byte-identical to what earlier versions wrote.
 */
export function hookCommandPrefix(binPath: string, plat: NodeJS.Platform = platform()): string {
  if (plat === 'win32' || /\s/.test(binPath)) return `"${binPath}"`
  return binPath
}

/**
 * Is this hook command one PLUR wrote? Recognises the shim in either slash
 * style, quoted or not, in any case (Windows paths are case-insensitive),
 * plus the `npx @plur-ai/cli` fallback. Before #1267 the match was a
 * forward-slash substring, so a re-run of `plur init` on Windows did not see
 * its own backslash hooks and appended a second set.
 */
export function isPlurHookCommand(command: string): boolean {
  const normalised = command.replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
  return normalised.includes('@plur-ai/cli') || normalised.includes('.plur/bin/plur-hook')
}
