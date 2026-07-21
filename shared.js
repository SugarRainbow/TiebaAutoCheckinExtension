(function initTiebaShared(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TiebaShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTiebaShared() {
  'use strict';

  const CHANNEL = 'tieba-sign-extension-v1';

  // Keep these names stable: the popup and the background worker communicate only
  // through this small protocol, so a closed popup never owns the running task.
  const MSG = Object.freeze({
    GET_SNAPSHOT: 'GET_SNAPSHOT',
    START_JOB: 'START_JOB',
    RETRY_FAILED: 'RETRY_FAILED',
    PAUSE_JOB: 'PAUSE_JOB',
    RESUME_JOB: 'RESUME_JOB',
    STOP_JOB: 'STOP_JOB',
    SAVE_SETTINGS: 'SAVE_SETTINGS',
    CLEAR_RESULTS: 'CLEAR_RESULTS',
    OPEN_TIEBA: 'OPEN_TIEBA',
    CONTENT_READY: 'CONTENT_READY',
    CONTENT_COMMAND: 'CONTENT_COMMAND',
    CONTENT_EVENT: 'CONTENT_EVENT',
    OFFSCREEN_COMMAND: 'OFFSCREEN_COMMAND',
    OFFSCREEN_EVENT: 'OFFSCREEN_EVENT',
    GET_AUTH: 'GET_AUTH',
    REFRESH_AUTH: 'REFRESH_AUTH',
    CLEAR_AUTH: 'CLEAR_AUTH',
    OPEN_AUTH: 'OPEN_AUTH',
    STATE_UPDATED: 'STATE_UPDATED'
  });

  const PHASES = Object.freeze({
    IDLE: 'idle',
    AUTH: 'auth',
    STARTING: 'starting',
    SCANNING: 'scanning',
    CHECKING: 'checking',
    SIGNING: 'signing',
    PAUSED: 'paused',
    STOPPING: 'stopping',
    COMPLETED: 'completed',
    STOPPED: 'stopped',
    INTERRUPTED: 'interrupted',
    ERROR: 'error'
  });

  const CATEGORIES = Object.freeze({
    SUCCESS: 'success',
    ALREADY_SIGNED: 'already_signed',
    NOT_SIGNED: 'not_signed',
    LOGIN_REQUIRED: 'login_required',
    TBS_INVALID: 'tbs_invalid',
    RATE_LIMITED: 'rate_limited',
    FORUM_INVALID: 'forum_invalid',
    NON_JSON: 'non_json',
    HTTP_ERROR: 'http_error',
    NETWORK_ERROR: 'network_error',
    UNKNOWN: 'unknown'
  });

  const CATEGORY_LABELS = Object.freeze({
    success: '成功',
    already_signed: '今日已签',
    not_signed: '未签到',
    login_required: '登录失效',
    tbs_invalid: 'tbs 失效',
    rate_limited: '频率或风控限制',
    forum_invalid: '贴吧无效',
    non_json: '响应格式异常',
    http_error: 'HTTP 错误',
    network_error: '网络错误',
    unknown: '未知错误'
  });

  const DEFAULT_SETTINGS = Object.freeze({
    maxPages: 30,
    minDelay: 800,
    maxDelay: 1600,
    signMode: 'fast',
    maxRefreshes: 1,
    requestTimeout: 20000,
    closeWorkerTab: true,
    autoSign: false,
    autoTime: '09:00',
    notifications: true,
    networkRetries: 2,
    rateLimitRetries: 1,
    retryBaseDelay: 1500
  });

  const STORAGE_KEYS = Object.freeze({
    settings: 'tieba.extension.settings.v1',
    state: 'tieba.extension.state.v1',
    lastSummary: 'tieba.extension.last-summary.v1',
    auth: 'tieba.extension.auth.v1',
    pendingAuth: 'tieba.extension.pending-auth.v1',
    authWindow: 'tieba.extension.auth-window.v1'
  });

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
  }

  function normalizeSettings(input) {
    const source = input && typeof input === 'object' ? input : {};
    const minDelay = clampInteger(source.minDelay, 0, 60000, DEFAULT_SETTINGS.minDelay);
    const maxDelay = clampInteger(source.maxDelay, 0, 60000, DEFAULT_SETTINGS.maxDelay);
    return {
      maxPages: clampInteger(source.maxPages, 1, 100, DEFAULT_SETTINGS.maxPages),
      minDelay: Math.min(minDelay, maxDelay),
      maxDelay: Math.max(minDelay, maxDelay),
      signMode: source.signMode === 'safe' ? 'safe' : 'fast',
      maxRefreshes: clampInteger(source.maxRefreshes, 0, 3, DEFAULT_SETTINGS.maxRefreshes),
      requestTimeout: clampInteger(source.requestTimeout, 5000, 120000, DEFAULT_SETTINGS.requestTimeout),
      closeWorkerTab: source.closeWorkerTab !== false,
      autoSign: source.autoSign === true,
      autoTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(source.autoTime || '')) ? String(source.autoTime) : DEFAULT_SETTINGS.autoTime,
      notifications: source.notifications !== false,
      networkRetries: clampInteger(source.networkRetries, 0, 4, DEFAULT_SETTINGS.networkRetries),
      rateLimitRetries: clampInteger(source.rateLimitRetries, 0, 3, DEFAULT_SETTINGS.rateLimitRetries),
      retryBaseDelay: clampInteger(source.retryBaseDelay, 250, 30000, DEFAULT_SETTINGS.retryBaseDelay)
    };
  }

  function todayKey(date) {
    const value = date instanceof Date ? date : new Date(date || Date.now());
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  function makeRunId() {
    const random = Math.random().toString(36).slice(2, 10);
    return `run-${Date.now().toString(36)}-${random}`;
  }

  function sleep(ms, signal = null) {
    const delay = Math.max(0, Number(ms) || 0);
    const abortError = () => {
      const error = new Error('操作已中止');
      error.name = 'AbortError';
      return error;
    };
    if (signal && signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const onAbort = () => {
        if (timer !== null) clearTimeout(timer);
        cleanup();
        reject(abortError());
      };
      timer = setTimeout(() => {
        timer = null;
        cleanup();
        resolve();
      }, delay);
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function randomDelay(min, max, random = Math.random) {
    const low = Math.max(0, Number(min) || 0);
    const high = Math.max(low, Number(max) || 0);
    if (high <= low) return Math.floor(low);
    return Math.floor(low + random() * (high - low + 1));
  }

  function retryDelay(settings, category, attempt) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const base = clampInteger(source.retryBaseDelay, 250, 30000, DEFAULT_SETTINGS.retryBaseDelay);
    const retryAttempt = clampInteger(attempt, 0, 30, 0);
    const multiplier = 2 ** retryAttempt;
    if (category === CATEGORIES.RATE_LIMITED) {
      return Math.min(60000, Math.max(5000, base * 4) * multiplier);
    }
    return Math.min(30000, base * multiplier);
  }

  function normalizeForumName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim();
  }

  function looksLikeEncodedKw(name) {
    return /%(?:[0-9A-Fa-f]{2})/.test(String(name || ''));
  }

  function parseForumListText(text) {
    return String(text || '')
      .split(/[\r\n,，;；|]+/)
      .map(normalizeForumName)
      .filter((name) => name && !looksLikeEncodedKw(name));
  }

  function decodeUnicodeEscapes(value) {
    return String(value || '')
      .replace(/\\u([\dA-Fa-f]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  function decodeHtmlEntity(text) {
    return String(text || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function decodeURIComponentSafe(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function decodeQueryValue(value) {
    return decodeURIComponentSafe(String(value || '').replace(/\+/g, '%20'));
  }

  function extractForums(html) {
    const byName = new Map();
    const addForum = (rawName, source) => {
      const name = normalizeForumName(decodeHtmlEntity(decodeUnicodeEscapes(rawName)));
      if (!name || looksLikeEncodedKw(name) || byName.has(name)) return;
      byName.set(name, { name, source });
    };
    const text = String(html || '');
    const jsonNamePattern = /"forum_name"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let match;
    while ((match = jsonNamePattern.exec(text)) !== null) addForum(match[1], 'json:forum_name');

    const anchorPattern = /<a\b[^>]*href=["'][^"']*\/f\?[^"']*kw=([^"'&]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = anchorPattern.exec(text)) !== null) {
      const rawText = match[2].replace(/<[^>]*>/g, '');
      const tag = match[0].slice(0, match[0].indexOf('>') + 1);
      const titleMatch = tag.match(/\btitle=["']([^"']+)["']/i);
      const titleName = titleMatch ? normalizeForumName(decodeHtmlEntity(titleMatch[1])) : '';
      const textName = normalizeForumName(decodeHtmlEntity(rawText));
      const kwName = normalizeForumName(decodeQueryValue(match[1]));
      addForum(titleName || textName || kwName, titleName ? 'anchor:title' : textName ? 'anchor:text' : 'anchor:kw');
    }

    const titlePattern = /\btitle=["']([^"']+)["'][^>]*href=["'][^"']*\/f\?[^"']*kw=/gi;
    while ((match = titlePattern.exec(text)) !== null) addForum(match[1], 'title-before-href');
    return [...byName.values()];
  }

  function hasNextPage(html, pageNo) {
    const page = Number(pageNo) || 1;
    const text = String(html || '');
    return text.includes(`pn=${page + 1}`) ||
      text.includes(`pn%3D${page + 1}`) ||
      text.includes('下一页') ||
      text.includes('\\u4e0b\\u4e00\\u9875');
  }

  function messageFrom(data) {
    if (!data || typeof data !== 'object') return '';
    return String(data.error || data.err_msg || data.msg || data.message || data.errmsg || '');
  }

  function codeFrom(data) {
    if (!data || typeof data !== 'object') return '';
    return data.no ?? data.err_no ?? data.error_code ?? data.code ?? '';
  }

  function normalizeCode(code) {
    return code === undefined || code === null ? '' : String(code);
  }

  function isTruthySignValue(value) {
    return value === 1 || value === true || value === '1' || value === 'true' || value === 'signed';
  }

  function isTodayTimestamp(value, now = Date.now()) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return false;
    const ms = number > 100000000000 ? number : number * 1000;
    return todayKey(new Date(ms)) === todayKey(new Date(now));
  }

  function findSignedEvidence(value, pathName = 'data', now = Date.now()) {
    if (!value || typeof value !== 'object') return null;
    const signFlagKeys = new Set(['is_sign_in', 'is_signed', 'has_signed', 'has_sign', 'signed', 'sign_today', 'isSignIn', 'isSigned']);
    const signTimeKeys = new Set(['sign_time', 'last_sign_time', 'signTime', 'lastSignTime']);
    for (const [key, entry] of Object.entries(value)) {
      const currentPath = `${pathName}.${key}`;
      if (signFlagKeys.has(key) && isTruthySignValue(entry)) return currentPath;
      if (signTimeKeys.has(key) && isTodayTimestamp(entry, now)) return currentPath;
      if (entry && typeof entry === 'object') {
        const nested = findSignedEvidence(entry, currentPath, now);
        if (nested) return nested;
      }
    }
    return null;
  }

  function categoryFromFailure(code, message) {
    const normalizedCode = normalizeCode(code);
    const text = String(message || '');
    if (normalizedCode === '1101' || /已经签到|之前已经签过|已签到|already/i.test(text)) return CATEGORIES.ALREADY_SIGNED;
    if (/未登录|请登录|登录已失效|重新登录|login|BDUSS|cookie/i.test(text)) return CATEGORIES.LOGIN_REQUIRED;
    if (/tbs|csrf|token|令牌|签名|校验|验证失败|invalid/i.test(text)) return CATEGORIES.TBS_INVALID;
    if (/频繁|稍后|请求过快|rate|limit|too many|风控|安全验证|验证码|captcha/i.test(text)) return CATEGORIES.RATE_LIMITED;
    if (/贴吧目录出问题|吧不存在|贴吧不存在|目录|forum|kw|参数错误|param/i.test(text)) return CATEGORIES.FORUM_INVALID;
    return CATEGORIES.UNKNOWN;
  }

  function categoryLabel(category) {
    return CATEGORY_LABELS[category] || category || CATEGORY_LABELS.unknown;
  }

  function classifySignInfo(data, now = Date.now()) {
    if (!data || typeof data !== 'object') return { signed: false, status: 'fail', category: CATEGORIES.UNKNOWN, reason: '接口返回为空' };
    const message = messageFrom(data);
    const code = codeFrom(data);
    if (/已经签到|之前已经签过|已签到|签到成功|already/i.test(message)) {
      return { signed: true, status: 'signed', category: CATEGORIES.ALREADY_SIGNED, code, reason: '接口消息显示今日已签到' };
    }
    if (Number(data.no) !== 0 || !data.data) {
      const category = categoryFromFailure(code, message);
      return { signed: false, status: 'fail', category, code, reason: message || `接口错误码 no=${data.no}` };
    }
    const evidence = findSignedEvidence(data.data, 'data', now);
    if (evidence) return { signed: true, status: 'signed', category: CATEGORIES.ALREADY_SIGNED, code, reason: `命中签到字段 ${evidence}` };
    return { signed: false, status: 'unsigned', category: CATEGORIES.NOT_SIGNED, code, reason: '未发现今日签到字段' };
  }

  function classifySignResult(data) {
    if (!data || typeof data !== 'object') {
      return { status: 'fail', category: CATEGORIES.UNKNOWN, code: '', message: '接口返回为空', retryable: false, needsTbsRefresh: false };
    }
    const code = codeFrom(data);
    if (Number(data.no) === 0) return { status: 'ok', category: CATEGORIES.SUCCESS, code, message: '签到成功', retryable: false, needsTbsRefresh: false };
    const message = messageFrom(data) || JSON.stringify(data);
    const category = categoryFromFailure(code, message);
    if (category === CATEGORIES.ALREADY_SIGNED) return { status: 'already', category, code, message: message || '今日已签到', retryable: false, needsTbsRefresh: false };
    const needsTbsRefresh = category === CATEGORIES.TBS_INVALID;
    return { status: 'fail', category, code, message, retryable: needsTbsRefresh || category === CATEGORIES.NETWORK_ERROR, needsTbsRefresh };
  }

  function classifyError(error) {
    const value = error || {};
    const message = String(value.message || value || '未知错误');
    let category = value.category || '';
    if (!category && value.name === 'AbortError') category = CATEGORIES.NETWORK_ERROR;
    if (!category && /JSON|non.?json|parse/i.test(message)) category = CATEGORIES.NON_JSON;
    if (!category && /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|timeout/i.test(message)) category = CATEGORIES.NETWORK_ERROR;
    category = category || CATEGORIES.UNKNOWN;
    return {
      status: 'fail',
      category,
      code: value.code || value.statusCode || '',
      message,
      retryable: category === CATEGORIES.NETWORK_ERROR,
      needsTbsRefresh: category === CATEGORIES.TBS_INVALID
    };
  }

  function createForumRecord(item) {
    const source = item && typeof item === 'object' ? item : { name: item };
    const name = normalizeForumName(source.name);
    return {
      name,
      searchKey: name.toLowerCase(),
      source: String(source.source || ''),
      page: source.page || '',
      status: 'pending',
      category: '',
      code: '',
      message: source.page ? `第 ${source.page} 页${source.source ? `，来源 ${source.source}` : ''}` : '',
      retryCount: clampInteger(source.retryCount, 0, 1000, 0),
      finishedAt: '',
      raw: null
    };
  }

  function sanitizeForum(forum) {
    const value = createForumRecord(forum);
    value.status = String(forum && forum.status || value.status);
    value.category = String(forum && forum.category || '');
    value.code = normalizeCode(forum && forum.code);
    value.message = String(forum && forum.message || '');
    value.retryCount = clampInteger(forum && forum.retryCount, 0, 1000, 0);
    value.finishedAt = String(forum && forum.finishedAt || '');
    return value;
  }

  function emptyState() {
    return {
      schemaVersion: 1,
      runId: '',
      revision: 0,
      date: todayKey(),
      status: PHASES.IDLE,
      phase: PHASES.IDLE,
      mode: 'all',
      startedAt: '',
      updatedAt: new Date().toISOString(),
      currentIndex: 0,
      queue: [],
      total: 0,
      currentForum: '',
      progress: { current: 0, total: 0, label: '' },
      counts: { ok: 0, signed: 0, fail: 0, pending: 0, total: 0 },
      forums: [],
      logs: [],
      message: '',
      error: null,
      executorTabId: null,
      ownedExecutor: false,
      executorMode: 'offscreen'
    };
  }

  function countForums(forums) {
    const counts = { ok: 0, signed: 0, fail: 0, pending: 0, total: forums.length };
    for (const forum of forums) {
      if (forum.status === 'ok') counts.ok += 1;
      else if (forum.status === 'signed') counts.signed += 1;
      else if (forum.status === 'fail') counts.fail += 1;
      else counts.pending += 1;
    }
    return counts;
  }

  function sanitizeState(input) {
    const base = emptyState();
    const source = input && typeof input === 'object' ? input : {};
    const forums = Array.isArray(source.forums) ? source.forums.map(sanitizeForum).filter((forum) => forum.name) : [];
    const queue = Array.isArray(source.queue)
      ? source.queue.map((name) => normalizeForumName(name)).filter(Boolean).slice(0, 10000)
      : forums.map((forum) => forum.name);
    const state = {
      ...base,
      ...source,
      schemaVersion: 1,
      runId: String(source.runId || ''),
      revision: clampInteger(source.revision, 0, 1000000000, 0),
      date: String(source.date || base.date),
      status: String(source.status || base.status),
      phase: String(source.phase || source.status || base.phase),
      mode: source.mode === 'retry' || source.mode === 'resume' ? source.mode : 'all',
      startedAt: String(source.startedAt || ''),
      updatedAt: String(source.updatedAt || new Date().toISOString()),
      currentIndex: clampInteger(source.currentIndex, 0, Math.max(forums.length, 100000), 0),
      queue,
      total: forums.length,
      currentForum: String(source.currentForum || ''),
      progress: {
        current: clampInteger(source.progress && source.progress.current, 0, Math.max(forums.length, 100000), 0),
        total: clampInteger(source.progress && source.progress.total, 0, 100000, queue.length || forums.length),
        label: String(source.progress && source.progress.label || '')
      },
      counts: countForums(forums),
      forums,
      logs: Array.isArray(source.logs) ? source.logs.slice(-100).map((entry) => ({
        kind: String(entry && entry.kind || 'info'),
        message: String(entry && entry.message || '').slice(0, 500),
        time: String(entry && entry.time || '')
      })) : [],
      message: String(source.message || '').slice(0, 500),
      error: source.error ? {
        category: String(source.error.category || CATEGORIES.UNKNOWN),
        code: normalizeCode(source.error.code),
        message: String(source.error.message || '').slice(0, 500)
      } : null,
      executorTabId: Number.isInteger(source.executorTabId) ? source.executorTabId : null,
      ownedExecutor: Boolean(source.ownedExecutor),
      executorMode: String(source.executorMode || 'offscreen')
    };
    return state;
  }

  function appendLog(state, kind, message, time = new Date().toISOString()) {
    const next = sanitizeState(state);
    next.logs.push({ kind: String(kind || 'info'), message: String(message || '').slice(0, 500), time });
    next.logs = next.logs.slice(-100);
    next.updatedAt = new Date().toISOString();
    return next;
  }

  return {
    CHANNEL,
    MSG,
    PHASES,
    CATEGORIES,
    CATEGORY_LABELS,
    DEFAULT_SETTINGS,
    STORAGE_KEYS,
    appendLog,
    categoryFromFailure,
    categoryLabel,
    classifyError,
    classifySignInfo,
    classifySignResult,
    clampInteger,
    countForums,
    createForumRecord,
    decodeHtmlEntity,
    decodeQueryValue,
    decodeUnicodeEscapes,
    emptyState,
    extractForums,
    findSignedEvidence,
    hasNextPage,
    isTodayTimestamp,
    looksLikeEncodedKw,
    makeRunId,
    messageFrom,
    normalizeCode,
    normalizeForumName,
    normalizeSettings,
    parseForumListText,
    randomDelay,
    retryDelay,
    sanitizeForum,
    sanitizeState,
    sleep,
    todayKey
  };
});
