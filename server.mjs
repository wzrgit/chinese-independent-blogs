import express from 'express'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const csvPath = resolve(root, 'blogs-original.csv')
const localPath = resolve(root, 'local.json')
const isDev = process.argv.includes('--dev')
const app = express()
app.use(express.json({ limit: '32kb' }))

const TYPE_VALUES = new Set(['技术', '生活', '综合', '营销', '其它'])
const LANGUAGE_VALUES = new Set(['中文', '英文', '其它'])
const PAGE_SIZE_VALUES = new Set([10, 20, 50, 100])
const DEFAULT_SETTINGS = { pageSize: 20, probeConcurrency: 12, lastGlobalProbeAt: null }
const PROBE_CONCURRENCY = 12
const ONE_MONTH = 30 * 24 * 60 * 60 * 1000
let writeQueue = Promise.resolve()
let probeJob = { state: 'idle', total: 0, completed: 0, probed: 0, skipped: 0, succeeded: 0, failed: 0 }

function parseCsv(text) {
  return text.trim().split(/\r?\n/).slice(1).map((line, index) => {
    const [introduction, address, rss, tags] = line.split(',').map((value) => value.trim())
    return {
      id: index + 1,
      introduction,
      address,
      rss,
      tags: tags ? tags.split(';').map((tag) => tag.trim()).filter(Boolean) : []
    }
  })
}

function decodeXml(value = '') {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (_match, entity) => {
      if (entity[0] === '#') {
        const hexadecimal = entity[1].toLowerCase() === 'x'
        return String.fromCodePoint(Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10))
      }
      return entities[entity] ?? `&${entity};`
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function tagValue(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
    if (match) return decodeXml(match[1])
  }
  return ''
}

function parseLatestArticle(xml, feedUrl) {
  const item = xml.match(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/i)?.[1]
  const entry = xml.match(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/i)?.[1]
  const block = item || entry
  if (!block) return null

  const title = tagValue(block, ['title']) || '未命名文章'
  let url = item ? tagValue(block, ['link', 'guid']) : ''
  if (!url && entry) {
    const linkTag = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)
    url = linkTag?.[1] || ''
  }
  try { if (url) url = new URL(url, feedUrl).href } catch { url = '' }
  const publishedAt = tagValue(block, ['pubDate', 'published', 'updated', 'dc:date']) || null
  return { title, url, publishedAt }
}

async function fetchLatestArticle(blog) {
  const feedResponse = await fetch(blog.rss, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
    headers: {
      accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*',
      'user-agent': 'ChineseIndependentBlogs/1.0 (+local feed reader)'
    }
  })
  if (!feedResponse.ok) throw new Error(`Feed 返回 HTTP ${feedResponse.status}`)
  const contentLength = Number(feedResponse.headers.get('content-length') || 0)
  if (contentLength > 5 * 1024 * 1024) throw new Error('Feed 文件过大')
  return parseLatestArticle(await feedResponse.text(), blog.rss)
}

async function probeBlog(blog) {
  const lastProbeAt = new Date().toISOString()
  if (blog.rss) {
    try {
      const latestArticle = await fetchLatestArticle(blog)
      return { lastProbeAt, accessible: true, latestArticle, status: null }
    } catch {
      return { lastProbeAt, accessible: false, status: null }
    }
  }

  try {
    let result = await fetch(blog.address, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) })
    if (result.status === 405) result = await fetch(blog.address, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) })
    const status = result.status
    const accessible = status >= 200 && status < 500
    if (result.body) await result.body.cancel()
    return { lastProbeAt, accessible, status }
  } catch {
    return { lastProbeAt, accessible: false, status: null }
  }
}

function skipProbe(site) {
  if (site?.doNotProbe) return true
  if (site?.accessible !== false || !site.lastProbeAt) return false
  return Date.now() - new Date(site.lastProbeAt).getTime() < ONE_MONTH
}

async function readData() {
  const [csv, local] = await Promise.all([
    readFile(csvPath, 'utf8'),
    readFile(localPath, 'utf8').then(JSON.parse)
  ])
  local.settings = { ...DEFAULT_SETTINGS, ...local.settings }
  return { blogs: parseCsv(csv), local }
}

function validatePatch(body) {
  const patch = {}
  if ('type' in body) {
    if (!TYPE_VALUES.has(body.type)) throw new Error('无效的网站类型')
    patch.type = body.type
  }
  if ('language' in body) {
    if (!LANGUAGE_VALUES.has(body.language)) throw new Error('无效的语言')
    patch.language = body.language
  }
  if ('rating' in body) {
    if (!Number.isInteger(body.rating) || body.rating < 0 || body.rating > 5) throw new Error('评级必须为未知或 1～5 星')
    patch.rating = body.rating
  }
  if ('accessible' in body) {
    if (body.accessible !== null && typeof body.accessible !== 'boolean') throw new Error('无效的访问状态')
    patch.accessible = body.accessible
  }
  if ('doNotProbe' in body) patch.doNotProbe = Boolean(body.doNotProbe)
  if ('blacklisted' in body) patch.blacklisted = Boolean(body.blacklisted)
  return patch
}

async function updateSite(address, patch) {
  const operation = writeQueue.then(async () => {
    const local = JSON.parse(await readFile(localPath, 'utf8'))
    if (!local.sites[address]) throw new Error('本地记录不存在')
    local.sites[address] = { ...local.sites[address], ...patch }
    local.updatedAt = new Date().toISOString()
    const tempPath = `${localPath}.tmp`
    await writeFile(tempPath, `${JSON.stringify(local, null, 2)}\n`)
    await rename(tempPath, localPath)
    return local.sites[address]
  })
  writeQueue = operation.catch(() => {})
  return operation
}

async function updateSettings(patch) {
  const operation = writeQueue.then(async () => {
    const local = JSON.parse(await readFile(localPath, 'utf8'))
    local.settings = { ...DEFAULT_SETTINGS, ...local.settings, ...patch }
    local.updatedAt = new Date().toISOString()
    const tempPath = `${localPath}.tmp`
    await writeFile(tempPath, `${JSON.stringify(local, null, 2)}\n`)
    await rename(tempPath, localPath)
    return local.settings
  })
  writeQueue = operation.catch(() => {})
  return operation
}

async function runProbeJob() {
  const { blogs, local } = await readData()
  const queue = [...blogs]
  const concurrency = Math.min(32, Math.max(1, Number(local.settings.probeConcurrency) || PROBE_CONCURRENCY))
  probeJob = {
    state: 'running',
    total: blogs.length,
    completed: 0,
    probed: 0,
    skipped: 0,
    succeeded: 0,
    failed: 0,
    concurrency,
    startedAt: new Date().toISOString(),
    finishedAt: null
  }

  async function worker() {
    while (queue.length) {
      const blog = queue.shift()
      const site = local.sites[blog.address]
      if (!site || skipProbe(site)) {
        probeJob.skipped++
        probeJob.completed++
        continue
      }

      const result = await probeBlog(blog)
      const { status: _status, ...patch } = result
      await updateSite(blog.address, patch)
      Object.assign(site, patch)
      probeJob.probed++
      probeJob.completed++
      if (patch.accessible) probeJob.succeeded++
      else probeJob.failed++
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  probeJob.finishedAt = new Date().toISOString()
  await updateSettings({
    probeConcurrency: concurrency,
    lastGlobalProbeAt: probeJob.finishedAt
  })
  probeJob.state = 'complete'
}

app.get('/api/blogs', async (_request, response, next) => {
  try {
    const { blogs, local } = await readData()
    response.json({
      updatedAt: local.updatedAt,
      settings: local.settings,
      probeJob,
      blogs: blogs.map((blog) => ({ blacklisted: false, ...blog, ...local.sites[blog.address] }))
    })
  } catch (error) { next(error) }
})

app.patch('/api/blogs/:id', async (request, response, next) => {
  try {
    const { blogs } = await readData()
    const blog = blogs.find((item) => item.id === Number(request.params.id))
    if (!blog) return response.status(404).json({ message: '未找到该博客' })
    const site = await updateSite(blog.address, validatePatch(request.body))
    response.json(site)
  } catch (error) {
    if (/无效|必须/.test(error.message)) return response.status(400).json({ message: error.message })
    next(error)
  }
})

app.get('/api/blogs/:id/latest', async (request, response) => {
  try {
    const { blogs } = await readData()
    const blog = blogs.find((item) => item.id === Number(request.params.id))
    if (!blog) return response.status(404).json({ message: '未找到该博客' })
    if (!blog.rss) return response.json({ article: null })

    const article = await fetchLatestArticle(blog)
    await updateSite(blog.address, {
      latestArticle: article,
      lastProbeAt: new Date().toISOString(),
      accessible: true
    })
    response.json({ article })
  } catch (error) {
    response.status(502).json({ message: error.message || '无法读取 Feed' })
  }
})

app.post('/api/blogs/:id/probe', async (request, response, next) => {
  try {
    const { blogs, local } = await readData()
    const blog = blogs.find((item) => item.id === Number(request.params.id))
    if (!blog) return response.status(404).json({ message: '未找到该博客' })
    if (local.sites[blog.address]?.doNotProbe) return response.status(409).json({ message: '该站点已设为不再探测' })

    const result = await probeBlog(blog)
    const { status, ...patch } = result
    const site = await updateSite(blog.address, patch)
    response.json({ ...site, status })
  } catch (error) { next(error) }
})

app.patch('/api/settings', async (request, response, next) => {
  try {
    const pageSize = Number(request.body.pageSize)
    if (!PAGE_SIZE_VALUES.has(pageSize)) return response.status(400).json({ message: '每页数量仅支持 10、20、50 或 100' })
    response.json(await updateSettings({ pageSize }))
  } catch (error) { next(error) }
})

app.get('/api/probe/status', (_request, response) => {
  response.set('Cache-Control', 'no-store')
  response.json(probeJob)
})

app.post('/api/probe/start', (_request, response) => {
  if (probeJob.state === 'starting' || probeJob.state === 'running') return response.status(409).json({ message: '探测任务正在运行', ...probeJob })
  probeJob = { state: 'starting', total: 0, completed: 0, probed: 0, skipped: 0, succeeded: 0, failed: 0 }
  runProbeJob().catch((error) => {
    console.error(error)
    probeJob.state = 'failed'
    probeJob.error = error.message
    probeJob.finishedAt = new Date().toISOString()
  })
  response.status(202).json(probeJob)
})

if (isDev) {
  const { createServer } = await import('vite')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
} else {
  app.use(express.static(resolve(root, 'dist')))
  app.get('*splat', (_request, response) => response.sendFile(resolve(root, 'dist/index.html')))
}

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ message: '服务器处理失败，请稍后重试' })
})

const port = isDev ? 4174 : Number(process.env.PORT || 4173)
app.listen(port, () => console.log(`博客管理台运行于 http://localhost:${port}`))
