/**
 * Test preload (`node --import <this> cli.js ...`): make acquiring the store
 * lock SLOW, so a hook that force-exits while its process is inside a store
 * write is caught doing it every time rather than 1 run in N (#1343).
 *
 * The lock is taken by `writeFile(lock, token, { flag: O_EXCL })` in core's
 * async-lock. This splits that call into its two halves — the O_EXCL create
 * (an EMPTY file) and the token write — and sleeps between them for
 * PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS — a comma list, one delay per acquisition
 * in order, the last one repeating ("6000,1500": the first holder is slow, so
 * a second writer in the same process queues behind it; the second is quick
 * enough to finish inside a bounded wait). That is the exact state measured on a
 * 10,000-engram store when the Claude Code hook exited mid-write (#1313): an
 * empty lock, which core cannot attribute to anyone and so waits out for 60s.
 *
 * Nothing in production reads the env var; without this preload it is inert.
 */
import fsp from 'node:fs/promises'
import { constants } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const DELAYS = String(process.env.PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS ?? '')
  .split(',').filter(s => s.trim() !== '').map(Number).filter(n => Number.isFinite(n) && n >= 0)
let acquisitions = 0
const realWriteFile = fsp.writeFile

fsp.writeFile = async function slowLockWriteFile(file, data, options) {
  const flag = options && typeof options === 'object' ? options.flag : undefined
  if (DELAYS.length > 0 && typeof file === 'string' && file.endsWith('engrams.yaml.lock')
    && typeof flag === 'number' && (flag & constants.O_EXCL)) {
    const handle = await fsp.open(file, flag) // throws EEXIST exactly as before
    const delay = DELAYS[Math.min(acquisitions++, DELAYS.length - 1)]
    try {
      await new Promise(r => setTimeout(r, delay))
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    return
  }
  return realWriteFile.call(this, file, data, options)
}
syncBuiltinESMExports()
