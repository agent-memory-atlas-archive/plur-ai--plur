import { join } from 'path'

/**
 * Environment for a spawned `plur init` / `plur doctor` rooted entirely in a
 * temp HOME.
 *
 * Overriding HOME/USERPROFILE is not enough: the opencode leg resolves its
 * config directory from OPENCODE_CONFIG_DIR, then `$XDG_CONFIG_HOME/opencode`,
 * and only then `~/.config/opencode` (`opencodeConfigDir` in
 * src/opencode-config.ts). An inherited XDG_CONFIG_HOME (CI runners set one,
 * as do many desktops) sends `init` to write a real opencode.json outside the
 * temp HOME, and sends `doctor` to read a directory the test never wrote.
 * An empty OPENCODE_CONFIG_DIR is treated as unset by `opencodeConfigDir`.
 */
export function isolatedHomeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENCODE_CONFIG_DIR: '',
  }
}
