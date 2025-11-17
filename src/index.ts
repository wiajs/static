import {Elysia, NotFoundError} from 'elysia'
import fastDecodeURI from 'fast-decode-uri-component'
import type {StaticOptions} from './types'
import {fileExists, generateETag, getBuiltinModule, getFile, isBun, isCached, listFiles} from './utils'

// -------- types --------
type Encoding = 'br' | 'gzip' | undefined
interface CacheEntry {
  body: any // BunFile | Buffer
  etag?: string
  mtimeMs?: number // dev 模式用于热更新校验
  size: number
  hits: number
  lastAccess: number
  prewarmed: boolean
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
  prewarmMaxFiles: 300,
  cacheMaxEntries: process.env.NODE_ENV === 'production' ? 1000 : 400,
  cacheOvershoot: 200,
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
  const ext = p.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8'
    case 'css':
      return 'text/css; charset=utf-8'
    case 'js':
    case 'mjs':
      return 'application/javascript; charset=utf-8'
    case 'json':
      return 'application/json; charset=utf-8'
    case 'svg':
      return 'image/svg+xml'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'ico':
      return 'image/x-icon'
    case 'woff':
      return 'font/woff'
    case 'woff2':
      return 'font/woff2'
    default:
      return undefined
  }
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
    cacheMaxEntries = DEFAULTS.cacheMaxEntries,
    cacheOvershoot = DEFAULTS.cacheOvershoot,
  } = opts

  if (typeof process === 'undefined' || typeof (process as any).getBuiltinModule === 'undefined') {
    if (!silent) console.warn('[@elysiajs/static] require process.getBuiltinModule. Disabled.')
    return new Elysia()
  }

  const builtin = getBuiltinModule()
  if (!builtin) return new Elysia()
  const [fs] = builtin

  const roots = assetsToRoots(assets)
  const _prefix = normalizePrefix(String(prefix))
  const ignore = shouldIgnoreFactory(ignorePatterns)
  const devMode = !prewarmEnable

  const app = new Elysia({name: 'static', seed: _prefix})

  // ---- cache container ----
  const cache = new Map<string, CacheEntry>() // key: fullPath(.br/.gz 可带编码后缀)

  function touch(entry: CacheEntry) {
    entry.hits += 1
    entry.lastAccess = Date.now()
  }

  function putCache(key: string, entry: CacheEntry) {
    cache.set(key, entry)
    maybeCleanup()
  }

  function maybeCleanup() {
    const limit = cacheMaxEntries
    const overshoot = cacheOvershoot
    if (cache.size <= limit + overshoot) return

    const arr = Array.from(cache.entries())
    // hits 升序 + lastAccess 升序（命中少且最久未访问优先被清）
    arr.sort((a, b) => {
      const ea = a[1],
        eb = b[1]
      if (ea.hits !== eb.hits) return ea.hits - eb.hits
      return ea.lastAccess - eb.lastAccess
    })
    const toRemove = arr.length - limit
    for (let i = 0; i < toRemove; i++) cache.delete(arr[i][0])
  }

  // ---- production prewarm（仅预热前 N 个文件；不热更）----
  if (prewarmEnable) {
    let loaded = 0
    for (const root of roots) {
      const files = await listFiles(root).catch(() => [])
      for (const fileAbs of files) {
        if (loaded >= prewarmMaxFiles) break
        if (!fileAbs || ignore(fileAbs)) continue
        // 不对目录做预热，这里 files 已经是平铺文件集合
        const body = isBun ? getFile(fileAbs) : await getFile(fileAbs)
        const st = await statSafe(fs, fileAbs)
        const et = useETag ? await generateETag(body as any) : undefined
        putCache(cacheKey(fileAbs), {
          body,
          etag: et,
          mtimeMs: st?.mtimeMs,
          size: st?.size ?? 0,
          hits: 0,
          lastAccess: Date.now(),
          prewarmed: true,
        })
        loaded++
      }
      if (loaded >= prewarmMaxFiles) break
    }
    if (!silent) console.log(`[@elysiajs/static] prewarmed ${Math.min(loaded, prewarmMaxFiles)} file(s)`)
  }

  // ---- register GET (and optional HEAD) wildcard routes ----
  app.get(`${_prefix}*`, async ctx => {
    return serveWildcard(ctx)
  })

  if (enableHEAD) {
    app.head(`${_prefix}*`, async ctx => {
      const res = await serveWildcard(ctx)
      // HEAD：只返回 headers/status
      return new Response(null, {status: res.status, headers: res.headers})
    })
  }

  return app

  // ---- wildcard handler ----
  async function serveWildcard(ctx: any): Promise<Response> {
    const url = new URL(ctx.request.url)
    const reqHeaders = headersToObject(ctx.request.headers)
    const encoding: Encoding = preCompressed ? negotiateEncoding(reqHeaders['accept-encoding']) : undefined
    const star = (ctx.params as any)['*'] || ''
    let reqPath = `/${star}`

    if (decodeURI) reqPath = fastDecodeURI(reqPath) ?? reqPath

    // 支持多个静态目录
    for (const root of roots) {
      const full = requirePath(root, reqPath)
      const st = await statSafe(fs, full)

      // 目录处理
      if (st?.isDirectory() && indexHTML) {
        // 目录自动追加 /index.html
        for (const name of indexFiles) {
          const idxReq = reqPath.endsWith('/') ? reqPath + name : reqPath + '/' + name
          const idxFull = requirePath(root, idxReq)
          const r = await tryServe(idxFull, idxReq, reqHeaders, encoding, {
            devMode,
            initialHeaders,
            maxAge,
            directive,
            useETag,
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
    }: {
      devMode: boolean
      initialHeaders?: Record<string, string>
      maxAge: number
      directive: string
      useETag: boolean
    }
  ) {
    const fsmod = (await getBuiltinModule())![0]

    // 预压缩优先：.br/.gz
    const encFull = enc ? `${fullPath}.${enc === 'br' ? 'br' : 'gz'}` : undefined

    // 1) 缓存命中：预压缩
    if (encFull) {
      const ck = cacheKey(encFull, enc)
      const ce = cache.get(ck)
      if (ce) {
        if (devMode) {
          const st = await statSafe(fsmod, encFull)
          if (!st) {
            cache.delete(ck)
          } else if (ce.mtimeMs !== st.mtimeMs) {
            const body = isBun ? getFile(encFull) : await getFile(encFull)
            const et = useETag ? await generateETag(body as any) : undefined
            ce.body = body
            ce.etag = et
            ce.mtimeMs = st.mtimeMs
            ce.size = st.size
          }
        }
        touch(ce)
        return buildResponse(ce, urlPath, initialHeaders, {maxAge, directive}, enc)
      }
    }

    // 2) 缓存命中：非预压缩
    {
      const ck = cacheKey(fullPath)
      const ce = cache.get(ck)
      if (ce) {
        if (devMode) {
          const st = await statSafe(fsmod, fullPath)
          if (!st) {
            cache.delete(ck)
          } else if (ce.mtimeMs !== st.mtimeMs) {
            const body = isBun ? getFile(fullPath) : await getFile(fullPath)
            const et = useETag ? await generateETag(body as any) : undefined
            ce.body = body
            ce.etag = et
            ce.mtimeMs = st.mtimeMs
            ce.size = st.size
          }
        }
        // ETag / 304
        if (useETag && ce.etag && (await isCached(reqHeaders, ce.etag, fullPath))) {
          const h = new Headers(initialHeaders ?? {})
          return new Response(null, {status: 304, headers: h})
        }
        touch(ce)
        return buildResponse(ce, urlPath, initialHeaders, {maxAge, directive})
      }
    }

    // 3) 缓存未命中：从磁盘读取并加入缓存（生产模式=首次访问动态加缓存；开发模式=首次读入并记录 mtime）
    if (encFull && (await fileExists(encFull))) {
      const body = isBun ? getFile(encFull) : await getFile(encFull)
      const st = await statSafe(fsmod, encFull)
      const et = useETag ? await generateETag(body as any) : undefined
      const entry: CacheEntry = {
        body,
        etag: et,
        mtimeMs: st?.mtimeMs,
        size: st?.size ?? 0,
        hits: 0,
        lastAccess: Date.now(),
        prewarmed: false,
      }
      putCache(cacheKey(encFull, enc), entry)
      return buildResponse(entry, urlPath, initialHeaders, {maxAge, directive}, enc)
    }

    if (await fileExists(fullPath)) {
      const body = isBun ? getFile(fullPath) : await getFile(fullPath)
      const st = await statSafe(fsmod, fullPath)
      const et = useETag ? await generateETag(body as any) : undefined

      if (useETag && et && (await isCached(reqHeaders, et, fullPath))) {
        const h = new Headers(initialHeaders ?? {})
        return new Response(null, {status: 304, headers: h})
      }

      const entry: CacheEntry = {
        body,
        etag: et,
        mtimeMs: st?.mtimeMs,
        size: st?.size ?? 0,
        hits: 0,
        lastAccess: Date.now(),
        prewarmed: false,
      }
      putCache(cacheKey(fullPath), entry)
      return buildResponse(entry, urlPath, initialHeaders, {maxAge, directive})
    }

    return null
  }

  function buildResponse(
    entry: CacheEntry,
    urlPath: string,
    initialHeaders: Record<string, string> | undefined,
    {maxAge, directive}: {maxAge: number; directive: string},
    enc?: Encoding
  ) {
    const h = new Headers({
      'Cache-Control': maxAge ? `${directive}, max-age=${maxAge}` : directive,
      ...(initialHeaders ?? {}),
    })
    if (entry.etag) h.set('ETag', entry.etag)
    const ct = guessContentType(urlPath)
    if (ct) h.set('Content-Type', ct)
    if (enc) h.set('Content-Encoding', enc)
    touch(entry)
    return new Response(entry.body as any, {headers: h})
  }
}

export default staticPlugin
