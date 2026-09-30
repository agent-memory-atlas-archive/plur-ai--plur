/**
 * Test preload (`node --import <this> cli.js hook-inject`) that lines up
 * concurrent hook-inject processes AT the inject lock.
 *
 * Process start-up jitter (tens of ms) is far wider than any lock's
 * check-to-create window, so hooks spawned together would otherwise reach the
 * lock one after another and even a racy lock would look exclusive. On its
 * first touch of a `*.injecting` path (statSync or openSync, whichever the
 * lock uses first) each process records its arrival in
 * PLUR_TEST_BARRIER_DIR and spins until PLUR_TEST_BARRIER_N have arrived
 * (bounded at 10s), then proceeds. Nothing in production reads these env
 * vars; without this preload they are inert.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const DIR = process.env.PLUR_TEST_BARRIER_DIR
const N = Number(process.env.PLUR_TEST_BARRIER_N || 0)
let waited = false

function barrier(path) {
  if (waited || !DIR || !N || typeof path !== 'string' || !path.endsWith('.injecting')) return
  waited = true
  fs.writeFileSync(join(DIR, `arrived-${process.pid}`), '')
  const until = Date.now() + 10_000
  while (Date.now() < until && fs.readdirSync(DIR).filter(f => f.startsWith('arrived-')).length < N) { /* spin */ }
}

for (const name of ['statSync', 'openSync', 'writeFileSync']) {
  const real = fs[name]
  fs[name] = function (path, ...rest) { barrier(path); return real.call(this, path, ...rest) }
}
syncBuiltinESMExports()
