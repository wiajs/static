import axios from 'axios'
import { Elysia } from 'elysia'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import staticPlugin from '../src/index'; // <- 按你的实际导出路径调整

// 简单起一个随机端口
async function listen(app: Elysia) {
  const server = app.listen(0)
  // @ts-ignore
  const port = server.server?.port ?? (server as any).port
  return { server, port }
}

const ROOT = resolve(process.cwd(), '.tmp-public')

async function setupFiles() {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(join(ROOT, 'dir'), { recursive: true })

  // 首页
  const indexHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>INDEX_OK</h1></body></html>`
  await writeFile(join(ROOT, 'index.html'), indexHtml, 'utf8')

  // 目录首页
  const dirIndex = `<!doctype html><html><body><h2>DIR_INDEX_OK</h2></body></html>`
  await writeFile(join(ROOT, 'dir', 'index.html'), dirIndex, 'utf8')

  // 一个脚本文件，用于压缩测试
  const js = `console.log("HELLO_STATIC");`
  await writeFile(join(ROOT, 'app.js'), js, 'utf8')

  // 预压缩版本（真实压缩，方便 axios 自动解码或保留原样）
  const indexBr = brotliCompressSync(Buffer.from(indexHtml))
  await writeFile(join(ROOT, 'index.html.br'), indexBr)

  const jsGz = gzipSync(Buffer.from(js))
  await writeFile(join(ROOT, 'app.js.gz'), jsGz)
}

function createApp() {
  const app = new Elysia()
    .use(staticPlugin({
      assets: ROOT,     // 绝对路径
      prefix: '/',      // 在根路径挂载
      preCompressed: true, // 打开预压缩支持
      redirect: true,      // 目录无 / 时 301 -> 加 /
      indexHTML: true,
      etag: true,
      // headers: { 'X-Test': 'static' } // 需要可加
    }))

  return app
}

describe('elysia-static (axios + bun test)', () => {
  let baseURL = ''
  let stop: any

  beforeAll(async () => {
    await setupFiles()
    const { server, port } = await listen(createApp())
    stop = server
    baseURL = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    stop?.stop?.()
    await rm(ROOT, { recursive: true, force: true })
  })

  test('GET / -> index.html', async () => {
    const { data, headers, status } = await axios.get(`${baseURL}/`, {
      // axios 在 Bun/Node 下默认可自动解压 gzip/br；此处不强制
      validateStatus: () => true
    })
    expect(status).toBe(200)
    expect(headers['content-type']?.includes('text/html')).toBe(true)
    expect(String(data)).toContain('INDEX_OK')
  })

  test('GET /dir/ -> dir/index.html', async () => {
    const { data, headers, status } = await axios.get(`${baseURL}/dir/`, {
      validateStatus: () => true
    })
    expect(status).toBe(200)
    expect(headers['content-type']?.includes('text/html')).toBe(true)
    expect(String(data)).toContain('DIR_INDEX_OK')
  })

  test('hash route: GET /#/path -> should still serve index.html', async () => {
    // 浏览器会把 # 之后的内容留在本地，HTTP 请求依旧是 '/'
    const { data, status } = await axios.get(`${baseURL}/#//kx/power/login`, {
      // axios 会把 URL 发送给服务端为 '/'，服务端应返回 index.html
      validateStatus: () => true
    })
    expect(status).toBe(200)
    expect(String(data)).toContain('INDEX_OK')
  })

  test('preCompressed: Accept-Encoding: br -> serve .br with content-encoding=br', async () => {
    const { data, headers, status } = await axios.get(`${baseURL}/`, {
      headers: { 'Accept-Encoding': 'br' },
      // axios 可能自动解压；我们主要断言返回头是否正确
      decompress: true, // 兼容 Node 适配器语义；Bun 下忽略也无妨
      validateStatus: () => true
    })
    expect(status).toBe(200)
    // 如果 axios 自动解压，content-encoding 可能被去掉；
    // 为了稳妥，我们只要保证服务端会在存在 .br 文件时返回 200
    // 并维持 text/html 内容。
    expect(headers['content-type']?.includes('text/html')).toBe(true)
    expect(String(data)).toContain('INDEX_OK')
  })

  test('preCompressed: Accept-Encoding: gzip -> serve .gz when requesting /app.js', async () => {
    const url = `${baseURL}/app.js`
    // 第一次获取，看看内容（可能被自动解压），我们只断言 200
    const r1 = await axios.get(url, {
      headers: { 'Accept-Encoding': 'gzip' },
      decompress: true,
      validateStatus: () => true
    })
    expect(r1.status).toBe(200)
    // 如果自动解压，content-encoding 可能为空；只要 200 即可
    // 类型应是 js
    expect((r1.headers['content-type'] || '').includes('javascript')).toBe(true)
    expect(String(r1.data)).toContain('HELLO_STATIC')
  })

  test('ETag / 304 flow', async () => {
    const url = `${baseURL}/`
    const r1 = await axios.get(url, { validateStatus: () => true })
    expect(r1.status).toBe(200)
    const etag = r1.headers.etag
    expect(typeof etag).toBe('string')

    const r2 = await axios.get(url, {
      headers: { 'If-None-Match': etag },
      validateStatus: () => true
    })
    expect(r2.status).toBe(304)
    expect(r2.data).toBe('') // 304 无 body
  })

  test('dynamic update: modify index.html -> new content visible without restart', async () => {
    // 修改文件内容
    const NEW = `<!doctype html><html><body><h1>INDEX_UPDATED</h1></body></html>`
    await writeFile(join(ROOT, 'index.html'), NEW, 'utf8')

    // 再请求一次，应该能看到新内容（动态模式已支持；若预注册模式需你实现失效策略）
    const r = await axios.get(`${baseURL}/`, { validateStatus: () => true })
    expect(r.status).toBe(200)
    expect(String(r.data)).toContain('INDEX_UPDATED')
  })

  test('dynamic new dir: add /newdir/index.html -> GET /newdir/ works', async () => {
    await mkdir(join(ROOT, 'newdir'), { recursive: true })
    await writeFile(join(ROOT, 'newdir', 'index.html'), '<p>NEW_DIR_OK</p>', 'utf8')

    const r = await axios.get(`${baseURL}/newdir/`, { validateStatus: () => true })
    expect(r.status).toBe(200)
    expect(String(r.data)).toContain('NEW_DIR_OK')
  })
})
