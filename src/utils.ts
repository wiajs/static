import type {BunFile} from 'bun'

let fs: typeof import('fs/promises')
let path: typeof import('path')

export const isBun = typeof Bun !== 'undefined' && !!Bun.file

export function getBuiltinModule() {
  if (!fs) fs = process.getBuiltinModule('fs/promises')
  if (!fs) {
    console.warn('@elysiajs/static require fs/promises to be available.')
    return
  }

  if (!path) path = process.getBuiltinModule('path')
  if (!path) {
    console.warn('@elysiajs/static require path to be available.')
    return
  }

  return [fs, path] as const
}

export async function listHTMLFiles(dir: string) {
  if (!fs) getBuiltinModule()

  if (isBun) {
    const glob = new Bun.Glob('**/*.html')
    const files = []

    for await (const file of glob.scan(dir)) files.push(path.join(dir, file))

    return files
  }

  return []
}

export async function listFiles(dir: string): Promise<string[]> {
  if (!fs) getBuiltinModule()

  if (isBun) {
    const glob = new Bun.Glob('**/*')
    const files = []

    for await (const file of glob.scan(dir)) files.push(path.join(dir, file))

    return files
  }

  const files = await fs.readdir(dir).catch(() => [])

  const all = await Promise.all(
    files.map(async name => {
      const file = dir + path.sep + name
      const stats = await fs.stat(file).catch(() => null)
      if (!stats) return []

      return stats.isDirectory() ? await listFiles(file) : [path.resolve(dir, file)]
    })
  )

  return all.flat()
}

export function fileExists(path: string) {
  if (!fs) getBuiltinModule()

  return fs.stat(path).then(
    () => true,
    () => false
  )
}

export function isCached(headers: Record<string, string | undefined>, etag: string, filePath: string) {
  if (headers['cache-control'] && /no-cache|no-store/.test(headers['cache-control'])) return false

  if ('if-none-match' in headers) {
    const ifNoneMatch = headers['if-none-match']

    if (ifNoneMatch === '*') return true
    if (ifNoneMatch === null) return false
    if (typeof etag !== 'string') return false

    const isMatching = ifNoneMatch === etag

    if (isMatching) return true

    return false
  }

  if (headers['if-modified-since']) {
    const ifModifiedSince = headers['if-modified-since']

    try {
      return fs.stat(filePath).then(stat => {
        if (stat.mtime !== undefined && stat.mtime.getTime() <= Date.parse(ifModifiedSince)) return true
      })
    } catch {}
  }

  return false
}

let Crypto: typeof import('crypto')

export function getFile(path: string) {
  if (isBun) return Bun.file(path)

  if (!fs) getBuiltinModule()
  return fs.readFile(path)
}

// Remove generic Buffer type and cast to any for update
export async function generateETag(file: BunFile | Buffer) {
  if (isBun) return new Bun.CryptoHasher('md5').update(await (file as BunFile).arrayBuffer()).digest('base64')

  if (!Crypto) Crypto = process.getBuiltinModule('crypto')
  if (!Crypto) return void console.warn('[@elysiajs/static] crypto is required to generate etag.')

  return Crypto.createHash('md5')
        .update(file as any) 
    .digest('base64')
}

export const isNotEmpty = (obj?: Object) => {
  if (!obj) return false

  for (const _ in obj) return true

  return false
}
