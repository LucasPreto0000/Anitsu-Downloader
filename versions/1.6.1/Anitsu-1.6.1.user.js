// ==UserScript==
// @name         Anitsu Downloader1
// @name:pt-BR   Anitsu Downloader1
// @namespace    https://nuvem.anitsu.moe/
// @version      1.6.1
// @description  Download em massa para o Anitsu Cloud (nuvem.anitsu.moe). Painel flutuante com seleção de arquivos, download direto ou via AB Download Manager, renovação automática de sessão, modo recursivo para baixar pastas inteiras e preview automático da capa do anime (via AniList).
// @description:pt-BR  Download em massa para o Anitsu Cloud (nuvem.anitsu.moe). Painel flutuante com seleção de arquivos, download direto ou via AB Download Manager, renovação automática de sessão, modo recursivo para baixar pastas inteiras e preview automático da capa do anime (via AniList).
// @author       TheCyBee & Saitama
// @match        https://nuvem.anitsu.moe/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      qzrxxwizigfdcpmwkztq.supabase.co
// @connect      graphql.anilist.co
// @run-at       document-idle
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
const FOLDER_CHANGE_DEBOUNCE_MS = 100;
const INITIAL_FOLDER_LOAD_DELAY_MS = 150;

const ABDM_PORT_KEY = 'anu-abdm-port';
const ABDM_BATCH_KEY = 'anu-abdm-batch';
const ABDM_INTERVAL_KEY = 'anu-abdm-interval';
const ABDM_FOLDER_KEY = 'anu-abdm-folder';
const ABDM_API_KEY_STORAGE = 'anu-abdm-api-key';
const EXT_FILTER_KEY = 'anu-ext-filter';
const DOWNLOADER_MODE_KEY = 'anu-downloader-mode';
const PANEL_STATE_KEY = 'anu-panel-state';
const CONSOLE_HIDDEN_KEY = 'anu-console-hidden';
const ABDM_SEND_RETRIES = 3;
const ABDM_SEND_RETRY_DELAY_MS = 1200;

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
let downloading = false;
let stopped = false;
let lastCheckedIndex = null;
let sessionRefreshing = false;
let sessionRefreshPromise = null;
let ignoreObserver = false;
let activeLoadId = 0;
let activeCrawlId = 0;
let crawling = false;
let extCacheRaw = null;
let extCacheList = [];

let abdmQueue = [];
let abdmOffset = 0;
let abdmTimer = null;
let abdmSending = false;
let abdmQueueTimer = null;
let abdmQueueLoading = false;
let abdmQueueRefreshRun = 0;
let abdmApiKeyModalOpen = false;
let abdmApiKeyTesting = false;
let lastAbdmAuthNoticeAt = 0;
let abdmAuthBlocked = false;
const apiCache = new Map();
const apiInflight = new Map();
const anilistCache = new Map(); // query -> { createdAt, media: {...} | null }
let activeAnilistId = 0;
const ANILIST_STRONG_MATCH = 0.90;
const ANILIST_MIN_MATCH = 0.62;
const ANILIST_MIN_MARGIN = 0.055;
const anilistInflight = new Map();
const anilistJobs = [];
let anilistBusy = false;
let anilistNextRequestAt = 0;
let anilistBatchSupported = true;
let folderLoading = false;
let hasLoadedFolder = false;
let currentFolderPath = '';
let requestedFolderPath = null;
const folderViews = new Map();
const animeOverrides = readJsonStorage('anu-anime-overrides', {}) || {};

// ─── Sessão ───────────────────────────────────────────────────────────────────
const AUTH_COOKIE_NAME = 'sb-' + SUPABASE_PROJECT + '-auth-token';

function getCookieMap() {
  const result = new Map();
  String(document.cookie || '').split(';').forEach(function(part) {
    const index = part.indexOf('=');
    if (index < 0) { return; }
    const name = part.slice(0, index).trim();
    if (name) { result.set(name, part.slice(index + 1).trim()); }
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
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
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
        let normalized = String(raw).trim();
        try { normalized = decodeURIComponent(normalized); } catch (e) {}
        const decoded = normalized.startsWith('{') || normalized.startsWith('[')
          ? JSON.parse(normalized)
          : decodeBase64Json(normalized);
        if (!decoded || (!decoded.access_token && !decoded.refresh_token)) { return; }
        if (!best || Number(decoded.expires_at || 0) >= Number(best.expires_at || 0)) {
          best = decoded;
        }
      } catch (e) {}
    });
    return best;
  } catch (e) { return null; }
}

function writeAuthData(data) {
  const encoded = encodeBase64Json(data);
  const chunks = [];
  for (let i = 0; i < encoded.length; i += 3400) { chunks.push(encoded.slice(i, i + 3400)); }
  const expires = new Date(Date.now() + SESSION_COOKIE_DAYS * 24 * 60 * 60 * 1000).toUTCString();
  const secureFlag = location.protocol === 'https:' ? '; Secure' : '';
  const sharedDomain = /(^|\.)anitsu\.moe$/i.test(location.hostname) ? '; domain=.anitsu.moe' : '';
  const maxAge = SESSION_COOKIE_DAYS * 24 * 60 * 60;
  const flags = '; path=/; expires=' + expires + '; Max-Age=' + maxAge +
    sharedDomain + '; SameSite=Lax' + secureFlag;
  const names = [AUTH_COOKIE_NAME];
  for (let i = 0; i < 12; i++) { names.push(AUTH_COOKIE_NAME + '.' + i); }
  names.forEach(function(name) {
    document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax' + secureFlag;
    if (sharedDomain) {
      document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT' +
        sharedDomain + '; SameSite=Lax' + secureFlag;
    }
  });
  if (chunks.length === 1) {
    document.cookie = AUTH_COOKIE_NAME + '=base64-' + chunks[0] + flags;
  } else {
    chunks.forEach(function(chunk, index) {
      document.cookie = AUTH_COOKIE_NAME + '.' + index + '=' +
        (index === 0 ? 'base64-' : '') + chunk + flags;
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
  btn.setAttribute('aria-busy', value ? 'true' : 'false');
  if (value) { txt.textContent = 'renovando…'; }
}

function refreshSession() {
  if (sessionRefreshPromise) { return sessionRefreshPromise; }
  const data = getAuthData();
  if (!data || !data.refresh_token) {
    log('⚠ Sem refresh_token. Recarregue a página e faça login novamente.', 'lwrn');
    return Promise.resolve(false);
  }
  sessionRefreshing = true;
  setSessionRefreshingUi(true);
  log('🔄 Renovando sessão…', 'linf');
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
              log('⚠ Falha ao renovar: ' +
                (body.error_description || body.error || ('HTTP ' + r.status)), 'lwrn');
              finish(false);
              return;
            }
            const minimal = {
              access_token: body.access_token,
              token_type: body.token_type || 'bearer',
              expires_in: body.expires_in,
              expires_at: body.expires_at ||
                Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
              refresh_token: body.refresh_token || data.refresh_token,
              user: body.user || data.user,
            };
            if (!writeAuthData(minimal)) {
              log('⚠ A sessão renovou, mas o navegador bloqueou o cookie persistente.', 'lwrn');
              finish(false);
              return;
            }
            clearApiCache();
            log('✓ Sessão renovada!', 'lok');
            finish(true);
          } catch (e) {
            log('⚠ Erro ao processar renovação: ' + e.message, 'lwrn');
            finish(false);
          }
        },
        onerror: function() {
          log('⚠ Erro de rede ao renovar sessão.', 'lwrn');
          finish(false);
        },
        ontimeout: function() {
          log('⚠ A renovação da sessão demorou demais.', 'lwrn');
          finish(false);
        },
        onabort: function() { finish(false); },
      });
    } catch (e) {
      log('⚠ Não foi possível iniciar a renovação: ' + e.message, 'lwrn');
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
  if (!bytes) { return '?'; }
  if (bytes > 1e9) { return (bytes / 1e9).toFixed(1) + ' GB'; }
  if (bytes > 1e6) { return (bytes / 1e6).toFixed(1) + ' MB'; }
  if (bytes > 1e3) { return (bytes / 1e3).toFixed(0) + ' KB'; }
  return bytes + ' B';
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
  safe = safe.replace(/[^\w\s.\-_()[\]àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß]/gi, '_');
  safe = safe.replace(/_+/g, '_');
  safe = safe.replace(/^[\s._]+|[\s._]+$/g, '');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe.split('.')[0])) { safe = '_' + safe; }
  if (safe.length > 200) {
    const match = safe.match(/\.[^.]+$/);
    const ext = match ? match[0] : '';
    safe = safe.slice(0, 200 - ext.length) + ext;
  }
  return safe || 'arquivo';
}

// Extrai um termo de busca "limpo" a partir do nome de uma pasta de release,
// removendo tags de grupo/fansub, resolução, codec, temporada/episódio, ano
// entre parênteses, etc. Ex.: "[SubGrupo] Attack on Titan S4 (1080p BD)"
// → "Attack on Titan".
function animeUnicode(value) {
  let text = String(value || '');
  if (text.normalize) { text = text.normalize('NFKC'); }
  return text.replace(/[‐‑‒–—―]/g, '-');
}

function foldAnimeText(value) {
  let text = animeUnicode(value).toLowerCase();
  if (text.normalize) {
    text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }
  return text
    .replace(/[×✕]/g, ' x ')
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractAnimeSeason(value) {
  const text = animeUnicode(value);
  const patterns = [
    /\bS(?:eason)?[\s._-]*0*(\d{1,2})(?=\s*E\d|\b)/i,
    /\b0*(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i,
    /\b(?:Season|Temporada)[\s._-]*0*(\d{1,2})\b/i,
    /\b0*(\d{1,2})\s*(?:ª|a)\s*Temporada\b/i,
    /第\s*0*(\d{1,2})\s*期/,
    /(?:^|\s)0*(\d{1,2})\s*期(?:\s|$)/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i]);
    if (match) {
      const season = parseInt(match[1], 10);
      if (season > 0 && season <= 99) { return season; }
    }
  }
  return null;
}

function extractAnimePart(value) {
  const match = animeUnicode(value).match(/\b(?:Part|Parte|Cour)[\s._-]*0*(\d{1,2})\b/i);
  if (!match) { return null; }
  const part = parseInt(match[1], 10);
  return part > 0 && part <= 99 ? part : null;
}

function extractAnimeYear(value) {
  const matches = animeUnicode(value).match(/\b(?:19|20)\d{2}\b/g);
  if (!matches || !matches.length) { return null; }
  const year = parseInt(matches[matches.length - 1], 10);
  return year >= 1940 && year <= new Date().getFullYear() + 2 ? year : null;
}

function removeAnimeTechNoise(value) {
  return animeUnicode(value)
    .replace(/\b(?:\d{3,4}p|4k|8k|\d{3,4}\s*x\s*\d{3,4})\b/gi, ' ')
    .replace(/\b(?:blu[\s._-]*ray|bd[\s._-]*rip|bdremux|bdmv|bdrip|web[\s._-]*dl|web[\s._-]*rip|hdtv|hdrip|dvdrip|remux|webrip)\b/gi, ' ')
    .replace(/\b(?:x26[45]|h[\s._-]*26[45]|hevc|avc|av1|hi10p|10[\s._-]*bit|8[\s._-]*bit|hdr10?|dolby[\s._-]*vision)\b/gi, ' ')
    .replace(/\b(?:aac|flac|opus|ac3|eac3|ddp|dts(?:[\s._-]*hd)?|truehd)\b/gi, ' ')
    .replace(/\b(?:dual[\s._-]*(?:audio|[áa]udio)|multi(?:ple)?[\s._-]*(?:audio|subtitles?)|multi[\s._-]*subs?|legendado|dublado)\b/gi, ' ')
    .replace(/\b(?:batch|complete|completo|uncensored|proper|repack|multi)\b/gi, ' ')
    .replace(/\b(?:bd|dvd|uhd|raws?|subs?|subtitle|subtitles)\b/gi, ' ');
}

function isAnimeTechnicalBlock(value) {
  const compact = animeUnicode(value).replace(/[^a-fA-F0-9]/g, '');
  if (/^[a-fA-F0-9]{8}$/.test(compact)) { return true; }
  return !foldAnimeText(removeAnimeTechNoise(value));
}

function isLikelyReleaseGroup(value) {
  return /\b(?:subsplease|erai[\s._-]*raws|judas|lostyears|fansub|anime[\s._-]*time|horriblesubs|ember|neohevc)\b/i
    .test(animeUnicode(value));
}

function isAnimeStructuralOnly(value) {
  const folded = foldAnimeText(removeAnimeTechNoise(value));
  if (!folded) { return true; }
  return /^(?:(?:season|temporada|part|parte|cour|s)\s*\d+|(?:episodes?|episodios?|capitulos?)|(?:final|complete|completo)|\d+(?:\s+\d+)*)$/i
    .test(folded);
}

function cleanAnimeReleaseName(value) {
  let name = animeUnicode(value).trim();
  if (!name) { return ''; }

  name = name.replace(/\.(?:mkv|mp4|avi|mov|wmv|webm|m4v|ts|m2ts|ass|srt|zip|rar|7z)$/i, ' ');

  // Preserva pontos oficiais como "Ver1.1a" enquanto normaliza separadores.
  const protectedVersions = [];
  name = name.replace(/\bVer\d+\.\d+[a-z]?\b/gi, function(match) {
    protectedVersions.push(match);
    return 'ANUVERSIONTOKEN' + (protectedVersions.length - 1) + 'TOKEN';
  });
  name = name.replace(/\b(?:Dr|Mr|Mrs|Ms|St)\./gi, function(match) {
    protectedVersions.push(match);
    return 'ANUVERSIONTOKEN' + (protectedVersions.length - 1) + 'TOKEN';
  });

  name = name.replace(/\[([^\]]*)\]/g, function(match, inside, offset, whole) {
    const before = whole.slice(0, offset).trim();
    const after = whole.slice(offset + match.length).trim();
    if (isAnimeTechnicalBlock(inside) || isLikelyReleaseGroup(inside)) { return ' '; }
    // Primeiro bloco seguido de um título costuma ser o grupo de release.
    if (!before && after && !isAnimeStructuralOnly(after)) { return ' '; }
    return ' ' + inside + ' '; // subtítulo legítimo, ex.: [Unlimited Blade Works]
  });

  name = name.replace(/\(([^)]*)\)/g, function(match, inside) {
    if (/^\s*(?:19|20)\d{2}\s*$/.test(inside) || isAnimeTechnicalBlock(inside)) { return ' '; }
    return ' ' + inside + ' ';
  });

  name = name
    .replace(/\bS(?:eason)?[\s._-]*0*(\d{1,2})\s*E(?:P(?:ISODE)?)?[\s._-]*\d+(?:\.\d+)?(?:v\d+)?\b/gi, ' Season $1 ')
    .replace(/\b0*(\d{1,2})\s*x\s*\d{1,4}\b/gi, ' Season $1 ')
    .replace(/\bS(?:eason)?[\s._-]*0*(\d{1,2})\b/gi, ' Season $1 ')
    .replace(/\b0*(\d{1,2})(?:st|nd|rd|th)\s+Season\b/gi, ' Season $1 ')
    .replace(/\b(?:Season|Temporada)[\s._-]*0*(\d{1,2})\b/gi, ' Season $1 ')
    .replace(/\b0*(\d{1,2})\s*(?:ª|a)\s*Temporada\b/gi, ' Season $1 ')
    .replace(/第\s*0*(\d{1,2})\s*期/g, ' Season $1 ')
    .replace(/\b(?:Part|Parte|Cour)[\s._-]*0*(\d{1,2})\b/gi, ' Part $1 ')
    .replace(/第\s*0*\d+(?:\.\d+)?\s*話/g, ' ')
    .replace(/\b(?:E|EP|Episode|Epis[oó]dio)[\s._-]*0*\d+(?:\.\d+)?(?:v\d+)?\b/gi, ' ')
    .replace(/\s+-\s*0*\d{1,4}(?:\.\d+)?(?:v\d+)?(?:\s*(?:END|FINAL))?\s*$/i, ' ')
    .replace(/\b0*\d{1,4}\s*-\s*0*\d{1,4}\b(?=\s*$)/i, ' ');

  name = removeAnimeTechNoise(name)
    .replace(/\s+(?:19|20)\d{2}\s*$/i, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-:|]+\s*$/g, ' ')
    .replace(/^\s*[-:|]+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  name = name.replace(/ANUVERSIONTOKEN(\d+)TOKEN/g, function(match, index) {
    return protectedVersions[Number(index)] || '';
  });
  return name.replace(/\s{2,}/g, ' ').trim();
}

function stripAnimeSeasonAndPart(value) {
  return animeUnicode(value)
    .replace(/\bSeason\s*\d{1,2}\b/gi, ' ')
    .replace(/\bPart\s*\d{1,2}\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isGenericAnimeFolder(value) {
  const folded = foldAnimeText(cleanAnimeReleaseName(value));
  if (!folded) { return true; }
  if (/^(?:anime|animes|filmes|movies|downloads?|colecao|collection|minha colecao|nova pasta|series|tv|legendado|dublado|dual audio|batch|completo|complete|episodios?|episodes?|capitulos?|chapters?|ovas?|specials?)$/i.test(folded)) {
    return true;
  }
  return /^(?:(?:season|temporada|part|parte|cour|s)\s*\d+|\d{3,4}p)$/i.test(folded);
}

function decodeAnimePathSegment(value) {
  try { return decodeURIComponent(value); } catch (e) { return value; }
}

function deriveAnimeContext(path) {
  const segments = String(path || '').split('/').filter(Boolean).map(decodeAnimePathSegment);
  let season = null;
  let part = null;
  let year = null;
  let title = '';

  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (season === null) { season = extractAnimeSeason(segment); }
    if (part === null) { part = extractAnimePart(segment); }
    if (year === null) { year = extractAnimeYear(segment); }
    if (isGenericAnimeFolder(segment)) { continue; }

    const cleaned = cleanAnimeReleaseName(segment);
    const base = stripAnimeSeasonAndPart(cleaned);
    if (base && !isGenericAnimeFolder(base)) {
      title = cleaned;
      break;
    }
  }

  if (!title) { return null; }
  if (season && !extractAnimeSeason(title)) { title += ' Season ' + season; }
  if (part && !extractAnimePart(title)) { title += ' Part ' + part; }

  const baseTitle = stripAnimeSeasonAndPart(title).replace(/\s{2,}/g, ' ').trim();
  if (!baseTitle || isGenericAnimeFolder(baseTitle)) { return null; }

  const queries = [baseTitle];
  const simpler = baseTitle.split(/\s+(?:-|:)\s+/)[0].trim();
  if (simpler.length >= 3 && foldAnimeText(simpler) !== foldAnimeText(baseTitle) && !isGenericAnimeFolder(simpler)) {
    queries.push(simpler);
  }

  return {
    title: title,
    baseTitle: baseTitle,
    normalizedTitle: foldAnimeText(title),
    normalizedBaseTitle: foldAnimeText(baseTitle),
    queries: queries,
    season: season,
    part: part,
    year: year,
  };
}

function animeNgramDice(a, b) {
  const left = foldAnimeText(a).replace(/\s/g, '');
  const right = foldAnimeText(b).replace(/\s/g, '');
  if (left === right) { return left ? 1 : 0; }
  if (left.length < 2 || right.length < 2) { return 0; }
  const grams = new Map();
  for (let i = 0; i < left.length - 1; i++) {
    const gram = left.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  let matches = 0;
  for (let i = 0; i < right.length - 1; i++) {
    const gram = right.slice(i, i + 2);
    const count = grams.get(gram) || 0;
    if (count > 0) {
      matches++;
      grams.set(gram, count - 1);
    }
  }
  return (2 * matches) / ((left.length - 1) + (right.length - 1));
}

function animeTitleSimilarity(a, b) {
  const left = foldAnimeText(a);
  const right = foldAnimeText(b);
  if (!left || !right) { return 0; }
  if (left === right) { return 1; }

  const leftTokens = Array.from(new Set(left.split(' ').filter(Boolean)));
  const rightTokens = Array.from(new Set(right.split(' ').filter(Boolean)));
  let intersection = 0;
  leftTokens.forEach(function(token) {
    if (rightTokens.includes(token)) { intersection++; }
  });
  const precision = intersection / Math.max(1, rightTokens.length);
  const recall = intersection / Math.max(1, leftTokens.length);
  const tokenF1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const dice = animeNgramDice(left, right);
  let score = tokenF1 * 0.62 + dice * 0.38;

  const smaller = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const larger = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
  const subset = smaller.every(function(token) { return larger.includes(token); });
  if (subset) {
    const ratio = smaller.length / Math.max(1, larger.length);
    score = Math.max(score, 0.70 + 0.20 * ratio);
  }
  return Math.min(1, score);
}

function getAnimeAliases(media) {
  const aliases = [];
  if (media && media.title) {
    aliases.push(media.title.english, media.title.romaji, media.title.native);
  }
  if (media && Array.isArray(media.synonyms)) {
    Array.prototype.push.apply(aliases, media.synonyms);
  }
  return Array.from(new Set(aliases.filter(Boolean).map(function(value) {
    return animeUnicode(value).trim();
  }).filter(Boolean)));
}

function scoreAnimeCandidate(media, context, searchIndex) {
  const aliases = getAnimeAliases(media);
  if (!aliases.length) { return null; }

  let fullSimilarity = 0;
  let baseSimilarity = 0;
  let exactFull = false;
  let exactBase = false;
  const candidateSeasons = new Set();
  const candidateParts = new Set();

  aliases.forEach(function(alias) {
    const normalized = foldAnimeText(alias);
    fullSimilarity = Math.max(fullSimilarity, animeTitleSimilarity(context.normalizedTitle, normalized));
    baseSimilarity = Math.max(baseSimilarity, animeTitleSimilarity(context.normalizedBaseTitle, normalized));
    if (normalized === context.normalizedTitle) { exactFull = true; }
    if (normalized === context.normalizedBaseTitle) { exactBase = true; }
    const aliasSeason = extractAnimeSeason(alias);
    const aliasPart = extractAnimePart(alias);
    if (aliasSeason) { candidateSeasons.add(aliasSeason); }
    if (aliasPart) { candidateParts.add(aliasPart); }
  });

  if (context.season && candidateSeasons.size && !candidateSeasons.has(context.season)) { return null; }
  if (context.part && candidateParts.size && !candidateParts.has(context.part)) { return null; }

  const candidateYear = Number(media.seasonYear || (media.startDate && media.startDate.year)) || null;
  if (context.year && candidateYear && Math.abs(context.year - candidateYear) > 1) { return null; }

  const baseTokenCount = context.normalizedBaseTitle.split(' ').filter(Boolean).length;
  if (baseTokenCount <= 1 && !exactBase && !exactFull) { return null; }

  let score = Math.max(fullSimilarity, baseSimilarity * 0.86);
  if (exactFull) { score = Math.max(score, 1); }
  if (exactBase && !context.season && !context.part) { score = Math.max(score, 0.97); }

  if (context.season) {
    if (candidateSeasons.has(context.season)) { score += 0.14; }
    else if (exactBase && context.season > 1) { score -= 0.18; }
    else if (context.season > 1) { score -= 0.07; }
    else { score += 0.03; }
  }
  if (context.part) {
    if (candidateParts.has(context.part)) { score += 0.09; }
    else if (exactBase && context.part > 1) { score -= 0.12; }
  }
  if (context.year && candidateYear) { score += 0.12; }

  score += Math.max(0, 0.03 - searchIndex * 0.004);
  if (media.popularity) {
    score += Math.min(0.015, Math.log10(Math.max(10, media.popularity)) * 0.003);
  }

  return {
    media: media,
    score: score,
    exact: exactFull || exactBase,
  };
}

function selectBestAnimeCandidate(candidates, context) {
  const ranked = candidates.map(function(media, index) {
    return scoreAnimeCandidate(media, context, index);
  }).filter(Boolean).sort(function(a, b) {
    return b.score - a.score;
  });

  if (!ranked.length || ranked[0].score < ANILIST_MIN_MATCH) { return null; }
  if (ranked.length > 1) {
    const margin = ranked[0].score - ranked[1].score;
    if (ranked[0].score < ANILIST_STRONG_MATCH && margin < ANILIST_MIN_MARGIN) { return null; }
  }
  return ranked[0];
}

// Mantida como utilitário simples para qualquer chamada antiga.
function guessAnimeTitle(folderName) {
  const context = deriveAnimeContext(folderName);
  return context && context.queries.length ? context.queries[0] : '';
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
  return { files: item.files.map(cloneFile) };
}

function setCachedApi(path, files) {
  apiCache.set(String(path || ''), {
    createdAt: Date.now(),
    files: (files || []).map(cloneFile),
  });
}

function clearApiCache(path) {
  if (typeof path === 'string') {
    apiCache.delete(path);
    apiInflight.delete(path);
    return;
  }
  apiCache.clear();
  apiInflight.clear();
}

// Breadcrumb: SPA nunca muda URL. Pastas pai = <button>, atual = <span>.
// O span não usa trim() para preservar espaços no nome da pasta (o servidor
// pode ter pastas com espaço no final e o path precisa ser exato).
function getBreadcrumb() {
  return document.querySelector('nav[aria-label*="breadcrumb" i], nav[aria-label*="navega" i], nav[data-testid*="breadcrumb" i]') ||
    Array.from(document.querySelectorAll('nav')).find(function(nav) {
      return Array.from(nav.querySelectorAll('button, a')).some(function(el) {
        return /^(home|início|inicio)$/i.test(el.textContent.trim());
      });
    });
}

function getCurrentPath() {
  const nav = getBreadcrumb();
  if (!nav) { return currentFolderPath; }
  const parts = [];
  nav.querySelectorAll('button, a, span').forEach(function(el) {
    if (el.parentElement.closest('button, a') && el.tagName === 'SPAN') { return; }
    if (el.tagName === 'SPAN' && el.querySelector('span, button, a')) { return; }
    if (el.closest('[aria-hidden="true"]')) { return; }
    const text = el.textContent;
    if (!text || !text.trim() || /^(home|início|inicio|cadê meu anime\?|[\/›>»])$/i.test(text.trim())) { return; }
    parts.push(text);
  });
  return parts.join('/');
}

function mkBadge(status) {
  const map = {
    pending: ['bp', 'aguardando'],
    done: ['bd', '✓ concluído'],
    sent_abdm: ['bd', '↗ enviado ao ABDM'],
    sent_idm: ['bd', '↗ encaminhado ao IDM'],
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
  const pending = apiInflight.get(key);
  if (pending) {
    return pending.then(function(data) {
      return { files: (data.files || []).map(cloneFile) };
    });
  }

  attempt = attempt || 0;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const options = { credentials: 'include' };
  let timeout = null;
  if (controller) {
    options.signal = controller.signal;
    timeout = setTimeout(function() { controller.abort(); }, API_TIMEOUT_MS);
  }

  const request = fetch('/api/files?path=' + encodeURIComponent(key), options).then(function(r) {
    if (r.status === 401 && !retry) {
      apiInflight.delete(key);
      return refreshSession().then(function() { return apiFetch(key, true, 0); });
    }
    if ((r.status === 429 || r.status === 503) && attempt < MAX_RETRIES) {
      apiInflight.delete(key);
      return sleep(backoffDelay(attempt)).then(function() {
        return apiFetch(key, retry, attempt + 1);
      });
    }
    if (!r.ok) { throw new Error('HTTP ' + r.status + ' em /' + (key || 'raiz')); }
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error('Resposta não é JSON em /' + (path || 'raiz') + ' — sessão expirada?');
    }
    return r.json();
  }).then(function(data) {
    const files = Array.isArray(data.files) ? data.files.map(function(f) {
      return {
        name: f.name || 'arquivo',
        path: f.path || makeChildPath(key, f.name || 'arquivo'),
        size: Number(f.size) || 0,
        is_directory: !!f.is_directory,
      };
    }) : [];
    setCachedApi(key, files);
    return { files: files.map(cloneFile) };
  }).catch(function(e) {
    if (e && e.name === 'AbortError') {
      throw new Error('Tempo esgotado ao carregar /' + (key || 'raiz') + '. Tente novamente.');
    }
    throw e;
  }).finally(function() {
    if (timeout) { clearTimeout(timeout); }
    apiInflight.delete(key);
  });

  apiInflight.set(key, request);
  return request.then(function(data) {
    return { files: (data.files || []).map(cloneFile) };
  });
}

function dlUrl(path) { return BASE_URL + '/api/download?path=' + encodeURIComponent(path); }

function getDownloadUrl(item) {
  if (typeof item === 'string') { return dlUrl(item); }
  if (!item.downloadUrl) { item.downloadUrl = dlUrl(item.path); }
  return item.downloadUrl;
}

function getAbdmPort() { return String(parseIntSafe(localStorage.getItem(ABDM_PORT_KEY), 15151, 1, 65535)); }
function getAbdmBatch() { return parseIntSafe(localStorage.getItem(ABDM_BATCH_KEY), 5, 1, 999); }
function getAbdmInterval() { return parseIntSafe(localStorage.getItem(ABDM_INTERVAL_KEY), 30, 1, 999); }
function getAbdmFolder() { return localStorage.getItem(ABDM_FOLDER_KEY) || ''; }

function getAbdmApiKey() {
  try {
    return String(GM_getValue(ABDM_API_KEY_STORAGE, '') || '').trim();
  } catch (e) {
    return '';
  }
}

function saveAbdmApiKey(value) {
  const key = String(value || '').trim();
  try { GM_setValue(ABDM_API_KEY_STORAGE, key); } catch (e) {}
  return key;
}

// A chave autentica a chamada ao servidor local do ABDM. O cookie abaixo,
// enviado dentro do JSON, continua autenticando o arquivo no Anitsu.
function getAbdmRequestHeaders(includeJson, overrideKey) {
  const headers = {};
  if (includeJson) { headers['Content-Type'] = 'application/json'; }
  const key = overrideKey === undefined ? getAbdmApiKey() : String(overrideKey || '').trim();
  if (key) { headers['X-Api-Key'] = key; }
  return headers;
}

function isAbdmAuthStatus(status) {
  return Number(status) === 401;
}

// ─── Preview de anime (AniList) ────────────────────────────────────────────────
const ANILIST_FIELDS = 'id title { romaji english native } synonyms seasonYear startDate { year } popularity coverImage { medium large } averageScore episodes format siteUrl';
const ANILIST_QUERY = 'query ($search: String) { Page(perPage: 10) { media(search: $search, type: ANIME) { ' + ANILIST_FIELDS + ' } } }';
const ANILIST_ID_QUERY = 'query ($id: Int) { Media(id: $id, type: ANIME) { ' + ANILIST_FIELDS + ' } }';
const persistedAnimeCache = readJsonStorage('anu-anime-cache-v3', []);
if (Array.isArray(persistedAnimeCache)) {
  persistedAnimeCache.slice(-150).forEach(function(entry) {
    if (Array.isArray(entry) && entry[1] && Date.now() - entry[1].createdAt < ANILIST_CACHE_MS) {
      anilistCache.set(entry[0], entry[1]);
    }
  });
}

function getCachedAnilist(key) {
  const item = anilistCache.get(key);
  if (!item) { return undefined; }
  const ttl = item.media && item.media.length ? ANILIST_CACHE_MS : ANILIST_MISS_CACHE_MS;
  if (Date.now() - item.createdAt > ttl) { anilistCache.delete(key); return undefined; }
  return item.media;
}

function runAnimeJobs() {
  if (anilistBusy || !anilistJobs.length) { return; }
  anilistBusy = true;
  setTimeout(function() {
    const jobs = anilistJobs.splice(0, anilistBatchSupported ? 6 : 1);
    const batched = jobs.length > 1;
    let finished = false;
    function finish(results, cacheable) {
      if (finished) { return; }
      finished = true;
      jobs.forEach(function(job, index) {
        const candidates = results[index] || [];
        if (cacheable) {
          anilistCache.set(job.key, { createdAt: Date.now(), media: candidates });
          while (anilistCache.size > 150) { anilistCache.delete(anilistCache.keys().next().value); }
        }
        anilistInflight.delete(job.key);
        job.resolve(candidates);
      });
      if (cacheable) { writeJsonStorage('anu-anime-cache-v3', Array.from(anilistCache)); }
      anilistBusy = false;
      anilistNextRequestAt = Math.max(anilistNextRequestAt, Date.now() + 2200);
      runAnimeJobs();
    }
    function retry(delay, disableBatch) {
      if (finished) { return; }
      finished = true;
      if (disableBatch) { anilistBatchSupported = false; }
      const pending = jobs.filter(function(job) { return (job.attempts || 0) < 2; });
      pending.forEach(function(job) { job.attempts = (job.attempts || 0) + 1; });
      jobs.filter(function(job) { return !pending.includes(job); }).forEach(function(job) {
        anilistInflight.delete(job.key);
        job.resolve([]);
      });
      anilistJobs.unshift.apply(anilistJobs, pending);
      anilistBusy = false;
      anilistNextRequestAt = Math.max(anilistNextRequestAt, Date.now() + delay);
      runAnimeJobs();
    }
    try {
      const variables = {};
      let query = jobs[0].id ? ANILIST_ID_QUERY : ANILIST_QUERY;
      if (batched) {
        const declarations = [];
        const fields = jobs.map(function(job, index) {
          const alias = 'r' + index;
          const variable = 'v' + index;
          variables[variable] = job.id || job.query;
          declarations.push('$' + variable + ': ' + (job.id ? 'Int' : 'String'));
          return job.id
            ? alias + ': Media(id: $' + variable + ', type: ANIME) { ' + ANILIST_FIELDS + ' }'
            : alias + ': Page(perPage: 10) { media(search: $' + variable + ', type: ANIME) { ' + ANILIST_FIELDS + ' } }';
        });
        query = 'query (' + declarations.join(', ') + ') { ' + fields.join(' ') + ' }';
      } else {
        variables[jobs[0].id ? 'id' : 'search'] = jobs[0].id || jobs[0].query;
      }
      GM_xmlhttpRequest({
        method: 'POST', url: ANILIST_API_URL,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        data: JSON.stringify({ query: query, variables: variables }),
        timeout: ANILIST_TIMEOUT_MS,
        onload: function(r) {
          if (r.status === 429) {
            retry(60000, false); return;
          }
          try {
            const body = JSON.parse(r.responseText);
            if (r.status < 200 || r.status >= 300 || body.errors || !body.data) {
              retry(2200, batched); return;
            }
            const results = jobs.map(function(job, index) {
              const value = batched ? body.data['r' + index]
                : job.id ? body.data.Media : body.data.Page;
              const candidates = job.id ? (value ? [value] : []) : value && value.media;
              return Array.isArray(candidates) ? candidates : [];
            });
            finish(results, true);
          } catch (e) { retry(2200, batched); }
        },
        onerror: function() { retry(5000, false); },
        ontimeout: function() { retry(5000, false); },
        onabort: function() { retry(5000, false); },
      });
    } catch (e) { retry(5000, false); }
  }, Math.max(0, anilistNextRequestAt - Date.now()));
}

function fetchAnilistCandidates(query, priority) {
  const idMatch = String(query).match(/^(?:https:\/\/anilist\.co\/anime\/)?(\d+)(?:\/.*)?$/);
  const id = idMatch ? Number(idMatch[1]) : null;
  const key = id ? 'id:' + id : foldAnimeText(query);
  const cached = getCachedAnilist(key);
  if (cached !== undefined) { return Promise.resolve(cached); }
  if (anilistInflight.has(key)) {
    if (priority) {
      const index = anilistJobs.findIndex(function(job) { return job.key === key; });
      if (index > 0) { anilistJobs.unshift(anilistJobs.splice(index, 1)[0]); }
    }
    return anilistInflight.get(key);
  }
  const promise = new Promise(function(resolve) {
    const job = { key: key, query: query, id: id, resolve: resolve };
    if (priority) { anilistJobs.unshift(job); } else { anilistJobs.push(job); }
  });
  anilistInflight.set(key, promise);
  runAnimeJobs();
  return promise;
}

function getAnimeOverride(path) {
  let current = path;
  while (current) {
    if (Object.prototype.hasOwnProperty.call(animeOverrides, current)) { return animeOverrides[current]; }
    current = current.slice(0, Math.max(0, current.lastIndexOf('/')));
  }
  return '';
}

function fetchAnilistMedia(path, priority) {
  const override = getAnimeOverride(path);
  const context = deriveAnimeContext(override || path);
  if (!context && !override) { return Promise.resolve(null); }
  const query = override || context.queries[0];
  return fetchAnilistCandidates(query, priority).then(function(candidates) {
    if (/^(?:https:\/\/anilist\.co\/anime\/)?\d+(?:\/.*)?$/.test(query)) { return candidates[0] || null; }
    const selected = context && selectBestAnimeCandidate(candidates, context);
    return selected ? selected.media : null;
  });
}

function correctAnime(path) {
  const value = window.prompt('Anime desta pasta: informe o nome, ID ou link do AniList. Deixe vazio para voltar à detecção automática.', getAnimeOverride(path));
  if (value === null) { return; }
  if (value.trim()) { animeOverrides[path] = value.trim(); } else { delete animeOverrides[path]; }
  writeJsonStorage('anu-anime-overrides', animeOverrides);
  render();
  updateAnimePreview(currentFolderPath);
}

function addFolderCover(icon, file) {
  icon.title = 'Corrigir anime: clique com o botão direito';
  icon.oncontextmenu = function(event) {
    event.preventDefault(); event.stopPropagation(); correctAnime(file.path);
  };
  function load() {
    fetchAnilistMedia(file.path, false).then(function(media) {
      if (!icon.isConnected || !media || !media.coverImage) { return; }
      const url = media.coverImage.medium || media.coverImage.large;
      if (!url || !/^https:\/\//i.test(url)) { return; }
      const img = document.createElement('img');
      img.alt = (media.title && (media.title.romaji || media.title.english)) || file.name;
      img.style.cssText = 'width:30px;height:42px;object-fit:cover;border-radius:5px;display:block';
      img.onload = function() {
        if (!icon.isConnected) { return; }
        icon.textContent = ''; icon.appendChild(img);
        icon.style.cssText = 'width:30px;min-width:30px;height:42px;padding:0;background:transparent';
      };
      img.src = url;
    });
  }
  load();
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
  'position:relative;overflow:visible;z-index:4;}' +
  '#anu-header::before{content:"";position:absolute;inset:0;' +
  'background:linear-gradient(90deg,transparent,rgba(255,255,255,0.03),transparent);' +
  'animation:anu-shimmer 8s ease infinite;background-size:200% 100%;border-radius:inherit;pointer-events:none;}' +
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
  '#anu-body{display:flex;flex-direction:column;overflow-y:auto;flex:1;}' +

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
  '.ab{background:linear-gradient(135deg,#5b7cff,#7c6cff);color:#fff;border-color:rgba(108,140,255,0.2);' +
  'box-shadow:0 2px 12px rgba(108,140,255,0.2);}' +
  '.ab:hover:not(:disabled){box-shadow:0 4px 20px rgba(108,140,255,0.35);}' +
  '.ag{background:linear-gradient(135deg,#10b981,#34d399);color:#fff;border-color:rgba(52,211,153,0.2);' +
  'box-shadow:0 2px 12px rgba(52,211,153,0.15);}' +
  '.ag:hover:not(:disabled){box-shadow:0 4px 20px rgba(52,211,153,0.3);}' +
  '.ar{background:linear-gradient(135deg,#ef4444,#f87171);color:#fff;border-color:rgba(248,113,113,0.2);' +
  'box-shadow:0 2px 12px rgba(248,113,113,0.15);}' +
  '.ar:hover:not(:disabled){box-shadow:0 4px 20px rgba(248,113,113,0.3);}' +
  '.ay{background:linear-gradient(135deg,#d97706,#f59e0b);color:#fff;border-color:rgba(251,191,36,0.2);' +
  'box-shadow:0 2px 12px rgba(251,191,36,0.12);}' +
  '.ay:hover:not(:disabled){box-shadow:0 4px 20px rgba(251,191,36,0.25);}' +
  '.agr{background:rgba(255,255,255,0.04);color:' + C.text + ';' +
  'border:1px solid ' + C.border + ';backdrop-filter:blur(4px);}' +
  '.agr:hover:not(:disabled){background:rgba(255,255,255,0.07);border-color:' + C.borderLight + ';}' +
  '.am{background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;border-color:rgba(167,139,250,0.2);' +
  'box-shadow:0 2px 12px rgba(167,139,250,0.15);}' +
  '.am:hover:not(:disabled){box-shadow:0 4px 20px rgba(167,139,250,0.3);}' +

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
  '.anu-switch-track::after{content:"";position:absolute;top:50%;left:1px;width:13px;height:13px;' +
  'border-radius:50%;background:#c7cede;transition:all .25s cubic-bezier(.4,0,.2,1);' +
  'box-shadow:0 1px 3px rgba(0,0,0,.4);transform:translateY(-50%);}' +
  '.anu-switch input:checked ~ .anu-switch-track{background:linear-gradient(135deg,#5b7cff,#7c6cff);' +
  'border-color:transparent;}' +
  '.anu-switch input:checked ~ .anu-switch-track::after{transform:translate(12px,-50%);background:#fff;}' +
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
  '#anu-abdm-cfg input[type=number]{appearance:textfield;-moz-appearance:textfield;}' +
  '#anu-abdm-cfg input[type=number]::-webkit-inner-spin-button,' +
  '#anu-abdm-cfg input[type=number]::-webkit-outer-spin-button{' +
  '-webkit-appearance:none;margin:0;}' +
  '#anu-abdm-cfg input:focus,#anu-abdm-cfg select:focus{border-color:' + C.accent + ';}' +
  '#anu-abdm-key-open{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;' +
  'border:1px solid ' + C.border + ';border-radius:8px;background:rgba(255,255,255,.04);' +
  'color:' + C.text + ';font:600 11px "Inter",sans-serif;cursor:pointer;transition:all .2s ease;}' +
  '#anu-abdm-key-open:hover{background:rgba(255,255,255,.08);border-color:' + C.borderLight + ';}' +
  '#anu-abdm-key-state{color:' + C.amber + ';font-weight:600;}' +
  '#anu-abdm-key-state.anu-key-ok{color:' + C.green + ';}' +

  // ABDM API key dialog. Kept outside the panel so no edge can clip it.
  '#anu-abdm-key-modal{position:fixed;inset:0;z-index:100003;display:flex;align-items:center;' +
  'justify-content:center;padding:20px;background:rgba(3,5,11,.74);backdrop-filter:blur(8px);' +
  '-webkit-backdrop-filter:blur(8px);opacity:0;visibility:hidden;pointer-events:none;' +
  'transition:opacity .2s ease,visibility .2s ease;font-family:"Inter",system-ui,sans-serif;}' +
  '#anu-abdm-key-modal.anu-open{opacity:1;visibility:visible;pointer-events:auto;}' +
  '#anu-abdm-key-dialog{width:min(440px,calc(100vw - 32px));border-radius:16px;padding:20px;' +
  'background:rgba(15,18,30,.98);color:' + C.text + ';border:1px solid ' + C.borderLight + ';' +
  'box-shadow:0 30px 90px rgba(0,0,0,.7),0 0 45px rgba(99,102,241,.18);' +
  'transform:translateY(10px) scale(.98);transition:transform .2s ease;}' +
  '#anu-abdm-key-modal.anu-open #anu-abdm-key-dialog{transform:translateY(0) scale(1);}' +
  '#anu-abdm-key-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}' +
  '#anu-abdm-key-head h2{margin:0;font-size:16px;line-height:1.3;color:' + C.text + ';}' +
  '#anu-abdm-key-close{width:28px;height:28px;flex:0 0 28px;border-radius:8px;border:1px solid ' + C.border + ';' +
  'background:rgba(255,255,255,.04);color:' + C.textMid + ';cursor:pointer;font-size:18px;line-height:1;}' +
  '#anu-abdm-key-close:hover{color:' + C.text + ';background:rgba(255,255,255,.08);}' +
  '#anu-abdm-key-description{margin:10px 0 12px;color:' + C.textMid + ';font-size:12px;line-height:1.55;}' +
  '#anu-abdm-key-path{margin:0 0 13px;padding:9px 10px;border-radius:9px;background:' + C.accentDim + ';' +
  'color:' + C.accentLight + ';font-size:11px;line-height:1.45;border:1px solid rgba(130,148,255,.16);}' +
  '#anu-abdm-key-input{box-sizing:border-box;width:100%;height:38px;padding:0 12px;border-radius:9px;' +
  'border:1px solid ' + C.borderLight + ';background:' + C.bgInput + ';color:' + C.text + ';outline:none;' +
  'font:500 13px "JetBrains Mono",Consolas,monospace;letter-spacing:.4px;}' +
  '#anu-abdm-key-input:focus{border-color:' + C.accent + ';box-shadow:0 0 0 3px ' + C.accentDim + ';}' +
  '#anu-abdm-key-error{min-height:18px;margin:7px 0 2px;color:#fca5a5;font-size:11px;line-height:1.4;}' +
  '#anu-abdm-key-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;}' +
  '#anu-abdm-key-actions button{min-height:34px;padding:7px 13px;border-radius:9px;font:600 12px "Inter",sans-serif;cursor:pointer;}' +
  '#anu-abdm-key-later{border:1px solid ' + C.border + ';background:rgba(255,255,255,.04);color:' + C.textMid + ';}' +
  '#anu-abdm-key-save{border:0;background:linear-gradient(135deg,#5b7cff,#7c6cff);color:#fff;' +
  'box-shadow:0 4px 16px rgba(108,140,255,.25);}' +
  '#anu-abdm-key-actions button:disabled{opacity:.5;cursor:wait;}' +

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
  '#anu-list{overflow-y:auto;overflow-x:hidden;flex:1;min-width:0;min-height:150px;max-height:260px;}' +
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
  '.bp{background:' + C.accentDim + ';color:#93c5fd;border-color:rgba(108,140,255,0.1);}' +
  '.bd{background:' + C.greenDim + ';color:#6ee7b7;border-color:rgba(52,211,153,0.15);}' +
  '.be{background:' + C.redDim + ';color:#fca5a5;border-color:rgba(248,113,113,0.15);}' +
  '.ba{background:' + C.amberDim + ';color:#fde68a;border-color:rgba(251,191,36,0.15);' +
  'animation:anu-badgePop .25s ease both,anu-pulse 2s ease infinite;}' +
  '.bf{background:rgba(255,255,255,0.03);color:' + C.textMid + ';border-color:' + C.border + ';}' +

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
  '.lok{color:' + C.green + ';}' +
  '.lerr{color:' + C.red + ';}' +
  '.linf{color:' + C.accent + ';}' +
  '.lwrn{color:' + C.amber + ';}' +

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
  '.agr{background:rgba(255,255,255,.045);}' +
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
  '[data-tip]{position:relative;}' +
  '[data-tip]::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;' +
  'transform:translateX(-50%) translateY(4px);white-space:nowrap;pointer-events:none;' +
  'background:#1a1d28;color:' + C.text + ';font-size:11px;font-weight:500;font-family:"Inter",sans-serif;' +
  'padding:6px 10px;border-radius:7px;border:1px solid ' + C.borderLight + ';' +
  'box-shadow:0 8px 24px rgba(0,0,0,.5);opacity:0;visibility:hidden;' +
  'transition:opacity .15s ease,transform .15s ease;z-index:100;letter-spacing:.2px;}' +
  '[data-tip]::before{content:"";position:absolute;bottom:100%;left:50%;transform:translateX(-50%) translateY(2px);' +
  'border:5px solid transparent;border-top-color:#1a1d28;opacity:0;visibility:hidden;' +
  'transition:opacity .15s ease;pointer-events:none;z-index:100;}' +
  '[data-tip]:hover::after,[data-tip]:hover::before{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0);}' +
  '.anu-dl-one[data-tip]::after{left:auto;right:0;transform:translateY(4px);}' +
  '.anu-dl-one[data-tip]::before{left:auto;right:7px;transform:translateY(2px);}' +
  '.anu-dl-one[data-tip]:hover::after,.anu-dl-one[data-tip]:hover::before{transform:translateY(0);}' +
  // Left-edge controls keep their tooltips anchored inside the panel.
  '#anu-abdm-label[data-tip]::after,#anu-idm-label[data-tip]::after,#anu-console-toggle[data-tip]::after{' +
  'left:0;right:auto;transform:translateY(4px);}' +
  '#anu-abdm-label[data-tip]::before,#anu-idm-label[data-tip]::before{' +
  'left:22px;right:auto;transform:translateY(2px);}' +
  '#anu-console-toggle[data-tip]::before{left:8px;right:auto;transform:translateY(2px);}' +
  '#anu-abdm-label[data-tip]:hover::after,#anu-abdm-label[data-tip]:hover::before,' +
  '#anu-idm-label[data-tip]:hover::after,#anu-idm-label[data-tip]:hover::before,' +
  '#anu-console-toggle[data-tip]:hover::after,#anu-console-toggle[data-tip]:hover::before{' +
  'transform:translateY(0);}' +
  // Header tooltips open downward and align to the right so they stay inside the panel.
  '#anu-header [data-tip]::after{top:calc(100% + 8px);right:0;bottom:auto;left:auto;' +
  'transform:translateY(-4px);}' +
  '#anu-header [data-tip]::before{top:100%;right:8px;bottom:auto;left:auto;' +
  'transform:translateY(-2px);border-top-color:transparent;border-bottom-color:#1a1d28;}' +
  '#anu-header [data-tip]:hover::after,#anu-header [data-tip]:hover::before{transform:translateY(0);}' +
  // With the panel collapsed, keep the tooltip inside the header, to the left.
  '#anu-panel.anu-minimised #anu-header [data-tip]::after{top:50%;right:calc(100% + 8px);bottom:auto;left:auto;' +
  'width:max-content;max-width:200px;white-space:normal;text-align:center;transform:translate(4px,-50%);}' +
  '#anu-panel.anu-minimised #anu-header [data-tip]::before{top:50%;right:100%;bottom:auto;left:auto;' +
  'transform:translate(2px,-50%);border-bottom-color:transparent;border-left-color:#1a1d28;}' +
  '#anu-panel.anu-minimised #anu-header [data-tip]:hover::after{transform:translate(0,-50%);}' +
  '#anu-panel.anu-minimised #anu-header [data-tip]:hover::before{transform:translate(0,-50%);}'
);

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
panel.innerHTML =
  '<div id="anu-header">' +
    '<h3>' +
      '<span class="anu-logo-icon">🎌</span>' +
      '<span class="anu-logo-text">Anitsu Downloader</span>' +
    '</h3>' +
    '<button id="anu-session" class="ok" data-tip="Clique para renovar a sessão" title="Status da sessão"><span class="anu-ic">' + ICON.pulse + '</span><span id="anu-session-txt">sessão ok</span></button>' +
    '<button id="anu-min" data-tip="Minimizar" title="Minimizar">' + ICON.minimize + '</button>' +
  '</div>' +
  '<div id="anu-body">' +
    '<div id="anu-pathbar"><span class="anu-path-icon anu-ic">' + ICON.folderPath + '</span> Navegue até uma pasta para carregar. <b id="anu-cp"></b></div>' +
    '<a id="anu-anime-preview" href="#" target="_blank" rel="noopener" style="display:none">' +
      '<img id="anu-anime-cover" alt="" />' +
      '<div class="anu-anime-info">' +
        '<span id="anu-anime-title"></span>' +
        '<span id="anu-anime-meta"></span>' +
      '</div>' +
    '</a>' +
    '<div id="anu-toolbar">' +
      '<div id="anu-toolbar-top">' +
        '<div class="anu-primary-actions">' +
          '<button id="b-load" class="ab"><span class="anu-ic">' + ICON.reload + '</span>Carregar</button>' +
          '<button id="b-recurse" class="am"><span class="anu-ic">' + ICON.layers + '</span>Tudo de uma vez</button>' +
          '<div class="anu-selection-actions">' +
            '<button id="b-all" class="agr"><span class="anu-ic">' + ICON.checkAll + '</span>Todos</button>' +
            '<button id="b-none" class="agr"><span class="anu-ic">' + ICON.square + '</span>Nenhum</button>' +
          '</div>' +
        '</div>' +
        '<div class="anu-download-managers">' +
          '<label id="anu-abdm-label" data-tip="Enviar para o AB Download Manager" title="Usar o AB Download Manager ao invés de baixar diretamente">' +
            '<span class="anu-switch"><input type="checkbox" id="anu-abdm" /><span class="anu-switch-track"></span></span> ABDM' +
          '</label>' +
          '<label id="anu-idm-label" data-tip="Enviar para o Internet Download Manager" title="Usar o Internet Download Manager (IDM)">' +
            '<span class="anu-switch"><input type="checkbox" id="anu-idm" /><span class="anu-switch-track"></span></span> IDM' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div id="anu-toolbar-bot">' +
        '<button id="b-dl" class="ag" disabled><span class="anu-ic">' + ICON.download + '</span>Baixar</button>' +
        '<button id="b-retry" class="ay" disabled><span class="anu-ic">' + ICON.retry + '</span>Repetir falhas</button>' +
        '<button id="b-stop" class="ar" disabled><span class="anu-ic">' + ICON.stop + '</span>Parar</button>' +
      '</div>' +
    '</div>' +
    '<div id="anu-abdm-cfg">' +
      '<div class="anu-cfg-row">' +
        '<label>Porta:</label>' +
        '<input id="anu-abdm-port" type="number" min="1" max="65535" style="width:72px" placeholder="15151" />' +
        '<label>Lote:</label>' +
        '<input id="anu-abdm-batch" type="number" min="1" max="999" style="width:56px" placeholder="5" />' +
        '<label>Intervalo&nbsp;(min):</label>' +
        '<input id="anu-abdm-intv" type="number" min="1" max="999" style="width:56px" placeholder="30" />' +
        '<label>Fila:</label>' +
        '<select id="anu-abdm-queue" style="flex:1;min-width:0">' +
          '<option value="">— sem fila —</option>' +
        '</select>' +
      '</div>' +
      '<div class="anu-cfg-row" style="margin-top:4px">' +
        '<label>Pasta destino:</label>' +
        '<input id="anu-abdm-folder" placeholder="ex: D:/Downloads/Animes  (vazio = padrão do ABDM)" style="flex:1" />' +
      '</div>' +
      '<div id="anu-abdm-auth-row" class="anu-cfg-row" style="margin-top:4px">' +
        '<label>Autenticação:</label>' +
        '<button id="anu-abdm-key-open" type="button" title="Configurar a chave API do ABDM">' +
          'Chave API <b id="anu-abdm-key-state">sem chave</b>' +
        '</button>' +
      '</div>' +
    '</div>' +
    '<div id="anu-abdm-ctrl">' +
      '<button id="b-abdm-next" class="ab" style="display:none"><span class="anu-ic">' + ICON.skip + '</span>Próximo lote agora</button>' +
      '<button id="b-abdm-stop" class="ar" style="display:none"><span class="anu-ic">' + ICON.stop + '</span>Cancelar envio</button>' +
    '</div>' +
    '<div id="anu-filter">' +
      '<label><span class="anu-ic">' + ICON.filter + '</span> Extensão:</label>' +
      '<input id="anu-ext" placeholder=".mkv,.mp4  (vazio = todos os arquivos)" />' +
    '</div>' +
    '<div id="anu-stats">' +
      '<span><span class="anu-stat-icon anu-ic">' + ICON.statFiles + '</span>Arquivos: <b id="st">0</b></span>' +
      '<span><span class="anu-stat-icon anu-ic">' + ICON.statSelected + '</span>Selecionados: <b id="ss">0</b></span>' +
      '<span><span class="anu-stat-icon anu-ic">' + ICON.statDone + '</span>Concluídos: <b id="sd">0</b></span>' +
      '<span title="Arquivos encaminhados ao gerenciador; confira o término nele.">Enviados: <b id="se">0</b></span>' +
      '<span><span class="anu-stat-icon anu-ic">' + ICON.statFail + '</span>Falhas: <b id="sf">0</b></span>' +
      '<span><span class="anu-stat-icon anu-ic">' + ICON.statSize + '</span>Tamanho: <b id="sz">—</b></span>' +
    '</div>' +
    '<div id="anu-prog"><div id="anu-fill"></div></div>' +
    '<div id="anu-list">' +
      '<div class="anu-empty">' +
        '<span class="anu-empty-icon anu-ic">' + ICON.emptyBox + '</span>' +
        'Navegue até uma pasta para carregar automaticamente.' +
      '</div>' +
    '</div>' +
    '<div id="anu-log"><span class="linf">✦ Pronto.</span></div>' +
  '</div>' +
  '<div id="anu-footer">' +
    '<button id="anu-console-toggle" data-tip="Mostrar/ocultar console" title="Mostrar/ocultar console">' + ICON.eyeOpen + '</button>' +
    '<span id="anu-footer-credit">✦ by TheCyBee &amp; Saitama</span>' +
  '</div>';

document.body.appendChild(panel);

const abdmKeyModal = document.createElement('div');
abdmKeyModal.id = 'anu-abdm-key-modal';
abdmKeyModal.setAttribute('aria-hidden', 'true');
abdmKeyModal.innerHTML =
  '<div id="anu-abdm-key-dialog" role="dialog" aria-modal="true" aria-labelledby="anu-abdm-key-title">' +
    '<div id="anu-abdm-key-head">' +
      '<h2 id="anu-abdm-key-title">Chave API do AB Download Manager</h2>' +
      '<button id="anu-abdm-key-close" type="button" aria-label="Fechar" title="Fechar">×</button>' +
    '</div>' +
    '<p id="anu-abdm-key-description">O ABDM 1.10 ou mais recente pode proteger a integração local com uma chave. Ela só é necessária quando a opção <b>Usar chave API</b> está ativada.</p>' +
    '<p id="anu-abdm-key-path"><b>Onde encontrar:</b> ABDM → Configurações → Integração com Navegadores → Chave API</p>' +
    '<input id="anu-abdm-key-input" type="password" autocomplete="off" spellcheck="false" aria-label="Chave API do ABDM" placeholder="Cole aqui a chave API" />' +
    '<div id="anu-abdm-key-error" role="status" aria-live="polite"></div>' +
    '<div id="anu-abdm-key-actions">' +
      '<button id="anu-abdm-key-later" type="button">Agora não</button>' +
      '<button id="anu-abdm-key-save" type="button">Salvar e verificar</button>' +
    '</div>' +
  '</div>';
document.body.appendChild(abdmKeyModal);

requestAnimationFrame(function() {
  requestAnimationFrame(function() { panel.classList.add('anu-mounted'); });
});

function G(id) { return document.getElementById(id); }
const listEl = G('anu-list');
const logEl = G('anu-log');
const extEl = G('anu-ext');
extEl.value = localStorage.getItem(EXT_FILTER_KEY) || '';

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
}

function updateAbdmApiKeyStatus(invalid) {
  const state = G('anu-abdm-key-state');
  const row = G('anu-abdm-auth-row');
  if (!state || !row) { return; }
  const configured = !!getAbdmApiKey();
  state.textContent = invalid && configured ? 'chave inválida' : (configured ? 'configurada' : 'sem chave');
  state.classList.toggle('anu-key-ok', configured && !invalid);
  row.style.display = configured && !invalid ? 'none' : 'flex';
}

function setAbdmApiKeyModalBusy(value) {
  abdmApiKeyTesting = !!value;
  G('anu-abdm-key-save').disabled = abdmApiKeyTesting;
  G('anu-abdm-key-later').disabled = abdmApiKeyTesting;
  G('anu-abdm-key-close').disabled = abdmApiKeyTesting;
  G('anu-abdm-key-save').textContent = abdmApiKeyTesting ? 'Verificando…' : 'Salvar e verificar';
}

function showAbdmApiKeyModal(message) {
  const wasOpen = abdmApiKeyModalOpen;
  abdmApiKeyModalOpen = true;
  abdmKeyModal.classList.add('anu-open');
  abdmKeyModal.setAttribute('aria-hidden', 'false');
  G('anu-abdm-key-error').textContent = message || '';
  if (!wasOpen) { G('anu-abdm-key-input').value = ''; }
  setTimeout(function() { G('anu-abdm-key-input').focus(); }, 30);
}

function hideAbdmApiKeyModal() {
  if (abdmApiKeyTesting) { return; }
  abdmApiKeyModalOpen = false;
  abdmKeyModal.classList.remove('anu-open');
  abdmKeyModal.setAttribute('aria-hidden', 'true');
  G('anu-abdm-key-input').value = '';
  G('anu-abdm-key-error').textContent = '';
}

function probeAbdmApiKey(apiKey) {
  return new Promise(function(resolve) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'http://127.0.0.1:' + getAbdmPort() + '/ping',
      headers: getAbdmRequestHeaders(true, apiKey),
      data: 'null',
      timeout: 4000,
      onload: function(r) {
        resolve({
          ok: r.status >= 200 && r.status < 300,
          auth: isAbdmAuthStatus(r.status),
          status: Number(r.status) || 0,
        });
      },
      onerror: function() { resolve({ ok: false, auth: false, status: 0 }); },
      ontimeout: function() { resolve({ ok: false, auth: false, status: 0 }); },
    });
  });
}

function handleAbdmAuthFailure(action) {
  const now = Date.now();
  if (now - lastAbdmAuthNoticeAt > 1500) {
    log('✗ O ABDM recusou a chave API' + (action ? ' ao ' + action : '') + '. Informe a chave correta.', 'lerr');
    lastAbdmAuthNoticeAt = now;
  }
  updateAbdmApiKeyStatus(true);
  showAbdmApiKeyModal('Chave ausente ou incorreta. Copie novamente a chave mostrada no ABDM.');
}

G('anu-abdm-key-open').onclick = function() {
  showAbdmApiKeyModal(getAbdmApiKey()
    ? 'Já existe uma chave salva. Cole uma nova chave para substituí-la.'
    : 'Cole a chave exibida nas configurações do ABDM.');
};
G('anu-abdm-key-close').onclick = hideAbdmApiKeyModal;
G('anu-abdm-key-later').onclick = hideAbdmApiKeyModal;
G('anu-abdm-key-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); G('anu-abdm-key-save').click(); }
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && abdmApiKeyModalOpen) { hideAbdmApiKeyModal(); }
});

G('anu-abdm-key-save').onclick = function() {
  if (abdmApiKeyTesting) { return; }
  const candidate = G('anu-abdm-key-input').value.trim();
  if (!candidate) {
    G('anu-abdm-key-error').textContent = 'Cole uma chave antes de continuar.';
    G('anu-abdm-key-input').focus();
    return;
  }

  G('anu-abdm-key-error').textContent = '';
  setAbdmApiKeyModalBusy(true);
  probeAbdmApiKey(candidate).then(function(result) {
    setAbdmApiKeyModalBusy(false);
    if (result.auth) {
      G('anu-abdm-key-error').textContent = 'O ABDM recusou essa chave. Confira e tente novamente.';
      G('anu-abdm-key-input').select();
      return;
    }

    saveAbdmApiKey(candidate);
    updateAbdmApiKeyStatus();
    hideAbdmApiKeyModal();
    if (result.ok) {
      log('✓ Chave API do ABDM salva e verificada.', 'lok');
    } else {
      log('Chave API salva. Não foi possível testá-la porque o ABDM não respondeu.', 'lwrn');
    }
    if (G('anu-abdm').checked) { startAbdmQueueAutoRefresh(); }
  });
};

updateAbdmApiKeyStatus();

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
  const done = files.filter(function(f) { return f.status === 'done'; }).length;
  const fail = files.filter(function(f) { return f.status === 'error'; }).length;
  const progressDone = progressFiles.filter(function(f) {
    return f.status === 'done' || f.status === 'error' || f.status === 'sent_abdm' || f.status === 'sent_idm';
  }).length;
  G('st').textContent = files.length;
  G('ss').textContent = selected.size;
  G('sd').textContent = done;
  G('se').textContent = files.filter(function(f) { return f.status === 'sent_abdm' || f.status === 'sent_idm'; }).length;
  G('sf').textContent = fail;
  G('sz').textContent = selected.size > 0 ? fmt(totalSize(selected)) : '—';
  const pct = progressFiles.length ? Math.round(progressDone / progressFiles.length * 100) : 0;
  const busy = downloading || abdmSending || crawling || folderLoading;
  const fillEl = G('anu-fill');
  fillEl.style.width = pct + '%';
  // Green when complete
  if (pct >= 100 && !busy) {
    fillEl.classList.add('anu-done');
  } else {
    fillEl.classList.remove('anu-done');
  }
  G('b-dl').disabled = selected.size === 0 || busy;
  G('b-retry').disabled = fail === 0 || busy;
  G('b-stop').disabled = !(downloading || abdmSending || crawling);
  G('b-recurse').disabled = busy;
}

function formatCountdown(s) {
  if (s <= 0) { return 'expirada'; }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'min' : m + 'min';
}

function updateSessionIndicator() {
  const btn = G('anu-session');
  const txt = G('anu-session-txt');
  const data = getAuthData();
  if (!data || !data.expires_at) {
    btn.className = 'exp';
    txt.textContent = 'sem sessão';
    btn.setAttribute('data-tip', 'Sessão ausente. Entre pelo Discord uma vez.');
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
  btn.setAttribute('data-tip', s > 0
    ? 'Sessão: ' + formatCountdown(s) + '. Clique para renovar agora.'
    : 'Sessão expirada. Clique para tentar renovar.');
}

setInterval(updateSessionIndicator, 30000);
updateSessionIndicator();

function setSessionRefreshLock() {
  try { localStorage.setItem(SESSION_REFRESH_LOCK_KEY, String(Date.now())); } catch (e) {}
}

function requestAutomaticSessionRefresh(delay) {
  setTimeout(function() {
    const latest = getAuthData();
    if (!latest || !latest.refresh_token) { return; }
    const secondsLeft = Number(latest.expires_at || 0) - Date.now() / 1000;
    if (secondsLeft >= 10 * 60 || sessionRefreshing) { return; }
    try {
      const lastRefresh = Number(localStorage.getItem(SESSION_REFRESH_LOCK_KEY) || 0);
      if (Date.now() - lastRefresh < SESSION_REFRESH_COOLDOWN_MS) { return; }
    } catch (e) {}
    setSessionRefreshLock();
    refreshSession().then(updateSessionIndicator);
  }, Math.max(0, Number(delay) || 0));
}

function initialisePersistentSession() {
  const data = getAuthData();
  if (!data || !data.refresh_token) { return; }
  if (!writeAuthData(data)) {
    log('⚠ O navegador não permitiu manter a sessão salva. Verifique os cookies do Anitsu.', 'lwrn');
    return;
  }
  const secondsLeft = Number(data.expires_at || 0) - Date.now() / 1000;
  if (secondsLeft < 10 * 60) { requestAutomaticSessionRefresh(900); }
}

G('anu-session').onclick = function() {
  setSessionRefreshLock();
  refreshSession().then(updateSessionIndicator);
};
initialisePersistentSession();

setInterval(function() {
  const data = getAuthData();
  if (!data || !data.expires_at) { return; }
  const secondsLeft = data.expires_at - Date.now() / 1000;
  if (secondsLeft < 10 * 60) {
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
      const iconWrap = document.createElement('span');
      iconWrap.className = 'anu-ficon anu-ficon-folder';
      iconWrap.innerHTML = ICON.folder;
      addFolderCover(iconWrap, f);
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
      row.onclick = function() {
        if (folderLoading) { return; }
        const clickedInSite = clickFolderInSite(f.name);
        if (!clickedInSite) {
          log('⚠ Não encontrei "' + f.name + '" na página para navegar o site também — carregando só no painel.', 'lwrn');
        }
        loadFolder(f.path);
      };
    } else {
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = selected.has(f.path);
      chk.dataset.index = index;
      chk.onchange = function(e) {
        const ci = parseInt(chk.dataset.index, 10);
        if (e.shiftKey && lastCheckedIndex !== null && lastCheckedIndex !== ci) {
          const start = Math.min(lastCheckedIndex, ci);
          const end = Math.max(lastCheckedIndex, ci);
          const allChk = listEl.querySelectorAll('input[type=checkbox]');
          for (let i = start; i <= end; i++) {
            const cb = allChk[i];
            if (!cb) { continue; }
            cb.checked = chk.checked;
            const f2 = fileList[parseInt(cb.dataset.index, 10)];
            if (f2) {
              if (chk.checked) { selected.add(f2.path); } else { selected.delete(f2.path); }
            }
          }
        } else {
          if (chk.checked) { selected.add(f.path); } else { selected.delete(f.path); }
        }
        lastCheckedIndex = ci;
        updateStats();
      };
      row.onclick = function(e) {
        if (e.target === chk) { return; }
        chk.checked = !chk.checked;
        chk.onchange(e);
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
      button.title = 'Baixar este arquivo';
      button.setAttribute('data-tip', 'Baixar este arquivo');
      button.innerHTML = ICON.downloadSm;
      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(badgeWrap.firstChild);
      row.appendChild(button);
      button.onclick = function(e) {
        e.stopPropagation();
        f.status = 'pending'; f.retries = 0;
        refreshBadge(f);
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
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(type) {
    try {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
  });
}

// Tenta localizar, na UI real do site (fora do painel), o elemento clicável
// que representa a pasta com o nome informado, e clica nele — assim o site
// também navega para dentro da pasta, não só o painel.
function clickFolderInSite(name) {
  const candidates = Array.from(document.querySelectorAll(
    'main [role="button"], main button, main a, main li, main div[tabindex], [data-testid*="folder" i], [data-testid*="item" i]'
  )).filter(function(el) { return !panel.contains(el); });

  let target = null;
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    const text = (el.textContent || '').trim();
    if (text === name) { target = el; break; }
  }
  if (!target) {
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const text = (el.textContent || '').trim();
      if (text.includes(name)) { target = el; break; }
    }
  }
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

function hideAnimePreview() {
  activeAnilistId++;
  G('anu-anime-preview').style.display = 'none';
}

// Usa o nome da pasta atual como termo de busca no AniList e mostra a capa,
// título e nota do anime encontrado (se houver). Cancela silenciosamente se
// o usuário já tiver navegado para outra pasta enquanto a busca corria.
function updateAnimePreview(path) {
  hideAnimePreview();
  const anilistId = ++activeAnilistId;
  if (!path) { hideAnimePreview(); return; }
  fetchAnilistMedia(path, true).then(function(media) {
    if (anilistId !== activeAnilistId) { return; } // pasta mudou nesse meio-tempo
    if (!media) { hideAnimePreview(); return; }
    const title = (media.title && (media.title.english || media.title.romaji || media.title.native)) || path;
    const cover = media.coverImage && (media.coverImage.medium || media.coverImage.large);
    const metaParts = [];
    if (media.format) { metaParts.push(media.format); }
    if (media.episodes) { metaParts.push(media.episodes + ' ep.'); }
    if (media.averageScore) { metaParts.push('★ ' + (media.averageScore / 10).toFixed(1)); }

    const el = G('anu-anime-preview');
    G('anu-anime-cover').src = cover || '';
    G('anu-anime-title').textContent = title;
    G('anu-anime-meta').textContent = metaParts.join(' · ');
    el.href = media.siteUrl || '#';
    el.title = 'Abrir no AniList • Botão direito para corrigir o anime';
    el.oncontextmenu = function(event) { event.preventDefault(); correctAnime(path); };
    el.style.display = 'flex';
  });
}

function loadFolder(path) {
  path = String(path || '');
  if (folderLoading && requestedFolderPath === path) { return; }
  const loadId = ++activeLoadId;
  if (!folderLoading && hasLoadedFolder) {
    folderViews.set(currentFolderPath, { files: fileList, selected: Array.from(selected) });
    while (folderViews.size > 80) { folderViews.delete(folderViews.keys().next().value); }
  }
  requestedFolderPath = path;
  const cached = getCachedApi(path);
  function commit(data) {
    if (loadId !== activeLoadId) { return; }
    const view = folderViews.get(path);
    const previous = new Map(view ? view.files.map(function(f) { return [f.path, f]; }) : []);
    fileList = (data.files || []).map(function(f) {
      const full = f.path || makeChildPath(path, f.name);
      return Object.assign(previous.get(full) || { status: 'pending', retries: 0 }, f, { path: full });
    });
    selected = new Set(fileList.filter(function(f) {
      return !f.is_directory && passes(f.name) && (!view || view.selected.includes(f.path));
    }).map(function(f) { return f.path; }));
    currentFolderPath = path;
    hasLoadedFolder = true;
    requestedFolderPath = null;
    folderLoading = false;
    listEl.inert = false;
    listEl.style.opacity = '';
    listEl.setAttribute('aria-busy', 'false');
    G('anu-cp').textContent = path || 'raiz';
    lastCheckedIndex = null;
    render();
    updateAnimePreview(path);
    const folders = fileList.filter(function(f) { return f.is_directory; }).length;
    log('Carregado — ' + (fileList.length - folders) + ' arquivo(s), ' + folders + ' pasta(s)', 'lok');
  }
  if (cached) { commit(cached); return; }
  folderLoading = true;
  listEl.inert = true;
  listEl.style.opacity = '0.55';
  listEl.setAttribute('aria-busy', 'true');
  G('anu-cp').textContent = (path || 'raiz') + ' — carregando…';
  hideAnimePreview();
  if (!fileList.length) { renderSkeleton(); }
  updateStats();
  apiFetch(path).then(commit).catch(function(e) {
    if (loadId !== activeLoadId) { return; }
    requestedFolderPath = null;
    folderLoading = false;
    listEl.inert = false;
    listEl.style.opacity = '';
    listEl.setAttribute('aria-busy', 'false');
    G('anu-cp').textContent = currentFolderPath || 'raiz';
    log('Erro ao carregar pasta: ' + e.message + '. A lista anterior foi mantida.', 'lerr');
    render();
    updateAnimePreview(currentFolderPath);
  });
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
  if (crawling || downloading || abdmSending || folderLoading) { return; }
  const path = getCurrentPath();
  const crawlId = ++activeCrawlId;
  crawling = true;
  stopped = false;
  G('b-recurse').disabled = true;
  G('b-recurse').textContent = '⏳ Buscando…';
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
    G('anu-pathbar').childNodes[0].textContent = '';
    render();
    log('Busca concluída — ' + acc.length + ' arquivo(s), ' + stats.folders +
      ' pasta(s), ' + stats.errors + ' erro(s).', stats.errors ? 'lwrn' : 'lok');
  }).catch(function(e) {
    log('Erro na busca: ' + e.message, 'lerr');
  }).finally(function() {
    if (crawlId === activeCrawlId) {
      crawling = false;
      G('b-recurse').disabled = false;
      G('b-recurse').innerHTML = '<span class="anu-ic">' + ICON.layers + '</span>Tudo de uma vez';
      updateStats();
    }
  });
};

G('b-load').onclick = function() { clearApiCache(getCurrentPath()); loadFolder(getCurrentPath()); };
G('b-all').onclick = function() {
  fileList.forEach(function(f) {
    if (!f.is_directory && passes(f.name)) { selected.add(f.path); }
  });
  render();
};
G('b-none').onclick = function() { selected.clear(); render(); };
extEl.addEventListener('input', debounce(function() {
  try { localStorage.setItem(EXT_FILTER_KEY, extEl.value); } catch (e) {}
  selected.clear();
  fileList.forEach(function(f) {
    if (!f.is_directory && passes(f.name)) { selected.add(f.path); }
  });
  render();
}, 180));

G('b-stop').onclick = function() {
  stopped = true;
  downloading = false;
  crawling = false;
  activeCrawlId++;
  clearTimeout(abdmTimer);
  abdmTimer = null;
  abdmSending = false;
  abdmQueue = [];
  abdmOffset = 0;
  activeDownloadPaths.clear();
  G('b-recurse').innerHTML = '<span class="anu-ic">' + ICON.layers + '</span>Tudo de uma vez';
  updateAbdmControls();
  log('Parado pelo usuário.', 'lwrn');
  updateStats();
};

function dlFile(item) {
  return new Promise(function(resolve) {
    if (stopped) { resolve(); return; }
    item.status = 'downloading';
    refreshBadge(item);
    log('↓ ' + item.name, 'linf');
    GM_download({
      url: getDownloadUrl(item),
      name: sanitizeName(item.name),
      onload: function() {
        item.status = 'done'; refreshBadge(item);
        log('✓ ' + item.name, 'lok');
        updateStats(); updateSessionIndicator(); resolve();
      },
      onerror: function(err) {
        const maybeAuth = err && (err.error === 401 || err.error === 403 ||
          (err.details && err.details.includes('401')));
        if (maybeAuth && item.retries === 0) {
          log('⚠ Sessão expirada — renovando…', 'lwrn');
          refreshSession().then(function() {
            item.retries++; item.status = 'pending';
            setTimeout(function() { dlFile(item).then(resolve); }, RETRY_DELAY_MS);
          });
          return;
        }
        if (item.retries < MAX_RETRIES) {
          item.retries++; item.status = 'pending';
          log('⚠ Tentativa ' + item.retries + '/' + MAX_RETRIES + ': ' + item.name, 'lwrn');
          setTimeout(function() { dlFile(item).then(resolve); }, backoffDelay(item.retries - 1));
        } else {
          item.status = 'error'; refreshBadge(item);
          log('✗ Falhou após ' + MAX_RETRIES + ' tentativas: ' + item.name, 'lerr');
          updateStats(); resolve();
        }
      },
    });
  });
}

function runQueue(items) {
  if (!items.length) { return; }
  downloading = true; stopped = false; updateStats();
  let idx = 0;
  function worker() {
    return new Promise(function(resolveWorker) {
      function next() {
        if (idx >= items.length || stopped) { resolveWorker(); return; }
        const item = items[idx++];
        if (item.status !== 'pending') { next(); return; }
        dlFile(item).then(next);
      }
      next();
    });
  }
  const workers = [];
  const workerCount = Math.min(CONCURRENCY, items.length);
  for (let i = 0; i < workerCount; i++) { workers.push(worker()); }
  Promise.all(workers).then(function() {
    downloading = false;
    activeDownloadPaths.clear();
    if (stopped) {
      log('Fila interrompida.', 'lwrn');
      updateStats();
      return;
    }
    const fail = items.filter(function(f) { return f.status === 'error'; }).length;
    log(fail ? 'Concluído. ' + fail + ' falha(s) — clique em "Repetir falhas".'
             : '✓ Todos os downloads concluídos!', fail ? 'lwrn' : 'lok');
    updateStats();
  });
}

G('anu-abdm-port').value = getAbdmPort();
G('anu-abdm-batch').value = getAbdmBatch();
G('anu-abdm-intv').value = getAbdmInterval();
G('anu-abdm-folder').value = getAbdmFolder();

G('anu-abdm-port').onchange = function() {
  const v = parseInt(G('anu-abdm-port').value, 10);
  if (v > 0 && v <= 65535) {
    localStorage.setItem(ABDM_PORT_KEY, v);
    if (G('anu-abdm').checked) { startAbdmQueueAutoRefresh(); }
  }
};
G('anu-abdm-batch').onchange = function() {
  const v = parseInt(G('anu-abdm-batch').value, 10);
  if (v > 0) { localStorage.setItem(ABDM_BATCH_KEY, v); }
};
G('anu-abdm-intv').onchange = function() {
  const v = parseInt(G('anu-abdm-intv').value, 10);
  if (v > 0) { localStorage.setItem(ABDM_INTERVAL_KEY, v); }
};
G('anu-abdm-folder').oninput = function() {
  localStorage.setItem(ABDM_FOLDER_KEY, G('anu-abdm-folder').value.trim());
};

function applyDownloaderMode(mode, refreshQueues) {
  const useAbdm = mode === 'abdm';
  const useIdm = mode === 'idm';
  G('anu-abdm').checked = useAbdm;
  G('anu-idm').checked = useIdm;
  G('anu-abdm-cfg').style.display = useAbdm ? 'flex' : 'none';
  if (useAbdm && refreshQueues) { startAbdmQueueAutoRefresh(); }
  else { stopAbdmQueueAutoRefresh(); }
  try { localStorage.setItem(DOWNLOADER_MODE_KEY, useAbdm ? 'abdm' : (useIdm ? 'idm' : 'direct')); } catch (e) {}
}

G('anu-abdm').onchange = function() {
  applyDownloaderMode(G('anu-abdm').checked ? 'abdm' : 'direct', true);
};

G('anu-idm').onchange = function() {
  applyDownloaderMode(G('anu-idm').checked ? 'idm' : 'direct', false);
};

applyDownloaderMode(localStorage.getItem(DOWNLOADER_MODE_KEY) || 'direct', false);

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
  if (abdmQueueLoading) {
    if (done) { done(); }
    return;
  }
  abdmQueueLoading = true;
  const sel = G('anu-abdm-queue');
  const previous = sel.value;

  function finish() {
    abdmQueueLoading = false;
    if (done) { done(); }
  }

  GM_xmlhttpRequest({
    method: 'GET',
    url: 'http://127.0.0.1:' + getAbdmPort() + '/queues',
    headers: getAbdmRequestHeaders(false),
    timeout: 3500,
    onload: function(r) {
      if (r.status >= 200 && r.status < 300) {
        try {
          const queues = JSON.parse(r.responseText);
          sel.innerHTML = '<option value="">— sem fila —</option>';
          queues.forEach(function(q) {
            const opt = document.createElement('option');
            opt.value = q.id; opt.textContent = q.name;
            sel.appendChild(opt);
          });
          if (previous && Array.from(sel.options).some(function(o) { return o.value === previous; })) {
            sel.value = previous;
          }
        } catch (e) {}
      } else if (isAbdmAuthStatus(r.status)) {
        handleAbdmAuthFailure('carregar as filas');
      }
      finish();
    },
    onerror: function() {
      finish();
    },
    ontimeout: function() {
      finish();
    },
  });
}

function updateAbdmControls() {
  const hasPending = abdmOffset < abdmQueue.length;
  G('b-abdm-next').style.display = abdmSending && hasPending ? 'inline-block' : 'none';
  G('b-abdm-stop').style.display = abdmSending ? 'inline-block' : 'none';
  G('anu-abdm-ctrl').style.display = abdmSending ? 'flex' : 'none';
  updateStats();
}

function abdmPing() {
  return probeAbdmApiKey(getAbdmApiKey());
}

// Envia um único item ao ABDM, com re-tentativas automáticas em caso de
// falha de rede/timeout (a captação do link em si é obtida via getDownloadUrl,
// que já resolve e cacheia a URL de download antes do envio).
function sendItemToABDM(item, queueId, folder, port, authCookies, attempt) {
  attempt = attempt || 0;
  const link = getDownloadUrl(item);
  const body = {
    downloadSource: {
      type: 'http',
      link: link,
      headers: { 'Cookie': authCookies },
    },
    name: sanitizeName(item.name),
    // O endpoint "start-headless-download" da v1.10.2 apenas adiciona o item
    // quando este campo é omitido; preserve o comportamento de iniciar agora.
    startDownload: true,
  };
  if (queueId) { body.queueId = parseInt(queueId, 10); }
  if (folder) { body.folder = folder; }

  return new Promise(function(resolve) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'http://127.0.0.1:' + port + '/start-headless-download',
      headers: getAbdmRequestHeaders(true),
      data: JSON.stringify(body),
      timeout: 12000,
      onload: function(r) {
        if (r.status >= 200 && r.status < 300) {
          resolve(true);
          return;
        }
        if (isAbdmAuthStatus(r.status)) {
          abdmAuthBlocked = true;
          handleAbdmAuthFailure('enviar o download');
          resolve(false);
          return;
        }
        // 4xx = link/parâmetros inválidos, não adianta re-tentar.
        // 5xx / outros = pode ser instabilidade do ABDM, vale re-tentar.
        if (r.status >= 500 && attempt < ABDM_SEND_RETRIES) {
          log('⟳ ABDM respondeu ' + r.status + ' em ' + item.name + ' — tentativa ' + (attempt + 2) + '/' + (ABDM_SEND_RETRIES + 1) + '…', 'lwrn');
          setTimeout(function() {
            sendItemToABDM(item, queueId, folder, port, authCookies, attempt + 1).then(resolve);
          }, ABDM_SEND_RETRY_DELAY_MS * (attempt + 1));
          return;
        }
        log('⚠ ABDM erro ' + r.status + ' ao captar link de ' + item.name, 'lwrn');
        resolve(false);
      },
      onerror: function() {
        if (attempt < ABDM_SEND_RETRIES) {
          log('⟳ Falha de conexão com o ABDM em ' + item.name + ' — tentativa ' + (attempt + 2) + '/' + (ABDM_SEND_RETRIES + 1) + '…', 'lwrn');
          setTimeout(function() {
            sendItemToABDM(item, queueId, folder, port, authCookies, attempt + 1).then(resolve);
          }, ABDM_SEND_RETRY_DELAY_MS * (attempt + 1));
          return;
        }
        log('✗ Não foi possível conectar ao ABDM na porta ' + port + ' (' + item.name + ').', 'lerr');
        resolve(false);
      },
      ontimeout: function() {
        if (attempt < ABDM_SEND_RETRIES) {
          log('⟳ ABDM demorou para responder em ' + item.name + ' — tentativa ' + (attempt + 2) + '/' + (ABDM_SEND_RETRIES + 1) + '…', 'lwrn');
          setTimeout(function() {
            sendItemToABDM(item, queueId, folder, port, authCookies, attempt + 1).then(resolve);
          }, ABDM_SEND_RETRY_DELAY_MS * (attempt + 1));
          return;
        }
        log('✗ ABDM demorou demais para responder em ' + item.name + '.', 'lerr');
        resolve(false);
      },
    });
  });
}

function sendBatchToABDM(batch) {
  const queueId = G('anu-abdm-queue').value;
  const folder = getAbdmFolder();
  const port = getAbdmPort();
  const authCookies = document.cookie.split(';')
    .map(function(c) { return c.trim(); })
    .filter(function(c) { return c.includes('sb-') && c.includes('auth-token'); })
    .join('; ');
  let allOk = true;

  function sendOne(index) {
    if (stopped || !abdmSending || abdmAuthBlocked) { return Promise.resolve(false); }
    if (index >= batch.length) { return Promise.resolve(allOk); }
    const item = batch[index];
    return sendItemToABDM(item, queueId, folder, port, authCookies, 0).then(function(ok) {
      if (ok) {
        item.status = 'sent_abdm'; refreshBadge(item); updateStats();
      } else {
        allOk = false;
        item.status = 'error'; refreshBadge(item); updateStats();
      }
      // Se a chave foi recusada, não envie o restante do lote com a mesma chave.
      if (abdmAuthBlocked) { return false; }
      return new Promise(function(resolve) {
        setTimeout(function() { sendOne(index + 1).then(resolve); }, 200);
      });
    });
  }
  return sendOne(0);
}

function sendToIDM(items) {
  if (!items.length) { return; }
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
    const frame = getIdmFrame();
    const a = document.createElement('a');
    frame.src = 'about:blank';
    a.href = url;
    a.target = frame.name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    setTimeout(function() { a.click(); }, 30);
    setTimeout(function() {
      if (a.parentNode) { a.parentNode.removeChild(a); }
    }, 1000);
  }

  function triggerNext() {
    if (stopped) {
      downloading = false;
      activeDownloadPaths.clear();
      log('Envio para o IDM interrompido.', 'lwrn');
      updateStats();
      return;
    }
    if (idx >= items.length) {
      log('✓ Todos os arquivos enviados para o IDM.', 'lok');
      downloading = false;
      activeDownloadPaths.clear();
      updateStats();
      return;
    }
    const item = items[idx++];
    item.status = 'downloading';
    refreshBadge(item);
    openWithIdm(getDownloadUrl(item));
    setTimeout(function() {
      item.status = 'sent_idm';
      refreshBadge(item);
      updateStats();
      triggerNext();
    }, IDM_TRIGGER_DELAY_MS);
  }
  triggerNext();
}

function abdmSendNextBatch() {
  clearTimeout(abdmTimer); abdmTimer = null;
  if (stopped || !abdmSending) { updateAbdmControls(); return; }
  if (abdmOffset >= abdmQueue.length) {
    log('✓ Todos os arquivos foram enviados para o ABDM.', 'lok');
    abdmSending = false; activeDownloadPaths.clear(); updateAbdmControls(); return;
  }
  const batchSize = getAbdmBatch();
  const batch = abdmQueue.slice(abdmOffset, abdmOffset + batchSize);
  const batchNum = Math.floor(abdmOffset / batchSize) + 1;
  const totalBatches = Math.ceil(abdmQueue.length / batchSize);
  abdmPing().then(function(result) {
    if (!result.ok) {
      if (result.auth) {
        handleAbdmAuthFailure('iniciar o envio');
      } else {
        log('✗ ABDM não responde. Verifique se está aberto e se a porta está correta.', 'lerr');
      }
      abdmSending = false; activeDownloadPaths.clear(); updateAbdmControls(); return;
    }
    log('Lote ' + batchNum + '/' + totalBatches + ': enviando ' + batch.length + ' arquivo(s)…', 'linf');
    sendBatchToABDM(batch).then(function(sent) {
      if (!sent) {
        abdmSending = false;
        activeDownloadPaths.clear();
        updateAbdmControls();
        return;
      }
      abdmOffset += batchSize;
      if (abdmOffset >= abdmQueue.length) {
        log('✓ Todos os arquivos foram enviados para o ABDM.', 'lok');
        abdmSending = false; activeDownloadPaths.clear(); updateAbdmControls(); return;
      }
      const remaining = abdmQueue.length - abdmOffset;
      const intervalMin = getAbdmInterval();
      log(remaining + ' arquivo(s) restante(s). Próximo lote em ' + intervalMin + ' min — ou clique "Próximo lote agora".', 'lwrn');
      updateAbdmControls();
      abdmTimer = setTimeout(function() {
        log('Intervalo concluído. Enviando próximo lote…', 'linf');
        abdmSendNextBatch();
      }, intervalMin * 60 * 1000);
    });
  });
}

function sendToABDM(items) {
  if (!items.length) { return; }
  abdmQueue = items.slice(); abdmOffset = 0; abdmSending = true;
  abdmAuthBlocked = false;
  stopped = false;
  clearTimeout(abdmTimer);
  log('Iniciando envio — ' + items.length + ' arquivo(s) em lotes de ' + getAbdmBatch() + '.', 'linf');
  updateAbdmControls(); abdmSendNextBatch();
}

G('b-abdm-next').onclick = function() {
  if (!abdmSending) { return; }
  clearTimeout(abdmTimer);
  log('Enviando próximo lote manualmente…', 'linf');
  abdmSendNextBatch();
};
G('b-abdm-stop').onclick = function() {
  stopped = true; clearTimeout(abdmTimer); abdmSending = false; abdmQueue = []; abdmOffset = 0;
  activeDownloadPaths.clear();
  log('Envio para o ABDM cancelado.', 'lwrn'); updateAbdmControls();
};

function startDownloads(items) {
  if (!items.length || downloading || abdmSending || crawling || folderLoading) { return; }
  activeDownloadPaths = new Set(items.map(function(f) { return f.path; }));
  items.forEach(function(f) { f.status = 'pending'; f.retries = 0; });
  render();
  if (G('anu-abdm').checked) { sendToABDM(items); }
  else if (G('anu-idm').checked) { sendToIDM(items); }
  else { runQueue(items); }
}

G('b-dl').onclick = function() {
  startDownloads(fileList.filter(function(f) {
    return !f.is_directory && selected.has(f.path);
  }));
};

G('b-retry').onclick = function() {
  startDownloads(fileList.filter(function(f) { return f.status === 'error'; }));
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
  writeJsonStorage(PANEL_STATE_KEY, {
    left: Math.round(r.left),
    top: Math.round(r.top),
    width: Math.round(r.width),
    minimised: minimised,
  });
}

function setPanelMinimised(value, persist) {
  minimised = !!value;
  panel.classList.toggle('anu-minimised', minimised);
  G('anu-body').style.display = minimised ? 'none' : 'flex';
  G('anu-footer').style.display = minimised ? 'none' : 'flex';
  G('anu-min').innerHTML = minimised ? ICON.expand : ICON.minimize;
  G('anu-min').setAttribute('data-tip', minimised ? 'Expandir' : 'Minimizar');
  G('anu-min').title = minimised ? 'Expandir' : 'Minimizar';
  keepPanelInViewport();
  if (persist) { savePanelState(); }
}

function restorePanelState() {
  const state = readJsonStorage(PANEL_STATE_KEY, null);
  if (!state) { return; }
  if (Number.isFinite(state.width)) {
    const maxWidth = Math.max(380, window.innerWidth - 16);
    panel.style.width = clamp(state.width, 380, maxWidth) + 'px';
  }
  if (Number.isFinite(state.left) && Number.isFinite(state.top)) {
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = state.left + 'px';
    panel.style.top = state.top + 'px';
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
  consoleToggleBtn.innerHTML = consoleHidden ? ICON.eyeOff : ICON.eyeOpen;
  consoleToggleBtn.classList.toggle('anu-off', consoleHidden);
  consoleToggleBtn.title = consoleHidden ? 'Mostrar console' : 'Ocultar console';
  consoleToggleBtn.setAttribute('data-tip', consoleHidden ? 'Mostrar console' : 'Ocultar console');
  if (persist) {
    try { localStorage.setItem(CONSOLE_HIDDEN_KEY, consoleHidden ? '1' : '0'); } catch (e) {}
  }
}

consoleToggleBtn.onclick = function() {
  setConsoleHidden(!consoleHidden, true);
};

setConsoleHidden(localStorage.getItem(CONSOLE_HIDDEN_KEY) === '1', false);

let drag = false, ox = 0, oy = 0;
G('anu-header').addEventListener('mousedown', function(e) {
  if (e.target.closest && e.target.closest('button,input,select,label')) { return; }
  drag = true;
  const r = panel.getBoundingClientRect();
  ox = e.clientX - r.left; oy = e.clientY - r.top;
});
document.addEventListener('mousemove', function(e) {
  if (!drag) { return; }
  const r = panel.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - r.width);
  const maxTop = Math.max(0, window.innerHeight - r.height);
  panel.style.right = 'auto'; panel.style.bottom = 'auto';
  panel.style.left = clamp(e.clientX - ox, 0, maxLeft) + 'px';
  panel.style.top = clamp(e.clientY - oy, 0, maxTop) + 'px';
});
document.addEventListener('mouseup', function() {
  if (!drag) { return; }
  drag = false;
  savePanelState();
});
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
let observedBreadcrumb = null;
const syncFolderNavigation = function() {
  const path = getCurrentPath();
  if (path === lastPath) { return; }
  lastPath = path;
  clearTimeout(reloadTimer);
  if (requestedFolderPath === path || (!folderLoading && currentFolderPath === path)) { return; }
  reloadTimer = setTimeout(function() { loadFolder(path); }, FOLDER_CHANGE_DEBOUNCE_MS);
};
const navObserver = new MutationObserver(syncFolderNavigation);
function observeBreadcrumb() {
  const nav = getBreadcrumb();
  if (!nav || nav === observedBreadcrumb) { return; }
  navObserver.disconnect();
  observedBreadcrumb = nav;
  navObserver.observe(nav, { childList: true, characterData: true, subtree: true });
  syncFolderNavigation();
}
// O observador amplo só reconecta quando o breadcrumb é substituído pela SPA.
const breadcrumbMountObserver = new MutationObserver(function() {
  if (!observedBreadcrumb || !observedBreadcrumb.isConnected) { observeBreadcrumb(); }
});
breadcrumbMountObserver.observe(document.body, { childList: true, subtree: true });
observeBreadcrumb();
log('Detecção automática ativa. Navegue por qualquer pasta para carregar automaticamente.', 'linf');

// Detecta automaticamente se o ABDM está exigindo autenticação. Um erro de
// conexão significa apenas que o app está fechado/porta incorreta e não abre o popup.
setTimeout(function() {
  probeAbdmApiKey(getAbdmApiKey()).then(function(result) {
    if (result.auth) { handleAbdmAuthFailure('conectar'); }
  });
}, 550);

setTimeout(function() {
  if (activeLoadId !== 0) { return; }
  const path = getCurrentPath();
  lastPath = path;
  loadFolder(path);
}, INITIAL_FOLDER_LOAD_DELAY_MS);

})();
