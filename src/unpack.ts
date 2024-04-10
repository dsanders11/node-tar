// the PEND/UNPEND stuff tracks whether we're ready to emit end/close yet.
// but the path reservations are required to avoid race conditions where
// parallelized unpack ops may mess with one another, due to dependencies
// (like a Link depending on its target) or destructive operations (like
// clobbering an fs object to create one of a different type.)

import * as fsm from '@isaacs/fs-minipass'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import fs, { type Stats } from 'node:fs'
import path from 'node:path'
import { getWriteFlag } from './get-write-flag.js'
import { mkdir, MkdirError, mkdirSync } from './mkdir.js'
import { normalizeUnicode } from './normalize-unicode.js'
import { normalizeWindowsPath } from './normalize-windows-path.js'
import { Parser } from './parse.js'
import { stripAbsolutePath } from './strip-absolute-path.js'
import { stripTrailingSlashes } from './strip-trailing-slashes.js'
import * as wc from './winchars.js'

import { TarOptions } from './options.js'
import { PathReservations } from './path-reservations.js'
import { ReadEntry } from './read-entry.js'
import { WarnData } from './warn-method.js'

const ONENTRY = Symbol('onEntry')
const CHECKFS = Symbol('checkFs')
const CHECKFS2 = Symbol('checkFs2')
const PRUNECACHE = Symbol('pruneCache')
const ISREUSABLE = Symbol('isReusable')
const MAKEFS = Symbol('makeFs')
const FILE = Symbol('file')
const DIRECTORY = Symbol('directory')
const LINK = Symbol('link')
const SYMLINK = Symbol('symlink')
const HARDLINK = Symbol('hardlink')
const UNSUPPORTED = Symbol('unsupported')
const CHECKPATH = Symbol('checkPath')
const MKDIR = Symbol('mkdir')
const ONERROR = Symbol('onError')
const PENDING = Symbol('pending')
const PEND = Symbol('pend')
const UNPEND = Symbol('unpend')
const ENDED = Symbol('ended')
const MAYBECLOSE = Symbol('maybeClose')
const SKIP = Symbol('skip')
const DOCHOWN = Symbol('doChown')
const UID = Symbol('uid')
const GID = Symbol('gid')
const CHECKED_CWD = Symbol('checkedCwd')
const platform =
  process.env.TESTING_TAR_FAKE_PLATFORM || process.platform
const isWindows = platform === 'win32'
const DEFAULT_MAX_DEPTH = 1024

// Unlinks on Windows are not atomic.
//
// This means that if you have a file entry, followed by another
// file entry with an identical name, and you cannot re-use the file
// (because it's a hardlink, or because unlink:true is set, or it's
// Windows, which does not have useful nlink values), then the unlink
// will be committed to the disk AFTER the new file has been written
// over the old one, deleting the new file.
//
// To work around this, on Windows systems, we rename the file and then
// delete the renamed file.  It's a sloppy kludge, but frankly, I do not
// know of a better way to do this, given windows' non-atomic unlink
// semantics.
//
// See: https://github.com/npm/node-tar/issues/183
/* c8 ignore start */
const unlinkFile = (
  path: string,
  cb: (er?: Error | null) => void,
) => {
  if (!isWindows) {
    return fs.unlink(path, cb)
  }

  const name = path + '.DELETE.' + randomBytes(16).toString('hex')
  fs.rename(path, name, er => {
    if (er) {
      return cb(er)
    }
    fs.unlink(name, cb)
  })
}
/* c8 ignore stop */

/* c8 ignore start */
const unlinkFileSync = (path: string) => {
  if (!isWindows) {
    return fs.unlinkSync(path)
  }

  const name = path + '.DELETE.' + randomBytes(16).toString('hex')
  fs.renameSync(path, name)
  fs.unlinkSync(name)
}
/* c8 ignore stop */

// this.gid, entry.gid, this.processUid
const uint32 = (
  a: number | undefined,
  b: number | undefined,
  c: number | undefined,
) =>
  a !== undefined && a === a >>> 0
    ? a
    : b !== undefined && b === b >>> 0
      ? b
      : c

// clear the cache if it's a case-insensitive unicode-squashing match.
// we can't know if the current file system is case-sensitive or supports
// unicode fully, so we check for similarity on the maximally compatible
// representation.  Err on the side of pruning, since all it's doing is
// preventing lstats, and it's not the end of the world if we get a false
// positive.
// Note that on windows, we always drop the entire cache whenever a
// symbolic link is encountered, because 8.3 filenames are impossible
// to reason about, and collisions are hazards rather than just failures.
const cacheKeyNormalize = (path: string) =>
  stripTrailingSlashes(
    normalizeWindowsPath(normalizeUnicode(path)),
  ).toLowerCase()

// remove all cache entries matching ${abs}/**
const pruneCache = (cache: Map<string, boolean>, abs: string) => {
  abs = cacheKeyNormalize(abs)
  for (const path of cache.keys()) {
    const pnorm = cacheKeyNormalize(path)
    if (pnorm === abs || pnorm.indexOf(abs + '/') === 0) {
      cache.delete(path)
    }
  }
}

const dropCache = (cache: Map<string, boolean>) => {
  for (const key of cache.keys()) {
    cache.delete(key)
  }
}

export class Unpack extends Parser {
  [ENDED]: boolean = false;
  [CHECKED_CWD]: boolean = false;
  [PENDING]: number = 0

  reservations: PathReservations = new PathReservations()
  transform?: TarOptions['transform']
  writable: true = true
  readable: false = false
  dirCache: Exclude<TarOptions['dirCache'], undefined>
  uid?: number
  gid?: number
  setOwner: boolean
  preserveOwner: boolean
  processGid?: number
  processUid?: number
  maxDepth: number
  forceChown: boolean
  win32: boolean
  newer: boolean
  keep: boolean
  noMtime: boolean
  preservePaths: boolean
  unlink: boolean
  cwd: string
  strip: number
  processUmask: number
  umask: number
  dmode: number
  fmode: number
  noChmod: boolean

  constructor(opt: TarOptions = {}) {
    opt.ondone = () => {
      this[ENDED] = true
      this[MAYBECLOSE]()
    }

    super(opt)

    this.transform = opt.transform

    this.dirCache = opt.dirCache || new Map()
    this.noChmod = !!opt.noChmod

    if (typeof opt.uid === 'number' || typeof opt.gid === 'number') {
      // need both or neither
      if (
        typeof opt.uid !== 'number' ||
        typeof opt.gid !== 'number'
      ) {
        throw new TypeError(
          'cannot set owner without number uid and gid',
        )
      }
      if (opt.preserveOwner) {
        throw new TypeError(
          'cannot preserve owner in archive and also set owner explicitly',
        )
      }
      this.uid = opt.uid
      this.gid = opt.gid
      this.setOwner = true
    } else {
      this.uid = undefined
      this.gid = undefined
      this.setOwner = false
    }

    // default true for root
    if (
      opt.preserveOwner === undefined &&
      typeof opt.uid !== 'number'
    ) {
      this.preserveOwner = !!(
        process.getuid && process.getuid() === 0
      )
    } else {
      this.preserveOwner = !!opt.preserveOwner
    }

    this.processUid =
      (this.preserveOwner || this.setOwner) && process.getuid
        ? process.getuid()
        : undefined
    this.processGid =
      (this.preserveOwner || this.setOwner) && process.getgid
        ? process.getgid()
        : undefined

    // prevent excessively deep nesting of subfolders
    // set to `Infinity` to remove this restriction
    this.maxDepth =
      typeof opt.maxDepth === 'number'
        ? opt.maxDepth
        : DEFAULT_MAX_DEPTH

    // mostly just for testing, but useful in some cases.
    // Forcibly trigger a chown on every entry, no matter what
    this.forceChown = opt.forceChown === true

    // turn ><?| in filenames into 0xf000-higher encoded forms
    this.win32 = !!opt.win32 || isWindows

    // do not unpack over files that are newer than what's in the archive
    this.newer = !!opt.newer

    // do not unpack over ANY files
    this.keep = !!opt.keep

    // do not set mtime/atime of extracted entries
    this.noMtime = !!opt.noMtime

    // allow .., absolute path entries, and unpacking through symlinks
    // without this, warn and skip .., relativize absolutes, and error
    // on symlinks in extraction path
    this.preservePaths = !!opt.preservePaths

    // unlink files and links before writing. This breaks existing hard
    // links, and removes symlink directories rather than erroring
    this.unlink = !!opt.unlink

    this.cwd = normalizeWindowsPath(
      path.resolve(opt.cwd || process.cwd()),
    )
    this.strip = Number(opt.strip) || 0
    // if we're not chmodding, then we don't need the process umask
    this.processUmask = opt.noChmod ? 0 : process.umask()
    this.umask =
      typeof opt.umask === 'number' ? opt.umask : this.processUmask

    // default mode for dirs created as parents
    this.dmode = opt.dmode || 0o0777 & ~this.umask
    this.fmode = opt.fmode || 0o0666 & ~this.umask

    this.on('entry', entry => this[ONENTRY](entry))
  }

  // a bad or damaged archive is a warning for Parser, but an error
  // when extracting.  Mark those errors as unrecoverable, because
  // the Unpack contract cannot be met.
  warn(code: string, msg: string | Error, data: WarnData = {}) {
    if (code === 'TAR_BAD_ARCHIVE' || code === 'TAR_ABORT') {
      data.recoverable = false
    }
    return super.warn(code, msg, data)
  }

  [MAYBECLOSE]() {
    if (this[ENDED] && this[PENDING] === 0) {
      this.emit('prefinish')
      this.emit('finish')
      this.emit('end')
    }
  }

  [CHECKPATH](entry: ReadEntry) {
    const p = normalizeWindowsPath(entry.path)
    const parts = p.split('/')

    if (this.strip) {
      if (parts.length < this.strip) {
        return false
      }
      if (entry.type === 'Link') {
        const linkparts = normalizeWindowsPath(
          String(entry.linkpath),
        ).split('/')
        if (linkparts.length >= this.strip) {
          entry.linkpath = linkparts.slice(this.strip).join('/')
        } else {
          return false
        }
      }
      parts.splice(0, this.strip)
      entry.path = parts.join('/')
    }

    if (isFinite(this.maxDepth) && parts.length > this.maxDepth) {
      this.warn('TAR_ENTRY_ERROR', 'path excessively deep', {
        entry,
        path: p,
        depth: parts.length,
        maxDepth: this.maxDepth,
      })
      return false
    }

    if (!this.preservePaths) {
      if (
        parts.includes('..') ||
        /* c8 ignore next */
        (isWindows && /^[a-z]:\.\.$/i.test(parts[0] ?? ''))
      ) {
        this.warn('TAR_ENTRY_ERROR', `path contains '..'`, {
          entry,
          path: p,
        })
        return false
      }

      // strip off the root
      const [root, stripped] = stripAbsolutePath(p)
      if (root) {
        entry.path = String(stripped)
        this.warn(
          'TAR_ENTRY_INFO',
          `stripping ${root} from absolute path`,
          {
            entry,
            path: p,
          },
        )
      }
    }

    if (path.isAbsolute(entry.path)) {
      entry.absolute = normalizeWindowsPath(path.resolve(entry.path))
    } else {
      entry.absolute = normalizeWindowsPath(
        path.resolve(this.cwd, entry.path),
      )
    }

    // if we somehow ended up with a path that escapes the cwd, and we are
    // not in preservePaths mode, then something is fishy!  This should have
    // been prevented above, so ignore this for coverage.
    /* c8 ignore start - defense in depth */
    if (
      !this.preservePaths &&
      typeof entry.absolute === 'string' &&
      entry.absolute.indexOf(this.cwd + '/') !== 0 &&
      entry.absolute !== this.cwd
    ) {
      this.warn('TAR_ENTRY_ERROR', 'path escaped extraction target', {
        entry,
        path: normalizeWindowsPath(entry.path),
        resolvedPath: entry.absolute,
        cwd: this.cwd,
      })
      return false
    }
    /* c8 ignore stop */

    // an archive can set properties on the extraction directory, but it
    // may not replace the cwd with a different kind of thing entirely.
    if (
      entry.absolute === this.cwd &&
      entry.type !== 'Directory' &&
      entry.type !== 'GNUDumpDir'
    ) {
      return false
    }

    // only encode : chars that aren't drive letter indicators
    if (this.win32) {
      const { root: aRoot } = path.win32.parse(String(entry.absolute))
      entry.absolute =
        aRoot + wc.encode(String(entry.absolute).slice(aRoot.length))
      const { root: pRoot } = path.win32.parse(entry.path)
      entry.path = pRoot + wc.encode(entry.path.slice(pRoot.length))
    }

    return true
  }

  [ONENTRY](entry: ReadEntry) {
    if (!this[CHECKPATH](entry)) {
      return entry.resume()
    }

    assert.equal(typeof entry.absolute, 'string')

    switch (entry.type) {
      case 'Directory':
      case 'GNUDumpDir':
        if (entry.mode) {
          entry.mode = entry.mode | 0o700
        }

      // eslint-disable-next-line no-fallthrough
      case 'File':
      case 'OldFile':
      case 'ContiguousFile':
      case 'Link':
      case 'SymbolicLink':
        return this[CHECKFS](entry)

      case 'CharacterDevice':
      case 'BlockDevice':
      case 'FIFO':
      default:
        return this[UNSUPPORTED](entry)
    }
  }

  [ONERROR](er: Error, entry: ReadEntry) {
    // Cwd has to exist, or else nothing works. That's serious.
    // Other errors are warnings, which raise the error in strict
    // mode, but otherwise continue on.
    if (er.name === 'CwdError') {
      this.emit('error', er)
    } else {
      this.warn('TAR_ENTRY_ERROR', er, { entry })
      this[UNPEND]()
      entry.resume()
    }
  }

  [MKDIR](
    dir: string,
    mode: number,
    cb: (er?: null | MkdirError, made?: string) => void,
  ) {
    mkdir(
      normalizeWindowsPath(dir),
      {
        uid: this.uid,
        gid: this.gid,
        processUid: this.processUid,
        processGid: this.processGid,
        umask: this.processUmask,
        preserve: this.preservePaths,
        unlink: this.unlink,
        cache: this.dirCache,
        cwd: this.cwd,
        mode: mode,
        noChmod: this.noChmod,
      },
      cb,
    )
  }

  [DOCHOWN](entry: ReadEntry) {
    // in preserve owner mode, chown if the entry doesn't match process
    // in set owner mode, chown if setting doesn't match process
    return (
      this.forceChown ||
      (this.preserveOwner &&
        ((typeof entry.uid === 'number' &&
          entry.uid !== this.processUid) ||
          (typeof entry.gid === 'number' &&
            entry.gid !== this.processGid))) ||
      (typeof this.uid === 'number' &&
        this.uid !== this.processUid) ||
      (typeof this.gid === 'number' && this.gid !== this.processGid)
    )
  }

  [UID](entry: ReadEntry) {
    return uint32(this.uid, entry.uid, this.processUid)
  }

  [GID](entry: ReadEntry) {
    return uint32(this.gid, entry.gid, this.processGid)
  }

  [FILE](entry: ReadEntry, fullyDone: () => void) {
    const mode =
      typeof entry.mode === 'number'
        ? entry.mode & 0o7777
        : this.fmode
    const stream = new fsm.WriteStream(String(entry.absolute), {
      // slight lie, but it can be numeric flags
      flags: getWriteFlag(entry.size) as string,
      mode: mode,
      autoClose: false,
    })
    stream.on('error', (er: Error) => {
      if (stream.fd) {
        fs.close(stream.fd, () => {})
      }

      // flush all the data out so that we aren't left hanging
      // if the error wasn't actually fatal.  otherwise the parse
      // is blocked, and we never proceed.
      stream.write = () => true
      this[ONERROR](er, entry)
      fullyDone()
    })

    let actions = 1
    const done = (er?: null | Error) => {
      if (er) {
        /* c8 ignore start - we should always have a fd by now */
        if (stream.fd) {
          fs.close(stream.fd, () => {})
        }
        /* c8 ignore stop */

        this[ONERROR](er, entry)
        fullyDone()
        return
      }

      if (--actions === 0) {
        if (stream.fd !== undefined) {
          fs.close(stream.fd, er => {
            if (er) {
              this[ONERROR](er, entry)
            } else {
              this[UNPEND]()
            }
            fullyDone()
          })
        }
      }
    }

    stream.on('finish', () => {
      // if futimes fails, try utimes
      // if utimes fails, fail with the original error
      // same for fchown/chown
      const abs = String(entry.absolute)
      const fd = stream.fd

      if (typeof fd === 'number' && entry.mtime && !this.noMtime) {
        actions++
        const atime = entry.atime || new Date()
        const mtime = entry.mtime
        fs.futimes(fd, atime, mtime, er =>
          er
            ? fs.utimes(abs, atime, mtime, er2 => done(er2 && er))
            : done(),
        )
      }

      if (typeof fd === 'number' && this[DOCHOWN](entry)) {
        actions++
        const uid = this[UID](entry)
        const gid = this[GID](entry)
        if (typeof uid === 'number' && typeof gid === 'number') {
          fs.fchown(fd, uid, gid, er =>
            er
              ? fs.chown(abs, uid, gid, er2 => done(er2 && er))
              : done(),
          )
        }
      }

      done()
    })

    const tx = this.transform ? this.transform(entry) || entry : entry
    if (tx !== entry) {
      tx.on('error', (er: Error) => {
        this[ONERROR](er, entry)
        fullyDone()
      })
      entry.pipe(tx)
    }
    tx.pipe(stream)
  }

  [DIRECTORY](entry: ReadEntry, fullyDone: () => void) {
    const mode =
      typeof entry.mode === 'number'
        ? entry.mode & 0o7777
        : this.dmode
    this[MKDIR](String(entry.absolute), mode, er => {
      if (er) {
        this[ONERROR](er, entry)
        fullyDone()
        return
      }

      let actions = 1
      const done = () => {
        if (--actions === 0) {
          fullyDone()
          this[UNPEND]()
          entry.resume()
        }
      }

      if (entry.mtime && !this.noMtime) {
        actions++
        fs.utimes(
          String(entry.absolute),
          entry.atime || new Date(),
          entry.mtime,
          done,
        )
      }

      if (this[DOCHOWN](entry)) {
        actions++
        fs.chown(
          String(entry.absolute),
          Number(this[UID](entry)),
          Number(this[GID](entry)),
          done,
        )
      }

      done()
    })
  }

  [UNSUPPORTED](entry: ReadEntry) {
    entry.unsupported = true
    this.warn(
      'TAR_ENTRY_UNSUPPORTED',
      `unsupported entry type: ${entry.type}`,
      { entry },
    )
    entry.resume()
  }

  [SYMLINK](entry: ReadEntry, done: () => void) {
    this[LINK](entry, String(entry.linkpath), 'symlink', done)
  }

  [HARDLINK](entry: ReadEntry, done: () => void) {
    const linkpath = normalizeWindowsPath(
      path.resolve(this.cwd, String(entry.linkpath)),
    )
    this[LINK](entry, linkpath, 'link', done)
  }

  [PEND]() {
    this[PENDING]++
  }

  [UNPEND]() {
    this[PENDING]--
    this[MAYBECLOSE]()
  }

  [SKIP](entry: ReadEntry) {
    this[UNPEND]()
    entry.resume()
  }

  // Check if we can reuse an existing filesystem entry safely and
  // overwrite it, rather than unlinking and recreating
  // Windows doesn't report a useful nlink, so we just never reuse entries
  [ISREUSABLE](entry: ReadEntry, st: Stats) {
    return (
      entry.type === 'File' &&
      !this.unlink &&
      st.isFile() &&
      st.nlink <= 1 &&
      !isWindows
    )
  }

  // check if a thing is there, and if so, try to clobber it
  [CHECKFS](entry: ReadEntry) {
    this[PEND]()
    const paths = [entry.path]
    if (entry.linkpath) {
      paths.push(entry.linkpath)
    }
    this.reservations.reserve(paths, done =>
      this[CHECKFS2](entry, done),
    )
  }

  [PRUNECACHE](entry: ReadEntry) {
    // if we are not creating a directory, and the path is in the dirCache,
    // then that means we are about to delete the directory we created
    // previously, and it is no longer going to be a directory, and neither
    // is any of its children.
    // If a symbolic link is encountered, all bets are off.  There is no
    // reasonable way to sanitize the cache in such a way we will be able to
    // avoid having filesystem collisions.  If this happens with a non-symlink
    // entry, it'll just fail to unpack, but a symlink to a directory, using an
    // 8.3 shortname or certain unicode attacks, can evade detection and lead
    // to arbitrary writes to anywhere on the system.
    if (entry.type === 'SymbolicLink') {
      dropCache(this.dirCache)
    } else if (entry.type !== 'Directory') {
      pruneCache(this.dirCache, String(entry.absolute))
    }
  }

  [CHECKFS2](entry: ReadEntry, fullyDone: (er?: Error) => void) {
    this[PRUNECACHE](entry)

    const done = (er?: Error) => {
      this[PRUNECACHE](entry)
      fullyDone(er)
    }

    const checkCwd = () => {
      this[MKDIR](this.cwd, this.dmode, er => {
        if (er) {
          this[ONERROR](er, entry)
          done()
          return
        }
        this[CHECKED_CWD] = true
        start()
      })
    }

    const start = () => {
      if (entry.absolute !== this.cwd) {
        const parent = normalizeWindowsPath(
          path.dirname(String(entry.absolute)),
        )
        if (parent !== this.cwd) {
          return this[MKDIR](parent, this.dmode, er => {
            if (er) {
              this[ONERROR](er, entry)
              done()
              return
            }
            afterMakeParent()
          })
        }
      }
      afterMakeParent()
    }

    const afterMakeParent = () => {
      fs.lstat(String(entry.absolute), (lstatEr, st) => {
        if (
          st &&
          (this.keep ||
            /* c8 ignore next */
            (this.newer && st.mtime > (entry.mtime ?? st.mtime)))
        ) {
          this[SKIP](entry)
          done()
          return
        }
        if (lstatEr || this[ISREUSABLE](entry, st)) {
          return this[MAKEFS](null, entry, done)
        }

        if (st.isDirectory()) {
          if (entry.type === 'Directory') {
            const needChmod =
              !this.noChmod &&
              entry.mode &&
              (st.mode & 0o7777) !== entry.mode
            const afterChmod = (er?: Error | null | undefined) =>
              this[MAKEFS](er ?? null, entry, done)
            if (!needChmod) {
              return afterChmod()
            }
            return fs.chmod(
              String(entry.absolute),
              Number(entry.mode),
              afterChmod,
            )
          }
          // Not a dir entry, have to remove it.
          // NB: the only way to end up with an entry that is the cwd
          // itself, in such a way that == does not detect, is a
          // tricky windows absolute path with UNC or 8.3 parts (and
          // preservePaths:true, or else it will have been stripped).
          // In that case, the user has opted out of path protections
          // explicitly, so if they blow away the cwd, c'est la vie.
          if (entry.absolute !== this.cwd) {
            return fs.rmdir(
              String(entry.absolute),
              (er?: null | Error) =>
                this[MAKEFS](er ?? null, entry, done),
            )
          }
        }

        // not a dir, and not reusable
        // don't remove if the cwd, we want that error
        if (entry.absolute === this.cwd) {
          return this[MAKEFS](null, entry, done)
        }

        unlinkFile(String(entry.absolute), er =>
          this[MAKEFS](er ?? null, entry, done),
        )
      })
    }

    if (this[CHECKED_CWD]) {
      start()
    } else {
      checkCwd()
    }
  }

  [MAKEFS](
    er: null | undefined | Error,
    entry: ReadEntry,
    done: () => void,
  ) {
    if (er) {
      this[ONERROR](er, entry)
      done()
      return
    }

    switch (entry.type) {
      case 'File':
      case 'OldFile':
      case 'ContiguousFile':
        return this[FILE](entry, done)

      case 'Link':
        return this[HARDLINK](entry, done)

      case 'SymbolicLink':
        return this[SYMLINK](entry, done)

      case 'Directory':
      case 'GNUDumpDir':
        return this[DIRECTORY](entry, done)
    }
  }

  [LINK](
    entry: ReadEntry,
    linkpath: string,
    link: 'link' | 'symlink',
    done: () => void,
  ) {
    // XXX: get the type ('symlink' or 'junction') for windows
    fs[link](linkpath, String(entry.absolute), er => {
      if (er) {
        this[ONERROR](er, entry)
      } else {
        this[UNPEND]()
        entry.resume()
      }
      done()
    })
  }
}

const callSync = (fn: () => any) => {
  try {
    return [null, fn()]
  } catch (er) {
    return [er, null]
  }
}

export class UnpackSync extends Unpack {
  [MAKEFS](er: null | Error | undefined, entry: ReadEntry) {
    return super[MAKEFS](er, entry, () => {})
  }

  [CHECKFS](entry: ReadEntry) {
    this[PRUNECACHE](entry)

    if (!this[CHECKED_CWD]) {
      const er = this[MKDIR](this.cwd, this.dmode)
      if (er) {
        return this[ONERROR](er as Error, entry)
      }
      this[CHECKED_CWD] = true
    }

    // don't bother to make the parent if the current entry is the cwd,
    // we've already checked it.
    if (entry.absolute !== this.cwd) {
      const parent = normalizeWindowsPath(
        path.dirname(String(entry.absolute)),
      )
      if (parent !== this.cwd) {
        const mkParent = this[MKDIR](parent, this.dmode)
        if (mkParent) {
          return this[ONERROR](mkParent as Error, entry)
        }
      }
    }

    const [lstatEr, st] = callSync(() =>
      fs.lstatSync(String(entry.absolute)),
    )
    if (
      st &&
      (this.keep ||
        /* c8 ignore next */
        (this.newer && st.mtime > (entry.mtime ?? st.mtime)))
    ) {
      return this[SKIP](entry)
    }

    if (lstatEr || this[ISREUSABLE](entry, st)) {
      return this[MAKEFS](null, entry)
    }

    if (st.isDirectory()) {
      if (entry.type === 'Directory') {
        const needChmod =
          !this.noChmod &&
          entry.mode &&
          (st.mode & 0o7777) !== entry.mode
        const [er] = needChmod
          ? callSync(() => {
              fs.chmodSync(String(entry.absolute), Number(entry.mode))
            })
          : []
        return this[MAKEFS](er, entry)
      }
      // not a dir entry, have to remove it
      const [er] = callSync(() =>
        fs.rmdirSync(String(entry.absolute)),
      )
      this[MAKEFS](er, entry)
    }

    // not a dir, and not reusable.
    // don't remove if it's the cwd, since we want that error.
    const [er] =
      entry.absolute === this.cwd
        ? []
        : callSync(() => unlinkFileSync(String(entry.absolute)))
    this[MAKEFS](er, entry)
  }

  [FILE](entry: ReadEntry, done: () => void) {
    const mode =
      typeof entry.mode === 'number'
        ? entry.mode & 0o7777
        : this.fmode

    const oner = (er?: null | Error | undefined) => {
      let closeError
      try {
        fs.closeSync(fd)
      } catch (e) {
        closeError = e
      }
      if (er || closeError) {
        this[ONERROR]((er as Error) || closeError, entry)
      }
      done()
    }

    let fd: number
    try {
      fd = fs.openSync(
        String(entry.absolute),
        getWriteFlag(entry.size),
        mode,
      )
    } catch (er) {
      return oner(er as Error)
    }
    const tx = this.transform ? this.transform(entry) || entry : entry
    if (tx !== entry) {
      tx.on('error', (er: Error) => this[ONERROR](er, entry))
      entry.pipe(tx)
    }

    tx.on('data', (chunk: Buffer) => {
      try {
        fs.writeSync(fd, chunk, 0, chunk.length)
      } catch (er) {
        oner(er as Error)
      }
    })

    tx.on('end', () => {
      let er = null
      // try both, falling futimes back to utimes
      // if either fails, handle the first error
      if (entry.mtime && !this.noMtime) {
        const atime = entry.atime || new Date()
        const mtime = entry.mtime
        try {
          fs.futimesSync(fd, atime, mtime)
        } catch (futimeser) {
          try {
            fs.utimesSync(String(entry.absolute), atime, mtime)
          } catch (utimeser) {
            er = futimeser
          }
        }
      }

      if (this[DOCHOWN](entry)) {
        const uid = this[UID](entry)
        const gid = this[GID](entry)

        try {
          fs.fchownSync(fd, Number(uid), Number(gid))
        } catch (fchowner) {
          try {
            fs.chownSync(
              String(entry.absolute),
              Number(uid),
              Number(gid),
            )
          } catch (chowner) {
            er = er || fchowner
          }
        }
      }

      oner(er as Error)
    })
  }

  [DIRECTORY](entry: ReadEntry, done: () => void) {
    const mode =
      typeof entry.mode === 'number'
        ? entry.mode & 0o7777
        : this.dmode
    const er = this[MKDIR](String(entry.absolute), mode)
    if (er) {
      this[ONERROR](er as Error, entry)
      done()
      return
    }
    if (entry.mtime && !this.noMtime) {
      try {
        fs.utimesSync(
          String(entry.absolute),
          entry.atime || new Date(),
          entry.mtime,
        )
        /* c8 ignore next */
      } catch (er) {}
    }
    if (this[DOCHOWN](entry)) {
      try {
        fs.chownSync(
          String(entry.absolute),
          Number(this[UID](entry)),
          Number(this[GID](entry)),
        )
      } catch (er) {}
    }
    done()
    entry.resume()
  }

  [MKDIR](dir: string, mode: number) {
    try {
      return mkdirSync(normalizeWindowsPath(dir), {
        uid: this.uid,
        gid: this.gid,
        processUid: this.processUid,
        processGid: this.processGid,
        umask: this.processUmask,
        preserve: this.preservePaths,
        unlink: this.unlink,
        cache: this.dirCache,
        cwd: this.cwd,
        mode: mode,
        noChmod: this.noChmod,
      })
    } catch (er) {
      return er
    }
  }

  [LINK](
    entry: ReadEntry,
    linkpath: string,
    link: 'link' | 'symlink',
    done: () => void,
  ) {
    const ls: `${typeof link}Sync` = `${link}Sync`
    try {
      fs[ls](linkpath, String(entry.absolute))
      done()
      entry.resume()
    } catch (er) {
      return this[ONERROR](er as Error, entry)
    }
  }
}
