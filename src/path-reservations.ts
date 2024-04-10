// A path exclusive reservation system
// reserve([list, of, paths], fn)
// When the fn is first in line for all its paths, it
// is called with a cb that clears the reservation.
//
// Used by async unpack to avoid clobbering paths in use,
// while still allowing maximal safe parallelization.

import { join } from 'node:path'
import { normalizeUnicode } from './normalize-unicode.js'
import { stripTrailingSlashes } from './strip-trailing-slashes.js'

const platform =
  process.env.TESTING_TAR_FAKE_PLATFORM || process.platform
const isWindows = platform === 'win32'

export type Reservation = {
  paths: string[]
  dirs: Set<string>
}

export type Handler = (clear: () => void) => void

// return a set of parent dirs for a given path
// '/a/b/c/d' -> ['/', '/a', '/a/b', '/a/b/c', '/a/b/c/d']
const getDirs = (path: string) => {
  const dirs = path
    .split('/')
    .slice(0, -1)
    .reduce((set: string[], path) => {
      const s = set[set.length - 1]
      if (s !== undefined) {
        path = join(s, path)
      }
      set.push(path || '/')
      return set
    }, [])
  return dirs
}

export class PathReservations {
  // path => [function or Set]
  // A Set object means a directory reservation
  // A fn is a direct reservation on that path
  #queues = new Map<string, (Handler | Set<Handler>)[]>()

  // fn => {paths:[path,...], dirs:[path, ...]}
  #reservations = new Map<Handler, Reservation>()

  // functions currently running
  #running = new Set<Handler>()

  reserve(paths: string[], fn: Handler) {
    paths = isWindows
      ? ['win32 parallelization disabled']
      : paths.map(p => {
          // don't need normPath, because we skip this entirely for windows
          return stripTrailingSlashes(
            join(normalizeUnicode(p)),
          ).toLowerCase()
        })

    const dirs = new Set<string>(
      paths.map(path => getDirs(path)).reduce((a, b) => a.concat(b)),
    )
    this.#reservations.set(fn, { dirs, paths })
    for (const p of paths) {
      const q = this.#queues.get(p)
      if (!q) {
        this.#queues.set(p, [fn])
      } else {
        q.push(fn)
      }
    }
    for (const dir of dirs) {
      const q = this.#queues.get(dir)
      if (!q) {
        this.#queues.set(dir, [new Set([fn])])
      } else {
        const l = q[q.length - 1]
        if (l instanceof Set) {
          l.add(fn)
        } else {
          q.push(new Set([fn]))
        }
      }
    }
    return this.#run(fn)
  }

  // return the queues for each path the function cares about
  // fn => {paths, dirs}
  #getQueues(fn: Handler): {
    paths: Handler[][]
    dirs: (Handler | Set<Handler>)[][]
  } {
    const res = this.#reservations.get(fn)
    /* c8 ignore start */
    if (!res) {
      throw new Error('function does not have any path reservations')
    }
    /* c8 ignore stop */
    return {
      paths: res.paths.map((path: string) =>
        this.#queues.get(path),
      ) as Handler[][],
      dirs: [...res.dirs].map(path => this.#queues.get(path)) as (
        | Handler
        | Set<Handler>
      )[][],
    }
  }

  // check if fn is first in line for all its paths, and is
  // included in the first set for all its dir queues
  check(fn: Handler) {
    const { paths, dirs } = this.#getQueues(fn)
    return (
      paths.every(q => q && q[0] === fn) &&
      dirs.every(q => q && q[0] instanceof Set && q[0].has(fn))
    )
  }

  // run the function if it's first in line and not already running
  #run(fn: Handler) {
    if (this.#running.has(fn) || !this.check(fn)) {
      return false
    }
    this.#running.add(fn)
    fn(() => this.#clear(fn))
    return true
  }

  #clear(fn: Handler) {
    if (!this.#running.has(fn)) {
      return false
    }
    const res = this.#reservations.get(fn)
    /* c8 ignore start */
    if (!res) {
      throw new Error('invalid reservation')
    }
    /* c8 ignore stop */
    const { paths, dirs } = res

    const next = new Set<Handler>()
    for (const path of paths) {
      const q = this.#queues.get(path)
      /* c8 ignore start */
      if (!q || q?.[0] !== fn) {
        continue
      }
      /* c8 ignore stop */
      const q0 = q[1]
      if (!q0) {
        this.#queues.delete(path)
        continue
      }
      q.shift()
      if (typeof q0 === 'function') {
        next.add(q0)
      } else {
        for (const f of q0) {
          next.add(f)
        }
      }
    }

    for (const dir of dirs) {
      const q = this.#queues.get(dir)
      const q0 = q?.[0]
      /* c8 ignore next - type safety only */
      if (!q || !(q0 instanceof Set)) continue
      if (q0.size === 1 && q.length === 1) {
        this.#queues.delete(dir)
        continue
      } else if (q0.size === 1) {
        q.shift()
        // next one must be a function,
        // or else the Set would've been reused
        const n = q[0]
        if (typeof n === 'function') {
          next.add(n)
        }
      } else {
        q0.delete(fn)
      }
    }

    this.#running.delete(fn)
    next.forEach(fn => this.#run(fn))
    return true
  }
}
