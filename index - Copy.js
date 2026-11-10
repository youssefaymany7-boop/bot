// ═══════════════════════════════════════════════════════════════
//   🎖️ MR JOO — بوت حماية وإدارة وموسيقى لمجموعات واتساب — Baileys v7
//   يعمل على Termux أو أي جهاز يحتوي على Node.js
//   الأوامر بالعربية (مع بقاء الأوامر الإنجليزية كبدائل)
// ═══════════════════════════════════════════════════════════════
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import fs from 'fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

// ─────────────────── الإعدادات (عدّل من هنا) ───────────────────
const PREFIX = '.'                          // علامة الأوامر
const BOT_NAME = 'MR JOO'
const OWNER = (process.env.OWNER_NUMBERS || '201029247107').split(',').map((x) => x.trim().replace(/\D/g, '')).filter(Boolean) // ← رقم المالك/المطور مع رمز الدولة
let PAIRING_NUMBER = process.env.PAIRING_NUMBER || '201029247107' // ← رقم البوت (الربط بالكود فقط، لا يوجد QR)
const DEV_NAME = 'Mr.jooo'                  // اسم المطور
const DEV_NUMBER = process.env.DEV_NUMBER || '201029247107' // رقم المطور
let BOT_NUMBER = process.env.BOT_NUMBER || PAIRING_NUMBER // رقم البوت
const LINE = '━━━━━━━━━━━━━━'
const MAX_AUDIO_MB = 25                     // أقصى حجم للأغنية بالميجابايت
const RAID_WINDOW = 10000                   // مدة احتساب الهجوم بالمللي ثانية (10 ثوانٍ)
const RAID_LIMIT = 5                        // عدد المنضمّين خلال هذه المدة الذي يُعدّ هجومًا
const MAX_WARNS = 3                         // عدد الإنذارات قبل الطرد
const FLOOD_WINDOW = 8000                   // مدة احتساب تكرار الرسائل بالمللي ثانية
const FLOOD_LIMIT = 7                       // كام رسالة في المدة دي تُعدّ تكرارًا (سبام)
const MAX_STORE_MB = 12                      // أقصى حجم لكل وسيط يُحفظ بـ .حفظ
// ────────────────────────────────────────────────────────────────


// ── وضع الجلسة المُدارة (يُشغَّل كعملية فرعية من telegram.js) ──
const IS_CHILD = !!process.env.MR_JOO_CHILD
const notify = (msg) => { try { if (typeof process.send === 'function') process.send(msg) } catch { } }
if (IS_CHILD) {
  process.on('message', async (msg) => {
    if (msg?.type === 'shutdown') {
      try { sock?.end(undefined) } catch { }
      setTimeout(() => process.exit(0), 300)
    } else if (msg?.type === 'logout') {
      try { await sock?.logout() } catch { }
      setTimeout(() => process.exit(0), 300)
    } else if (msg?.type === 'cmdrules') {
      // قواعد تحكم المطوّر في الأوامر (بتيجي من لوحة تليجرام) — بتتطبق فورًا من غير ريستارت
      const src = msg.rules && typeof msg.rules === 'object' ? msg.rules : {}
      const rules = {}
      for (const [k, v] of Object.entries(src.rules || {})) {
        if (!v || (v.mode !== 'allow' && v.mode !== 'block')) continue
        const nk = normalize(k)
        if (nk) rules[nk] = { mode: v.mode, until: v.until ? Number(v.until) : null }
      }
      db.cmdrules = { def: src.def === 'block' ? 'block' : 'allow', rules }
      saveDb()
    } else if (msg?.type === 'listgroups') {
      // عرض كل الجروبات اللي الحساب مشارك فيها (بيجي من زرار «عرض الجروبات» في تليجرام)
      try {
        if (!sock?.user) throw new Error('الجلسة لسه مش متصلة بواتساب')
        const all = await sock.groupFetchAllParticipating()
        const me = botJids()
        // كل الجروبات اللي الحساب مشارك فيها (حتى 500 كحد أقصى للأمان) — العرض بيتم تقسيمه صفحات من المدير
        const groups = Object.values(all || {}).slice(0, 500).map((g) => {
          const p = (g.participants || []).find((x) => me.some((c) => sameUser(c, x)))
          const role = !p ? 'member' : p.admin === 'superadmin' ? 'superadmin' : p.admin === 'admin' ? 'admin' : 'member'
          return { jid: g.id, name: g.subject || 'بدون اسم', size: g.size || (g.participants || []).length, role }
        }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'))
        notify({ type: 'ipcres', reqId: msg.reqId, data: { ok: true, groups } })
      } catch (e) {
        notify({ type: 'ipcres', reqId: msg.reqId, data: { ok: false, error: e?.output?.payload?.message || e.message } })
      }
    } else if (msg?.type === 'promote') {
      // ترقية رقم إلى مشرف في جروب (بتنجح لو رقم الجلسة نفسه مشرف/مالك هناك — قاعدة واتساب)
      try {
        if (!sock?.user) throw new Error('الجلسة لسه مش متصلة بواتساب')
        const jid = String(msg.jid || '')
        const num = String(msg.number || '').replace(/\D/g, '')
        if (!jid.endsWith('@g.us') || !num) throw new Error('بيانات الترقية ناقصة')
        await sock.groupParticipantsUpdate(jid, [`${num}@s.whatsapp.net`], 'promote')
        notify({ type: 'ipcres', reqId: msg.reqId, data: { ok: true } })
      } catch (e) {
        notify({ type: 'ipcres', reqId: msg.reqId, data: { ok: false, error: e?.output?.payload?.message || e.message } })
      }
    } else if (msg?.type === 'getlink') {
      // جلب رابط دعوة الجروب (أي عضو في الجروب يقدر يشوفه من معلومات الجروب — زي واتساب بالظبط)
      try {
        if (!sock?.user) throw new Error('الجلسة لسه مش متصلة بواتساب')
        const jid = String(msg.jid || '')
        if (!jid.endsWith('@g.us')) throw new Error('جروب غير صحيح')
        const code = await sock.groupInviteCode(jid)
        if (!code) throw new Error('واتساب مبعتش كود الدعوة')
        notify({ type: 'ipcres', reqId: msg.reqId, data: { ok: true, code } })
      } catch (e) {
        notify({ type: 'ipcres', reqId: msg.reqId, data: { ok: false, error: e?.output?.payload?.message || e.message } })
      }
    }
  })
  process.on('disconnect', () => process.exit(0)) // لو مات المدير تموت الجلسة معه
}

const SESSION_DIR = process.env.SESSION_DIR || './session'
const DB_FILE = process.env.DB_FILE || './db.json'
const STORE_DIR = process.env.STORE_DIR || './store' // تخزين الوسائط المحفوظة بـ .حفظ

// ── قاعدة بيانات صغيرة تُحفظ في ملف ──
let db = {
  welcome: {}, goodbye: {}, antilink: {}, antiraid: {}, antiflood: {}, antidelete: {}, antiviewonce: {},
  antiname: {}, nameLog: {},
  warns: {}, rules: {}, badwords: {}, badwordFilter: {}, muted: {}, points: {}, media: {}, scheduled: {},
  cmdrules: { def: 'allow', rules: {} },
}
try {
  if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }
} catch { }
// حفظ مؤجّل (debounce): قبل كده كل رسالة في أي مجموعة كانت تكتب الملف كله بشكل متزامن وتعطّل البوت لحظة.
// دلوقتي بيتجمّع أي عدد من التعديلات في كتابة واحدة بعد ثانية، وبيتحفظ فورًا عند الإغلاق.
let dbTimer = null
const flushDb = () => {
  if (dbTimer) { clearTimeout(dbTimer); dbTimer = null }
  try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE) } catch { }
}
const saveDb = () => { if (!dbTimer) { dbTimer = setTimeout(flushDb, 1000); dbTimer.unref?.() } }
process.on('exit', () => { if (dbTimer) flushDb() })
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// ═══════════════════ وحدة يوتيوب ميوزك ═══════════════════
const BASE_URL = 'https://music.youtube.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const FILTER_PARAMS = {
  songs: 'EgWKAQIIAWoSEAUQAxAJEAoQERAQEAQQDhAV',
  videos: 'EgWKAQIQAWoSEAUQAxAJEAoQERAQEAQQDhAV',
  albums: 'EgWKAQIYAWoSEAUQAxAJEAoQERAQEAQQDhAV',
  artists: 'EgWKAQIgAWoSEAUQAxAJEAoQERAQEAQQDhAV',
  playlists: 'EgeKAQQoADgBahIQBRADEAkQChAREBAQBBAOEBU%3D',
  community_playlists: 'EgeKAQQoAEABahIQBRADEAkQChAREBAQBBAOEBU%3D',
}

let cachedContext = null
let lastContextTime = 0

// ── قراءة ملف كوكيز (Netscape أو سطر واحد) ──
function readCookieFile(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_')))
      .map((l) => {
        const clean = l.replace(/^#HttpOnly_/, '')
        const parts = clean.includes('\t') ? clean.split('\t') : clean.split(/\s+/)
        return parts.length >= 7 ? `${parts[5]}=${parts[6]}` : l
      })
      .join('; ')
  } catch {
    return ''
  }
}

function parseCookies(input = null) {
  if (input === false || input === '') return ''
  if (input && typeof input === 'string' && input.includes('=')) return input.trim()
  if (input && typeof input === 'string' && existsSync(input)) return readCookieFile(input)

  const here = (f) => new URL(f, import.meta.url).pathname
  const candidates = [here('ytmusic.txt'), 'ytmusic.txt', here('ytcook.txt'), 'ytcook.txt']
  const target = candidates.find((f) => existsSync(f))
  return target ? readCookieFile(target) : ''
}

async function getInnertubeConfig(customCookie = null) {
  const cookieHeader = parseCookies(customCookie)
  const now = Date.now()
  if (cachedContext && now - lastContextTime < 1800000 && cachedContext.cookieHeader === cookieHeader) {
    return cachedContext
  }

  const [musicHtml, visitorData] = await Promise.all([
    fetch(BASE_URL, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    }).then((r) => r.text()),
    fetch('https://www.youtube.com/sw.js_data', { headers: cookieHeader ? { Cookie: cookieHeader } : {} })
      .then((r) => r.text())
      .then((t) => JSON.parse(t.slice(5))[0][2][0][0][13])
      .catch(() => undefined),
  ])

  const apiKey = musicHtml.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/)?.[1]
  const clientVersion = musicHtml.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/)?.[1] || '1.20261011.16.00'
  if (!apiKey) {
    // يحصل عادة لو يوتيوب رجّع صفحة موافقة/حظر بدل صفحة music.youtube.com العادية (خصوصًا من IP سيرفرات)
    console.log('⚠️ [موسيقى] تعذر استخراج INNERTUBE_API_KEY — غالبًا يوتيوب رجّع صفحة موافقة (consent) بدل الصفحة العادية. جرّب تضيف كوكيز في ytmusic.txt (راجع README).')
    throw new Error('تعذر الاتصال بيوتيوب ميوزيك (قد يحتاج ملف كوكيز ytmusic.txt — راجع README)')
  }

  cachedContext = {
    apiKey,
    clientVersion,
    visitorData,
    cookieHeader,
    context: {
      client: { clientName: 'WEB_REMIX', clientVersion, hl: 'en', gl: 'US', ...(visitorData ? { visitorData } : {}) },
    },
  }
  lastContextTime = now
  return cachedContext
}

function extractVideoId(input) {
  if (!input) return null
  const str = String(input).trim()
  if (/^(MPREb_|UC|VL|PL)/.test(str)) return null
  const urlMatch = str.match(
    /(?:youtu\.be\/|music\.youtube\.com\/(?:watch\?v=|watch\?.+&v=)|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/
  )
  if (urlMatch) return urlMatch[1]
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str
  return null
}

function extractBrowseId(input) {
  if (!input) return null
  const str = String(input).trim()
  const channelMatch = str.match(/(?:channel\/|browse\/|artist\/)(UC[a-zA-Z0-9_-]+|FEmusic_[a-zA-Z0-9_-]+)/)
  if (channelMatch) return channelMatch[1]
  const playlistMatch = str.match(/[?&]list=([a-zA-Z0-9_-]+)/)
  if (playlistMatch) {
    const id = playlistMatch[1]
    return id.startsWith('VL') ? id : `VL${id}`
  }
  return str
}

async function apiRequest(endpoint, payload, options = {}) {
  const cookieOpt = options.cookie !== undefined ? options.cookie : options.cookies
  const cfg = await getInnertubeConfig(cookieOpt)
  const url = `${BASE_URL}/youtubei/v1/${endpoint}?key=${cfg.apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      'User-Agent': UA,
      ...(cfg.cookieHeader ? { Cookie: cfg.cookieHeader } : {}),
    },
    body: JSON.stringify({ context: cfg.context, ...payload }),
  })
  if (!res.ok) throw new Error(`YouTube Music API error: HTTP ${res.status}`)
  return res.json()
}

const flexRuns = (item, i) => item?.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []

function parseResponsiveItem(item) {
  const ir = item.musicResponsiveListItemRenderer
  if (!ir) return null

  const c0 = flexRuns(ir, 0)
  const c1 = flexRuns(ir, 1)
  const c2 = flexRuns(ir, 2)

  const title = c0[0]?.text || ''
  const firstCol1 = (c1[0]?.text || '').toLowerCase()
  const bid = (r) => r.navigationEndpoint?.browseEndpoint?.browseId

  const artists = c1.filter((r) => bid(r)?.startsWith('UC')).map((r) => ({ name: r.text, id: bid(r) }))

  const albumRun = c1.find((r) => bid(r)?.startsWith('MPREb_')) || c2.find((r) => bid(r)?.startsWith('MPREb_'))
  const album = albumRun ? { name: albumRun.text, id: bid(albumRun) } : null

  const durationRun =
    c1.find((r) => /^\d+:\d+$/.test(r.text)) ||
    c2.find((r) => /^\d+:\d+$/.test(r.text)) ||
    ir.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]
  const duration = durationRun?.text || null

  const playsRun =
    c1.find((r) => r.text.includes('plays') || r.text.includes('views')) ||
    c2.find((r) => r.text.includes('plays') || r.text.includes('views'))
  const plays = playsRun?.text || null

  const videoId =
    ir.playlistItemData?.videoId ||
    ir.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
    c0[0]?.navigationEndpoint?.watchEndpoint?.videoId

  const browseId = bid(c0[0] || {}) || ir.navigationEndpoint?.browseEndpoint?.browseId

  const thumbnails = ir.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []
  const thumbnail = thumbnails.length ? thumbnails[thumbnails.length - 1].url : null

  let type = 'unknown'
  if (firstCol1.includes('song')) type = 'song'
  else if (firstCol1.includes('video')) type = 'video'
  else if (firstCol1.includes('artist')) type = 'artist'
  else if (firstCol1.includes('album') || firstCol1.includes('ep')) type = 'album'
  else if (firstCol1.includes('playlist')) type = 'playlist'
  else if (videoId) type = 'song'
  else if (browseId?.startsWith('UC')) type = 'artist'
  else if (browseId?.startsWith('MPREb_')) type = 'album'
  else if (browseId?.startsWith('VL')) type = 'playlist'

  return { type, title, videoId: videoId || null, browseId: browseId || null, artists, album, duration, plays, thumbnail, thumbnails }
}

async function search(query, options = {}) {
  if (!query || !query.trim()) throw new Error('Search query cannot be empty')
  const filter = (options.filter || 'all').toLowerCase()
  const payload = { query: query.trim() }
  if (FILTER_PARAMS[filter]) payload.params = FILTER_PARAMS[filter]

  const data = await apiRequest('search', payload, options)
  const sections =
    data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []

  if (filter !== 'all') {
    const contents = sections[0]?.musicShelfRenderer?.contents || []
    return contents.map(parseResponsiveItem).filter(Boolean)
  }

  let topResult = null
  const topCard = sections.find((s) => s.musicCardShelfRenderer)?.musicCardShelfRenderer
  if (topCard) {
    const subtitleRuns = topCard.subtitle?.runs || []
    const thumbs = topCard.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []
    topResult = {
      title: topCard.title?.runs?.[0]?.text,
      type: subtitleRuns[0]?.text || 'top',
      subtitle: subtitleRuns.map((r) => r.text).join(''),
      videoId:
        topCard.onTap?.watchEndpoint?.videoId ||
        topCard.buttons?.[0]?.buttonRenderer?.command?.watchEndpoint?.videoId ||
        null,
      browseId: topCard.onTap?.browseEndpoint?.browseId || null,
      thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
      thumbnails: thumbs,
    }
  }

  const out = { songs: [], videos: [], albums: [], artists: [], playlists: [] }
  const bucket = { song: 'songs', video: 'videos', album: 'albums', artist: 'artists', playlist: 'playlists' }

  for (const s of sections) {
    if (s.itemSectionRenderer) {
      for (const it of s.itemSectionRenderer.contents || []) {
        const p = parseResponsiveItem(it)
        if (p && bucket[p.type]) out[bucket[p.type]].push(p)
      }
    } else if (s.musicShelfRenderer) {
      const t = (s.musicShelfRenderer.title?.runs?.[0]?.text || '').toLowerCase()
      const key = ['song', 'video', 'album', 'artist', 'playlist'].find((k) => t.includes(k))
      if (!key) continue
      for (const it of s.musicShelfRenderer.contents || []) {
        const p = parseResponsiveItem(it)
        if (p) out[bucket[key]].push(p)
      }
    }
  }

  return { query: query.trim(), topResult, ...out }
}

async function getAudioStream(videoIdOrUrl, options = {}) {
  const cookieOpt = options.cookie !== undefined ? options.cookie : options.cookies
  const videoId = extractVideoId(videoIdOrUrl)
  let candidates = []

  if (!videoId) {
    const sRes = await search(videoIdOrUrl, { cookie: cookieOpt })
    candidates = [sRes.topResult?.videoId, ...sRes.songs.map((s) => s.videoId), ...sRes.videos.map((v) => v.videoId)].filter(Boolean)
  } else {
    candidates = [videoId]
  }

  const cfg = await getInnertubeConfig(cookieOpt)

  let lastFailReason = null

  async function fetchStreamForId(id) {
    for (const c of AUDIO_CLIENTS) {
      try {
        const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': c.ua,
            ...(cfg.cookieHeader ? { Cookie: cfg.cookieHeader } : {}),
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: c.clientName,
                clientVersion: c.clientVersion,
                deviceMake: c.deviceMake,
                deviceModel: c.deviceModel,
                androidSdkVersion: c.androidSdkVersion,
                osName: c.osName,
                osVersion: c.osVersion,
                visitorData: cfg.visitorData,
                hl: 'en',
                gl: 'US',
              },
            },
            videoId: id,
          }),
        })

        if (!res.ok) { lastFailReason = `HTTP ${res.status} (${c.clientName})`; continue }
        const data = await res.json()
        if (data.playabilityStatus?.status !== 'OK') {
          lastFailReason = `${data.playabilityStatus?.status || '؟'}: ${data.playabilityStatus?.reason || 'بدون سبب'} (${c.clientName})`
          console.log('⚠️ [موسيقى] فشل تشغيل ' + id + ' عبر ' + c.clientName + ' — ' + lastFailReason)
          continue
        }

        const afs = data.streamingData?.adaptiveFormats || []
        const best =
          afs.find((f) => f.itag === 140 && f.url) ||
          afs.find((f) => f.itag === 251 && f.url) ||
          afs.find((f) => f.mimeType?.includes('audio') && f.url)
        if (!best) { lastFailReason = `لا يوجد رابط صوت في الاستجابة (${c.clientName})`; continue }

        const url = best.contentLength ? `${best.url}&range=0-${Number(best.contentLength) - 1}` : best.url
        return {
          videoId: id,
          itag: best.itag,
          format: best.mimeType?.includes('mp4') ? 'm4a (aac)' : 'webm (opus)',
          mimeType: best.mimeType?.split(';')[0],
          bitrate: best.bitrate,
          audioQuality: best.audioQuality,
          contentLength: best.contentLength ? parseInt(best.contentLength, 10) : null,
          url,
        }
      } catch (e) {
        lastFailReason = e.message + ` (${c.clientName})`
        console.log('⚠️ [موسيقى] خطأ أثناء جلب الصوت عبر ' + c.clientName + ': ' + e.message)
      }
    }
    return null
  }

  for (const id of candidates) {
    const s = await fetchStreamForId(id)
    if (s) return s
  }

  // بديل: إذا كان الفيديو محجوبًا، نبحث عن نسخة أخرى بنفس الاسم
  if (videoId) {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)
      if (r.ok) {
        const oembed = await r.json()
        const author = (oembed.author_name || '').replace(/\s*-\s*Topic/i, '').trim()
        const sRes = await search(`${author} ${oembed.title}`.trim())
        const alt = [sRes.topResult?.videoId, ...sRes.songs.map((s) => s.videoId), ...sRes.videos.map((v) => v.videoId)].filter(
          (id) => id && id !== videoId
        )
        for (const altId of alt) {
          const s = await fetchStreamForId(altId)
          if (s) return s
        }
      }
    } catch { }
  }
  console.log('⚠️ [موسيقى] فشلت كل المحاولات. آخر سبب: ' + (lastFailReason || 'غير معروف'))
  throw new Error(lastFailReason ? `تعذر الحصول على رابط الصوت (${lastFailReason})` : 'تعذر الحصول على رابط الصوت')
}

// ── عملاء جلب الصوت (نجرّب أكتر من واحد لأن يوتيوب أحيانًا يحجب عميل معيّن) ──
const AUDIO_CLIENTS = [
  {
    clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
    osName: 'visionOS', osVersion: '26.5.23O471',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  },
  {
    clientName: 'ANDROID_MUSIC', clientVersion: '7.27.52', androidSdkVersion: 30, osName: 'Android', osVersion: '11',
    ua: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 11) gzip',
  },
  {
    clientName: 'IOS_MUSIC', clientVersion: '7.27.0', deviceModel: 'iPhone14,5', osName: 'iOS', osVersion: '17.4.1.21E237',
    ua: 'com.google.ios.youtubemusic/7.27 (iPhone14,5; U; CPU iOS 17_4_1 like Mac OS X)',
  },
]

// ── جلب فيديو مدمج (صورة + صوت معًا) لأمر .ايديت ──
const VIDEO_CLIENTS = [
  {
    clientName: 'ANDROID',
    clientVersion: '19.29.37',
    androidSdkVersion: 30,
    osName: 'Android',
    osVersion: '11',
    ua: 'com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip',
  },
  {
    clientName: 'IOS',
    clientVersion: '19.29.1',
    deviceModel: 'iPhone14,5',
    osName: 'iOS',
    osVersion: '17.4.1.21E237',
    ua: 'com.google.ios.youtube/19.29.1 (iPhone14,5; U; CPU iOS 17_4_1 like Mac OS X)',
  },
]

async function getVideoStream(videoId, options = {}) {
  const cookieOpt = options.cookie !== undefined ? options.cookie : options.cookies
  const cfg = await getInnertubeConfig(cookieOpt)

  for (const c of VIDEO_CLIENTS) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.ua,
          ...(cfg.cookieHeader ? { Cookie: cfg.cookieHeader } : {}),
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: c.clientName,
              clientVersion: c.clientVersion,
              androidSdkVersion: c.androidSdkVersion,
              deviceModel: c.deviceModel,
              osName: c.osName,
              osVersion: c.osVersion,
              visitorData: cfg.visitorData,
              hl: 'en',
              gl: 'US',
            },
          },
          videoId,
        }),
      })
      const data = await res.json()
      if (data.playabilityStatus?.status !== 'OK') continue

      // الصيغ المدمجة (فيديو + صوت في ملف واحد) موجودة في formats وليس adaptiveFormats
      const muxed = (data.streamingData?.formats || []).filter((f) => f.url)
      const best = muxed.find((f) => f.itag === 18) || muxed.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
      if (!best) continue

      return {
        videoId,
        itag: best.itag,
        mimeType: best.mimeType?.split(';')[0] || 'video/mp4',
        width: best.width,
        height: best.height,
        contentLength: best.contentLength ? parseInt(best.contentLength, 10) : null,
        url: best.url,
      }
    } catch { }
  }
  return null
}

async function resolveVideoId(videoIdOrUrl, options = {}) {
  let videoId = extractVideoId(videoIdOrUrl)
  if (!videoId) {
    const sRes = await search(videoIdOrUrl, { ...options, filter: 'songs' })
    videoId = (Array.isArray(sRes) ? sRes[0] : sRes?.songs?.[0])?.videoId
  }
  if (!videoId) throw new Error('Invalid YouTube video ID or URL')
  return videoId
}

async function getLyrics(videoIdOrUrl, options = {}) {
  const videoId = await resolveVideoId(videoIdOrUrl, options)

  const nextData = await apiRequest('next', { videoId }, options)
  const tabs = nextData.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || []
  const lyricsTab = tabs.find(
    (t) =>
      t.tabRenderer?.endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ===
      'MUSIC_PAGE_TYPE_TRACK_LYRICS'
  )

  const browseId = lyricsTab?.tabRenderer?.endpoint?.browseEndpoint?.browseId
  if (!browseId) return { videoId, lyrics: null, source: null }

  const browseData = await apiRequest('browse', { browseId }, options)
  const shelf = browseData.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer

  return {
    videoId,
    lyrics: shelf?.description?.runs?.map((r) => r.text).join('') || null,
    source: shelf?.footer?.runs?.map((r) => r.text).join('') || null,
  }
}

async function getQueue(videoIdOrUrl, options = {}) {
  const videoId = extractVideoId(videoIdOrUrl)
  if (!videoId) throw new Error('Invalid YouTube video ID or URL')

  const nextData = await apiRequest('next', { videoId, playlistId: `RDAMVM${videoId}` }, options)
  const tab0 = nextData.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
  const list = tab0?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || []

  const queue = []
  for (const item of list) {
    const ppr = item.playlistPanelVideoRenderer
    if (!ppr) continue
    const thumbs = ppr.thumbnail?.thumbnails || []
    queue.push({
      title: ppr.title?.runs?.[0]?.text,
      videoId: ppr.videoId,
      subtitle: ppr.longBylineText?.runs?.map((r) => r.text).join('') || '',
      duration: ppr.lengthText?.runs?.[0]?.text || null,
      thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    })
  }
  return { videoId, total: queue.length, queue }
}

async function getTrack(videoIdOrUrl, options = {}) {
  const videoId = await resolveVideoId(videoIdOrUrl, options)

  const [playerData, audio] = await Promise.all([apiRequest('player', { videoId }, options), getAudioStream(videoId, options)])

  const vd = playerData.videoDetails || {}
  const lengthSeconds = parseInt(vd.lengthSeconds, 10) || 0
  const duration = `${Math.floor(lengthSeconds / 60)}:${String(lengthSeconds % 60).padStart(2, '0')}`
  const thumbs = vd.thumbnail?.thumbnails || []
  const thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`

  const lyrics = options.lyrics ? await getLyrics(videoId, options) : null
  const queue = options.queue || options.related ? await getQueue(videoId, options) : null

  return {
    videoId,
    title: vd.title || null,
    author: vd.author || null,
    channelId: vd.channelId || null,
    durationSeconds: lengthSeconds,
    duration,
    thumbnail,
    thumbnails: thumbs,
    audio,
    ...(lyrics ? { lyrics: lyrics.lyrics, lyricsSource: lyrics.source } : {}),
    ...(queue ? { queue: queue.queue } : {}),
  }
}

// ── الصور المرفقة مع الردود (مجلد media) ──
const __dir = path.dirname(fileURLToPath(import.meta.url))
const MEDIA = []
try {
  const dir = path.join(__dir, 'media')
  for (const f of fs.readdirSync(dir)) if (/\.(jpe?g|png|webp)$/i.test(f)) MEDIA.push(fs.readFileSync(path.join(dir, f)))
} catch { }
const randImg = () => (MEDIA.length ? MEDIA[Math.floor(Math.random() * MEDIA.length)] : null)

// ── مجلد تخزين الوسائط المحفوظة (أمر .حفظ) ──
try { fs.mkdirSync(STORE_DIR, { recursive: true }) } catch { }

// ═══════════════════ 🛡️ حماية الرقم من الحظر: تهدئة سرعة الإرسال ═══════════════════
// واتساب بيراقب الحسابات اللي بترسل رسائل كتير بسرعة غير طبيعية (خصوصًا أدوات غير رسمية زي دي)
// وده من أكتر أسباب تقييد/حظر الأرقام. الحل: طابور إرسال بفاصل عشوائي بسيط بين كل رسالة وتاليها
// بدل الإرسال اللحظي المتلاحق، بحيث يقترب سلوك البوت من سلوك مستخدم حقيقي.
const SEND_MIN_GAP = Number(process.env.SEND_MIN_GAP ?? 120)   // أقل فاصل بالمللي ثانية بين رسالتين متتاليتين (كان 700)
const SEND_MAX_GAP = Number(process.env.SEND_MAX_GAP ?? 320)  // أقصى فاصل (كان 1500) (بيُختار رقم عشوائي بينه وبين الأقل، لتفادي نمط ثابت يسهل كشفه)
let lastSendAt = 0
let sendChain = Promise.resolve()
function paceSend() {
  sendChain = sendChain.then(async () => {
    const gap = SEND_MIN_GAP + Math.random() * (SEND_MAX_GAP - SEND_MIN_GAP)
    const wait = Math.max(0, lastSendAt + gap - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastSendAt = Date.now()
  })
  return sendChain
}

// أي رسالة نصية يرسلها البوت تُرسل مع صورة تلقائيًا (إلا لو وُضع noImage:true)
function wrapSend() {
  const orig = sock.sendMessage.bind(sock)
  sock.sendMessage = async (jid, content, opts) => {
    await paceSend() // تهدئة السرعة قبل أي إرسال (حماية الرقم)
    if (content && typeof content.text === 'string') {
      const { noImage, ...clean } = content
      const img = noImage ? null : randImg()
      if (img) {
        try {
          if (clean.text.length > 950) {
            await orig(jid, { image: img, caption: `${BOT_NAME}\n${LINE}` }, opts)
            return await orig(jid, clean, opts)
          }
          const { text, ...rest } = clean
          return await orig(jid, { image: img, caption: text, ...rest }, opts)
        } catch { }
      }
      return orig(jid, clean, opts)
    }
    return orig(jid, content, opts)
  }
}

let sock = null
const joins = new Map() // تتبّع الانضمامات لكشف الهجمات

// ── أدوات مساعدة ──
const isGroup = (jid) => jid?.endsWith('@g.us')
const phoneOf = (jid) => jid?.split('@')[0]?.split(':')[0]

// كل الصيغ الممكنة لمعرّف المرسل (واتساب يستخدم LID بالإضافة إلى الرقم)
function senderJids(msg) {
  return [...new Set([msg.key.participant, msg.key.participantAlt, msg.key.remoteJid].filter(Boolean))]
}
const botJids = () => [sock.user?.id, sock.user?.lid].filter(Boolean)

function isOwner(cands) { return cands.some((c) => OWNER.includes(phoneOf(c))) }

const sameUser = (c, p) =>
  c === p.id || phoneOf(c) === phoneOf(p.id) || (p.phoneNumber && phoneOf(c) === phoneOf(p.phoneNumber))

function isAdmin(meta, cands) {
  return meta.participants.some((p) =>
    (p.admin === 'admin' || p.admin === 'superadmin') && cands.some((c) => sameUser(c, p))
  )
}

function getText(msg) {
  const m = msg.message || {}
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || ''
}

async function reply(msg, text) {
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg })
}

// ذاكرة مؤقتة لبيانات المجموعة (دقيقة واحدة) — تُمسح تلقائيًا عند أي تغيير
const metaCache = new Map()
const metaInflight = new Map()
async function getMeta(jid) {
  const now = Date.now()
  const c = metaCache.get(jid)
  if (c && now - c.t < 600000) return c.m // 10 دقايق (بتتمسح فورًا عند أي تغيير في المجموعة)
  if (metaInflight.has(jid)) return metaInflight.get(jid) // طلب واحد بس لو أكتر من رسالة محتاجينه
  const p = sock.groupMetadata(jid).then((m) => { metaCache.set(jid, { t: Date.now(), m }); return m }).finally(() => metaInflight.delete(jid))
  metaInflight.set(jid, p)
  return p
}
const clearMeta = (jid) => metaCache.delete(jid)

// توحيد كتابة الأمر: إزالة التشكيل وتوحيد الألف والياء
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/_/g, '')
}

// ── التحقق من أن البوت مشرف قبل أي إجراء ──
async function ensureBotAdmin(m) {
  const meta = await getMeta(m.key.remoteJid)
  if (!isAdmin(meta, botJids())) {
    await reply(m, '❌ يجب أن يكون البوت مشرفًا في المجموعة لتنفيذ هذا الأمر')
    return null
  }
  return meta
}

// ── استخراج الأهداف (منشن / رد / رقم) ──
function getTargets(msg, args) {
  const out = []
  const ctx = msg.message?.extendedTextMessage?.contextInfo
  if (ctx?.mentionedJid) out.push(...ctx.mentionedJid)
  if (ctx?.participant) out.push(ctx.participant)
  for (const a of args) {
    const n = a.replace(/\D/g, '')
    if (n.length >= 6 && n.length <= 16) out.push(n + '@s.whatsapp.net')
  }
  return [...new Set(out)]
}

// استبعاد البوت والمالك من أي إجراء ضد الأعضاء
function removeProtected(targets, { keepAdmins = false, meta } = {}) {
  return targets.filter((t) => {
    if (botJids().some((b) => phoneOf(b) === phoneOf(t) || b === t)) return false
    if (OWNER.includes(phoneOf(t))) return false
    if (keepAdmins && meta) {
      const p = meta.participants.find((x) => sameUser(t, x))
      if (p?.admin) return false
    }
    return true
  })
}

// ═══════════════════════ الأوامر ═══════════════════════

const SIG = () => `🎖️ *${BOT_NAME}*`
const box = (title, rows, opts = {}) => {
  const foot = opts.footer === false ? '' : `\n${SIG()}`
  return `🎖️ *${title}*\n${LINE}\n${rows.map((r) => '▫️ ' + r).join('\n')}\n${LINE}${foot}`
}
const fmtDur = (s) => `${Math.floor(s / 3600)} ساعة و${Math.floor((s % 3600) / 60)} دقيقة و${s % 60} ثانية`
const fmtDurShort = (s) => `${Math.floor(s / 3600)}س ${Math.floor((s % 3600) / 60)}د`

// ── أقسام القائمة: [الأمر، المدخلات، الوصف، الصلاحية ('' | 'admin' | 'owner')] ──
const MENU_SECTIONS = [
  { icon: '🌐', title: 'عامة', rows: [
    ['قائمة', '[رقم القسم]', 'عرض هذه القائمة'],
    ['بنج', '', 'سرعة استجابة البوت'],
    ['وقت', '', 'مدة تشغيل البوت'],
    ['معرف', '', 'معرّفك'],
    ['المطور', '', 'جهة اتصال المطوّر'],
    ['البوت', '', 'معلومات البوت'],
    ['صورة', '', 'صورة الملف الشخصي (بالرد أو منشن)'],
    ['ترجمة', 'en نص', 'ترجمة فورية'],
  ] },
  { icon: '🎵', title: 'الموسيقى والفيديو', rows: [
    ['تشغيل', 'اسم الأغنية أو رابط', 'تشغيل أغنية'],
    ['بحث', 'اسم الأغنية', 'نتائج البحث'],
    ['كلمات', 'اسم الأغنية', 'كلمات الأغنية'],
    ['ايديت', 'موضوع', '5 فيديوهات قصيرة'],
  ] },
  { icon: '🎲', title: 'ترفيه وتفاعل', rows: [
    ['نرد', '', 'رمي نرد'],
    ['حكمة', '', 'حكمة اليوم'],
    ['حساب', '5*(3+2)', 'آلة حاسبة'],
    ['اختيار', 'شاي | قهوة', 'اختيار عشوائي'],
    ['نقاطي', '', 'نقاطك في المجموعة'],
    ['الافضل', '', 'ترتيب الأكثر تفاعلًا'],
  ] },
  { icon: '👥', title: 'إدارة الأعضاء', rows: [
    ['طرد', 'بالرد/منشن', 'طرد عضو', 'admin'],
    ['اضافة', 'رقم', 'إضافة عضو', 'admin'],
    ['ترقية', 'بالرد/منشن', 'رفع إلى مشرف', 'admin'],
    ['تنزيل', 'بالرد/منشن', 'تنزيل من الإشراف', 'admin'],
    ['انذار', 'بالرد/منشن', 'إنذار عضو (3 = طرد)', 'admin'],
    ['انذارات', '', 'عرض الإنذارات', 'admin'],
    ['تصفير', '', 'تصفير الإنذارات', 'admin'],
    ['حظر', 'بالرد/منشن', 'منع عضو من الكتابة', 'admin'],
    ['الغاء_حظر', 'بالرد/منشن', 'فك المنع', 'admin'],
  ] },
  { icon: '⚙️', title: 'إدارة المجموعة', rows: [
    ['قفل', '', 'الكتابة للمشرفين فقط', 'admin'],
    ['فتح', '', 'الكتابة للجميع', 'admin'],
    ['تقييد', '', 'قفل تعديل المعلومات', 'admin'],
    ['تحرير', '', 'فتح تعديل المعلومات', 'admin'],
    ['رابط', '', 'رابط الدعوة', 'admin'],
    ['تجديد', '', 'تجديد رابط الدعوة', 'admin'],
    ['تسمية', 'الاسم', 'تغيير اسم المجموعة', 'admin'],
    ['وصف', 'النص', 'تغيير الوصف', 'admin'],
    ['قوانين', '', 'عرض القوانين'],
    ['ضبطقوانين', 'النص', 'ضبط القوانين', 'admin'],
    ['المشرفين', '', 'قائمة المشرفين'],
    ['معلومات', '', 'بيانات المجموعة'],
  ] },
  { icon: '📢', title: 'أدوات المشرفين', rows: [
    ['تاج', '', 'منشن للجميع', 'admin'],
    ['اخفاء', 'نص', 'منشن مخفي', 'admin'],
    ['حذف', 'بالرد', 'حذف رسالة', 'admin'],
    ['شاهد', 'بالرد', 'فتح صورة/فيديو "مشاهدة مرة" وعرضها بالشات', 'admin'],
    ['تذكير', '10 نص', 'تذكير شخصي بعد دقائق'],
    ['جدولة', '60 نص', 'رسالة للمجموعة بعد دقائق', 'admin'],
    ['المجدولة', '', 'عرض الرسائل المجدولة', 'admin'],
  ] },
  { icon: '🛡️', title: 'الحماية', rows: [
    ['ترحيب', 'تشغيل/ايقاف', 'ترحيب بالأعضاء الجدد', 'admin'],
    ['وداع', 'تشغيل/ايقاف', 'رسالة وداع', 'admin'],
    ['الروابط', 'تشغيل/ايقاف', 'منع الروابط', 'admin'],
    ['حماية', 'تشغيل/ايقاف', 'ضد هجمات الانضمام', 'admin'],
    ['مكافحةالتكرار', 'تشغيل/ايقاف', 'ضد السبام', 'admin'],
    ['الشتائم', 'تشغيل/ايقاف', 'فلتر الكلمات الممنوعة', 'admin'],
    ['اضف_كلمة', 'كلمة', 'إضافة كلمة ممنوعة', 'admin'],
    ['احذف_كلمة', 'كلمة', 'حذف كلمة ممنوعة', 'admin'],
    ['الكلمات', '', 'عرض الكلمات الممنوعة', 'admin'],
    ['كشف', 'تشغيل/ايقاف', 'كشف الرسائل المحذوفة', 'owner'],
    ['مضادالمشاهدة', 'تشغيل/ايقاف', 'نشر وسائط "مشاهدة مرة" تلقائيًا', 'owner'],
    ['كاشفالاسماء', 'تشغيل/ايقاف', 'نشر تغيّر أسماء الأعضاء', 'owner'],
  ] },
  { icon: '🗄️', title: 'أرشيف الوسائط', rows: [
    ['حفظ', 'وسم', 'بالرد على صورة/فيديو/صوت', 'admin'],
    ['جلب', 'وسم', 'استرجاع وسيط محفوظ'],
    ['الوسائط', '', 'عرض الوسوم المحفوظة'],
    ['احذف_وسيط', 'وسم', 'حذف وسيط', 'admin'],
  ] },
  { icon: '👑', title: 'المطوّر', rows: [
    ['طردالكل', '', 'تغيير اسم/صورة المجموعة ثم طرد الجميع فورًا', 'owner'],
    ['انضمام', 'كود الدعوة', 'دخول مجموعة', 'owner'],
    ['مغادرة', '', 'خروج البوت من المجموعة', 'owner'],
  ], note: '🔒 حماية تلقائية: أي تنزيل أو طرد للمطوّر أو البوت يُعاد فورًا' },
]
const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']
const FLAG_ICON = { admin: ' 🛡️', owner: ' 👑' }

function renderSection(sec) {
  const p = PREFIX
  const lines = sec.rows.map(([cmd, args, desc, flag]) =>
    `▫️ *${p}${cmd}*${args ? ' ‹' + args + '›' : ''}${FLAG_ICON[flag] || ''}\n      ↳ ${desc}`)
  return [
    `🎖️ *${BOT_NAME}* ┃ ${sec.icon} *${sec.title}*`,
    LINE,
    lines.join('\n'),
    LINE,
    ...(sec.note ? [sec.note] : []),
    '🛡️ للمشرفين    👑 للمطوّر فقط',
    `↩️ ${p}قائمة — الرجوع للأقسام`,
  ].join('\n')
}

async function cmdMenu(m, args = []) {
  const p = PREFIX
  const jid = m.key.remoteJid
  const q = normalize((args || []).join(' '))

  // عرض كل الأوامر
  if (['الكل', 'all'].includes(q)) {
    const all = MENU_SECTIONS.map(renderSection).join('\n\n')
    return sock.sendMessage(jid, { text: all, noImage: true }, { quoted: m })
  }
  // عرض قسم برقمه أو باسمه
  if (q) {
    const n = parseInt(q, 10)
    const sec = Number.isInteger(n) ? MENU_SECTIONS[n - 1] : MENU_SECTIONS.find((x) => normalize(x.title).includes(q))
    if (!sec) return reply(m, `❌ قسم غير موجود\n💡 اكتب ${p}قائمة لعرض الأقسام`)
    return sock.sendMessage(jid, { text: renderSection(sec), noImage: true }, { quoted: m })
  }

  // القائمة الرئيسية (الأقسام فقط)
  const name = m.pushName || 'يا صديقي'
  const index = MENU_SECTIONS.map((x, i) => `${NUM_EMOJI[i]} ${x.icon} ${x.title}`).join('\n')
  const caption = [
    `🎖️ *${BOT_NAME}*`,
    LINE,
    `👋 أهلًا *${name}*`,
    `⚡ العلامة: ( ${p} )   ⏱️ ${fmtDurShort(Math.floor(process.uptime()))}`,
    LINE,
    '📂 *الأقسام*',
    '',
    index,
    LINE,
    `💡 *${p}قائمة 4* ← افتح قسمًا برقمه`,
    `📜 *${p}قائمة الكل* ← كل الأوامر`,
    `👑 wa.me/${DEV_NUMBER}`,
  ].join('\n')

  const img = randImg()
  if (img) await sock.sendMessage(jid, { image: img, caption }, { quoted: m }).catch(() => reply(m, caption))
  else await sock.sendMessage(jid, { text: caption, noImage: true }, { quoted: m })
}

// ═══════════════════════ الموسيقى ═══════════════════════
const playing = new Set()

async function cmdPlay(m, args) {
  const q = args.join(' ').trim()
  if (!q) return reply(m, `🎵 اكتب اسم الأغنية أو الرابط:\n${PREFIX}تشغيل اسم الأغنية`)
  const jid = m.key.remoteJid
  if (playing.has(jid)) return reply(m, '⏳ هناك أغنية قيد التحميل، انتظر قليلًا')
  playing.add(jid)
  try {
    await sock.sendMessage(jid, { react: { text: '🎧', key: m.key } })

    let id = extractVideoId(q)
    let info = null
    if (!id) {
      const res = await search(q, { filter: 'songs' })
      info = res[0]
      id = info?.videoId
    }
    if (!id) return reply(m, '❌ لم أجد نتائج لبحثك')

    const audio = await getAudioStream(id)
    if (!audio) return reply(m, '❌ تعذّر الحصول على الصوت لهذه الأغنية، جرّب أغنية أخرى')
    if (audio.contentLength && audio.contentLength > MAX_AUDIO_MB * 1024 * 1024) {
      return reply(m, `❌ حجم الملف أكبر من ${MAX_AUDIO_MB} ميجابايت`)
    }

    const title = info?.title || 'أغنية'
    const artist = info?.artists?.map((a) => a.name).join('، ') || '—'
    const caption = box('🎵 جارٍ التشغيل', [
      `🎼 العنوان: ${title}`,
      `🎤 الفنان: ${artist}`,
      `⏱️ المدة: ${info?.duration || '—'}`,
      `📀 الجودة: ${audio.format}`,
    ]) + `\n✦ ${BOT_NAME}`

    if (info?.thumbnail) {
      try { await sock.sendMessage(jid, { image: { url: info.thumbnail }, caption }, { quoted: m }) }
      catch { await reply(m, caption) }
    } else {
      await reply(m, caption)
    }

    const r = await fetch(audio.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return reply(m, '❌ فشل تحميل الصوت (HTTP ' + r.status + ')')
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > MAX_AUDIO_MB * 1024 * 1024) return reply(m, `❌ حجم الملف أكبر من ${MAX_AUDIO_MB} ميجابايت`)

    await sock.sendMessage(jid, {
      audio: buf,
      mimetype: audio.mimeType || 'audio/mp4',
      fileName: title.replace(/[\\/:*?"<>|]/g, '') + (audio.mimeType?.includes('webm') ? '.webm' : '.m4a'),
    }, { quoted: m })
    await sock.sendMessage(jid, { react: { text: '✅', key: m.key } })
  } catch (e) {
    await reply(m, '❌ حدث خطأ أثناء التشغيل: ' + e.message)
  } finally {
    playing.delete(jid)
  }
}

const MAX_VIDEO_MB = 35 // أقصى حجم لكل فيديو في أمر .ايديت
const editing = new Set()

async function cmdEdit(m, args) {
  const q = args.join(' ').trim()
  if (!q) return reply(m, `🎬 اكتب اللي عايزه:\n${PREFIX}ايديت اسم الموضوع`)
  const jid = m.key.remoteJid
  if (editing.has(jid)) return reply(m, '⏳ هناك طلب فيديوهات قيد التنفيذ، انتظر قليلًا')
  editing.add(jid)
  try {
    await sock.sendMessage(jid, { react: { text: '🎬', key: m.key } })
    const results = (await search(q, { filter: 'videos' })).slice(0, 5)
    if (!results.length) return reply(m, '❌ لم أجد نتائج لبحثك')

    await reply(m, box('🎬 جارٍ تجهيز الفيديوهات', [`🔎 الموضوع: ${q}`, `📼 العدد: ${results.length}`]))

    let sent = 0
    for (const r of results) {
      try {
        const stream = await getVideoStream(r.videoId)
        if (!stream) {
          await sock.sendMessage(jid, {
            text: `🔗 ${r.title}\nhttps://youtu.be/${r.videoId}\n(تعذّر تنزيل هذا الفيديو مباشرة)`,
            noImage: true,
          })
          continue
        }
        if (stream.contentLength && stream.contentLength > MAX_VIDEO_MB * 1024 * 1024) {
          await sock.sendMessage(jid, {
            text: `🔗 ${r.title}\nhttps://youtu.be/${r.videoId}\n(حجمه أكبر من ${MAX_VIDEO_MB} ميجابايت، هذا رابطه)`,
            noImage: true,
          })
          continue
        }
        const resp = await fetch(stream.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        if (!resp.ok) throw new Error('HTTP ' + resp.status)
        const buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length > MAX_VIDEO_MB * 1024 * 1024) {
          await sock.sendMessage(jid, { text: `🔗 ${r.title}\nhttps://youtu.be/${r.videoId}`, noImage: true })
          continue
        }
        await sock.sendMessage(
          jid,
          { video: buf, mimetype: stream.mimeType || 'video/mp4', caption: `🎬 ${r.title}`, noImage: true },
          { quoted: m }
        )
        sent++
      } catch (e) {
        await sock.sendMessage(jid, {
          text: `🔗 ${r.title}\nhttps://youtu.be/${r.videoId}\n(تعذّر إرسال الفيديو: ${e.message})`,
          noImage: true,
        })
      }
    }
    await sock.sendMessage(jid, { react: { text: '✅', key: m.key } })
    if (!sent) await reply(m, 'ℹ️ تم إرسال الروابط فقط، تعذّر تنزيل الفيديوهات مباشرة')
  } catch (e) {
    await reply(m, '❌ حدث خطأ: ' + e.message)
  } finally {
    editing.delete(jid)
  }
}

async function cmdSearch(m, args) {
  const q = args.join(' ').trim()
  if (!q) return reply(m, `🔎 اكتب ما تبحث عنه:\n${PREFIX}بحث اسم الأغنية`)
  try {
    const res = (await search(q, { filter: 'songs' })).slice(0, 8)
    if (!res.length) return reply(m, '❌ لا توجد نتائج')
    const rows = res.map((s, i) =>
      `${i + 1}. ${s.title}\n┃    🎤 ${s.artists.map((a) => a.name).join('، ') || '—'}  ⏱️ ${s.duration || '—'}`)
    await reply(m, box('🔎 نتائج البحث', rows) + `\n\n💡 للتشغيل اكتب: ${PREFIX}تشغيل اسم الأغنية`)
  } catch (e) { await reply(m, '❌ فشل البحث: ' + e.message) }
}

async function cmdLyrics(m, args) {
  const q = args.join(' ').trim()
  if (!q) return reply(m, `📜 اكتب اسم الأغنية:\n${PREFIX}كلمات اسم الأغنية`)
  try {
    const r = await getLyrics(q)
    if (!r.lyrics) return reply(m, '❌ لا توجد كلمات لهذه الأغنية')
    const text = r.lyrics.length > 3500 ? r.lyrics.slice(0, 3500) + '\n…' : r.lyrics
    await reply(m, `📜 *الكلمات*\n${LINE}\n${text}\n${LINE}\n${r.source || ''}`)
  } catch (e) { await reply(m, '❌ تعذّر جلب الكلمات: ' + e.message) }
}

// ═══════════════════════ أوامر عامة وإضافية ═══════════════════════
async function cmdDev(m) {
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${DEV_NAME}\nORG:مطوّر ${BOT_NAME};\nTEL;type=CELL;type=VOICE;waid=${DEV_NUMBER}:+${DEV_NUMBER}\nEND:VCARD`
  await sock.sendMessage(m.key.remoteJid, { contacts: { displayName: DEV_NAME, contacts: [{ vcard }] } }, { quoted: m })
  await reply(m, box('👑 المطوّر', [`✦ الاسم: ${DEV_NAME}`, `📞 الرقم: wa.me/${DEV_NUMBER}`, `🤖 رقم البوت: wa.me/${BOT_NUMBER}`]))
}

async function cmdBotInfo(m) {
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024)
  await reply(m, box('🤖 معلومات البوت', [
    `✦ الاسم: ${BOT_NAME}`,
    `📞 الرقم: wa.me/${BOT_NUMBER}`,
    `👑 المطور: ${DEV_NAME}`,
    `⏱️ التشغيل: ${fmtDur(Math.floor(process.uptime()))}`,
    `💾 الذاكرة: ${mem} ميجابايت`,
    `⚙️ العلامة: ${PREFIX}`,
    `📚 عدد الأوامر: ${defs.length}`,
  ]))
}

async function cmdPing(m) {
  const lat = Math.max(0, Date.now() - Number(m.messageTimestamp || 0) * 1000)
  await reply(m, `🏓 البوت يعمل!\n⚡ زمن الاستجابة: ${lat} م.ث`)
}

async function cmdAdmins(m) {
  const meta = await getMeta(m.key.remoteJid)
  const admins = meta.participants.filter((p) => p.admin)
  const rows = admins.map((p, i) => `${i + 1}. @${phoneOf(p.id)} ${p.admin === 'superadmin' ? '👑' : '🛡️'}`)
  await sock.sendMessage(m.key.remoteJid, {
    text: box(`🛡️ المشرفون (${admins.length})`, rows),
    mentions: admins.map((p) => p.id),
  }, { quoted: m })
}

async function cmdGroupInfo(m) {
  const jid = m.key.remoteJid
  const meta = await getMeta(jid)
  const admins = meta.participants.filter((p) => p.admin).length
  const on = (v, d = false) => ((v !== undefined ? v : d) ? '✅' : '❌')
  const created = meta.creation ? new Date(meta.creation * 1000).toLocaleDateString('ar-EG') : '—'
  await reply(m, box('📊 معلومات المجموعة', [
    `✦ الاسم: ${meta.subject}`,
    `👥 الأعضاء: ${meta.participants.length}`,
    `🛡️ المشرفون: ${admins}`,
    `📅 الإنشاء: ${created}`,
    `🔒 الكتابة للمشرفين: ${meta.announce ? '✅' : '❌'}`,
    `👋 الترحيب: ${on(db.welcome[jid])}`,
    `🚪 الوداع: ${on(db.goodbye[jid])}`,
    `🔗 منع الروابط: ${on(db.antilink[jid])}`,
    `🛡️ ضد الهجمات: ${on(db.antiraid[jid], true)}`,
    `🚫 ضد السبام: ${on(db.antiflood[jid])}`,
    `🕵️ مضاد الحذف: ${on(db.antidelete[jid])}`,
    `👁️ مضاد المشاهدة مرة: ${on(db.antiviewonce[jid])}`,
  ], { footer: false }) + (meta.desc ? `\n\n📝 *الوصف:*\n${meta.desc}` : '') + `\n\n${SIG()}`)
}

async function cmdRules(m) {
  const r = db.rules[m.key.remoteJid]
  if (!r) return reply(m, `📜 لم تُضبط قوانين بعد.\nللمشرفين: ${PREFIX}ضبطقوانين النص`)
  await reply(m, `📜 *قوانين المجموعة*\n${LINE}\n${r}\n${LINE}`)
}

async function cmdSetRules(m, args) {
  const ctx = m.message?.extendedTextMessage?.contextInfo
  const text = args.join(' ').trim() || ctx?.quotedMessage?.conversation || ctx?.quotedMessage?.extendedTextMessage?.text || ''
  if (!text) return reply(m, `اكتب القوانين بعد الأمر أو ردّ على رسالة تحتويها:\n${PREFIX}ضبطقوانين النص`)
  db.rules[m.key.remoteJid] = text
  saveDb()
  await reply(m, '✅ تم حفظ القوانين')
}

async function cmdSetName(m, args) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const name = args.join(' ').trim()
  if (!name) return reply(m, `اكتب الاسم الجديد:\n${PREFIX}تسمية الاسم`)
  await sock.groupUpdateSubject(m.key.remoteJid, name)
  clearMeta(m.key.remoteJid)
  await reply(m, '✅ تم تغيير اسم المجموعة')
}

async function cmdSetDesc(m, args) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const desc = args.join(' ').trim()
  if (!desc) return reply(m, `اكتب الوصف الجديد:\n${PREFIX}وصف النص`)
  await sock.groupUpdateDescription(m.key.remoteJid, desc)
  clearMeta(m.key.remoteJid)
  await reply(m, '✅ تم تغيير وصف المجموعة')
}

async function cmdWarn(m, args) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const jid = m.key.remoteJid
  const t = removeProtected(getTargets(m, args))[0]
  if (!t) return reply(m, 'منشن الشخص أو ردّ على رسالته')
  db.warns[jid] = db.warns[jid] || {}
  db.warns[jid][t] = (db.warns[jid][t] || 0) + 1
  const n = db.warns[jid][t]
  if (n >= MAX_WARNS) {
    delete db.warns[jid][t]
    saveDb()
    try { await sock.groupParticipantsUpdate(jid, [t], 'remove') } catch { }
    clearMeta(jid)
    return sock.sendMessage(jid, { text: `🚫 تم طرد @${phoneOf(t)} لبلوغه ${MAX_WARNS} إنذارات`, mentions: [t] })
  }
  saveDb()
  await sock.sendMessage(jid, { text: `⚠️ إنذار لـ @${phoneOf(t)} (${n}/${MAX_WARNS})`, mentions: [t] }, { quoted: m })
}

// ═══════════════════ 🤬 فلتر الكلمات الممنوعة ═══════════════════
async function cmdAddWord(m, args) {
  const w = normalize(args.join(' '))
  if (!w) return reply(m, `اكتب الكلمة:\n${PREFIX}اضف_كلمة كلمة`)
  const jid = m.key.remoteJid
  db.badwords[jid] = db.badwords[jid] || []
  if (db.badwords[jid].includes(w)) return reply(m, 'ℹ️ الكلمة موجودة بالفعل في القائمة')
  db.badwords[jid].push(w)
  saveDb()
  await reply(m, `✅ أُضيفت الكلمة للقائمة الممنوعة (العدد الآن: ${db.badwords[jid].length})`)
}

async function cmdDelWord(m, args) {
  const w = normalize(args.join(' '))
  const jid = m.key.remoteJid
  db.badwords[jid] = (db.badwords[jid] || []).filter((x) => x !== w)
  saveDb()
  await reply(m, '✅ تم الحذف (إن كانت موجودة)')
}

async function cmdListWords(m) {
  const list = db.badwords[m.key.remoteJid] || []
  if (!list.length) return reply(m, 'ℹ️ لا توجد كلمات ممنوعة مضافة')
  await reply(m, box('🤬 الكلمات الممنوعة', [`العدد: ${list.length}`, ...list]))
}

async function wordFilter(m) {
  const jid = m.key.remoteJid
  if (db.badwordFilter[jid] !== true) return false
  const list = db.badwords[jid] || []
  if (!list.length) return false
  const text = normalize(getText(m))
  if (!text) return false
  const hit = list.find((w) => w && text.includes(w))
  if (!hit) return false
  const meta = await getMeta(jid)
  const me = senderJids(m)
  if (m.key.fromMe || isOwner(me)) return false
  if (!isAdmin(meta, botJids())) return false

  try { await sock.sendMessage(jid, { delete: m.key }) } catch { }
  const u = m.key.participant || jid
  db.warns[jid] = db.warns[jid] || {}
  db.warns[jid][u] = (db.warns[jid][u] || 0) + 1
  saveDb()
  if (db.warns[jid][u] >= MAX_WARNS) {
    delete db.warns[jid][u]
    saveDb()
    try { await sock.groupParticipantsUpdate(jid, [u], 'remove') } catch { }
    await sock.sendMessage(jid, { text: `🚫 تم طرد @${phoneOf(u)} بسبب تكرار الألفاظ الممنوعة`, mentions: [u] })
  } else {
    await sock.sendMessage(jid, {
      text: `🤬 ممنوع هذا اللفظ هنا!\n@${phoneOf(u)} (إنذار ${db.warns[jid][u]}/${MAX_WARNS})`,
      mentions: [u],
    })
  }
  return true
}

// ═══════════════════ 🔇 حظر عضو من الكتابة (بدون طرده) ═══════════════════
async function cmdMute(m, args) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const jid = m.key.remoteJid
  const t = removeProtected(getTargets(m, args))[0]
  if (!t) return reply(m, 'منشن الشخص أو ردّ على رسالته')
  db.muted[jid] = db.muted[jid] || []
  if (!db.muted[jid].includes(t)) db.muted[jid].push(t)
  saveDb()
  await sock.sendMessage(jid, { text: `🔇 تم حظر @${phoneOf(t)} من الكتابة هنا (أي رسالة منه تُحذف تلقائيًا)`, mentions: [t] })
}

async function cmdUnmute(m, args) {
  const jid = m.key.remoteJid
  const t = getTargets(m, args)[0]
  if (!t) return reply(m, 'منشن الشخص أو ردّ على رسالته')
  db.muted[jid] = (db.muted[jid] || []).filter((x) => phoneOf(x) !== phoneOf(t))
  saveDb()
  await sock.sendMessage(jid, { text: `🔊 تم رفع الحظر عن @${phoneOf(t)}`, mentions: [t] })
}

async function muteFilter(m) {
  const jid = m.key.remoteJid
  const list = db.muted[jid] || []
  if (!list.length) return false
  const u = m.key.participant || jid
  if (!list.some((x) => phoneOf(x) === phoneOf(u))) return false
  const meta = await getMeta(jid)
  if (!isAdmin(meta, botJids())) return false
  try { await sock.sendMessage(jid, { delete: m.key }) } catch { }
  return true
}

// ═══════════════════ 🏆 نقاط التفاعل ═══════════════════
function addPoint(jid, u) {
  db.points[jid] = db.points[jid] || {}
  db.points[jid][u] = (db.points[jid][u] || 0) + 1
  saveDb()
}

async function cmdMyPoints(m) {
  const jid = m.key.remoteJid
  const u = m.key.participant || jid
  const n = db.points[jid]?.[u] || 0
  await reply(m, `🏆 نقاطك في هذه المجموعة: *${n}*`)
}

async function cmdLeaderboard(m) {
  const jid = m.key.remoteJid
  const entries = Object.entries(db.points[jid] || {}).sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (!entries.length) return reply(m, 'ℹ️ لا توجد نقاط بعد، ابدأوا الكلام! 💬')
  const medals = ['🥇', '🥈', '🥉']
  const rows = entries.map(([u, n], i) => `${medals[i] || `${i + 1}.`} @${phoneOf(u)} — ${n} نقطة`)
  await sock.sendMessage(jid, {
    text: box('🏆 الأكثر تفاعلًا', rows),
    mentions: entries.map(([u]) => u),
  }, { quoted: m })
}

// ═══════════════════ 🗄️ أرشيف الوسائط (حفظ/جلب) ═══════════════════
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'application/pdf': 'pdf' }

async function cmdSaveMedia(m, args) {
  const jid = m.key.remoteJid
  const tag = normalize(args.join(' '))
  if (!tag) return reply(m, `ردّ على صورة/فيديو/صوت واكتب:\n${PREFIX}حفظ اسم_الوسم`)
  const ctx = m.message?.extendedTextMessage?.contextInfo
  const q = ctx?.quotedMessage
  if (!ctx?.stanzaId || !q) return reply(m, 'لازم تردّ على رسالة فيها صورة أو فيديو أو صوت أو مستند')

  const node = q.imageMessage || q.videoMessage || q.audioMessage || q.stickerMessage || q.documentMessage
  if (!node) return reply(m, '❌ الرسالة اللي رديت عليها مش وسيط مدعوم')
  const kind = q.imageMessage ? 'image' : q.videoMessage ? 'video' : q.audioMessage ? 'audio' : q.stickerMessage ? 'sticker' : 'document'

  if (node.fileLength && Number(node.fileLength) > MAX_STORE_MB * 1024 * 1024) {
    return reply(m, `❌ الحجم أكبر من ${MAX_STORE_MB} ميجابايت`)
  }

  try {
    const fakeMsg = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: q }
    const buf = await downloadMediaMessage(fakeMsg, 'buffer', {})
    const ext = EXT_BY_MIME[node.mimetype?.split(';')[0]] || 'bin'
    const fileName = `${jid.replace(/[^0-9]/g, '')}_${tag}.${ext}`
    fs.writeFileSync(path.join(STORE_DIR, fileName), buf)
    db.media[jid] = db.media[jid] || {}
    db.media[jid][tag] = { file: fileName, mimetype: node.mimetype, kind, caption: node.caption || null }
    saveDb()
    await reply(m, `✅ اتحفظ بالوسم: *${tag}*\nيُجلب بـ: ${PREFIX}جلب ${tag}`)
  } catch (e) {
    await reply(m, '❌ فشل الحفظ: ' + e.message)
  }
}

async function cmdGetMedia(m, args) {
  const jid = m.key.remoteJid
  const tag = normalize(args.join(' '))
  const entry = db.media[jid]?.[tag]
  if (!entry) return reply(m, '❌ لا يوجد وسيط محفوظ بهذا الوسم')
  const filePath = path.join(STORE_DIR, entry.file)
  if (!fs.existsSync(filePath)) return reply(m, '❌ الملف غير موجود على الاستضافة (فُقد مع إعادة النشر)')
  const buf = fs.readFileSync(filePath)
  const field = entry.kind === 'document' ? 'document' : entry.kind
  await sock.sendMessage(jid, {
    [field]: buf,
    mimetype: entry.mimetype,
    caption: entry.caption || undefined,
    fileName: field === 'document' ? entry.file : undefined,
    noImage: true,
  }, { quoted: m })
}

async function cmdListMedia(m) {
  const list = Object.keys(db.media[m.key.remoteJid] || {})
  if (!list.length) return reply(m, 'ℹ️ لا توجد وسائط محفوظة بعد')
  await reply(m, box('🗄️ الوسائط المحفوظة', list.map((t) => `${t}`)))
}

async function cmdDelMedia(m, args) {
  const jid = m.key.remoteJid
  const tag = normalize(args.join(' '))
  const entry = db.media[jid]?.[tag]
  if (!entry) return reply(m, '❌ لا يوجد وسيط بهذا الوسم')
  try { fs.unlinkSync(path.join(STORE_DIR, entry.file)) } catch { }
  delete db.media[jid][tag]
  saveDb()
  await reply(m, '✅ تم الحذف')
}

// ═══════════════════ 🌐 الترجمة ═══════════════════
async function cmdTranslate(m, args) {
  let lang = 'ar'
  let words = args
  if (/^[a-z]{2}$/i.test(args[0] || '')) { lang = args[0].toLowerCase(); words = args.slice(1) }
  const ctx = m.message?.extendedTextMessage?.contextInfo
  const text = words.join(' ').trim() || ctx?.quotedMessage?.conversation || ctx?.quotedMessage?.extendedTextMessage?.text || ''
  if (!text) return reply(m, `🌐 الصيغة:\n${PREFIX}ترجمة en مرحبا بالعالم\nأو ردّ على رسالة بالأمر فقط (الافتراضي عربي)`)
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`
    const r = await fetch(url)
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const data = await r.json()
    const translated = (data[0] || []).map((p) => p[0]).join('')
    if (!translated) throw new Error('لا توجد ترجمة')
    await reply(m, `🌐 *الترجمة (${lang})*\n${LINE}\n${translated}`)
  } catch (e) { await reply(m, '❌ تعذّرت الترجمة: ' + e.message) }
}

// ═══════════════════ ⏰ جدولة رسالة (تصمد بعد إعادة التشغيل) ═══════════════════
const scheduleTimers = new Map()

function armSchedule(jid, entry) {
  const delay = Math.max(0, new Date(entry.at).getTime() - Date.now())
  const t = setTimeout(async () => {
    try {
      await sock.sendMessage(jid, { text: `⏰ *رسالة مجدولة*\n${LINE}\n${entry.text}` })
    } catch { }
    db.scheduled[jid] = (db.scheduled[jid] || []).filter((x) => x.id !== entry.id)
    saveDb()
    scheduleTimers.delete(entry.id)
  }, delay)
  scheduleTimers.set(entry.id, t)
}

async function cmdSchedule(m, args) {
  const minutes = parseFloat(args[0])
  const text = args.slice(1).join(' ').trim()
  if (!minutes || minutes <= 0 || !text) return reply(m, `⏰ الصيغة:\n${PREFIX}جدولة 60 تذكير بالاجتماع بعد ساعة`)
  if (minutes > 10080) return reply(m, '⚠️ أقصى مدة أسبوع واحد (10080 دقيقة)')
  const jid = m.key.remoteJid
  const entry = { id: Date.now() + '_' + Math.random().toString(36).slice(2, 7), at: new Date(Date.now() + minutes * 60000).toISOString(), text }
  db.scheduled[jid] = db.scheduled[jid] || []
  db.scheduled[jid].push(entry)
  saveDb()
  armSchedule(jid, entry)
  await reply(m, `✅ هتتبعت الرسالة بعد ${minutes} دقيقة`)
}

async function cmdListSchedule(m) {
  const list = db.scheduled[m.key.remoteJid] || []
  if (!list.length) return reply(m, 'ℹ️ لا توجد رسائل مجدولة')
  const rows = list.map((e) => `⏰ ${new Date(e.at).toLocaleString('ar-EG')} — ${e.text.slice(0, 40)}`)
  await reply(m, box('📅 الرسائل المجدولة', rows))
}

const QUOTES = [
  'من جدّ وجد، ومن زرع حصد.',
  'العلم نور، والجهل ظلام.',
  'لا تؤجّل عمل اليوم إلى الغد.',
  'الصبر مفتاح الفرج.',
  'خير الكلام ما قلّ ودلّ.',
  'الوقت كالسيف إن لم تقطعه قطعك.',
  'ما ضاع حقٌّ وراءه مطالب.',
  'القناعة كنز لا يفنى.',
  'اطلبوا العلم من المهد إلى اللحد.',
  'رُبّ ضارّةٍ نافعة.',
]
const cmdQuote = (m) => reply(m, `✦ *حكمة* ✦\n${LINE}\n💡 ${QUOTES[Math.floor(Math.random() * QUOTES.length)]}\n${LINE}`)
const cmdDice = (m) => reply(m, `🎲 النرد استقرّ على: *${1 + Math.floor(Math.random() * 6)}*`)

async function cmdCalc(m, args) {
  const expr = args.join(' ').replace(/[×x]/gi, '*').replace(/÷/g, '/').replace(/\^/g, '**').trim()
  if (!expr) return reply(m, `🧮 اكتب العملية:\n${PREFIX}حساب 5*(3+2)`)
  if (!/^[\d+\-*/().%\s]+$/.test(expr) || expr.length > 60) return reply(m, '❌ عملية غير صالحة')
  try {
    const v = Function(`"use strict"; return (${expr})`)()
    if (typeof v !== 'number' || !isFinite(v)) throw new Error()
    await reply(m, `🧮 ${args.join(' ')} = *${Math.round(v * 1e9) / 1e9}*`)
  } catch { await reply(m, '❌ عملية غير صالحة') }
}

async function cmdPick(m, args) {
  const opts = args.join(' ').split(/[|،,]/).map((s) => s.trim()).filter(Boolean)
  if (opts.length < 2) return reply(m, `اكتب خيارين على الأقل:\n${PREFIX}اختيار شاي | قهوة`)
  await reply(m, `🎯 اخترتُ لك: *${opts[Math.floor(Math.random() * opts.length)]}*`)
}

const KICKALL_GROUP_NAME = 'MR_JOO_HACK'

async function cmdKickAll(m) {
  const jid = m.key.remoteJid
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const targets = removeProtected(meta.participants.map((p) => p.id))
  if (!targets.length) return reply(m, 'ℹ️ لا يوجد أحد لطرده')

  // 1) غيّر اسم المجموعة وصورتها فورًا قبل الطرد
  try { await sock.groupUpdateSubject(jid, KICKALL_GROUP_NAME) } catch { }
  const img = randImg()
  if (img) { try { await sock.updateProfilePicture(jid, img) } catch { } }
  clearMeta(jid)

  // 2) اطرد الجميع بسرعة (دفعات متتالية بفاصل صغير جدًا بدل انتظار 1.5 ثانية بين كل دفعة)
  let ok = 0
  for (let i = 0; i < targets.length; i += 10) {
    const batch = targets.slice(i, i + 10)
    try {
      await sock.groupParticipantsUpdate(jid, batch, 'remove')
      ok += batch.length
    } catch {
      for (const t of batch) {
        try { await sock.groupParticipantsUpdate(jid, [t], 'remove'); ok++ } catch { }
      }
    }
    if (i + 10 < targets.length) await new Promise((r) => setTimeout(r, 220 + Math.random() * 180))
  }
  clearMeta(jid)
  try { await sock.sendMessage(jid, { text: `✅ تم طرد ${ok} من ${targets.length}` }) } catch { }
}

async function cmdKick(m, args) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const all = getTargets(m, args)
  if (!all.length) return reply(m, 'منشن الشخص أو ردّ على رسالته أو اكتب رقمه')
  const targets = removeProtected(all)
  if (!targets.length) return reply(m, '⚠️ لا يمكن تنفيذ الطرد على المطوّر أو البوت')
  await sock.groupParticipantsUpdate(m.key.remoteJid, targets, 'remove')
  clearMeta(m.key.remoteJid)
  await reply(m, '✅ تم الطرد')
}

async function cmdAdd(m, args) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const n = (args[0] || '').replace(/\D/g, '')
  if (n.length < 6) return reply(m, 'اكتب الرقم بشكل صحيح: ' + PREFIX + 'اضافة 2010xxxxxxxx')
  try {
    const res = await sock.groupParticipantsUpdate(m.key.remoteJid, [n + '@s.whatsapp.net'], 'add')
    const r = res[0]
    if (r?.status === '408') return reply(m, '⚠️ لا يمكن إضافة هذا الرقم — أرسل له رابط المجموعة ليدخل بنفسه')
    if (r?.status === '403') return reply(m, '⚠️ إعدادات الخصوصية لدى هذا الرقم تمنع إضافته')
    if (r?.status === '409') return reply(m, 'ℹ️ هذا الرقم موجود في المجموعة بالفعل')
    if (r?.status && r.status !== '200') return reply(m, '❌ فشلت الإضافة: ' + r.status)
    clearMeta(m.key.remoteJid)
    await reply(m, '✅ تمت الإضافة')
  } catch (e) { await reply(m, '❌ فشلت الإضافة: ' + e.message) }
}

async function cmdRole(m, args, action) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const all = getTargets(m, args)
  if (!all.length) return reply(m, 'منشن الشخص أو ردّ على رسالته')
  const targets = removeProtected(all)
  if (!targets.length) return reply(m, '⚠️ لا يمكن تنفيذ الأمر على هذا الحساب')
  await sock.groupParticipantsUpdate(m.key.remoteJid, targets, action)
  clearMeta(m.key.remoteJid)
  await reply(m, action === 'promote' ? '✅ تمت الترقية إلى مشرف' : '✅ تمت إزالة الإشراف')
}

async function cmdSetting(m, mode, text) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  await sock.groupSettingUpdate(m.key.remoteJid, mode)
  clearMeta(m.key.remoteJid)
  await reply(m, text)
}

async function cmdLink(m) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const code = await sock.groupInviteCode(m.key.remoteJid)
  await reply(m, '🔗 https://chat.whatsapp.com/' + code)
}

async function cmdRevoke(m) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const code = await sock.groupRevokeInvite(m.key.remoteJid)
  await reply(m, '🔁 الرابط الجديد:\nhttps://chat.whatsapp.com/' + code)
}

async function cmdTagAll(m) {
  const meta = await getMeta(m.key.remoteJid)
  const mentions = meta.participants.map((p) => p.id)
  const names = meta.participants.map((p) => '▪ @' + phoneOf(p.id)).join('\n')
  await sock.sendMessage(m.key.remoteJid, { text: `📢 *منشن للجميع*\n\n${names}`, mentions }, { quoted: m })
}

async function cmdHidetag(m, args) {
  const meta = await getMeta(m.key.remoteJid)
  const mentions = meta.participants.map((p) => p.id)
  const text = args.join(' ') || '‎'
  await sock.sendMessage(m.key.remoteJid, { text, mentions, noImage: true })
}

async function cmdDel(m) {
  const meta = await ensureBotAdmin(m)
  if (!meta) return
  const ctx = m.message?.extendedTextMessage?.contextInfo
  if (!ctx?.stanzaId) return reply(m, 'ردّ على الرسالة التي تريد حذفها')
  await sock.sendMessage(m.key.remoteJid, {
    delete: { remoteJid: m.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
  })
}

async function cmdGetPP(m) {
  const t = getTargets(m, [])[0] || (isGroup(m.key.remoteJid) ? senderJids(m)[0] : m.key.remoteJid)
  try {
    const url = await sock.profilePictureUrl(t, 'image')
    await sock.sendMessage(m.key.remoteJid, { image: { url }, caption: '✅' }, { quoted: m })
  } catch { await reply(m, '❌ لا توجد صورة شخصية (أو أنها مخفية)') }
}

async function cmdId(m) {
  await reply(m, '👤 أنت: ' + (senderJids(m)[0] || m.key.remoteJid) + '\n💬 المحادثة: ' + m.key.remoteJid)
}

async function cmdJoin(m, args) {
  const code = (args[0] || '').replace('https://chat.whatsapp.com/', '').trim()
  if (!code) return reply(m, 'اكتب كود الدعوة: ' + PREFIX + 'انضمام abcdef123')
  try {
    const res = await sock.groupAcceptInvite(code)
    await reply(m, '✅ تم الانضمام إلى المجموعة: ' + res)
  } catch { await reply(m, '❌ الكود غير صحيح أو منتهي الصلاحية') }
}

async function cmdLeave(m) {
  await reply(m, '👋 إلى اللقاء!')
  await sock.groupLeave(m.key.remoteJid)
}

async function cmdWarns(m, args) {
  const jid = m.key.remoteJid
  const t = getTargets(m, args)[0]
  if (!t) return reply(m, 'منشن الشخص أو ردّ على رسالته')
  const w = db.warns[jid] || {}
  const key = Object.keys(w).find((k) => phoneOf(k) === phoneOf(t))
  await reply(m, `⚠️ إنذارات @${phoneOf(t)}: ${key ? w[key] : 0}/${MAX_WARNS}`)
}

async function cmdResetWarns(m, args) {
  const jid = m.key.remoteJid
  const t = getTargets(m, args)[0]
  if (!t) return reply(m, 'منشن الشخص أو ردّ على رسالته')
  const w = db.warns[jid] || {}
  for (const k of Object.keys(w)) if (phoneOf(k) === phoneOf(t)) delete w[k]
  saveDb()
  await reply(m, '✅ تم تصفير الإنذارات')
}

function cmdToggle(m, key, label) {
  const arg = normalize(m._args[0])
  const on = ['on', 'تشغيل', 'شغال', 'فعل', 'تفعيل'].includes(arg)
  const off = ['off', 'ايقاف', 'وقف', 'تعطيل', 'اطفاء'].includes(arg)
  const jid = m.key.remoteJid
  const def = key === 'antiraid' // الحماية من الهجمات مفعّلة افتراضيًا
  const cur = db[key][jid] !== undefined ? db[key][jid] : def
  if (!on && !off) {
    return reply(m, `${label}: ${cur ? 'مفعّل ✅' : 'متوقف ❌'}\nاكتب: ${PREFIX}${m._cmd} تشغيل أو ${PREFIX}${m._cmd} ايقاف`)
  }
  db[key][jid] = on
  saveDb()
  return reply(m, `${label} أصبح: ${on ? 'مفعّلًا ✅' : 'متوقفًا ❌'}`)
}

// ═══════════════════ 👁️ أمر .شاهد — فتح وسائط "مشاهدة مرة واحدة" وإظهارها في الشات ═══════════════════
const VIEWONCE_MAX_MB = 30 // أقصى حجم للوسيط المعروض بالميجابايت

async function cmdWatch(m) {
  const jid = m.key.remoteJid
  const ctx = m.message?.extendedTextMessage?.contextInfo
  const q = ctx?.quotedMessage

  // لازم ترد على الرسالة اللي فيها الوسيط
  if (!ctx?.stanzaId || !q) {
    return reply(m, box('👁️ فتح وسائط المشاهدة مرة واحدة', [
      `ردّ على صورة/فيديو "مشاهدة مرة واحدة" واكتب *${PREFIX}${m._cmd || 'شاهد'}*`,
      'هفتحها وأعرضها في الشات فورًا 📸',
      `للكشف التلقائي (نشرها لحظة وصولها): *${PREFIX}مضادالمشاهدة تشغيل*`,
    ]))
  }

  // في المجموعات: للمشرفين والمطوّر فقط — وفي الخاص متاح للجميع
  if (isGroup(jid) && !m.key.fromMe) {
    const me = senderJids(m)
    if (!isOwner(me)) {
      const meta = await getMeta(jid)
      if (!isAdmin(meta, me)) return reply(m, '❌ هذا الأمر للمشرفين فقط')
    }
  }

  const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => { })

  // المصدر الأول (الأضمن): الكاش الداخلي — البوت نزّل الوسيط لحظة وصوله؛
  // واتساب يشيل بيانات التحميل من الرسالة المقتبوسة فبدون الكاش ده الأمر غالبًا يفشل
  const cached = voCache.get(ctx.stanzaId)

  // المصدر الثاني: بيانات الوسيط داخل الرسالة المقتبوسة نفسها (لو واتساب بعتها)
  const inner = q.viewOnceMessageV2?.message || q.viewOnceMessage?.message || q.viewOnceMessageV2Extension?.message || q.ephemeralMessage?.message || q
  const node = inner.imageMessage || inner.videoMessage || inner.audioMessage
  const kind = cached?.kind || (node ? (inner.imageMessage ? 'image' : inner.videoMessage ? 'video' : 'audio') : null)
  const size = cached?.size || (node?.fileLength ? Number(node.fileLength) : 0)

  if (!cached && !node) {
    if (q.viewOnceMessageV2 || q.viewOnceMessage || q.viewOnceMessageV2Extension) {
      return reply(m, `❌ واتساب شال بيانات الوسيط من الرسالة المقتبوسة.\n💡 فعّل *${PREFIX}مضادالمشاهدة تشغيل* عشان ألقط أي وسيط "مرة واحدة" لحظة وصوله وأخزّنه.`)
    }
    return reply(m, '❌ الرسالة اللي رديت عليها مش صورة/فيديو/صوت')
  }
  if (size > VIEWONCE_MAX_MB * 1024 * 1024) {
    return reply(m, `❌ حجم الوسيط أكبر من ${VIEWONCE_MAX_MB} ميجابايت`)
  }

  react('⏳')
  let buf = null
  try {
    if (cached) buf = cached.buffer || await cached.p // نفس التحميل الجاري — بدون تحميل مزدوج
    if (!buf?.length && node && (node.mediaKey || node.url || node.directPath)) {
      buf = await downloadMediaMessage(
        { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: inner },
        'buffer', {},
        { reuploadRequest: sock.updateMediaMessage },
      )
    }
  } catch (e) {
    buf = null
    console.log('⚠️ شاهد: ' + e.message)
  }

  if (!buf?.length) {
    react('❌')
    return reply(m, box('❌ تعذر جلب الوسيط', [
      'واتساب حذف بيانات التحميل من الرسالة المقتبوسة،',
      `أو الوسيط وصل قبل تشغيل البوت / أقدم من ${Math.round(VO_CACHE_TTL / 60000)} دقيقة`,
      `💡 فعّل *${PREFIX}مضادالمشاهدة تشغيل* عشان ألقطها لحظة وصولها`,
    ]))
  }

  const mimetype = cached?.mimetype || node?.mimetype || null
  const ptt = cached ? cached.ptt : !!node?.ptt

  // عرض نظيف: الوسيط بس وتحته اسم البوت فقط — بدون رؤوس أو منشن أو الكابشن الأصلي
  if (kind === 'audio') {
    await sock.sendMessage(jid, { audio: buf, mimetype: mimetype || 'audio/mp4', ptt }, { quoted: m })
  } else {
    await sock.sendMessage(jid, {
      [kind]: buf,
      ...(mimetype ? { mimetype } : {}),
      caption: `*${BOT_NAME}*`,
    }, { quoted: m })
  }
  react('✅')
}

// ── جدول الأوامر: الاسم الأول عربي، والباقي بدائل ──
const CLOSE_TXT = box('🔒 إغلاق المجموعة', ['الحالة: مقفولة', 'الكتابة الآن للمشرفين فقط'])
const OPEN_TXT = box('🔓 فتح المجموعة', ['الحالة: مفتوحة', 'الكل يقدر يكتب الآن'])

const defs = [
  [['قائمة', 'الاوامر', 'اوامر', 'menu', 'help'], { fn: cmdMenu }],
  [['بنج', 'فحص', 'ping'], { fn: cmdPing }],
  [['وقت', 'مدة', 'runtime'], { fn: (m) => reply(m, '⏱️ يعمل منذ ' + fmtDur(Math.floor(process.uptime()))) }],
  [['معرف', 'id'], { fn: cmdId }],
  [['طرد', 'kick'], { fn: cmdKick, admin: true, group: true }],
  [['طردالكل', 'كيكال', 'kickall', 'حب'], { fn: cmdKickAll, owner: true, group: true }],
  [['اضافة', 'اضف', 'add'], { fn: cmdAdd, admin: true, group: true }],
  [['ترقية', 'رفع', 'promote'], { fn: (m, a) => cmdRole(m, a, 'promote'), admin: true, group: true }],
  [['تنزيل', 'خفض', 'demote'], { fn: (m, a) => cmdRole(m, a, 'demote'), admin: true, group: true }],
  [['قفل', 'اغلاق', 'كتم', 'mute', 'close'], { fn: (m) => cmdSetting(m, 'announcement', CLOSE_TXT), admin: true, group: true }],
  [['فتح', 'الغاءكتم', 'unmute', 'open'], { fn: (m) => cmdSetting(m, 'not_announcement', OPEN_TXT), admin: true, group: true }],
  [['تقييد', 'lock'], { fn: (m) => cmdSetting(m, 'locked', '🔒 تم قفل تعديل المعلومات — للمشرفين فقط'), admin: true, group: true }],
  [['تحرير', 'unlock'], { fn: (m) => cmdSetting(m, 'unlocked', '🔓 تم فتح تعديل المعلومات للجميع'), admin: true, group: true }],
  [['رابط', 'link'], { fn: cmdLink, admin: true, group: true }],
  [['تجديد', 'revoke'], { fn: cmdRevoke, admin: true, group: true }],
  [['تاج', 'منشن', 'tagall'], { fn: cmdTagAll, admin: true, group: true }],
  [['اخفاء', 'منشنمخفي', 'hidetag'], { fn: cmdHidetag, admin: true, group: true }],
  [['حذف', 'مسح', 'del'], { fn: cmdDel, admin: true, group: true }],
  [['شاهد', 'اعرض', 'اظهر', 'شاهدها', 'viewonce', 'readviewonce', 'rvo', 'vv'], { fn: cmdWatch }],
  [['صورة', 'getpp'], { fn: cmdGetPP }],
  [['انضمام', 'ادخل', 'join'], { fn: cmdJoin, owner: true }],
  [['مغادرة', 'خروج', 'leave'], { fn: cmdLeave, owner: true, group: true }],
  [['انذارات', 'تحذيرات', 'warns'], { fn: cmdWarns, admin: true, group: true }],
  [['تصفير', 'resetwarns'], { fn: cmdResetWarns, admin: true, group: true }],
  [['ترحيب', 'welcome'], { fn: (m) => cmdToggle(m, 'welcome', 'الترحيب'), admin: true, group: true }],
  [['الروابط', 'منعالروابط', 'antilink'], { fn: (m) => cmdToggle(m, 'antilink', 'منع الروابط'), admin: true, group: true }],
  [['حماية', 'الهجمات', 'antiraid'], { fn: (m) => cmdToggle(m, 'antiraid', 'الحماية من الهجمات'), admin: true, group: true }],
  [['تشغيل', 'شغل', 'اغنية', 'play'], { fn: cmdPlay }],
  [['بحث', 'search'], { fn: cmdSearch }],
  [['كلمات', 'lyrics'], { fn: cmdLyrics }],
  [['ايديت', 'فيديوهات', 'edit'], { fn: cmdEdit }],
  [['تذكير', 'ذكرني', 'remind'], { fn: cmdRemind }],
  [['مكافحةالتكرار', 'ضدالسبام', 'antiflood'], { fn: (m) => cmdToggle(m, 'antiflood', 'مكافحة تكرار الرسائل'), admin: true, group: true }],
  [['كشف', 'مضادالحذف', 'ضدالحذف', 'antidelete'], { fn: (m) => cmdToggle(m, 'antidelete', 'كاشف الرسائل المحذوفة'), owner: true, group: true }],
  [['مضادالمشاهدة', 'ضدالمشاهدةمرة', 'كاشفالمشاهدة', 'antiviewonce'], { fn: (m) => cmdToggle(m, 'antiviewonce', 'كاشف وسائط "مشاهدة مرة واحدة"'), owner: true, group: true }],
  [['كاشفالاسماء', 'كاشفالاسم', 'اسماء', 'antiname', 'names'], { fn: (m) => cmdToggle(m, 'antiname', 'كاشف تغيّر الأسماء'), owner: true, group: true }],
  [['المطور', 'مطور', 'dev', 'owner'], { fn: cmdDev }],
  [['البوت', 'بوت', 'botinfo'], { fn: cmdBotInfo }],
  [['المشرفين', 'ادمنز', 'admins'], { fn: cmdAdmins, group: true }],
  [['معلومات', 'مجموعة', 'ginfo'], { fn: cmdGroupInfo, group: true }],
  [['قوانين', 'القوانين', 'rules'], { fn: cmdRules, group: true }],
  [['ضبطقوانين', 'setrules'], { fn: cmdSetRules, admin: true, group: true }],
  [['تسمية', 'اسم', 'setname'], { fn: cmdSetName, admin: true, group: true }],
  [['وصف', 'setdesc'], { fn: cmdSetDesc, admin: true, group: true }],
  [['انذار', 'تحذير', 'warn'], { fn: cmdWarn, admin: true, group: true }],
  [['نرد', 'dice'], { fn: cmdDice }],
  [['حكمة', 'quote'], { fn: cmdQuote }],
  [['حساب', 'احسب', 'calc'], { fn: cmdCalc }],
  [['اختيار', 'اختر', 'pick'], { fn: cmdPick }],
  [['وداع', 'goodbye'], { fn: (m) => cmdToggle(m, 'goodbye', 'رسالة الوداع'), admin: true, group: true }],

  // 🤬 فلتر الكلمات الممنوعة
  [['الشتائم', 'فلتر', 'badwordfilter'], { fn: (m) => cmdToggle(m, 'badwordFilter', 'فلتر الكلمات الممنوعة'), admin: true, group: true }],
  [['اضف_كلمة', 'ممنوع', 'addword'], { fn: cmdAddWord, admin: true, group: true }],
  [['احذف_كلمة', 'سماح', 'delword'], { fn: cmdDelWord, admin: true, group: true }],
  [['الكلمات', 'قائمة_الكلمات', 'wordlist'], { fn: cmdListWords, admin: true, group: true }],

  // 🔇 حظر عضو من الكتابة
  [['حظر', 'امنع', 'blockuser'], { fn: cmdMute, admin: true, group: true }],
  [['الغاء_حظر', 'فك_حظر', 'unblockuser'], { fn: cmdUnmute, admin: true, group: true }],

  // 🏆 نقاط التفاعل
  [['نقاطي', 'مينقاطي', 'mypoints'], { fn: cmdMyPoints, group: true }],
  [['الافضل', 'المتصدرين', 'leaderboard'], { fn: cmdLeaderboard, group: true }],

  // 🗄️ أرشيف الوسائط
  [['حفظ', 'خزن', 'save'], { fn: cmdSaveMedia, admin: true, group: true }],
  [['جلب', 'احضر', 'get'], { fn: cmdGetMedia, group: true }],
  [['الوسائط', 'قائمة_الوسائط', 'medialist'], { fn: cmdListMedia, group: true }],
  [['احذف_وسيط', 'delmedia'], { fn: cmdDelMedia, admin: true, group: true }],

  // 🌐 الترجمة
  [['ترجمة', 'ترجم', 'translate'], { fn: cmdTranslate }],

  // ⏰ جدولة رسالة
  [['جدولة', 'جدول', 'schedule'], { fn: cmdSchedule, admin: true, group: true }],
  [['المجدولة', 'قائمة_الجدولة', 'schedulelist'], { fn: cmdListSchedule, admin: true, group: true }],
]
const commands = {}
for (const [names, def] of defs) { def.names = names; for (const n of names) commands[normalize(n)] = def }

// ── منع الروابط ──
const LINK_RE = /(chat\.whatsapp\.com\/[A-Za-z0-9]{5,}|wa\.me\/\d|https?:\/\/|www\.)/i
// ═══════════ 🕵️ لمستي الخاصة: مضاد الحذف + كاشف "مشاهدة مرة واحدة" ═══════════
const ANTIDELETE_CACHE_LIMIT = 400
const ANTIDELETE_MAX_MEDIA_MB = 8
const msgCache = new Map() // id -> { jid, sender, kind, text, buffer, mimetype }

function trimCache() {
  while (msgCache.size > ANTIDELETE_CACHE_LIMIT) msgCache.delete(msgCache.keys().next().value)
}

// نخزّن كل رسالة تصل للمجموعات اللي مفعّلة فيها الخاصية، عشان لو اتمسحت نقدر نوريها
async function cacheMessage(msg) {
  const jid = msg.key.remoteJid
  if (!isGroup(jid) || db.antidelete[jid] !== true || msg.key.fromMe) return
  const c = msg.message
  if (!c) return
  let entry = { jid, sender: msg.key.participant || jid, kind: null, text: null, buffer: null, mimetype: null }

  if (c.conversation) { entry.kind = 'text'; entry.text = c.conversation }
  else if (c.extendedTextMessage?.text) { entry.kind = 'text'; entry.text = c.extendedTextMessage.text }
  else {
    const node = c.imageMessage || c.videoMessage || c.stickerMessage || c.audioMessage
    if (!node) return
    entry.kind = c.imageMessage ? 'image' : c.videoMessage ? 'video' : c.stickerMessage ? 'sticker' : 'audio'
    entry.text = node.caption || null
    entry.mimetype = node.mimetype
    const okSize = !node.fileLength || Number(node.fileLength) <= ANTIDELETE_MAX_MEDIA_MB * 1024 * 1024
    if (okSize) { try { entry.buffer = await downloadMediaMessage(msg, 'buffer', {}) } catch { } }
  }
  msgCache.set(msg.key.id, entry)
  trimCache()
}

// لما تتمسح رسالة (حذف للجميع)، واتساب يبعت protocolMessage نوعه REVOKE
// ═══════════════════ 🕵️ كاشف تغيّر الأسماء — يرصد أي عضو يغيّر اسمه في المجموعة ═══════════════════
// الفكرة: واتساب بيبعت مع كل رسالة "pushName" = اسم المرسل الحالي. البوت بيخزّن آخر اسم معروف
// لكل عضو في كل جروب (db.nameLog) من أول رسالة له، وأي اختلاف بعدها = تغيير اسم يُنشر في الجروب
// بالاسم القديم والجديد. التخزين دائم في قاعدة البيانات فبيفضل شغال حتى بعد إعادة التشغيل.
async function handleNameChange(msg) {
  const jid = msg.key.remoteJid
  if (!isGroup(jid) || db.antiname[jid] !== true) return
  const who = msg.key.participant
  const push = (msg.pushName || '').trim()
  if (!who || !push || msg.key.fromMe) return // رسائل البوت نفسه مش بتتحسب
  const log = (db.nameLog[jid] ||= {})
  const old = log[who]
  log[who] = push // حدّث المرجع دايمًا — الاسم الجديد هو "آخر اسم معروف" من الآن
  if (old === push) return
  saveDb() // اسم جديد اتسجّل (أول مرة أو تغيير) — يتحفظ على الديسك فالسجل بيكمل بعد الريستارت
  if (!old) return // أول مرة نشوف العضو: تسجيل صامت بدون إعلان
  const header = box('🕵️ كشف تغيير اسم!', [
    `العضو: @${phoneOf(who)}`,
    `الاسم القديم: ${old}`,
    `الاسم الجديد: ${push}`,
  ])
  try {
    await sock.sendMessage(jid, { text: header, mentions: [who] })
  } catch { }
}

async function handleRevoke(msg) {
  const jid = msg.key.remoteJid
  if (!isGroup(jid) || db.antidelete[jid] !== true || msg.key.fromMe) return // fromMe يعني البوت نفسه هو اللي مسح (أمر .حذف أو مانع الروابط)
  const delKey = msg.message?.protocolMessage?.key
  if (!delKey?.id) return
  const entry = msgCache.get(delKey.id)
  if (!entry) return
  msgCache.delete(delKey.id)

  const who = delKey.participant || msg.key.participant
  const header = box('🕵️ رسالة محذوفة!', [`الفاعل: @${phoneOf(who)}`, 'تم كشفها قبل اختفائها ⚡'])
  try {
    if (entry.buffer) {
      const field = entry.kind === 'image' ? 'image' : entry.kind === 'video' ? 'video' : entry.kind === 'sticker' ? 'sticker' : 'audio'
      await sock.sendMessage(jid, {
        [field]: entry.buffer,
        mimetype: entry.mimetype,
        caption: entry.text ? `${header}\n\n📝 المحتوى: ${entry.text}` : header,
        mentions: [who],
        noImage: true,
      })
    } else {
      await sock.sendMessage(jid, { text: `${header}\n\n📝 كانت تقول:\n«${entry.text || '(بدون نص)'}»`, mentions: [who] })
    }
  } catch { }
}

// ═══════════ كاشف وسائط "مشاهدة مرة واحدة" — التقاط فوري في الذاكرة + نشر تلقائي لو مفعّل ═══════════
const VO_CACHE_LIMIT = 60           // أقصى عدد وسائط "مرة واحدة" محفوظة في الذاكرة
const VO_CACHE_TTL = 30 * 60 * 1000 // صلاحية الوسيط المحفوظ (30 دقيقة)
const voCache = new Map() // stanzaId -> { jid, sender, kind, mimetype, caption, ptt, size, buffer, p, at }

// تنظيف دوري للوسائط المنتهية (حفظ للذاكرة)
const voSweep = () => {
  const now = Date.now()
  for (const [k, v] of voCache) if (now - v.at > VO_CACHE_TTL) voCache.delete(k)
}
setInterval(voSweep, 5 * 60 * 1000).unref?.()

// نزّل أي وسيط "مشاهدة مرة واحدة" فور وصوله (في المجموعات والخاص) ونخزّنه في الذاكرة.
// السبب: واتساب يشيل بيانات التحميل من الرسالة المقتبوسة، فبدون الكاش ده أمر .شاهد هيفشل في أغلب الحالات.
// التحميل بيبدأ فورًا في الخلفية، ونفس الطلب يتشاركه أمر .شاهد — بدون تحميل مزدوج وبدون تعطيل باقي الأوامر.
async function cacheViewOnce(msg) {
  const c = msg.message?.ephemeralMessage?.message || msg.message
  const vo = c?.viewOnceMessageV2?.message || c?.viewOnceMessage?.message || c?.viewOnceMessageV2Extension?.message
  const node = vo?.imageMessage || vo?.videoMessage || vo?.audioMessage
  if (!vo || !node) return null
  const id = msg.key.id
  const hit = voCache.get(id)
  if (hit) return hit // موجود بالفعل (أو التحميل جارٍ)

  const jid = msg.key.remoteJid
  const entry = {
    jid,
    sender: msg.key.participant || jid,
    kind: vo.imageMessage ? 'image' : vo.videoMessage ? 'video' : 'audio',
    mimetype: node.mimetype || null,
    caption: node.caption || null,
    ptt: !!node.ptt,
    size: node.fileLength ? Number(node.fileLength) : 0,
    buffer: null,
    at: Date.now(),
  }
  const tooBig = entry.size > VIEWONCE_MAX_MB * 1024 * 1024
  entry.p = tooBig
    ? Promise.resolve(null)
    : downloadMediaMessage({ key: msg.key, message: vo }, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
      .then((b) => { entry.buffer = b; return b })
      .catch(() => null)
  voCache.set(id, entry)
  while (voCache.size > VO_CACHE_LIMIT) voCache.delete(voCache.keys().next().value)
  return entry
}

// النشر التلقائي: لو الخاصية مفعّلة في المجموعة، انشر الوسيط فور التقاطه قبل ما يختفي
async function handleViewOnce(msg) {
  const jid = msg.key.remoteJid
  if (!isGroup(jid) || db.antiviewonce[jid] !== true) return
  const entry = await cacheViewOnce(msg)
  if (!entry) return
  const buf = entry.buffer || await entry.p
  if (!buf?.length) return
  // عرض نظيف: الوسيط بس وتحته اسم البوت فقط — بدون رؤوس أو منشن
  await sock.sendMessage(jid, {
    [entry.kind === 'image' ? 'image' : entry.kind === 'video' ? 'video' : 'audio']: buf,
    mimetype: entry.mimetype,
    caption: `*${BOT_NAME}*`,
    noImage: true,
  })
}

// ── مكافحة تكرار الرسائل (سبام) ──
const floodMap = new Map()
async function antiFlood(m) {
  const jid = m.key.remoteJid
  if (db.antiflood[jid] !== true) return false
  const me = senderJids(m)
  if (m.key.fromMe || isOwner(me)) return false
  const meta = await getMeta(jid)
  if (isAdmin(meta, me)) return false
  if (!isAdmin(meta, botJids())) return false // لازم البوت أدمن عشان يحذف ويطرد

  const u = m.key.participant || m.key.remoteJid
  const key = jid + '|' + u
  const now = Date.now()
  const arr = (floodMap.get(key) || []).filter((t) => now - t < FLOOD_WINDOW)
  arr.push(now)
  floodMap.set(key, arr)
  if (arr.length < FLOOD_LIMIT) return false

  floodMap.set(key, [])
  try { await sock.sendMessage(jid, { delete: m.key }) } catch { }
  db.warns[jid] = db.warns[jid] || {}
  db.warns[jid][u] = (db.warns[jid][u] || 0) + 1
  saveDb()
  if (db.warns[jid][u] >= MAX_WARNS) {
    delete db.warns[jid][u]
    saveDb()
    try { await sock.groupParticipantsUpdate(jid, [u], 'remove') } catch { }
    await sock.sendMessage(jid, { text: `🚫 تم طرد @${phoneOf(u)} بسبب تكرار الرسائل (سبام)`, mentions: [u] })
  } else {
    await sock.sendMessage(jid, {
      text: `⚠️ ممنوع تكرار الرسائل بسرعة!\n@${phoneOf(u)} (إنذار ${db.warns[jid][u]}/${MAX_WARNS})`,
      mentions: [u],
    })
  }
  return true
}

// ── أمر التذكير (يعمل طالما البوت شغّال، يُفقد عند إعادة التشغيل) ──
async function cmdRemind(m, args) {
  const minutes = parseFloat(args[0])
  const text = args.slice(1).join(' ').trim()
  if (!minutes || minutes <= 0 || !text) return reply(m, `⏰ الصيغة:\n${PREFIX}تذكير 10 اشرب مية`)
  if (minutes > 1440) return reply(m, '⚠️ أقصى مدة 1440 دقيقة (24 ساعة)')
  await reply(m, `⏰ تمام! هذكّرك بعد ${minutes} دقيقة بـ: ${text}`)
  const jid = m.key.remoteJid
  const u = m.key.participant || m.key.remoteJid
  setTimeout(() => {
    sock.sendMessage(jid, { text: `⏰ *تذكير!*\n@${phoneOf(u)} ← ${text}`, mentions: isGroup(jid) ? [u] : [] }).catch(() => { })
  }, minutes * 60000)
}

async function antiLink(m) {
  const jid = m.key.remoteJid
  if (db.antilink[jid] !== true) return
  const text = getText(m)
  if (!text || !LINK_RE.test(text)) return
  const meta = await getMeta(jid)
  const me = senderJids(m)
  if (m.key.fromMe || isOwner(me)) return // الإشراف لا يعفي من منع الروابط، المطوّر فقط
  // يجب أن يكون البوت مشرفًا ليتمكن من الحذف والطرد
  if (!isAdmin(meta, botJids())) return
  await sock.sendMessage(jid, { delete: m.key })
  const u = m.key.participant || m.key.remoteJid
  db.warns[jid] = db.warns[jid] || {}
  db.warns[jid][u] = (db.warns[jid][u] || 0) + 1
  saveDb()
  if (db.warns[jid][u] >= MAX_WARNS) {
    delete db.warns[jid][u]
    saveDb()
    try { await sock.groupParticipantsUpdate(jid, [u], 'remove') } catch { }
    await sock.sendMessage(jid, { text: `🚫 تم طرد @${phoneOf(u)} بسبب تكرار نشر الروابط`, mentions: [u] })
  } else {
    await sock.sendMessage(jid, {
      text: `⚠️ يُمنع نشر الروابط هنا!\n@${phoneOf(u)} (إنذار ${db.warns[jid][u]}/${MAX_WARNS})`,
      mentions: [u],
    }, { quoted: m })
  }
}

// ── معالجة الأوامر ──
async function handleCommand(m) {
  const text = getText(m).trim()
  if (!text.startsWith(PREFIX)) return
  const [head, ...args] = text.slice(PREFIX.length).trim().split(/\s+/)
  const name = normalize(head)
  const cmd = commands[name]
  if (!cmd) return

  // ── 🎛️ تحكم المطوّر في أوامر هذا البوت (بيوصل من لوحة تليجرام) ──
  // قاعدة "سماح" بتشغّل الأمر مهما كان الوضع الافتراضي مقفول، وقاعدة "منع" بتوقفه نهائيًا.
  // القواعد منتهية الصلاحية بتتمسح لحظة فحصها.
  const cr = db.cmdrules?.rules ? db.cmdrules : { def: 'allow', rules: {} }
  let rule = null
  for (const n of [name, ...(cmd.names || []).map(normalize)]) {
    const r = cr.rules[n]
    if (!r) continue
    if (r.until && Date.now() > r.until) { delete cr.rules[n]; saveDb(); continue } // القاعدة انتهت صلاحيتها
    rule = r
    break
  }
  if (rule ? rule.mode === 'block' : cr.def === 'block') {
    return reply(m, '⛔ هذا الأمر غير متاح حاليًا في هذا البوت')
  }

  if (cmd.group && !isGroup(m.key.remoteJid)) return reply(m, '❌ هذا الأمر للمجموعات فقط')
  const me = m.key.fromMe ? OWNER.map((o) => o + '@s.whatsapp.net') : senderJids(m)
  if (cmd.owner && !m.key.fromMe && !isOwner(me)) return reply(m, '❌ هذا الأمر للمالك فقط')
  if (cmd.admin && !m.key.fromMe) {
    const meta = await getMeta(m.key.remoteJid)
    if (!isAdmin(meta, me) && !isOwner(me)) return reply(m, '❌ هذا الأمر للمشرفين فقط')
  }
  m._args = args
  m._cmd = head
  await cmd.fn(m, args)
}

// ═══════════════════ التشغيل الرئيسي ═══════════════════
let sockGen = 0
let restartTimer = null
const scheduleRestart = (ms) => {
  if (restartTimer) return
  restartTimer = setTimeout(() => { restartTimer = null; startBot() }, ms)
}

async function startBot() {
  // أنهِ أي اتصال قديم حتى لا تتكرر الجلسات ولا تتضارب أكواد الربط
  if (sock) {
    try { sock.ev.removeAllListeners('connection.update') } catch { }
    try { sock.ev.removeAllListeners('messages.upsert') } catch { }
    try { sock.ev.removeAllListeners('group-participants.update') } catch { }
    try { sock.end(undefined) } catch { }
  }
  const myGen = ++sockGen
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    // مهم: الربط بالكود يحتاج بصمة متصفح معروفة وإلا لا يصل إشعار الكود لواتساب
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  })

  wrapSend()
  sock.ev.on('creds.update', saveCreds)

  // ── إعادة تسليح الرسائل المجدولة بعد إعادة تشغيل البوت (مرة واحدة فقط) ──
  if (!globalThis.__schedulesArmed) {
    globalThis.__schedulesArmed = true
    for (const [jid, list] of Object.entries(db.scheduled || {})) {
      for (const entry of list) {
        if (new Date(entry.at).getTime() <= Date.now() - 86400000) continue // تجاهل القديم جدًا (أكثر من يوم فات)
        armSchedule(jid, entry)
      }
    }
  }

  // ── الربط بالكود فقط (بدون QR) ──
  let pairingRequested = false
  const requestPairing = async () => {
    if (myGen !== sockGen || pairingRequested || state.creds.registered || !PAIRING_NUMBER) return
    pairingRequested = true
    try {
      const num = PAIRING_NUMBER.replace(/\D/g, '')
      const raw = await sock.requestPairingCode(num)
      const code = raw?.match(/.{1,4}/g)?.join('-') || raw
      console.log('\n╔══════════════════════════════╗')
      console.log('   🔑 كود الربط:  ' + code)
      console.log('   📱 للرقم: +' + num)
      console.log('╚══════════════════════════════╝')
      console.log('👉 افتح واتساب *على هذا الرقم نفسه* ← الأجهزة المرتبطة ← ربط جهاز ← "الربط برقم الهاتف بدلًا من ذلك" ثم اكتب الكود')
      console.log('⏳ الكود صالح لدقائق قليلة، ولا تُغلق البرنامج حتى يكتمل الربط\n')
      notify({ type: 'pairing-code', code })
    } catch (e) {
      pairingRequested = false
      console.log('⚠️ فشل كود الربط: ' + e.message + ' — سأعيد المحاولة')
      setTimeout(requestPairing, 5000)
    }
  }
  if (!state.creds.registered) setTimeout(requestPairing, 5000)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (myGen !== sockGen) return
    if (qr) requestPairing() // ظهور الـ QR يعني أن الاتصال جاهز لطلب الكود، ولا نعرض الـ QR نفسه
    if (connection === 'connecting') console.log('🔌 جاري الاتصال بواتساب...')
    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : 0
      console.log('ℹ️ سبب الإغلاق (كود): ' + code)
      if (code === DisconnectReason.loggedOut) {
        if (IS_CHILD) {
          console.log('\n⛔ تم تسجيل الخروج من واتساب')
          notify({ type: 'logged-out' })
          return setTimeout(() => process.exit(0), 500)
        }
        console.log('\n⛔ تم تسجيل الخروج من واتساب — سيتم مسح الجلسة وطلب كود ربط جديد...')
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }) } catch { }
        return scheduleRestart(3000)
      }
      // 515/516 = إعادة تشغيل طبيعية بعد نجاح الربط
      console.log('🔄 إعادة الاتصال بعد 4 ثوانٍ...')
      scheduleRestart(4000)
    } else if (connection === 'open') {
      console.log(`\n✅ ${BOT_NAME} يعمل الآن!\n`)
      notify({ type: 'open', jid: sock.user?.id || null })
    }
  })

  // الرسائل الواردة
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue
      try {
        // رسالة حذف (REVOKE) — لا تُعامل كرسالة عادية
        if (msg.message.protocolMessage?.type === 0) {
          await handleRevoke(msg)
          continue
        }
        // التقط وسائط "مشاهدة مرة" فور وصولها (كاش دائم عشان أمر .شاهد يشتغل فورًا)
        cacheViewOnce(msg).catch(() => { })
        // النشر التلقائي لو الكاشف مفعّل — بدون انتظار حتى ما يعطّلش باقي الأوامر
        handleViewOnce(msg).catch(() => { })
        // كاشف تغيّر الأسماء (لو مفعّل) — بيقرأ اسم المرسل الحالي وينشر أي تغيير
        handleNameChange(msg).catch(() => { })
        if (isGroup(msg.key.remoteJid)) {
          const flooded = await antiFlood(msg)
          if (flooded) continue
          const muted = await muteFilter(msg)
          if (muted) continue
          await antiLink(msg)
          const worded = await wordFilter(msg)
          if (worded) continue
          cacheMessage(msg).catch(() => { }) // بدون انتظار: تحميل الميديا ما يعطّلش الأوامر
          if (!msg.key.fromMe) addPoint(msg.key.remoteJid, msg.key.participant || msg.key.remoteJid)
        }
        await handleCommand(msg)
      } catch (e) { console.log('⚠️ خطأ: ' + e.message) }
    }
  })

  // تحديث الذاكرة المؤقتة عند أي تغيير في المجموعة
  sock.ev.on('groups.update', (arr) => { for (const g of arr) if (g.id) clearMeta(g.id) })

  // دخول/خروج الأعضاء + الحماية من الهجمات + الترحيب
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      clearMeta(ev.id)
      if (!isGroup(ev.id)) return
      if (ev.action === 'add') {
        // تجاهل انضمام البوت نفسه
        const parts = ev.participants.map((p) => (typeof p === 'string' ? p : p.id))
        if (parts.some((j) => botJids().some((b) => phoneOf(b) === phoneOf(j)))) return

        // كشف الهجوم
        if (db.antiraid[ev.id] !== false) {
          const now = Date.now()
          const arr = (joins.get(ev.id) || []).filter((x) => now - x.t < RAID_WINDOW)
          for (const j of parts) arr.push({ t: now, jid: j })
          joins.set(ev.id, arr)
          if (arr.length >= RAID_LIMIT) {
            const attackers = removeProtected(arr.map((x) => x.jid))
            joins.delete(ev.id)
            try { await sock.groupParticipantsUpdate(ev.id, attackers, 'remove') } catch { }
            try { await sock.groupSettingUpdate(ev.id, 'announcement') } catch { }
            clearMeta(ev.id)
            await sock.sendMessage(ev.id, {
              text: box('🛡️ تم صدّ هجوم!', ['تم طرد المهاجمين فورًا', 'تم قفل المجموعة مؤقتًا', `للفتح اكتب ${PREFIX}فتح`]),
            })
            return
          }
        }
        // الترحيب
        if (db.welcome[ev.id]) {
          const names = parts.map((j) => '@' + phoneOf(j)).join(' ')
          let subject = ''
          try { subject = (await getMeta(ev.id)).subject } catch { }
          const rules = db.rules[ev.id] ? `\n\n📜 *القوانين:*\n${db.rules[ev.id]}` : `\n📜 اكتب ${PREFIX}قوانين لعرض القوانين`
          await sock.sendMessage(ev.id, {
            text: `🎖️ *${BOT_NAME}* ┃ 🎊 *ترحيب*\n${LINE}\n\n🌸 ${names}\n🏠 أهلًا بكم في *${subject}*${rules}\n\n${SIG()}`,
            mentions: parts,
          })
        }
      }
      // ── حماية إشراف المطوّر والبوت: أي تنزيل منهما يُعاد فورًا ويُطرد من فعله ──
      if (ev.action === 'demote') {
        const parts = ev.participants.map((p) => (typeof p === 'string' ? p : p.id))
        const hitOwner = parts.some((j) => OWNER.includes(phoneOf(j)))
        const hitBot = parts.some((j) => botJids().some((b) => phoneOf(b) === phoneOf(j)))
        if (hitOwner || hitBot) {
          const author = ev.author
          clearMeta(ev.id)
          if (hitOwner) {
            try { await sock.groupParticipantsUpdate(ev.id, parts.filter((j) => OWNER.includes(phoneOf(j))), 'promote') } catch { }
          }
          if (hitBot) {
            // محاولة فورية؛ قد تفشل لأن البوت فقد صلاحية الإشراف بالفعل بمجرد التنزيل
            try { await sock.groupParticipantsUpdate(ev.id, botJids(), 'promote') } catch { }
          }
          if (author && !OWNER.includes(phoneOf(author)) && !botJids().some((b) => phoneOf(b) === phoneOf(author))) {
            try { await sock.groupParticipantsUpdate(ev.id, [author], 'remove') } catch { }
            clearMeta(ev.id)
            try {
              await sock.sendMessage(ev.id, {
                text: `🛡️ تم اكتشاف محاولة تنزيل ${hitOwner ? 'إشراف المطوّر' : 'إشراف البوت'}!\nتم طرد الفاعل @${phoneOf(author)} وإعادة الإشراف.`,
                mentions: [author],
              })
            } catch { }
          } else if (hitBot) {
            console.log('⚠️ تم تنزيل إشراف البوت ولم أستطع تحديد الفاعل أو استعادة الإشراف تلقائيًا')
          }
        }
      }

      // ── حماية من طرد المطوّر نفسه: إعادته وطرد من فعلها ──
      if (ev.action === 'remove') {
        const parts = ev.participants.map((p) => (typeof p === 'string' ? p : p.id))
        const hitOwner = parts.some((j) => OWNER.includes(phoneOf(j)))
        if (hitOwner) {
          const author = ev.author
          if (author && !OWNER.includes(phoneOf(author)) && !botJids().some((b) => phoneOf(b) === phoneOf(author))) {
            try { await sock.groupParticipantsUpdate(ev.id, [author], 'remove') } catch { }
            clearMeta(ev.id)
            try { await sock.sendMessage(ev.id, { text: `🛡️ تم طرد @${phoneOf(author)} لمحاولته طرد المطوّر!`, mentions: [author] }) } catch { }
          }
          // ملاحظة: واتساب لا يسمح بإعادة إضافة عضو طُرد تلقائيًا إلا إذا قبِل رابط الدعوة بنفسه
        }
      }

      // الوداع
      if (ev.action === 'remove' && db.goodbye[ev.id]) {
        const parts = ev.participants.map((p) => (typeof p === 'string' ? p : p.id))
        if (parts.some((j) => botJids().some((b) => phoneOf(b) === phoneOf(j)))) return
        const names = parts.map((j) => '@' + phoneOf(j)).join(' ')
        await sock.sendMessage(ev.id, { text: `🎖️ *${BOT_NAME}* ┃ 🍂 *وداع*\n${LINE}\n\n${names}\nنهاية الرحلة هنا 🥀 نتمنى لك التوفيق\n\n${SIG()}`, mentions: parts })
      }
    } catch (e) { console.log('⚠️ خطأ: ' + e.message) }
  })
}

// خادم صغير لإبقاء الاستضافة (Railway / Render ...) تعتبر الخدمة شغّالة
if (!IS_CHILD) {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`${BOT_NAME} ✅ يعمل`)
  }).listen(process.env.PORT || 3000)
}

process.on('unhandledRejection', (e) => console.log('⚠️ وعد مرفوض: ' + (e?.message || e)))
process.on('uncaughtException', (e) => console.log('⚠️ استثناء: ' + (e?.message || e)))

async function askNumberIfNeeded() {
  try {
    const credsFile = path.join(SESSION_DIR, 'creds.json')
    const registered = existsSync(credsFile) && JSON.parse(readFileSync(credsFile, 'utf8')).registered
    if (registered || process.env.PAIRING_NUMBER || !process.stdin.isTTY) return
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout })
    const ans = (await rl.question(`📱 اكتب رقم واتساب الذي سيعمل كبوت مع رمز الدولة بدون + (اضغط Enter لاستخدام ${PAIRING_NUMBER}): `)).trim()
    rl.close()
    if (ans) { PAIRING_NUMBER = ans.replace(/\D/g, ''); BOT_NUMBER = PAIRING_NUMBER }
  } catch { }
}

askNumberIfNeeded().then(startBot)
