import path from 'path'
import fs from 'fs-extra'
import LRUCache from 'lru-cache'
import { Context } from 'koa'
import { Readable } from 'stream'
import { seenUrls } from '../server/serverPluginServeStatic'

const getETag = require('etag')

interface CacheEntry {
  lastModified: number
  etag: string
  content: string
}

const moduleReadCache = new LRUCache<string, CacheEntry>({
  max: 10000
})

/**
 * Read a file with in-memory cache.
 * Also sets appropriate headers and body on the Koa context.
 */
export async function cachedRead(
  ctx: Context | null,
  file: string
): Promise<string> {
  const lastModified = fs.statSync(file).mtimeMs
  const cached = moduleReadCache.get(file)
  if (ctx) {
    ctx.set('Cache-Control', 'no-cache')
    ctx.type = path.extname(file) || 'js'
  }
  if (cached && cached.lastModified === lastModified) {
    if (ctx) {
      ctx.etag = cached.etag
      ctx.lastModified = new Date(cached.lastModified)
      if (
        ctx.__serviceWorker !== true &&
        ctx.get('If-None-Match') === ctx.etag &&
        seenUrls.has(ctx.url)
      ) {
        ctx.status = 304
      }
      seenUrls.add(ctx.url)
      ctx.body = cached.content
    }
    return cached.content
  }
  const content = await fs.readFile(file, 'utf-8')
  const etag = getETag(content)
  moduleReadCache.set(file, {
    content,
    etag,
    lastModified
  })
  if (ctx) {
    ctx.etag = etag
    ctx.lastModified = new Date(lastModified)
    ctx.body = content
    ctx.status = 200
  }
  return content
}

/**
 * Read already set body on a Koa context and normalize it into a string.
 * Useful in post-processing middlewares.
 */
export async function readBody(
  stream: Readable | Buffer | string | null
): Promise<string | null> {
  if (stream instanceof Readable) {
    return new Promise((resolve, reject) => {
      let res = ''
      stream
        .on('data', (chunk) => (res += chunk))
        .on('error', reject)
        .on('end', () => {
          resolve(res)
        })
    })
  } else {
    return !stream || typeof stream === 'string' ? stream : stream.toString()
  }
}

export function lookupFile(
  dir: string,
  formats: string[],
  pathOnly = false
): string | undefined {
  for (const format of formats) {
    const fullPath = path.join(dir, format)
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return pathOnly ? fullPath : fs.readFileSync(fullPath, 'utf-8')
    }
  }
  const parentDir = path.dirname(dir)
  if (parentDir !== dir) {
    return lookupFile(parentDir, formats, pathOnly)
  }
}
