// ==UserScript==
// @name         Anitsu Downloader
// @name:pt-BR   Anitsu Downloader
// @namespace    https://nuvem.anitsu.moe/
// @version      2.0.1
// @description  Download em massa para o Anitsu Cloud (nuvem.anitsu.moe). Painel flutuante com seleção de arquivos, download direto ou via AB Download Manager, renovação automática de sessão, modo recursivo para baixar pastas inteiras e preview automático da capa do anime (via AniList).
// @description:pt-BR  Download em massa para o Anitsu Cloud (nuvem.anitsu.moe). Painel flutuante com seleção de arquivos, download direto ou via AB Download Manager, renovação automática de sessão, modo recursivo para baixar pastas inteiras e preview automático da capa do anime (via AniList).
// @author       TheCyBee & Saitama
// @match        https://nuvem.anitsu.moe/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      qzrxxwizigfdcpmwkztq.supabase.co
// @connect      graphql.anilist.co
// @run-at       document-idle
// @noframes
// @license      MIT
// @icon         https://nuvem.anitsu.moe/favicon.ico
// @downloadURL https://update.greasyfork.org/scripts/578627/Anitsu%20Downloader.user.js
// @updateURL https://update.greasyfork.org/scripts/578627/Anitsu%20Downloader.meta.js
// ==/UserScript==

// ═══════════════════════════════════════════════════════════════════════════════
// ANITSU DOWNLOADER — por TheCyBee & Saitama
// ═══════════════════════════════════════════════════════════════════════════════
//
// Configurações editáveis:
//   CONCURRENCY    → downloads simultâneos no modo direto (padrão: 2)
//   MAX_RETRIES    → tentativas por arquivo em caso de falha (padrão: 3)
//   RETRY_DELAY_MS → espera entre tentativas em ms (padrão: 2000)
// ─────────────────────────────────────────────────────────────────────────────

(function () {
'use strict';

// ─── Configurações ────────────────────────────────────────────────────────────
const CONCURRENCY = 2;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const BASE_URL = 'https://nuvem.anitsu.moe';
const API_TIMEOUT_MS = 15000;
const API_CACHE_MS = 45000;
const API_CACHE_MAX_ENTRIES = 180;
const CRAWL_CONCURRENCY = Math.min(12, Math.max(4, navigator.hardwareConcurrency || 6));
const CRAWL_PROGRESS_MS = 700;
const MAX_LOG_ENTRIES = 250;
const ABDM_QUEUE_REFRESH_ATTEMPTS = 2;
const ABDM_QUEUE_REFRESH_DELAY_MS = 1500;
const IDM_TRIGGER_DELAY_MS = 1200;
const ANILIST_API_URL = 'https://graphql.anilist.co';
const ANILIST_CACHE_MS = 24 * 60 * 60 * 1000; // 24h — capa/título não mudam
const ANILIST_TIMEOUT_MS = 8000;
const ANILIST_MISS_CACHE_MS = 6 * 60 * 60 * 1000; // 6h — evita re-tentar título sem match toda hora
const SESSION_COOKIE_DAYS = 30;
const SESSION_REFRESH_TIMEOUT_MS = 12000;
const SESSION_AUTO_CHECK_MS = 60 * 1000;
const SESSION_REFRESH_LOCK_KEY = 'anu-session-refresh-lock';
const SESSION_REFRESH_COOLDOWN_MS = 30 * 1000;

const ABDM_PORT_KEY = 'anu-abdm-port';
const ABDM_BATCH_KEY = 'anu-abdm-batch';
const ABDM_INTERVAL_KEY = 'anu-abdm-interval';
const ABDM_FOLDER_KEY = 'anu-abdm-folder';
const EXT_FILTER_KEY = 'anu-ext-filter';
const DOWNLOADER_MODE_KEY = 'anu-downloader-mode';
const PANEL_STATE_KEY = 'anu-panel-state';
const CONSOLE_HIDDEN_KEY = 'anu-console-hidden';

// ─── Supabase — autenticação ──────────────────────────────────────────────────
// Token dividido em dois cookies (sb-*-auth-token.0 e .1) por ser grande demais.
// Renovação: POST /auth/v1/token?grant_type=refresh_token via GM_xmlhttpRequest
// (fetch() não funciona — Supabase retorna ACAO: * incompatível com credentials: include)
// Anon key: chave pública do projeto, igual para todos. Expira 2033.
// Para obter nova: DevTools → Network → login Discord → POST /auth/v1/token?grant_type=pkce → header apikey
const SUPABASE_PROJECT = 'qzrxxwizigfdcpmwkztq';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6cnh4d2l6aWdmZGNwbXdrenRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE2ODQxODc3MTIsImV4cCI6MTk5OTc2MzcxMn0.M3e2Vvw_HQsDi4U8wDZpM0MFmMDFpm58Og-z6sA5cWw';

// ─── Estado interno ───────────────────────────────────────────────────────────
let fileList = [];
let selected = new Set();
let activeDownloadPaths = new Set();
let lastOperationPaths = new Set();
let downloading = false;
let stopped = false;
let lastCheckedIndex = null;
let sessionRefreshing = false;
let sessionRefreshPromise = null;
let ignoreObserver = false;
let activeLoadId = 0;
let currentPanelPath = '';
let hasCurrentPanelPath = false;
let pendingPanelPath = null;
let activeCrawlId = 0;
let crawling = false;
let loading = false;
let operationId = 0;
const activeDownloadHandles = new Map();
const retryTimers = new Set();
let extCacheRaw = null;
let extCacheList = [];

let abdmQueue = [];
let abdmOffset = 0;
let abdmTimer = null;
let abdmSending = false;
let abdmBatchInFlight = false;
let abdmNextAt = 0;
let abdmCountdownTimer = null;
let abdmOperationId = 0;
let abdmActiveSettings = null;
const abdmRequestHandles = new Set();
let abdmQueueTimer = null;
let abdmQueuePromise = null;
let abdmQueueRefreshRun = 0;
let abdmQueueRequestId = 0;
const apiCache = new Map();
const apiInflight = new Map();
const anilistCache = new Map(); // query -> { createdAt, media: {...} | null }
const anilistInflight = new Map();
let activeAnilistId = 0;

// ─── Sessão ───────────────────────────────────────────────────────────────────
const AUTH_COOKIE_NAME = 'sb-' + SUPABASE_PROJECT + '-auth-token';

function getCookieMap() {
  const result = new Map();
  String(document.cookie || '').split(';').forEach(function(part) {
    const index = part.indexOf('=');
    if (index < 0) { return; }
    const name = part.slice(0, index).trim();
    if (!name) { return; }
    result.set(name, part.slice(index + 1).trim());
  });
  return result;
}

function decodeBase64Json(value) {
  let raw = String(value || '');
  try { raw = decodeURIComponent(raw); } catch (e) {}
  raw = raw.replace(/^base64-/, '').replace(/-/g, '+').replace(/_/g, '/');
  while (raw.length % 4) { raw += '='; }
  const binary = atob(raw);
  if (typeof TextDecoder !== 'undefined') {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  return JSON.parse(decodeURIComponent(escape(binary)));
}

function encodeBase64Json(value) {
  const text = JSON.stringify(value);
  if (typeof TextEncoder !== 'undefined') {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  return btoa(unescape(encodeURIComponent(text)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function getAuthData() {
  try {
    const cookies = getCookieMap();
    const candidates = [];
    const direct = cookies.get(AUTH_COOKIE_NAME);
    if (direct) { candidates.push(direct); }
    const chunks = [];
    for (let i = 0; i < 12; i++) {
      const chunk = cookies.get(AUTH_COOKIE_NAME + '.' + i);
      if (typeof chunk !== 'string') { break; }
      chunks.push(chunk);
    }
    if (chunks.length) { candidates.push(chunks.join('')); }
    let best = null;
    candidates.forEach(function(raw) {
      try {
        let decoded;
        let normalized = String(raw).trim();
        try { normalized = decodeURIComponent(normalized); } catch (e) {}
        if (normalized.startsWith('{') || normalized.startsWith('[')) {
          decoded = JSON.parse(normalized);
        } else {
          decoded = decodeBase64Json(normalized);
        }
        if (!decoded || (!decoded.access_token && !decoded.refresh_token)) { return; }
        if (!best || Number(decoded.expires_at || 0) >= Number(best.expires_at || 0)) { best = decoded; }
      } catch (e) {}
    });
    return best;
  } catch (e) {
    return null;
  }
}

function writeAuthData(data) {
  const b64 = encodeBase64Json(data);
  const chunkSize = 3400;
  const chunks = [];
  for (let i = 0; i < b64.length; i += chunkSize) { chunks.push(b64.slice(i, i + chunkSize)); }
  const expires = new Date(Date.now() + SESSION_COOKIE_DAYS * 24 * 60 * 60 * 1000).toUTCString();
  const secureFlag = location.protocol === 'https:' ? '; Secure' : '';
  const sharedDomain = /(^|\.)anitsu\.moe$/i.test(location.hostname) ? '; domain=.anitsu.moe' : '';
  const flags = '; path=/; expires=' + expires + sharedDomain + '; SameSite=Lax' + secureFlag;
  const names = [AUTH_COOKIE_NAME];
  for (let i = 0; i < 12; i++) { names.push(AUTH_COOKIE_NAME + '.' + i); }
  names.forEach(function(name) {
    document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax' + secureFlag;
    document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; domain=' +
      location.hostname + '; SameSite=Lax' + secureFlag;
    if (sharedDomain) {
      document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT' +
        sharedDomain + '; SameSite=Lax' + secureFlag;
    }
  });

  if (chunks.length === 1) {
    document.cookie = AUTH_COOKIE_NAME + '=base64-' + chunks[0] + flags;
  } else {
    chunks.forEach(function(chunk, index) {
      document.cookie = AUTH_COOKIE_NAME + '.' + index + '=' + (index === 0 ? 'base64-' : '') + chunk + flags;
    });
  }
  const stored = getAuthData();
  return !!(stored && stored.access_token === data.access_token && stored.refresh_token);
}

function setSessionRefreshingUi(value) {
  const btn = document.getElementById('anu-session');
  const txt = document.getElementById('anu-session-txt');
  if (!btn || !txt) { return; }
  btn.disabled = !!value;
  btn.classList.toggle('anu-refreshing', !!value);
  btn.setAttribute('aria-busy', value ? 'true' : 'false');
  if (value) { txt.textContent = 'renovando…'; }
}

function refreshSession() {
  if (sessionRefreshPromise) { return sessionRefreshPromise; }
  const data = getAuthData();
  if (!data || !data.refresh_token) {
    log('Sem token de renovação. Faça login novamente no Anitsu.', 'lerr');
    return Promise.resolve(false);
  }

  sessionRefreshing = true;
  setSessionRefreshingUi(true);
  log('Renovando a sessão…', 'linf');

  sessionRefreshPromise = new Promise(function(resolve) {
    let settled = false;
    function finish(ok) {
      if (settled) { return; }
      settled = true;
      resolve(!!ok);
    }

    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://' + SUPABASE_PROJECT + '.supabase.co/auth/v1/token?grant_type=refresh_token',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        },
        data: JSON.stringify({ refresh_token: data.refresh_token }),
        timeout: SESSION_REFRESH_TIMEOUT_MS,
        onload: function(r) {
          try {
            const body = JSON.parse(r.responseText || '{}');
            if (r.status < 200 || r.status >= 300 || !body.access_token) {
              log('Não foi possível renovar a sessão: ' +
                (body.error_description || body.msg || body.error || ('HTTP ' + r.status)) + '.', 'lerr');
              finish(false);
              return;
            }
            const minimal = {
              access_token: body.access_token,
              token_type: body.token_type || 'bearer',
              expires_in: body.expires_in,
              expires_at: body.expires_at || Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
              refresh_token: body.refresh_token || data.refresh_token,
              user: body.user || data.user,
            };
            if (!writeAuthData(minimal)) {
              log('A sessão foi renovada, mas o navegador bloqueou a gravação dos cookies.', 'lerr');
              finish(false);
              return;
            }
            // Limpa respostas antigas sem abortar a apiFetch que pode estar
            // aguardando esta própria renovação.
            apiCache.clear();
            log('Sessão renovada por mais aproximadamente 60 minutos.', 'lok');
            finish(true);
          } catch (e) {
            log('Resposta inválida ao renovar a sessão: ' + e.message, 'lerr');
            finish(false);
          }
        },
        onerror: function() {
          log('Erro de rede ao renovar a sessão.', 'lerr');
          finish(false);
        },
        ontimeout: function() {
          log('A renovação da sessão demorou demais. Tente novamente.', 'lerr');
          finish(false);
        },
        onabort: function() {
          log('A renovação da sessão foi interrompida.', 'lwrn');
          finish(false);
        },
      });
    } catch (e) {
      log('Não foi possível iniciar a renovação: ' + e.message, 'lerr');
      finish(false);
    }
  }).finally(function() {
    sessionRefreshing = false;
    sessionRefreshPromise = null;
    setSessionRefreshingUi(false);
    updateSessionIndicator();
  });

  return sessionRefreshPromise;
}

// ─── Utilitários ──────────────────────────────────────────────────────────────
function fmt(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) { return '—'; }
  if (value === 0) { return '0 B'; }
  if (value >= 1024 ** 3) { return (value / 1024 ** 3).toFixed(1) + ' GB'; }
  if (value >= 1024 ** 2) { return (value / 1024 ** 2).toFixed(1) + ' MB'; }
  if (value >= 1024) { return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB'; }
  return value + ' B';
}

function totalSize(paths) {
  let total = 0;
  fileList.forEach(function(f) {
    if (!f.is_directory && paths.has(f.path)) { total += f.size || 0; }
  });
  return total;
}

function sanitizeName(name) {
  if (!name) { return 'arquivo'; }
  let safe = String(name);
  if (safe.normalize) { safe = safe.normalize('NFC'); }
  safe = safe.replace(/[\\/:*?"<>|]/g, '_');
  safe = safe.replace(/[\x00-\x1F\x7F]/g, '');
  safe = safe.replace(/_+/g, '_');
  safe = safe.replace(/^[\s._]+|[\s._]+$/g, '');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe.split('.')[0])) { safe = '_' + safe; }
  if (Array.from(safe).length > 200) {
    const match = safe.match(/\.[^.]+$/);
    const ext = match ? match[0] : '';
    const stem = ext ? safe.slice(0, -ext.length) : safe;
    const maxStemLength = Math.max(1, 200 - Array.from(ext).length);
    safe = Array.from(stem).slice(0, maxStemLength).join('') + ext;
  }
  return safe || 'arquivo';
}

function assignUniqueDownloadNames(items) {
  const counts = new Map();
  items.forEach(function(item) {
    const key = sanitizeName(item.name).toLocaleLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const used = new Set();
  items.forEach(function(item) {
    const base = sanitizeName(item.name);
    const key = base.toLocaleLowerCase();
    let candidate = base;
    if ((counts.get(key) || 0) > 1) {
      const segments = String(item.path || '').split('/').filter(Boolean);
      const parent = segments.length > 1 ? segments.slice(-3, -1).join(' - ') : 'pasta';
      candidate = sanitizeName(parent + ' - ' + base);
    }
    let unique = candidate;
    let suffix = 2;
    while (used.has(unique.toLocaleLowerCase())) {
      const extMatch = candidate.match(/(\.[^.]+)$/);
      const ext = extMatch ? extMatch[1] : '';
      const stem = ext ? candidate.slice(0, -ext.length) : candidate;
      unique = sanitizeName(stem + ' (' + suffix++ + ')' + ext);
    }
    used.add(unique.toLocaleLowerCase());
    item.downloadName = unique;
  });
}

// Extrai um termo de busca "limpo" a partir do nome de uma pasta de release,
// removendo tags de grupo/fansub, resolução, codec, temporada/episódio, ano
// entre parênteses, etc. Ex.: "[SubGrupo] Attack on Titan S4 (1080p BD)"
// → "Attack on Titan".
function guessAnimeTitle(folderName) {
  let name = String(folderName || '');
  name = name.replace(/\[[^\]]*\]/g, ' ');           // [Grupo], [1080p], [Dual Áudio]...
  name = name.replace(/\([^)]*\)/g, ' ');             // (2023), (BD 1080p)...
  name = name.replace(/[._]+/g, ' ');                 // normaliza "Nome.Do.Anime" antes das tags abaixo
  name = name.replace(/\b(19|20)\d{2}\b/g, ' ');      // anos soltos
  name = name.replace(/\b(S(?:eason)?\.?\s?\d{1,2}|Temporada\s?\d{1,2})\b/gi, ' ');
  name = name.replace(/\b(EP?\.?\s?\d{1,4}|Episodio|Epis[oó]dio)\b/gi, ' ');
  name = name.replace(/\b(1080p|720p|480p|2160p|4k|BD ?Rip|WEB ?-?DL|HDTV|BluRay|Blu-Ray|x26[45]|HEVC|AAC|FLAC|Dual ?[ÁA]udio|Legendado|Dublado|Multi)\b/gi, ' ');
  name = name.replace(/\s{2,}/g, ' ').trim();
  return name || String(folderName || '').trim();
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function backoffDelay(attempt) {
  const base = RETRY_DELAY_MS * Math.pow(1.6, Math.max(0, attempt));
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(15000, Math.round(base + jitter));
}

function debounce(fn, wait) {
  let timer = null;
  return function() {
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(function() { fn.apply(null, args); }, wait);
  };
}

function parseIntSafe(value, fallback, min, max) {
  let parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) { parsed = fallback; }
  if (Number.isFinite(min)) { parsed = Math.max(min, parsed); }
  if (Number.isFinite(max)) { parsed = Math.min(max, parsed); }
  return parsed;
}

function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

function getStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function setStorage(key, value) {
  try {
    localStorage.setItem(key, String(value));
    return true;
  } catch (e) {
    return false;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cloneFile(f) {
  return {
    name: f.name,
    path: f.path,
    size: Number(f.size) || 0,
    is_directory: !!f.is_directory,
    status: f.status || 'pending',
    retries: f.retries || 0,
  };
}

function makeChildPath(parent, name) {
  return parent ? parent + '/' + name : name;
}

function getCachedApi(path) {
  const key = String(path || '');
  const item = apiCache.get(key);
  if (!item) { return null; }
  if (Date.now() - item.createdAt > API_CACHE_MS) {
    apiCache.delete(key);
    return null;
  }
  apiCache.delete(key);
  apiCache.set(key, item);
  return { files: item.files.map(cloneFile) };
}

function setCachedApi(path, files) {
  const key = String(path || '');
  apiCache.delete(key);
  apiCache.set(key, {
    createdAt: Date.now(),
    files: (files || []).map(cloneFile),
  });
  while (apiCache.size > API_CACHE_MAX_ENTRIES) {
    apiCache.delete(apiCache.keys().next().value);
  }
}

function clearApiCache(path, abortInflight) {
  const shouldAbort = abortInflight !== false;
  if (typeof path === 'string') {
    apiCache.delete(path);
    const entry = apiInflight.get(path);
    if (entry && shouldAbort) {
      entry.cancelled = true;
      entry.controllers.forEach(function(controller) { try { controller.abort(); } catch (e) {} });
      apiInflight.delete(path);
    }
    return;
  }
  apiCache.clear();
  if (shouldAbort) {
    apiInflight.forEach(function(entry) {
      entry.cancelled = true;
      entry.controllers.forEach(function(controller) { try { controller.abort(); } catch (e) {} });
    });
    apiInflight.clear();
  }
}

// Breadcrumb: SPA nunca muda URL. Pastas pai = <button>, atual = <span>.
// O span não usa trim() para preservar espaços no nome da pasta (o servidor
// pode ter pastas com espaço no final e o path precisa ser exato).
function getCurrentPath() {
  const parts = [];
  const nav = Array.from(document.querySelectorAll('nav')).find(function(candidate) {
    return Array.from(candidate.querySelectorAll('button')).some(function(button) {
      return button.textContent.trim() === 'Home';
    });
  });
  if (!nav) { return ''; }
  nav.querySelectorAll('button').forEach(function(btn) {
    const text = btn.textContent.trim();
    if (text && text !== 'Home') { parts.push(text); }
  });
  nav.querySelectorAll('span').forEach(function(span) {
    if (span.closest('button') || span.querySelector('span')) { return; }
    const raw = span.textContent;
    const comparable = raw.trim();
    if (comparable && comparable !== '/' && comparable !== '›' && comparable !== 'Home' &&
        comparable !== 'Cadê meu anime?') {
      parts.push(raw);
    }
  });
  return parts.join('/');
}

function mkBadge(status) {
  const map = {
    pending: ['bp', 'aguardando'],
    uncertain: ['bu', '? verificar ABDM'],
    done: ['bd', '✓ concluído'],
    sent: ['bd', '✓ enviado'],
    error: ['be', '✗ falhou'],
    downloading: ['ba', '↓ baixando'],
  };
  const pair = map[status] || ['bp', status];
  return '<span class="anu-bx ' + pair[0] + '">' + pair[1] + '</span>';
}

// Em caso de 401, renova sessão e retenta uma vez (retry=true evita loop).
// Em caso de 503, espera um pouco e tenta de novo (até MAX_RETRIES vezes).
function apiFetch(path, retry, attempt) {
  const key = String(path || '');
  const cached = getCachedApi(key);
  if (cached) { return Promise.resolve(cached); }
  const pendingEntry = apiInflight.get(key);
  if (pendingEntry) {
    return pendingEntry.promise.then(function(data) {
      return { files: (data.files || []).map(cloneFile) };
    });
  }

  const entry = { promise: null, controllers: new Set(), cancelled: false };

  function requestAttempt(authRetried, requestAttemptNumber) {
    if (entry.cancelled) { return Promise.reject(new Error('Carregamento cancelado.')); }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const options = { credentials: 'include' };
    let timeout = null;
    if (controller) {
      options.signal = controller.signal;
      entry.controllers.add(controller);
      timeout = setTimeout(function() { controller.abort(); }, API_TIMEOUT_MS);
    }

    function cleanupAttempt() {
      if (timeout) { clearTimeout(timeout); }
      if (controller) { entry.controllers.delete(controller); }
    }

    // Cada tentativa física encerra seu próprio timeout/controller antes de
    // aguardar refresh, backoff ou uma nova tentativa.
    const physicalAttempt = fetch('/api/files?path=' + encodeURIComponent(key), options)
      .then(function(r) {
        if (!r.ok) { return { response: r, data: null }; }
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          throw new Error('Resposta não é JSON em /' + (key || 'raiz') + ' — sessão expirada?');
        }
        return r.json().then(function(data) {
          return { response: r, data: data };
        });
      }).finally(cleanupAttempt);

    return physicalAttempt.then(function(result) {
      const r = result.response;
      if (r.status === 401 && !authRetried) {
        return refreshSession().then(function(ok) {
          if (!ok) { throw new Error('Sessão expirada. Faça login novamente.'); }
          return requestAttempt(true, 0);
        });
      }
      if ((r.status === 429 || r.status === 503) && requestAttemptNumber < MAX_RETRIES) {
        return sleep(backoffDelay(requestAttemptNumber)).then(function() {
          return requestAttempt(authRetried, requestAttemptNumber + 1);
        });
      }
      if (!r.ok) { throw new Error('HTTP ' + r.status + ' em /' + (key || 'raiz')); }
      const data = result.data;
      if (!data || !Array.isArray(data.files)) {
        throw new Error('A API retornou uma lista de arquivos inválida em /' + (key || 'raiz') + '.');
      }
      const files = data.files.map(function(f) {
        if (!f || typeof f !== 'object') { throw new Error('A API retornou um item de arquivo inválido.'); }
        const name = typeof f.name === 'string' && f.name ? f.name : 'arquivo';
        return {
          name: name,
          path: typeof f.path === 'string' && f.path ? f.path : makeChildPath(key, name),
          size: Number.isFinite(Number(f.size)) ? Math.max(0, Number(f.size)) : 0,
          is_directory: !!f.is_directory,
        };
      });
      return { files: files };
    }, function(e) {
      if (e && e.name === 'AbortError') {
        if (entry.cancelled) { throw new Error('Carregamento cancelado.'); }
        throw new Error('Tempo esgotado ao carregar /' + (key || 'raiz') + '. Tente novamente.');
      }
      if (requestAttemptNumber < MAX_RETRIES && e instanceof TypeError) {
        return sleep(backoffDelay(requestAttemptNumber)).then(function() {
          return requestAttempt(authRetried, requestAttemptNumber + 1);
        });
      }
      throw e;
    });
  }

  entry.promise = requestAttempt(!!retry, attempt || 0).then(function(data) {
    if (!entry.cancelled) { setCachedApi(key, data.files); }
    return { files: data.files.map(cloneFile) };
  }).finally(function() {
    if (apiInflight.get(key) === entry) { apiInflight.delete(key); }
  });

  apiInflight.set(key, entry);
  return entry.promise.then(function(data) {
    return { files: (data.files || []).map(cloneFile) };
  });
}

function dlUrl(path) { return BASE_URL + '/api/download?path=' + encodeURIComponent(path); }

function getDownloadUrl(item) {
  if (typeof item === 'string') { return dlUrl(item); }
  if (!item.downloadUrl) { item.downloadUrl = dlUrl(item.path); }
  return item.downloadUrl;
}

function getAbdmPort() { return String(parseIntSafe(getStorage(ABDM_PORT_KEY, '15151'), 15151, 1, 65535)); }
function getAbdmBatch() { return parseIntSafe(getStorage(ABDM_BATCH_KEY, '5'), 5, 1, 999); }
function getAbdmInterval() { return parseIntSafe(getStorage(ABDM_INTERVAL_KEY, '30'), 30, 1, 999); }
function getAbdmFolder() { return getStorage(ABDM_FOLDER_KEY, ''); }

// ─── Preview de anime (AniList) ────────────────────────────────────────────────
const ANILIST_QUERY =
  'query ($search: String) {' +
  '  Media(search: $search, type: ANIME) {' +
  '    id' +
  '    title { romaji english native }' +
  '    coverImage { large medium color }' +
  '    averageScore' +
  '    episodes' +
  '    format' +
  '    siteUrl' +
  '  }' +
  '}';

function getCachedAnilist(query) {
  const item = anilistCache.get(query);
  if (!item) { return undefined; }
  if (Date.now() - item.createdAt > (item.media ? ANILIST_CACHE_MS : ANILIST_MISS_CACHE_MS)) {
    anilistCache.delete(query);
    return undefined;
  }
  return item.media;
}

// Busca dados de um anime no AniList a partir de um termo de busca.
// Resolve com o objeto `media` do AniList, ou null se não encontrado/erro.
function fetchAnilistMedia(query) {
  const cached = getCachedAnilist(query);
  if (cached !== undefined) { return Promise.resolve(cached); }
  const pending = anilistInflight.get(query);
  if (pending) { return pending; }
  const request = new Promise(function(resolve) {
    let settled = false;
    function finish(media, cacheResult) {
      if (settled) { return; }
      settled = true;
      if (cacheResult) { anilistCache.set(query, { createdAt: Date.now(), media: media }); }
      resolve(media);
    }
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: ANILIST_API_URL,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        data: JSON.stringify({ query: ANILIST_QUERY, variables: { search: query } }),
        timeout: ANILIST_TIMEOUT_MS,
        onload: function(r) {
          if (r.status < 200 || r.status >= 300) { finish(null, false); return; }
          try {
            const body = JSON.parse(r.responseText || '{}');
            if (body.errors) { finish(null, false); return; }
            finish((body.data && body.data.Media) || null, true);
          } catch (e) { finish(null, false); }
        },
        onerror: function() { finish(null, false); },
        ontimeout: function() { finish(null, false); },
        onabort: function() { finish(null, false); },
      });
    } catch (e) {
      finish(null, false);
    }
  }).finally(function() {
    if (anilistInflight.get(query) === request) { anilistInflight.delete(query); }
  });
  anilistInflight.set(query, request);
  return request;
}

// ─── Design tokens ────────────────────────────────────────────────────────────
// Paleta premium — gradientes e cores ricas
const C = {
  bg: '#090b12',
  bgPanel: 'rgba(15,18,30,0.94)',
  bgHeader: 'rgba(17,20,34,0.96)',
  bgRow: 'rgba(23,27,43,0.52)',
  bgRowHov: 'rgba(38,44,69,0.68)',
  bgInput: 'rgba(9,12,22,0.78)',
  bgLog: 'rgba(8,10,18,0.84)',
  border: 'rgba(181,194,255,0.10)',
  borderLight: 'rgba(190,201,255,0.19)',
  borderSub: 'rgba(181,194,255,0.055)',
  text: '#f2f5ff',
  textMid: '#a2abc4',
  textDim: '#626c87',
  accent: '#8294ff',
  accentLight: '#aebaff',
  accentDim: 'rgba(130,148,255,0.14)',
  accentGlow: 'rgba(130,148,255,0.30)',
  green: '#34d399',
  greenDim: 'rgba(52,211,153,0.12)',
  greenGlow: 'rgba(52,211,153,0.2)',
  red: '#f87171',
  redDim: 'rgba(248,113,113,0.12)',
  amber: '#fbbf24',
  amberDim: 'rgba(251,191,36,0.12)',
  purple: '#b69cff',
  purpleDim: 'rgba(167,139,250,0.12)',
  glass: 'rgba(255,255,255,0.03)',
};

// ─── Estilos — UI Premium ─────────────────────────────────────────────────────
GM_addStyle(
  // Font import
  '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");' +
  '@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap");' +

  // Keyframes
  '@keyframes anu-pulse{0%,100%{opacity:1;}50%{opacity:.3;}}' +
  '@keyframes anu-shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}' +
  '@keyframes anu-fadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}' +
  '@keyframes anu-glow{0%,100%{box-shadow:0 0 8px rgba(108,140,255,0.15);}50%{box-shadow:0 0 20px rgba(108,140,255,0.35);}}' +
  '@keyframes anu-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}' +
  '@keyframes anu-badgePop{0%{transform:scale(0.8);opacity:0;}100%{transform:scale(1);opacity:1;}}' +
  '@keyframes anu-gradientShift{0%{background-position:0% 50%;}50%{background-position:100% 50%;}100%{background-position:0% 50%;}}' +

  // Panel
  '#anu-panel{position:fixed;bottom:24px;right:24px;z-index:99999;width:500px;min-width:380px;' +
  'background:' + C.bgPanel + ';color:' + C.text + ';border-radius:16px;' +
  'box-shadow:0 28px 80px rgba(0,0,0,.52),0 0 0 1px ' + C.border + ',0 0 0 6px rgba(130,148,255,.018),0 0 52px rgba(99,102,241,.10);' +
  'backdrop-filter:blur(28px) saturate(1.15);-webkit-backdrop-filter:blur(28px) saturate(1.15);' +
  'font-family:"Inter",system-ui,-apple-system,sans-serif;font-size:13px;' +
  'display:flex;flex-direction:column;max-height:86vh;overflow:hidden;' +
  'opacity:0;transform:translateY(16px) scale(.97);' +
  'transition:box-shadow .3s ease,opacity .35s cubic-bezier(.4,0,.2,1),transform .35s cubic-bezier(.4,0,.2,1);}' +
  '#anu-panel.anu-mounted{opacity:1;transform:translateY(0) scale(1);}' +
  '#anu-panel:hover{box-shadow:0 32px 90px rgba(0,0,0,.58),0 0 0 1px ' + C.borderLight + ',0 0 64px rgba(99,102,241,.14);}' +

  // Icon wrapper
  '.anu-ic{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;line-height:0;}' +
  '.anu-ic svg{display:block;}' +

  // Header — gradient glass
  '#anu-header{display:flex;align-items:center;gap:10px;padding:15px 18px;' +
  'background:linear-gradient(118deg,rgba(130,148,255,.17) 0%,rgba(182,156,255,.11) 48%,rgba(52,211,153,.055) 100%);' +
  'border-radius:16px 16px 0 0;' +
  'border-bottom:1px solid ' + C.border + ';cursor:move;user-select:none;' +
  'position:relative;overflow:hidden;}' +
  '#anu-header::before{content:"";position:absolute;inset:0;' +
  'background:linear-gradient(90deg,transparent,rgba(255,255,255,0.03),transparent);' +
  'animation:anu-shimmer 8s ease infinite;background-size:200% 100%;}' +
  '#anu-header h3{margin:0;font-size:14px;font-weight:700;flex:1;letter-spacing:.15px;' +
  'display:flex;align-items:center;gap:9px;position:relative;z-index:1;}' +
  '#anu-header h3 .anu-logo-text{background:linear-gradient(135deg,' + C.accent + ',' + C.purple + ');' +
  '-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}' +
  '#anu-header h3 .anu-logo-icon{display:flex;align-items:center;justify-content:center;' +
  'width:30px;height:30px;border-radius:10px;font-size:15px;line-height:1;' +
  'background:linear-gradient(135deg,rgba(130,148,255,.25),rgba(182,156,255,.18));' +
  'border:1px solid rgba(190,201,255,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 5px 16px rgba(92,102,220,.16);}' +
  '#anu-header h3 .anu-logo-icon svg{color:' + C.accent + ';}' +

  // Session badge
  '#anu-session{display:flex;align-items:center;gap:6px;font-size:11px;padding:5px 12px;' +
  'border-radius:99px;cursor:pointer;position:relative;z-index:1;' +
  'border:1px solid transparent;font-weight:600;letter-spacing:.3px;' +
  'transition:all .25s ease;backdrop-filter:blur(8px);}' +
  '#anu-session:hover{transform:translateY(-1px);filter:brightness(1.1);}' +
  '#anu-session:active{transform:scale(.96);}' +
  '#anu-session.ok{background:' + C.greenDim + ';color:#6ee7b7;border-color:rgba(52,211,153,0.15);}' +
  '#anu-session.ok .anu-ic{color:' + C.green + ';}' +
  '#anu-session.warn{background:' + C.amberDim + ';color:#fde68a;border-color:rgba(251,191,36,0.15);}' +
  '#anu-session.warn .anu-ic{color:' + C.amber + ';}' +
  '#anu-session.exp{background:' + C.redDim + ';color:#fca5a5;border-color:rgba(248,113,113,0.15);}' +
  '#anu-session.exp .anu-ic{color:' + C.red + ';animation:anu-pulse 1.5s infinite;}' +

  // Minimize button
  '#anu-min{display:flex;align-items:center;justify-content:center;position:relative;z-index:1;' +
  'background:rgba(255,255,255,0.04);border:1px solid ' + C.border + ';color:' + C.textMid + ';cursor:pointer;' +
  'width:28px;height:28px;border-radius:8px;padding:0;transition:all .2s ease;}' +
  '#anu-min:hover{color:' + C.text + ';background:rgba(255,255,255,0.08);border-color:' + C.borderLight + ';' +
  'transform:translateY(-1px);}' +

  // Body
  '#anu-body{display:flex;flex-direction:column;overflow:hidden;flex:1;}' +

  // Pathbar
  '#anu-pathbar{padding:9px 18px;font-size:11px;color:' + C.textMid + ';' +
  'border-bottom:1px solid ' + C.border + ';' +
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.2px;' +
  'display:flex;align-items:center;gap:6px;' +
  'background:rgba(255,255,255,0.01);}' +
  '#anu-pathbar .anu-path-icon{color:' + C.textDim + ';flex-shrink:0;}' +
  '#anu-pathbar b{color:' + C.accent + ';font-weight:600;}' +

  // Preview de anime (AniList)
  '#anu-anime-preview{display:flex;align-items:center;gap:10px;padding:9px 18px;' +
  'border-bottom:1px solid ' + C.border + ';text-decoration:none;color:inherit;' +
  'background:rgba(255,255,255,0.015);transition:background .2s ease;' +
  'animation:anu-fadeIn .3s ease;}' +
  '#anu-anime-preview:hover{background:rgba(255,255,255,0.04);}' +
  '#anu-anime-cover{width:34px;height:48px;object-fit:cover;border-radius:6px;flex-shrink:0;' +
  'box-shadow:0 3px 10px rgba(0,0,0,.35);background:rgba(255,255,255,0.05);}' +
  '.anu-anime-info{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}' +
  '#anu-anime-title{font-size:12px;font-weight:700;color:' + C.text + ';white-space:nowrap;' +
  'overflow:hidden;text-overflow:ellipsis;}' +
  '#anu-anime-meta{font-size:10.5px;color:' + C.textMid + ';white-space:nowrap;' +
  'overflow:hidden;text-overflow:ellipsis;}' +

  // Toolbar
  '#anu-toolbar{display:flex;flex-direction:column;gap:0;border-bottom:1px solid ' + C.border + ';}' +
  '#anu-toolbar-top,#anu-toolbar-bot{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;}' +
  '#anu-toolbar-bot{border-top:1px solid ' + C.borderSub + ';padding-top:8px;padding-bottom:8px;}' +
  '.anu-primary-actions{display:flex;flex:0 0 100%;flex-wrap:nowrap;gap:6px;align-items:center;}' +
  '.anu-selection-actions{display:flex;flex-wrap:nowrap;gap:6px;}' +
  '.anu-download-managers{display:flex;flex:0 0 100%;gap:6px;}' +

  // Buttons — premium glass
  '#anu-toolbar button{display:inline-flex;align-items:center;gap:6px;' +
  'padding:6px 14px;border-radius:9px;border:1px solid transparent;cursor:pointer;' +
  'font-family:inherit;font-size:12px;font-weight:600;letter-spacing:.2px;' +
  'transition:all .2s ease;position:relative;overflow:hidden;}' +
  '#anu-toolbar button::before{content:"";position:absolute;inset:0;opacity:0;' +
  'background:linear-gradient(135deg,rgba(255,255,255,0.1),transparent);transition:opacity .2s;}' +
  '#anu-toolbar button:hover:not(:disabled)::before{opacity:1;}' +
  '#anu-toolbar button:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.1);}' +
  '#anu-toolbar button:active:not(:disabled){transform:scale(.97);filter:brightness(.95);}' +
  '#anu-toolbar button:disabled{opacity:.25;cursor:not-allowed;filter:grayscale(.5);}' +
  '#anu-abdm-ctrl button{display:inline-flex;align-items:center;gap:6px;font-family:inherit;}' +

  // Button variants
  '#anu-panel .ab{background:linear-gradient(135deg,#5b7cff,#7c6cff);color:#fff;border-color:rgba(108,140,255,0.2);' +
  'box-shadow:0 2px 12px rgba(108,140,255,0.2);}' +
  '#anu-panel .ab:hover:not(:disabled){box-shadow:0 4px 20px rgba(108,140,255,0.35);}' +
  '#anu-panel .ag{background:linear-gradient(135deg,#10b981,#34d399);color:#fff;border-color:rgba(52,211,153,0.2);' +
  'box-shadow:0 2px 12px rgba(52,211,153,0.15);}' +
  '#anu-panel .ag:hover:not(:disabled){box-shadow:0 4px 20px rgba(52,211,153,0.3);}' +
  '#anu-panel .ar{background:linear-gradient(135deg,#ef4444,#f87171);color:#fff;border-color:rgba(248,113,113,0.2);' +
  'box-shadow:0 2px 12px rgba(248,113,113,0.15);}' +
  '#anu-panel .ar:hover:not(:disabled){box-shadow:0 4px 20px rgba(248,113,113,0.3);}' +
  '#anu-panel .ay{background:linear-gradient(135deg,#d97706,#f59e0b);color:#fff;border-color:rgba(251,191,36,0.2);' +
  'box-shadow:0 2px 12px rgba(251,191,36,0.12);}' +
  '#anu-panel .ay:hover:not(:disabled){box-shadow:0 4px 20px rgba(251,191,36,0.25);}' +
  '#anu-panel .agr{background:rgba(255,255,255,0.04);color:' + C.text + ';' +
  'border:1px solid ' + C.border + ';backdrop-filter:blur(4px);}' +
  '#anu-panel .agr:hover:not(:disabled){background:rgba(255,255,255,0.07);border-color:' + C.borderLight + ';}' +
  '#anu-panel .am{background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;border-color:rgba(167,139,250,0.2);' +
  'box-shadow:0 2px 12px rgba(167,139,250,0.15);}' +
  '#anu-panel .am:hover:not(:disabled){box-shadow:0 4px 20px rgba(167,139,250,0.3);}' +

  // ABDM / IDM labels
  '#anu-abdm-label,#anu-idm-label{display:flex;align-items:center;gap:8px;font-size:12px;' +
  'color:' + C.text + ';cursor:pointer;padding:6px 12px;font-weight:500;' +
  'background:rgba(255,255,255,0.03);border-radius:9px;border:1px solid ' + C.border + ';' +
  'white-space:nowrap;transition:all .2s ease;backdrop-filter:blur(4px);}' +
  '#anu-abdm-label:hover,#anu-idm-label:hover{border-color:' + C.borderLight + ';background:rgba(255,255,255,0.06);}' +
  '#anu-abdm-label:has(input:checked),#anu-idm-label:has(input:checked){' +
  'background:' + C.accentDim + ';border-color:rgba(108,140,255,0.3);color:' + C.accentLight + ';}' +

  // Toggle switch — pill with sliding knob
  '.anu-switch{position:relative;display:inline-flex;flex-shrink:0;width:30px;height:17px;}' +
  '.anu-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:1;width:100%;height:100%;}' +
  '.anu-switch-track{position:absolute;inset:0;border-radius:99px;' +
  'background:rgba(255,255,255,0.12);border:1px solid ' + C.border + ';transition:all .25s ease;}' +
  '.anu-switch-track::after{content:"";position:absolute;top:1px;left:1px;width:13px;height:13px;' +
  'border-radius:50%;background:#c7cede;transition:all .25s cubic-bezier(.4,0,.2,1);' +
  'box-shadow:0 1px 3px rgba(0,0,0,.4);}' +
  '.anu-switch input:checked ~ .anu-switch-track{background:linear-gradient(135deg,#5b7cff,#7c6cff);' +
  'border-color:transparent;}' +
  '.anu-switch input:checked ~ .anu-switch-track::after{transform:translateX(13px);background:#fff;}' +
  '.anu-switch input:focus-visible ~ .anu-switch-track{box-shadow:0 0 0 3px ' + C.accentDim + ';}' +

  // Extension filter
  '#anu-filter{display:flex;gap:8px;align-items:center;padding:8px 16px;' +
  'border-bottom:1px solid ' + C.border + ';}' +
  '#anu-filter label{font-size:11px;color:' + C.textMid + ';white-space:nowrap;font-weight:600;' +
  'display:flex;align-items:center;gap:5px;}' +
  '#anu-filter input{flex:1;background:' + C.bgInput + ';border:1px solid ' + C.border + ';' +
  'color:' + C.text + ';border-radius:8px;padding:6px 12px;font-size:12px;font-family:inherit;outline:none;' +
  'transition:all .2s ease;backdrop-filter:blur(4px);}' +
  '#anu-filter input:focus{border-color:' + C.accent + ';box-shadow:0 0 0 3px ' + C.accentDim + ';}' +
  '#anu-filter input::placeholder{color:' + C.textDim + ';}' +

  // ABDM config
  '#anu-abdm-cfg{display:none;flex-wrap:wrap;gap:6px;align-items:center;' +
  'padding:10px 16px;border-bottom:1px solid ' + C.border + ';' +
  'background:rgba(108,140,255,0.02);}' +
  '#anu-abdm-cfg .anu-cfg-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:100%;}' +
  '#anu-abdm-cfg label{font-size:11px;color:' + C.textMid + ';white-space:nowrap;font-weight:600;}' +
  '#anu-abdm-cfg input,#anu-abdm-cfg select{background:' + C.bgInput + ';' +
  'border:1px solid ' + C.border + ';color:' + C.text + ';font-family:inherit;' +
  'border-radius:7px;padding:5px 10px;font-size:12px;outline:none;transition:border-color .2s;}' +
  '#anu-abdm-cfg input:focus,#anu-abdm-cfg select:focus{border-color:' + C.accent + ';}' +

  // ABDM controls
  '#anu-abdm-ctrl{display:none;gap:7px;align-items:center;' +
  'padding:8px 16px;border-bottom:1px solid ' + C.border + ';' +
  'background:rgba(108,140,255,0.02);}' +
  '#anu-abdm-ctrl button{padding:6px 14px;border-radius:9px;border:none;font-family:inherit;' +
  'cursor:pointer;font-size:12px;font-weight:600;transition:all .2s ease;}' +
  '#anu-abdm-ctrl button:hover{filter:brightness(1.15);transform:translateY(-1px);}' +

  // Stats bar
  '#anu-stats{display:flex;gap:14px;padding:8px 18px;font-size:11px;' +
  'color:' + C.textMid + ';border-bottom:1px solid ' + C.border + ';flex-wrap:wrap;' +
  'background:rgba(255,255,255,0.01);}' +
  '#anu-stats span{display:flex;align-items:center;gap:5px;}' +
  '#anu-stats .anu-stat-icon{opacity:.5;flex-shrink:0;}' +
  '#anu-stats b{color:' + C.text + ';font-weight:700;}' +

  // Progress bar — animated shimmer
  '#anu-prog{height:3px;background:' + C.borderSub + ';position:relative;overflow:hidden;}' +
  '#anu-fill{height:3px;width:0%;transition:width .5s cubic-bezier(.4,0,.2,1);position:relative;' +
  'background:linear-gradient(90deg,' + C.accent + ',#818cf8,' + C.purple + ');' +
  'border-radius:0 2px 2px 0;}' +
  '#anu-fill::after{content:"";position:absolute;inset:0;' +
  'background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent);' +
  'animation:anu-shimmer 2s ease infinite;background-size:200% 100%;}' +
  '#anu-fill.anu-done{background:linear-gradient(90deg,' + C.green + ',' + C.green + ');}' +

  // File list
  '#anu-list{overflow-y:auto;overflow-x:hidden;flex:1;min-width:0;min-height:60px;max-height:260px;}' +
  '#anu-list::-webkit-scrollbar{width:5px;}' +
  '#anu-list::-webkit-scrollbar-track{background:transparent;}' +
  '#anu-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:99px;}' +
  '#anu-list::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.14);}' +

  // File row
  '.anu-row{display:flex;align-items:center;gap:10px;padding:7px 16px;' +
  'border-bottom:1px solid ' + C.borderSub + ';cursor:pointer;border-left:2px solid transparent;' +
  'transition:all .15s ease;animation:anu-fadeIn .3s ease both;}' +
  '.anu-row:hover{background:' + C.bgRowHov + ';}' +
  '.anu-row:has(input[type=checkbox]:checked){background:rgba(108,140,255,0.05);' +
  'border-left-color:' + C.accent + ';}' +
  '.anu-row:has(input[type=checkbox]:checked):hover{background:rgba(108,140,255,0.09);}' +
  '.anu-row input[type=checkbox]{flex-shrink:0;accent-color:' + C.accent + ';cursor:pointer;' +
  'width:15px;height:15px;border-radius:4px;}' +

  // File icon
  '.anu-ficon{display:flex;align-items:center;justify-content:center;flex-shrink:0;' +
  'width:28px;height:28px;border-radius:7px;transition:all .15s ease;}' +
  '.anu-ficon svg{width:15px;height:15px;}' +
  '.anu-ficon-folder{background:rgba(108,140,255,0.1);color:' + C.accent + ';border:1px solid rgba(108,140,255,0.12);}' +
  '.anu-ficon-video{background:rgba(167,139,250,0.1);color:' + C.purple + ';border:1px solid rgba(167,139,250,0.12);}' +
  '.anu-ficon-audio{background:rgba(251,191,36,0.1);color:' + C.amber + ';border:1px solid rgba(251,191,36,0.12);}' +
  '.anu-ficon-sub{background:rgba(52,211,153,0.1);color:' + C.green + ';border:1px solid rgba(52,211,153,0.12);}' +
  '.anu-ficon-img{background:rgba(244,114,182,0.1);color:#f472b6;border:1px solid rgba(244,114,182,0.12);}' +
  '.anu-ficon-archive{background:rgba(251,191,36,0.1);color:#f59e0b;border:1px solid rgba(251,191,36,0.12);}' +
  '.anu-ficon-doc{background:rgba(96,165,250,0.1);color:#60a5fa;border:1px solid rgba(96,165,250,0.12);}' +
  '.anu-ficon-default{background:rgba(255,255,255,0.04);color:' + C.textMid + ';border:1px solid ' + C.border + ';}' +
  '.anu-row:hover .anu-ficon{transform:scale(1.05);}' +

  // File name & size
  '.anu-fn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;' +
  'color:' + C.text + ';font-weight:500;}' +
  '.anu-fs{font-size:11px;color:' + C.textMid + ';white-space:nowrap;flex-shrink:0;font-weight:500;' +
  'background:rgba(255,255,255,0.03);padding:2px 8px;border-radius:6px;border:1px solid ' + C.borderSub + ';}' +

  // Badges — glass effect
  '.anu-bx{font-size:10px;padding:3px 9px;border-radius:99px;white-space:nowrap;' +
  'flex-shrink:0;font-weight:600;letter-spacing:.3px;' +
  'backdrop-filter:blur(4px);border:1px solid transparent;' +
  'animation:anu-badgePop .25s ease both;}' +
  '#anu-panel .bp{background:' + C.accentDim + ';color:#93c5fd;border-color:rgba(108,140,255,0.1);}' +
  '#anu-panel .bd{background:' + C.greenDim + ';color:#6ee7b7;border-color:rgba(52,211,153,0.15);}' +
  '#anu-panel .be{background:' + C.redDim + ';color:#fca5a5;border-color:rgba(248,113,113,0.15);}' +
  '#anu-panel .bu{background:rgba(251,191,36,0.11);color:#fde68a;border-color:rgba(251,191,36,0.2);}' +
  '#anu-panel .ba{background:' + C.amberDim + ';color:#fde68a;border-color:rgba(251,191,36,0.15);' +
  'animation:anu-badgePop .25s ease both,anu-pulse 2s ease infinite;}' +
  '#anu-panel .bf{background:rgba(255,255,255,0.03);color:' + C.textMid + ';border-color:' + C.border + ';}' +

  // Single download button
  '.anu-dl-one{display:inline-flex;align-items:center;justify-content:center;' +
  'flex-shrink:0;background:' + C.accentDim + ';color:' + C.accentLight + ';border:1px solid rgba(108,140,255,0.12);' +
  'border-radius:7px;padding:5px 8px;font-size:11px;font-weight:600;cursor:pointer;' +
  'transition:all .2s ease;}' +
  '.anu-dl-one:hover{background:linear-gradient(135deg,#5b7cff,#7c6cff);color:#fff;' +
  'border-color:rgba(108,140,255,0.3);box-shadow:0 2px 12px rgba(108,140,255,0.25);transform:translateY(-1px);}' +
  '.anu-dl-one:active{transform:scale(.95);}' +

  // Console/log
  '#anu-log{min-height:60px;height:88px;max-height:300px;overflow-y:auto;' +
  'background:' + C.bgLog + ';padding:8px 14px;' +
  'font-family:"JetBrains Mono","Cascadia Code",Consolas,monospace;font-size:11px;color:' + C.textMid + ';' +
  'border-top:1px solid ' + C.border + ';flex-shrink:0;line-height:1.7;}' +
  '#anu-log::-webkit-scrollbar{width:4px;}' +
  '#anu-log::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.06);border-radius:99px;}' +
  '#anu-log div{padding:1px 0;border-bottom:1px solid rgba(255,255,255,0.02);}' +
  '#anu-panel .lok{color:' + C.green + ';}' +
  '#anu-panel .lerr{color:' + C.red + ';}' +
  '#anu-panel .linf{color:' + C.accent + ';}' +
  '#anu-panel .lwrn{color:' + C.amber + ';}' +

  // Footer
  '#anu-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
  'padding:7px 12px 7px 10px;font-size:10px;color:' + C.textDim + ';' +
  'border-radius:0 0 16px 16px;' +
  'background:linear-gradient(135deg,rgba(108,140,255,0.03),rgba(167,139,250,0.02));' +
  'border-top:1px solid ' + C.border + ';letter-spacing:.3px;}' +
  '#anu-footer-credit{flex:1;text-align:right;font-weight:500;}' +
  '#anu-console-toggle{display:flex;align-items:center;justify-content:center;' +
  'flex-shrink:0;width:26px;height:26px;border-radius:7px;border:1px solid ' + C.border + ';cursor:pointer;' +
  'background:rgba(255,255,255,0.03);color:' + C.textMid + ';padding:0;transition:all .2s ease;}' +
  '#anu-console-toggle:hover{color:' + C.text + ';background:rgba(255,255,255,0.07);border-color:' + C.borderLight + ';}' +
  '#anu-console-toggle.anu-off{color:' + C.textDim + ';}' +
  '#anu-log.anu-hidden{display:none;}' +

  // Finishing layer — denser app-like hierarchy and keyboard accessibility
  '#anu-toolbar{background:linear-gradient(180deg,rgba(255,255,255,.018),transparent);}' +
  '#anu-toolbar-top,#anu-toolbar-bot{padding-left:18px;padding-right:18px;gap:7px;}' +
  '#anu-toolbar-top{padding-top:12px;padding-bottom:9px;}' +
  '#anu-toolbar-bot{padding-top:9px;padding-bottom:10px;background:rgba(4,6,14,.13);}' +
  '#anu-toolbar button{min-height:32px;border-radius:10px;padding:7px 13px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}' +
  '#anu-toolbar-top button{white-space:nowrap;}#b-load{padding-left:10px;padding-right:10px;}#b-recurse{padding-left:8px;padding-right:8px;font-size:11px;}#b-all,#b-none{gap:5px;padding-left:9px;padding-right:9px;font-size:11px;}' +
  '#anu-panel .agr{background:rgba(255,255,255,.045);}' +
  '#anu-abdm-label,#anu-idm-label{min-height:32px;border-radius:10px;padding:6px 11px;background:rgba(255,255,255,.035);}' +
  '#anu-filter{padding:10px 18px;background:rgba(255,255,255,.012);}' +
  '#anu-filter input{min-height:32px;border-radius:10px;padding:7px 12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.035);}' +
  '#anu-filter input:focus{box-shadow:0 0 0 3px ' + C.accentDim + ',inset 0 1px 0 rgba(255,255,255,.05);}' +
  '#anu-stats{gap:7px 10px;padding:9px 18px;background:rgba(7,9,17,.22);}' +
  '#anu-stats span{padding:3px 6px;border-radius:6px;}' +
  '#anu-stats span:hover{background:rgba(255,255,255,.035);}' +
  '#anu-prog{height:4px;background:rgba(130,148,255,.08);}' +
  '#anu-fill{height:4px;box-shadow:0 0 14px rgba(130,148,255,.65);}' +
  '#anu-list{background:linear-gradient(180deg,rgba(255,255,255,.012),transparent 28%);}' +
  '.anu-row{min-height:45px;padding:8px 18px;border-left-width:3px;}' +
  '.anu-row:hover{box-shadow:inset 0 1px 0 rgba(255,255,255,.025),inset 0 -1px 0 rgba(255,255,255,.02);}' +
  '.anu-row:has(input[type=checkbox]:checked){box-shadow:inset 0 1px 0 rgba(174,186,255,.08),0 0 20px rgba(99,102,241,.035);}' +
  '.anu-ficon{width:30px;height:30px;border-radius:9px;}' +
  '.anu-fn{font-weight:550;letter-spacing:.05px;}' +
  '.anu-fs{padding:3px 8px;background:rgba(255,255,255,.045);}' +
  '.anu-bx{padding:4px 9px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06);}' +
  '#anu-log{background:linear-gradient(180deg,rgba(6,8,16,.60),rgba(6,8,16,.88));padding:9px 14px;}' +
  '#anu-footer{padding:8px 12px 8px 10px;background:linear-gradient(110deg,rgba(130,148,255,.075),rgba(182,156,255,.035) 56%,rgba(52,211,153,.03));}' +
  '#anu-console-toggle{border-radius:9px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}' +
  '#anu-panel button:focus-visible,#anu-panel input:focus-visible,#anu-panel select:focus-visible{outline:2px solid ' + C.accentLight + ';outline-offset:2px;}' +
  '@media (max-width:560px){#anu-panel{right:8px;bottom:8px;width:calc(100vw - 16px);min-width:0;max-height:calc(100vh - 16px);}#anu-header{padding:13px 14px;}#anu-toolbar-top,#anu-toolbar-bot,#anu-filter,#anu-stats{padding-left:14px;padding-right:14px;}}' +
  '@media (prefers-reduced-motion:reduce){#anu-panel,#anu-toolbar button,.anu-row,.anu-ficon,#anu-session{transition:none!important;animation:none!important;}}' +

  // Empty state
  '.anu-empty{padding:28px 18px;text-align:center;font-size:12px;color:' + C.textDim + ';' +
  'display:flex;flex-direction:column;align-items:center;gap:10px;}' +
  '.anu-empty .anu-empty-icon{opacity:.3;}' +

  // Skeleton loading rows
  '.anu-skel-row{display:flex;align-items:center;gap:10px;padding:7px 16px;' +
  'border-bottom:1px solid ' + C.borderSub + ';}' +
  '.anu-skel{position:relative;overflow:hidden;border-radius:6px;' +
  'background:rgba(255,255,255,0.04);flex-shrink:0;}' +
  '.anu-skel::after{content:"";position:absolute;inset:0;' +
  'background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);' +
  'animation:anu-shimmer 1.4s ease infinite;background-size:200% 100%;}' +
  '.anu-skel-box{width:15px;height:15px;border-radius:4px;}' +
  '.anu-skel-icon{width:28px;height:28px;border-radius:7px;}' +
  '.anu-skel-line{height:11px;border-radius:5px;}' +
  '.anu-skel-chip{width:52px;height:18px;border-radius:99px;margin-left:auto;}' +

  // Custom tooltip — replaces native title styling for key controls
  '#anu-panel [data-tip]{position:relative;}' +
  '#anu-panel [data-tip]::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;' +
  'transform:translateX(-50%) translateY(4px);white-space:nowrap;pointer-events:none;' +
  'background:#1a1d28;color:' + C.text + ';font-size:11px;font-weight:500;font-family:"Inter",sans-serif;' +
  'padding:6px 10px;border-radius:7px;border:1px solid ' + C.borderLight + ';' +
  'box-shadow:0 8px 24px rgba(0,0,0,.5);opacity:0;visibility:hidden;' +
  'transition:opacity .15s ease,transform .15s ease;z-index:100;letter-spacing:.2px;}' +
  '#anu-panel [data-tip]::before{content:"";position:absolute;bottom:100%;left:50%;transform:translateX(-50%) translateY(2px);' +
  'border:5px solid transparent;border-top-color:#1a1d28;opacity:0;visibility:hidden;' +
  'transition:opacity .15s ease;pointer-events:none;z-index:100;}' +
  '#anu-panel [data-tip]:hover::after,#anu-panel [data-tip]:hover::before{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0);}' +
  '.anu-dl-one[data-tip]::after{left:auto;right:0;transform:translateY(4px);}' +
  '.anu-dl-one[data-tip]::before{left:auto;right:7px;transform:translateY(2px);}' +
  '.anu-dl-one[data-tip]:hover::after,.anu-dl-one[data-tip]:hover::before{transform:translateY(0);}'
);

// ─── Interface 2.0 — Aurora Control Center ────────────────────────────────────
// Esta camada é totalmente escopada ao painel para não alterar o site hospedeiro.
GM_addStyle(`
  #anu-panel,
  #anu-panel * {
    box-sizing: border-box;
  }

  #anu-panel .anu-sr-only {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    padding: 0 !important;
    margin: -1px !important;
    overflow: hidden !important;
    clip-path: inset(50%) !important;
    white-space: nowrap !important;
    border: 0 !important;
  }

  #anu-panel {
    --anu-surface: #0d1324;
    --anu-surface-2: #121a2e;
    --anu-surface-3: #172138;
    --anu-elevated: #1b2740;
    --anu-line: rgba(162, 180, 222, .13);
    --anu-line-strong: rgba(169, 187, 232, .24);
    --anu-text: #f7f9ff;
    --anu-muted: #aeb9d2;
    --anu-subtle: #7f8aa6;
    --anu-accent: #8b8cff;
    --anu-accent-strong: #716fff;
    --anu-accent-soft: rgba(139, 140, 255, .14);
    --anu-cyan: #38d6c6;
    --anu-success: #52d49b;
    --anu-warning: #ffc75b;
    --anu-danger: #ff7589;
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 99999;
    width: min(610px, calc(100vw - 36px));
    min-width: min(420px, calc(100vw - 16px));
    max-width: calc(100vw - 16px);
    max-height: calc(100dvh - 36px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    resize: horizontal;
    color: var(--anu-text);
    background:
      radial-gradient(110% 70% at 6% -8%, rgba(113, 111, 255, .22), transparent 55%),
      radial-gradient(80% 55% at 100% 0%, rgba(56, 214, 198, .10), transparent 58%),
      var(--anu-surface);
    border: 1px solid var(--anu-line-strong);
    border-radius: 22px;
    box-shadow:
      0 28px 90px rgba(2, 6, 18, .66),
      0 8px 28px rgba(2, 6, 18, .34),
      inset 0 1px 0 rgba(255, 255, 255, .05);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.4;
    opacity: 0;
    transform: translateY(14px) scale(.98);
    transition: opacity .24s ease, transform .24s ease, box-shadow .24s ease;
  }

  #anu-panel.anu-mounted {
    opacity: 1;
    transform: none;
  }

  #anu-panel:hover {
    box-shadow:
      0 28px 90px rgba(2, 6, 18, .66),
      0 8px 28px rgba(2, 6, 18, .34),
      inset 0 1px 0 rgba(255, 255, 255, .05);
  }

  #anu-toolbar button::before {
    content: none;
  }

  #anu-panel.anu-minimised {
    resize: none;
  }

  #anu-panel button,
  #anu-panel input,
  #anu-panel select {
    font: inherit;
  }

  #anu-panel button {
    -webkit-tap-highlight-color: transparent;
  }

  #anu-header {
    min-height: 68px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px 12px 16px;
    overflow: visible;
    flex: 0 0 auto;
    cursor: grab;
    touch-action: none;
    user-select: none;
    border-radius: 21px 21px 0 0;
    border-bottom: 1px solid var(--anu-line);
    background: rgba(15, 23, 42, .72);
    backdrop-filter: blur(22px) saturate(1.18);
    -webkit-backdrop-filter: blur(22px) saturate(1.18);
  }

  #anu-header:active {
    cursor: grabbing;
  }

  #anu-header::before {
    display: none;
  }

  #anu-header h3,
  #anu-header .anu-brand {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 11px;
    margin: 0;
  }

  #anu-header h3 .anu-logo-icon {
    width: 40px;
    height: 40px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 40px;
    color: #fff;
    background: linear-gradient(145deg, #9b8cff 0%, #6f79ff 52%, #3ccfc1 120%);
    border: 1px solid rgba(255, 255, 255, .2);
    border-radius: 13px;
    box-shadow: 0 8px 24px rgba(101, 104, 255, .28), inset 0 1px 0 rgba(255,255,255,.28);
  }

  #anu-header h3 .anu-logo-icon svg {
    width: 20px;
    height: 20px;
    color: currentColor;
  }

  .anu-brand-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  #anu-header h3 .anu-logo-text {
    overflow: hidden;
    color: var(--anu-text);
    background: none;
    -webkit-text-fill-color: currentColor;
    font-size: 14px;
    font-weight: 750;
    line-height: 1.2;
    letter-spacing: -.15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .anu-brand-subtitle {
    color: var(--anu-subtle);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .anu-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  #anu-session {
    min-height: 38px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px;
    border: 1px solid var(--anu-line);
    border-radius: 12px;
    cursor: pointer;
    color: var(--anu-muted);
    background: rgba(255, 255, 255, .035);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04);
    transition: border-color .16s ease, background .16s ease, transform .16s ease;
  }

  #anu-session:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: var(--anu-line-strong);
    background: rgba(255, 255, 255, .065);
  }

  #anu-session:disabled {
    cursor: wait;
    opacity: .82;
  }

  #anu-session .anu-session-copy {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
    line-height: 1.15;
  }

  #anu-session .anu-session-label {
    color: var(--anu-subtle);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  #anu-session-txt {
    color: currentColor;
    font-size: 11px;
    font-weight: 750;
    white-space: nowrap;
  }

  #anu-session.ok { color: var(--anu-success); border-color: rgba(82, 212, 155, .22); }
  #anu-session.warn { color: var(--anu-warning); border-color: rgba(255, 199, 91, .26); }
  #anu-session.exp { color: var(--anu-danger); border-color: rgba(255, 117, 137, .24); }
  #anu-session.anu-refreshing { color: var(--anu-accent); border-color: rgba(139, 140, 255, .3); }
  #anu-session.anu-refreshing .anu-ic { animation: anu-spin .9s linear infinite; }

  #anu-min,
  #anu-console-toggle {
    width: 38px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 38px;
    padding: 0;
    cursor: pointer;
    color: var(--anu-muted);
    border: 1px solid var(--anu-line);
    border-radius: 12px;
    background: rgba(255, 255, 255, .035);
    transition: color .16s ease, background .16s ease, border-color .16s ease, transform .16s ease;
  }

  #anu-min:hover,
  #anu-console-toggle:hover {
    color: var(--anu-text);
    background: rgba(255, 255, 255, .07);
    border-color: var(--anu-line-strong);
    transform: translateY(-1px);
  }

  #anu-body {
    min-height: 0;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(174, 188, 225, .2) transparent;
  }

  #anu-body::-webkit-scrollbar,
  #anu-list::-webkit-scrollbar,
  #anu-log::-webkit-scrollbar { width: 6px; }
  #anu-body::-webkit-scrollbar-thumb,
  #anu-list::-webkit-scrollbar-thumb,
  #anu-log::-webkit-scrollbar-thumb {
    background: rgba(174, 188, 225, .18);
    border-radius: 99px;
  }

  .anu-context-card {
    margin: 12px 12px 0;
    overflow: hidden;
    flex: 0 0 auto;
    border: 1px solid var(--anu-line);
    border-radius: 15px;
    background: linear-gradient(135deg, rgba(139, 140, 255, .09), rgba(56, 214, 198, .035));
  }

  #anu-pathbar {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 13px;
    border: 0;
    background: transparent;
  }

  #anu-pathbar .anu-path-icon {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 30px;
    color: var(--anu-accent);
    border: 1px solid rgba(139, 140, 255, .18);
    border-radius: 9px;
    background: var(--anu-accent-soft);
  }

  .anu-path-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .anu-eyebrow {
    color: var(--anu-subtle);
    font-size: 9.5px;
    font-weight: 750;
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  #anu-pathbar b {
    overflow: hidden;
    color: var(--anu-text);
    font-size: 12px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  #anu-anime-preview {
    min-height: 66px;
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 9px 12px;
    color: inherit;
    text-decoration: none;
    border: 0;
    border-top: 1px solid var(--anu-line);
    background: rgba(2, 6, 18, .14);
  }

  #anu-anime-preview:hover {
    background: rgba(139, 140, 255, .07);
  }

  #anu-anime-cover {
    width: 36px;
    height: 50px;
    flex: 0 0 36px;
    object-fit: cover;
    border: 1px solid var(--anu-line);
    border-radius: 8px;
    background: var(--anu-surface-3);
    box-shadow: 0 6px 14px rgba(0, 0, 0, .28);
  }

  #anu-anime-title {
    color: var(--anu-text);
    font-size: 12px;
    font-weight: 720;
  }

  #anu-anime-meta {
    color: var(--anu-muted);
    font-size: 10.5px;
  }

  #anu-toolbar {
    flex: 0 0 auto;
    border: 0;
    background: transparent;
  }

  #anu-toolbar-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 13px 12px 9px;
  }

  .anu-section-title {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .anu-section-title strong {
    color: var(--anu-text);
    font-size: 12px;
    font-weight: 730;
  }

  .anu-section-title span {
    color: var(--anu-subtle);
    font-size: 10.5px;
  }

  .anu-primary-actions,
  .anu-selection-actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 6px;
  }

  #anu-panel button.ab,
  #anu-panel button.ag,
  #anu-panel button.ar,
  #anu-panel button.ay,
  #anu-panel button.agr,
  #anu-panel button.am,
  #anu-abdm-ctrl button {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 10px;
    color: var(--anu-muted);
    border: 1px solid var(--anu-line);
    border-radius: 10px;
    background: rgba(255, 255, 255, .035);
    box-shadow: none;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0;
    cursor: pointer;
    transition: transform .15s ease, color .15s ease, background .15s ease, border-color .15s ease;
  }

  #anu-panel button:hover:not(:disabled) {
    filter: none;
  }

  #anu-panel button.ab:hover:not(:disabled),
  #anu-panel button.agr:hover:not(:disabled),
  #anu-panel button.am:hover:not(:disabled) {
    color: var(--anu-text);
    border-color: var(--anu-line-strong);
    background: rgba(255, 255, 255, .07);
    box-shadow: none;
    transform: translateY(-1px);
  }

  #anu-panel button.ag {
    min-height: 42px;
    color: #fff;
    border-color: rgba(162, 163, 255, .45);
    background: linear-gradient(135deg, #5752d6, #713fd0);
    box-shadow: 0 10px 25px rgba(112, 89, 255, .25), inset 0 1px 0 rgba(255,255,255,.2);
  }

  #anu-panel button.ag:hover:not(:disabled) {
    color: #fff;
    border-color: rgba(197, 188, 255, .65);
    background: linear-gradient(135deg, #625ddd, #7a4bd7);
    box-shadow: 0 13px 30px rgba(112, 89, 255, .34);
    transform: translateY(-1px);
  }

  #anu-panel button.ar {
    color: #ff9aaa;
    border-color: rgba(255, 117, 137, .22);
    background: rgba(255, 117, 137, .08);
  }

  #anu-panel button.ar:hover:not(:disabled) {
    color: #ffc0c9;
    border-color: rgba(255, 117, 137, .4);
    background: rgba(255, 117, 137, .14);
    transform: translateY(-1px);
  }

  #anu-panel button.ay {
    color: var(--anu-warning);
    border-color: rgba(255, 199, 91, .22);
    background: rgba(255, 199, 91, .08);
  }

  #anu-panel button:disabled,
  #anu-panel input:disabled,
  #anu-panel select:disabled {
    cursor: not-allowed;
    opacity: .4;
    transform: none;
  }

  #anu-filter {
    display: flex;
    align-items: end;
    gap: 8px;
    padding: 0 12px 10px;
    border: 0;
  }

  .anu-field {
    min-width: 0;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 5px;
  }

  #anu-panel label,
  #anu-filter label,
  #anu-abdm-cfg label {
    color: var(--anu-muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .02em;
  }

  #anu-panel input[type="text"],
  #anu-panel input[type="number"],
  #anu-panel select,
  #anu-filter input,
  #anu-abdm-cfg input,
  #anu-abdm-cfg select {
    width: 100%;
    min-height: 38px;
    padding: 8px 10px;
    color: var(--anu-text);
    caret-color: var(--anu-accent);
    border: 1px solid var(--anu-line);
    border-radius: 10px;
    outline: 0;
    background: rgba(4, 9, 22, .54);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
    font-size: 11.5px;
    transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
  }

  #anu-panel input::placeholder {
    color: #69758f;
  }

  #anu-panel input:focus,
  #anu-panel select:focus {
    border-color: rgba(139, 140, 255, .65);
    background: rgba(8, 13, 29, .8);
    box-shadow: 0 0 0 3px rgba(139, 140, 255, .13);
  }

  #anu-stats {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 6px;
    padding: 0 12px 10px;
    color: inherit;
    border: 0;
    background: transparent;
  }

  #anu-stats .anu-stat {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 8px 9px;
    border: 1px solid var(--anu-line);
    border-radius: 11px;
    background: rgba(255, 255, 255, .026);
  }

  #anu-stats .anu-stat-label {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 5px;
    overflow: hidden;
    color: var(--anu-subtle);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .05em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  #anu-stats .anu-stat b {
    max-width: 100%;
    overflow: hidden;
    color: var(--anu-text);
    font-size: 12px;
    font-weight: 750;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  #anu-prog {
    height: 5px;
    margin: 0 12px 8px;
    overflow: hidden;
    border-radius: 99px;
    background: rgba(139, 140, 255, .09);
  }

  #anu-fill {
    height: 100%;
    width: 0;
    overflow: hidden;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--anu-accent-strong), #a45cff, var(--anu-cyan));
    box-shadow: none;
    transition: width .3s ease;
  }

  #anu-fill::after {
    display: none;
  }

  #anu-fill.anu-done {
    background: var(--anu-success);
  }

  #anu-list {
    min-height: 150px;
    max-height: 310px;
    margin: 0 12px;
    overflow: auto;
    flex: 1 1 220px;
    border: 1px solid var(--anu-line);
    border-radius: 14px;
    background: rgba(3, 8, 20, .34);
    scrollbar-width: thin;
    scrollbar-color: rgba(174, 188, 225, .2) transparent;
  }

  #anu-list[aria-busy="true"] {
    cursor: progress;
  }

  .anu-row {
    min-height: 53px;
    display: grid;
    grid-template-columns: auto 34px minmax(0, 1fr) auto auto;
    grid-template-areas:
      "check icon name status action"
      "check icon meta status action";
    align-items: center;
    gap: 2px 10px;
    padding: 8px 10px;
    cursor: pointer;
    color: var(--anu-text);
    border: 0;
    border-left: 3px solid transparent;
    border-bottom: 1px solid rgba(162, 180, 222, .08);
    background: transparent;
    animation: anu-fadeIn .2s ease both;
    transition: background .14s ease, border-color .14s ease;
  }

  .anu-row:last-child {
    border-bottom: 0;
  }

  .anu-row:hover {
    background: rgba(139, 140, 255, .07);
  }

  .anu-row:focus-visible {
    outline: 2px solid var(--anu-accent);
    outline-offset: -2px;
  }

  .anu-row.anu-folder-row {
    grid-template-columns: 34px minmax(0, 1fr) auto;
    grid-template-areas: "icon name status";
  }

  .anu-row:has(input[type="checkbox"]:checked) {
    border-left-color: var(--anu-accent);
    background: rgba(139, 140, 255, .095);
    box-shadow: none;
  }

  .anu-row input[type="checkbox"] {
    grid-area: check;
    width: 17px;
    height: 17px;
    margin: 0;
    accent-color: var(--anu-accent-strong);
    cursor: pointer;
  }

  .anu-ficon {
    grid-area: icon;
    width: 34px;
    height: 34px;
    border-radius: 10px;
  }

  .anu-ficon svg {
    width: 16px;
    height: 16px;
  }

  .anu-ficon-folder { color: #a7a9ff; background: rgba(139,140,255,.12); border-color: rgba(139,140,255,.16); }
  .anu-ficon-video { color: #c39bff; background: rgba(177,114,255,.11); }
  .anu-ficon-audio { color: #ffd274; background: rgba(255,199,91,.10); }
  .anu-ficon-sub { color: #6be3ad; background: rgba(82,212,155,.10); }
  .anu-ficon-img { color: #ff9dcc; background: rgba(244,114,182,.10); }
  .anu-ficon-archive { color: #ffb97b; background: rgba(251,146,60,.10); }
  .anu-ficon-doc { color: #7fc4ff; background: rgba(96,165,250,.10); }
  .anu-ficon-default { color: var(--anu-muted); background: rgba(255,255,255,.04); }

  .anu-fn {
    grid-area: name;
    align-self: end;
    overflow: hidden;
    color: var(--anu-text);
    font-size: 12px;
    font-weight: 650;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .anu-fs {
    grid-area: meta;
    align-self: start;
    width: fit-content;
    padding: 0;
    color: var(--anu-subtle);
    border: 0;
    background: transparent;
    font-size: 10px;
    font-weight: 550;
  }

  .anu-bx {
    grid-area: status;
    align-self: center;
    padding: 4px 7px;
    border-radius: 8px;
    box-shadow: none;
    font-size: 9px;
    font-weight: 750;
    letter-spacing: .03em;
    text-transform: uppercase;
  }

  #anu-panel .bp { color: #b9bbff; background: rgba(139,140,255,.10); border-color: rgba(139,140,255,.15); }
  #anu-panel .bd { color: #74e6ae; background: rgba(82,212,155,.10); border-color: rgba(82,212,155,.17); }
  #anu-panel .be { color: #ff9cab; background: rgba(255,117,137,.10); border-color: rgba(255,117,137,.17); }
  #anu-panel .bu { color: #ffd477; background: rgba(255,199,91,.10); border-color: rgba(255,199,91,.19); }
  #anu-panel .ba { color: #ffd477; background: rgba(255,199,91,.10); border-color: rgba(255,199,91,.17); animation: none; }
  #anu-panel .bf { color: var(--anu-muted); background: rgba(255,255,255,.04); border-color: var(--anu-line); }

  .anu-dl-one {
    grid-area: action;
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    color: #b9bbff;
    cursor: pointer;
    border: 1px solid rgba(139,140,255,.17);
    border-radius: 10px;
    background: rgba(139,140,255,.09);
  }

  .anu-dl-one:hover:not(:disabled) {
    color: #fff;
    border-color: rgba(139,140,255,.42);
    background: var(--anu-accent-strong);
    box-shadow: none;
    transform: translateY(-1px);
  }

  .anu-empty {
    min-height: 148px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 9px;
    padding: 24px;
    color: var(--anu-subtle);
    text-align: center;
  }

  .anu-empty .anu-empty-icon {
    color: var(--anu-muted);
    opacity: .4;
  }

  .anu-empty.anu-error-state .anu-empty-icon {
    color: var(--anu-danger);
    opacity: .9;
  }

  .anu-transfer-card {
    margin: 10px 12px 0;
    overflow: hidden;
    flex: 0 0 auto;
    border: 1px solid var(--anu-line);
    border-radius: 15px;
    background: rgba(255, 255, 255, .022);
  }

  .anu-transfer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 11px 8px;
  }

  #anu-mode-selector {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    margin: 0 10px 10px;
    padding: 4px;
    border: 1px solid var(--anu-line);
    border-radius: 12px;
    background: rgba(2, 6, 18, .38);
  }

  .anu-mode-input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  #anu-mode-selector .anu-mode-option {
    min-width: 0;
    min-height: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 8px;
    color: var(--anu-subtle);
    border: 1px solid transparent;
    border-radius: 9px;
    cursor: pointer;
    font-size: 10.5px;
    font-weight: 750;
    transition: color .15s ease, background .15s ease, border-color .15s ease;
  }

  #anu-mode-selector .anu-mode-option:hover {
    color: var(--anu-text);
    background: rgba(255,255,255,.04);
  }

  #anu-mode-selector .anu-mode-input:checked + .anu-mode-option {
    color: #fff;
    border-color: rgba(154, 155, 255, .35);
    background: linear-gradient(135deg, #504bc5, #6736b8);
    box-shadow: 0 5px 16px rgba(91, 81, 210, .2), inset 0 1px 0 rgba(255,255,255,.16);
  }

  #anu-mode-selector .anu-mode-input:disabled + .anu-mode-option {
    opacity: .45;
    cursor: not-allowed;
  }

  #anu-mode-selector .anu-mode-input:disabled + .anu-mode-option:hover {
    color: var(--anu-subtle);
    background: transparent;
  }

  #anu-mode-selector .anu-mode-input:focus-visible + .anu-mode-option {
    outline: 2px solid var(--anu-accent);
    outline-offset: 2px;
  }

  #anu-abdm-cfg {
    display: none;
    grid-template-columns: 92px 76px 100px minmax(130px, 1fr);
    gap: 8px;
    padding: 10px;
    border: 0;
    border-top: 1px solid var(--anu-line);
    background: rgba(139, 140, 255, .035);
  }

  #anu-abdm-cfg .anu-cfg-row {
    display: contents;
  }

  #anu-abdm-cfg .anu-field-folder {
    grid-column: 1 / -1;
  }

  .anu-help {
    color: var(--anu-subtle);
    font-size: 9.5px;
    line-height: 1.35;
  }

  #anu-abdm-ctrl {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 10px;
    border: 0;
    border-top: 1px solid var(--anu-line);
    background: rgba(3, 8, 20, .2);
  }

  #anu-abdm-wait {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: var(--anu-warning);
    font-size: 10.5px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  #anu-live {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 12px 3px;
    color: var(--anu-muted);
    font-size: 10.5px;
  }

  #anu-live .anu-live-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 12%, transparent);
  }

  #anu-live-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  #anu-panel .lok { color: var(--anu-success); }
  #anu-panel .lerr { color: var(--anu-danger); }
  #anu-panel .linf { color: #aeb0ff; }
  #anu-panel .lwrn { color: var(--anu-warning); }

  #anu-toolbar-bot {
    position: sticky;
    bottom: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px 12px;
    border: 0;
    background: linear-gradient(180deg, rgba(13,19,36,0), var(--anu-surface) 22%);
  }

  #anu-toolbar-bot #b-dl {
    min-width: 0;
    flex: 1;
  }

  #anu-toolbar-bot #b-retry,
  #anu-toolbar-bot #b-stop {
    flex: 0 0 auto;
  }

  #anu-log {
    min-height: 76px;
    height: 100px;
    max-height: 210px;
    margin: 0 12px 10px;
    overflow: auto;
    padding: 8px 10px;
    color: var(--anu-muted);
    border: 1px solid var(--anu-line);
    border-radius: 12px;
    background: rgba(2, 6, 18, .48);
    font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
    font-size: 9.5px;
    line-height: 1.6;
  }

  #anu-log div {
    padding: 2px 0;
    border: 0;
    border-bottom: 1px solid rgba(162,180,222,.055);
  }

  #anu-log.anu-hidden {
    display: none;
  }

  #anu-footer {
    min-height: 42px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    flex: 0 0 auto;
    color: var(--anu-subtle);
    border: 0;
    border-top: 1px solid var(--anu-line);
    border-radius: 0 0 21px 21px;
    background: rgba(8, 13, 27, .84);
  }

  #anu-footer-credit {
    flex: 1;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9.5px;
    font-weight: 600;
  }

  .anu-console-label {
    color: var(--anu-muted);
    font-size: 10.5px;
    font-weight: 650;
  }

  #anu-panel [data-tip]::before,
  #anu-panel [data-tip]::after {
    display: none !important;
  }

  #anu-panel button:focus-visible,
  #anu-panel input:focus-visible,
  #anu-panel select:focus-visible,
  #anu-panel a:focus-visible {
    outline: 2px solid var(--anu-accent);
    outline-offset: 2px;
  }

  .anu-skel-row {
    min-height: 53px;
    padding: 9px 10px;
    border-bottom-color: rgba(162,180,222,.07);
  }

  .anu-skel {
    background: rgba(255,255,255,.045);
  }

  @media (max-width: 680px) {
    #anu-panel {
      top: auto !important;
      right: 8px !important;
      bottom: max(8px, env(safe-area-inset-bottom)) !important;
      left: auto !important;
      width: calc(100% - 16px) !important;
      min-width: 0;
      max-width: calc(100% - 16px);
      max-height: calc(100dvh - 16px - env(safe-area-inset-bottom));
      resize: none;
      border-radius: 18px;
    }

    #anu-header {
      min-height: 62px;
      padding: 10px;
      border-radius: 17px 17px 0 0;
    }

    #anu-header h3 .anu-logo-icon {
      width: 36px;
      height: 36px;
      flex-basis: 36px;
    }

    .anu-brand-subtitle,
    #anu-session .anu-session-label {
      display: none;
    }

    #anu-session {
      min-height: 36px;
      padding: 7px 9px;
    }

    #anu-min,
    #anu-console-toggle {
      width: 36px;
      height: 36px;
      flex-basis: 36px;
    }

    #anu-toolbar-top {
      align-items: flex-start;
      flex-direction: column;
    }

    .anu-primary-actions,
    .anu-selection-actions {
      width: 100%;
    }

    .anu-primary-actions button {
      min-height: 40px !important;
      flex: 1;
    }

    #anu-stats {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    #anu-stats .anu-stat:nth-child(4),
    #anu-stats .anu-stat:nth-child(5) {
      grid-column: span 1;
    }

    #anu-list {
      min-height: 180px;
      max-height: 42dvh;
    }

    .anu-row {
      grid-template-columns: auto 32px minmax(0, 1fr) auto;
      grid-template-areas:
        "check icon name action"
        "check icon meta action"
        "check icon status action";
      min-height: 70px;
    }

    .anu-row .anu-bx {
      display: inline-flex;
      justify-self: start;
    }

    .anu-row.anu-folder-row {
      grid-template-columns: 32px minmax(0, 1fr) auto;
      grid-template-areas: "icon name status";
    }

    .anu-row.anu-folder-row .anu-bx {
      display: inline-flex;
    }

    #anu-abdm-cfg {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    #anu-abdm-cfg .anu-field-folder,
    #anu-abdm-cfg .anu-field-queue {
      grid-column: 1 / -1;
    }

    #anu-toolbar-bot {
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }

    #anu-toolbar-bot #b-retry {
      font-size: 0;
    }

    #anu-toolbar-bot #b-retry .anu-ic {
      font-size: initial;
    }
  }

  @media (max-width: 420px) {
    #anu-header h3 .anu-logo-text {
      font-size: 13px;
    }

    #anu-session .anu-ic {
      display: none;
    }

    #anu-stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    #anu-stats .anu-stat:last-child {
      grid-column: 1 / -1;
    }

    #anu-mode-selector .anu-mode-option {
      min-height: 42px;
      padding: 7px 4px;
      font-size: 10px;
    }

    #anu-toolbar-bot {
      flex-wrap: wrap;
    }

    #anu-toolbar-bot #b-dl {
      order: -1;
      flex-basis: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    #anu-panel,
    #anu-panel *,
    #anu-panel *::before,
    #anu-panel *::after {
      scroll-behavior: auto !important;
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
    }
  }
`);

// ─── Ícones Premium (SVG inline Lucide-style) ─────────────────────────────────
const ICON = {
  // Logo — crystal/diamond shape
  logo: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2.7 10.3 2.334-2.774a1 1 0 0 1 .766-.356h12.4a1 1 0 0 1 .766.356L21.3 10.3a1 1 0 0 1 .03 1.256l-8.587 10.974a1 1 0 0 1-1.486 0L2.67 11.556a1 1 0 0 1 .03-1.256Z"/><path d="m10 2 2 5.2 2-5.2"/><path d="M2.7 10.3h18.6"/></svg>',

  // Reload — rotating arrows
  reload: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>',

  // Layers — stacked for recursive
  layers: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m2 12 8.58 3.91a2 2 0 0 0 1.66 0L21 12"/><path d="m2 17 8.58 3.91a2 2 0 0 0 1.66 0L21 17"/></svg>',

  // Select all — checkbox with check
  checkAll: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m9 12 2 2 4-4"/></svg>',

  // Uncheck — empty square
  square: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 9l6 6"/><path d="M15 9l-6 6"/></svg>',

  // Download — arrow with tray
  download: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',

  // Small download
  downloadSm: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',

  // Retry — refresh arrows
  retry: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>',

  // Stop
  stop: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',

  // Skip
  skip: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',

  // Eye open
  eyeOpen: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>',

  // Eye off
  eyeOff: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>',

  // Minimize
  minimize: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',

  // Expand
  expand: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',

  // Status dot
  pulse: '<svg viewBox="0 0 24 24" width="8" height="8" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',

  // Path/folder breadcrumb
  folderPath: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>',

  // Filter
  filter: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',

  // ─── File type icons ─────────────────────────────────────────────────────

  // Folder
  folder: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',

  // Video file (mkv, mp4, avi, etc.)
  video: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',

  // Audio file (mp3, flac, ogg, etc.)
  audio: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',

  // Subtitle file (ass, srt, sub, etc.)
  subtitle: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h4"/><path d="M15 15h2"/><path d="M7 11h2"/><path d="M13 11h4"/></svg>',

  // Image file (png, jpg, etc.)
  image: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',

  // Archive file (zip, rar, 7z, etc.)
  archive: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 22h2a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="10" cy="20" r="2"/><path d="M10 7V6"/><path d="M10 12v-1"/><path d="M10 18v-2"/></svg>',

  // Document / default file
  file: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',

  // Stats icons
  statFiles: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
  statSelected: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
  statDone: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  statFail: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
  statSize: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M2 15h10"/><path d="m9 18 3-3-3-3"/></svg>',

  // Empty state
  emptyBox: '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7.5v9l-4 2.25L12 21l-4-2.25L4 16.5v-9L8 5.25 12 3l4 2.25Z"/><path d="M12 12 4 7.5"/><path d="M12 12v9"/><path d="m12 12 8-4.5"/><path d="M16 5.25 8 9.5"/></svg>',
};

// ─── Mapeamento de extensões para ícones de arquivo ───────────────────────────
function getFileIcon(name) {
  const n = String(name || '').toLowerCase();
  // Video
  if (/\.(mkv|mp4|avi|wmv|mov|flv|webm|m4v|ts|m2ts|mpg|mpeg|ogv|3gp)$/i.test(n)) {
    return { icon: ICON.video, cls: 'anu-ficon-video' };
  }
  // Audio
  if (/\.(mp3|flac|ogg|opus|wav|aac|m4a|wma|aiff|alac)$/i.test(n)) {
    return { icon: ICON.audio, cls: 'anu-ficon-audio' };
  }
  // Subtitles
  if (/\.(ass|ssa|srt|sub|idx|vtt|sup|pgs)$/i.test(n)) {
    return { icon: ICON.subtitle, cls: 'anu-ficon-sub' };
  }
  // Images
  if (/\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff|tif|avif)$/i.test(n)) {
    return { icon: ICON.image, cls: 'anu-ficon-img' };
  }
  // Archives
  if (/\.(zip|rar|7z|tar|gz|bz2|xz|zst|cab|iso)$/i.test(n)) {
    return { icon: ICON.archive, cls: 'anu-ficon-archive' };
  }
  // Documents
  if (/\.(pdf|doc|docx|txt|nfo|md|rtf|xml|json|csv|log|ini|cfg|yml|yaml)$/i.test(n)) {
    return { icon: ICON.file, cls: 'anu-ficon-doc' };
  }
  // Default
  return { icon: ICON.file, cls: 'anu-ficon-default' };
}

// ─── Painel HTML ──────────────────────────────────────────────────────────────
const panel = document.createElement('div');
panel.id = 'anu-panel';
panel.setAttribute('role', 'region');
panel.setAttribute('aria-labelledby', 'anu-title');
panel.innerHTML = `
  <header id="anu-header">
    <h3 class="anu-brand">
      <span class="anu-logo-icon anu-ic" aria-hidden="true">${ICON.logo}</span>
      <span class="anu-brand-copy">
        <span id="anu-title" class="anu-logo-text">Anitsu Downloader</span>
        <span class="anu-brand-subtitle">Central de transferências</span>
      </span>
    </h3>
    <div class="anu-header-actions">
      <button id="anu-session" class="ok" type="button"
        aria-describedby="anu-session-help"
        title="Tempo restante da autenticação. Clique para renovar agora.">
        <span class="anu-ic" aria-hidden="true">${ICON.pulse}</span>
        <span class="anu-session-copy">
          <span class="anu-session-label">Sessão</span>
          <span id="anu-session-txt">verificando…</span>
        </span>
      </button>
      <span id="anu-session-help" class="anu-sr-only">
        Mostra quanto tempo falta para a sessão de login expirar. Clique para renovar agora.
      </span>
      <button id="anu-min" type="button" aria-label="Minimizar painel"
        aria-controls="anu-body anu-footer" aria-expanded="true" title="Minimizar painel">
        <span class="anu-ic" aria-hidden="true">${ICON.minimize}</span>
      </button>
    </div>
  </header>

  <div id="anu-body">
    <section class="anu-context-card" aria-label="Pasta atual">
      <div id="anu-pathbar">
        <span class="anu-path-icon anu-ic" aria-hidden="true">${ICON.folderPath}</span>
        <span class="anu-path-copy">
          <span class="anu-eyebrow">Pasta atual</span>
          <b id="anu-cp" title="raiz">raiz</b>
        </span>
      </div>
      <a id="anu-anime-preview" href="#" target="_blank" rel="noopener" style="display:none">
        <img id="anu-anime-cover" alt="" />
        <span class="anu-anime-info">
          <span id="anu-anime-title"></span>
          <span id="anu-anime-meta"></span>
        </span>
      </a>
    </section>

    <div id="anu-toolbar">
      <div id="anu-toolbar-top">
        <div class="anu-section-title">
          <strong>Biblioteca</strong>
          <span>Carregue a pasta atual ou inclua todas as subpastas.</span>
        </div>
        <div class="anu-primary-actions">
          <button id="b-load" class="ab" type="button" title="Atualizar a pasta atual">
            <span class="anu-ic" aria-hidden="true">${ICON.reload}</span>Atualizar
          </button>
          <button id="b-recurse" class="am" type="button"
            title="Buscar arquivos também em todas as subpastas">
            <span class="anu-ic" aria-hidden="true">${ICON.layers}</span>Incluir subpastas
          </button>
          <span class="anu-selection-actions">
            <button id="b-all" class="agr" type="button" title="Selecionar todos os tipos incluídos">
              <span class="anu-ic" aria-hidden="true">${ICON.checkAll}</span>Todos
            </button>
            <button id="b-none" class="agr" type="button" title="Limpar a seleção">
              <span class="anu-ic" aria-hidden="true">${ICON.square}</span>Limpar
            </button>
          </span>
        </div>
      </div>
    </div>

    <div id="anu-filter">
      <div class="anu-field">
        <label for="anu-ext"><span class="anu-ic" aria-hidden="true">${ICON.filter}</span> Tipos incluídos</label>
        <input id="anu-ext" type="text" placeholder=".mkv, .mp4 — vazio inclui tudo"
          aria-describedby="anu-ext-help" />
        <span id="anu-ext-help" class="anu-help">
          Redefine a seleção e também limita a busca nas subpastas.
        </span>
      </div>
    </div>

    <div id="anu-stats" aria-label="Resumo dos arquivos">
      <span class="anu-stat">
        <span class="anu-stat-label"><span class="anu-ic" aria-hidden="true">${ICON.statFiles}</span>Arquivos</span>
        <b id="st">0</b>
      </span>
      <span class="anu-stat">
        <span class="anu-stat-label"><span class="anu-ic" aria-hidden="true">${ICON.statSelected}</span>Seleção</span>
        <b id="ss">0</b>
      </span>
      <span class="anu-stat">
        <span class="anu-stat-label"><span class="anu-ic" aria-hidden="true">${ICON.statDone}</span>Prontos</span>
        <b id="sd">0</b>
      </span>
      <span class="anu-stat">
        <span class="anu-stat-label"><span class="anu-ic" aria-hidden="true">${ICON.statFail}</span>Atenção</span>
        <b id="sf">0</b>
      </span>
      <span class="anu-stat">
        <span class="anu-stat-label"><span class="anu-ic" aria-hidden="true">${ICON.statSize}</span>Tamanho</span>
        <b id="sz">—</b>
      </span>
    </div>

    <div id="anu-prog" role="progressbar" aria-label="Progresso da operação"
      aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div id="anu-fill"></div>
    </div>

    <div id="anu-list" role="group" aria-label="Arquivos e pastas">
      <div class="anu-empty">
        <span class="anu-empty-icon anu-ic" aria-hidden="true">${ICON.emptyBox}</span>
        <strong>Nenhuma pasta carregada</strong>
        <span>Navegue no Anitsu Cloud ou clique em Atualizar.</span>
      </div>
    </div>

    <section class="anu-transfer-card" aria-label="Destino do download">
      <div class="anu-transfer-head">
        <div class="anu-section-title">
          <strong>Destino do download</strong>
          <span>Escolha como os arquivos serão transferidos.</span>
        </div>
      </div>
      <div id="anu-mode-selector" role="radiogroup" aria-label="Modo de download">
        <input class="anu-mode-input" id="anu-direct" type="radio"
          name="anu-downloader-mode" value="direct" checked />
        <label id="anu-direct-label" class="anu-mode-option" for="anu-direct">Direto</label>
        <input class="anu-mode-input" id="anu-abdm" type="radio"
          name="anu-downloader-mode" value="abdm" />
        <label id="anu-abdm-label" class="anu-mode-option" for="anu-abdm">AB Download Manager</label>
        <input class="anu-mode-input" id="anu-idm" type="radio"
          name="anu-downloader-mode" value="idm" />
        <label id="anu-idm-label" class="anu-mode-option" for="anu-idm">IDM</label>
      </div>

      <div id="anu-abdm-cfg" aria-label="Configurações do AB Download Manager">
        <div class="anu-field">
          <label for="anu-abdm-port">Porta</label>
          <input id="anu-abdm-port" type="number" min="1" max="65535"
            inputmode="numeric" placeholder="15151" />
        </div>
        <div class="anu-field">
          <label for="anu-abdm-batch">Por lote</label>
          <input id="anu-abdm-batch" type="number" min="1" max="999"
            inputmode="numeric" placeholder="5" />
        </div>
        <div class="anu-field">
          <label for="anu-abdm-intv">Intervalo (min)</label>
          <input id="anu-abdm-intv" type="number" min="1" max="999"
            inputmode="numeric" placeholder="30"
            title="Tempo de espera entre um lote e o próximo. O primeiro lote é imediato." />
        </div>
        <div class="anu-field anu-field-queue">
          <label for="anu-abdm-queue">Fila</label>
          <select id="anu-abdm-queue">
            <option value="">Sem fila específica</option>
          </select>
        </div>
        <div class="anu-field anu-field-folder">
          <label for="anu-abdm-folder">Pasta de destino</label>
          <input id="anu-abdm-folder" type="text"
            placeholder="Ex.: D:/Downloads/Animes" aria-describedby="anu-folder-help" />
          <span id="anu-folder-help" class="anu-help">
            Em branco usa a pasta padrão do ABDM.
          </span>
        </div>
      </div>

      <div id="anu-abdm-ctrl" aria-label="Controle do envio em lotes">
        <span id="anu-abdm-wait"></span>
        <button id="b-abdm-next" class="ab" type="button">
          <span class="anu-ic" aria-hidden="true">${ICON.skip}</span>Próximo lote agora
        </button>
        <button id="b-abdm-stop" class="ar" type="button">
          <span class="anu-ic" aria-hidden="true">${ICON.stop}</span>Cancelar
        </button>
      </div>
    </section>

    <div id="anu-live" class="linf" role="status" aria-live="polite">
      <span class="anu-live-dot" aria-hidden="true"></span>
      <span id="anu-live-text">Pronto.</span>
    </div>

    <div id="anu-toolbar-bot">
      <button id="b-retry" class="ay" type="button" disabled>
        <span class="anu-ic" aria-hidden="true">${ICON.retry}</span>
        <span id="anu-retry-label">Repetir falhas</span>
      </button>
      <button id="b-stop" class="ar" type="button" disabled>
        <span class="anu-ic" aria-hidden="true">${ICON.stop}</span>
        <span>Parar</span>
      </button>
      <button id="b-dl" class="ag" type="button" disabled>
        <span class="anu-ic" aria-hidden="true">${ICON.download}</span>
        <span id="anu-dl-label">Baixar selecionados</span>
      </button>
    </div>

    <div id="anu-log" aria-live="off" aria-label="Histórico de atividade">
      <div class="linf">Pronto.</div>
    </div>
  </div>

  <footer id="anu-footer">
    <button id="anu-console-toggle" type="button" aria-label="Ocultar atividade"
      aria-controls="anu-log" aria-expanded="true" title="Mostrar ou ocultar atividade">
      <span class="anu-ic" aria-hidden="true">${ICON.eyeOpen}</span>
    </button>
    <span class="anu-console-label">Atividade</span>
    <span id="anu-footer-credit">Anitsu Downloader 2.0.1 · TheCyBee &amp; Saitama</span>
  </footer>
`;

document.body.appendChild(panel);
requestAnimationFrame(function() {
  requestAnimationFrame(function() { panel.classList.add('anu-mounted'); });
});

function G(id) { return document.getElementById(id); }
const listEl = G('anu-list');
const logEl = G('anu-log');
const extEl = G('anu-ext');
extEl.value = getStorage(EXT_FILTER_KEY, '');

function isBusy() {
  return loading || downloading || abdmSending || crawling;
}

function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) { d.className = cls; }
  // Add timestamp prefix
  const now = new Date();
  const ts = String(now.getHours()).padStart(2, '0') + ':' +
             String(now.getMinutes()).padStart(2, '0') + ':' +
             String(now.getSeconds()).padStart(2, '0');
  d.textContent = '[' + ts + '] ' + msg;
  logEl.appendChild(d);
  while (logEl.children.length > MAX_LOG_ENTRIES) {
    logEl.removeChild(logEl.firstChild);
  }
  logEl.scrollTop = logEl.scrollHeight;
  const live = G('anu-live');
  const liveText = G('anu-live-text');
  if (live && liveText) {
    live.className = cls || 'linf';
    liveText.textContent = msg;
    live.title = msg;
  }
}

function getExts() {
  if (extEl.value === extCacheRaw) { return extCacheList; }
  extCacheRaw = extEl.value;
  extCacheList = extCacheRaw.split(',').map(function(e) {
    return e.trim().toLowerCase();
  }).filter(Boolean);
  return extCacheList;
}
function passes(name) {
  const exts = getExts();
  if (!exts.length) { return true; }
  const lower = String(name || '').toLowerCase();
  return exts.some(function(x) { return lower.endsWith(x); });
}

function updateStats() {
  const files = fileList.filter(function(f) { return !f.is_directory; });
  const activeFiles = activeDownloadPaths.size
    ? files.filter(function(f) { return activeDownloadPaths.has(f.path); })
    : files.filter(function(f) {
      return selected.has(f.path) || f.status !== 'pending';
    });
  const progressFiles = activeFiles.length ? activeFiles : files;
  const done = files.filter(function(f) { return f.status === 'done' || f.status === 'sent'; }).length;
  const fail = files.filter(function(f) { return f.status === 'error'; }).length;
  const retryableFail = files.filter(function(f) {
    return f.status === 'error' && lastOperationPaths.has(f.path);
  }).length;
  const uncertain = files.filter(function(f) { return f.status === 'uncertain'; }).length;
  const pendingAfterProgress = files.filter(function(f) {
    return f.status === 'pending' && lastOperationPaths.has(f.path);
  }).length;
  const progressDone = progressFiles.filter(function(f) {
    return f.status === 'done' || f.status === 'sent' ||
      f.status === 'error' || f.status === 'uncertain';
  }).length;
  G('st').textContent = files.length;
  G('ss').textContent = selected.size;
  G('sd').textContent = done;
  G('sf').textContent = fail + uncertain;
  G('sf').parentElement.title = fail + ' falha(s), ' + uncertain + ' envio(s) para verificar no ABDM';
  G('sz').textContent = selected.size > 0 ? fmt(totalSize(selected)) : '—';
  const pct = progressFiles.length ? Math.round(progressDone / progressFiles.length * 100) : 0;
  const busy = isBusy();
  const fillEl = G('anu-fill');
  fillEl.style.width = pct + '%';
  G('anu-prog').setAttribute('aria-valuenow', String(pct));
  listEl.setAttribute('aria-busy', (loading || crawling) ? 'true' : 'false');
  // Green when complete
  if (pct >= 100 && !busy) {
    fillEl.classList.add('anu-done');
  } else {
    fillEl.classList.remove('anu-done');
  }
  G('b-dl').disabled = selected.size === 0 || busy;
  const retryable = retryableFail + pendingAfterProgress;
  G('b-retry').disabled = retryable === 0 || busy;
  G('anu-retry-label').textContent = pendingAfterProgress && retryableFail
    ? 'Retomar ' + pendingAfterProgress + ' + ' + retryableFail + ' falha(s)'
    : (pendingAfterProgress
      ? 'Retomar ' + pendingAfterProgress + ' pendente(s)'
      : (retryableFail ? 'Repetir ' + retryableFail + ' falha(s)' : 'Repetir falhas'));
  G('b-retry').title = (pendingAfterProgress
    ? 'Retomar apenas os arquivos que ainda não foram enviados'
    : 'Tentar novamente apenas os arquivos com falha') +
    (uncertain ? '. Itens “verificar ABDM” ficam de fora para evitar duplicação' : '');
  G('b-retry').setAttribute('aria-label', G('anu-retry-label').textContent);
  G('b-stop').disabled = !busy;
  G('b-recurse').disabled = busy;
  G('b-load').disabled = busy;
  G('b-all').disabled = busy || files.length === 0;
  G('b-none').disabled = busy || selected.size === 0;
  extEl.disabled = busy;
  ['anu-direct', 'anu-abdm', 'anu-idm'].forEach(function(id) {
    G(id).disabled = busy;
  });
  ['anu-abdm-port', 'anu-abdm-batch', 'anu-abdm-intv', 'anu-abdm-queue', 'anu-abdm-folder'].forEach(function(id) {
    G(id).disabled = abdmSending;
  });
  listEl.querySelectorAll('.anu-dl-one').forEach(function(button) { button.disabled = busy; });
  listEl.querySelectorAll('input[type="checkbox"]').forEach(function(checkbox) { checkbox.disabled = busy; });
  const mode = G('anu-abdm').checked ? 'abdm' : (G('anu-idm').checked ? 'idm' : 'direct');
  const count = selected.size;
  G('anu-dl-label').textContent = count === 0
    ? 'Selecione arquivos'
    : (mode === 'abdm' ? 'Enviar ' + count + ' ao ABDM'
      : (mode === 'idm' ? 'Enviar ' + count + ' ao IDM'
        : 'Baixar ' + count + (count === 1 ? ' arquivo' : ' arquivos')));
}

function formatCountdown(s) {
  if (s <= 0) { return 'expirada'; }
  const totalMinutes = Math.max(1, Math.ceil(s / 60));
  if (totalMinutes < 120) { return totalMinutes + ' min'; }
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h + 'h' + (m ? ' ' + m + 'min' : '');
}

function updateSessionIndicator() {
  const btn = G('anu-session');
  const txt = G('anu-session-txt');
  if (sessionRefreshing) {
    btn.className = 'anu-refreshing';
    btn.disabled = true;
    txt.textContent = 'renovando…';
    return;
  }
  btn.disabled = false;
  const data = getAuthData();
  if (!data || !data.expires_at) {
    btn.className = 'exp';
    txt.textContent = 'sem sessão';
    btn.title = 'Sessão ausente. Faça login novamente no Anitsu.';
    return;
  }
  const s = data.expires_at - Date.now() / 1000;
  if (s <= 0) {
    btn.className = 'exp';
    txt.textContent = 'expirada';
  } else if (s < 15 * 60) {
    btn.className = 'warn';
    txt.textContent = formatCountdown(s);
  } else {
    btn.className = 'ok';
    txt.textContent = formatCountdown(s);
  }
  btn.title = s > 0
    ? 'Sessão: ' + formatCountdown(s) + ' restantes. Clique para renovar agora.'
    : 'Sessão expirada. Clique para tentar renovar.';
}

setInterval(updateSessionIndicator, 30000);
updateSessionIndicator();
G('anu-session').onclick = function() {
  setStorage(SESSION_REFRESH_LOCK_KEY, Date.now());
  refreshSession().then(updateSessionIndicator);
};

function requestAutomaticSessionRefresh(delay) {
  setTimeout(function() {
    const latest = getAuthData();
    if (!latest || !latest.refresh_token) { return; }
    const secondsLeft = Number(latest.expires_at || 0) - Date.now() / 1000;
    if (secondsLeft >= 10 * 60 || sessionRefreshing) { return; }
    const lastRefresh = Number(getStorage(SESSION_REFRESH_LOCK_KEY, '0')) || 0;
    if (Date.now() - lastRefresh < SESSION_REFRESH_COOLDOWN_MS) { return; }
    setStorage(SESSION_REFRESH_LOCK_KEY, Date.now());
    refreshSession().then(updateSessionIndicator);
  }, Math.max(0, Number(delay) || 0));
}

// O Supabase normalmente entrega um access token de cerca de 60 minutos, mas
// o refresh token deve sobreviver ao fechamento do navegador. Assim que uma
// sessão válida é encontrada, regravamos o cookie com validade persistente e,
// se o access token já estiver perto de vencer, renovamos sem esperar o timer.
function initialisePersistentSession() {
  const data = getAuthData();
  if (!data || !data.refresh_token) { return; }
  if (!writeAuthData(data)) {
    log('O navegador não permitiu manter a sessão salva. Verifique se os cookies do Anitsu estão liberados.', 'lwrn');
    return;
  }
  const secondsLeft = Number(data.expires_at || 0) - Date.now() / 1000;
  if (secondsLeft < 10 * 60) { requestAutomaticSessionRefresh(900); }
}
initialisePersistentSession();

setInterval(function() {
  const data = getAuthData();
  if (!data || !data.expires_at) { return; }
  const secondsLeft = data.expires_at - Date.now() / 1000;
  if (secondsLeft < 10 * 60 && !sessionRefreshing) {
    requestAutomaticSessionRefresh(0);
  }
}, SESSION_AUTO_CHECK_MS);

function render() {
  ignoreObserver = true;
  if (!fileList.length) {
    listEl.innerHTML = '<div class="anu-empty"><span class="anu-empty-icon anu-ic">' + ICON.emptyBox + '</span>Nenhum arquivo encontrado.</div>';
    updateStats();
    ignoreObserver = false;
    return;
  }
  listEl.textContent = '';
  lastCheckedIndex = null;
  const frag = document.createDocumentFragment();
  fileList.forEach(function(f, index) {
    const row = document.createElement('div');
    row.className = 'anu-row';
    row.dataset.path = f.path;
    // Stagger animation
    row.style.animationDelay = Math.min(index * 15, 300) + 'ms';
    if (f.is_directory) {
      row.classList.add('anu-folder-row');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', 'Abrir pasta ' + f.name);
      const iconWrap = document.createElement('span');
      iconWrap.className = 'anu-ficon anu-ficon-folder';
      iconWrap.innerHTML = ICON.folder;
      const name = document.createElement('span');
      name.className = 'anu-fn';
      name.style.color = C.accent;
      name.title = f.name;
      name.textContent = f.name;
      const badge = document.createElement('span');
      badge.className = 'anu-bx bf';
      badge.textContent = 'pasta';
      row.appendChild(iconWrap);
      row.appendChild(name);
      row.appendChild(badge);
      function openFolder() {
        if (isBusy()) { return; }
        const clickedInSite = clickFolderInSite(f.name);
        if (!clickedInSite) {
          log('⚠ Não encontrei "' + f.name + '" na página para navegar o site também — carregando só no painel.', 'lwrn');
        }
        loadFolder(f.path);
      }
      row.onclick = openFolder;
      row.onkeydown = function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openFolder();
        }
      };
    } else {
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = selected.has(f.path);
      chk.dataset.index = index;
      chk.setAttribute('aria-label', 'Selecionar ' + f.name);
      chk.disabled = isBusy();

      function applyCheck(shiftKey) {
        const ci = Number(chk.dataset.index);
        const checked = chk.checked;
        if (shiftKey && lastCheckedIndex !== null && lastCheckedIndex !== ci) {
          const start = Math.min(lastCheckedIndex, ci);
          const end = Math.max(lastCheckedIndex, ci);
          for (let i = start; i <= end; i++) {
            const f2 = fileList[i];
            if (!f2 || f2.is_directory) { continue; }
            if (checked) { selected.add(f2.path); } else { selected.delete(f2.path); }
            const cb = listEl.querySelector('input[type="checkbox"][data-index="' + i + '"]');
            if (cb) { cb.checked = checked; }
          }
        } else if (checked) {
          selected.add(f.path);
        } else {
          selected.delete(f.path);
        }
        lastCheckedIndex = ci;
        updateStats();
      }

      chk.onclick = function(e) {
        e.stopPropagation();
        if (isBusy()) { e.preventDefault(); return; }
        applyCheck(!!e.shiftKey);
      };
      row.onclick = function(e) {
        if (isBusy() || e.target === chk || (e.target.closest && e.target.closest('button'))) { return; }
        chk.checked = !chk.checked;
        applyCheck(!!e.shiftKey);
      };
      // File type icon
      const fi = getFileIcon(f.name);
      const iconWrap = document.createElement('span');
      iconWrap.className = 'anu-ficon ' + fi.cls;
      iconWrap.innerHTML = fi.icon;

      row.appendChild(chk);
      row.appendChild(iconWrap);
      const name = document.createElement('span');
      name.className = 'anu-fn';
      name.title = f.name;
      name.textContent = f.name;
      const size = document.createElement('span');
      size.className = 'anu-fs';
      size.textContent = fmt(f.size);
      const badgeWrap = document.createElement('span');
      badgeWrap.innerHTML = mkBadge(f.status);
      const button = document.createElement('button');
      button.className = 'anu-dl-one';
      button.type = 'button';
      button.disabled = isBusy();
      button.title = 'Baixar este arquivo';
      button.setAttribute('aria-label', 'Baixar ' + f.name);
      button.setAttribute('data-tip', 'Baixar este arquivo');
      button.innerHTML = ICON.downloadSm;
      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(badgeWrap.firstChild);
      row.appendChild(button);
      button.onclick = function(e) {
        e.stopPropagation();
        if (isBusy()) { return; }
        startDownloads([f]);
      };
    }
    frag.appendChild(row);
  });
  listEl.appendChild(frag);
  updateStats();
  ignoreObserver = false;
}

function refreshBadge(item) {
  ignoreObserver = true;
  const rows = listEl.querySelectorAll('.anu-row');
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].dataset.path === item.path) {
      const b = rows[i].querySelector('.anu-bx:not(.bf)');
      if (b) { b.outerHTML = mkBadge(item.status); }
      break;
    }
  }
  ignoreObserver = false;
}

// Dispara um clique "de verdade" (mousedown+mouseup+click) num elemento —
// alguns componentes React só reagem à sequência completa de eventos do
// ponteiro, não a um simples .click().
function fireRealClick(el) {
  try { el.click(); } catch (e) {
    try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e2) {}
  }
}

// Tenta localizar, na UI real do site (fora do painel), o elemento clicável
// que representa a pasta com o nome informado, e clica nele — assim o site
// também navega para dentro da pasta, não só o painel.
function clickFolderInSite(name) {
  const candidates = Array.from(document.querySelectorAll(
    'main [role="button"], main button, main a, main li, main div[tabindex], [data-testid*="folder" i], [data-testid*="item" i]'
  )).filter(function(el) {
    if (panel.contains(el)) { return false; }
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  });

  const matches = candidates.filter(function(el) {
    const text = (el.textContent || '').trim();
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    return text === name || label === name || label === 'Abrir ' + name;
  }).sort(function(a, b) {
    const aInteractive = a.matches('button,a,[role="button"]') ? 0 : 1;
    const bInteractive = b.matches('button,a,[role="button"]') ? 0 : 1;
    if (aInteractive !== bInteractive) { return aInteractive - bInteractive; }
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (ar.width * ar.height) - (br.width * br.height);
  });
  const target = matches[0] || null;
  if (target) {
    fireRealClick(target);
    return true;
  }
  return false;
}

function renderSkeleton() {
  ignoreObserver = true;
  const rows = [90, 70, 85, 60, 78];
  listEl.innerHTML = rows.map(function(w) {
    return '<div class="anu-skel-row">' +
      '<span class="anu-skel anu-skel-box"></span>' +
      '<span class="anu-skel anu-skel-icon"></span>' +
      '<span class="anu-skel anu-skel-line" style="width:' + w + '%"></span>' +
      '<span class="anu-skel anu-skel-chip"></span>' +
    '</div>';
  }).join('');
  ignoreObserver = false;
}

function renderListError(titleText, detailText) {
  listEl.textContent = '';
  const state = document.createElement('div');
  state.className = 'anu-empty anu-error-state';
  const icon = document.createElement('span');
  icon.className = 'anu-empty-icon anu-ic';
  icon.innerHTML = ICON.emptyBox;
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('strong');
  title.textContent = titleText;
  const detail = document.createElement('span');
  detail.textContent = detailText;
  state.appendChild(icon);
  state.appendChild(title);
  state.appendChild(detail);
  listEl.appendChild(state);
  updateStats();
}

function hideAnimePreview() {
  const preview = G('anu-anime-preview');
  const cover = G('anu-anime-cover');
  preview.style.display = 'none';
  cover.removeAttribute('src');
  cover.hidden = true;
}

// Usa o nome da pasta atual como termo de busca no AniList e mostra a capa,
// título e nota do anime encontrado (se houver). Cancela silenciosamente se
// o usuário já tiver navegado para outra pasta enquanto a busca corria.
function updateAnimePreview(path) {
  const anilistId = ++activeAnilistId;
  const segments = String(path || '').split('/').filter(Boolean);
  const folderName = segments.length ? segments[segments.length - 1] : '';
  if (!folderName) { hideAnimePreview(); return; }
  const query = guessAnimeTitle(folderName);
  if (!query) { hideAnimePreview(); return; }

  fetchAnilistMedia(query).then(function(media) {
    if (anilistId !== activeAnilistId) { return; } // pasta mudou nesse meio-tempo
    if (!media) { hideAnimePreview(); return; }
    const title = (media.title && (media.title.english || media.title.romaji || media.title.native)) || query;
    const cover = media.coverImage && (media.coverImage.medium || media.coverImage.large);
    const metaParts = [];
    if (media.format) { metaParts.push(media.format); }
    if (media.episodes) { metaParts.push(media.episodes + ' ep.'); }
    if (media.averageScore) { metaParts.push('★ ' + (media.averageScore / 10).toFixed(1)); }

    const el = G('anu-anime-preview');
    const coverEl = G('anu-anime-cover');
    if (cover) {
      coverEl.src = cover;
      coverEl.hidden = false;
      coverEl.alt = 'Capa de ' + title;
    } else {
      coverEl.removeAttribute('src');
      coverEl.hidden = true;
      coverEl.alt = '';
    }
    G('anu-anime-title').textContent = title;
    G('anu-anime-meta').textContent = metaParts.join(' · ');
    if (media.siteUrl) {
      el.href = media.siteUrl;
      el.setAttribute('aria-label', 'Abrir ' + title + ' no AniList');
    } else {
      el.removeAttribute('href');
      el.removeAttribute('aria-label');
    }
    el.style.display = 'flex';
  });
}

function loadFolder(path) {
  if (downloading || abdmSending || crawling) {
    pendingPanelPath = String(path || '');
    log('Conclua ou pare a operação atual antes de trocar a pasta do painel.', 'lwrn');
    return;
  }
  pendingPanelPath = null;
  const loadId = ++activeLoadId;
  currentPanelPath = String(path || '');
  hasCurrentPanelPath = true;
  loading = true;
  fileList = [];
  selected.clear();
  lastOperationPaths.clear();
  lastCheckedIndex = null;
  G('anu-cp').textContent = path || 'raiz';
  G('anu-cp').title = path || 'raiz';
  log('Carregando /' + (path || 'raiz') + '…', 'linf');
  hideAnimePreview();
  updateAnimePreview(path);
  renderSkeleton();
  updateStats();
  apiFetch(path).then(function(data) {
    if (loadId !== activeLoadId) { return; }
    fileList = (data.files || []).map(function(f) {
      return { name: f.name, path: f.path || makeChildPath(path, f.name),
        size: f.size, is_directory: f.is_directory, status: 'pending', retries: 0 };
    });
    selected.clear();
    lastCheckedIndex = null;
    fileList.forEach(function(f) {
      if (!f.is_directory && passes(f.name)) { selected.add(f.path); }
    });
    loading = false;
    render();
    const fc = fileList.filter(function(f) { return !f.is_directory; }).length;
    const dc = fileList.filter(function(f) { return f.is_directory; }).length;
    log('Carregado — ' + fc + ' arquivo(s), ' + dc + ' pasta(s)', 'lok');
  }).catch(function(e) {
    if (loadId !== activeLoadId) { return; }
    loading = false;
    fileList = [];
    selected.clear();
    log('Erro ao carregar pasta: ' + e.message, 'lerr');
    renderListError('Não foi possível carregar esta pasta', e.message);
  }).finally(function() {
    if (loadId === activeLoadId && loading) {
      loading = false;
      updateStats();
    }
  });
}

function flushPendingFolder() {
  if (isBusy() || pendingPanelPath === null) { return; }
  const path = pendingPanelPath;
  pendingPanelPath = null;
  setTimeout(function() { loadFolder(path); }, 0);
}

function crawlRecursive(path, acc, crawlId, onProgress) {
  const root = String(path || '');
  const queue = [root];
  const queued = new Set([root]);
  const seenFiles = new Set();
  const stats = { folders: 0, queued: 1, active: 0, files: 0, errors: 0, cancelled: false };
  let lastProgress = 0;

  function emitProgress(force) {
    const now = Date.now();
    if (!force && now - lastProgress < CRAWL_PROGRESS_MS) { return; }
    lastProgress = now;
    stats.queued = queue.length;
    stats.files = acc.length;
    if (onProgress) { onProgress(Object.assign({}, stats)); }
  }

  function addFile(item, full) {
    if (seenFiles.has(full) || !passes(item.name)) { return; }
    seenFiles.add(full);
    acc.push({
      name: item.name,
      path: full,
      size: item.size,
      is_directory: false,
      status: 'pending',
      retries: 0,
    });
  }

  return new Promise(function(resolve, reject) {
    let settled = false;

    function finish(cancelled) {
      if (settled) { return; }
      settled = true;
      stats.cancelled = !!cancelled;
      emitProgress(true);
      resolve(stats);
    }

    function launch() {
      if (crawlId !== activeCrawlId || stopped) { finish(true); return; }
      if (!queue.length && stats.active === 0) { finish(false); return; }

      while (queue.length && stats.active < CRAWL_CONCURRENCY) {
        const current = queue.shift();
        stats.active++;
        emitProgress(false);
        apiFetch(current).then(function(data) {
          stats.folders++;
          const files = data.files || [];
          files.forEach(function(f) {
            const full = f.path || makeChildPath(current, f.name);
            if (f.is_directory) {
              if (!queued.has(full)) {
                queued.add(full);
                queue.push(full);
              }
            } else {
              addFile(f, full);
            }
          });
        }).catch(function(e) {
          stats.errors++;
          if (current === root) {
            settled = true;
            reject(e);
            return;
          }
          log('⚠ Pulando pasta com erro: /' + current + ' — ' + e.message, 'lwrn');
        }).then(function() {
          stats.active--;
          if (!settled) { launch(); }
        });
      }
    }

    launch();
  });
}

G('b-recurse').onclick = function() {
  if (isBusy()) { return; }
  const path = hasCurrentPanelPath ? currentPanelPath : getCurrentPath();
  const crawlId = ++activeCrawlId;
  crawling = true;
  stopped = false;
  fileList = [];
  selected.clear();
  lastOperationPaths.clear();
  lastCheckedIndex = null;
  G('b-recurse').disabled = true;
  G('b-recurse').textContent = 'Buscando…';
  renderSkeleton();
  updateStats();
  log('Busca rápida em /' + (path || 'raiz') + ' com ' + CRAWL_CONCURRENCY + ' pasta(s) em paralelo…', 'linf');
  const acc = [];
  crawlRecursive(path, acc, crawlId, function(stats) {
    G('anu-cp').textContent = (path || 'raiz') + ' (' + stats.files + ' arquivos)';
  }).then(function(stats) {
    if (crawlId !== activeCrawlId || stats.cancelled) {
      log('Busca interrompida — ' + acc.length + ' arquivo(s) encontrados antes da parada.', 'lwrn');
      return;
    }
    fileList = acc;
    selected.clear();
    lastCheckedIndex = null;
    fileList.forEach(function(f) { selected.add(f.path); });
    G('anu-cp').textContent = (path || 'raiz') + ' (completo)';
    render();
    log('Busca concluída — ' + acc.length + ' arquivo(s), ' + stats.folders +
      ' pasta(s), ' + stats.errors + ' erro(s).', stats.errors ? 'lwrn' : 'lok');
  }).catch(function(e) {
    if (crawlId !== activeCrawlId || stopped) { return; }
    log('Erro na busca: ' + e.message, 'lerr');
    fileList = [];
    selected.clear();
    G('anu-cp').textContent = path || 'raiz';
    G('anu-cp').title = path || 'raiz';
    renderListError('Não foi possível buscar as subpastas', e.message);
  }).finally(function() {
    if (crawlId === activeCrawlId) {
      crawling = false;
      G('b-recurse').disabled = false;
      G('b-recurse').innerHTML = '<span class="anu-ic" aria-hidden="true">' + ICON.layers + '</span>Incluir subpastas';
      updateStats();
      flushPendingFolder();
    }
  });
};

G('b-load').onclick = function() {
  const path = hasCurrentPanelPath ? currentPanelPath : getCurrentPath();
  clearApiCache(path);
  loadFolder(path);
};
G('b-all').onclick = function() {
  fileList.forEach(function(f) {
    if (!f.is_directory && passes(f.name)) { selected.add(f.path); }
  });
  render();
};
G('b-none').onclick = function() { selected.clear(); render(); };
const renderFilteredSelection = debounce(function() {
  if (!isBusy()) { render(); }
}, 180);
extEl.addEventListener('input', function() {
  setStorage(EXT_FILTER_KEY, extEl.value);
  selected.clear();
  fileList.forEach(function(f) {
    if (!f.is_directory && passes(f.name)) { selected.add(f.path); }
  });
  listEl.querySelectorAll('input[type="checkbox"]').forEach(function(checkbox) {
    const row = checkbox.closest('.anu-row');
    checkbox.checked = !!(row && selected.has(row.dataset.path));
  });
  updateStats();
  renderFilteredSelection();
});

G('b-stop').onclick = function() {
  cancelCurrentOperation(false);
};

function clearRetryWaits() {
  retryTimers.forEach(function(ticket) {
    clearTimeout(ticket.timer);
    ticket.resolve(false);
  });
  retryTimers.clear();
}

function waitForRetry(delay, jobId) {
  return new Promise(function(resolve) {
    const ticket = { timer: null, resolve: resolve };
    ticket.timer = setTimeout(function() {
      retryTimers.delete(ticket);
      resolve(jobId === operationId && !stopped);
    }, delay);
    retryTimers.add(ticket);
  });
}

function cancelCurrentOperation(silent) {
  const hadWork = isBusy();
  let uncertainOnCancel = 0;
  stopped = true;
  operationId++;
  abdmOperationId++;
  activeLoadId++;
  activeCrawlId++;
  loading = false;
  downloading = false;
  crawling = false;
  clearRetryWaits();
  activeDownloadHandles.forEach(function(entry) {
    if (entry.item && entry.item.status === 'downloading') { entry.item.status = 'pending'; }
    try {
      if (entry.handle && typeof entry.handle.abort === 'function') { entry.handle.abort(); }
    } catch (e) {}
    if (typeof entry.resolveCancel === 'function') { entry.resolveCancel(); }
  });
  activeDownloadHandles.clear();
  abdmRequestHandles.forEach(function(ticket) {
    // Um POST já pode ter chegado ao ABDM quando o navegador o aborta. Marcar
    // como incerto impede que "Retomar" o envie novamente sem confirmação.
    if (ticket.item && ticket.item.status === 'downloading') {
      ticket.item.status = 'uncertain';
      uncertainOnCancel++;
    }
    try {
      if (ticket.handle && typeof ticket.handle.abort === 'function') { ticket.handle.abort(); }
    } catch (e) {}
    if (typeof ticket.resolveCancel === 'function') { ticket.resolveCancel(); }
  });
  abdmRequestHandles.clear();
  clearApiCache();
  clearTimeout(abdmTimer);
  abdmTimer = null;
  clearAbdmCountdown();
  abdmSending = false;
  abdmBatchInFlight = false;
  abdmNextAt = 0;
  abdmActiveSettings = null;
  abdmQueue = [];
  abdmOffset = 0;
  activeDownloadPaths.clear();
  fileList.forEach(function(item) {
    if (item.status === 'downloading') { item.status = 'pending'; }
  });
  G('b-recurse').innerHTML = '<span class="anu-ic" aria-hidden="true">' + ICON.layers + '</span>Incluir subpastas';
  updateAbdmControls();
  render();
  if (!silent && hadWork) {
    log('Operação interrompida pelo usuário.' +
      (uncertainOnCancel
        ? ' Verifique ' + uncertainOnCancel + ' item(ns) no ABDM antes de reenviar.'
        : ''), 'lwrn');
  }
  updateStats();
  flushPendingFolder();
  return uncertainOnCancel;
}

function dlFile(item, jobId) {
  return new Promise(function(resolve) {
    if (stopped || jobId !== operationId) { resolve(false); return; }
    let settled = false;
    let failureHandling = false;
    const token = {};

    function finish(value) {
      if (settled) { return; }
      settled = true;
      activeDownloadHandles.delete(token);
      resolve(value);
    }

    function retryAfter(delay) {
      if (settled) { return; }
      settled = true;
      activeDownloadHandles.delete(token);
      waitForRetry(delay, jobId).then(function(shouldRetry) {
        if (!shouldRetry) { resolve(false); return; }
        dlFile(item, jobId).then(resolve);
      });
    }

    function handleFailure(err) {
      if (settled || failureHandling) { return; }
      failureHandling = true;
      if (jobId !== operationId || stopped) { finish(false); return; }
      const status = Number(err && (err.status || err.statusCode || err.error));
      const detail = String(err && err.details !== undefined ? err.details : '');
      const maybeAuth = status === 401 || status === 403 || /\b40[13]\b/.test(detail);
      if (maybeAuth && item.retries === 0) {
        log('A sessão expirou durante o download. Renovando…', 'lwrn');
        activeDownloadHandles.delete(token);
        refreshSession().then(function(ok) {
          if (jobId !== operationId || stopped) { finish(false); return; }
          if (!ok) {
            item.status = 'error';
            refreshBadge(item);
            updateStats();
            finish(false);
            return;
          }
          item.retries++;
          item.status = 'pending';
          retryAfter(RETRY_DELAY_MS);
        });
        return;
      }
      if (item.retries < MAX_RETRIES) {
        item.retries++;
        item.status = 'pending';
        const nextAttempt = item.retries + 1;
        log('Nova tentativa ' + nextAttempt + '/' + (MAX_RETRIES + 1) + ': ' + item.name, 'lwrn');
        retryAfter(backoffDelay(item.retries - 1));
        return;
      }
      item.status = 'error';
      refreshBadge(item);
      log('Falhou após ' + (MAX_RETRIES + 1) + ' tentativas: ' + item.name, 'lerr');
      updateStats();
      finish(false);
    }

    item.status = 'downloading';
    refreshBadge(item);
    log('↓ ' + item.name, 'linf');
    try {
      const handle = GM_download({
        url: getDownloadUrl(item),
        name: item.downloadName || sanitizeName(item.name),
        onload: function() {
          if (jobId !== operationId || stopped) { finish(false); return; }
          item.status = 'done';
          refreshBadge(item);
          log('✓ ' + item.name, 'lok');
          updateStats();
          updateSessionIndicator();
          finish(true);
        },
        onerror: handleFailure,
        ontimeout: function() { handleFailure({ error: 'timeout' }); },
        onabort: function() { finish(false); },
      });
      if (!settled) {
        activeDownloadHandles.set(token, {
          handle: handle,
          item: item,
          jobId: jobId,
          resolveCancel: function() { finish(false); },
        });
      }
    } catch (e) {
      handleFailure(e);
    }
  });
}

function runQueue(items, jobId) {
  if (!items.length || jobId !== operationId) { return Promise.resolve(false); }
  downloading = true; stopped = false; updateStats();
  let idx = 0;
  function worker() {
    return new Promise(function(resolveWorker) {
      function next() {
        if (idx >= items.length || stopped || jobId !== operationId) { resolveWorker(); return; }
        const item = items[idx++];
        if (item.status !== 'pending') { next(); return; }
        dlFile(item, jobId).then(next);
      }
      next();
    });
  }
  const workers = [];
  const workerCount = Math.min(CONCURRENCY, items.length);
  for (let i = 0; i < workerCount; i++) { workers.push(worker()); }
  return Promise.all(workers).then(function() {
    if (jobId !== operationId) { return false; }
    downloading = false;
    activeDownloadPaths.clear();
    if (stopped) {
      log('Fila interrompida.', 'lwrn');
      updateStats();
      return false;
    }
    const fail = items.filter(function(f) { return f.status === 'error'; }).length;
    log(fail ? 'Concluído. ' + fail + ' falha(s) — clique em "Repetir falhas".'
             : '✓ Todos os downloads concluídos!', fail ? 'lwrn' : 'lok');
    updateStats();
    flushPendingFolder();
    return fail === 0;
  }).catch(function(e) {
    if (jobId === operationId) {
      downloading = false;
      activeDownloadPaths.clear();
      log('Erro inesperado na fila: ' + e.message, 'lerr');
      updateStats();
      flushPendingFolder();
    }
    return false;
  });
}

G('anu-abdm-port').value = getAbdmPort();
G('anu-abdm-batch').value = getAbdmBatch();
G('anu-abdm-intv').value = getAbdmInterval();
G('anu-abdm-folder').value = getAbdmFolder();

G('anu-abdm-port').onchange = function() {
  const v = parseInt(G('anu-abdm-port').value, 10);
  if (v > 0 && v <= 65535) {
    setStorage(ABDM_PORT_KEY, v);
    if (G('anu-abdm').checked) { startAbdmQueueAutoRefresh(); }
  } else {
    G('anu-abdm-port').value = getAbdmPort();
  }
};
G('anu-abdm-batch').oninput = function() {
  const v = parseInt(G('anu-abdm-batch').value, 10);
  if (v > 0) { setStorage(ABDM_BATCH_KEY, v); }
};
G('anu-abdm-batch').onblur = function() {
  G('anu-abdm-batch').value = getAbdmBatch();
};
G('anu-abdm-intv').oninput = function() {
  const v = parseInt(G('anu-abdm-intv').value, 10);
  if (v > 0) { setStorage(ABDM_INTERVAL_KEY, v); }
};
G('anu-abdm-intv').onblur = function() {
  G('anu-abdm-intv').value = getAbdmInterval();
};
G('anu-abdm-folder').oninput = function() {
  setStorage(ABDM_FOLDER_KEY, G('anu-abdm-folder').value.trim());
};

function applyDownloaderMode(mode, refreshQueues) {
  const useDirect = mode !== 'abdm' && mode !== 'idm';
  const useAbdm = mode === 'abdm';
  const useIdm = mode === 'idm';
  G('anu-direct').checked = useDirect;
  G('anu-abdm').checked = useAbdm;
  G('anu-idm').checked = useIdm;
  G('anu-abdm-cfg').style.display = useAbdm ? 'grid' : 'none';
  G('anu-abdm-cfg').setAttribute('aria-hidden', useAbdm ? 'false' : 'true');
  if (useAbdm && refreshQueues) { startAbdmQueueAutoRefresh(); }
  else { stopAbdmQueueAutoRefresh(); }
  setStorage(DOWNLOADER_MODE_KEY, useAbdm ? 'abdm' : (useIdm ? 'idm' : 'direct'));
  updateStats();
}

G('anu-direct').onchange = function() {
  if (G('anu-direct').checked) { applyDownloaderMode('direct', false); }
};
G('anu-abdm').onchange = function() {
  if (G('anu-abdm').checked) { applyDownloaderMode('abdm', true); }
};

G('anu-idm').onchange = function() {
  if (G('anu-idm').checked) { applyDownloaderMode('idm', false); }
};

applyDownloaderMode(getStorage(DOWNLOADER_MODE_KEY, 'direct'), true);

function startAbdmQueueAutoRefresh() {
  stopAbdmQueueAutoRefresh();
  abdmQueueRefreshRun = 0;

  function runAttempt() {
    if (!G('anu-abdm').checked) { stopAbdmQueueAutoRefresh(); return; }
    if (abdmQueueRefreshRun >= ABDM_QUEUE_REFRESH_ATTEMPTS) { return; }
    abdmQueueRefreshRun++;
    loadAbdmQueues(function() {
      if (abdmQueueRefreshRun < ABDM_QUEUE_REFRESH_ATTEMPTS && G('anu-abdm').checked) {
        abdmQueueTimer = setTimeout(runAttempt, ABDM_QUEUE_REFRESH_DELAY_MS);
      }
    });
  }

  runAttempt();
}

function stopAbdmQueueAutoRefresh() {
  clearTimeout(abdmQueueTimer);
  abdmQueueTimer = null;
}

function loadAbdmQueues(done) {
  if (abdmQueuePromise) {
    if (done) { abdmQueuePromise.finally(done); }
    return abdmQueuePromise;
  }
  const sel = G('anu-abdm-queue');
  const previous = sel.value;
  const capturedPort = getAbdmPort();
  const requestId = ++abdmQueueRequestId;

  const request = new Promise(function(resolve) {
    let settled = false;
    function finish() {
      if (settled) { return; }
      settled = true;
      resolve();
    }
    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'http://127.0.0.1:' + capturedPort + '/queues',
        timeout: 3500,
        onload: function(r) {
          if (requestId === abdmQueueRequestId && capturedPort === getAbdmPort() &&
              r.status >= 200 && r.status < 300) {
            try {
              const queues = JSON.parse(r.responseText || '[]');
              if (!Array.isArray(queues)) { throw new Error('Formato de filas inválido'); }
              sel.textContent = '';
              const empty = document.createElement('option');
              empty.value = '';
              empty.textContent = 'Sem fila específica';
              sel.appendChild(empty);
              queues.forEach(function(q) {
                const opt = document.createElement('option');
                opt.value = q.id;
                opt.textContent = q.name || ('Fila ' + q.id);
                sel.appendChild(opt);
              });
              if (previous && Array.from(sel.options).some(function(o) { return o.value === previous; })) {
                sel.value = previous;
              }
            } catch (e) {}
          }
          finish();
        },
        onerror: finish,
        ontimeout: finish,
        onabort: finish,
      });
    } catch (e) {
      finish();
    }
  }).finally(function() {
    if (abdmQueuePromise === request) {
      abdmQueuePromise = null;
    }
  });
  abdmQueuePromise = request;
  if (done) { request.finally(done); }
  return request;
}

function updateAbdmControls() {
  const hasPending = abdmOffset < abdmQueue.length;
  const waiting = !!(abdmSending && hasPending && abdmTimer && !abdmBatchInFlight);
  G('b-abdm-next').style.display = waiting ? 'inline-flex' : 'none';
  G('b-abdm-next').disabled = !waiting;
  G('b-abdm-stop').style.display = abdmSending ? 'inline-flex' : 'none';
  G('anu-abdm-ctrl').style.display = abdmSending ? 'flex' : 'none';
  if (abdmSending && abdmBatchInFlight) {
    G('anu-abdm-wait').textContent = 'Enviando lote…';
  } else if (waiting) {
    updateAbdmCountdown();
  } else if (abdmSending) {
    G('anu-abdm-wait').textContent = 'Preparando próximo lote…';
  } else {
    G('anu-abdm-wait').textContent = '';
  }
  updateStats();
}

function isLiveAbdm(jobId) {
  return abdmSending && !stopped && jobId === abdmOperationId && jobId === operationId;
}

function clearAbdmCountdown() {
  clearInterval(abdmCountdownTimer);
  abdmCountdownTimer = null;
}

function updateAbdmCountdown() {
  if (!abdmNextAt || !abdmTimer) { return; }
  const seconds = Math.max(0, Math.ceil((abdmNextAt - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  G('anu-abdm-wait').textContent = 'Próximo lote em ' + minutes + ':' + rest;
}

function trackAbdmRequest(options, jobId, interpret, item) {
  return new Promise(function(resolve) {
    if (!isLiveAbdm(jobId)) { resolve('cancelled'); return; }
    let settled = false;
    const ticket = {
      handle: null,
      item: item || null,
      resolveCancel: null,
    };
    function finish(value) {
      if (settled) { return; }
      settled = true;
      abdmRequestHandles.delete(ticket);
      resolve(value);
    }
    ticket.resolveCancel = function() { finish('cancelled'); };
    const requestOptions = Object.assign({}, options, {
      onload: function(r) {
        if (!isLiveAbdm(jobId)) { finish('cancelled'); return; }
        try {
          finish(interpret(r));
        } catch (e) {
          finish('unknown');
        }
      },
      onerror: function() { finish(isLiveAbdm(jobId) ? 'unknown' : 'cancelled'); },
      ontimeout: function() { finish(isLiveAbdm(jobId) ? 'unknown' : 'cancelled'); },
      onabort: function() { finish('cancelled'); },
    });
    try {
      ticket.handle = GM_xmlhttpRequest(requestOptions);
      if (!settled) { abdmRequestHandles.add(ticket); }
      if (!isLiveAbdm(jobId)) {
        if (ticket.handle && typeof ticket.handle.abort === 'function') { ticket.handle.abort(); }
        finish('cancelled');
      }
    } catch (e) {
      finish('unknown');
    }
  });
}

function getAuthCookieHeader() {
  return Array.from(getCookieMap().entries())
    .filter(function(entry) {
      return entry[0] === AUTH_COOKIE_NAME || entry[0].startsWith(AUTH_COOKIE_NAME + '.');
    })
    .map(function(entry) { return entry[0] + '=' + entry[1]; })
    .join('; ');
}

function ensureFreshAbdmSession(jobId) {
  if (!isLiveAbdm(jobId)) { return Promise.resolve(false); }
  const data = getAuthData();
  if (!data || !data.refresh_token) {
    log('A sessão do Anitsu não está disponível. Faça login novamente antes de continuar.', 'lerr');
    return Promise.resolve(false);
  }
  const secondsLeft = Number(data.expires_at || 0) - Date.now() / 1000;
  if (secondsLeft >= 10 * 60) { return Promise.resolve(true); }
  log('Renovando a sessão antes do próximo lote do ABDM…', 'linf');
  return refreshSession().then(function(ok) {
    return !!ok && isLiveAbdm(jobId);
  });
}

function abdmPing(jobId) {
  const settings = abdmActiveSettings;
  if (!settings) { return Promise.resolve(false); }
  return trackAbdmRequest({
    method: 'POST',
    url: 'http://127.0.0.1:' + settings.port + '/ping',
    headers: { 'Content-Type': 'application/json' },
    data: 'null',
    timeout: 4000,
  }, jobId, function(r) {
    return r.status >= 200 && r.status < 300 ? 'accepted' : 'rejected';
  }).then(function(result) { return result === 'accepted'; });
}

// Um POST com timeout tem resultado ambíguo: o ABDM pode ter aceitado o item
// e perdido apenas a resposta. Por isso não há reenvio automático aqui — isso
// evita downloads duplicados.
function sendItemToABDM(item, settings, jobId) {
  const link = getDownloadUrl(item);
  const body = {
    downloadSource: {
      link: link,
      // O cabeçalho é reconstruído para cada item: uma sessão renovada durante
      // uma espera longa passa a valer imediatamente para os próximos envios.
      headers: { 'Cookie': getAuthCookieHeader() },
    },
    name: item.downloadName || sanitizeName(item.name),
  };
  if (settings.queueId) { body.queueId = parseInt(settings.queueId, 10); }
  if (settings.folder) { body.folder = settings.folder; }

  return trackAbdmRequest({
    method: 'POST',
    url: 'http://127.0.0.1:' + settings.port + '/start-headless-download',
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify(body),
    timeout: 12000,
  }, jobId, function(r) {
    if (r.status >= 200 && r.status < 300) { return 'accepted'; }
    if (r.status >= 400 && r.status < 500) { return 'rejected'; }
    return 'unknown';
  }, item);
}

function sendBatchToABDM(batch, jobId) {
  let failures = 0;
  function sendOne(index) {
    if (!isLiveAbdm(jobId)) { return Promise.resolve({ cancelled: true, failures: failures }); }
    if (index >= batch.length) { return Promise.resolve({ cancelled: false, failures: failures }); }
    const item = batch[index];
    item.status = 'downloading';
    refreshBadge(item);
    updateStats();
    return sendItemToABDM(item, abdmActiveSettings, jobId).then(function(result) {
      if (!isLiveAbdm(jobId) || result === 'cancelled') {
        return { cancelled: true, failures: failures };
      }
      if (result === 'accepted') {
        item.status = 'sent';
      } else if (result === 'unknown') {
        item.status = 'uncertain';
        log('Status incerto no ABDM para ' + item.name +
          '; verifique o aplicativo antes de tentar enviar esse arquivo novamente.', 'lwrn');
      } else {
        failures++;
        item.status = 'error';
        log('O ABDM rejeitou ' + item.name + '.', 'lerr');
      }
      refreshBadge(item);
      updateStats();
      return sleep(160).then(function() {
        return sendOne(index + 1);
      });
    });
  }
  return sendOne(0);
}

function sendToIDM(items, jobId) {
  if (!items.length || jobId !== operationId) { return; }
  downloading = true;
  stopped = false;
  updateStats();
  log('Enviando ' + items.length + ' arquivo(s) para o IDM…', 'linf');
  let idx = 0;

  function getIdmFrame() {
    let frame = document.getElementById('anu-idm-frame');
    if (frame) { return frame; }
    frame = document.createElement('iframe');
    frame.id = 'anu-idm-frame';
    frame.name = 'anu-idm-frame';
    frame.allow = 'downloads';
    frame.style.position = 'fixed';
    frame.style.left = '-10000px';
    frame.style.top = '-10000px';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.style.opacity = '0';
    frame.style.border = '0';
    frame.style.pointerEvents = 'none';
    document.body.appendChild(frame);
    return frame;
  }

  function openWithIdm(url) {
    if (jobId !== operationId || stopped) { return; }
    const frame = getIdmFrame();
    const a = document.createElement('a');
    frame.src = 'about:blank';
    a.href = url;
    a.target = frame.name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    setTimeout(function() {
      if (jobId === operationId && !stopped) { a.click(); }
    }, 30);
    setTimeout(function() {
      if (a.parentNode) { a.parentNode.removeChild(a); }
    }, 1000);
  }

  function triggerNext() {
    if (stopped || jobId !== operationId) { return; }
    if (idx >= items.length) {
      downloading = false;
      activeDownloadPaths.clear();
      log('Solicitações enviadas ao IDM. A confirmação final depende do próprio IDM.', 'lok');
      updateStats();
      flushPendingFolder();
      return;
    }
    const item = items[idx++];
    item.status = 'downloading';
    refreshBadge(item);
    openWithIdm(getDownloadUrl(item));
    setTimeout(function() {
      if (stopped || jobId !== operationId) { return; }
      item.status = 'sent';
      refreshBadge(item);
      updateStats();
      triggerNext();
    }, IDM_TRIGGER_DELAY_MS);
  }
  triggerNext();
}

function finishAbdm(jobId) {
  if (!isLiveAbdm(jobId)) { return; }
  clearTimeout(abdmTimer);
  abdmTimer = null;
  clearAbdmCountdown();
  abdmNextAt = 0;
  abdmBatchInFlight = false;
  abdmSending = false;
  abdmActiveSettings = null;
  activeDownloadPaths.clear();
  const failures = abdmQueue.filter(function(item) { return item.status === 'error'; }).length;
  const uncertain = abdmQueue.filter(function(item) { return item.status === 'uncertain'; }).length;
  log(failures || uncertain
    ? 'Envio ao ABDM concluído: ' + failures + ' falha(s) e ' + uncertain +
      ' item(ns) com status incerto. Verifique os itens incertos no ABDM antes de reenviar.'
    : 'Todos os arquivos foram enviados para o ABDM.',
    failures || uncertain ? 'lwrn' : 'lok');
  updateAbdmControls();
  flushPendingFolder();
}

function scheduleNextAbdmBatch(jobId) {
  if (!isLiveAbdm(jobId) || !abdmActiveSettings) { return; }
  abdmBatchInFlight = false;
  clearTimeout(abdmTimer);
  clearAbdmCountdown();
  abdmNextAt = Date.now() + abdmActiveSettings.intervalMs;
  abdmTimer = setTimeout(function() {
    if (!isLiveAbdm(jobId)) { return; }
    abdmTimer = null;
    clearAbdmCountdown();
    abdmNextAt = 0;
    log('Intervalo concluído. Enviando o próximo lote…', 'linf');
    abdmSendNextBatch(jobId);
  }, abdmActiveSettings.intervalMs);
  abdmCountdownTimer = setInterval(updateAbdmCountdown, 1000);
  const remaining = abdmQueue.length - abdmOffset;
  log(remaining + ' arquivo(s) restante(s). Aguardando o intervalo entre lotes.', 'lwrn');
  updateAbdmControls();
}

function pauseAbdmBeforeBatch(jobId, message) {
  if (!isLiveAbdm(jobId)) { return; }
  abdmBatchInFlight = false;
  abdmSending = false;
  abdmActiveSettings = null;
  activeDownloadPaths.clear();
  log(message, 'lerr');
  updateAbdmControls();
  flushPendingFolder();
}

function abdmSendNextBatch(jobId) {
  jobId = jobId || abdmOperationId;
  if (!isLiveAbdm(jobId) || abdmBatchInFlight || !abdmActiveSettings) {
    updateAbdmControls();
    return;
  }
  clearTimeout(abdmTimer);
  abdmTimer = null;
  clearAbdmCountdown();
  abdmNextAt = 0;
  if (abdmOffset >= abdmQueue.length) { finishAbdm(jobId); return; }

  // Trava o lote antes do primeiro await para impedir clique duplo/duplicação.
  abdmBatchInFlight = true;
  const batchSize = abdmActiveSettings.batchSize;
  const batch = abdmQueue.slice(abdmOffset, abdmOffset + batchSize);
  const batchNum = Math.floor(abdmOffset / batchSize) + 1;
  const totalBatches = Math.ceil(abdmQueue.length / batchSize);
  updateAbdmControls();

  ensureFreshAbdmSession(jobId).then(function(sessionReady) {
    if (!isLiveAbdm(jobId)) { return; }
    if (!sessionReady) {
      pauseAbdmBeforeBatch(jobId,
        'A sessão não pôde ser renovada. Faça login e use “Retomar pendentes” para continuar.');
      return;
    }
    abdmPing(jobId).then(function(alive) {
      if (!isLiveAbdm(jobId)) { return; }
      if (!alive) {
        pauseAbdmBeforeBatch(jobId,
          'O ABDM não respondeu. Abra o aplicativo e use “Retomar pendentes” para continuar sem duplicar os já enviados.');
        return;
      }
      log('Lote ' + batchNum + '/' + totalBatches + ': enviando ' + batch.length + ' arquivo(s)…', 'linf');
      sendBatchToABDM(batch, jobId).then(function(result) {
        if (!isLiveAbdm(jobId) || result.cancelled) { return; }
        abdmOffset += batch.length;
        if (abdmOffset >= abdmQueue.length) {
          finishAbdm(jobId);
          return;
        }
        scheduleNextAbdmBatch(jobId);
      });
    });
  });
}

function sendToABDM(items, jobId) {
  if (!items.length || jobId !== operationId) { return; }
  abdmQueue = items.slice();
  abdmOffset = 0;
  abdmSending = true;
  abdmBatchInFlight = false;
  abdmOperationId = jobId;
  abdmActiveSettings = {
    port: getAbdmPort(),
    batchSize: getAbdmBatch(),
    intervalMs: getAbdmInterval() * 60 * 1000,
    queueId: G('anu-abdm-queue').value,
    folder: getAbdmFolder(),
  };
  stopped = false;
  clearTimeout(abdmTimer);
  abdmTimer = null;
  clearAbdmCountdown();
  log('Iniciando envio de ' + items.length + ' arquivo(s) em lotes de ' + abdmActiveSettings.batchSize + '.', 'linf');
  updateAbdmControls();
  abdmSendNextBatch(jobId);
}

G('b-abdm-next').onclick = function() {
  if (!isLiveAbdm(abdmOperationId) || abdmBatchInFlight || !abdmTimer) { return; }
  clearTimeout(abdmTimer);
  abdmTimer = null;
  clearAbdmCountdown();
  abdmNextAt = 0;
  log('Pulando a espera e enviando o próximo lote agora…', 'linf');
  abdmSendNextBatch(abdmOperationId);
};
G('b-abdm-stop').onclick = function() {
  if (!abdmSending) { return; }
  const uncertain = cancelCurrentOperation(true);
  log('Envio para o ABDM cancelado.' +
    (uncertain
      ? ' Verifique ' + uncertain + ' item(ns) em trânsito antes de reenviar.'
      : ''), 'lwrn');
};

function startDownloads(items) {
  if (!items.length || isBusy()) { return false; }
  const jobId = ++operationId;
  stopped = false;
  assignUniqueDownloadNames(items);
  activeDownloadPaths = new Set(items.map(function(f) { return f.path; }));
  lastOperationPaths = new Set(activeDownloadPaths);
  items.forEach(function(f) { f.status = 'pending'; f.retries = 0; });
  render();
  if (G('anu-abdm').checked) { sendToABDM(items, jobId); }
  else if (G('anu-idm').checked) { sendToIDM(items, jobId); }
  else { runQueue(items, jobId); }
  return true;
}

G('b-dl').onclick = function() {
  startDownloads(fileList.filter(function(f) {
    return !f.is_directory && selected.has(f.path);
  }));
};

G('b-retry').onclick = function() {
  startDownloads(fileList.filter(function(f) {
    return (f.status === 'error' && lastOperationPaths.has(f.path)) ||
      (f.status === 'pending' && lastOperationPaths.has(f.path));
  }));
};

let minimised = false;

function keepPanelInViewport() {
  const r = panel.getBoundingClientRect();
  if (panel.style.left) {
    panel.style.left = clamp(r.left, 0, Math.max(0, window.innerWidth - r.width)) + 'px';
  }
  if (panel.style.top) {
    panel.style.top = clamp(r.top, 0, Math.max(0, window.innerHeight - r.height)) + 'px';
  }
}

function savePanelState() {
  const r = panel.getBoundingClientRect();
  const previous = readJsonStorage(PANEL_STATE_KEY, {});
  if (window.innerWidth <= 680) {
    previous.minimised = minimised;
    writeJsonStorage(PANEL_STATE_KEY, previous);
    return;
  }
  writeJsonStorage(PANEL_STATE_KEY, {
    left: Math.round(r.left),
    top: Math.round(r.top),
    width: Math.round(r.width),
    minimised: minimised,
  });
}

function setPanelMinimised(value, persist) {
  minimised = !!value;
  G('anu-body').style.display = minimised ? 'none' : 'flex';
  G('anu-footer').style.display = minimised ? 'none' : 'flex';
  panel.classList.toggle('anu-minimised', minimised);
  const minButton = G('anu-min');
  const action = minimised ? 'Expandir painel' : 'Minimizar painel';
  minButton.innerHTML = '<span class="anu-ic" aria-hidden="true">' +
    (minimised ? ICON.expand : ICON.minimize) + '</span>';
  minButton.title = action;
  minButton.setAttribute('aria-label', action);
  minButton.setAttribute('aria-expanded', minimised ? 'false' : 'true');
  keepPanelInViewport();
  if (persist) { savePanelState(); }
}

function restorePanelState() {
  const state = readJsonStorage(PANEL_STATE_KEY, null);
  if (!state) { return; }
  if (window.innerWidth > 680) {
    const minWidth = Math.min(420, Math.max(280, window.innerWidth - 16));
    const maxWidth = Math.max(minWidth, window.innerWidth - 16);
    if (Number.isFinite(state.width)) {
      panel.style.width = clamp(state.width, minWidth, maxWidth) + 'px';
    }
    if (Number.isFinite(state.left) && Number.isFinite(state.top)) {
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = state.left + 'px';
      panel.style.top = state.top + 'px';
    }
  }
  setPanelMinimised(!!state.minimised, false);
  keepPanelInViewport();
}

G('anu-min').onclick = function() {
  setPanelMinimised(!minimised, true);
};

// ─── Ocultar/mostrar console (botão de olho no rodapé) ────────────────────────
let consoleHidden = false;
const consoleToggleBtn = G('anu-console-toggle');

function setConsoleHidden(value, persist) {
  consoleHidden = !!value;
  logEl.classList.toggle('anu-hidden', consoleHidden);
  consoleToggleBtn.innerHTML = '<span class="anu-ic" aria-hidden="true">' +
    (consoleHidden ? ICON.eyeOff : ICON.eyeOpen) + '</span>';
  consoleToggleBtn.classList.toggle('anu-off', consoleHidden);
  const action = consoleHidden ? 'Mostrar atividade' : 'Ocultar atividade';
  consoleToggleBtn.title = action;
  consoleToggleBtn.setAttribute('aria-label', action);
  consoleToggleBtn.setAttribute('aria-expanded', consoleHidden ? 'false' : 'true');
  if (persist) {
    setStorage(CONSOLE_HIDDEN_KEY, consoleHidden ? '1' : '0');
  }
}

consoleToggleBtn.onclick = function() {
  setConsoleHidden(!consoleHidden, true);
};

setConsoleHidden(getStorage(CONSOLE_HIDDEN_KEY, '1') === '1', false);

let drag = false, dragPointerId = null, ox = 0, oy = 0;
G('anu-header').addEventListener('pointerdown', function(e) {
  if (window.innerWidth <= 680 || e.button !== 0) { return; }
  if (e.target.closest && e.target.closest('button,input,select,label,a')) { return; }
  drag = true;
  dragPointerId = e.pointerId;
  const r = panel.getBoundingClientRect();
  ox = e.clientX - r.left;
  oy = e.clientY - r.top;
  try { G('anu-header').setPointerCapture(e.pointerId); } catch (err) {}
});
document.addEventListener('pointermove', function(e) {
  if (!drag || e.pointerId !== dragPointerId) { return; }
  const r = panel.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - r.width);
  const maxTop = Math.max(0, window.innerHeight - r.height);
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.left = clamp(e.clientX - ox, 0, maxLeft) + 'px';
  panel.style.top = clamp(e.clientY - oy, 0, maxTop) + 'px';
});
function finishPanelDrag(e) {
  if (!drag || (e && e.pointerId !== dragPointerId)) { return; }
  drag = false;
  dragPointerId = null;
  savePanelState();
}
document.addEventListener('pointerup', finishPanelDrag);
document.addEventListener('pointercancel', finishPanelDrag);
window.addEventListener('resize', debounce(function() {
  keepPanelInViewport();
  savePanelState();
}, 150));
restorePanelState();
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(debounce(function() {
    keepPanelInViewport();
    savePanelState();
  }, 250)).observe(panel);
}

window.addEventListener('beforeunload', function(e) {
  if (downloading || abdmSending || crawling) {
    e.preventDefault();
    e.returnValue = 'Há uma operação em andamento. Deseja sair?';
    return e.returnValue;
  }
});

let lastPath = '', reloadTimer = null;
const navObserver = new MutationObserver(function(mutations) {
  if (ignoreObserver) { return; }
  if (mutations.every(function(m) { return panel.contains(m.target); })) { return; }
  const path = getCurrentPath();
  if (path !== lastPath) {
    lastPath = path;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function() { loadFolder(path); }, 400);
  }
});
navObserver.observe(document.body, { childList: true, subtree: true });
log('Detecção automática ativa. Navegue por qualquer pasta para carregar automaticamente.', 'linf');
setTimeout(function() {
  const path = getCurrentPath();
  lastPath = path;
  loadFolder(path);
}, 500);

})();
