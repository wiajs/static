# @wiajs/static
Plugin for [elysia](https://github.com/saltyaom/elysia) for serving static folder.

## Installation
```bash
bun add @wiajs/static
```

## 使用说明

默认（推荐）：动态通配符，生产环境也支持增/改/新目录的即时生效：

```js
app.use(staticPlugin({
  assets: ['public', 'assets'], // 支持数组
  prefix: '/',                  // 根路径服务
  preCompressed: true,          // 若你的构建产出 .br/.gz
  redirect: true,               // 目录无斜杠时 301 补齐
  headers: { 'X-Powered-By': 'elysia-static' }
}))
```

预注册（小目录、高性能）：

```js
app.use(staticPlugin({
  assets: 'public',
  prefix: '/',
  alwaysStatic: true,           // 预注册
  staticLimit: 2000,            // 若超限会自动回退为动态
  extension: true,
  indexHTML: true
}))
```


## Example
```typescript
import { Elysia } from 'elysia'
import { staticPlugin } from '@wiajs/static'

const app = new Elysia()
    .use(staticPlugin())
    .listen(8080)
```

## Config
Below is an available config for a static plugin.

### assets
@default "public"

Asset path to expose as a public path

### prefix
@default '/public'

Path prefix to create a virtual mount path for the static directory

### staticLimit
@defualt 1024

If total files exceed this number, the file will be handled via wildcard instead of the static route to reduce memory usage

### alwaysStatic
@default boolean

If set to true, the file will always use a static path instead
