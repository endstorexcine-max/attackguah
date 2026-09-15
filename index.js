const ANIMATE_SCROLL_DURATION = 300;
const SYNC_LEAD_MS = 0;
const LYRICS_LINE_REGEX = /((\[\d\d:\d\d\.\d{2,3}\] ?)+)(.+)/;
const LYRICS_TIME_REGEX = /\[(\d\d):(\d\d)\.(\d{2,3})\]/g;
const DEVICE_ID_KEY = 'fashBeats.deviceId';
const FIRST_VISIT_KEY = 'fashBeats.firstVisit';
const BADGE_KEY = 'fashBeats.badge';
const LAUNCH_DATE = new Date('2025-01-01T00:00:00Z').getTime();
const LOW_VOLUME_AUTOPAUSE_THRESHOLD = 0.02;
const APP_VERSION = '1.2.5';
const VERSION_STORAGE_KEY = 'fashBeats.lastSeenVersion';
const RECENT_KEY = 'fashBeats.recent';
const RECENT_MAX = 100;

const BADGES = {
  founder: { label: 'Founder', icon: 'crown' },
  dev: { label: 'Developer', icon: 'code' },
  beta: { label: 'Beta Tester', icon: 'flask-conical' },
  pro: { label: 'Pro User', icon: 'star' },
  verified: { label: 'Verified', icon: 'check-circle-2' },
  premium: { label: 'Premium', icon: 'gem' },
  music_lover: { label: 'Music Lover', icon: 'headphones' },
  night_owl: { label: 'Night Owl', icon: 'moon' },
  early_adopter: { label: 'Early Adopter', icon: 'rocket' }
};

const ADMIN_DEVICE_IDS = ['fb-dev-faddlan-001', 'fb-admin-fashbeats'];
let lowVolumeToastShown = false;
let offlineDB = null;
let sleepTimerInterval = null;
let sleepEndTime = null;
let sleepNotified = false;
let lyricsScrollRAF = null;
let pinSearchTimer = null;
let silenceAnalyser = null;
let silenceSourceNode = null;
let silenceRAF = null;
let silenceStartedAt = 0;
const SILENCE_RMS_THRESHOLD = 0.010;
const SILENCE_HOLD_MS = 1500;

function refreshIcons() {
  if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons();
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    const random = Math.random().toString(36).substring(2, 10);
    const scr = `${screen.width}x${screen.height}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    const ua = (navigator.userAgent || '').slice(0, 30);
    const raw = `${random}-${scr}-${tz}-${ua}`;
    id = 'fb-' + hashCode(raw).toString(36) + '-' + random;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function getFirstVisit() {
  let t = localStorage.getItem(FIRST_VISIT_KEY);
  if (!t) {
    t = Date.now().toString();
    localStorage.setItem(FIRST_VISIT_KEY, t);
  }
  return parseInt(t, 10);
}

function assignBadge(deviceId, firstVisit) {
  const saved = localStorage.getItem(BADGE_KEY);
  if (saved && BADGES[saved]) return saved;
  if (ADMIN_DEVICE_IDS.includes(deviceId)) {
    localStorage.setItem(BADGE_KEY, 'dev');
    return 'dev';
  }
  const daysSinceLaunch = (firstVisit - LAUNCH_DATE) / 86400000;
  let badge;
  if (daysSinceLaunch < 30) badge = 'founder';
  else if (daysSinceLaunch < 90) badge = 'early_adopter';
  else {
    const pool = ['pro', 'premium', 'verified', 'music_lover', 'beta', 'night_owl'];
    badge = pool[hashCode(deviceId) % pool.length];
  }
  localStorage.setItem(BADGE_KEY, badge);
  return badge;
}

function renderUserBadge() {
  const deviceId = getDeviceId();
  const firstVisit = getFirstVisit();
  const badgeKey = assignBadge(deviceId, firstVisit);
  const badge = BADGES[badgeKey];
  const badgeHTML = `<i data-lucide="${badge.icon}"></i><span>${badge.label}</span>`;
  const targets = ['welcomeUserBadge', 'headerBadge', 'homeUserBadge', 'settingsUserBadge'];
  targets.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('user-badge');
    if (id === 'headerBadge') el.classList.add('hidden', 'md:inline-flex');
    if (id === 'welcomeUserBadge') el.classList.add('mt-4', 'splash-tag');
    el.innerHTML = badgeHTML;
  });
  const deviceEl = document.getElementById('settingsDeviceId');
  if (deviceEl) deviceEl.innerText = deviceId;
  const memberEl = document.getElementById('settingsMemberSince');
  if (memberEl) {
    const d = new Date(firstVisit);
    memberEl.innerText = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  refreshIcons();
}

function copyDeviceId() {
  const deviceId = getDeviceId();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(deviceId).then(() => showToast('Device ID disalin')).catch(() => showToast('Gagal menyalin'));
  } else {
    showToast('Clipboard tidak didukung');
  }
}

async function confirmDialog(title, text, confirmText = 'Hapus') {
  if (typeof Swal === 'undefined') return confirm(text);
  const res = await Swal.fire({
    title, text, icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#E8846B',
    cancelButtonColor: '#3D2621',
    confirmButtonText: confirmText,
    cancelButtonText: 'Batal',
    background: '#2A1815',
    color: '#fff',
    customClass: { popup: 'rounded-3xl border border-white/10' }
  });
  return res.isConfirmed;
}

async function handleResetData() {
  const ok = await confirmDialog('Reset Data', 'Semua riwayat dan pengaturan akan dihapus. Lanjutkan?', 'Reset');
  if (!ok) return;
  localStorage.clear();
  try { indexedDB.deleteDatabase('fashBeats'); } catch (_) {}
  location.reload();
}

function parseLyricsLine(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = trimmed.match(LYRICS_LINE_REGEX);
  if (!match) return null;
  const timesStr = match[1];
  const text = match[3] ? match[3].trim() : '';
  const entries = [];
  LYRICS_TIME_REGEX.lastIndex = 0;
  let m;
  while ((m = LYRICS_TIME_REGEX.exec(timesStr)) !== null) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    let ms = parseInt(m[3], 10);
    if (m[3].length === 2) ms *= 10;
    const time = min * 60000 + sec * 1000 + ms;
    entries.push({ time, text, words: null, agent: null });
  }
  return entries.length ? entries : null;
}

function parseLyrics(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const entries = parseLyricsLine(line);
    if (entries) out.push(...entries);
  }
  return out.sort((a, b) => a.time - b.time);
}

function isTtml(raw) {
  if (!raw) return false;
  const t = raw.trim();
  if (!t.startsWith('<')) return false;
  return /<tt[\s>]/i.test(t) || /www\.w3\.org\/ns\/ttml/i.test(t);
}

function parseTtml(raw) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, 'application/xml');
    const nodes = Array.from(doc.getElementsByTagName('p'));
    const out = [];
    for (const p of nodes) {
      const begin = p.getAttribute('begin');
      const text = (p.textContent || '').trim();
      if (!begin || !text) continue;
      const time = parseTtmlTime(begin);
      const words = [];
      const spans = Array.from(p.getElementsByTagName('span'));
      if (spans.length) {
        for (const span of spans) {
          const sb = span.getAttribute('begin');
          const se = span.getAttribute('end');
          const st = (span.textContent || '').trim();
          if (sb && st) {
            words.push({
              text: st,
              startTime: parseTtmlTime(sb) / 1000,
              endTime: se ? parseTtmlTime(se) / 1000 : parseTtmlTime(sb) / 1000 + 0.5,
              isBackground: span.getAttribute('ttm:role') === 'x-bg'
            });
          }
        }
      }
      out.push({ time, text, words: words.length ? words : null, agent: p.getAttribute('ttm:agent') || null });
    }
    return out.sort((a, b) => a.time - b.time);
  } catch (_) { return []; }
}

function parseTtmlTime(str) {
  if (!str) return 0;
  const m = str.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3])) * 1000;
  const s = str.match(/^(\d+(?:\.\d+)?)s$/);
  if (s) return parseFloat(s[1]) * 1000;
  const ms = str.match(/^(\d+(?:\.\d+)?)ms$/);
  if (ms) return parseFloat(ms[1]);
  return 0;
}

function findCurrentLineIndex(lines, position, leadMs = SYNC_LEAD_MS) {
  if (!lines.length) return -1;
  const target = position + leadMs;
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lines[mid].time < target) low = mid + 1;
    else high = mid - 1;
  }
  return Math.min(Math.max(high, 0), lines.length - 1);
}

function findWordIndex(words, position) {
  if (!words || !words.length) return -1;
  const target = position / 1000;
  let low = 0;
  let high = words.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (words[mid].startTime < target) low = mid + 1;
    else high = mid - 1;
  }
  return Math.min(Math.max(high, 0), words.length - 1);
}

function buildLyricLineHTML(line, index) {
  const hasWords = Array.isArray(line.words) && line.words.length > 0;
  if (!hasWords) {
    return `<div class="lyric-line" data-time="${line.time}" data-index="${index}"><p class="lyric-text">${escapeHtml(line.text || '')}</p></div>`;
  }
  const wordsHTML = line.words.map((w, wi) => {
    const cls = w.isBackground ? 'lyric-word lyric-word-bg' : 'lyric-word';
    return `<span class="${cls}" data-start="${w.startTime}" data-end="${w.endTime}" data-wi="${wi}">${escapeHtml(w.text)}</span>`;
  }).join(' ');
  return `<div class="lyric-line lyric-line-words" data-time="${line.time}" data-index="${index}"><p class="lyric-text">${wordsHTML}</p></div>`;
}

const state = {
  currentTrack: null,
  queue: [],
  index: -1,
  isPlaying: false,
  isShuffle: false,
  repeatMode: 'off',
  lastSearch: '',
  suggestTimer: null,
  homeLoaded: false,
  lyricLines: [],
  activeLyricIndex: -1,
  activeWordIndex: -1,
  lyricsReady: false,
  lyricsLoadingPromise: null,
  lyricsCache: new Map(),
  likedTracks: JSON.parse(localStorage.getItem('fashBeats.liked') || '[]'),
  pinnedTracks: JSON.parse(localStorage.getItem('fashBeats.pinned') || '[]'),
  recentTracks: JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'),
  autoRecLoading: false,
  language: localStorage.getItem('fashBeats.lang') || 'id',
  sleepEndOfTrack: false,
  libraryTab: 'liked',
  geo: null,
  offlineTracks: [],
  lyricBounce: true,
  lyricFillSmooth: 0.25,
  skipSilence: false,
  quickPicksItems: [],
  quickPicksLoading: false,
  quickPicksInitialized: false
};

const audio = new Audio();
audio.crossOrigin = 'anonymous';
audio.preload = 'auto';

const homeShelves = [
  { id: 'trendingPlaylistShelf', query: 'Trending Playlist Indonesia 2024', type: 'songs' },
  { id: 'coversRemixShelf', query: 'Covers and Remix Indonesia Populer', type: 'songs' },
  { id: 'trendingForYouShelf', query: 'Trending Songs For You Indonesia', type: 'songs' },
  { id: 'newReleaseShelf', query: 'Lagu Indonesia Rilis Terbaru', type: 'songs' },
  { id: 'popShelf', query: 'Pop Indonesia Terbaru', type: 'songs' },
  { id: 'allTimeHitsShelf', query: 'All Time Hits Indonesia Legendaris', type: 'songs' },
  { id: 'artistShelf', query: 'Bruno Mars', type: 'artists', isArtist: true }
];

const QUICK_PICKS_QUERIES = [
  'Top Hits Indonesia 2024',
  'Lagu Viral TikTok Indonesia',
  'Pop Indonesia Trending',
  'Indie Indonesia Populer',
  'Dangdut Koplo Terbaru',
  'Lagu Galau Indonesia',
  'K-Pop Trending Asia',
  'Lofi Indonesia Chill',
  'Rock Indonesia Legendaris',
  'Anime OST Populer'
];

const searchCategories = [
  { title: 'Pop Indonesia', bg: 'from-zinc-700 to-zinc-900', icon: 'flame', query: 'Pop Indonesia Trending' },
  { title: 'Top Hits', bg: 'from-zinc-600 to-zinc-900', icon: 'trending-up', query: 'Top Hits Indonesia' },
  { title: 'Hip-Hop & Rap', bg: 'from-zinc-700 to-black', icon: 'drum', query: 'Hip Hop Indonesia' },
  { title: 'Indie Chill', bg: 'from-zinc-800 to-zinc-950', icon: 'coffee', query: 'Lagu Indie Indonesia' },
  { title: 'Rock & Heavy', bg: 'from-zinc-900 to-black', icon: 'guitar', query: 'Rock Indonesia' },
  { title: 'Dangdut Koplo', bg: 'from-zinc-600 to-zinc-900', icon: 'disc', query: 'Dangdut Koplo Terbaru' },
  { title: 'Anime & OST', bg: 'from-zinc-900 to-zinc-950', icon: 'gamepad-2', query: 'Anime OST Popular' },
  { title: 'Focus & Chill', bg: 'from-zinc-500 to-zinc-800', icon: 'headphones', query: 'Lofi Chill Music' }
];

const SLEEP_OPTIONS = [
  { minutes: 5, label: '5 menit' },
  { minutes: 10, label: '10 menit' },
  { minutes: 15, label: '15 menit' },
  { minutes: 30, label: '30 menit' },
  { minutes: 45, label: '45 menit' },
  { minutes: 60, label: '1 jam' },
  { minutes: 90, label: '1.5 jam' },
  { minutes: 120, label: '2 jam' },
  { minutes: null, label: 'Akhir lagu ini' }
];

const API = {
  async search(q, type = 'all') {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${type}`);
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    return res.json();
  },
  async suggest(q) {
    const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`Suggest failed: ${res.status}`);
    return res.json();
  },
  async artist(id) {
    const res = await fetch(`/api/artist?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Artist failed: ${res.status}`);
    return res.json();
  },
  async lyrics({ id, title, artist }) {
    const params = new URLSearchParams();
    if (id) params.set('id', id);
    if (title) params.set('title', title);
    if (artist) params.set('artist', artist);
    const res = await fetch(`/api/lyrics?${params.toString()}`);
    if (!res.ok) throw new Error(`Lyrics failed: ${res.status}`);
    return res.json();
  },
  async download(query) {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.json();
  }
};

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fashBeats', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'videoId' });
    };
    req.onsuccess = () => { offlineDB = req.result; resolve(offlineDB); };
    req.onerror = () => reject(req.error);
  });
}

async function getAllOffline() {
  if (!offlineDB) await openOfflineDB();
  return new Promise((resolve) => {
    const tx = offlineDB.transaction('tracks', 'readonly');
    const req = tx.objectStore('tracks').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function saveOffline(track, blob) {
  if (!offlineDB) await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = offlineDB.transaction('tracks', 'readwrite');
    const req = tx.objectStore('tracks').put({ ...track, blob, savedAt: Date.now() });
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function deleteOffline(videoId) {
  if (!offlineDB) await openOfflineDB();
  return new Promise((resolve) => {
    const tx = offlineDB.transaction('tracks', 'readwrite');
    const req = tx.objectStore('tracks').delete(videoId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

async function clearOfflineDB() {
  if (!offlineDB) await openOfflineDB();
  return new Promise((resolve) => {
    const tx = offlineDB.transaction('tracks', 'readwrite');
    const req = tx.objectStore('tracks').clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

function addToRecent(track) {
  if (!track || !track.videoId) return;
  const entry = {
    videoId: track.videoId,
    title: track.title || 'Unknown',
    artist: track.artist || track.author || 'Unknown Artist',
    thumbnail: track.thumbnail || track.cover || '',
    duration: track.duration || '',
    playedAt: Date.now()
  };
  state.recentTracks = state.recentTracks.filter((x) => x.videoId !== track.videoId);
  state.recentTracks.unshift(entry);
  if (state.recentTracks.length > RECENT_MAX) state.recentTracks = state.recentTracks.slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(state.recentTracks)); } catch (_) {}
}

function clearRecent() {
  state.recentTracks = [];
  try { localStorage.removeItem(RECENT_KEY); } catch (_) {}
  renderLibrary();
  showToast('Recent Play dibersihkan');
}

document.addEventListener('DOMContentLoaded', async () => {
  renderUserBadge();
  initSettings();
  autoDetectLowDevice();
  checkVersionUpdate();
  await openOfflineDB();
  await loadOfflineTracks();
  renderSearchCategories();
  initSearch();
  initSuggestBox();
  initAudioListeners();
  initKeyboardShortcuts();
  initVolumeControl();
  restorePlayerFromStorage();
  loadHomeShelves();
  updateStorageInfo();
  detectLocationAndGreeting();
  refreshIcons();
});

function getTimezoneOffsetHours() { return -new Date().getTimezoneOffset() / 60; }

function getGreeting(hour) {
  if (hour >= 3 && hour < 11) return { text: 'Selamat Pagi', emoji: '🌅' };
  if (hour >= 11 && hour < 15) return { text: 'Selamat Siang', emoji: '☀️' };
  if (hour >= 15 && hour < 18) return { text: 'Selamat Sore', emoji: '🌤️' };
  if (hour >= 18 && hour < 21) return { text: 'Selamat Malam', emoji: '🌆' };
  return { text: 'Selamat Malam', emoji: '🌙' };
}

function getWaktuIndonesia(offsetHours) {
  if (offsetHours === 7) return 'WIB';
  if (offsetHours === 8) return 'WITA';
  if (offsetHours === 9) return 'WIT';
  return 'WIB';
}

async function detectLocationAndGreeting() {
  let city = 'Indonesia';
  let country = 'Indonesia';
  let tzLabel = getWaktuIndonesia(getTimezoneOffsetHours());
  try {
    const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      if (data.city) city = data.city;
      if (data.country_name) country = data.country_name;
      const tz = data.timezone || '';
      if (tz.includes('Jakarta') || tz.includes('Pontianak')) tzLabel = 'WIB';
      else if (tz.includes('Makassar') || tz.includes('Bali')) tzLabel = 'WITA';
      else if (tz.includes('Jayapura')) tzLabel = 'WIT';
      state.geo = { city, country, tzLabel };
    }
  } catch (_) {
    try {
      const res2 = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(4000) });
      if (res2.ok) {
        const d = await res2.json();
        if (d.city) city = d.city;
        if (d.country) country = d.country;
        state.geo = { city, country, tzLabel };
      }
    } catch (_) {}
  }
  const localHour = new Date().getHours();
  const greeting = getGreeting(localHour);
  const homeTime = document.getElementById('homeGreetingTime');
  const homeText = document.getElementById('homeGreetingText');
  const homeSub = document.getElementById('homeGreetingSub');
  if (homeTime) homeTime.innerText = greeting.text.replace('Selamat ', '');
  if (homeText) homeText.innerText = `${greeting.emoji} ${greeting.text}`;
  if (homeSub) homeSub.innerText = `Dari ${city}, ${country} • ${tzLabel}`;
}

function switchTab(tab) {
  const views = ['home', 'search', 'library', 'settings'];
  views.forEach((t) => {
    const viewEl = document.getElementById(`view-${t}`);
    const navBtn = document.getElementById(`nav-${t}`);
    if (!viewEl) return;
    if (t === tab) {
      viewEl.classList.remove('hidden', 'translate-x-full', 'opacity-0', 'pointer-events-none');
      viewEl.classList.add('translate-x-0', 'opacity-100', 'pointer-events-auto');
      if (navBtn) navBtn.classList.add('text-white');
    } else {
      viewEl.classList.add('translate-x-full', 'opacity-0', 'pointer-events-none');
      viewEl.classList.remove('translate-x-0', 'opacity-100', 'pointer-events-auto');
      setTimeout(() => { if (t !== tab) viewEl.classList.add('hidden'); }, 300);
      if (navBtn) navBtn.classList.remove('text-white');
    }
  });
  if (tab === 'search') {
    const input = document.getElementById('searchInput');
    if (input) setTimeout(() => input.focus(), 200);
  }
  if (tab === 'library') renderLibrary();
  refreshIcons();
}

async function loadOfflineTracks() { state.offlineTracks = await getAllOffline(); }

async function updateStorageInfo() {
  await loadOfflineTracks();
  const count = state.offlineTracks.length;
  let bytes = 0;
  for (const t of state.offlineTracks) if (t.blob) bytes += t.blob.size || 0;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  const countEl = document.getElementById('storageCount');
  const sizeEl = document.getElementById('storageSize');
  if (countEl) countEl.innerText = count;
  if (sizeEl) sizeEl.innerText = `${mb} MB`;
  const opCount = document.getElementById('offlinePageCount');
  if (opCount) opCount.innerText = count;
}

async function clearAllOffline() {
  const ok = await confirmDialog('Hapus Offline', 'Semua lagu offline akan dihapus. Lanjutkan?', 'Hapus');
  if (!ok) return;
  await clearOfflineDB();
  await loadOfflineTracks();
  await updateStorageInfo();
  renderOfflinePage();
  showToast('Semua lagu offline dihapus');
}

function isTrackOffline(videoId) { return state.offlineTracks.some((t) => t.videoId === videoId); }
function isTrackPinned(videoId) { return state.pinnedTracks.some((t) => t.videoId === videoId); }

function openOfflinePage() { renderOfflinePage(); document.getElementById('offlinePage')?.classList.add('show'); refreshIcons(); }
function closeOfflinePage() { document.getElementById('offlinePage')?.classList.remove('show'); }

function renderOfflinePage() {
  const box = document.getElementById('offlinePageContent');
  if (!box) return;
  if (!state.offlineTracks.length) { box.innerHTML = emptyHTML('Belum ada lagu offline'); refreshIcons(); return; }
  box.innerHTML = state.offlineTracks.map((s) => {
    const trackData = encodeAttr({ videoId: s.videoId, title: s.title, artist: s.artist, thumbnail: s.thumbnail });
    const listData = encodeAttr([{ videoId: s.videoId, title: s.title, artist: s.artist, thumbnail: s.thumbnail }]);
    return `
      <div onclick='playTrackFromList(${trackData}, 0, ${listData})' class="flex items-center gap-3 p-3 hover:bg-white/5 rounded-2xl cursor-pointer">
        <div class="relative w-14 h-14 flex-none">
          <img src="${s.thumbnail}" class="w-14 h-14 rounded-xl object-cover" loading="lazy" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'">
          <div class="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-[#E8846B] flex items-center justify-center border-2 border-[#1A0F0D]"><i data-lucide="check" class="w-2.5 h-2.5 text-white"></i></div>
        </div>
        <div class="truncate flex-1 min-w-0">
          <div class="marquee-box"><h4 class="marquee-inner font-bold text-sm text-white"><span>${escapeHtml(s.title)}</span><span aria-hidden="true">${escapeHtml(s.title)}</span></h4></div>
          <p class="text-[11px] text-[#B8A29C] truncate">${escapeHtml(s.artist || '')}</p>
        </div>
        <button onclick="event.stopPropagation();playClickSFX();deleteOffline('${s.videoId}').then(()=>{loadOfflineTracks();updateStorageInfo();renderOfflinePage();})" class="text-[#B8A29C] p-2 active:scale-95 transition"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
      </div>`;
  }).join('');
  refreshIcons();
}

function togglePin() {
  const t = state.currentTrack;
  if (!t || !t.videoId) return;
  const idx = state.pinnedTracks.findIndex((x) => x.videoId === t.videoId);
  if (idx >= 0) { state.pinnedTracks.splice(idx, 1); showToast('Dilepas dari Speed Dial'); }
  else { state.pinnedTracks.push({ videoId: t.videoId, title: t.title, artist: t.artist || t.author, thumbnail: t.thumbnail }); showToast('Dipin ke Speed Dial'); }
  localStorage.setItem('fashBeats.pinned', JSON.stringify(state.pinnedTracks));
  renderSpeedDial();
  updatePinMenu();
}

function updatePinMenu() {
  const t = state.currentTrack;
  if (!t || !t.videoId) return;
  const pinned = isTrackPinned(t.videoId);
  const text = document.getElementById('pinMenuText');
  if (text) text.innerText = pinned ? 'Lepas dari Speed Dial' : 'Pin ke Speed Dial';
}

function updateDownloadMenu() {
  const t = state.currentTrack;
  if (!t || !t.videoId) return;
  const offline = isTrackOffline(t.videoId);
  const text = document.getElementById('downloadMenuText');
  const icon = document.getElementById('downloadMenuIcon');
  if (text) text.innerText = offline ? 'Hapus dari Offline' : 'Simpan Offline';
  if (icon) icon.innerHTML = offline ? '<i data-lucide="trash-2" class="w-4 h-4 text-[#F2A895]"></i>' : '<i data-lucide="download" class="w-4 h-4"></i>';
  refreshIcons();
}

function renderSpeedDial() {
  const grid = document.getElementById('speedDialGrid');
  if (!grid) return;
  if (!state.pinnedTracks.length) {
    grid.innerHTML = `<div class="col-span-full flex flex-col items-center justify-center py-8 text-[#B8A29C] space-y-2"><div class="w-12 h-12 rounded-full glass-light flex items-center justify-center text-[#B8A29C]"><i data-lucide="pin" class="w-5 h-5"></i></div><p class="text-xs font-semibold">Belum ada lagu yang dipin</p><button onclick="playClickSFX();openPinSheet()" class="text-[11px] font-bold text-[#E8846B]">+ Tambah lagu</button></div>`;
    refreshIcons();
    return;
  }
  grid.innerHTML = state.pinnedTracks.map((s) => `
      <div onclick="playSinglePinned('${s.videoId}')" class="speed-dial-item relative aspect-square rounded-2xl overflow-hidden cursor-pointer group glossy shadow-lg">
        <img src="${s.thumbnail || ''}" class="w-full h-full object-cover group-hover:scale-110 transition duration-500" onerror="this.src='https://via.placeholder.com/200/2A1815/E8846B?text=?'">
        <div class="absolute inset-0 bg-gradient-to-t from-[#1A0F0D]/95 via-[#1A0F0D]/30 to-transparent"></div>
        <div class="absolute bottom-0 left-0 right-0 p-2.5">
          <div class="marquee-box"><h4 class="marquee-inner font-black text-[11px] text-white"><span>${escapeHtml(s.title)}</span><span aria-hidden="true">${escapeHtml(s.title)}</span></h4></div>
          <p class="text-[9px] font-semibold text-[#B8A29C] truncate">${escapeHtml(s.artist || '')}</p>
        </div>
        <button onclick="event.stopPropagation();playClickSFX();unpinTrack('${s.videoId}')" class="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-black/60 backdrop-blur flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition"><i data-lucide="x" class="w-3 h-3"></i></button>
      </div>`).join('');
  refreshIcons();
}

function unpinTrack(videoId) {
  const idx = state.pinnedTracks.findIndex((x) => x.videoId === videoId);
  if (idx >= 0) {
    state.pinnedTracks.splice(idx, 1);
    localStorage.setItem('fashBeats.pinned', JSON.stringify(state.pinnedTracks));
    renderSpeedDial();
    showToast('Dilepas dari Speed Dial');
  }
}

async function playSinglePinned(videoId) {
  const track = state.pinnedTracks.find((x) => x.videoId === videoId);
  if (!track) return;
  playTrackFromList(track, 0, [track]);
}

function openPinSheet() {
  const backdrop = document.getElementById('pinBackdrop');
  const sheet = document.getElementById('pinSheet');
  if (backdrop) backdrop.classList.add('show');
  if (sheet) sheet.classList.add('show');
  const input = document.getElementById('pinSearchInput');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 300);
    input.oninput = debouncedPinSearch;
  }
  const results = document.getElementById('pinSearchResults');
  if (results) results.innerHTML = '<p class="text-xs text-[#B8A29C] px-3 py-6 text-center">Ketik untuk mencari lagu</p>';
}

function closePinSheet() {
  document.getElementById('pinBackdrop')?.classList.remove('show');
  document.getElementById('pinSheet')?.classList.remove('show');
}

function debouncedPinSearch(e) {
  clearTimeout(pinSearchTimer);
  const q = e.target.value.trim();
  if (!q) {
    const el = document.getElementById('pinSearchResults');
    if (el) el.innerHTML = '<p class="text-xs text-[#B8A29C] px-3 py-6 text-center">Ketik untuk mencari lagu</p>';
    return;
  }
  pinSearchTimer = setTimeout(() => runPinSearch(q), 400);
}

async function runPinSearch(q) {
  const results = document.getElementById('pinSearchResults');
  if (!results) return;
  results.innerHTML = '<p class="text-xs text-[#B8A29C] px-3 py-6 text-center">Mencari...</p>';
  try {
    const data = await API.search(q, 'songs');
    const items = (data.result && data.result.songs) || [];
    if (!items.length) {
      results.innerHTML = '<p class="text-xs text-[#B8A29C] px-3 py-6 text-center">Tidak ada hasil</p>';
      return;
    }
    results.innerHTML = items.slice(0, 15).map((s) => {
      const pinned = isTrackPinned(s.videoId);
      return `<div onclick="playClickSFX();pinFromSearch(${encodeAttr(s)})" class="flex items-center gap-3 p-2.5 hover:bg-white/5 rounded-2xl cursor-pointer"><img src="${s.thumbnail}" class="w-11 h-11 rounded-xl object-cover flex-none" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'"><div class="truncate flex-1 min-w-0"><h4 class="font-bold text-sm truncate text-white">${escapeHtml(s.title)}</h4><p class="text-[11px] text-[#B8A29C] truncate">${escapeHtml(s.artist || '')}</p></div><i data-lucide="${pinned ? 'check' : 'plus'}" class="w-4 h-4 ${pinned ? 'text-[#E8846B]' : 'text-[#B8A29C]'}"></i></div>`;
    }).join('');
    refreshIcons();
  } catch (_) {
    results.innerHTML = '<p class="text-xs text-[#B8A29C] px-3 py-6 text-center">Gagal mencari</p>';
  }
}

function pinFromSearch(track) {
  const idx = state.pinnedTracks.findIndex((x) => x.videoId === track.videoId);
  if (idx >= 0) { state.pinnedTracks.splice(idx, 1); showToast('Dilepas dari Speed Dial'); }
  else { state.pinnedTracks.push({ videoId: track.videoId, title: track.title, artist: track.artist, thumbnail: track.thumbnail }); showToast('Dipin ke Speed Dial'); }
  localStorage.setItem('fashBeats.pinned', JSON.stringify(state.pinnedTracks));
  renderSpeedDial();
  const input = document.getElementById('pinSearchInput');
  if (input && input.value.trim()) runPinSearch(input.value.trim());
}

async function downloadCurrentTrack() {
  const t = state.currentTrack;
  if (!t || !t.videoId) return;
  if (isTrackOffline(t.videoId)) {
    await deleteOffline(t.videoId);
    await loadOfflineTracks();
    await updateStorageInfo();
    showToast('Dihapus dari offline');
    updateDownloadMenu();
    renderOfflinePage();
    return;
  }
  showToast('Menyimpan offline...');
  try {
    const data = await API.download(t.videoId);
    if (!data.status || !data.result || !data.result.download || !data.result.download.audio) throw new Error('Gagal mengambil audio');
    const res = await fetch(`/api/proxy-audio?url=${encodeURIComponent(data.result.download.audio)}`);
    if (!res.ok) throw new Error('Gagal download stream');
    const blob = await res.blob();
    await saveOffline({ videoId: t.videoId, title: t.title, artist: t.artist || t.author, thumbnail: t.thumbnail, duration: t.duration }, blob);
    await loadOfflineTracks();
    await updateStorageInfo();
    showToast('Tersimpan offline');
    updateDownloadMenu();
    renderOfflinePage();
  } catch (err) { showToast('Gagal menyimpan: ' + err.message); }
}

function addToQueue() {
  const t = state.currentTrack;
  if (!t) return;
  state.queue.push(t);
  showToast('Ditambah ke antrian');
}

async function startMix() {
  const t = state.currentTrack;
  const seed = t ? `${t.title} ${t.artist || ''}` : 'Top Hits Indonesia 2024';
  showToast('Membuat mix...');
  try {
    const data = await API.search(seed, 'songs');
    const items = (data.result && data.result.songs) || [];
    if (!items.length) { showToast('Tidak bisa membuat mix'); return; }
    const shuffled = [...items].sort(() => Math.random() - 0.5);
    state.queue = shuffled;
    state.index = 0;
    playTrackFromList(shuffled[0], 0, shuffled);
    showToast('Mix dimulai');
  } catch (_) { showToast('Gagal membuat mix'); }
}

async function loadHomeShelves() {
  if (state.homeLoaded) return;
  state.homeLoaded = true;
  renderSpeedDial();
  initQuickPicks();
  await Promise.all(homeShelves.map(async (shelf) => {
    const el = document.getElementById(shelf.id);
    if (!el) return;
    try {
      const data = await API.search(shelf.query, shelf.type);
      const items = shelf.isArtist
        ? ((data.result && data.result.artists) || [])
        : ((data.result && data.result.songs) || []);
      if (!items.length) {
        el.innerHTML = '<p class="text-xs font-semibold text-[#B8A29C] py-8">Tidak ada data</p>';
        return;
      }
      renderHomeShelf(el, items.slice(0, 12), !!shelf.isArtist);
    } catch (_) {
      el.innerHTML = '<p class="text-xs font-semibold text-[#B8A29C] py-8">Gagal memuat</p>';
    }
  }));
}

async function refreshHomeShelves() {
  state.homeLoaded = false;
  await loadHomeShelves();
}

function renderHomeShelf(el, items, isArtist) {
  if (isArtist) {
    el.innerHTML = items.map((a) => `
      <div onclick="openArtist('${a.id || a.browseId}', '${escapeAttr(a.title)}')" class="snap-start flex-none w-32 text-center cursor-pointer group">
        <div class="w-24 h-24 mx-auto rounded-full overflow-hidden mb-2.5 border border-[#E8846B]/30 group-hover:border-[#E8846B] transition shadow-lg">
          <img src="${a.cover || a.thumbnail}" class="w-full h-full object-cover" loading="lazy" onerror="this.src='https://via.placeholder.com/150/2A1815/E8846B?text=?'">
        </div>
        <div class="marquee-box">
          <h4 class="marquee-inner font-bold text-xs text-white"><span>${escapeHtml(a.title)}</span><span aria-hidden="true">${escapeHtml(a.title)}</span></h4>
        </div>
      </div>`).join('');
    refreshIcons();
    return;
  }
  const encodedList = encodeAttr(items);
  el.innerHTML = items.map((s, idx) => {
    const encoded = encodeAttr(s);
    return `
      <div onclick='playTrackFromList(${encoded}, ${idx}, ${encodedList})' class="snap-start flex-none w-40 cursor-pointer group">
        <div class="relative overflow-hidden rounded-2xl mb-2.5 aspect-square shadow-lg glossy">
          <img src="${s.thumbnail}" class="w-full h-full object-cover group-hover:scale-105 transition duration-500" loading="lazy" onerror="this.src='https://via.placeholder.com/300/2A1815/E8846B?text=?'">
          <button class="absolute bottom-2.5 right-2.5 w-10 h-10 rounded-full bg-[#E8846B] text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transform translate-y-2 group-hover:translate-y-0 transition-all duration-300 shadow-lg">
            <i data-lucide="play" class="w-4 h-4 ml-0.5"></i>
          </button>
        </div>
        <div class="marquee-box">
          <h4 class="marquee-inner font-bold text-xs text-white"><span>${escapeHtml(s.title)}</span><span aria-hidden="true">${escapeHtml(s.title)}</span></h4>
        </div>
        <p class="text-[11px] font-semibold text-[#B8A29C] truncate mt-0.5">${escapeHtml(s.artist || 'Unknown')}</p>
      </div>`;
  }).join('');
  refreshIcons();
}

function quickPickCardHTML(s, idx, encodedList) {
  const encoded = encodeAttr(s);
  return `
    <div onclick='playTrackFromList(${encoded}, ${idx}, ${encodedList})' class="quick-pick-card snap-start cursor-pointer group">
      <div class="quick-pick-thumb relative">
        <img src="${s.thumbnail}" class="w-full h-full object-cover group-hover:scale-105 transition duration-500" loading="lazy" onerror="this.src='https://via.placeholder.com/400/2A1815/E8846B?text=?'">
        <div class="absolute inset-0 bg-gradient-to-t from-[#1A0F0D]/90 via-[#1A0F0D]/10 to-transparent pointer-events-none"></div>
        <button class="absolute bottom-3 right-3 w-12 h-12 rounded-full bg-[#E8846B] text-white flex items-center justify-center shadow-2xl opacity-0 group-hover:opacity-100 transform translate-y-2 group-hover:translate-y-0 transition-all duration-300">
          <i data-lucide="play" class="w-5 h-5 ml-0.5"></i>
        </button>
        <div class="absolute bottom-3 left-3 right-16">
          <div class="marquee-box">
            <h4 class="marquee-inner quick-pick-title text-white"><span>${escapeHtml(s.title)}</span><span aria-hidden="true">${escapeHtml(s.title)}</span></h4>
          </div>
          <p class="quick-pick-artist text-[#F2A895] truncate mt-0.5">${escapeHtml(s.artist || 'Unknown')}</p>
        </div>
      </div>
    </div>`;
}

function renderQuickPicksSkeleton(count) {
  return Array.from({ length: count }).map(() => `<div class="quick-pick-skeleton skeleton"></div>`).join('');
}

async function initQuickPicks() {
  if (state.quickPicksInitialized) return;
  state.quickPicksInitialized = true;
  const shelf = document.getElementById('quickPicksShelf');
  if (!shelf) return;
  shelf.innerHTML = renderQuickPicksSkeleton(5);
  await loadMoreQuickPicks(true);
  shelf.addEventListener('scroll', () => {
    const nearEnd = shelf.scrollWidth - shelf.scrollLeft - shelf.clientWidth < 500;
    if (nearEnd) loadMoreQuickPicks(false);
  }, { passive: true });
}

async function loadMoreQuickPicks(reset) {
  if (state.quickPicksLoading) return;
  state.quickPicksLoading = true;
  const shelf = document.getElementById('quickPicksShelf');
  if (!shelf) { state.quickPicksLoading = false; return; }
  const q = QUICK_PICKS_QUERIES[Math.floor(Math.random() * QUICK_PICKS_QUERIES.length)];
  try {
    const data = await API.search(q, 'songs');
    const items = (data.result && data.result.songs) || [];
    const existingIds = new Set(state.quickPicksItems.map((x) => x.videoId));
    const fresh = items.filter((x) => x.videoId && !existingIds.has(x.videoId)).slice(0, 8);
    if (reset) {
      state.quickPicksItems = fresh;
      const encodedList = encodeAttr(state.quickPicksItems);
      shelf.innerHTML = state.quickPicksItems.map((s, i) => quickPickCardHTML(s, i, encodedList)).join('');
    } else if (fresh.length) {
      const startIdx = state.quickPicksItems.length;
      state.quickPicksItems = [...state.quickPicksItems, ...fresh];
      const encodedList = encodeAttr(state.quickPicksItems);
      fresh.forEach((s, i) => {
        shelf.insertAdjacentHTML('beforeend', quickPickCardHTML(s, startIdx + i, encodedList));
      });
    } else if (reset) {
      shelf.innerHTML = '<p class="text-xs font-semibold text-[#B8A29C] py-8">Tidak ada data</p>';
    }
  } catch (_) {
    if (reset) shelf.innerHTML = '<p class="text-xs font-semibold text-[#B8A29C] py-8">Gagal memuat</p>';
  }
  refreshIcons();
  state.quickPicksLoading = false;
}

async function refreshQuickPicks() {
  state.quickPicksItems = [];
  const shelf = document.getElementById('quickPicksShelf');
  if (shelf) shelf.innerHTML = renderQuickPicksSkeleton(5);
  await loadMoreQuickPicks(true);
  showToast('Quick Picks di-refresh');
}

function renderSearchCategories() {
  const grid = document.getElementById('categoryGrid');
  if (!grid) return;
  grid.innerHTML = searchCategories.map((cat) => `
    <div onclick="searchByCategory('${escapeAttr(cat.query)}')" class="relative h-28 rounded-2xl bg-gradient-to-br ${cat.bg} p-4 overflow-hidden cursor-pointer shadow-lg active:scale-95 transition border border-[#3D2621] glossy">
      <h3 class="font-black text-sm text-white leading-snug tracking-tight max-w-[70%]">${escapeHtml(cat.title)}</h3>
      <div class="absolute -right-3 -bottom-3 w-16 h-16 rounded-2xl bg-[#E8846B]/20 flex items-center justify-center transform rotate-12"><i data-lucide="${cat.icon}" class="w-6 h-6 text-[#F2A895]"></i></div>
    </div>`).join('');
  refreshIcons();
}

function searchByCategory(q) {
  const input = document.getElementById('searchInput');
  if (input) input.value = q;
  switchTab('search');
  executeSearch(q);
}

function searchByQuery(q) {
  switchTab('search');
  const input = document.getElementById('searchInput');
  if (input) input.value = q;
  executeSearch(q);
}

function initSearch() {
  const input = document.getElementById('searchInput');
  if (!input) return;
  let timer;
  input.addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    hideSuggestBox();
    if (!q) {
      document.getElementById('categorySection')?.classList.remove('hidden');
      document.getElementById('searchResultsSection')?.classList.add('hidden');
      return;
    }
    scheduleSuggest(q);
    timer = setTimeout(() => executeSearch(q), 500);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { hideSuggestBox(); executeSearch(input.value.trim()); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#searchSuggestBox') && !e.target.closest('#searchInput')) hideSuggestBox();
  });
}

function initSuggestBox() {
  if (document.getElementById('searchSuggestBox')) return;
  const wrapper = document.getElementById('searchInput')?.parentElement;
  if (!wrapper) return;
  const box = document.createElement('div');
  box.id = 'searchSuggestBox';
  box.className = 'absolute top-full left-0 right-0 mt-2 glass border border-[#3D2621] rounded-2xl shadow-2xl overflow-hidden hidden z-50';
  wrapper.classList.add('relative');
  wrapper.appendChild(box);
}

function scheduleSuggest(q) {
  clearTimeout(state.suggestTimer);
  state.suggestTimer = setTimeout(async () => {
    try {
      const data = await API.suggest(q);
      if (data.suggestions && data.suggestions.length) renderSuggestBox(data.suggestions, q);
    } catch (_) {}
  }, 250);
}

function renderSuggestBox(suggestions, originalQuery) {
  const box = document.getElementById('searchSuggestBox');
  if (!box) return;
  box.innerHTML = suggestions.slice(0, 8).map((s) => `<div onclick="pickSuggestion('${escapeAttr(s)}')" class="flex items-center gap-3 px-4 py-3 hover:bg-white/5 cursor-pointer border-b border-[#3D2621] last:border-0"><i data-lucide="search" class="w-4 h-4 text-[#B8A29C]"></i><span class="text-sm font-bold text-[#F2A895]">${highlightMatch(s, originalQuery)}</span></div>`).join('');
  box.classList.remove('hidden');
  refreshIcons();
}

function highlightMatch(text, query) {
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapeHtml(text).replace(new RegExp(`(${escapeHtml(q)})`, 'ig'), '<span class="text-white font-black">$1</span>');
}

function hideSuggestBox() { document.getElementById('searchSuggestBox')?.classList.add('hidden'); }

function pickSuggestion(text) {
  const input = document.getElementById('searchInput');
  if (input) input.value = text;
  hideSuggestBox();
  executeSearch(text);
}

async function executeSearch(query) {
  if (!query) return;
  state.lastSearch = query;
  const categorySection = document.getElementById('categorySection');
  const resultsSection = document.getElementById('searchResultsSection');
  const resultsContainer = document.getElementById('searchResults');
  categorySection?.classList.add('hidden');
  resultsSection?.classList.remove('hidden');
  if (resultsContainer) resultsContainer.innerHTML = loadingHTML('Mencari lagu...');
  try {
    const data = await API.search(query);
    const results = data.result || {};
    if (data.status && ((results.songs && results.songs.length) || (results.albums && results.albums.length) || (results.artists && results.artists.length))) {
      renderSearchResults(results);
    } else {
      resultsContainer.innerHTML = emptyHTML('Tidak ada hasil ditemukan.');
      refreshIcons();
    }
  } catch (err) {
    resultsContainer.innerHTML = errorHTML(err.message);
    refreshIcons();
  }
}

function renderSearchResults({ songs = [], artists = [], albums = [] }) {
  const container = document.getElementById('searchResults');
  if (!container) return;
  const sections = [];
  if (songs.length) sections.push(`<div class="space-y-1">${songs.map((s, idx) => songRow(s, idx, songs)).join('')}</div>`);
  if (artists.length) {
    sections.push(`<h3 class="text-base font-black text-white mb-3 mt-6 tracking-tight">Artis</h3><div class="grid grid-cols-2 sm:grid-cols-3 gap-3">${artists.map((a) => `<div onclick="openArtist('${a.id || a.browseId}', '${escapeAttr(a.title)}')" class="flex items-center gap-3 p-2.5 glass rounded-2xl cursor-pointer transition active:scale-95 border border-[#3D2621]"><img src="${a.cover || a.thumbnail}" class="w-12 h-12 rounded-full object-cover border border-[#E8846B]/30" loading="lazy" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'"><div class="truncate flex-1 min-w-0"><h4 class="font-bold text-sm text-white truncate">${escapeHtml(a.title)}</h4><p class="text-[11px] text-[#B8A29C] truncate">${escapeHtml(a.artist || 'Artis')}</p></div></div>`).join('')}</div>`);
  }
  if (albums.length) {
    sections.push(`<h3 class="text-base font-black text-white mb-3 mt-6 tracking-tight">Album & Single</h3><div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">${albums.map((a) => `<div onclick="searchByQuery('${escapeAttr(a.title + ' ' + (a.artist || ''))}')" class="cursor-pointer transition active:scale-95"><img src="${a.cover || a.thumbnail}" class="w-full aspect-square object-cover rounded-2xl mb-2 shadow-lg" loading="lazy" onerror="this.src='https://via.placeholder.com/300/2A1815/E8846B?text=?'"><h4 class="font-bold text-xs text-white truncate">${escapeHtml(a.title)}</h4><p class="text-[11px] text-[#B8A29C] truncate">${escapeHtml(a.artist || '')} • ${a.year || ''}</p></div>`).join('')}</div>`);
  }
  container.innerHTML = sections.join('') || emptyHTML('Tidak ada hasil ditemukan.');
  refreshIcons();
}

function songRow(s, idx, list) {
  const encoded = encodeAttr(s);
  const listEncoded = encodeAttr(list);
  const isVideo = s.type === 'video';
  const isCurrent = state.currentTrack && state.currentTrack.videoId === s.videoId;
  const isPinned = isTrackPinned(s.videoId);
  const isOffline = isTrackOffline(s.videoId);
  return `<div onclick='playTrackFromList(${encoded}, ${idx}, ${listEncoded})' class="flex items-center gap-3 p-2.5 ${isCurrent ? 'bg-[#E8846B]/10 border border-[#E8846B]/40' : 'hover:bg-white/5'} rounded-2xl transition cursor-pointer active:scale-[0.99]"><div class="relative w-12 h-12 flex-none rounded-xl overflow-hidden shadow"><img src="${s.thumbnail}" class="w-full h-full object-cover" loading="lazy" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'">${isCurrent ? `<div class="absolute inset-0 bg-[#1A0F0D]/60 flex items-center justify-center"><div class="playing-bars"><span></span><span></span><span></span></div></div>` : ''}${isOffline ? `<div class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-[#E8846B] flex items-center justify-center"><i data-lucide="check" class="w-2.5 h-2.5 text-white"></i></div>` : ''}</div><div class="truncate flex-1 min-w-0"><div class="flex items-center gap-2"><h4 class="font-bold text-sm text-white truncate">${escapeHtml(s.title)}</h4>${isVideo ? '<span class="text-[8px] font-black px-1.5 py-0.5 rounded bg-[#E8846B]/20 text-[#F2A895] flex-none">VIDEO</span>' : ''}${isPinned ? '<i data-lucide="pin" class="w-3 h-3 text-[#E8846B] flex-none"></i>' : ''}</div><p class="text-[11px] font-semibold text-[#B8A29C] truncate mt-0.5">${escapeHtml(s.artist || 'Unknown')}</p></div><button onclick="event.stopPropagation();playClickSFX();togglePinFromRow('${s.videoId}', '${escapeAttr(s.title)}', '${escapeAttr(s.artist || '')}', '${s.thumbnail}')" class="w-8 h-8 flex items-center justify-center flex-none ${isPinned ? 'text-[#E8846B]' : 'text-[#B8A29C]'}"><i data-lucide="pin" class="w-3.5 h-3.5"></i></button></div>`;
}

function togglePinFromRow(videoId, title, artist, thumbnail) {
  const idx = state.pinnedTracks.findIndex((x) => x.videoId === videoId);
  if (idx >= 0) { state.pinnedTracks.splice(idx, 1); showToast('Dilepas dari Speed Dial'); }
  else { state.pinnedTracks.push({ videoId, title, artist, thumbnail }); showToast('Dipin ke Speed Dial'); }
  localStorage.setItem('fashBeats.pinned', JSON.stringify(state.pinnedTracks));
  renderSpeedDial();
  if (state.lastSearch) executeSearch(state.lastSearch);
}

async function openArtist(id, name) {
  if (!id) return;
  switchTab('home');
  const shelf = document.getElementById('trendingPlaylistShelf');
  if (shelf) shelf.innerHTML = loadingHTML(`Memuat ${name}...`);
  refreshIcons();
  try {
    const data = await API.artist(id);
    const artist = data.artist || {};
    const songs = artist.topSongs || [];
    if (!songs.length) {
      if (shelf) shelf.innerHTML = emptyHTML('Tidak ada lagu dari artis ini.');
      refreshIcons();
      return;
    }
    renderHomeShelf(shelf, songs, false);
  } catch (_) {
    if (shelf) shelf.innerHTML = errorHTML('Gagal memuat data artis.');
    refreshIcons();
  }
}

async function preloadLyrics(track) {
  if (!track || !track.videoId) return;
  const cacheKey = track.videoId;
  if (state.lyricsCache.has(cacheKey)) {
    const cached = state.lyricsCache.get(cacheKey);
    state.lyricLines = cached;
    state.lyricsReady = true;
    return cached;
  }
  try {
    const data = await API.lyrics({ id: track.videoId, title: track.title, artist: track.artist || track.author });
    let lines = [];
    if (data && data.status && data.lyrics) {
      const payload = data.lyrics;
      if (typeof payload === 'string') lines = isTtml(payload) ? parseTtml(payload) : parseLyrics(payload);
      else if (Array.isArray(payload.lines)) lines = payload.lines.map((l) => ({ time: Math.round((l.time || 0) * 1000), text: l.text || '', words: null, agent: null })).filter((l) => l.text).sort((a, b) => a.time - b.time);
      else if (typeof payload.text === 'string') lines = isTtml(payload.text) ? parseTtml(payload.text) : parseLyrics(payload.text);
    }
    state.lyricsCache.set(cacheKey, lines);
    state.lyricLines = lines;
    state.lyricsReady = true;
    return lines;
  } catch (_) {
    state.lyricLines = [];
    state.lyricsReady = false;
    return [];
  }
}

function renderLyricsContent() {
  const content = document.getElementById('lyricsContent');
  if (!content) return;
  if (!state.lyricLines.length) {
    content.innerHTML = emptyHTML('Lirik tidak tersedia');
    refreshIcons();
    return;
  }
  const hasWords = state.lyricLines.some((l) => l.words && l.words.length);
  content.innerHTML = `<div class="lyric-scroll py-16 space-y-6 text-center">${state.lyricLines.map((l, i) => buildLyricLineHTML(l, i)).join('')}</div>`;
  content.dataset.hasWords = hasWords ? '1' : '0';
}

async function playTrackFromList(track, index, list) {
  if (!track) return;
  state.currentTrack = track;
  state.queue = Array.isArray(list) ? list : [];
  state.index = index;
  state.activeLyricIndex = -1;
  state.activeWordIndex = -1;
  state.lyricsReady = false;
  addToRecent(track);
  updatePlayerUI();
  showMiniPlayer();
  updatePinMenu();
  updateDownloadMenu();
  const miniBtn = document.getElementById('miniPlayBtn');
  if (miniBtn) miniBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>';
  refreshIcons();
  preloadLyrics(track).catch(() => {});
  const offline = state.offlineTracks.find((t) => t.videoId === track.videoId);
  if (offline && offline.blob) {
    try {
      const url = URL.createObjectURL(offline.blob);
      audio.src = url;
      audio.load();
      await audio.play();
      state.isPlaying = true;
      updatePlayButtons();
      setupMediaSession();
      persistPlayerState();
      return;
    } catch (_) {}
  }
  try {
    const data = await API.download(track.videoId || track.title);
    if (!data.status || !data.result || !data.result.download || !data.result.download.audio) throw new Error(data.message || data.error || 'Gagal mengambil audio');
    const info = data.result.download;
    if (info.thumbnail && !track.thumbnail) track.thumbnail = info.thumbnail;
    if (info.title && !track.title) track.title = info.title;
    if (info.artist && !track.artist) track.artist = info.artist;
    const proxiedUrl = `/api/proxy-audio?url=${encodeURIComponent(info.audio)}`;
    audio.src = proxiedUrl;
    audio.load();
    await audio.play();
    state.isPlaying = true;
    updatePlayButtons();
    setupMediaSession();
    persistPlayerState();
    const upNext = document.getElementById('upNextOverlay');
    if (upNext && !upNext.classList.contains('translate-y-full')) loadAutoRecommendations();
  } catch (err) {
    if (miniBtn) miniBtn.innerHTML = '<i data-lucide="play" class="w-4 h-4 ml-0.5"></i>';
    refreshIcons();
    showToast('Gagal memutar: ' + err.message);
  }
}

function updatePlayerUI() {
  if (!state.currentTrack) return;
  const t = state.currentTrack;
  const thumb = t.thumbnail || t.cover || 'https://via.placeholder.com/300/2A1815/E8846B?text=?';
  ['miniThumb', 'fullThumb', 'lyricsMiniThumb'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.src = thumb;
  });
  ['miniTitle', 'fullTitle', 'lyricsMiniTitle', 'lyricsTrackTitle'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerText = t.title || 'Unknown';
  });
  ['miniArtist', 'fullArtist', 'lyricsMiniArtist', 'fullArtistTop'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerText = t.artist || t.author || 'Unknown Artist';
  });
  const ambient = document.getElementById('ambientBackground');
  if (ambient) ambient.style.backgroundImage = `url('${thumb}')`;
  const lyricsAmbient = document.getElementById('lyricsAmbient');
  if (lyricsAmbient) lyricsAmbient.style.backgroundImage = `url('${thumb}')`;
  const upNextAmbient = document.getElementById('upNextAmbient');
  if (upNextAmbient) upNextAmbient.style.backgroundImage = `url('${thumb}')`;
  updateLikeIcon();
  document.title = `${t.title || 'Fash Beats'} • Fash Beats`;
}

function updateLikeIcon() {
  const icon = document.getElementById('likeIcon');
  if (!icon || !state.currentTrack) return;
  const id = state.currentTrack.videoId;
  const liked = state.likedTracks.includes(id);
  icon.innerHTML = liked
    ? '<i data-lucide="heart" fill="currentColor" class="w-5 h-5 text-[#E8846B]"></i>'
    : '<i data-lucide="heart" class="w-5 h-5 text-[#B8A29C]"></i>';
  refreshIcons();
}

function toggleLike() {
  if (!state.currentTrack || !state.currentTrack.videoId) return;
  const id = state.currentTrack.videoId;
  const i = state.likedTracks.indexOf(id);
  if (i >= 0) state.likedTracks.splice(i, 1);
  else state.likedTracks.push(id);
  localStorage.setItem('fashBeats.liked', JSON.stringify(state.likedTracks));
  updateLikeIcon();
  const sheetLike = document.getElementById('sheetLikeIcon');
  if (sheetLike) {
    const liked = state.likedTracks.includes(id);
    sheetLike.innerHTML = liked
      ? '<i data-lucide="heart" fill="currentColor" class="w-4 h-4 text-[#E8846B]"></i>'
      : '<i data-lucide="heart" class="w-4 h-4"></i>';
    refreshIcons();
  }
  showToast(i >= 0 ? 'Dihapus dari Library' : 'Ditambahkan ke Library');
  if (state.libraryTab === 'liked') renderLibrary();
}

function showMiniPlayer() {
  const el = document.getElementById('miniPlayer');
  if (!el) return;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.remove('translate-y-full'));
  const bars = document.getElementById('miniPlayingBars');
  if (bars) bars.classList.remove('hidden');
}

function togglePlay() {
  if (!audio.src) return;
  if (state.isPlaying) {
    audio.pause();
    state.isPlaying = false;
  } else {
    audio.play().catch(() => {});
    state.isPlaying = true;
  }
  updatePlayButtons();
}

function updatePlayButtons() {
  const icon = state.isPlaying
    ? '<i data-lucide="pause" class="w-4 h-4"></i>'
    : '<i data-lucide="play" class="w-4 h-4 ml-0.5"></i>';
  const fullIcon = state.isPlaying
    ? '<i data-lucide="pause" class="w-7 h-7"></i>'
    : '<i data-lucide="play" class="w-7 h-7 ml-1"></i>';
  const miniBtn = document.getElementById('miniPlayBtn');
  if (miniBtn) miniBtn.innerHTML = icon;
  const fullBtn = document.getElementById('fullPlayBtn');
  if (fullBtn) fullBtn.innerHTML = fullIcon;
  const lyricsBtn = document.getElementById('lyricsPlayBtn');
  if (lyricsBtn) lyricsBtn.innerHTML = icon;
  refreshIcons();
}

function playNextTrack(auto = false) {
  if (state.repeatMode === 'one' && auto) {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  if (state.isShuffle && state.queue.length > 1) {
    let next;
    do { next = Math.floor(Math.random() * state.queue.length); } while (next === state.index);
    return playTrackFromList(state.queue[next], next, state.queue);
  }
  if (state.index < state.queue.length - 1) {
    const next = state.index + 1;
    return playTrackFromList(state.queue[next], next, state.queue);
  }
  if (state.repeatMode === 'all' && state.queue.length) {
    return playTrackFromList(state.queue[0], 0, state.queue);
  }
  loadAutoRecommendations().then(() => {
    if (state.queue.length > state.index + 1) {
      const next = state.index + 1;
      playTrackFromList(state.queue[next], next, state.queue);
    }
  });
}

function playPrevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.index > 0) {
    const prev = state.index - 1;
    playTrackFromList(state.queue[prev], prev, state.queue);
  }
}

function toggleShuffle() {
  state.isShuffle = !state.isShuffle;
  const btn = document.getElementById('shuffleBtn');
  if (btn) {
    btn.classList.remove('action-active', 'action-inactive');
    btn.classList.add(state.isShuffle ? 'action-active' : 'action-inactive');
  }
  showToast(state.isShuffle ? 'Shuffle aktif' : 'Shuffle nonaktif');
}

function cycleRepeat() {
  const modes = ['off', 'all', 'one'];
  const i = modes.indexOf(state.repeatMode);
  state.repeatMode = modes[(i + 1) % modes.length];
  const btn = document.getElementById('repeatBtn');
  const badge = document.getElementById('repeatBadge');
  if (btn) {
    btn.classList.remove('action-active', 'action-inactive');
    btn.classList.add(state.repeatMode !== 'off' ? 'action-active' : 'action-inactive');
  }
  if (badge) badge.classList.toggle('hidden', state.repeatMode !== 'one');
  showToast(`Repeat: ${state.repeatMode}`);
}

function openFullPlayer() { document.getElementById('fullPlayer')?.classList.remove('translate-y-full'); refreshIcons(); }
function closeFullPlayer() { document.getElementById('fullPlayer')?.classList.add('translate-y-full'); }

function ensureSilenceGraph() {
  if (silenceSourceNode) return;
  try {
    silenceSourceNode = audioCtx.createMediaElementSource(audio);
    silenceAnalyser = audioCtx.createAnalyser();
    silenceAnalyser.fftSize = 1024;
    silenceAnalyser.smoothingTimeConstant = 0.65;
    silenceSourceNode.connect(silenceAnalyser);
    silenceAnalyser.connect(audioCtx.destination);
  } catch (_) { silenceSourceNode = null; silenceAnalyser = null; }
}

function startSilenceMonitor() {
  if (silenceRAF) return;
  const step = () => {
    silenceRAF = requestAnimationFrame(step);
    if (!state.skipSilence || !silenceAnalyser || !state.isPlaying) {
      silenceStartedAt = 0;
      return;
    }
    const buf = new Uint8Array(silenceAnalyser.fftSize);
    silenceAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    if (rms < SILENCE_RMS_THRESHOLD) {
      if (!silenceStartedAt) silenceStartedAt = performance.now();
      else if (performance.now() - silenceStartedAt > SILENCE_HOLD_MS) {
        if (audio.duration && audio.currentTime < audio.duration - 3) audio.currentTime = Math.min(audio.currentTime + 2, audio.duration - 1);
        silenceStartedAt = 0;
      }
    } else silenceStartedAt = 0;
  };
  silenceRAF = requestAnimationFrame(step);
}

function initAudioListeners() {
  const progress = document.getElementById('progressBar');
  audio.addEventListener('timeupdate', () => {
    if (!isNaN(audio.duration)) {
      if (progress) progress.value = (audio.currentTime / audio.duration) * 100;
      const currentEl = document.getElementById('currentTime');
      const durEl = document.getElementById('durationTime');
      if (currentEl) currentEl.innerText = formatTime(audio.currentTime);
      if (durEl) durEl.innerText = formatTime(audio.duration);
    }
    scheduleLyricsSync();
    updatePositionState();
  });
  if (progress) progress.addEventListener('input', () => {
    if (!isNaN(audio.duration)) audio.currentTime = (progress.value / 100) * audio.duration;
  });
  audio.addEventListener('ended', () => {
    if (state.sleepEndOfTrack) { handleSleepEndOfTrack(); return; }
    playNextTrack(true);
  });
  audio.addEventListener('play', () => {
    state.isPlaying = true;
    updatePlayButtons();
    document.getElementById('miniPlayingBars')?.classList.remove('hidden');
    if (state.skipSilence) {
      ensureSilenceGraph();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      startSilenceMonitor();
    }
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  audio.addEventListener('pause', () => {
    state.isPlaying = false;
    updatePlayButtons();
    document.getElementById('miniPlayingBars')?.classList.add('hidden');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  audio.addEventListener('error', () => showToast('Stream gagal dimuat'));
}

function scheduleLyricsSync() {
  if (lyricsScrollRAF) return;
  lyricsScrollRAF = requestAnimationFrame(() => { lyricsScrollRAF = null; syncLyrics(); });
}

function initVolumeControl() {
  const vol = document.getElementById('volumeBar');
  if (!vol) return;
  audio.volume = parseFloat(vol.value) || 1;
  vol.addEventListener('input', () => {
    audio.volume = parseFloat(vol.value);
    handleVolumeAutoPause();
  });
}

function handleVolumeAutoPause() {
  if (audio.volume <= LOW_VOLUME_AUTOPAUSE_THRESHOLD) {
    if (state.isPlaying) {
      audio.pause();
      state.isPlaying = false;
      updatePlayButtons();
      if (!lowVolumeToastShown) { lowVolumeToastShown = true; showToast('Dijeda otomatis: volume terlalu kecil'); }
    }
  } else lowVolumeToastShown = false;
}

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

function setupMediaSession() {
  if (!('mediaSession' in navigator) || !state.currentTrack) return;
  const t = state.currentTrack;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title || 'Unknown',
    artist: t.artist || t.author || 'Unknown Artist',
    album: 'Fash Beats',
    artwork: [
      { src: t.thumbnail || '', sizes: '96x96', type: 'image/jpeg' },
      { src: t.thumbnail || '', sizes: '256x256', type: 'image/jpeg' },
      { src: t.thumbnail || '', sizes: '512x512', type: 'image/jpeg' }
    ]
  });
  navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  const safeSetHandler = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {} };
  safeSetHandler('play', () => { togglePlay(); navigator.mediaSession.playbackState = 'playing'; });
  safeSetHandler('pause', () => { togglePlay(); navigator.mediaSession.playbackState = 'paused'; });
  safeSetHandler('previoustrack', () => playPrevTrack());
  safeSetHandler('nexttrack', () => playNextTrack());
  safeSetHandler('stop', () => { audio.pause(); state.isPlaying = false; updatePlayButtons(); });
  safeSetHandler('seekto', (details) => { if (details.seekTime != null && !isNaN(audio.duration)) audio.currentTime = details.seekTime; });
  safeSetHandler('seekbackward', (details) => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); });
  safeSetHandler('seekforward', (details) => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (details.seekOffset || 10)); });
  updatePositionState();
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
  if (isNaN(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration)
    });
  } catch (_) {}
}

async function triggerPiP() {
  try {
    const canvas = document.getElementById('pipCanvas');
    const video = document.getElementById('pipVideo');
    if (!canvas || !video || !state.currentTrack) return;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = state.currentTrack.thumbnail || '';
    img.onload = async () => {
      canvas.width = 640; canvas.height = 640;
      ctx.drawImage(img, 0, 0, 640, 640);
      ctx.fillStyle = 'rgba(26,15,13,0.75)';
      ctx.fillRect(0, 480, 640, 160);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 34px sans-serif';
      ctx.fillText((state.currentTrack.title || '').slice(0, 26), 24, 550);
      ctx.font = '24px sans-serif';
      ctx.fillStyle = '#F2A895';
      ctx.fillText((state.currentTrack.artist || '').slice(0, 30), 24, 590);
      video.srcObject = canvas.captureStream();
      await video.play();
      await video.requestPictureInPicture();
    };
  } catch (_) { showToast('PiP tidak tersedia'); }
}

async function showLyrics() {
  if (!state.currentTrack) return;
  const overlay = document.getElementById('lyricsOverlay');
  const content = document.getElementById('lyricsContent');
  if (!overlay || !content) return;
  overlay.classList.remove('translate-y-full');
  refreshIcons();
  if (!state.lyricLines.length) {
    content.innerHTML = loadingHTML('Memuat lirik...');
    refreshIcons();
    await preloadLyrics(state.currentTrack);
  }
  renderLyricsContent();
  state.activeLyricIndex = -1;
  state.activeWordIndex = -1;
  requestAnimationFrame(() => syncLyrics(true));
}

function syncLyrics(force = false) {
  const overlay = document.getElementById('lyricsOverlay');
  if (!overlay || overlay.classList.contains('translate-y-full')) return;
  const lines = state.lyricLines;
  if (!lines.length) return;
  const positionMs = Math.round(audio.currentTime * 1000);
  const active = findCurrentLineIndex(lines, positionMs, SYNC_LEAD_MS);
  if (active < 0) return;
  const domLines = document.querySelectorAll('#lyricsContent .lyric-line');
  if (!domLines.length) return;
  if (active !== state.activeLyricIndex || force) {
    state.activeLyricIndex = active;
    domLines.forEach((el, i) => {
      el.classList.remove('line-active', 'line-past', 'line-future');
      if (i === active) el.classList.add('line-active');
      else if (i < active) el.classList.add('line-past');
      else el.classList.add('line-future');
    });
    const activeEl = domLines[active];
    const container = document.getElementById('lyricsContent');
    if (activeEl && container) {
      const targetTop = activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
      container.scrollTo({ top: targetTop, behavior: 'smooth' });
    }
  }
  const activeLine = lines[active];
  if (activeLine.words && activeLine.words.length) {
    const wIdx = findWordIndex(activeLine.words, positionMs);
    if (wIdx !== state.activeWordIndex || force) {
      state.activeWordIndex = wIdx;
      const activeEl = domLines[active];
      if (activeEl) {
        const wordSpans = activeEl.querySelectorAll('.lyric-word');
        wordSpans.forEach((span, i) => {
          span.classList.toggle('word-sung', i <= wIdx);
          span.classList.toggle('word-active', i === wIdx);
        });
      }
    }
  }
}

function closeLyrics() { document.getElementById('lyricsOverlay')?.classList.add('translate-y-full'); }

function showUpNext() {
  document.getElementById('upNextOverlay')?.classList.remove('translate-y-full');
  if (!document.getElementById('upNextList')?.children.length) loadAutoRecommendations();
}

function closeUpNext() { document.getElementById('upNextOverlay')?.classList.add('translate-y-full'); }

async function loadAutoRecommendations() {
  if (state.autoRecLoading || !state.currentTrack) return;
  state.autoRecLoading = true;
  const list = document.getElementById('upNextList');
  const sub = document.getElementById('upNextSubtitle');
  if (!list) { state.autoRecLoading = false; return; }
  list.innerHTML = loadingHTML('Memuat rekomendasi...');
  refreshIcons();
  if (sub) sub.innerText = `Berdasarkan "${state.currentTrack.title}"`;
  const artist = state.currentTrack.artist || state.currentTrack.author || '';
  const query = `${state.currentTrack.title} ${artist} similar`.trim();
  try {
    const data = await API.search(query, 'songs');
    let items = (data.result && data.result.songs) || [];
    items = items.filter((x) => x.videoId && x.videoId !== state.currentTrack.videoId);
    if (!items.length) {
      list.innerHTML = emptyHTML('Tidak ada rekomendasi');
      refreshIcons();
      state.autoRecLoading = false;
      return;
    }
    if (state.index >= 0) state.queue = [...state.queue.slice(0, state.index + 1), ...items];
    else { state.queue = [state.currentTrack, ...items]; state.index = 0; }
    renderUpNext(items);
  } catch (_) {
    list.innerHTML = errorHTML('Gagal memuat rekomendasi');
    refreshIcons();
  } finally { state.autoRecLoading = false; }
}

function renderUpNext(items) {
  const list = document.getElementById('upNextList');
  if (!list) return;
  list.innerHTML = items.map((s, idx) => {
    const encoded = encodeAttr(s);
    const queueIdx = state.index + 1 + idx;
    const listEncoded = encodeAttr(state.queue);
    return `<div onclick='playTrackFromList(${encoded}, ${queueIdx}, ${listEncoded})' class="upnext-item flex items-center gap-3 p-2.5 hover:bg-white/5 rounded-2xl cursor-pointer"><img src="${s.thumbnail}" class="w-12 h-12 rounded-xl object-cover flex-none" loading="lazy" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'"><div class="truncate flex-1 min-w-0"><h4 class="font-bold text-sm text-white truncate">${escapeHtml(s.title)}</h4><p class="text-[11px] font-semibold text-[#B8A29C] truncate mt-0.5">${escapeHtml(s.artist || 'Unknown')}</p></div><i data-lucide="grip-vertical" class="w-3 h-3 text-[#B8A29C]"></i></div>`;
  }).join('');
  refreshIcons();
}

function showDevices() { showToast('Fitur pilih perangkat segera hadir'); }

function openOptionsSheet(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  const backdrop = document.getElementById('optionsBackdrop');
  const sheet = document.getElementById('optionsSheet');
  if (!backdrop || !sheet) return;
  const t = state.currentTrack;
  if (t) {
    const thumb = t.thumbnail || t.cover || '';
    const sheetThumb = document.getElementById('sheetThumb');
    const sheetTitle = document.getElementById('sheetTitle');
    const sheetArtist = document.getElementById('sheetArtist');
    const sheetLike = document.getElementById('sheetLikeIcon');
    if (sheetThumb) sheetThumb.src = thumb;
    if (sheetTitle) sheetTitle.innerText = t.title || 'Unknown';
    if (sheetArtist) sheetArtist.innerText = t.artist || t.author || 'Unknown Artist';
    if (sheetLike) {
      const liked = state.likedTracks.includes(t.videoId);
      sheetLike.innerHTML = liked
        ? '<i data-lucide="heart" fill="currentColor" class="w-4 h-4 text-[#E8846B]"></i>'
        : '<i data-lucide="heart" class="w-4 h-4"></i>';
    }
  }
  const sleepLabel = document.getElementById('sleepActiveLabel');
  if (sleepLabel) sleepLabel.classList.toggle('hidden', !sleepEndTime && !state.sleepEndOfTrack);
  updatePinMenu();
  updateDownloadMenu();
  backdrop.classList.add('show');
  sheet.classList.add('show');
  refreshIcons();
}

function closeOptionsSheet() {
  document.getElementById('optionsBackdrop')?.classList.remove('show');
  document.getElementById('optionsSheet')?.classList.remove('show');
}

function openSleepSheet() {
  renderSleepOptions();
  document.getElementById('sleepBackdrop')?.classList.add('show');
  document.getElementById('sleepSheet')?.classList.add('show');
  refreshIcons();
}

function closeSleepSheet() {
  document.getElementById('sleepBackdrop')?.classList.remove('show');
  document.getElementById('sleepSheet')?.classList.remove('show');
}

function renderSleepOptions() {
  const box = document.getElementById('sleepOptions');
  if (!box) return;
  const isEndOfTrack = state.sleepEndOfTrack === true;
  box.innerHTML = SLEEP_OPTIONS.map((opt) => {
    const active = opt.minutes === null
      ? isEndOfTrack
      : sleepEndTime && !isEndOfTrack && Math.round((sleepEndTime - Date.now()) / 60000) <= opt.minutes;
    return `<div class="sleep-option ${active ? 'active' : ''}" onclick="playClickSFX();pickSleepOption(${opt.minutes === null ? 'null' : opt.minutes})"><div class="flex items-center gap-3"><i data-lucide="${opt.minutes === null ? 'flag' : 'clock'}" class="w-4 h-4 ${active ? 'text-[#E8846B]' : 'text-[#B8A29C]'}"></i><span class="text-sm font-bold text-white">${opt.label}</span></div>${active ? '<i data-lucide="check" class="w-4 h-4 text-[#E8846B]"></i>' : ''}</div>`;
  }).join('') + ((sleepEndTime || isEndOfTrack) ? `<div class="sleep-option danger" onclick="playClickSFX();cancelSleepTimer()"><div class="flex items-center gap-3"><i data-lucide="x" class="w-4 h-4 text-[#F2A895]"></i><span class="text-sm font-bold text-[#F2A895]">Matikan Sleep Timer</span></div></div>` : '');
  refreshIcons();
}

function pickSleepOption(minutes) {
  clearInterval(sleepTimerInterval);
  sleepTimerInterval = null;
  sleepNotified = false;
  if (minutes === null) {
    state.sleepEndOfTrack = true;
    sleepEndTime = null;
    showSleepCountdown('Akhir lagu');
    showToast('Sleep Timer: akhir lagu ini');
    closeSleepSheet();
    return;
  }
  state.sleepEndOfTrack = false;
  sleepEndTime = Date.now() + minutes * 60 * 1000;
  startSleepCountdown();
  showToast(`Sleep Timer: ${minutes} menit`);
  closeSleepSheet();
}

function startSleepCountdown() {
  clearInterval(sleepTimerInterval);
  updateSleepCountdown();
  sleepTimerInterval = setInterval(() => {
    const remaining = Math.ceil((sleepEndTime - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
      audio.pause();
      state.isPlaying = false;
      updatePlayButtons();
      hideSleepCountdown();
      sleepEndTime = null;
      showToast('Sleep Timer selesai');
      return;
    }
    updateSleepCountdown();
  }, 1000);
}

function updateSleepCountdown() {
  if (!sleepEndTime) return;
  const remaining = Math.ceil((sleepEndTime - Date.now()) / 1000);
  if (remaining <= 0) return;
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  const label = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  showSleepCountdown(label);
  if (remaining === 30 && !sleepNotified) { sleepNotified = true; showToast('Sleep Timer akan berhenti dalam 30 detik'); }
}

function showSleepCountdown(label) {
  const el = document.getElementById('sleepCountdown');
  const text = document.getElementById('sleepCountdownText');
  if (text) text.innerText = label;
  if (el) el.classList.add('show');
  const activeLabel = document.getElementById('sleepActiveLabel');
  if (activeLabel) activeLabel.classList.remove('hidden');
}

function hideSleepCountdown() {
  document.getElementById('sleepCountdown')?.classList.remove('show');
  const activeLabel = document.getElementById('sleepActiveLabel');
  if (activeLabel) activeLabel.classList.add('hidden');
}

function cancelSleepTimer() {
  clearInterval(sleepTimerInterval);
  sleepTimerInterval = null;
  sleepEndTime = null;
  state.sleepEndOfTrack = false;
  hideSleepCountdown();
  renderSleepOptions();
  showToast('Sleep Timer dimatikan');
}

function handleSleepEndOfTrack() {
  if (!state.sleepEndOfTrack) return;
  state.sleepEndOfTrack = false;
  hideSleepCountdown();
  audio.pause();
  state.isPlaying = false;
  updatePlayButtons();
  showToast('Sleep Timer selesai');
}

function openArtistInfo() {
  const content = document.getElementById('artistInfoContent');
  if (!content) return;
  const t = state.currentTrack;
  if (!t) return;
  content.innerHTML = `<div class="flex items-center gap-4 mb-4"><img src="${t.thumbnail || t.cover || ''}" class="w-16 h-16 rounded-2xl object-cover border border-[#E8846B]/30" alt="Cover" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'"><div class="min-w-0 flex-1"><h4 class="font-black text-base truncate text-white">${escapeHtml(t.title || '')}</h4><p class="text-xs text-[#F2A895] font-semibold truncate mt-0.5">${escapeHtml(t.artist || t.author || '')}</p></div></div><div class="space-y-3 text-xs"><div class="flex justify-between"><span class="text-[#B8A29C] font-semibold">Video ID</span><span class="font-mono font-bold text-white">${escapeHtml(t.videoId || '-')}</span></div>${t.album ? `<div class="flex justify-between"><span class="text-[#B8A29C] font-semibold">Album</span><span class="font-bold text-white truncate max-w-[200px] text-right">${escapeHtml(t.album)}</span></div>` : ''}${t.duration ? `<div class="flex justify-between"><span class="text-[#B8A29C] font-semibold">Durasi</span><span class="font-bold text-white">${escapeHtml(t.duration)}</span></div>` : ''}</div>${t.artistId ? `<button onclick="playClickSFX();closeArtistInfo();openArtist('${t.artistId}', '${escapeAttr(t.artist || '')}')" class="w-full mt-4 py-3 glass-light rounded-2xl text-xs font-bold text-[#F2A895] flex items-center justify-center gap-2 active:scale-95 transition border border-[#E8846B]/20"><i data-lucide="user" class="w-4 h-4"></i><span>Lihat Semua Lagu Artis</span></button>` : ''}`;
  document.getElementById('artistInfoBackdrop')?.classList.add('show');
  document.getElementById('artistInfoSheet')?.classList.add('show');
  refreshIcons();
}

function closeArtistInfo() {
  document.getElementById('artistInfoBackdrop')?.classList.remove('show');
  document.getElementById('artistInfoSheet')?.classList.remove('show');
}

function copyTrackLink() {
  const t = state.currentTrack;
  if (!t) return;
  const url = t.videoId ? `https://music.youtube.com/watch?v=${t.videoId}` : '';
  if (!url) { showToast('Link tidak tersedia'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => showToast('Link disalin')).catch(() => showToast('Gagal menyalin'));
  } else showToast('Clipboard tidak didukung');
}

function openYouTube() {
  const t = state.currentTrack;
  if (!t || !t.videoId) { showToast('Link tidak tersedia'); return; }
  window.open(`https://music.youtube.com/watch?v=${t.videoId}`, '_blank');
}

function switchLibraryTab(tab) {
  state.libraryTab = tab;
  document.querySelectorAll('.lib-tab').forEach((el) => {
    const active = el.dataset.tab === tab;
    el.classList.toggle('active', active);
  });
  renderLibrary();
}

function renderLibrary() {
  const box = document.getElementById('libraryContent');
  if (!box) return;
  if (state.libraryTab === 'liked') {
    if (!state.likedTracks.length) { box.innerHTML = emptyHTML('Belum ada lagu disukai'); refreshIcons(); return; }
    box.innerHTML = state.likedTracks.map((id) => `<div class="flex items-center gap-3 p-2.5 hover:bg-white/5 rounded-2xl cursor-pointer" onclick="playClickSFX();playFromLibrary('${id}')"><div class="w-11 h-11 rounded-xl glass-light flex items-center justify-center border border-[#E8846B]/20"><i data-lucide="heart" fill="currentColor" class="w-4 h-4 text-[#E8846B]"></i></div><div class="truncate flex-1 min-w-0"><h4 class="font-bold text-sm truncate text-white">Video ID: ${id}</h4><p class="text-[11px] text-[#B8A29C]">Disukai</p></div></div>`).join('');
    refreshIcons();
    return;
  }
  if (state.libraryTab === 'pinned') {
    if (!state.pinnedTracks.length) { box.innerHTML = emptyHTML('Belum ada lagu dipin'); refreshIcons(); return; }
    box.innerHTML = state.pinnedTracks.map((s) => `<div onclick="playSinglePinned('${s.videoId}')" class="flex items-center gap-3 p-2.5 hover:bg-white/5 rounded-2xl cursor-pointer"><img src="${s.thumbnail}" class="w-11 h-11 rounded-xl object-cover" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'"><div class="truncate flex-1 min-w-0"><h4 class="font-bold text-sm truncate text-white">${escapeHtml(s.title)}</h4><p class="text-[11px] text-[#B8A29C] truncate">${escapeHtml(s.artist || '')}</p></div><button onclick="event.stopPropagation();unpinTrack('${s.videoId}')" class="text-[#B8A29C] p-2"><i data-lucide="x" class="w-3.5 h-3.5"></i></button></div>`).join('');
    refreshIcons();
    return;
  }
  if (state.libraryTab === 'queue') {
    if (!state.queue.length) { box.innerHTML = emptyHTML('Antrian kosong'); refreshIcons(); return; }
    box.innerHTML = state.queue.map((s, i) => {
      const encoded = encodeAttr(s);
      const listEncoded = encodeAttr(state.queue);
      const current = i === state.index;
      return `<div onclick='playTrackFromList(${encoded}, ${i}, ${listEncoded})' class="flex items-center gap-3 p-2.5 ${current ? 'bg-[#E8846B]/10 border border-[#E8846B]/40' : 'hover:bg-white/5'} rounded-2xl cursor-pointer"><img src="${s.thumbnail}" class="w-11 h-11 rounded-xl object-cover" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'"><div class="truncate flex-1 min-w-0"><h4 class="font-bold text-sm text-white truncate">${escapeHtml(s.title)}</h4><p class="text-[11px] text-[#B8A29C] truncate">${escapeHtml(s.artist || '')}</p></div>${current ? '<div class="playing-bars"><span></span><span></span><span></span></div>' : ''}</div>`;
    }).join('');
    refreshIcons();
    return;
  }
  if (state.libraryTab === 'recent') {
    if (!state.recentTracks.length) {
      box.innerHTML = `<div class="text-center py-12 text-[#B8A29C]"><i data-lucide="history" class="w-6 h-6 mb-2 text-[#E8846B] inline-block"></i><p class="font-bold text-sm">Belum ada riwayat putar</p></div>`;
      refreshIcons();
      return;
    }
    const header = `<div class="flex items-center justify-between mb-2 px-1"><p class="text-[11px] font-black uppercase tracking-widest text-[#B8A29C]">${state.recentTracks.length} lagu terakhir</p><button onclick="playClickSFX();clearRecent()" class="text-[11px] font-bold text-[#E8846B] flex items-center gap-1"><i data-lucide="trash-2" class="w-3 h-3"></i><span>Bersihkan</span></button></div>`;
    const list = state.recentTracks.map((s, i) => {
      const track = { videoId: s.videoId, title: s.title, artist: s.artist, thumbnail: s.thumbnail };
      const encoded = encodeAttr(track);
      const listEncoded = encodeAttr(state.recentTracks);
      return `<div onclick='playTrackFromList(${encoded}, ${i}, ${listEncoded})' class="recent-item cursor-pointer"><div class="relative w-11 h-11 flex-none"><img src="${s.thumbnail}" class="w-11 h-11 rounded-xl object-cover" loading="lazy" onerror="this.src='https://via.placeholder.com/100/2A1815/E8846B?text=?'"><div class="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-[#E8846B] flex items-center justify-center border-2 border-[#1A0F0D]"><i data-lucide="history" class="w-2.5 h-2.5 text-white"></i></div></div><div class="truncate flex-1 min-w-0"><h4 class="font-bold text-sm text-white truncate">${escapeHtml(s.title)}</h4><p class="text-[11px] text-[#B8A29C] truncate">${escapeHtml(s.artist || '')} • ${timeAgo(s.playedAt)}</p></div><button onclick="event.stopPropagation();playClickSFX();playTrackFromList(${encoded}, ${i}, ${listEncoded})" class="w-8 h-8 rounded-full glass-light flex items-center justify-center border border-[#E8846B]/20 flex-none"><i data-lucide="play" class="w-3 h-3 ml-0.5 text-[#E8846B]"></i></button></div>`;
    }).join('');
    box.innerHTML = header + list;
    refreshIcons();
  }
}

function timeAgo(ts) {
  if (!ts) return 'Baru saja';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'Baru saja';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} jam lalu`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} hari lalu`;
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

async function playFromLibrary(videoId) {
  const track = { videoId, title: 'Unknown', thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` };
  playTrackFromList(track, 0, [track]);
}

function applyLiquidGlass(enabled) {
  document.body.classList.toggle('no-liquid-glass', !enabled);
  const knob = document.getElementById('liquidGlassKnob');
  const btn = document.getElementById('liquidGlassToggle');
  if (knob && btn) {
    knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
    btn.style.backgroundColor = enabled ? '#E8846B' : '#3D2621';
  }
  localStorage.setItem('fashBeats.liquidGlass', enabled ? '1' : '0');
}

function toggleLiquidGlass() {
  if (localStorage.getItem('fashBeats.lowDevice') === '1') { showToast('Nonaktifkan Mode Perangkat Rendah terlebih dahulu'); return; }
  const current = localStorage.getItem('fashBeats.liquidGlass') !== '0';
  applyLiquidGlass(!current);
  showToast(!current ? 'Liquid Glass aktif' : 'Liquid Glass nonaktif');
}

function applyAutoTheme(enabled) {
  document.body.classList.toggle('auto-theme', enabled);
  const knob = document.getElementById('autoThemeKnob');
  const btn = document.getElementById('autoThemeToggle');
  if (knob && btn) {
    knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
    btn.style.backgroundColor = enabled ? '#E8846B' : '#3D2621';
  }
  localStorage.setItem('fashBeats.autoTheme', enabled ? '1' : '0');
  if (enabled) {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => setTheme(mql.matches ? 'light' : 'dark');
    apply();
    if (!window.__autoThemeListener) {
      window.__autoThemeListener = (e) => setTheme(e.matches ? 'light' : 'dark');
      mql.addEventListener('change', window.__autoThemeListener);
    }
  } else if (window.__autoThemeListener) {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    mql.removeEventListener('change', window.__autoThemeListener);
    window.__autoThemeListener = null;
  }
}

function toggleAutoTheme() {
  const current = localStorage.getItem('fashBeats.autoTheme') === '1';
  applyAutoTheme(!current);
  showToast(!current ? 'Auto Dark Theme aktif' : 'Auto Dark Theme nonaktif');
}

function setTheme(mode) {
  const html = document.documentElement;
  const btn = document.getElementById('themeToggleBtn');
  if (mode === 'light') {
    html.classList.remove('dark');
    document.body.classList.remove('bg-[#1A0F0D]', 'text-white');
    document.body.classList.add('bg-zinc-100', 'text-zinc-900');
    if (btn) btn.innerHTML = '<i data-lucide="sun" class="w-4 h-4"></i><span>Light</span>';
    localStorage.setItem('fashBeats.theme', 'light');
  } else {
    html.classList.add('dark');
    document.body.classList.add('bg-[#1A0F0D]', 'text-white');
    document.body.classList.remove('bg-zinc-100', 'text-zinc-900');
    if (btn) btn.innerHTML = '<i data-lucide="moon" class="w-4 h-4"></i><span>Dark</span>';
    localStorage.setItem('fashBeats.theme', 'dark');
  }
  refreshIcons();
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  setTheme(isDark ? 'light' : 'dark');
}

function pickFont(key) {
  document.body.classList.remove('font-poppins', 'font-inter');
  if (key === 'poppins') document.body.classList.add('font-poppins');
  if (key === 'inter') document.body.classList.add('font-inter');
  localStorage.setItem('fashBeats.font', key);
  document.querySelectorAll('.font-option').forEach((el) => el.classList.toggle('active', el.dataset.font === key));
  const names = { jakarta: 'Jakarta', poppins: 'Poppins', inter: 'Inter' };
  showToast(`Font: ${names[key]}`);
}

function applyFont(key) {
  document.body.classList.remove('font-poppins', 'font-inter');
  if (key === 'poppins') document.body.classList.add('font-poppins');
  if (key === 'inter') document.body.classList.add('font-inter');
  document.querySelectorAll('.font-option').forEach((el) => el.classList.toggle('active', el.dataset.font === key));
}

function pickBarStyle(style) {
  const bar = document.getElementById('progressBar');
  if (bar) {
    bar.classList.remove('bar-squiggly', 'bar-slim');
    if (style === 'squiggly') bar.classList.add('bar-squiggly');
    if (style === 'slim') bar.classList.add('bar-slim');
  }
  localStorage.setItem('fashBeats.barStyle', style);
  document.querySelectorAll('.bar-option').forEach((el) => el.classList.toggle('active', el.dataset.bar === style));
  showToast(`Bar: ${style}`);
}

function applyBarStyle(style) {
  const bar = document.getElementById('progressBar');
  if (!bar) return;
  bar.classList.remove('bar-squiggly', 'bar-slim');
  if (style === 'squiggly') bar.classList.add('bar-squiggly');
  if (style === 'slim') bar.classList.add('bar-slim');
  document.querySelectorAll('.bar-option').forEach((el) => el.classList.toggle('active', el.dataset.bar === style));
}

function applyLowDeviceMode(enabled) {
  document.body.classList.toggle('low-device-mode', enabled);
  const knob = document.getElementById('lowDeviceKnob');
  const btn = document.getElementById('lowDeviceToggle');
  if (knob && btn) {
    knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
    btn.style.backgroundColor = enabled ? '#E8846B' : '#3D2621';
  }
  localStorage.setItem('fashBeats.lowDevice', enabled ? '1' : '0');
  const lgToggle = document.getElementById('liquidGlassToggle');
  if (enabled) { applyLiquidGlass(false); if (lgToggle) lgToggle.style.opacity = '0.4'; }
  else if (lgToggle) lgToggle.style.opacity = '1';
}

function toggleLowDeviceMode() {
  const current = localStorage.getItem('fashBeats.lowDevice') === '1';
  applyLowDeviceMode(!current);
  showToast(!current ? 'Mode Perangkat Rendah aktif' : 'Mode Perangkat Rendah nonaktif');
}

function applyLyricAnimation() {
  const bounce = localStorage.getItem('fashBeats.lyricBounce') !== '0';
  const fill = parseFloat(localStorage.getItem('fashBeats.lyricFill') || '0.25');
  document.body.classList.toggle('lyric-bounce-on', bounce);
  document.body.classList.toggle('lyric-bounce-off', !bounce);
  document.documentElement.style.setProperty('--lyric-fill-smooth', fill + 's');
  const knob = document.getElementById('lyricBounceKnob');
  const btn = document.getElementById('lyricBounceToggle');
  if (knob && btn) {
    knob.style.transform = bounce ? 'translateX(20px)' : 'translateX(0)';
    btn.style.backgroundColor = bounce ? '#E8846B' : '#3D2621';
  }
  const slider = document.getElementById('lyricFillSlider');
  const valueEl = document.getElementById('lyricFillValue');
  if (slider) slider.value = fill;
  if (valueEl) valueEl.innerText = fill.toFixed(2) + 's';
}

function toggleLyricBounce() {
  const current = localStorage.getItem('fashBeats.lyricBounce') !== '0';
  localStorage.setItem('fashBeats.lyricBounce', current ? '0' : '1');
  applyLyricAnimation();
  showToast(!current ? 'Line Bounce aktif' : 'Line Bounce nonaktif');
}

function setLyricFill(value) {
  const v = parseFloat(value);
  localStorage.setItem('fashBeats.lyricFill', String(v));
  document.documentElement.style.setProperty('--lyric-fill-smooth', v + 's');
  const valueEl = document.getElementById('lyricFillValue');
  if (valueEl) valueEl.innerText = v.toFixed(2) + 's';
}

function applySkipSilence(enabled) {
  state.skipSilence = enabled;
  localStorage.setItem('fashBeats.skipSilence', enabled ? '1' : '0');
  const knob = document.getElementById('skipSilenceKnob');
  const btn = document.getElementById('skipSilenceToggle');
  if (knob && btn) {
    knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
    btn.style.backgroundColor = enabled ? '#E8846B' : '#3D2621';
  }
  if (enabled) {
    ensureSilenceGraph();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    startSilenceMonitor();
  }
}

function toggleSkipSilence() {
  const current = localStorage.getItem('fashBeats.skipSilence') === '1';
  applySkipSilence(!current);
  showToast(!current ? 'Skip Silence aktif' : 'Skip Silence nonaktif');
}

function autoDetectLowDevice() {
  try {
    const mem = navigator.deviceMemory || navigator.hardwareConcurrency || 8;
    const cores = navigator.hardwareConcurrency || 8;
    const conn = (navigator.connection && navigator.connection.effectiveType) || '4g';
    const isLow = mem <= 2 || cores <= 4 || /(2g|slow-2g)/.test(conn);
    if (isLow && localStorage.getItem('fashBeats.lowDevice') === null) {
      applyLowDeviceMode(true);
      showToast('Mode Perangkat Rendah diaktifkan otomatis');
    }
  } catch (_) {}
}

function checkVersionUpdate() {
  const lastSeen = localStorage.getItem(VERSION_STORAGE_KEY);
  if (lastSeen === APP_VERSION) return;
  localStorage.setItem(VERSION_STORAGE_KEY, APP_VERSION);
  setTimeout(() => showUpdateAnnouncement(APP_VERSION), 2800);
}

function formatClock(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}.${String(m).padStart(2, '0')} ${ampm}`;
}

function showUpdateAnnouncement(version) {
  const existing = document.getElementById('updateBanner');
  if (existing) existing.remove();
  const elapsed = formatClock(new Date());
  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <button class="update-close" aria-label="Tutup"><i data-lucide="x" class="w-4 h-4"></i></button>
    <div class="flex items-start gap-3">
      <div class="update-icon"><i data-lucide="sparkles" class="w-5 h-5"></i></div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="update-chip">Telah Tiba</span>
          <span class="update-time">v${version} • ${elapsed}</span>
        </div>
        <h3 class="update-title">Fash Beats v${version} sudah mendarat</h3>
        <ul class="update-list">
          <li><b>Recent Play</b> di Library — riwayat lagu yang baru diputar</li>
          <li><b>Info Artis</b> lengkap dari menu opsi lagu</li>
          <li>Tema warna baru: <b>Warm Dark</b> yang lebih nyaman</li>
          <li>Loading screen lebih cantik & halus</li>
          <li>Performa & stabilitas lebih baik</li>
        </ul>
      </div>
    </div>
  `;
  document.body.appendChild(banner);
  refreshIcons();
  requestAnimationFrame(() => banner.classList.add('show'));
  const closeBtn = banner.querySelector('.update-close');
  const dismiss = () => {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 500);
  };
  closeBtn.addEventListener('click', dismiss);
  setTimeout(() => { if (banner.parentElement) dismiss(); }, 18000);
}

function toggleLanguageDropdown() {
  const dd = document.getElementById('languageDropdown');
  const chev = document.getElementById('langChevron');
  if (!dd) return;
  const isHidden = dd.classList.contains('hidden');
  if (isHidden) { dd.classList.remove('hidden'); if (chev) chev.style.transform = 'rotate(180deg)'; }
  else { dd.classList.add('hidden'); if (chev) chev.style.transform = 'rotate(0deg)'; }
}

function renderLanguageList() {
  const list = document.getElementById('languageList');
  if (!list) return;
  const current = localStorage.getItem('fashBeats.lang') || 'id';
  list.innerHTML = LANGUAGES.map((l) => `<div onclick="playClickSFX();pickLanguage('${l.code}')" class="lang-item ${l.code === current ? 'selected' : ''}"><span class="text-lg">${l.flag}</span><span class="text-sm font-semibold flex-1 text-white">${l.name}</span>${l.code === current ? '<i data-lucide="check" class="w-3 h-3 text-[#E8846B]"></i>' : ''}</div>`).join('');
  refreshIcons();
}

function pickLanguage(code) {
  const lang = LANGUAGES.find((l) => l.code === code);
  if (!lang) return;
  localStorage.setItem('fashBeats.lang', code);
  state.language = code;
  const flagEl = document.getElementById('selectedLangFlag');
  const nameEl = document.getElementById('selectedLangName');
  if (flagEl) flagEl.innerText = lang.flag;
  if (nameEl) nameEl.innerText = lang.name;
  renderLanguageList();
  toggleLanguageDropdown();
  showToast(`Bahasa: ${lang.name}`);
  state.homeLoaded = false;
  loadHomeShelves();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#languagePicker')) {
    document.getElementById('languageDropdown')?.classList.add('hidden');
    const chev = document.getElementById('langChevron');
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
});

function initSettings() {
  const lg = localStorage.getItem('fashBeats.liquidGlass') !== '0';
  applyLiquidGlass(lg);
  const at = localStorage.getItem('fashBeats.autoTheme') === '1';
  applyAutoTheme(at);
  const ld = localStorage.getItem('fashBeats.lowDevice') === '1';
  applyLowDeviceMode(ld);
  const font = localStorage.getItem('fashBeats.font') || 'jakarta';
  applyFont(font);
  const bar = localStorage.getItem('fashBeats.barStyle') || 'default';
  applyBarStyle(bar);
  applyLyricAnimation();
  applySkipSilence(localStorage.getItem('fashBeats.skipSilence') === '1');
  renderLanguageList();
  const lang = localStorage.getItem('fashBeats.lang') || 'id';
  const l = LANGUAGES.find((x) => x.code === lang);
  if (l) {
    const flagEl = document.getElementById('selectedLangFlag');
    const nameEl = document.getElementById('selectedLangName');
    if (flagEl) flagEl.innerText = l.flag;
    if (nameEl) nameEl.innerText = l.name;
  }
  switchLibraryTab('liked');
}

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) { return escapeHtml(s).replace(/\\/g, '\\\\'); }

function encodeAttr(obj) {
  return JSON.stringify(obj).replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadingHTML(msg = 'Memuat...') {
  return `<div class="flex flex-col items-center justify-center py-12 text-[#B8A29C]"><i data-lucide="loader-2" class="w-6 h-6 text-[#E8846B] mb-3 animate-spin"></i><p class="font-bold text-sm">${msg}</p></div>`;
}

function emptyHTML(msg = 'Tidak ada hasil') {
  return `<div class="text-center py-12 text-[#B8A29C]"><i data-lucide="alert-circle" class="w-6 h-6 mb-2 text-[#E8846B] inline-block"></i><p class="font-bold text-sm">${msg}</p></div>`;
}

function errorHTML(msg = 'Terjadi kesalahan') {
  return `<div class="text-center py-12 text-[#B8A29C]"><i data-lucide="alert-triangle" class="w-6 h-6 mb-2 text-[#E8846B] inline-block"></i><p class="font-bold text-sm text-[#F2A895]">${msg}</p></div>`;
}

function showToast(message, ms = 2500) {
  const el = document.getElementById('toastNotif');
  const text = document.getElementById('toastNotifText');
  if (!el || !text) return;
  text.innerText = message;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function persistPlayerState() {
  try {
    localStorage.setItem('fashBeats.player', JSON.stringify({
      track: state.currentTrack,
      queue: state.queue.slice(0, 20),
      index: state.index,
      volume: audio.volume,
      isShuffle: state.isShuffle,
      repeatMode: state.repeatMode
    }));
  } catch (_) {}
}

function restorePlayerFromStorage() {
  try {
    const raw = localStorage.getItem('fashBeats.player');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved.track) return;
    state.currentTrack = saved.track;
    state.queue = saved.queue || [];
    state.index = saved.index != null ? saved.index : -1;
    state.isShuffle = !!saved.isShuffle;
    state.repeatMode = saved.repeatMode || 'off';
    state.sleepEndOfTrack = false;
    updatePlayerUI();
    const btn = document.getElementById('shuffleBtn');
    if (btn && state.isShuffle) { btn.classList.remove('action-inactive'); btn.classList.add('action-active'); }
  } catch (_) {}
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    switch (e.code) {
      case 'Space': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': if (e.shiftKey) playNextTrack(); break;
      case 'ArrowLeft': if (e.shiftKey) playPrevTrack(); break;
      case 'KeyF':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        break;
      case 'Escape':
        closeLyrics(); closeUpNext(); closeOptionsSheet(); closeSleepSheet(); closePinSheet(); closeArtistInfo(); closeOfflinePage();
        break;
    }
  });
}

Object.assign(window, {
  switchTab, searchByQuery, searchByCategory, playTrackFromList, togglePlay, playNextTrack, playPrevTrack,
  openFullPlayer, closeFullPlayer, triggerPiP, openArtist, pickSuggestion, showLyrics, closeLyrics,
  showUpNext, closeUpNext, loadAutoRecommendations, toggleLike, toggleShuffle, cycleRepeat, showDevices,
  refreshHomeShelves, toggleLiquidGlass, toggleAutoTheme, toggleLowDeviceMode, applyLowDeviceMode,
  pickFont, pickBarStyle, toggleLanguageDropdown, pickLanguage, applyLiquidGlass, applyAutoTheme,
  applyFont, applyBarStyle, setTheme, openOptionsSheet, closeOptionsSheet, openSleepSheet, closeSleepSheet,
  pickSleepOption, cancelSleepTimer, openArtistInfo, closeArtistInfo, copyTrackLink, openYouTube,
  switchLibraryTab, renderLibrary, togglePin, unpinTrack, playSinglePinned, openPinSheet, closePinSheet,
  pinFromSearch, togglePinFromRow, downloadCurrentTrack, addToQueue, startMix, clearAllOffline,
  updateStorageInfo, openOfflinePage, closeOfflinePage, renderOfflinePage, renderUserBadge, copyDeviceId,
  handleResetData, getDeviceId, parseLyrics, parseTtml, findCurrentLineIndex, API,
  toggleLyricBounce, setLyricFill, applyLyricAnimation, toggleSkipSilence, applySkipSilence,
  autoDetectLowDevice, showUpdateAnnouncement, refreshIcons, APP_VERSION,
  playClickSFX, playSwishSFX, toggleTheme,
  refreshQuickPicks, loadMoreQuickPicks, initQuickPicks,
  addToRecent, clearRecent, timeAgo
});
