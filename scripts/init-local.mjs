import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const csv = await readFile(resolve(root, 'blogs-original.csv'), 'utf8')
const rows = csv.trim().split(/\r?\n/).slice(1)

const technical = /编程|前端|后端|软件|开发|算法|架构|运维|开源|AI|机器学习|数据|技术|Linux|Java|Python|Go|iOS|Android/i
const lifestyle = /生活|随笔|旅行|摄影|读书|阅读|音乐|文学|成长|日记|美食|咖啡|育儿|哲学/i
const marketing = /营销|推广|SEO|外贸|电商|广告|运营/i

function inferType(tags) {
  if (marketing.test(tags)) return '营销'
  const hasTech = technical.test(tags)
  const hasLife = lifestyle.test(tags)
  if (hasTech && hasLife) return '综合'
  if (hasTech) return '技术'
  if (hasLife) return '生活'
  return '其它'
}

const sites = {}
for (const row of rows) {
  const [, address, , tags = ''] = row.split(',').map((value) => value.trim())
  if (!address) continue
  sites[address] = {
    type: inferType(tags),
    language: '中文',
    rating: 0,
    lastProbeAt: null,
    accessible: null,
    latestArticle: null,
    doNotProbe: false,
    blacklisted: false
  }
}

const data = {
  version: 1,
  updatedAt: null,
  settings: {
    pageSize: 20,
    probeConcurrency: 12,
    lastGlobalProbeAt: null
  },
  sites
}
await writeFile(resolve(root, 'local.json'), `${JSON.stringify(data, null, 2)}\n`)
console.log(`已初始化 ${Object.keys(sites).length} 条本地记录。`)
