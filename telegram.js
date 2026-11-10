// ═══════════════════════════════════════════════════════════════
//   🎖️ MR JOO — مدير جلسات عبر تليجرام (واجهة حديثة + نظام اشتراكات)
//   أي مستخدم يفتح البوت ← يربط رقمه ← تشتغل له جلسة واتساب خاصة.
//   المسؤول (adminIds) فقط يتحكم في الجلسات والمستخدمين والاشتراكات.
//   لا يحتاج أي مكتبات إضافية (يستخدم Telegram Bot API مباشرة).
// ═══════════════════════════════════════════════════════════════
import { fork } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = path.dirname(fileURLToPath(import.meta.url))

// ───────────────────────── الإعدادات ─────────────────────────
const CONFIG_FILE = path.join(__dir, 'config.json')
const TEMPLATE = {
  telegramToken: 'ضع_توكن_البوت_هنا',
  adminIds: ['ضع_معرفك_الرقمي_هنا'],
  adminContact: '',
  maxSessionsPerUser: 1,
  maxTotalSessions: 15,
  defaultCountryCode: '20',
  developerWhatsApp: '',
  timezone: 'Africa/Cairo'
}

let fileCfg = {}
if (fs.existsSync(CONFIG_FILE)) {
  try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (e) {
    console.log('❌ ملف config.json فيه خطأ في الصياغة: ' + e.message)
    process.exit(1)
  }
} else if (!process.env.TELEGRAM_TOKEN) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(TEMPLATE, null, 2) + '\n')
  console.log('📝 تم إنشاء ملف config.json — افتحه وضع التوكن ومعرفك كمسؤول ثم شغّل الأمر مرة ثانية.')
  process.exit(0)
}

const csv = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const TOKEN = (process.env.TELEGRAM_TOKEN || fileCfg.telegramToken || '').trim()
const ADMIN_IDS = new Set((process.env.ADMIN_IDS ? csv(process.env.ADMIN_IDS) : (fileCfg.adminIds || []).map(String)).filter((x) => /^\d+$/.test(x)))
const MAX_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER || fileCfg.maxSessionsPerUser || 1)
const MAX_TOTAL = Number(process.env.MAX_TOTAL_SESSIONS || fileCfg.maxTotalSessions || 15)
const DEFAULT_CC = String(process.env.DEFAULT_COUNTRY_CODE || fileCfg.defaultCountryCode || '').replace(/\D/g, '')
const DEV_WA = String(process.env.DEVELOPER_WHATSAPP || fileCfg.developerWhatsApp || '').replace(/\D/g, '')
const TZ_NAME = process.env.TZ_NAME || fileCfg.timezone || 'Africa/Cairo'
const API = process.env.TELEGRAM_API || 'https://api.telegram.org'
const SESSION_SCRIPT = process.env.SESSION_SCRIPT || path.join(__dir, 'index.js')
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dir, 'data'))

// رابط «تواصل مع الأدمن»: يوزر تليجرام (مع أو بدون @) أو رابط كامل أو معرف رقمي. الافتراضي: أول مسؤول.
const CONTACT_URL = (() => {
  const raw = String(process.env.ADMIN_CONTACT || fileCfg.adminContact || '').trim()
  if (/^https?:\/\//i.test(raw) || /^tg:\/\//i.test(raw)) return raw
  if (/^\d+$/.test(raw)) return `tg://user?id=${raw}`
  if (/^@?[A-Za-z][\w]{3,}$/.test(raw)) return `https://t.me/${raw.replace(/^@/, '')}`
  const first = [...ADMIN_IDS][0]
  return first ? `tg://user?id=${first}` : ''
})()

if (!/^\d{5,}:[\w-]{20,}$/.test(TOKEN)) {
  console.log('❌ توكن البوت غير صحيح أو غير موجود. ضعه في config.json (telegramToken) — تحصل عليه من @BotFather')
  process.exit(1)
}
if (!ADMIN_IDS.size) {
  console.log('❌ لازم تحدد معرفك الرقمي كمسؤول في config.json (adminIds). تعرفه من @userinfobot أو بإرسال /id لبوتك.')
  process.exit(1)
}

const PAIR_CODE_TIMEOUT = 90_000      // مهلة ظهور الكود
const PAIR_TOTAL_TIMEOUT = 6 * 60_000 // مهلة إتمام الربط
const MAX_CODES = 4                   // أقصى عدد أكواد لكل محاولة ربط
const USER_COOLDOWN = 20_000          // بين محاولات الربط للمستخدم الواحد
const NUMBER_COOLDOWN = 5 * 60_000    // بين محاولات الربط لنفس الرقم (يمنع إزعاج أرقام الغير)
const MAX_BAD_CODES = 5               // محاولات كود اشتراك خاطئة قبل القفل المؤقت
const BAD_CODE_LOCK = 10 * 60_000     // مدة القفل
const TICK_EVERY = 5_000              // تحديث العد التنازلي الحي
const TICK_FOR = 2 * 60_000           // مدة بقاء العد الحي بعد فتح الشاشة
const SWEEP_EVERY = 20_000            // فحص الاشتراكات المنتهية

// ── قفل نسخة واحدة: يمنع تشغيل المدير مرتين بالغلط على نفس الجهاز بنفس التوكن ──
const LOCK_FILE = path.join(DATA_DIR, 'telegram.lock')
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
      let alive = false
      try { process.kill(oldPid, 0); alive = true } catch { alive = false }
      if (alive && oldPid !== process.pid) {
        console.log(`❌ في نسخة تانية من المدير شغّالة بالفعل على هذا الجهاز (PID ${oldPid}).`)
        console.log('   اقفلها الأول (من الطرفية اللي شغّالة فيها، أو من Task Manager) ثم شغّل تاني.')
        console.log('   لو متأكد إنها مش شغّالة فعلًا، احذف هذا الملف وحاول تاني: ' + LOCK_FILE)
        process.exit(1)
      }
    }
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LOCK_FILE, String(process.pid))
  } catch (e) { log('⚠️ تعذر إنشاء قفل النسخة الواحدة: ' + e.message) }
}
function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) fs.rmSync(LOCK_FILE, { force: true }) } catch { }
}
acquireLock()

fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true })

// ───────────────────────── التخزين ─────────────────────────
// users[id].sub = { startedAt, expiresAt (null = دائم), totalMs, source, warned }
// codes[CODE]   = { code, durationMs (null = دائم), createdAt, createdBy, usedBy, usedAt }
// settings.paid = هل البوت بنظام الاشتراك؟
const STORE_FILE = path.join(DATA_DIR, 'store.json')
let store = { users: {}, sessions: {}, codes: {}, cmdrules: {}, adminWa: {}, settings: { paid: false } }
try {
  if (fs.existsSync(STORE_FILE)) {
    store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  }
} catch (e) {
  console.log('⚠️ تعذر قراءة الملف: ' + e.message);
}
store.users ||= {}; store.sessions ||= {}; store.codes ||= {}
store.cmdrules = { ...(store.cmdrules || {}) }
store.adminWa = { ...(store.adminWa || {}) }
store.unlinkReqs = { ...(store.unlinkReqs || {}) }
store.settings = { paid: false, ...(store.settings || {}) }
const saveStore = () => {
  try {
    fs.writeFileSync(STORE_FILE + '.tmp', JSON.stringify(store, null, 2))
    fs.renameSync(STORE_FILE + '.tmp', STORE_FILE)
  } catch (e) { console.log('⚠️ تعذر حفظ البيانات: ' + e.message) }
}

// ───────────────────────── أدوات ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const isAdmin = (id) => ADMIN_IDS.has(String(id))
const LINE = '━━━━━━━━━━━━━━'
const mask = (n) => (n && n.length > 6 ? `+${n.slice(0, 4)}••••${n.slice(-2)}` : `+${n}`)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const toEnDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
const pad = (n) => String(n).padStart(2, '0')
const fmtDate = (t) => new Date(t).toLocaleString('en-GB', { timeZone: TZ_NAME, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

function fmtShort(ms) {
  ms = Math.max(0, ms)
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / MIN), s = Math.floor((ms % MIN) / 1000)
  const parts = []
  if (d) parts.push(`${d} يوم`)
  if (h) parts.push(`${h} ساعة`)
  if (m && parts.length < 2) parts.push(`${m} دقيقة`)
  if (!parts.length) parts.push(`${s} ثانية`)
  return parts.slice(0, 2).join(' و ')
}
function fmtClock(ms) {
  ms = Math.max(0, ms)
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / MIN), s = Math.floor((ms % MIN) / 1000)
  return (d ? `<b>${d}</b> يوم  ·  ` : '') + `<b>${pad(h)}</b> ساعة  ·  <b>${pad(m)}</b> دقيقة  ·  <b>${pad(s)}</b> ثانية`
}
const bar = (frac, n = 12) => {
  const f = Math.round(Math.min(1, Math.max(0, frac)) * n)
  return '▰'.repeat(f) + '▱'.repeat(n - f)
}
function spanLabel(ms) {
  if (ms === null) return '♾ دائم'
  const d = ms / DAY
  if (ms >= 365 * DAY && ms % (365 * DAY) === 0) return ms === 365 * DAY ? 'سنة' : `${ms / (365 * DAY)} سنين`
  if (d >= 1 && Number.isInteger(d)) return d === 1 ? 'يوم' : d === 2 ? 'يومين' : d <= 10 ? `${d} أيام` : `${d} يوم`
  if (ms >= HOUR && ms % HOUR === 0) { const h = ms / HOUR; return h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : h <= 10 ? `${h} ساعات` : `${h} ساعة` }
  return fmtShort(ms)
}

function parseDuration(raw) {
  const t = toEnDigits(String(raw ?? '').trim().toLowerCase())
  if (['perm', 'permanent', 'forever', 'lifetime', 'دائم', 'دائما', 'دائمة', 'دايم', 'مدى الحياة'].includes(t)) return null
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([a-zء-ي]*)$/)
  if (!m) return undefined
  const n = parseFloat(m[1]); const u = m[2]
  let unit
  if (!u || /^(d|day|days|ي|يوم|يوما|ايام|أيام|يومين)$/.test(u)) unit = DAY
  else if (/^(m|min|mins|minute|minutes|د|دقيقة|دقيقه|دقايق|دقائق)$/.test(u)) unit = MIN
  else if (/^(h|hr|hrs|hour|hours|س|ساعة|ساعه|ساعات)$/.test(u)) unit = HOUR
  else if (/^(w|week|weeks|اسبوع|أسبوع|اسابيع|أسابيع)$/.test(u)) unit = 7 * DAY
  else if (/^(mo|month|months|شهر|شهور|اشهر|أشهر)$/.test(u)) unit = 30 * DAY
  else if (/^(y|yr|year|years|سنة|سنه|سنين|سنوات|عام)$/.test(u)) unit = 365 * DAY
  else return undefined
  const ms = Math.round(n * unit)
  if (!(ms >= MIN) || ms > 3650 * DAY) return undefined
  return ms
}

async function tg(method, params = {}, timeoutMs = 30_000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctl.signal,
    })
    const data = await res.json()
    if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`)
    return data.result
  } finally { clearTimeout(t) }
}
const send = (chat_id, text, extra = {}) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch((e) => { log('⚠️ إرسال:', e.message); return null })
const edit = (chat_id, message_id, text, extra = {}) =>
  tg('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
    .catch((e) => (/not modified/i.test(e.message) ? true : null))
const editCaption = (chat_id, message_id, caption, extra = {}) =>
  tg('editMessageCaption', { chat_id, message_id, caption, parse_mode: 'HTML', ...extra })
    .catch((e) => (/not modified/i.test(e.message) ? true : null))
const del = (chat_id, message_id) => tg('deleteMessage', { chat_id, message_id }).catch(() => null)
const answer = (id, text = '', alert = false) => tg('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }).catch(() => null)
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows.filter((r) => r.length) } })
const btn = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) })
const urlBtn = (text, url, style) => ({ text, url, ...(style ? { style } : {}) })
const contactRow = () => {
  const row = []
  if (CONTACT_URL) row.push(urlBtn('📩 تواصل مع الأدمن', CONTACT_URL))
  if (DEV_WA) row.push(urlBtn('🟢 واتساب', `https://wa.me/${DEV_WA}`))
  return row
}

async function tgMultipart(method, fields, fileField, filePath, timeoutMs = 30_000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v))
    const buf = fs.readFileSync(filePath)
    form.append(fileField, new Blob([buf]), path.basename(filePath))
    const res = await fetch(`${API}/bot${TOKEN}/${method}`, { method: 'POST', body: form, signal: ctl.signal })
    const data = await res.json()
    if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`)
    return data.result
  } finally { clearTimeout(t) }
}

const IMGS = (() => {
  try {
    const dir = path.join(__dir, 'media')
    const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().map((f) => path.join(dir, f))
    const home = files[0] || null
    return { home, admin: files[1] || home, gate: files[2] || home }
  } catch { return { home: null, admin: null, gate: null } }
})()
const fileIds = new Map()

async function sendPhotoScreen(chat_id, img, caption, extra = {}) {
  if (!img) return send(chat_id, caption, extra)
  const markup = extra.reply_markup
  const cached = fileIds.get(img)
  if (cached) {
    try { return await tg('sendPhoto', { chat_id, photo: cached, caption, parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) }) }
    catch (e) { fileIds.delete(img); log('⚠️ file_id قديم، إعادة رفع الصورة:', e.message) }
  }
  try {
    const fields = { chat_id, caption, parse_mode: 'HTML' }
    if (markup) fields.reply_markup = JSON.stringify(markup)
    const r = await tgMultipart('sendPhoto', fields, 'photo', img)
    const fid = r?.photo?.[r.photo.length - 1]?.file_id
    if (fid) fileIds.set(img, fid)
    return r
  } catch (e) {
    log('⚠️ إرسال الصورة:', e.message)
    return send(chat_id, caption, extra)
  }
}

async function show(chatId, mid, scr, curIsPhoto = false) {
  const { text, extra = {}, photo = null } = scr
  if (mid) {
    if (photo && curIsPhoto) { const r = await editCaption(chatId, mid, text, extra); if (r) return r }
    else if (!photo && !curIsPhoto) { const r = await edit(chatId, mid, text, extra); if (r) return r }
    await del(chatId, mid)
  }
  return photo ? sendPhotoScreen(chatId, photo, text, extra) : send(chatId, text, extra)
}
const midOf = (r, fallback) => (r && typeof r === 'object' ? r.message_id : fallback)

// ───────────────────────── تشغيل الجلسات ─────────────────────────
const runtime = new Map()
const lastLink = { user: new Map(), number: new Map() }
const awaiting = new Map()
const restartLog = new Map()
const badCodes = new Map()
const tickers = new Map()

const pendingIPC = new Map()
const groupsCache = new Map()
function childReq(sid, msg, timeoutMs = 25_000) {
  const rt = runtime.get(sid)
  if (!rt?.child) return Promise.reject(new Error('الجلسة دي مش شغّالة'))
  return new Promise((resolve, reject) => {
    const reqId = crypto.randomUUID()
    const timer = setTimeout(() => { pendingIPC.delete(reqId); reject(new Error('انتهت مهلة الرد من الجلسة')) }, timeoutMs)
    pendingIPC.set(reqId, { resolve, timer })
    try { rt.child.send({ ...msg, reqId }) } catch (e) { clearTimeout(timer); pendingIPC.delete(reqId); reject(e) }
  })
}

const sessionDir = (sid) => path.join(DATA_DIR, 'sessions', sid)
const userSessions = (tgId) => Object.values(store.sessions).filter((s) => s.tgId === String(tgId))

// ───────────────────────── الاشتراكات ─────────────────────────
const isPaid = () => !!store.settings.paid
function subOf(uid) {
  const s = store.users[String(uid)]?.sub
  if (!s) return null
  if (s.expiresAt === null || s.expiresAt > Date.now()) return s
  return null
}
const hasAccess = (uid) => isAdmin(uid) || !isPaid() || !!subOf(uid)

const statusOf = (s) => {
  const rt = runtime.get(s.id)
  if (s.status === 'pending') return { icon: '🟡', text: 'قيد الربط' }
  if (rt?.state === 'online') return { icon: '🟢', text: 'شغّالة' }
  if (rt && !rt.stopping) return { icon: '🟠', text: 'جارٍ الاتصال' }
  if (s.status === 'linked' && !hasAccess(s.tgId)) return { icon: '🔒', text: 'موقوفة (بدون اشتراك)' }
  return { icon: '🔴', text: 'متوقفة' }
}

async function enforceAccess() {
  for (const s of Object.values(store.sessions)) {
    if (hasAccess(s.tgId) || !runtime.has(s.id)) continue
    if (s.status === 'pending') await destroySession(s.id, { logout: false })
    else await stopProcess(s.id)
  }
}
async function resumeAccess(uid = null) {
  for (const s of Object.values(store.sessions)) {
    if (uid && s.tgId !== String(uid)) continue
    if (s.status !== 'linked' || runtime.has(s.id)) continue
    if (store.users[s.tgId]?.banned || !hasAccess(s.tgId)) continue
    spawnSession(s.id)
    await sleep(1200)
  }
}
async function cancelUserSessions(uid) {
  const list = userSessions(uid)
  for (const s of list) await destroySession(s.id, { logout: s.status === 'linked' && runtime.has(s.id) })
  return list.length
}

function applySub(uid, durationMs, source) {
  const u = store.users[String(uid)]
  const now = Date.now()
  const cur = subOf(uid)
  if (durationMs === null) u.sub = { startedAt: now, expiresAt: null, totalMs: null, source }
  else {
    const base = cur && cur.expiresAt !== null ? cur.expiresAt : now
    u.sub = { startedAt: now, expiresAt: base + durationMs, totalMs: base + durationMs - now, source }
  }
  delete u.lastExpiredAt
  saveStore()
  return u.sub
}

const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function genCode() {
  for (;;) {
    const b = crypto.randomBytes(12)
    let s = ''
    for (let i = 0; i < 12; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length]
    const code = `CMD-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
    if (!store.codes[code]) return code
  }
}
function normalizeCode(raw) {
  const s = toEnDigits(raw).toUpperCase()
  const a = s.replace(/[^A-Z0-9]/g, '')
  const body = a.startsWith('CMD') && a.length === 15 ? a.slice(3) : a.length === 12 ? a : null
  return body ? `CMD-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}` : s.trim()
}
const looksLikeCode = (raw) => /^CMD[A-Z0-9]{12}$/.test(toEnDigits(raw).toUpperCase().replace(/[^A-Z0-9]/g, ''))

function redeemCode(uid, raw) {
  const now = Date.now()
  const bad = badCodes.get(uid)
  if (bad && bad.until > now) return { ok: false, text: `🚫 محاولات خاطئة كتير.\nجرّب تاني بعد <b>${fmtShort(bad.until - now)}</b>.` }
  const code = normalizeCode(raw)
  const c = store.codes[code]
  if (!c) {
    const n = (bad && bad.until <= now ? 0 : bad?.n || 0) + 1
    badCodes.set(uid, { n, until: n >= MAX_BAD_CODES ? now + BAD_CODE_LOCK : 0 })
    return { ok: false, text: n >= MAX_BAD_CODES
      ? `🚫 اتقفل إدخال الأكواد مؤقتًا لمدة ${fmtShort(BAD_CODE_LOCK)} بسبب محاولات خاطئة كتير.`
      : `❌ <b>كود غير صحيح</b>\nتأكد من الكود واكتبه زي ما وصلك.\n<i>المحاولات: ${n}/${MAX_BAD_CODES}</i>` }
  }
  if (c.usedBy) return { ok: false, text: '⚠️ <b>الكود ده اتستخدم قبل كده.</b>\nاطلب كود جديد من الأدمن.' }
  const cur = subOf(uid)
  if (cur && cur.expiresAt === null) return { ok: false, text: '♾ اشتراكك <b>دائم</b> بالفعل، مش محتاج كود جديد. (الكود لم يُستهلك)' }
  badCodes.delete(uid)
  applySub(uid, c.durationMs, `code:${code}`)
  c.usedBy = uid
  c.usedAt = now
  saveStore()
  return { ok: true, code: c, renewed: !!cur }
}

async function sweepExpiry() {
  const now = Date.now()
  let changed = false
  const expiredNow = []
  for (const u of Object.values(store.users)) {
    const s = u.sub
    if (!s || s.expiresAt === null) continue
    if (s.expiresAt <= now) {
      u.sub = null; u.lastExpiredAt = now; changed = true
      if (isPaid() && !isAdmin(u.id)) expiredNow.push(u)
    } else if (!s.warned && s.expiresAt - now <= DAY && (s.totalMs || 0) > 2 * DAY) {
      s.warned = true; changed = true
      if (isPaid() && !isAdmin(u.id)) send(u.id, `⏰ <b>تنبيه:</b> اشتراكك هيخلص بعد <b>${fmtShort(s.expiresAt - now)}</b>.\nجدّل قبل ما يخلص، لأن لما ينتهي الاشتراك بتتلغى جلستك.`,
        kb([[btn('💎 اشتراكي', 'sub')], contactRow()]))
    }
  }
  if (changed) saveStore()
  for (const u of expiredNow) {
    const n = await cancelUserSessions(u.id)
    send(u.id, `⌛ <b>انتهى اشتراكك</b>\n${LINE}\nاتلغى الاشتراك تلقائيًا` + (n ? ` وتم <b>إلغاء وحذف جلستك</b> (فصل الجهاز من واتساب).` : '.') +
      `\nلتجديد الاشتراك تواصل مع الأدمن وادخل كود جديد، وبعدها اربط رقمك من جديد.`,
      kb([[btn('🎟 إدخال كود الاشتراك', 'code', 'primary')], contactRow()]))
  }
}

function stopTicker(uid) {
  const t = tickers.get(uid)
  if (t) { clearInterval(t.timer); tickers.delete(uid) }
}
function startTicker(uid, chatId, mid) {
  stopTicker(uid)
  if (!mid) return
  const sub = subOf(uid)
  if (!sub || sub.expiresAt === null || isAdmin(uid)) return
  const t = { chatId, mid, until: Date.now() + TICK_FOR, fails: 0 }
  t.timer = setInterval(async () => {
    if (Date.now() > t.until) return stopTicker(uid)
    const v = subScreen(uid)
    const r = await edit(chatId, mid, v.text, v.extra)
    t.fails = r ? 0 : t.fails + 1
    if (t.fails >= 3 || !subOf(uid)) stopTicker(uid)
  }, TICK_EVERY)
  t.timer.unref?.()
  tickers.set(uid, t)
}

// ───────────────────────── تشغيل/إيقاف الجلسات ─────────────────────────
function spawnSession(sid) {
  const s = store.sessions[sid]
  if (!s || runtime.has(sid)) return
  const dir = sessionDir(sid)
  fs.mkdirSync(dir, { recursive: true })
  const logFile = path.join(DATA_DIR, 'logs', `${sid}.log`)
  try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.truncateSync(logFile, 0) } catch { }
  const logStream = fs.createWriteStream(logFile, { flags: 'a' })

  const env = { ...process.env }
  delete env.TELEGRAM_TOKEN
  Object.assign(env, {
    MR_JOO_CHILD: '1',
    SESSION_DIR: path.join(dir, 'session'),
    DB_FILE: path.join(dir, 'db.json'),
    STORE_DIR: path.join(dir, 'store'),
    PAIRING_NUMBER: s.number,
    BOT_NUMBER: s.number,
    OWNER_NUMBERS: s.number,
    DEV_NUMBER: DEV_WA || s.number,
  })

  const child = fork(SESSION_SCRIPT, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: __dir })
  child.stdout.pipe(logStream, { end: false })
  child.stderr.pipe(logStream, { end: false })
  const cmdRules = store.cmdrules[s.tgId]
  if (cmdRules && (cmdRules.def === 'block' || Object.keys(cmdRules.rules || {}).length)) {
    try { child.send({ type: 'cmdrules', rules: cmdRules }) } catch { }
  }
  const rt = runtime.get(sid) || { codes: 0, restarts: [], timers: {} }
  Object.assign(rt, { child, state: 'starting', stopping: false, logStream })
  runtime.set(sid, rt)
  log(`▶️ بدأت الجلسة ${sid} (${mask(s.number)})`)

  child.on('message', (msg) => onChildMessage(sid, msg).catch((e) => log('⚠️', e.message)))
  child.on('exit', (code) => onChildExit(sid, code).catch((e) => log('⚠️', e.message)))
}

async function onChildMessage(sid, msg) {
  if (msg?.type === 'ipcres') {
    const p = pendingIPC.get(msg.reqId)
    if (p) { clearTimeout(p.timer); pendingIPC.delete(msg.reqId); p.resolve(msg.data) }
    return
  }
  const s = store.sessions[sid]
  const rt = runtime.get(sid)
  if (!s || !rt) return

  if (msg.type === 'pairing-code' && s.status === 'pending') {
    clearTimeout(rt.timers.code)
    rt.state = 'pairing'
    rt.codes++
    if (rt.codes > MAX_CODES) return failPending(sid, 'اتطلب أكتر من كود ومحصلش ربط.')
    if (rt.codeMsgId) del(s.chatId, rt.codeMsgId)
    const m = await send(s.chatId,
      `🔑 <b>كود الربط</b>${rt.codes > 1 ? ` (كود جديد ${rt.codes}/${MAX_CODES})` : ''}\n${LINE}\n` +
      `<code>${esc(msg.code)}</code>   👈 اضغط عليه للنسخ\n📱 للرقم: <b>+${esc(s.number)}</b>\n${LINE}\n` +
      `1️⃣ افتح واتساب على الرقم ده\n2️⃣ الإعدادات ← الأجهزة المرتبطة ← ربط جهاز\n` +
      `3️⃣ اختار «الربط برقم الهاتف بدلًا من ذلك»\n4️⃣ اكتب الكود\n\n⏳ الكود صالح لدقايق قليلة`,
      kb([[btn('❌ إلغاء الربط', `s:${sid}:cancel`, 'danger')]]))
    rt.codeMsgId = m?.message_id || null
  }

  if (msg.type === 'open') {
    rt.state = 'online'
    if (s.status === 'pending') {
      clearTimeout(rt.timers.code); clearTimeout(rt.timers.total)
      s.status = 'linked'
      s.linkedAt = Date.now()
      saveStore()
      if (rt.codeMsgId) del(s.chatId, rt.codeMsgId)
      await send(s.chatId,
        `✅ <b>تم الربط بنجاح!</b>\n${LINE}\nرقمك <b>+${esc(s.number)}</b> شغّال دلوقتي على MR JOO 🎖️\n\n` +
        `جرّب ابعت <code>.قائمة</code> من واتساب في أي شات أو مجموعة.\n\n` +
        `💡 الأوامر بتتنفذ من الحساب المربوط نفسه، ولأوامر الإدارة لازم يكون مشرف في المجموعة.`,
        kb([[btn('📱 جلساتي', 'list', 'primary')]]))
    }
  }

  if (msg.type === 'logged-out') {
    rt.stopping = true
    await send(s.chatId, `⚠️ تم فصل الجهاز من واتساب (رقم <b>+${esc(s.number)}</b>) فتم حذف الجلسة.\nتقدر تربط من جديد في أي وقت.`,
      kb([[btn('🔗 ربط رقم جديد', 'link', 'primary')]]))
    const u = store.users[s.tgId]
    for (const a of ADMIN_IDS) {
      send(a,
        `⚠️ <b>عضو فك الربط من واتساب بنفسه</b>\n${LINE}\n` +
        `👤 ${esc(u?.name || s.tgId)} (<code>${s.tgId}</code>)\n📱 ${mask(s.number)}\n⏰ ${fmtDate(Date.now())}\n\n` +
        `<i>الفك تم من واتساب على موبايله مباشرة — الجلسة اتحذفت تلقائيًا.</i>`)
    }
    setTimeout(() => destroySession(sid, { logout: false }), 1000)
  }
}

async function onChildExit(sid, code) {
  const rt = runtime.get(sid)
  const s = store.sessions[sid]
  if (!rt) return
  try { rt.logStream?.end() } catch { }
  const wasStopping = rt.stopping
  runtime.delete(sid)
  clearTimeout(rt.timers?.code); clearTimeout(rt.timers?.total)
  log(`⏹ انتهت الجلسة ${sid} (code=${code})`)
  if (!s || wasStopping) return

  if (s.status === 'pending') return failPending(sid, 'حصل خطأ أثناء الاتصال بواتساب.')

  const now = Date.now()
  const hist = (restartLog.get(sid) || []).filter((t) => now - t < 600_000)
  if (hist.length >= 5) {
    restartLog.delete(sid)
    s.status = 'stopped'; saveStore()
    send(s.chatId, `⚠️ جلسة <b>+${esc(s.number)}</b> بتتعطل باستمرار فاتوقفت. جرّب تشغيلها من «جلساتي».`)
    for (const a of ADMIN_IDS) send(a, `⚠️ الجلسة ${esc(sid)} (${mask(s.number)}) تعطلت 5 مرات وتم إيقافها.`)
    return
  }
  hist.push(now)
  restartLog.set(sid, hist)
  setTimeout(() => {
    const cur = store.sessions[sid]
    if (cur && cur.status === 'linked' && !runtime.has(sid) && hasAccess(cur.tgId)) spawnSession(sid)
  }, 3000 * hist.length)
}

async function failPending(sid, reason) {
  const s = store.sessions[sid]
  if (!s || s.status !== 'pending') return
  log(`✖ فشل ربط ${sid}: ${reason}`)
  await send(s.chatId, `❌ <b>لم يكتمل الربط</b>\n${esc(reason)}\nتأكد من الرقم وجرّب تاني.`, kb([[btn('🔗 محاولة جديدة', 'link', 'primary')]]))
  await destroySession(sid, { logout: false })
}

function stopProcess(sid, { logout = false } = {}) {
  const rt = runtime.get(sid)
  if (!rt?.child) { runtime.delete(sid); return Promise.resolve() }
  rt.stopping = true
  clearTimeout(rt.timers?.code); clearTimeout(rt.timers?.total)
  return new Promise((resolve) => {
    const child = rt.child
    const kill = setTimeout(() => { try { child.kill('SIGKILL') } catch { } }, logout ? 10_000 : 4_000)
    child.once('exit', () => { clearTimeout(kill); resolve() })
    try { child.send({ type: logout ? 'logout' : 'shutdown' }) } catch { try { child.kill() } catch { } }
  })
}

async function destroySession(sid, { logout = true } = {}) {
  const s = store.sessions[sid]
  await stopProcess(sid, { logout: logout && s?.status === 'linked' })
  runtime.delete(sid)
  delete store.sessions[sid]
  for (const [k, v] of Object.entries(store.unlinkReqs || {})) if (v.sid === sid) delete store.unlinkReqs[k]
  saveStore()
  try { fs.rmSync(sessionDir(sid), { recursive: true, force: true }) } catch { }
  try { fs.rmSync(path.join(DATA_DIR, 'logs', `${sid}.log`), { force: true }) } catch { }
}

// ───────────────────────── ربط رقم جديد ─────────────────────────
function normalizeNumber(raw) {
  let n = String(raw).replace(/[\s\-()+]/g, '')
  n = toEnDigits(n)
  if (!/^\d+$/.test(n)) return null
  if (n.startsWith('00')) n = n.slice(2)
  else if (n.startsWith('0') && DEFAULT_CC) n = DEFAULT_CC + n.slice(1)
  return n.length >= 8 && n.length <= 15 ? n : null
}

async function startLink(user, chatId, rawNumber) {
  const uid = String(user.id)
  const number = normalizeNumber(rawNumber)
  if (!number) {
    return send(chatId, `❌ الرقم غير صحيح.\nاكتبه بكود الدولة وبدون +، مثال: <code>201012345678</code>\n(أو /cancel للإلغاء)`)
  }
  awaiting.delete(uid)

  if (!hasAccess(uid)) return show(chatId, null, gateScreen(uid))
  if (userSessions(uid).some((x) => x.status === 'pending')) {
    return send(chatId, '⏳ عندك عملية ربط شغّالة بالفعل. كمّلها أو الغيها الأول.', kb([[btn('📱 جلساتي', 'list')]]))
  }
  const mine = userSessions(uid).length
  if (!isAdmin(uid) && mine >= MAX_PER_USER) {
    return send(chatId, `⚠️ وصلت للحد الأقصى (${MAX_PER_USER}) من الجلسات. احذف جلسة قديمة الأول.`, kb([[btn('📱 جلساتي', 'list')]]))
  }
  if (Object.keys(store.sessions).length >= MAX_TOTAL) {
    return send(chatId, '⚠️ السيرفر وصل للحد الأقصى من الجلسات حاليًا. جرّب بعدين.')
  }
  if (Object.values(store.sessions).some((x) => x.number === number)) {
    return send(chatId, '⚠️ الرقم ده مربوط بالفعل في جلسة موجودة.')
  }
  const now = Date.now()
  if (!isAdmin(uid) && now - (lastLink.user.get(uid) || 0) < USER_COOLDOWN) {
    return send(chatId, '⏳ استنى شوية قبل المحاولة التالية.')
  }
  if (now - (lastLink.number.get(number) || 0) < NUMBER_COOLDOWN) {
    return send(chatId, '⏳ اتعملت محاولة ربط لنفس الرقم حالًا. استنى كام دقيقة وجرّب تاني.')
  }
  lastLink.user.set(uid, now)
  lastLink.number.set(number, now)

  const sid = `${uid}-${now.toString(36)}`
  store.sessions[sid] = { id: sid, tgId: uid, chatId: String(chatId), number, status: 'pending', createdAt: now }
  saveStore()
  const info = await send(chatId, `🔄 جاري طلب كود الربط للرقم <b>+${esc(number)}</b> ...`)
  spawnSession(sid)
  const rt = runtime.get(sid)
  if (rt) {
    rt.timers.code = setTimeout(() => failPending(sid, 'مظهرش كود الربط (تعذر الاتصال بواتساب).'), PAIR_CODE_TIMEOUT)
    rt.timers.total = setTimeout(() => failPending(sid, 'انتهت مهلة الربط.'), PAIR_TOTAL_TIMEOUT)
  }
  return info
}

// ───────────────────────── الشاشات (المستخدم) ─────────────────────────
const linkPrompt =
  `📱 <b>ربط رقم جديد</b>\n${LINE}\n<blockquote>ابعت رقم واتساب بكود الدولة وبدون +\nمثال: <code>201012345678</code>\n(لو كتبته بصيغة 010... هضيف كود الدولة تلقائيًا)</blockquote>\nللإلغاء: /cancel`

const helpText =
  `❓ <b>المساعدة</b>\n${LINE}\n` +
  `🔗 <b>ربط رقم جديد</b> ← تبعت رقمك، وتاخد كود تكتبه في واتساب (الأجهزة المرتبطة).\n` +
  `📱 <b>جلساتي</b> ← إيقاف / تشغيل / حذف جلستك.\n` +
  `💎 <b>اشتراكي</b> ← حالة اشتراكك والوقت المتبقي (عد تنازلي) وإدخال كود الاشتراك.\n\n` +
  `بعد الربط ابعت <code>.قائمة</code> من واتساب لعرض الأوامر.\n\n` +
  `<blockquote expandable>⚠️ البوت بيستخدم واجهة غير رسمية لواتساب، وفيه احتمال (ولو قليل) إن واتساب يقيّد الرقم. الأفضل تستخدم رقم مخصص للبوت.\n` +
  `🔒 إحنا مبنطلبش أي كلمة سر، وتقدر تفصل الجهاز في أي وقت من واتساب أو من هنا.</blockquote>\n` +
  `أوامر: /start /link /sessions /sub /code /cancel /id`

let BOT_USERNAME = null

function botLinkScreen() {
  const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=link` : null
  const text =
    `🔗 <b>رابط البوت</b>\n${LINE}\n` +
    (link
      ? `<code>${link}</code>\n\n` +
        `<b>اللي بيحصل لما حد يفتحه:</b>\n1️⃣ بيتفتح له البوت على وضع الربط مباشرة\n2️⃣ يكتب رقم واتساب بتاعه\n3️⃣ ياخد كود الربط ويكتبه في واتساب\n\n` +
        `<blockquote>💡 ابعت الرابط ده لأي مشرف جروب وهو يدوس عليه — هيربط رقمه عندك من غير ما يتعب نفسه في القايمات.\nملاحظة: واتساب بيشترط كتابة كود الربط من صاحب الرقم نفسه في واتساب (الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف) — دي حماية التشفير عنده ومستحيل تتخطى بأي رابط.</blockquote>`
      : '⚠️ تعذر جلب اسم البوت من تليجرام.')
  return {
    text,
    extra: kb([
      ...(link ? [[urlBtn('🔗 فتح الرابط', link, 'primary')]] : []),
      [btn('📋 نسخ الرابط', 'a:botlinkcopy')],
      [btn('⬅️ رجوع', 'a:panel')],
    ]),
  }
}

function unlinkReqsScreen() {
  const reqs = Object.values(store.unlinkReqs).sort((a, b) => b.at - a.at)
  let text = `🔓 <b>طلبات فك الرابط</b> (${reqs.length})\n${LINE}\n`
  const rows = []
  if (!reqs.length) text += '<blockquote>مفيش طلبات مستنية موافقتك.</blockquote>\n'
  reqs.slice(0, 15).forEach((r, i) => {
    const sess = store.sessions[r.sid]
    const live = sess ? (runtime.has(r.sid) ? '🟢 شغّالة' : '🔴 متوقفة') : '⚪ مش موجودة'
    text += `${i + 1}. ${esc(store.users[r.tgId]?.name || r.tgId)} — ${mask(r.number)} (${live})\n    ⏰ طلبها ${fmtDate(r.at)}\n`
    rows.push([
      btn(`✅ موافقة ${i + 1}`, `a:ulok:${r.id}`, 'success'),
      btn(`❌ رفض ${i + 1}`, `a:ulno:${r.id}`, 'danger'),
    ])
  })
  rows.push([btn('⬅️ رجوع', 'a:panel')])
  return { text, extra: kb(rows) }
}

function planLine(uid) {
  if (isAdmin(uid)) return '👑 <b>مسؤول</b> — وصول كامل'
  const s = subOf(uid)
  if (s) return s.expiresAt === null ? '💎 <b>مشترك</b> — اشتراك دائم ♾' : `💎 <b>مشترك</b> — باقي ${fmtShort(s.expiresAt - Date.now())}`
  return '🆓 <b>مجاني</b>'
}

function homeScreen(user) {
  const uid = String(user.id)
  const mine = userSessions(uid)
  const on = mine.filter((s) => runtime.get(s.id)?.state === 'online').length
  const text =
    `🎖️ <b>MR_JOO</b>\n${LINE}\n` +
    `أهلًا <b>${esc(user.name)}</b> 👋\n` +
    `<blockquote>حماية • إدارة • موسيقى — لواتساب بتاعك، بنظام حديث وسهل.</blockquote>\n` +
    `👤 الحساب: ${planLine(uid)}\n` +
    `📱 الجلسات: ${mine.length ? `🟢 ${on} شغّالة من ${mine.length}` : 'لسه مفيش — اربط رقمك للبدء'}\n\n` +
    `اختار من تحت 👇`
  const showSub = isPaid() || !!subOf(uid) || !!store.users[uid]?.lastExpiredAt
  return {
    text, photo: IMGS.home,
    extra: kb([
      [btn('🔗 ربط رقم جديد', 'link', 'primary'), btn('📱 جلساتي', 'list')],
      [...(showSub && !isAdmin(uid) ? [btn('💎 اشتراكي', 'sub')] : []), btn('❓ المساعدة', 'help')],
      ...(isAdmin(uid) ? [[btn('🛠 لوحة الأدمن', 'a:panel', 'success')]] : []),
    ]),
  }
}

function gateScreen(uid) {
  const expired = store.users[String(uid)]?.lastExpiredAt
  const text =
    `💎 <b>البوت بنظام الاشتراك</b>\n${LINE}\n` +
    `<blockquote>🔒 لازم تشترك في البوت ده علشان تقدر تستخدمه.</blockquote>\n` +
    (expired ? `⌛ انتهى اشتراكك السابق بتاريخ <b>${fmtDate(expired)}</b>\n\n` : '') +
    `1️⃣ تواصل مع الأدمن للاشتراك\n2️⃣ هيبعتلك <b>كود اشتراك</b>\n3️⃣ اضغط «إدخال كود الاشتراك» واكتب الكود\n\n` +
    `✅ لو عندك اشتراك فعّال بيتفعل تلقائيًا ومش بتحتاج تدخل الكود كل مرة.`
  return {
    text, photo: IMGS.gate,
    extra: kb([
      [btn('🎟 إدخال كود الاشتراك', 'code', 'primary')],
      contactRow(),
      [btn('🆔 معرفي', 'myid'), btn('❓ المساعدة', 'help')],
    ]),
  }
}

const codePromptScreen = () => ({
  text: `🎟 <b>إدخال كود الاشتراك</b>\n${LINE}\n<blockquote>اكتب كود الاشتراك اللي وصلك من الأدمن في رسالة هنا.\nمثال: <code>CMD-AB12-CD34-EF56</code></blockquote>\nللإلغاء: /cancel`,
  extra: kb([[btn('↩️ رجوع', 'home')]]),
})

function subScreen(uid, header = '') {
  const u = store.users[String(uid)]
  const s = subOf(uid)
  let body
  if (isAdmin(uid)) body = `👑 أنت <b>مسؤول</b> — وصول كامل ودائم، مش محتاج اشتراك.`
  else if (s && s.expiresAt === null) body = `💎 <b>اشتراك دائم</b> ♾\n📅 بدأ: ${fmtDate(s.startedAt)}\n\n✨ استمتع بكل المزايا بدون حد زمني.`
  else if (s) {
    const left = s.expiresAt - Date.now()
    const frac = s.totalMs ? left / s.totalMs : 1
    body =
      `💎 <b>اشتراك فعّال</b>\n\n⏳ <b>الوقت المتبقي</b>\n${fmtClock(left)}\n\n` +
      `${bar(frac)} <b>${Math.max(0, Math.round(frac * 100))}%</b>\n\n` +
      `📅 بدأ: ${fmtDate(s.startedAt)}\n🏁 ينتهي: <b>${fmtDate(s.expiresAt)}</b>\n\n` +
      `<i>لما الوقت يخلص الاشتراك بيتلغي تلقائيًا وبتتلغى جلستك معاه.</i>`
  } else if (!isPaid()) body = `🆓 البوت <b>مجاني</b> حاليًا — مش محتاج اشتراك.`
  else body = `🔒 <b>مفيش اشتراك فعّال</b>` + (u?.lastExpiredAt ? `\n⌛ انتهى اشتراكك في ${fmtDate(u.lastExpiredAt)}` : '') + `\n\nتواصل مع الأدمن واطلب كود اشتراك.`
  const live = s && s.expiresAt !== null && !isAdmin(uid)
  return {
    text: `${header}💎 <b>اشتراكي</b>\n${LINE}\n${body}`,
    extra: kb([
      [...(live ? [btn('🔄 تحديث', 'sub')] : []), ...(!isAdmin(uid) ? [btn('🎟 ' + (s ? 'تجديد بكود' : 'إدخال كود'), 'code', 'primary')] : [])],
      !s && !isAdmin(uid) ? contactRow() : [],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  }
}

function sessionsScreen(uid) {
  const list = userSessions(uid)
  let text = `📱 <b>جلساتي</b>\n${LINE}\n`
  const rows = []
  if (!list.length) text += '<blockquote>مفيش جلسات لسه.\nاضغط «ربط رقم جديد» للبدء.</blockquote>'
  for (const s of list) {
    const st = statusOf(s)
    text += `${st.icon} <b>+${esc(s.number)}</b> — ${st.text}\n`
    if (s.status === 'pending') rows.push([btn(`❌ إلغاء الربط +${s.number.slice(-4)}`, `s:${s.id}:cancel`, 'danger')])
    else rows.push([
      runtime.has(s.id) ? btn('⏹ إيقاف', `s:${s.id}:stop`) : btn('▶️ تشغيل', `s:${s.id}:start`, 'success'),
      btn('🗑 حذف', `s:${s.id}:del`, 'danger'),
    ])
  }
  rows.push([btn('🔗 ربط رقم جديد', 'link', 'primary'), btn('🏠 الرئيسية', 'home')])
  return { text, extra: kb(rows) }
}

// ───────────────────────── الشاشات (لوحة الأدمن) ─────────────────────────
const modeName = () => (isPaid() ? '💎 باشتراك' : '🆓 مجاني')
const activeSubs = () => Object.values(store.users).filter((u) => u.sub && subOf(u.id))
const unusedCodes = () => Object.values(store.codes).filter((c) => !c.usedBy).sort((a, b) => b.createdAt - a.createdAt)

function panelScreen() {
  const all = Object.values(store.sessions)
  const online = all.filter((s) => runtime.get(s.id)?.state === 'online').length
  const pending = all.filter((s) => s.status === 'pending').length
  const mem = Math.round(process.memoryUsage().rss / 1048576)
  const ulPend = Object.keys(store.unlinkReqs).length
  const text =
    `🛠 <b>لوحة الأدمن</b>\n${LINE}\n` +
    `💳 النظام: <b>${modeName()}</b>\n` +
    `👥 المستخدمين: <b>${Object.keys(store.users).length}</b>   💎 المشتركين: <b>${activeSubs().length}</b>   🎟 أكواد متاحة: <b>${unusedCodes().length}</b>\n` +
    `📱 الجلسات: <b>${all.length}</b> / ${MAX_TOTAL}\n🟢 شغّالة: <b>${online}</b>   🟡 قيد الربط: <b>${pending}</b>   🔴 متوقفة: <b>${all.length - online - pending}</b>\n` +
    `🔓 طلبات فك ربط مستنية: <b>${ulPend}</b>\n` +
    `💾 ذاكرة المدير: ${mem}MB\n${LINE}\n` +
    `<blockquote expandable>/grant ID المدة — منح اشتراك مباشر (30d / 12h / دائم)\n/revoke ID — إلغاء اشتراك\n/gen المدة [العدد] — إنشاء أكواد\n/mode free|paid — تغيير النظام\n/ban ID  /unban ID  /stop SID  /remove SID\n/broadcast نص</blockquote>`
  return {
    text, photo: IMGS.admin,
    extra: kb([
      [btn(`💳 نظام البوت: ${modeName()} — تغيير`, 'a:mode', 'primary')],
      [btn('🎛️ تحكم الأوامر', 'a:cmds', 'primary')],
      [btn('📋 عرض الجروبات', 'a:groups', 'primary')],
      [btn('🔗 رابط البوت', 'a:botlink', 'primary')],
      [btn('🎟 إنشاء كود', 'a:gen', 'success'), btn('🗂 الأكواد', 'a:clist')],
      [btn('💎 المشتركين', 'a:subs'), btn('👥 المستخدمين', 'a:users')],
      [btn('📱 كل الجلسات', 'a:sessions')],
      ...(ulPend ? [[btn(`🔓 طلبات فك الرابط (${ulPend})`, 'a:ulreqs', 'primary')]] : []),
      [btn('🔄 تحديث', 'a:panel'), btn('🏠 الرئيسية', 'home')],
    ]),
  }
}

function modeScreen() {
  const paid = isPaid()
  return {
    text:
      `💳 <b>نظام البوت</b>\n${LINE}\nالحالة الحالية: <b>${modeName()}</b>\n\n` +
      `🆓 <b>مجاني</b> — أي مستخدم يقدر يستخدم البوت.\n` +
      `💎 <b>باشتراك</b> — المستخدم يشوف إن البوت بالاشتراك، ويتواصل معاك، ويدخل <b>كود اشتراك</b> عشان يشتغل. أنت (المسؤول) مستثنى دايمًا.\n\n` +
      `<i>اختيار «باشتراك» بيوقف جلسات اللي مالهمش اشتراك مؤقتًا (من غير حذف)، وبترجع تلقائيًا لما يشتركوا.</i>`,
    extra: kb([
      [btn(`${paid ? '' : '✅ '}🆓 مجاني`, 'a:mode:free', paid ? undefined : 'success'), btn(`${paid ? '✅ ' : ''}💎 باشتراك`, 'a:mode:paid', paid ? 'success' : 'primary')],
      [btn('⬅️ رجوع', 'a:panel')],
    ]),
  }
}

function lockedUsersCount() {
  return Object.values(store.users).filter((u) => !isAdmin(u.id) && !subOf(u.id) && userSessions(u.id).length).length
}

function genDurScreen() {
  const P = [['⏱ ساعة', 60], ['📅 يوم', 1440], ['📅 3 أيام', 4320], ['📅 7 أيام', 10080], ['📅 30 يوم', 43200], ['📅 90 يوم', 129600], ['📅 سنة', 525600]]
  const rows = []
  for (let i = 0; i < P.length; i += 2) rows.push(P.slice(i, i + 2).map(([t, m]) => btn(t, `a:gen:${m}`)))
  rows.push([btn('♾ دائم', 'a:gen:perm', 'success'), btn('✏️ مدة مخصصة', 'a:gencustom', 'primary')])
  rows.push([btn('⬅️ رجوع', 'a:panel')])
  return { text: `🎟 <b>إنشاء كود اشتراك</b>\n${LINE}\nاختار <b>مدة الاشتراك</b> اللي الكود هيديها:`, extra: kb(rows) }
}
const keyToMs = (k) => (k === 'perm' ? null : Number(k) * MIN)
function genCountScreen(key) {
  return {
    text: `🎟 <b>إنشاء كود اشتراك</b>\n${LINE}\nالمدة: <b>${spanLabel(keyToMs(key))}</b>\nكام كود تعمل؟`,
    extra: kb([
      [1, 3, 5, 10, 20].map((n) => btn(String(n), `a:gen:${key}:${n}`, n === 1 ? 'primary' : undefined)),
      [btn('⬅️ تغيير المدة', 'a:gen')],
    ]),
  }
}
function makeCodes(key, n, adminId) {
  const ms = keyToMs(key)
  const out = []
  for (let i = 0; i < n; i++) {
    const code = genCode()
    store.codes[code] = { code, durationMs: ms, createdAt: Date.now(), createdBy: String(adminId), usedBy: null, usedAt: null }
    out.push(code)
  }
  saveStore()
  return out
}
const codesMessage = (codes, ms) =>
  `✅ <b>تم إنشاء ${codes.length} ${codes.length === 1 ? 'كود' : 'أكواد'}</b>\n${LINE}\n⏳ المدة: <b>${spanLabel(ms)}</b>\n\n` +
  codes.map((c) => `<code>${c}</code>`).join('\n') +
  `\n\n👆 اضغط على الكود للنسخ وابعته للمشترك.\n<i>كل كود يُستخدم مرة واحدة فقط.</i>`

function codesListScreen() {
  const free = unusedCodes()
  const used = Object.values(store.codes).filter((c) => c.usedBy).sort((a, b) => b.usedAt - a.usedAt)
  let text = `🗂 <b>الأكواد</b>\n${LINE}\n🆕 متاحة: <b>${free.length}</b>   ✅ مستخدمة: <b>${used.length}</b>\n\n`
  const rows = []
  const shown = free.slice(0, 15)
  if (!shown.length) text += '<blockquote>مفيش أكواد متاحة. اضغط «إنشاء كود».</blockquote>\n'
  shown.forEach((c, i) => { text += `${i + 1}. <code>${c.code}</code> — ${spanLabel(c.durationMs)}\n` })
  for (let i = 0; i < shown.length; i += 5) rows.push(shown.slice(i, i + 5).map((c, j) => btn(`🗑 ${i + j + 1}`, `a:cdel:${c.code}`, 'danger')))
  if (free.length > shown.length) text += `<i>… و ${free.length - shown.length} كود تاني</i>\n`
  if (used.length) {
    text += `\n<b>آخر المستخدمة:</b>\n`
    for (const c of used.slice(0, 5)) text += `• ${esc(store.users[c.usedBy]?.name || c.usedBy)} — ${spanLabel(c.durationMs)} — ${fmtDate(c.usedAt)}\n`
  }
  rows.push([btn('➕ إنشاء كود', 'a:gen', 'success'), btn('⬅️ رجوع', 'a:panel')])
  return { text, extra: kb(rows) }
}

function subsScreen() {
  const subs = activeSubs().sort((a, b) => (a.sub.expiresAt ?? Infinity) - (b.sub.expiresAt ?? Infinity))
  let text = `💎 <b>المشتركين</b> (${subs.length})\n${LINE}\n`
  const rows = []
  if (!subs.length) text += '<blockquote>مفيش مشتركين فعّالين حاليًا.</blockquote>\n'
  const shown = subs.slice(0, 15)
  shown.forEach((u, i) => {
    text += `${i + 1}. ${esc(u.name)}${u.username ? ' @' + esc(u.username) : ''} — <code>${u.id}</code>\n    ${u.sub.expiresAt === null ? '♾ دائم' : `⏳ ${fmtShort(u.sub.expiresAt - Date.now())}`}\n`
  })
  for (let i = 0; i < shown.length; i += 5) rows.push(shown.slice(i, i + 5).map((u, j) => btn(`❌ ${i + j + 1}`, `a:subrm:${u.id}`, 'danger')))
  if (subs.length > shown.length) text += `<i>… و ${subs.length - shown.length} تاني</i>\n`
  text += `\n<i>لمنح اشتراك مباشر: /grant ID 30d</i>`
  rows.push([btn('⬅️ رجوع', 'a:panel')])
  return { text, extra: kb(rows) }
}

function adminSessionsView() {
  const all = Object.values(store.sessions)
  let text = `📱 <b>كل الجلسات</b> (${all.length})\n${LINE}\n`
  const rows = []
  if (!all.length) text += 'لا توجد جلسات.'
  for (const s of all.slice(0, 20)) {
    const u = store.users[s.tgId]
    const st = statusOf(s)
    text += `${st.icon} ${mask(s.number)} — ${esc(u?.name || s.tgId)}\n<code>${esc(s.id)}</code>\n`
    rows.push([
      btn(`⏹ ${s.number.slice(-4)}`, `a:stop:${s.id}`),
      btn(`🗑 ${s.number.slice(-4)}`, `a:rm:${s.id}`, 'danger'),
    ])
  }
  rows.push([btn('⬅️ رجوع', 'a:panel')])
  return { text, extra: kb(rows) }
}

function adminUsersView() {
  const users = Object.values(store.users)
  let text = `👥 <b>المستخدمين</b> (${users.length})\n${LINE}\n`
  for (const u of users.slice(-30)) {
    text += `${u.banned ? '⛔' : subOf(u.id) ? '💎' : '👤'} ${esc(u.name)}${u.username ? ' @' + esc(u.username) : ''} — <code>${u.id}</code> — ${userSessions(u.id).length} جلسة\n`
  }
  return { text, extra: kb([[btn('⬅️ رجوع', 'a:panel')]]) }
}

const pendingCmd = new Map()

const cmdRulesOf = (tgId) => (store.cmdrules[tgId] ||= { def: 'allow', rules: {} })
const liveCmdRules = (tgId) => {
  const r = cmdRulesOf(tgId)
  const now = Date.now()
  return { def: r.def, entries: Object.entries(r.rules || {}).filter(([, v]) => !v.until || v.until > now) }
}

function pushCmdRules(tgId) {
  const rules = cmdRulesOf(tgId)
  for (const s of userSessions(tgId)) {
    const rt = runtime.get(s.id)
    if (rt?.child) { try { rt.child.send({ type: 'cmdrules', rules }) } catch { } }
  }
}

function applyCmdRule(tgId, cmd, mode, ms) {
  const r = cmdRulesOf(tgId)
  r.rules[cmd] = { mode, until: ms === null || ms === undefined ? null : Date.now() + ms }
  saveStore(); pushCmdRules(tgId)
  return r.rules[cmd]
}

function cmdsScreen() {
  const withSessions = [...new Set(Object.values(store.sessions).map((s) => s.tgId))]
  let text =
    `🎛️ <b>تحكم الأوامر</b>\n${LINE}\n` +
    `اختار العضو عشان تضبط أوامر البوت بتاعه:\n\n` +
    `<blockquote>✅ <b>سماح</b> — الأمر شغّال عنده لمدة تحددها\n⛔ <b>منع</b> — الأمر متوقف عنده\n🔓 <b>افتراضي مفتوح</b> — كل الأوامر شغّالة\n🔒 <b>افتراضي مقفول</b> — بس اللي تسمح به</blockquote>`
  const rows = []
  if (!withSessions.length) text += '\nمفيش أعضاء مربطين لسه.'
  for (const tgId of withSessions.slice(0, 20)) {
    const u = store.users[tgId]
    const live = liveCmdRules(tgId)
    rows.push([btn(`${live.def === 'block' ? '🔒' : '🔓'} ${esc(u?.name || tgId)}${live.entries.length ? ` · ${live.entries.length} أمر` : ''}`, `a:cuser:${tgId}`)])
  }
  rows.push([btn('⬅️ رجوع', 'a:panel')])
  return { text, extra: kb(rows) }
}

function cmdsUserScreen(tgId) {
  const u = store.users[tgId]
  const live = liveCmdRules(tgId)
  let text =
    `🎛️ <b>تحكم الأوامر — ${esc(u?.name || tgId)}</b>\n${LINE}\n` +
    `الوضع الافتراضي: <b>${live.def === 'block' ? '🔒 مقفول — بس الأوامر المسموح بها شغّالة' : '🔓 مفتوح — كل الأوامر شغّالة'}</b>\n\n`
  const rows = []
  if (!live.entries.length) {
    text += '<blockquote>مفيش أوامر مضبوطة للعضو ده.\nاضغط «➕ إضافة أمر» للتحكم في أمر معين بمدة محددة.</blockquote>\n'
  } else {
    text += '<b>الأوامر المضبوطة:</b>\n'
    live.entries.forEach(([cmd, v], i) => {
      text += `${i + 1}. ${v.mode === 'allow' ? '✅' : '⛔'} <code>${esc(cmd)}</code> — ${v.until === null ? '♾ دائم' : `⏳ باقي ${fmtShort(v.until - Date.now())}`}\n`
    })
    for (let i = 0; i < live.entries.length; i += 5)
      rows.push(live.entries.slice(i, i + 5).map((_, j) => btn(`🗑 ${i + j + 1}`, `a:crmv:${tgId}:${i + j}`, 'danger')))
  }
  rows.push([btn('➕ إضافة أمر', `a:cadd:${tgId}`, 'primary')])
  rows.push([btn(live.def === 'block' ? '🔓 فتح كل الأوامر افتراضيًا' : '🔒 قفل كل الأوامر افتراضيًا', `a:cdef:${tgId}:${live.def === 'block' ? 'allow' : 'block'}`, 'primary')])
  if (live.entries.length) rows.push([btn('🗑 مسح كل القواعد', `a:cclear:${tgId}`, 'danger')])
  rows.push([btn('⬅️ رجوع', 'a:cmds')])
  return { text, extra: kb(rows) }
}

const cmdNamePrompt = (tgId) => {
  const u = store.users[tgId]
  return `✏️ <b>إضافة أمر</b>\n${LINE}\nالعضو: <b>${esc(u?.name || tgId)}</b>\n\n<blockquote>اكتب اسم الأمر زي ما بيتبعت في واتساب (من غير النقطة):\n<code>شاهد</code> — <code>تشغيل</code> — <code>طرد</code></blockquote>\nللإلغاء: /cancel`
}

function cmdModeScreen(uid) {
  const p = pendingCmd.get(uid)
  if (!p) return cmdsScreen()
  const u = store.users[p.tgId]
  return {
    text: `🎛️ <b>تحكم الأوامر</b>\n${LINE}\nالعضو: <b>${esc(u?.name || p.tgId)}</b>\nالأمر: <code>${esc(p.cmd)}</code>\n\nاختار الإجراء:`,
    extra: kb([
      [btn('✅ السماح بالأمر', 'a:cgo:allow', 'success'), btn('⛔ منع الأمر', 'a:cgo:block', 'danger')],
      [btn('⬅️ رجوع', `a:cuser:${p.tgId}`)],
    ]),
  }
}

function cmdDurScreen(uid) {
  const p = pendingCmd.get(uid)
  if (!p) return cmdsScreen()
  const P = [['⏱ ساعة', 60], ['📅 يوم', 1440], ['📅 3 أيام', 4320], ['📅 7 أيام', 10080], ['📅 30 يوم', 43200], ['♾ دائم', 'perm']]
  const rows = []
  for (let i = 0; i < P.length; i += 3) rows.push(P.slice(i, i + 3).map(([t, m]) => btn(t, `a:cdur:${m}`)))
  rows.push([btn('✏️ مدة مخصصة', 'a:cdurcustom', 'primary')])
  rows.push([btn('⬅️ رجوع', `a:cuser:${p.tgId}`)])
  return {
    text: `🎛️ <b>تحكم الأوامر</b>\n${LINE}\nالأمر: <code>${esc(p.cmd)}</code> — ${p.mode === 'allow' ? '✅ سماح' : '⛔ منع'}\n\nاختار المدة:`,
    extra: kb(rows),
  }
}

function finishCmdRule(uid, chatId, p, ms) {
  pendingCmd.delete(uid); awaiting.delete(uid)
  const rule = applyCmdRule(p.tgId, p.cmd, p.mode, ms)
  send(p.tgId, `⚙️ <b>تحديث صلاحيات بوتك</b>\n${LINE}\n${p.mode === 'allow' ? '✅ بقى مسموح' : '⛔ بقى ممنوع'} استخدام الأمر <code>.${esc(p.cmd)}</code>\n${ms === null ? '♾ بشكل دائم' : `⏳ لمدة ${spanLabel(ms)} (حتى ${fmtDate(rule.until)})`}`)
  return show(chatId, null, cmdsUserScreen(p.tgId))
}

// ───────────────────────── 📋 عرض الجروبات + 👑 الترقية ─────────────────────────
function explainWgErr(err) {
  const t = String(err || '')
  if (/participant/i.test(t)) return '🚫 الرقم ده مش موجود في الجروب — لازم يكون عضو فيه الأول.'
  if (/admin|forbidden|not.?allowed|403|precondition|conflict/i.test(t))
    return '🚫 واتساب رفض الترقية: رقم الجلسة مش <b>مشرف</b> في الجروب ده.\nواتساب بيمنع أي رقم يبقى مشرف من غير مشرف موجود يعينه — دي قاعدة سيرفرات واتساب نفسها.'
  return '🚫 فشلت الترقية: <code>' + esc(t) + '</code>'
}

function memberExplain(s, g) {
  return (
    `🚫 <b>مفيش صلاحية في الجروب ده</b>\n${LINE}\n` +
    `رقم الجلسة <b>${mask(s.number)}</b> عضو عادي في «${esc(g.name)}» — ومينفعش يرقّي حد.\n\n` +
    `<blockquote>واتساب نفسه بيشترط أن الترقية تيجي من مشرف موجود في الجروب — القاعدة دي على سيرفراتهم ومفيش أي بوت يقدر يتخطاها.</blockquote>\n` +
    `<b>الحلول:</b>\n1️⃣ أي مشرف في الجروب يعيّن <b>رقم الجلسة</b> مشرف (إيد واحدة)\n2️⃣ بعد كده زرار «👑 ترقيتي أنا» هيشتغل هنا عادي`
  )
}

function groupsSessionsScreen() {
  const linked = Object.values(store.sessions).filter((s) => s.status === 'linked')
  let text = `📋 <b>عرض الجروبات</b>\n${LINE}\nاختار الجلسة اللي عايز تشوف جروباتها في واتساب:\n`
  const rows = linked.slice(0, 20).map((s) => [btn(`${mask(s.number)}`, `a:groups:${s.id}`)])
  if (!linked.length) text += 'مفيش جلسات مربوطة لسه.'
  rows.push([btn('⬅️ رجوع', 'a:panel')])
  return { text, extra: kb(rows) }
}

const GROUPS_PER_PAGE = 25

function groupsScreen(sid, page = 0) {
  const s = store.sessions[sid]
  const list = groupsCache.get(sid)?.list || []
  const pages = Math.max(1, Math.ceil(list.length / GROUPS_PER_PAGE))
  page = Math.min(Math.max(0, page), pages - 1)
  const admins = list.filter((g) => g.role !== 'member').length
  let text =
    `📋 <b>جروبات ${mask(s.number)}</b>\n${LINE}\n` +
    `👑 مشرف/مالك في: <b>${admins}</b> · 👤 عضو في: <b>${list.length - admins}</b> · الإجمالي: <b>${list.length}</b>\n\n` +
    `<i>الجروبات اللي فيها صلاحية فوق — الترقية شغّالة فيها.</i>\n\n`
  const rows = []
  const start = page * GROUPS_PER_PAGE
  const shown = list.slice(start, start + GROUPS_PER_PAGE)
  shown.forEach((g, i) => { text += `${start + i + 1}. ${g.role === 'member' ? '👤' : '👑'} ${esc(g.name)} — ${g.size} عضو\n` })
  if (!shown.length) text += '<blockquote>الحساب ده مش في أي جروب.</blockquote>\n'
  for (let i = 0; i < shown.length; i += 4) rows.push(shown.slice(i, i + 4).map((g, j) => btn(String(g.name).slice(0, 24), `a:gg:${sid}:${start + i + j}`)))
  if (pages > 1) {
    const nav = []
    if (page > 0) nav.push(btn('⬅️ السابق', `a:gpage:${sid}:${page - 1}`))
    nav.push(btn(`📄 ${page + 1} / ${pages}`, `a:gpage:${sid}:${page}`))
    if (page < pages - 1) nav.push(btn('التالي ➡️', `a:gpage:${sid}:${page + 1}`))
    rows.push(nav)
  }
  rows.push([btn('🔄 تحديث', `a:groups:${sid}`, 'primary')])
  rows.push([btn('⬅️ رجوع', 'a:panel')])
  return { text, extra: kb(rows) }
}

function groupDetailScreen(sid, idx, uid) {
  const g = groupsCache.get(sid)?.list?.[Number(idx)]
  if (!g) return groupsCache.get(sid) ? groupsScreen(sid, 0) : groupsSessionsScreen()
  const s = store.sessions[sid]
  const roleTxt = g.role === 'superadmin' ? '👑 مالك الجروب' : g.role === 'admin' ? '🛡️ مشرف' : '👤 عضو عادي'
  const myWa = store.adminWa?.[uid]
  return {
    text:
      `👥 <b>${esc(g.name)}</b>\n${LINE}\n` +
      `👥 الأعضاء: <b>${g.size}</b>\n` +
      `🎖️ مكانة ${mask(s?.number || '')} في الجروب: <b>${roleTxt}</b>\n` +
      (myWa ? `📱 رقمك الشخصي: <code>+${esc(myWa)}</code>` : '📱 رقمك الشخصي: <i>لسه مش متظبط — هيتطلب أول ترقية</i>') +
      `\n\n<blockquote>«👑 ترقيتي أنا» بتخلي رقم الجلسة (وهو مشرف هنا) يرقّي <b>رقمك الشخصي</b> مشرف جنب مشرفي الجروب — محدش بينزل من الإشراف.</blockquote>`,
    extra: kb([
      [btn('👑 ترقيتي أنا في الجروب', `a:gp:${sid}:${idx}:self`, 'success')],
      [btn('🔢 ترقية رقم معين', `a:gp:${sid}:${idx}:num`, 'primary')],
      [btn('🔗 رابط الجروب', `a:glink:${sid}:${idx}`, 'primary')],
      [btn(`📱 رقمي الشخصي${myWa ? ' (تغيير)' : ''}`, 'a:gmywa')],
      [btn('⬅️ رجوع', `a:groups:${sid}`)],
    ]),
  }
}

async function showGroupsList(chatId, mid, sid, isPhoto) {
  const s = store.sessions[sid]
  if (!s) return send(chatId, '❌ الجلسة دي مش موجودة.')
  if (!runtime.has(sid)) return send(chatId, '🔴 الجلسة دي مش شغّالة — شغّلها الأول.', kb([[btn('📱 كل الجلسات', 'a:sessions')]]))
  await show(chatId, mid, { text: `⏳ جارٍ جلب جروبات <b>${mask(s.number)}</b> من واتساب...` }, isPhoto)
  const r = await childReq(sid, { type: 'listgroups' }).catch((e) => ({ ok: false, error: e.message }))
  if (!r?.ok) return send(chatId, `❌ تعذر جلب الجروبات: ${esc(r?.error || 'خطأ غير معروف')}`, kb([[btn('🔁 حاول تاني', `a:groups:${sid}`), btn('⬅️ رجوع', 'a:panel')]]))
  const rank = { superadmin: 2, admin: 1, member: 0 }
  const list = [...(r.groups || [])].sort((a, b) => (rank[b.role] || 0) - (rank[a.role] || 0) || String(a.name).localeCompare(String(b.name), 'ar'))
  groupsCache.set(sid, { list, at: Date.now() })
  const scr = groupsScreen(sid, 0)
  return send(chatId, scr.text, scr.extra)
}

// ───────────────────────── معالجة التحديثات ─────────────────────────
function rememberUser(from) {
  const id = String(from.id)
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || id
  let u = store.users[id]
  if (!u) { u = store.users[id] = { id, banned: false, joinedAt: Date.now(), name, username: from.username || '' }; saveStore(); return u }
  if (u.name !== name || u.username !== (from.username || '')) { u.name = name; u.username = from.username || ''; saveStore() }
  return u
}

async function doRedeem(user, chatId, raw, userMsgId) {
  const uid = String(user.id)
  awaiting.delete(uid)
  if (userMsgId) del(chatId, userMsgId)
  const res = redeemCode(uid, raw)
  if (!res.ok) {
    return send(chatId, res.text, kb([[btn('🎟 حاول تاني', 'code', 'primary')], contactRow(), [btn('🏠 الرئيسية', 'home')]]))
  }
  resumeAccess(uid).catch(() => { })
  const m = await show(chatId, null, subScreen(uid, `🎉 <b>تم تفعيل الاشتراك بنجاح!</b>\n\n`))
  startTicker(uid, chatId, midOf(m))
  for (const a of ADMIN_IDS) {
    send(a, `🎟 <b>${esc(user.name)}</b> (<code>${uid}</code>) فعّل كود <code>${esc(res.code.code)}</code> — ${spanLabel(res.code.durationMs)}${res.renewed ? ' (تجديد)' : ''}`)
  }
}

async function adminCommand(cmd, arg, user, chatId) {
  const uid = String(user.id)
  if (cmd === 'admin') return show(chatId, null, panelScreen())
  if (cmd === 'users') return show(chatId, null, adminUsersView())
  if (cmd === 'ban' || cmd === 'unban') {
    const t = store.users[arg]
    if (!t) return send(chatId, '❌ مستخدم غير موجود. الصيغة: <code>/ban ID</code>')
    if (isAdmin(t.id)) return send(chatId, '❌ لا يمكن حظر مسؤول.')
    t.banned = cmd === 'ban'
    saveStore()
    if (t.banned) for (const s of userSessions(t.id)) await stopProcess(s.id)
    else resumeAccess(t.id).catch(() => { })
    return send(chatId, t.banned ? `⛔ تم حظر <b>${esc(t.name)}</b> وإيقاف جلساته.` : `✅ تم فك الحظر عن <b>${esc(t.name)}</b>.`)
  }
  if (cmd === 'stop' || cmd === 'remove') {
    if (!store.sessions[arg]) return send(chatId, `❌ جلسة غير موجودة. الصيغة: <code>/${cmd} SID</code> (الـ SID في «كل الجلسات»)`)
    const owner = store.sessions[arg].chatId
    if (cmd === 'stop') { await stopProcess(arg); if (store.sessions[arg].status === 'linked') { store.sessions[arg].status = 'stopped'; saveStore() } }
    else { await destroySession(arg); send(owner, '⚠️ تم حذف جلستك بواسطة المسؤول.') }
    return send(chatId, cmd === 'stop' ? '⏹ تم إيقاف الجلسة.' : '🗑 تم حذف الجلسة.')
  }
  if (cmd === 'broadcast') {
    if (!arg) return send(chatId, 'الصيغة: <code>/broadcast نص الرسالة</code>')
    let ok = 0
    for (const u of Object.values(store.users)) {
      if (u.banned) continue
      const r = await send(u.id, `📣 <b>إعلان</b>\n${LINE}\n${esc(arg)}`)
      if (r) ok++
      await sleep(60)
    }
    return send(chatId, `📣 تم الإرسال إلى ${ok} مستخدم.`)
  }
  if (cmd === 'mode') {
    const want = arg.toLowerCase()
    if (!['free', 'paid', 'مجاني', 'اشتراك', 'باشتراك'].includes(want)) return send(chatId, `النظام الحالي: <b>${modeName()}</b>\nالصيغة: <code>/mode free</code> أو <code>/mode paid</code>`)
    return setMode(want === 'free' || want === 'مجاني' ? false : true, chatId)
  }
  if (cmd === 'gen') {
    const [d, n = '1'] = arg.split(/\s+/)
    const ms = parseDuration(d)
    const count = Math.min(50, Math.max(1, parseInt(toEnDigits(n), 10) || 1))
    if (!d || ms === undefined) return send(chatId, 'الصيغة: <code>/gen المدة [العدد]</code>\nأمثلة: <code>/gen 30d 5</code> — <code>/gen 12h</code> — <code>/gen دائم 2</code>')
    const key = ms === null ? 'perm' : String(Math.round(ms / MIN))
    return send(chatId, codesMessage(makeCodes(key, count, uid), ms))
  }
  if (cmd === 'grant') {
    const [target, d] = arg.split(/\s+/)
    const ms = parseDuration(d)
    const t = store.users[target]
    if (!t || !d || ms === undefined) return send(chatId, 'الصيغة: <code>/grant ID المدة</code>\nأمثلة: <code>/grant 123456 30d</code> — <code>/grant 123456 دائم</code>\n(المستخدم لازم يكون فتح البوت قبل كده)')
    const sub = applySub(t.id, ms, `admin:${uid}`)
    resumeAccess(t.id).catch(() => { })
    send(t.id, `🎁 <b>تم تفعيل اشتراك لك من الأدمن!</b>\n${LINE}\n${sub.expiresAt === null ? '♾ اشتراك دائم' : `⏳ المدة: ${spanLabel(ms)}\n🏁 ينتهي: ${fmtDate(sub.expiresAt)}`}`, kb([[btn('💎 اشتراكي', 'sub', 'primary')]]))
    return send(chatId, `✅ تم منح <b>${esc(t.name)}</b> اشتراك ${spanLabel(ms)}.`)
  }
  if (cmd === 'revoke') {
    const t = store.users[arg]
    if (!t) return send(chatId, 'الصيغة: <code>/revoke ID</code>')
    return revokeSub(t.id, chatId)
  }
}

async function setMode(paid, chatId) {
  store.settings.paid = paid
  saveStore()
  if (paid) await enforceAccess()
  else resumeAccess().catch(() => { })
  return send(chatId, paid
    ? `💎 تم تفعيل <b>نظام الاشتراك</b>.\nأي مستخدم من غير اشتراك فعّال هيشوف شاشة الاشتراك، وجلساته اتوقفت مؤقتًا.`
    : `🆓 تم تحويل البوت إلى <b>مجاني</b>. الجلسات الموقوفة بتشتغل تاني تلقائيًا.`, kb([[btn('🛠 لوحة الأدمن', 'a:panel')]]))
}

async function revokeSub(uid, chatId) {
  const u = store.users[String(uid)]
  if (!u?.sub) return send(chatId, 'المستخدم ده معندوش اشتراك.')
  u.sub = null
  saveStore()
  const n = isPaid() && !isAdmin(u.id) ? await cancelUserSessions(u.id) : 0
  send(u.id, `⚠️ تم إلغاء اشتراكك بواسطة الأدمن.` + (n ? `\nوتم إلغاء وحذف جلستك.` : ''), kb([contactRow()]))
  return send(chatId, `✅ تم إلغاء اشتراك <b>${esc(u.name)}</b>` + (n ? ` وحذف ${n} جلسة.` : '.'))
}

async function handleMessage(msg) {
  if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return
  const user = rememberUser(msg.from)
  const uid = String(user.id)
  const chatId = msg.chat.id
  const text = (msg.text || '').trim()
  if (user.banned && !isAdmin(uid)) return send(chatId, '⛔ تم حظرك من استخدام هذا البوت.')
  stopTicker(uid)

  const [cmdRaw, ...rest] = text.split(/\s+/)
  const cmd = cmdRaw.startsWith('/') ? cmdRaw.slice(1).split('@')[0].toLowerCase() : ''
  const arg = rest.join(' ').trim()
  const entitled = hasAccess(uid)
  const wait = awaiting.get(uid)
  const waiting = wait && Date.now() - wait.at < 5 * 60_000 ? wait.type : null

  if (cmd === 'start' || cmd === 'menu') {
    const pay = (arg || '').trim().split(/\s+/)[0]?.toLowerCase() || ''
    if (pay === 'link' || pay === 'ربط') {
      if (!entitled) return show(chatId, null, gateScreen(uid))
      awaiting.set(uid, { type: 'number', at: Date.now() })
      return send(chatId, linkPrompt)
    }
    if (/^\d{6,}$/.test(toEnDigits(pay))) {
      if (!entitled) return show(chatId, null, gateScreen(uid))
      awaiting.delete(uid)
      return startLink(user, chatId, pay)
    }
    awaiting.delete(uid)
    return show(chatId, null, entitled ? homeScreen(user) : gateScreen(uid))
  }
  if (cmd === 'help') return send(chatId, helpText, kb([[btn('🏠 الرئيسية', 'home')]]))
  if (cmd === 'id') return send(chatId, `🆔 معرفك: <code>${uid}</code>`)
  if (cmd === 'cancel') { awaiting.delete(uid); pendingCmd.delete(uid); return send(chatId, '✅ تم الإلغاء.', kb([[btn('🏠 الرئيسية', 'home')]])) }
  if (cmd === 'sub') { const m = await show(chatId, null, subScreen(uid)); return startTicker(uid, chatId, midOf(m)) }
  if (cmd === 'code' || cmd === 'redeem') {
    if (arg) return doRedeem(user, chatId, arg, msg.message_id)
    awaiting.set(uid, { type: 'code', at: Date.now() })
    return show(chatId, null, codePromptScreen())
  }

  const adminCmds = ['admin', 'users', 'ban', 'unban', 'stop', 'remove', 'broadcast', 'mode', 'gen', 'grant', 'revoke']
  if (adminCmds.includes(cmd)) {
    if (!isAdmin(uid)) return send(chatId, '⛔ هذا الأمر للمسؤول فقط.')
    return adminCommand(cmd, arg, user, chatId)
  }
  if (waiting === 'custom' && isAdmin(uid) && text && !cmd) {
    const ms = parseDuration(text)
    if (ms === undefined) return send(chatId, '❌ مدة غير مفهومة. أمثلة: <code>45</code> (أيام) — <code>12h</code> — <code>3 شهور</code> — <code>دائم</code>\n(أو /cancel)')
    awaiting.delete(uid)
    return show(chatId, null, genCountScreen(ms === null ? 'perm' : String(Math.round(ms / MIN))))
  }
  if (waiting === 'cmdname' && isAdmin(uid) && text && !cmd) {
    const raw = text.replace(/^\.+/, '').trim()
    if (!raw || /\s/.test(raw) || raw.length > 40) return send(chatId, '❌ اكتب اسم الأمر بس من غير مسافات (مثال: <code>شاهد</code>)\n(أو /cancel)')
    pendingCmd.set(uid, { tgId: wait.tgId, cmd: raw })
    awaiting.delete(uid)
    return show(chatId, null, cmdModeScreen(uid))
  }
  if (waiting === 'cmddur' && isAdmin(uid) && text && !cmd) {
    const p = pendingCmd.get(uid)
    if (!p) { awaiting.delete(uid); return show(chatId, null, cmdsScreen()) }
    const ms = parseDuration(text)
    if (ms === undefined) return send(chatId, '❌ مدة غير مفهومة. أمثلة: <code>45</code> (أيام) — <code>12h</code> — <code>3 شهور</code> — <code>دائم</code>\n(أو /cancel)')
    return finishCmdRule(uid, chatId, p, ms)
  }
  if (waiting === 'promnum' && isAdmin(uid) && text && !cmd) {
    awaiting.delete(uid)
    const g = groupsCache.get(wait.sid)?.list?.[wait.idx]
    if (!g) return send(chatId, '⏪ القايمة قديمة — افتح «عرض الجروبات» من جديد.', kb([[btn('📋 عرض الجروبات', 'a:groups')]]))
    const sess = store.sessions[wait.sid]
    if (sess && g.role === 'member') return send(chatId, memberExplain(sess, g), kb([[btn('⬅️ رجوع', `a:gg:${wait.sid}:${wait.idx}`)]]))
    const number = normalizeNumber(text)
    if (!number) return send(chatId, '❌ الرقم غير صحيح. اكتبه بكود الدولة وبدون +، مثال: <code>201012345678</code>\n(أو /cancel)', kb([[btn('⬅️ رجوع', `a:gg:${wait.sid}:${wait.idx}`)]]))
    await send(chatId, '⏳ جارٍ تنفيذ الترقية...')
    const r = await childReq(wait.sid, { type: 'promote', jid: g.jid, number }).catch((e) => ({ ok: false, error: e.message }))
    return send(chatId, r?.ok
      ? `✅ تم ترقية <b>+${esc(number)}</b> إلى مشرف في «${esc(g.name)}»`
      : explainWgErr(r?.error), kb([[btn('⬅️ رجوع', `a:gg:${wait.sid}:${wait.idx}`)]]))
  }
  if (waiting === 'mywa' && isAdmin(uid) && text && !cmd) {
    awaiting.delete(uid)
    const number = normalizeNumber(text)
    if (!number) return send(chatId, '❌ الرقم غير صحيح. اكتبه بكود الدولة وبدون +، مثال: <code>201012345678</code>\n(أو /cancel)', kb([[btn('📋 عرض الجروبات', 'a:groups', 'primary')]]))
    store.adminWa[uid] = number
    saveStore()
    if (wait.setOnly) return send(chatId, `✅ تم حفظ رقمك الشخصي: <code>+${esc(number)}</code>\nدلوقتي زرار «👑 ترقيتي أنا» هيستخدمه.`, kb([[btn('📋 عرض الجروبات', 'a:groups', 'primary')]]))
    const g = groupsCache.get(wait.sid)?.list?.[wait.idx]
    const s = store.sessions[wait.sid]
    if (!g || !s) return send(chatId, `✅ تم حفظ رقمك: <code>+${esc(number)}</code>\n⏪ افتح «عرض الجروبات» من جديد واختار الجروب.`, kb([[btn('📋 عرض الجروبات', 'a:groups', 'primary')]]))
    if (g.role === 'member') return send(chatId, memberExplain(s, g), kb([[btn('⬅️ رجوع', `a:gg:${wait.sid}:${wait.idx}`)]]))
    await send(chatId, '⏳ جارٍ ترقيتك في واتساب...')
    const r = await childReq(wait.sid, { type: 'promote', jid: g.jid, number }).catch((e) => ({ ok: false, error: e.message }))
    return send(chatId, r?.ok
      ? `✅ <b>تمت ترقيتك مشرف!</b>\nرقمك <b>+${esc(number)}</b> بقى مشرف في «${esc(g.name)}» جنب ${mask(s.number)} وأي مشرفين تانيين 👑`
      : explainWgErr(r?.error), kb([[btn('⬅️ رجوع', `a:gg:${wait.sid}:${wait.idx}`)]]))
  }

  if (!entitled) {
    if (text && !cmd && (waiting === 'code' || looksLikeCode(text))) return doRedeem(user, chatId, text, msg.message_id)
    return show(chatId, null, gateScreen(uid))
  }

  if (waiting === 'number' && text && !cmd) return startLink(user, chatId, text)
  if (text && !cmd && (waiting === 'code' || looksLikeCode(text))) return doRedeem(user, chatId, text, msg.message_id)

  if (cmd === 'sessions') return show(chatId, null, sessionsScreen(uid))
  if (cmd === 'link') {
    if (arg) return startLink(user, chatId, arg)
    awaiting.set(uid, { type: 'number', at: Date.now() })
    return send(chatId, linkPrompt)
  }

  if (waiting === 'number' && text && !cmd) return startLink(user, chatId, text)

  if (cmd) return send(chatId, 'أمر غير معروف. اضغط /start', kb([[btn('🏠 الرئيسية', 'home')]]))
  return send(chatId, 'اضغط /start للبدء 👇', kb([[btn('🏠 الرئيسية', 'home')]]))
}

async function handleCallback(q) {
  const user = rememberUser(q.from)
  const uid = String(user.id)
  const chatId = q.message?.chat?.id
  const mid = q.message?.message_id
  const isPhoto = !!q.message?.photo
  const data = q.data || ''
  if (!chatId) return answer(q.id)
  if (user.banned && !isAdmin(uid)) return answer(q.id, '⛔ تم حظرك', true)
  stopTicker(uid)

  const open = ['home', 'help', 'sub', 'code', 'myid']
  if (!hasAccess(uid) && !open.includes(data)) {
    await answer(q.id, '🔒 لازم تشترك الأول', false)
    return show(chatId, mid, gateScreen(uid), isPhoto)
  }
  answer(q.id)

  if (data === 'home') { awaiting.delete(uid); return show(chatId, mid, hasAccess(uid) ? homeScreen(user) : gateScreen(uid), isPhoto) }
  if (data === 'help') return show(chatId, mid, { text: helpText, extra: kb([[btn('🏠 الرئيسية', 'home')]]) }, isPhoto)
  if (data === 'myid') return send(chatId, `🆔 معرفك: <code>${uid}</code>`)
  if (data === 'list') return show(chatId, mid, sessionsScreen(uid), isPhoto)
  if (data === 'link') { awaiting.set(uid, { type: 'number', at: Date.now() }); return send(chatId, linkPrompt) }
  if (data === 'code') { awaiting.set(uid, { type: 'code', at: Date.now() }); return show(chatId, mid, codePromptScreen(), isPhoto) }
  if (data === 'sub') {
    const m = await show(chatId, mid, subScreen(uid), isPhoto)
    return startTicker(uid, chatId, midOf(m, mid))
  }

  if (data.startsWith('s:')) {
    const [, sid, action] = data.split(':')
    const s = store.sessions[sid]
    if (!s) return show(chatId, mid, sessionsScreen(uid), isPhoto)
    if (s.tgId !== uid && !isAdmin(uid)) return
    if (action === 'stop') { await stopProcess(sid); if (s.status === 'linked') { s.status = 'stopped'; saveStore() } return show(chatId, mid, sessionsScreen(s.tgId), isPhoto) }
    if (action === 'start') {
      if (!hasAccess(s.tgId)) return send(chatId, '🔒 صاحب الجلسة دي مالوش اشتراك فعّال.')
      if (s.status === 'stopped') { s.status = 'linked'; saveStore() }
      spawnSession(sid)
      return show(chatId, mid, sessionsScreen(s.tgId), isPhoto)
    }
    if (action === 'cancel') { if (s.status === 'pending') await destroySession(sid, { logout: false }); return show(chatId, mid, sessionsScreen(s.tgId), isPhoto) }
    if (action === 'del') {
      const needsOk = s.tgId === uid && !isAdmin(uid)
      return show(chatId, mid, {
        text: `🗑 <b>فك الرابط وحذف الجلسة</b>\n${LINE}\nهتتفصل جلسة <b>+${esc(s.number)}</b> من واتساب نهائيًا.\n` +
          (needsOk ? `<i>ℹ️ لازم الأدمن يوافق الأول — هيتفك الرابط بعد موافقته هو.</i>\n` : '') +
          `متأكد؟`,
        extra: kb([[
          btn(needsOk ? '📨 نعم، اطلب فك الرابط' : '✅ نعم، احذف', `s:${sid}:delyes`, 'danger'),
          btn('↩️ تراجع', 'list'),
        ]]),
      }, isPhoto)
    }
    if (action === 'delyes') {
      if (isAdmin(uid)) { await destroySession(sid); return show(chatId, mid, sessionsScreen(s.tgId), isPhoto) }
      if (Object.values(store.unlinkReqs).some((r) => r.sid === sid)) {
        return show(chatId, mid, {
          text: `⏳ <b>في طلب فك ربط قائم بالفعل</b>\n${LINE}\nطلبك للجلسة <b>+${esc(s.number)}</b> مستني موافقة الأدمن لسه.\nالجلسة شغّالة زي ما هي لحد الموافقة.`,
          extra: kb([[btn('📱 جلساتي', 'list'), btn('🏠 الرئيسية', 'home')]]),
        }, isPhoto)
      }
      const reqId = crypto.randomUUID()
      store.unlinkReqs[reqId] = { id: reqId, sid, tgId: s.tgId, number: s.number, at: Date.now() }
      saveStore()
      const u = store.users[s.tgId]
      for (const a of ADMIN_IDS) {
        send(a,
          `🔓 <b>طلب فك ربط جديد</b>\n${LINE}\n👤 ${esc(u?.name || s.tgId)} (<code>${s.tgId}</code>)\n📱 ${mask(s.number)}\n⏰ ${fmtDate(Date.now())}`,
          kb([
            [btn('✅ موافقة على الفك', `a:ulok:${reqId}`, 'success')],
            [btn('❌ رفض الطلب', `a:ulno:${reqId}`, 'danger')],
          ]))
      }
      return show(chatId, mid, {
        text: `📨 <b>اتبعت طلب فك الرابط للأدمن</b>\n${LINE}\nهيتفك رابط <b>+${esc(s.number)}</b> بعد موافقة الأدمن على الطلب.\nالجلسة لسه شغّالة زي ما هي لحد ما يوافق.`,
        extra: kb([[btn('📱 جلساتي', 'list'), btn('🏠 الرئيسية', 'home')]]),
      }, isPhoto)
    }
    return
  }

  if (data.startsWith('a:')) {
    const [, action, p1, p2, p3] = data.split(':')
    const go = (scr) => show(chatId, mid, scr, isPhoto)
    if (action === 'panel') return go(panelScreen())
    if (action === 'botlink') return go(botLinkScreen())
    if (action === 'botlinkcopy') {
      const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=link` : null
      if (!link) return go(botLinkScreen())
      return send(chatId, `<code>${link}</code>\n<i>👆 اضغط على الرابط لنسخه ثم ابعته لمن تحب.</i>`)
    }
    if (action === 'sessions') return go(adminSessionsView())
    if (action === 'users') return go(adminUsersView())
    if (action === 'clist') return go(codesListScreen())
    if (action === 'subs') return go(subsScreen())

    if (action === 'cmds') return go(cmdsScreen())
    if (action === 'cuser') return go(cmdsUserScreen(p1))
    if (action === 'cadd') { awaiting.set(uid, { type: 'cmdname', at: Date.now(), tgId: p1 }); return send(chatId, cmdNamePrompt(p1), kb([[btn('⬅️ رجوع', `a:cuser:${p1}`)]])) }
    if (action === 'cgo') {
      const p = pendingCmd.get(uid)
      if (!p) return go(cmdsScreen())
      p.mode = p1 === 'block' ? 'block' : 'allow'
      return go(cmdDurScreen(uid))
    }
    if (action === 'cdur') {
      const p = pendingCmd.get(uid)
      if (!p) return go(cmdsScreen())
      return finishCmdRule(uid, chatId, p, p1 === 'perm' ? null : Number(p1) * MIN)
    }
    if (action === 'cdurcustom') { awaiting.set(uid, { type: 'cmddur', at: Date.now() }); return send(chatId, `✏️ <b>مدة مخصصة</b>\n${LINE}\n<blockquote>اكتب المدة:\n<code>45</code> = 45 يوم\n<code>12h</code> أو <code>12 ساعة</code>\n<code>3 شهور</code> — <code>2 سنة</code>\n<code>دائم</code> = بدون انتهاء</blockquote>\nللإلغاء: /cancel`) }
    if (action === 'cdef') {
      const r = cmdRulesOf(p1)
      r.def = p2 === 'block' ? 'block' : 'allow'
      saveStore(); pushCmdRules(p1)
      return go(cmdsUserScreen(p1))
    }
    if (action === 'crmv') {
      const live = liveCmdRules(p1)
      const entry = live.entries[Number(p2)]
      if (entry) { delete cmdRulesOf(p1).rules[entry[0]]; saveStore(); pushCmdRules(p1) }
      return go(cmdsUserScreen(p1))
    }
    if (action === 'cclear') { delete store.cmdrules[p1]; saveStore(); pushCmdRules(p1); return go(cmdsUserScreen(p1)) }

    if (action === 'groups') {
      if (p1) return showGroupsList(chatId, mid, p1, isPhoto)
      const linked = Object.values(store.sessions).filter((s) => s.status === 'linked')
      if (!linked.length) return send(chatId, '❌ مفيش جلسات مربوطة لسه.')
      if (linked.length === 1) return showGroupsList(chatId, mid, linked[0].id, isPhoto)
      return go(groupsSessionsScreen())
    }
    if (action === 'gpage') {
      if (!groupsCache.get(p1)) return showGroupsList(chatId, mid, p1, isPhoto)
      return go(groupsScreen(p1, Math.max(0, Number(p2) || 0)))
    }
    if (action === 'gg') {
      if (!groupsCache.get(p1)?.list) return go(groupsSessionsScreen())
      if (!groupsCache.get(p1).list[Number(p2)]) return go(groupsScreen(p1, 0))
      return go(groupDetailScreen(p1, p2, uid))
    }
    if (action === 'gp') {
      const g = groupsCache.get(p1)?.list?.[Number(p2)]
      if (!g) return go(groupsSessionsScreen())
      const s = store.sessions[p1]
      if (!s) return go(groupsSessionsScreen())
      if (g.role === 'member') return send(chatId, memberExplain(s, g), kb([[btn('🔄 تحديث الحالة', `a:groups:${p1}`, 'primary'), btn('⬅️ رجوع', `a:gg:${p1}:${p2}`)]]))
      if (p3 === 'num') {
        awaiting.set(uid, { type: 'promnum', at: Date.now(), sid: p1, idx: Number(p2) })
        return send(chatId,
          `🔢 <b>ترقية رقم في «${esc(g.name)}»</b>\n${LINE}\n<blockquote>اكتب رقم واتساب بكود الدولة وبدون +\nمثال: <code>201012345678</code>\n(لازم يكون عضو في الجروب ده)</blockquote>\nللإلغاء: /cancel`,
          kb([[btn('⬅️ رجوع', `a:gg:${p1}:${p2}`)]]))
      }
      const myWa = store.adminWa?.[uid]
      if (!myWa) {
        awaiting.set(uid, { type: 'mywa', at: Date.now(), sid: p1, idx: Number(p2) })
        return send(chatId,
          `📱 <b>رقمك الشخصي — أول مرة</b>\n${LINE}\n<blockquote>اكتب رقم الواتساب <b>بتاعك انت</b> (اللي عايزه يبقى مشرف) بكود الدولة وبدون +\nمثال: <code>201012345678</code></blockquote>\nهيتحفظ مرة واحدة وبعدها زرار «👑 ترقيتي أنا» هيشتغل على طول.\nللإلغاء: /cancel`,
          kb([[btn('⬅️ رجوع', `a:gg:${p1}:${p2}`)]]))
      }
      await show(chatId, mid, { text: '⏳ جارٍ ترقيتك في واتساب...' }, isPhoto)
      const r = await childReq(p1, { type: 'promote', jid: g.jid, number: myWa }).catch((e) => ({ ok: false, error: e.message }))
      return send(chatId, r?.ok
        ? `✅ <b>تمت ترقيتك مشرف!</b>\nرقمك <b>+${esc(myWa)}</b> بقى مشرف في «${esc(g.name)}» جنب ${mask(s.number)} وأي مشرفين تانيين 👑`
        : explainWgErr(r?.error), kb([[btn('⬅️ رجوع', `a:gg:${p1}:${p2}`)]]))
    }
    if (action === 'gmywa') {
      awaiting.set(uid, { type: 'mywa', at: Date.now(), setOnly: true })
      return send(chatId,
        `📱 <b>رقمك الشخصي</b>\n${LINE}\n<blockquote>اكتب رقم الواتساب بتاعك بكود الدولة وبدون +\nمثال: <code>201012345678</code></blockquote>\nهو اللي بيترقّى مشرف لما تدوس «👑 ترقيتي أنا».\nللإلغاء: /cancel`,
        kb([[btn('⬅️ رجوع', 'a:groups')]]))
    }
    if (action === 'glink') {
      const g = groupsCache.get(p1)?.list?.[Number(p2)]
      if (!g) return go(groupsSessionsScreen())
      await show(chatId, mid, { text: `⏳ جارٍ جلب رابط «${esc(g.name)}» من واتساب...` }, isPhoto)
      const r = await childReq(p1, { type: 'getlink', jid: g.jid }).catch((e) => ({ ok: false, error: e.message }))
      if (!r?.ok) {
        return send(chatId, `🚫 تعذر جلب الرابط: <code>${esc(String(r?.error || 'خطأ غير معروف'))}</code>`,
          kb([[btn('🔁 حاول تاني', `a:glink:${p1}:${p2}`), btn('⬅️ رجوع', `a:gg:${p1}:${p2}`)]]))
      }
      const link = `https://chat.whatsapp.com/${r.code}`
      return send(chatId,
        `🔗 <b>رابط دعوة «${esc(g.name)}»</b>\n${LINE}\n${link}\n\n<i>اضغط على الرابط لفتحه في واتساب والدخول بالرقم اللي تحبه.\nملاحظة: الدخول عبر رابط الدعوة بيظهر في الجروب بشكل عادي زي أي عضو داخل بالرابط.</i>`,
        kb([[urlBtn('🔗 فتح الرابط', link, 'primary')], [btn('⬅️ رجوع', `a:gg:${p1}:${p2}`)]]))
    }

    if (action === 'mode') {
      if (!p1) return go(modeScreen())
      if (p1 === 'free') { if (isPaid()) await setMode(false, chatId); return go(modeScreen()) }
      if (p1 === 'paid' && !isPaid()) {
        return go({
          text: `💎 <b>تفعيل نظام الاشتراك</b>\n${LINE}\n<blockquote>هيتوقف مؤقتًا جلسات <b>${lockedUsersCount()}</b> مستخدم مالهمش اشتراك فعّال، وكل المستخدمين الجداد هيشوفوا شاشة «البوت باشتراك».\nالجلسات مش بتتحذف، وبترجع لوحدها عند الاشتراك.</blockquote>\nتأكيد؟`,
          extra: kb([[btn('✅ تفعيل', 'a:mode:paidyes', 'success'), btn('↩️ تراجع', 'a:mode')]]),
        })
      }
      if (p1 === 'paidyes') { if (!isPaid()) await setMode(true, chatId); return go(modeScreen()) }
      return go(modeScreen())
    }

    if (action === 'gen') {
      if (!p1) return go(genDurScreen())
      if (p1 !== 'perm' && !(Number(p1) >= 1)) return go(genDurScreen())
      if (!p2) return go(genCountScreen(p1))
      const n = Math.min(50, Math.max(1, Number(p2) || 1))
      const codes = makeCodes(p1, n, uid)
      return send(chatId, codesMessage(codes, keyToMs(p1)), kb([[btn(`➕ كمان ${n} بنفس المدة`, `a:gen:${p1}:${n}`, 'success')], [btn('🗂 الأكواد', 'a:clist'), btn('🛠 اللوحة', 'a:panel')]]))
    }
    if (action === 'gencustom') {
      awaiting.set(uid, { type: 'custom', at: Date.now() })
      return send(chatId, `✏️ <b>مدة مخصصة</b>\n${LINE}\n<blockquote>اكتب المدة:\n<code>45</code> = 45 يوم\n<code>12h</code> أو <code>12 ساعة</code>\n<code>3 شهور</code> — <code>2 سنة</code>\n<code>دائم</code> = بدون انتهاء</blockquote>\nللإلغاء: /cancel`)
    }
    if (action === 'cdel') {
      const c = store.codes[p1]
      if (c && !c.usedBy) { delete store.codes[c.code]; saveStore() }
      return go(codesListScreen())
    }

    if (action === 'subrm') {
      const t = store.users[p1]
      if (!t?.sub) return go(subsScreen())
      return go({
        text: `❌ <b>إلغاء اشتراك</b>\n${LINE}\nهتلغي اشتراك <b>${esc(t.name)}</b> (<code>${t.id}</code>) ${t.sub.expiresAt === null ? '(دائم)' : `ومتبقي له ${fmtShort(t.sub.expiresAt - Date.now())}`}. متأكد؟`,
        extra: kb([[btn('✅ نعم، إلغاء', `a:subrmyes:${t.id}`, 'danger'), btn('↩️ تراجع', 'a:subs')]]),
      })
    }
    if (action === 'subrmyes') { await revokeSub(p1, chatId); return go(subsScreen()) }

    if (action === 'ulreqs') return go(unlinkReqsScreen())
    if (action === 'ulok' || action === 'ulno') {
      const r = store.unlinkReqs[p1]
      if (!r) return send(chatId, '⏪ الطلب ده مش موجود (اتنفذ أو انتهى).', kb([[btn('🔓 طلبات فك الرابط', 'a:ulreqs')]]))
      delete store.unlinkReqs[p1]
      saveStore()
      const sess = store.sessions[r.sid]
      if (action === 'ulok') {
        if (sess) await destroySession(r.sid)
        send(r.tgId, `✅ <b>وافق الأدمن على فك الرابط</b>\n${LINE}\nتم فصل <b>+${esc(r.number)}</b> من واتساب وحذف الجلسة.\nتقدر تربط من جديد في أي وقت.`, kb([[btn('🔗 ربط رقم جديد', 'link', 'primary')]]))
        return send(chatId, `✅ تم فك ربط ${mask(r.number)} وحذف الجلسة — واتم إشعار العضو.`, kb([[btn('🔓 الطلبات', 'a:ulreqs'), btn('🛠 اللوحة', 'a:panel')]]))
      }
      send(r.tgId, `❌ <b>رفض الأدمن طلب فك الربط</b>\n${LINE}\nجلستك <b>+${esc(r.number)}</b> هتفضل شغّالة زي ما هي.\nلو محتاج فك الرابط تواصل مع الأدمن تاني.`, kb([[btn('📱 جلساتي', 'list')]]))
      return send(chatId, `🚫 تم رفض طلب ${mask(r.number)} — واتم إشعار العضو.`, kb([[btn('🔓 الطلبات', 'a:ulreqs'), btn('🛠 اللوحة', 'a:panel')]]))
    }

    if (action === 'stop' && store.sessions[p1]) {
      await stopProcess(p1)
      if (store.sessions[p1].status === 'linked') { store.sessions[p1].status = 'stopped'; saveStore() }
    }
    if (action === 'rm' && store.sessions[p1]) { const o = store.sessions[p1].chatId; await destroySession(p1); send(o, '⚠️ تم حذف جلستك بواسطة المسؤول.') }
    return go(adminSessionsView())
  }
}

async function handleUpdate(u) {
  if (u.message) return handleMessage(u.message)
  if (u.callback_query) return handleUpdate(u.callback_query)
}

// ───────────────────────── التشغيل ─────────────────────────
let running = true

// خادم HTTP بسيط لاستضافة Railway (ليعرف المنصة إن البوت شغال ويستجيب على الـ PORT)
if (process.env.PORT) {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('MR JOO ✅ البوت يعمل على Railway')
  }).listen(Number(process.env.PORT), '0.0.0.0', () => {
    log(`🌐 خادم HTTP يعمل على البورت ${process.env.PORT}`)
  })
}

async function poll() {
  let offset = 0
  let conflictStreak = 0
  let lastConflictLog = 0
  while (running) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000)
      if (conflictStreak) { log('✅ رجع يشتغل عادي (اختفى تعارض الـ getUpdates).'); conflictStreak = 0 }
      for (const u of updates) {
        offset = u.update_id + 1
        handleUpdate(u).catch((e) => log('⚠️ خطأ في المعالجة:', e.message))
      }
    } catch (e) {
      if (!running) break
      const isConflict = /Conflict/i.test(e.message)
      if (isConflict) {
        conflictStreak++
        if (Date.now() - lastConflictLog > 60_000) {
          lastConflictLog = Date.now()
          console.log('\n⚠️ تعارض: في نسخة تانية من هذا البوت (بنفس التوكن) شغّالة في مكان تاني وبتسحب الرسائل بدل هذه النسخة.')
          console.log('   الأسباب الشائعة: شغّلته مرتين على جهازك، أو هو شغّال كمان على سيرفر/استضافة (Railway مثلًا)، أو على جهاز تاني.')
          console.log('   الحل: اقفل كل النسخ الأخرى، وسيب نسخة واحدة بس شغّالة بنفس التوكن.\n')
        }
        await sleep(Math.min(5000 * Math.min(conflictStreak, 12), 60_000))
      } else {
        conflictStreak = 0
        log('⚠️ تليجرام:', e.message)
        await sleep(3000)
      }
    }
  }
}

async function shutdown() {
  if (!running) return
  running = false
  log('⏹ إيقاف المدير وكل الجلسات...')
  for (const uid of [...tickers.keys()]) stopTicker(uid)
  await Promise.all([...runtime.keys()].map((sid) => stopProcess(sid)))
  saveStore()
  releaseLock()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', (e) => log('⚠️ وعد مرفوض:', e?.message || e))
process.on('uncaughtException', (e) => log('⚠️ استثناء:', e?.message || e))
process.on('exit', releaseLock)

async function main() {
  const me = await tg('getMe').catch((e) => { console.log('❌ فشل الاتصال بتليجرام: ' + e.message + '\nتأكد من التوكن ومن الإنترنت.'); process.exit(1) })
  BOT_USERNAME = me?.username || null
  await tg('deleteWebhook', { drop_pending_updates: false }).catch(() => { })
  const userCmds = [
    { command: 'start', description: 'القائمة الرئيسية' },
    { command: 'link', description: 'ربط رقم واتساب جديد' },
    { command: 'sessions', description: 'جلساتي' },
    { command: 'sub', description: 'اشتراكي والوقت المتبقي' },
    { command: 'code', description: 'إدخال كود اشتراك' },
    { command: 'help', description: 'المساعدة' },
    { command: 'cancel', description: 'إلغاء العملية الحالية' },
  ]
  await tg('setMyCommands', { commands: userCmds }).catch(() => { })
  for (const a of ADMIN_IDS) {
    await tg('setMyCommands', { scope: { type: 'chat', chat_id: Number(a) }, commands: [
      { command: 'admin', description: 'لوحة الأدمن' },
      { command: 'gen', description: 'إنشاء أكواد اشتراك' },
      { command: 'grant', description: 'منح اشتراك لمستخدم' },
      { command: 'mode', description: 'مجاني / باشتراك' },
      { command: 'users', description: 'المستخدمين' },
      ...userCmds.slice(0, 3),
    ] }).catch(() => { })
  }

  for (const s of Object.values(store.sessions)) {
    if (s.status === 'pending') await destroySession(s.id, { logout: false })
  }
  await sweepExpiry()
  setInterval(() => sweepExpiry().catch((e) => log('⚠️ فحص الاشتراكات:', e.message)), SWEEP_EVERY).unref?.()
  const toStart = Object.values(store.sessions).filter((s) => s.status === 'linked' && !store.users[s.tgId]?.banned && hasAccess(s.tgId))
  console.log(`\n✅ مدير تليجرام يعمل: @${me.username}`)
  console.log(`👑 المسؤولون: ${[...ADMIN_IDS].join(', ')}   |   💳 النظام: ${modeName()}   |   🔁 استعادة ${toStart.length} جلسة\n`)
  poll()
  for (const s of toStart) { spawnSession(s.id); await sleep(1500) }
}

main()