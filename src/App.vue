<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

const blogs = ref([])
const loading = ref(true)
const error = ref('')
const query = ref('')
const typeFilter = ref('全部')
const statusFilter = ref('全部')
const listTab = ref('normal')
const page = ref(1)
const pageSize = ref(20)
const selected = ref(null)
const settingsOpen = ref(false)
const probeJob = ref({ state: 'idle', total: 0, completed: 0, probed: 0, skipped: 0, succeeded: 0, failed: 0 })
const probeConcurrency = ref(12)
const lastGlobalProbeAt = ref(null)
const saving = ref(false)
const probing = ref(false)
const inlineSaving = ref(new Set())
const latestArticles = reactive({})
const toast = ref('')

const types = ['技术', '生活', '综合', '营销', '其它']
const languages = ['中文', '英文', '其它']
const statuses = ['全部', '可访问', '不可访问', '未探测', '停止探测']
const form = reactive({ type: '', language: '', rating: 0, accessible: null, doNotProbe: false, blacklisted: false })

const counts = computed(() => ({
  total: blogs.value.length,
  accessible: blogs.value.filter((item) => item.accessible === true).length,
  inaccessible: blogs.value.filter((item) => item.accessible === false).length,
  pending: blogs.value.filter((item) => item.accessible === null).length
}))
const listCounts = computed(() => ({
  normal: blogs.value.filter((item) => !item.blacklisted).length,
  blacklist: blogs.value.filter((item) => item.blacklisted).length
}))

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return blogs.value.filter((blog) => {
    const matchesList = listTab.value === 'blacklist' ? blog.blacklisted : !blog.blacklisted
    const matchesText = !keyword || [blog.introduction, blog.address, blog.tags.join(' ')].some((value) => value.toLowerCase().includes(keyword))
    const matchesType = typeFilter.value === '全部' || blog.type === typeFilter.value
    const matchesStatus = statusFilter.value === '全部'
      || (statusFilter.value === '可访问' && blog.accessible === true)
      || (statusFilter.value === '不可访问' && blog.accessible === false)
      || (statusFilter.value === '未探测' && blog.accessible === null)
      || (statusFilter.value === '停止探测' && blog.doNotProbe)
    return matchesList && matchesText && matchesType && matchesStatus
  })
})

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))
const visibleBlogs = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const probeActive = computed(() => ['starting', 'running'].includes(probeJob.value.state))
const probePercent = computed(() => probeJob.value.total ? Math.round(probeJob.value.completed / probeJob.value.total * 100) : 0)
const probeStateLabel = computed(() => ({
  idle: '尚未开始',
  starting: '正在准备',
  running: '正在探测',
  complete: '探测完成',
  failed: '探测失败'
}[probeJob.value.state] || '状态未知'))
const pageNumbers = computed(() => {
  const visibleCount = 15
  const start = Math.max(1, Math.min(page.value - Math.floor(visibleCount / 2), pageCount.value - visibleCount + 1))
  return Array.from({ length: Math.min(visibleCount, pageCount.value) }, (_, index) => start + index)
})

watch([query, typeFilter, statusFilter, listTab], () => { page.value = 1 })
watch(pageCount, () => { if (page.value > pageCount.value) page.value = pageCount.value })
let probePollTimer

function showToast(message) {
  toast.value = message
  window.clearTimeout(showToast.timer)
  showToast.timer = window.setTimeout(() => { toast.value = '' }, 2600)
}

async function request(url, options) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || '请求失败')
  return data
}

async function loadBlogs(silent = false) {
  if (!silent) loading.value = true
  error.value = ''
  try {
    const data = await request('/api/blogs')
    blogs.value = data.blogs
    pageSize.value = data.settings?.pageSize || 20
    probeConcurrency.value = data.settings?.probeConcurrency || 12
    lastGlobalProbeAt.value = data.settings?.lastGlobalProbeAt || null
    probeJob.value = data.probeJob || probeJob.value
    for (const blog of data.blogs) {
      if (blog.latestArticle) latestArticles[blog.id] = { state: 'ready', ...blog.latestArticle }
    }
  } catch (err) {
    error.value = err.message
  } finally {
    if (!silent) loading.value = false
  }
}

function scheduleProbePoll() {
  window.clearTimeout(probePollTimer)
  probePollTimer = window.setTimeout(refreshProbeStatus, 1200)
}

async function refreshProbeStatus() {
  try {
    const previousState = probeJob.value.state
    probeJob.value = await request('/api/probe/status')
    if (!probeActive.value && (previousState === 'running' || previousState === 'starting')) {
      await loadBlogs(true)
      showToast(probeJob.value.state === 'complete' ? '全部探测已完成并保存' : '探测任务执行失败')
    }
  } catch {}
  scheduleProbePoll()
}

async function startProbeUpdate() {
  try {
    probeJob.value = await request('/api/probe/start', { method: 'POST' })
    showToast('并发探测已启动')
  } catch (err) {
    showToast(err.message)
    await refreshProbeStatus()
  }
}

async function updatePageSize(value) {
  const previous = pageSize.value
  pageSize.value = Number(value)
  page.value = 1
  try {
    const settings = await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ pageSize: pageSize.value })
    })
    pageSize.value = settings.pageSize
    showToast('每页显示数量已保存')
  } catch (err) {
    pageSize.value = previous
    showToast(err.message)
  }
}

async function loadLatestArticle(blog) {
  latestArticles[blog.id] = { state: 'loading' }
  try {
    const data = await request(`/api/blogs/${blog.id}/latest`)
    latestArticles[blog.id] = data.article
      ? { state: 'ready', ...data.article }
      : { state: 'empty' }
  } catch {
    latestArticles[blog.id] = { state: 'error' }
  }
}

function openEditor(blog) {
  selected.value = blog
  Object.assign(form, {
    type: blog.type,
    language: blog.language,
    rating: blog.rating,
    accessible: blog.accessible,
    doNotProbe: blog.doNotProbe,
    blacklisted: blog.blacklisted
  })
}

function closeEditor() {
  if (!saving.value && !probing.value) selected.value = null
}

function syncSelected(data) {
  Object.assign(selected.value, data)
  Object.assign(form, {
    type: selected.value.type,
    language: selected.value.language,
    rating: selected.value.rating,
    accessible: selected.value.accessible,
    doNotProbe: selected.value.doNotProbe,
    blacklisted: selected.value.blacklisted
  })
}

async function saveSite() {
  saving.value = true
  try {
    const data = await request(`/api/blogs/${selected.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify(form)
    })
    syncSelected(data)
    showToast('修改已写入 local.json')
    selected.value = null
  } catch (err) {
    showToast(err.message)
  } finally {
    saving.value = false
  }
}

async function updateInline(blog, field, rawValue) {
  const value = field === 'rating' ? Number(rawValue) : rawValue
  const previousValue = blog[field]
  const key = `${blog.id}:${field}`
  blog[field] = value
  inlineSaving.value = new Set([...inlineSaving.value, key])
  try {
    const data = await request(`/api/blogs/${blog.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value })
    })
    Object.assign(blog, data)
    if (selected.value?.id === blog.id) syncSelected(data)
    showToast('已自动保存')
  } catch (err) {
    blog[field] = previousValue
    showToast(`保存失败：${err.message}`)
  } finally {
    const next = new Set(inlineSaving.value)
    next.delete(key)
    inlineSaving.value = next
  }
}

function toggleBlacklist() {
  form.blacklisted = !form.blacklisted
}

async function probeSite() {
  probing.value = true
  try {
    const data = await request(`/api/blogs/${selected.value.id}/probe`, { method: 'POST' })
    syncSelected(data)
    showToast(data.accessible ? `站点可访问${data.status ? ` · HTTP ${data.status}` : ''}` : '站点暂时无法访问')
  } catch (err) {
    showToast(err.message)
  } finally {
    probing.value = false
  }
}

function formatTime(value) {
  if (!value) return '尚未探测'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatFullTime(value) {
  if (!value) return '尚未进行全局探测'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value))
}

function host(value) {
  try { return new URL(value).host } catch { return value }
}

onMounted(async () => {
  await loadBlogs()
  scheduleProbePoll()
})
onBeforeUnmount(() => window.clearTimeout(probePollTimer))
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="博客巡游志首页">
        <span class="brand-mark">游</span>
        <span><strong>博客巡游志</strong><small>独立博客管理台</small></span>
      </a>
      <div class="topbar-actions">
        <div class="source-note"><span class="live-dot"></span> 数据来自 <code>blogs-original.csv</code></div>
        <button class="settings-trigger" @click="settingsOpen = true">全局设置</button>
      </div>
    </header>

    <main>
      <section class="hero">
        <div>
          <p class="eyebrow">CURATED BLOG DIRECTORY</p>
          <h1>在独立的文字里，<br><em>发现更大的世界。</em></h1>
          <p class="hero-copy">整理、标记并持续观察中文独立博客。所有管理数据仅保存在你的本地文件中。</p>
        </div>
        <div class="hero-orbit" aria-hidden="true">
          <span class="orbit-ring"></span><span class="orbit-dot one"></span><span class="orbit-dot two"></span>
          <span class="orbit-center">{{ counts.total }}</span><small>个独立站点</small>
        </div>
      </section>

      <section class="stats" aria-label="站点概况">
        <button class="stat-card total" :class="{ active: statusFilter === '全部' }" @click="statusFilter = '全部'">
          <span class="stat-icon">⌘</span><span><small>全部站点</small><strong>{{ counts.total }}</strong></span><i>100%</i>
        </button>
        <button class="stat-card good" :class="{ active: statusFilter === '可访问' }" @click="statusFilter = '可访问'">
          <span class="stat-icon">✓</span><span><small>可访问</small><strong>{{ counts.accessible }}</strong></span><i>{{ counts.total ? Math.round(counts.accessible / counts.total * 100) : 0 }}%</i>
        </button>
        <button class="stat-card bad" :class="{ active: statusFilter === '不可访问' }" @click="statusFilter = '不可访问'">
          <span class="stat-icon">×</span><span><small>无法访问</small><strong>{{ counts.inaccessible }}</strong></span><i>{{ counts.total ? Math.round(counts.inaccessible / counts.total * 100) : 0 }}%</i>
        </button>
        <button class="stat-card pending" :class="{ active: statusFilter === '未探测' }" @click="statusFilter = '未探测'">
          <span class="stat-icon">◌</span><span><small>待探测</small><strong>{{ counts.pending }}</strong></span><i>{{ counts.total ? Math.round(counts.pending / counts.total * 100) : 0 }}%</i>
        </button>
      </section>

      <section v-if="probeJob.state !== 'idle' || lastGlobalProbeAt" class="home-probe" aria-live="polite">
        <div class="home-probe-head">
          <div><span class="probe-state-dot" :class="{ active: probeActive, failed: probeJob.state === 'failed' }"></span><strong>{{ probeJob.state === 'idle' ? '上次全局探测' : probeStateLabel }}</strong><small>{{ probeConcurrency }} 路并发 · 结果同步保存至 local.json</small></div>
          <div><b v-if="probeJob.state !== 'idle'">{{ probePercent }}%</b><button @click="settingsOpen = true">查看详情</button></div>
        </div>
        <div v-if="probeJob.state !== 'idle'" class="probe-progress"><i :style="{ width: `${probePercent}%` }"></i></div>
        <div v-if="probeJob.total" class="home-probe-stats">
          <span>已处理 <b>{{ probeJob.completed }}</b> / {{ probeJob.total }}</span>
          <span>已探测 <b>{{ probeJob.probed }}</b></span>
          <span>成功 <b>{{ probeJob.succeeded }}</b></span>
          <span>失败 <b>{{ probeJob.failed }}</b></span>
          <span>跳过 <b>{{ probeJob.skipped }}</b></span>
        </div>
        <div class="last-global-time">上次全局探测完成时间：<b>{{ formatFullTime(lastGlobalProbeAt) }}</b></div>
      </section>

      <section class="directory">
        <div class="directory-heading">
          <div><p class="eyebrow">DIRECTORY</p><h2>博客名录</h2></div>
          <p>筛选并管理站点信息 <b>{{ filtered.length }}</b> 条结果</p>
        </div>

        <div class="toolbar">
          <label class="search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
            <input v-model="query" type="search" placeholder="搜索博客名称、网址或标签…" />
            <kbd>⌘ K</kbd>
          </label>
          <label class="select-wrap"><span>类型</span><select v-model="typeFilter"><option>全部</option><option v-for="item in types" :key="item">{{ item }}</option></select></label>
          <label class="select-wrap"><span>状态</span><select v-model="statusFilter"><option v-for="item in statuses" :key="item">{{ item }}</option></select></label>
        </div>

        <div v-if="loading" class="state-panel"><span class="spinner"></span><p>正在整理博客名录…</p></div>
        <div v-else-if="error" class="state-panel error"><p>{{ error }}</p><button @click="loadBlogs">重新加载</button></div>
        <div v-else class="tabbed-table">
          <div class="list-tabs" role="tablist" aria-label="博客列表分类">
            <button role="tab" :aria-selected="listTab === 'normal'" :class="{ active: listTab === 'normal' }" @click="listTab = 'normal'">正常列表 <span>{{ listCounts.normal }}</span></button>
            <button role="tab" :aria-selected="listTab === 'blacklist'" :class="{ active: listTab === 'blacklist' }" @click="listTab = 'blacklist'">Black list <span>{{ listCounts.blacklist }}</span></button>
          </div>
          <div class="table-wrap">
            <table>
            <thead><tr><th>博客 / 地址</th><th>类型</th><th>语言</th><th>评级</th><th>最近文章</th><th>访问状态</th><th>上次探测</th><th></th></tr></thead>
            <tbody>
              <tr v-for="blog in visibleBlogs" :key="blog.id" @click="openEditor(blog)">
                <td>
                  <a class="blog-cell" :href="blog.address" target="_blank" rel="noreferrer" @click.stop><span class="favicon">{{ blog.introduction.slice(0, 1).toUpperCase() }}</span><span><strong>{{ blog.introduction }}</strong><small>{{ host(blog.address) }}</small></span></a>
                </td>
                <td>
                  <select
                    class="inline-select type-select"
                    :class="{ saving: inlineSaving.has(`${blog.id}:type`) }"
                    :data-type="blog.type"
                    :value="blog.type"
                    :aria-label="`修改 ${blog.introduction} 的类型`"
                    @click.stop
                    @change.stop="updateInline(blog, 'type', $event.target.value)"
                  ><option v-for="item in types" :key="item">{{ item }}</option></select>
                </td>
                <td>
                  <select
                    class="inline-select"
                    :class="{ saving: inlineSaving.has(`${blog.id}:language`) }"
                    :value="blog.language"
                    :aria-label="`修改 ${blog.introduction} 的语言`"
                    @click.stop
                    @change.stop="updateInline(blog, 'language', $event.target.value)"
                  ><option v-for="item in languages" :key="item">{{ item }}</option></select>
                </td>
                <td>
                  <select
                    class="inline-select rating-select"
                    :class="{ saving: inlineSaving.has(`${blog.id}:rating`) }"
                    :value="blog.rating"
                    :aria-label="`修改 ${blog.introduction} 的评级`"
                    @click.stop
                    @change.stop="updateInline(blog, 'rating', $event.target.value)"
                  >
                    <option :value="0">未知</option>
                    <option v-for="star in 5" :key="star" :value="star">{{ '★'.repeat(star) }} {{ star }} 星</option>
                  </select>
                </td>
                <td class="latest-cell">
                  <span v-if="!blog.rss" class="feed-empty">无 Feed</span>
                  <button v-else-if="!latestArticles[blog.id]" class="feed-load" @click.stop="loadLatestArticle(blog)">读取最近文章</button>
                  <span v-else-if="latestArticles[blog.id].state === 'loading'" class="feed-loading">读取中…</span>
                  <a
                    v-else-if="latestArticles[blog.id].state === 'ready'"
                    :href="latestArticles[blog.id].url || blog.address"
                    target="_blank"
                    rel="noreferrer"
                    :title="latestArticles[blog.id].title"
                    @click.stop
                  >{{ latestArticles[blog.id].title }} ↗</a>
                  <span v-else-if="latestArticles[blog.id].state === 'empty'" class="feed-empty">暂无文章</span>
                  <button v-else class="feed-retry" @click.stop="loadLatestArticle(blog)">读取失败 · 重试</button>
                </td>
                <td><span class="status-pill" :class="blog.accessible === true ? 'online' : blog.accessible === false ? 'offline' : 'unknown-status'"><i class="fa-solid" :class="blog.accessible === true ? 'fa-link' : blog.accessible === false ? 'fa-link-slash' : 'fa-circle-question'" aria-hidden="true"></i>{{ blog.accessible === true ? 'Y' : blog.accessible === false ? 'N' : '?' }}</span></td>
                <td><span class="probe-time">{{ formatTime(blog.lastProbeAt) }}</span></td>
                <td><button class="more" aria-label="编辑站点" @click.stop="openEditor(blog)">•••</button></td>
              </tr>
            </tbody>
            </table>
            <div v-if="!visibleBlogs.length" class="empty">{{ listTab === 'blacklist' ? 'Black list 中还没有站点。' : '没有找到符合条件的博客。' }}</div>
          </div>
        </div>

        <nav v-if="!loading && filtered.length" class="pagination" aria-label="分页">
          <span>显示 {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, filtered.length) }}，共 {{ filtered.length }} 条</span>
          <div><button :disabled="page === 1" @click="page--">‹</button><button v-for="number in pageNumbers" :key="number" :class="{ current: page === number }" @click="page = number">{{ number }}</button><button :disabled="page === pageCount" @click="page++">›</button></div>
        </nav>
      </section>
    </main>

    <footer><span>博客巡游志 · 本地管理台</span><span>CSV 主数据 <i>+</i> JSON 本地标注</span></footer>

    <Transition name="fade"><div v-if="settingsOpen" class="scrim" @click="settingsOpen = false"></div></Transition>
    <Transition name="settings-modal">
      <section v-if="settingsOpen" class="settings-panel" aria-label="全局设置">
        <div class="settings-head"><div><p class="eyebrow">GLOBAL SETTINGS</p><h2>全局设置</h2></div><button @click="settingsOpen = false">×</button></div>

        <label class="settings-field">
          <span><strong>每页显示数目</strong><small>该设置会保存到 local.json</small></span>
          <select :value="pageSize" @change="updatePageSize($event.target.value)"><option :value="10">10 条</option><option :value="20">20 条</option><option :value="50">50 条</option><option :value="100">100 条</option></select>
        </label>

        <div class="probe-settings">
          <div class="probe-title"><span><strong>探测更新</strong><small>使用 {{ probeConcurrency }} 个并发任务，结果实时写入本地</small></span><b v-if="probeActive">{{ probePercent }}%</b></div>
          <div class="settings-last-probe"><span>上次全局探测</span><strong>{{ formatFullTime(lastGlobalProbeAt) }}</strong></div>
          <ul>
            <li>有 Feed：读取并保存最近一篇文章</li>
            <li>无 Feed：检测网站是否可以访问</li>
            <li>跳过“不再探测”的站点</li>
            <li>上次无法访问的站点，一个月内跳过</li>
          </ul>
          <div v-if="probeActive" class="probe-progress"><i :style="{ width: `${probePercent}%` }"></i></div>
          <div v-if="probeJob.state !== 'idle'" class="probe-summary">
            <span>已处理 {{ probeJob.completed }} / {{ probeJob.total }}</span>
            <span>成功 {{ probeJob.succeeded }} · 失败 {{ probeJob.failed }} · 跳过 {{ probeJob.skipped }}</span>
          </div>
          <button class="probe-all" :disabled="probeActive" @click="startProbeUpdate">{{ probeActive ? '探测正在进行…' : probeJob.state === 'complete' ? '再次探测更新' : '开始探测更新' }}</button>
        </div>
      </section>
    </Transition>

    <Transition name="fade"><div v-if="selected" class="scrim" @click="closeEditor"></div></Transition>
    <Transition name="drawer">
      <aside v-if="selected" class="editor" aria-label="编辑博客信息">
        <div class="editor-head"><div><p class="eyebrow">SITE PROFILE</p><h2>编辑站点</h2></div><button @click="closeEditor">×</button></div>
        <div class="site-preview"><span class="favicon large">{{ selected.introduction.slice(0, 1).toUpperCase() }}</span><div><h3>{{ selected.introduction }}</h3><a :href="selected.address" target="_blank" rel="noreferrer">{{ selected.address }} ↗</a></div></div>
        <div class="tags"><span v-for="tag in selected.tags" :key="tag"># {{ tag }}</span></div>

        <form @submit.prevent="saveSite">
          <div class="field-row"><label>网站类型<select v-model="form.type"><option v-for="item in types" :key="item">{{ item }}</option></select></label><label>语言<select v-model="form.language"><option v-for="item in languages" :key="item">{{ item }}</option></select></label></div>
          <fieldset><legend>评级</legend><div class="rating-editor"><button v-for="star in 5" :key="star" type="button" :class="{ chosen: star <= form.rating }" @click="form.rating = star">★</button><button type="button" class="clear-rating" @click="form.rating = 0">设为未知</button></div></fieldset>
          <fieldset><legend>访问状态</legend><div class="segmented"><button type="button" :class="{ chosen: form.accessible === null }" @click="form.accessible = null">未知</button><button type="button" :class="{ chosen: form.accessible === true }" @click="form.accessible = true">可访问</button><button type="button" :class="{ chosen: form.accessible === false }" @click="form.accessible = false">无法访问</button></div></fieldset>
          <label class="switch-row"><span><strong>不再探测</strong><small>跳过之后的自动或手动访问检测</small></span><input v-model="form.doNotProbe" type="checkbox" /><i></i></label>
          <div class="probe-box"><span><small>上次探测</small><strong>{{ formatTime(selected.lastProbeAt) }}</strong></span><button type="button" :disabled="probing || form.doNotProbe" @click="probeSite"><span v-if="probing" class="spinner mini"></span>{{ probing ? '探测中' : '立即探测' }}</button></div>
          <button type="button" class="blacklist-action" :class="{ restore: form.blacklisted }" @click="toggleBlacklist"><i class="fa-solid" :class="form.blacklisted ? 'fa-arrow-rotate-left' : 'fa-ban'" aria-hidden="true"></i>{{ form.blacklisted ? '移出 Black list' : '移入 Black list' }}</button>
          <div class="editor-actions"><button type="button" @click="closeEditor">取消</button><button class="primary" :disabled="saving" type="submit">{{ saving ? '保存中…' : '保存更改' }}</button></div>
        </form>
      </aside>
    </Transition>
    <Transition name="toast"><div v-if="toast" class="toast">✓ {{ toast }}</div></Transition>
  </div>
</template>
