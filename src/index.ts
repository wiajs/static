import {Elysia, NotFoundError} from 'elysia'
import fastDecodeURI from 'fast-decode-uri-component'
import {LRUCache} from 'lru-cache'
import {contentType, lookup} from 'mime-types'
import type {StaticOptions} from './types'
import {fileExists, generateETag, getBuiltinModule, getFile, isBun, isCached, listFiles} from './utils'

// -------- types --------
type Encoding = 'br' | 'gzip' | undefined
interface CacheEntry {
  body?: any // BunFile | Buffer (Small files only for Node)
  filePath: string // Absolute path for streaming
  etag?: string
  mtimeMs?: number // dev 模式用于热更新校验
  size: number
}

// -------- defaults --------
const DEFAULTS = {
  prefix: '/' as const,
  indexHTML: true,
  indexFiles: ['index.html'],
  etag: true,
  maxAge: 86400,
  directive: 'public',
  redirect: true,
  preCompressed: false,
  enableHEAD: true,
  ignorePatterns: ['.DS_Store', '.git', '.env'],
  prewarmEnable: process.env.NODE_ENV === 'production',
  prewarmMaxFiles: 300, // 依然保留作为防止遍历过深的保险
  cacheMaxSize: 30, // 30 MB
  cacheOvershootSize: 50, // 50 MB
}

// -------- helpers --------
function normalizePrefix(p: string) {
  if (!p.startsWith('/')) p = '/' + p
  if (!p.endsWith('/')) p = p + '/'
  return p
}

function negotiateEncoding(ae: string | null | undefined): Encoding {
  if (!ae) return undefined
  const s = ae.toLowerCase()
  if (s.includes('br')) return 'br'
  if (s.includes('gzip')) return 'gzip'
  return undefined
}

function guessContentType(p: string) {
  const mime = lookup(p)
  if (!mime) return 'application/octet-stream'
  return contentType(mime) || mime
}

function assetsToRoots(assets: string | string[]) {
  const list = Array.isArray(assets) ? assets : [assets]
  const [, path] = getBuiltinModule()!
  return list.map(p => (path.isAbsolute(p) ? p : path.resolve(p)))
}

function requirePath(root: string, rel: string) {
  const [, path] = getBuiltinModule()!
  // relUrlPath 使用 posix 分隔，统一替换为系统分隔
  const clean = rel.replace(/^\//, '')
  return path.join(root, clean)
}

async function statSafe(fs: any, p: string) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

function shouldIgnoreFactory(ignore: (string | RegExp)[]) {
  if (!ignore?.length) return () => false
  return (file: string) => ignore.find(pat => (typeof pat === 'string' ? file.includes(pat) : pat.test(file)))
}

function headersToObject(h: Headers) {
  const o: Record<string, string> = {}
  h.forEach((v, k) => (o[k.toLowerCase()] = v))
  return o
}

function cacheKey(p: string, enc?: Encoding) {
  return enc ? `${p}::${enc}` : p
}

// -------- main plugin --------
export async function staticPlugin<const Prefix extends string = '/'>(
  opts: StaticOptions<Prefix> = {}
): Promise<Elysia> {
  const {
    prefix = DEFAULTS.prefix as any,
    assets = 'public',
    ignorePatterns = DEFAULTS.ignorePatterns,
    headers: initialHeaders,
    maxAge = DEFAULTS.maxAge,
    directive = DEFAULTS.directive,
    etag: useETag = DEFAULTS.etag,
    indexHTML = DEFAULTS.indexHTML,
    indexFiles = DEFAULTS.indexFiles,
    redirect = DEFAULTS.redirect,
    decodeURI,
    preCompressed = DEFAULTS.preCompressed,
    enableHEAD = DEFAULTS.enableHEAD,
    silent,
    // cache/prewarm
    prewarmEnable = DEFAULTS.prewarmEnable,
    prewarmMaxFiles = DEFAULTS.prewarmMaxFiles,
    // Cache Size Control (MB)
    cacheMaxSize = DEFAULTS.cacheMaxSize,
  } = opts

  if (typeof process === 'undefined' || typeof (process as any).getBuiltinModule === 'undefined') {
    if (!silent) console.warn('[@elysiajs/static] require process.getBuiltinModule. Disabled.')
    return new Elysia()
  }

  const builtin = getBuiltinModule()
  if (!builtin) return new Elysia()

  // [Fix] 在这里直接解构出 path，此时 TypeScript 知道 builtin 一定存在
  const [fs, path] = builtin
  const fsNative = !isBun ? (process as any).getBuiltinModule('fs') : null

  const roots = assetsToRoots(assets)
  const _prefix = normalizePrefix(String(prefix))
  const ignore = shouldIgnoreFactory(ignorePatterns)
  const devMode = !prewarmEnable

  const app = new Elysia({name: 'static', seed: _prefix})

  // ---- cache container ----
  const cache = new LRUCache<string, CacheEntry>({
    maxSize: cacheMaxSize * 1024 * 1024,
    // Estimate size: file size + overhead (approx 200 bytes)
    sizeCalculation: val => val.size + 200,
  })

  // ---- production prewarm（仅预热前 N 个文件；不热更）----
  if (prewarmEnable) {
    let loadedFiles = 0
    for (const root of roots) {
      const files = await listFiles(root).catch(() => [])
      for (const fileAbs of files) {
        if (loadedFiles >= prewarmMaxFiles) break
        if (!fileAbs || ignore(fileAbs)) continue

        const st = await statSafe(fs, fileAbs)
        if (!st) continue

        // Check size limit before reading content
        // LRUCache handles eviction, but we stop scanning if too many files
        // 1. 检查文件数量限制
        if (cache.size >= prewarmMaxFiles) break

        // [新增修复] 2. 检查缓存容量限制 (避免颠簸)
        // cache.currentSize 是当前已使用的总大小
        // cache.maxSize 是最大限制
        // st.size + 200 是新文件预估大小 (包含 overhead)
        const estimatedEntrySize = st.size + 200

        // 如果单个文件就超过了总容量，跳过（避免读取）
        if (estimatedEntrySize > cache.maxSize) continue

        // 如果加入该文件会撑爆缓存，则停止预热（不再读取后续文件）
        // 这样保留的是文件系统顺序中靠前的 N 个文件，通常是更好的策略
        if (cache.calculatedSize + estimatedEntrySize > cache.maxSize) break

        // 不对目录做预热，这里 files 已经是平铺文件集合
        const body = isBun ? getFile(fileAbs) : await getFile(fileAbs)
        const et = useETag ? await generateETag(body as any) : undefined

        cache.set(cacheKey(fileAbs), {
          body,
          filePath: fileAbs,
          etag: et,
          mtimeMs: st.mtimeMs || 0,
          size: st.size || 0,
        })
        loadedFiles++
      }
    }
    if (!silent) {
      console.log(`[@wiajsjs/static] prewarmed ${loadedFiles} file(s)`)
    }
  }

  // ---- register GET (and optional HEAD) wildcard routes ----
  app.get(`${_prefix}*`, ctx => serveWildcard(ctx, false))

  if (enableHEAD) {
    app.head(`${_prefix}*`, async ctx => {
      const res = await serveWildcard(ctx, true)
      // HEAD：只返回 headers/status
      return new Response(null, {status: res.status, headers: res.headers})
    })
  }

  return app

  // ---- wildcard handler ----
  async function serveWildcard(ctx: any, isHead: boolean): Promise<Response> {
    const url = new URL(ctx.request.url)
    const reqHeaders = headersToObject(ctx.request.headers)
    const encoding: Encoding = preCompressed ? negotiateEncoding(reqHeaders['accept-encoding']) : undefined
    const star = (ctx.params as any)['*'] || ''
    let reqPath = `/${star}`

    if (decodeURI) reqPath = fastDecodeURI(reqPath) ?? reqPath

    // 支持多个静态目录
    for (const root of roots) {
      let full: string
      try {
        full = requirePath(root, reqPath)
      } catch {
        continue
      }

      // [Security Fix #2] Prevent Path Traversal (Windows Safe)
      const rel = path.relative(root, full)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue

      // [Security Fix #1] Check ignore patterns for dynamic requests
      if (ignore(full)) continue

      const st = await statSafe(fs, full)

      // 目录处理
      if (st?.isDirectory() && indexHTML) {
        // 目录自动追加 /index.html
        for (const name of indexFiles) {
          const idxReq = reqPath.endsWith('/') ? reqPath + name : reqPath + '/' + name
          let idxFull: string
          try {
            idxFull = requirePath(root, idxReq)
          } catch {
            continue
          }

          // 对 index 文件也做同样的安全检查
          const idxRel = path.relative(root, idxFull)
          if (idxRel.startsWith('..') || path.isAbsolute(idxRel)) continue

          if (ignore(idxFull)) continue

          const r = await tryServe(idxFull, idxReq, reqHeaders, encoding, {
            devMode,
            initialHeaders,
            maxAge,
            directive,
            useETag,
            isHead,
          })
          if (r) return r
        }
        continue
      }

      // 普通文件
      const r = await tryServe(full, reqPath, reqHeaders, encoding, {
        devMode,
        initialHeaders,
        maxAge,
        directive,
        useETag,
        isHead,
      })
      if (r) return r
    }

    throw new NotFoundError()
  }

  // ---- file serve with cache strategy ----
  async function tryServe(
    fullPath: string,
    urlPath: string,
    reqHeaders: Record<string, string>,
    enc: Encoding,
    {
      devMode,
      initialHeaders,
      maxAge,
      directive,
      useETag,
      isHead,
    }: {
      devMode: boolean
      initialHeaders?: Record<string, string>
      maxAge: number | null
      directive: string
      useETag: boolean
      isHead: boolean
    }
  ) {
    const fsmod = (await getBuiltinModule())![0]

    // 预压缩优先：.br/.gz
    const encFull = enc ? `${fullPath}.${enc === 'br' ? 'br' : 'gz'}` : undefined

    // Helper: refresh cache logic
    const checkRefresh = async (ck: string, ce: CacheEntry, path: string) => {
      const st = await statSafe(fsmod, path)
      if (!st) {
        cache.delete(ck)
        return null
      } else if (ce.mtimeMs !== st.mtimeMs) {
        // Refetch
        const isLarge = st.size > 5 * 1024 * 1024 // 5MB
        let body: any
        // Only cache body for small files in Node, or always in Bun (lazy)
        if (isBun || !isLarge) {
          body = isBun ? getFile(path) : await getFile(path)
        }

        // [Fix #4] If HEAD request, skip heavy ETag generation if not cached
        // For large files in Node, use Weak ETag to avoid full read
        const et =
          useETag && !isHead
            ? !isBun && isLarge
              ? `W/"${st.size.toString(16)}-${st.mtimeMs}"`
              : await generateETag(body)
            : undefined

        ce.body = body
        ce.etag = et
        ce.mtimeMs = st.mtimeMs || 0
        ce.size = st.size || 0
      }
      return ce
    }

    // 1) Cache hit: Compressed
    if (encFull) {
      const ck = cacheKey(encFull, enc)
      let ce = cache.get(ck)
      if (ce) {
        let isValid = true // 引入有效性标记
        if (devMode) {
          const refreshed = await checkRefresh(ck, ce, encFull)
          if (!refreshed) isValid = false
          else ce = refreshed
        }
        if (isValid) {
          return buildResponse(ce!, urlPath, initialHeaders, {maxAge, directive}, reqHeaders, enc)
        }
      }
    }

    // 2) Cache hit: Standard
    {
      const ck = cacheKey(fullPath)
      let ce = cache.get(ck)
      if (ce) {
        let isValid = true // 引入有效性标记
        if (devMode) {
          const refreshed = await checkRefresh(ck, ce, fullPath)
          if (!refreshed) isValid = false
          else ce = refreshed
        }

        if (isValid) {
          // ETag / 304
          if (useETag && ce!.etag && (await isCached(reqHeaders, ce!.etag, fullPath))) {
            const h = new Headers(initialHeaders ?? {})
            return new Response(null, {status: 304, headers: h})
          }
          return buildResponse(ce!, urlPath, initialHeaders, {maxAge, directive}, reqHeaders)
        }
      }
    }

    // 3) Cache Miss: Read from disk
    // Try compressed first
    if (encFull && (await fileExists(encFull))) {
      const body = isBun ? getFile(encFull) : await getFile(encFull)
      const st = await statSafe(fsmod, encFull)
      // [Fix #4] Skip ETag for HEAD to avoid full read latency
      const et = useETag && !isHead ? await generateETag(body as any) : undefined
      const entry: CacheEntry = {
        body,
        filePath: encFull,
        etag: et,
        mtimeMs: st?.mtimeMs || 0,
        size: st?.size || 0,
      }
      cache.set(cacheKey(encFull, enc), entry)
      return buildResponse(entry, urlPath, initialHeaders, {maxAge, directive}, reqHeaders, enc)
    }

    // Try standard
    if (await fileExists(fullPath)) {
      const st = await statSafe(fsmod, fullPath)

      // Strategy: Don't cache large file bodies in Node memory
      const isLarge = (st?.size ?? 0) > 5 * 1024 * 1024 // 5MB
      let body: any
      if (isBun || !isLarge) {
        body = isBun ? getFile(fullPath) : await getFile(fullPath)
      }

      const et =
        useETag && !isHead
          ? !isBun && isLarge
            ? `W/"${st?.size.toString(16)}-${st?.mtimeMs}"`
            : await generateETag(body)
          : undefined

      if (useETag && et && (await isCached(reqHeaders, et, fullPath))) {
        const h = new Headers(initialHeaders ?? {})
        return new Response(null, {status: 304, headers: h})
      }

      const entry: CacheEntry = {
        body,
        filePath: fullPath,
        etag: et,
        mtimeMs: st?.mtimeMs || 0,
        size: st?.size || 0,
      }
      cache.set(cacheKey(fullPath), entry)
      return buildResponse(entry, urlPath, initialHeaders, {maxAge, directive}, reqHeaders)
    }

    return null
  }

  function buildResponse(
    entry: CacheEntry,
    urlPath: string,
    initialHeaders: Record<string, string> | undefined,
    {maxAge, directive}: {maxAge: number | null; directive: string},
    reqHeaders: Record<string, string>, // Needed for Range check
    enc?: Encoding
  ) {
    const h = new Headers({
      'Cache-Control': maxAge ? `${directive}, max-age=${maxAge}` : directive,
      Vary: 'Accept-Encoding', // [Logic Fix #3] 告知缓存响应内容取决于 Accept-Encoding
      'Accept-Ranges': 'bytes', // Advertise Range support
      ...(initialHeaders ?? {}),
    })
    if (entry.etag) h.set('ETag', entry.etag)
    const ct = guessContentType(urlPath)
    if (ct) h.set('Content-Type', ct)
    if (enc) h.set('Content-Encoding', enc)

    const body = entry.body

    // [Fix #5] Node.js Range Support
    // Bun.file() handles range automatically, but Buffer (Node.js) does not.
    if (!isBun && reqHeaders['range']) {
      // If no cached body (large file), or checking range on Buffer
      // We prefer streaming for Range in Node
      const range = reqHeaders['range']
      const size = entry.size
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : size - 1

      if (!isNaN(start) && !isNaN(end) && start <= end && end < size) {
        h.set('Content-Range', `bytes ${start}-${end}/${size}`)
        h.set('Content-Length', (end - start + 1).toString())

        // Stream response
        if (fsNative && fsNative.createReadStream) {
          const stream = fsNative.createReadStream(entry.filePath, {start, end})
          return new Response(stream as any, {status: 206, headers: h})
        }

        // Fallback to Buffer slice if body exists
        if (body && Buffer.isBuffer(body)) {
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: h,
          })
        }
      }
    }

    // If Node.js large file miss (no body cached), stream it full
    if (!isBun && !body && fsNative && fsNative.createReadStream) {
      const stream = fsNative.createReadStream(entry.filePath)
      return new Response(stream as any, {headers: h})
    }

    // Bun or Small file Node
    return new Response(body as any, {headers: h})
  }
}

export default staticPlugin
