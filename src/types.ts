export interface StaticOptions<Prefix extends string = '/'> {
  /**
   * 根目录，支持数组，默认 'public'
   * Asset path to expose as public path
   * @default "public"
   */
  assets?: string | string[]

  /**
   * URL 前缀，默认 '/'
   * Path prefix to create virtual mount path for the static directory
   * @default '/'
   */
  prefix?: Prefix
  indexFiles?: string[] // index 文件名，默认 ['index.html']
  preCompressed?: boolean // 优先发送 .br/.gz，默认 false
  redirect?: boolean // 目录无 / 时 301 加 /，默认 true
  enableHEAD?: boolean // 是否注册 HEAD 路由（默认 true）

  // —— 缓存与预热策略 ——
  prewarmEnable?: boolean // 生产默认 true，开发默认 false
  prewarmMaxFiles?: number // 预热扫描的最大文件数（防止扫描过多），但受 cacheMaxSize 限制
  
  /**
   * 缓存目标大小 (MB)
   * 达到清理阈值后，会将缓存清理至此大小
   * @default 30
   */
  cacheMaxSize?: number

  /**
   * 缓存清理阈值 (MB)
   * 当总缓存大小超过此值时，触发清理
   * @default 50
   */
  cacheOvershootSize?: number

  /**
   * @default 1024
   * 预注册模式最大文件数，默认 1024
   * If total files exceed this number,
   * file will be handled via wildcard instead of static route
   * to reduce memory usage
   */
  staticLimit?: number

  /**
   * @default false unless `NODE_ENV` is 'production'
   *  true=预注册（性能好，但不热更）；默认 false（动态）
   * Should file always be served statically
   */
  alwaysStatic?: boolean

  /**
   * @default [] `Array<string | RegExp>`
   * 忽略匹配
   * Array of file to ignore publication.
   * If one of the patters is matched,
   * file will not be exposed.
   */
  ignorePatterns?: Array<string | RegExp>

  /**
   * Indicate if file extension is required
   * 去除扩展名的友好路由，默认 true（仅预注册）
   * Only works if `alwaysStatic` is set to true
   *
   * @default true
   */
  extension?: boolean

  /**
   * 追加响应头（静态）
   * When url needs to be decoded
   *
   * Only works if `alwaysStatic` is set to false
   */
  /**
   * Set headers
   */
  headers?: Record<string, string>

  setHeaders?: (headers: Headers, filePath: string, stat?: any) => void // 动态钩子

  /**
   * @default true
   * 启用 ETag，默认 true
   * If set to false, browser caching will be disabled
   *
   * On Bun, if set to false, performance will be significantly improved
   * as it can be inline as a static resource
   */
  etag?: boolean

  /**
   * @default public
   * Cache-Control 指令，默认 'public'
   * directive for Cache-Control header
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#directives
   */
  directive?:
    | 'public'
    | 'private'
    | 'must-revalidate'
    | 'no-cache'
    | 'no-store'
    | 'no-transform'
    | 'proxy-revalidate'
    | 'immutable'

  /**
   * @default 86400
   * Cache-Control: max-age，默认 86400
   * Specifies the maximum amount of time in seconds, a resource will be considered fresh.
   * This freshness lifetime is calculated relative to the time of the request.
   * This setting helps control browser caching behavior.
   * A `maxAge` of 0 will prevent caching, requiring requests to validate with the server before use.
   */
  maxAge?: number | null

  /**
   * @default true
   * 目录下回退 index.html，默认 true
   * Enable serving of index.html as default / route
   */
  indexHTML?: boolean

  /**
   * decodeURI
   * 路径解码，默认 false（可用 fast-decode）
   * @default false
   */
  decodeURI?: boolean

  /**
   * silent
   * 静默日志
   * @default false
   *
   * If set to true, suppresses all logs and warnings from the static plugin
   */
  silent?: boolean
}
