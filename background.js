'use strict';

importScripts('shared.js', 'core.js', 'auth.js');

const shared = globalThis.TiebaShared;
const core = globalThis.TiebaCore;
const authApi = globalThis.TiebaAuth;
const { MSG, CHANNEL, PHASES, STORAGE_KEYS } = shared;
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const AUTH_URL = 'https://tieba.baidu.com/?tieba_sign_extension_worker=1';
const DAILY_ALARM = 'tieba-daily-sign';
const ACTIVE_PHASES = new Set([
  PHASES.AUTH,
  PHASES.STARTING,
  PHASES.SCANNING,
  PHASES.CHECKING,
  PHASES.SIGNING,
  PHASES.PAUSED,
  PHASES.STOPPING
]);
const FINISHED_PHASES = new Set([PHASES.COMPLETED, PHASES.STOPPED, PHASES.ERROR]);

let cachedState = null;
let cachedSettings = null;
let cachedAuth = null;
let pendingStart = null;
let authWindowId = null;
let authAttemptInFlight = false;
let offscreenCreatePromise = null;
let loadPromise = null;
let persistChain = Promise.resolve();
let persistTimer = null;
let lastPersistAt = 0;
let persistedRevision = -1;

const authStore = new authApi.CookieStore();

function runtimeError() {
  return chrome.runtime.lastError ? new Error(chrome.runtime.lastError.message) : null;
}

function callbackApi(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (value) => {
      const error = runtimeError();
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function storageGet(keys) {
  return callbackApi(chrome.storage.local.get.bind(chrome.storage.local), keys);
}

function storageSet(values) {
  return callbackApi(chrome.storage.local.set.bind(chrome.storage.local), values);
}

function storageRemove(keys) {
  return callbackApi(chrome.storage.local.remove.bind(chrome.storage.local), keys);
}

function sessionGet(keys) {
  if (!chrome.storage.session) return Promise.resolve({});
  return callbackApi(chrome.storage.session.get.bind(chrome.storage.session), keys);
}

function sessionSet(values) {
  if (!chrome.storage.session) return Promise.resolve();
  return callbackApi(chrome.storage.session.set.bind(chrome.storage.session), values);
}

function sessionRemove(keys) {
  if (!chrome.storage.session) return Promise.resolve();
  return callbackApi(chrome.storage.session.remove.bind(chrome.storage.session), keys);
}

function windowsCreate(properties) {
  return callbackApi(chrome.windows.create.bind(chrome.windows), properties);
}

function windowsGet(windowId) {
  return callbackApi(chrome.windows.get.bind(chrome.windows), windowId);
}

function windowsRemove(windowId) {
  return callbackApi(chrome.windows.remove.bind(chrome.windows), windowId);
}

function alarmsClear(name) {
  if (!chrome.alarms) return Promise.resolve(false);
  return callbackApi(chrome.alarms.clear.bind(chrome.alarms), name).then(Boolean).catch(() => false);
}

function sendRuntime(message) {
  return callbackApi(chrome.runtime.sendMessage.bind(chrome.runtime), message);
}

async function ensureLoaded() {
  if (cachedState && cachedSettings && cachedAuth) return;
  if (!loadPromise) {
    loadPromise = Promise.all([
      storageGet([
        STORAGE_KEYS.state,
        STORAGE_KEYS.settings,
        STORAGE_KEYS.auth,
        STORAGE_KEYS.pendingAuth
      ]),
      sessionGet([STORAGE_KEYS.authWindow])
    ])
      .then(([stored, session]) => {
        cachedState = shared.sanitizeState(stored[STORAGE_KEYS.state]);
        cachedSettings = shared.normalizeSettings(stored[STORAGE_KEYS.settings]);
        cachedAuth = authStore.view(stored[STORAGE_KEYS.auth]);
        authWindowId = Number.isInteger(session[STORAGE_KEYS.authWindow])
          ? session[STORAGE_KEYS.authWindow]
          : null;
        const pending = stored[STORAGE_KEYS.pendingAuth];
        pendingStart = pending && typeof pending === 'object' && Object.keys(pending).length
          ? pending
          : null;
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  await loadPromise;
}

function authResponse(includeCookie = false) {
  const full = cachedAuth || authStore.view(null);
  if (includeCookie) return full;
  const { cookie, ...summary } = full;
  return summary;
}

function snapshotResponse(extra = {}, options = {}) {
  return {
    ok: true,
    state: shared.sanitizeState(cachedState),
    settings: shared.normalizeSettings(cachedSettings),
    auth: authResponse(options.includeCookie === true),
    ...extra
  };
}

function persistNow({ includeSettings = false, summary = false } = {}) {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const state = shared.sanitizeState(cachedState);
  const values = { [STORAGE_KEYS.state]: state };
  if (includeSettings) values[STORAGE_KEYS.settings] = shared.normalizeSettings(cachedSettings);
  if (summary) {
    values[STORAGE_KEYS.lastSummary] = {
      runId: state.runId,
      date: state.date,
      status: state.status,
      counts: state.counts,
      finishedAt: state.updatedAt
    };
  }
  cachedState = state;
  lastPersistAt = Date.now();
  persistedRevision = state.revision;
  persistChain = persistChain.catch(() => {}).then(() => storageSet(values));
  return persistChain;
}

function queuePersist(options = {}) {
  return persistNow(options);
}

function persistEvent(eventName) {
  const state = cachedState;
  const critical = new Set(['RUN_STARTED', 'RUN_FINISHED', 'ERROR', 'PAUSED', 'STOPPING', 'STOPPED']);
  const revisionGap = Math.max(0, Number(state.revision) - persistedRevision);
  const due = Date.now() - lastPersistAt >= 1800;
  if (critical.has(eventName) || revisionGap >= 5 || due) {
    return persistNow({ summary: eventName === 'RUN_FINISHED' });
  }
  if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow({ summary: false }).catch(() => {});
    }, 1800);
  }
  return Promise.resolve();
}

function broadcastSnapshot() {
  const message = {
    channel: CHANNEL,
    type: MSG.STATE_UPDATED,
    state: shared.sanitizeState(cachedState),
    settings: shared.normalizeSettings(cachedSettings),
    auth: authResponse()
  };
  try {
    chrome.runtime.sendMessage(message, () => runtimeError());
  } catch {
    // No popup may be listening.
  }
}

function setBadge() {
  if (!chrome.action || !cachedState) return;
  const state = cachedState;
  let text = '';
  let color = '#5f6368';
  if (ACTIVE_PHASES.has(state.status)) {
    if (state.status === PHASES.AUTH) text = '…';
    else if (state.status === PHASES.PAUSED) text = 'Ⅱ';
    else {
      const current = state.progress && state.progress.current || 0;
      const total = state.progress && state.progress.total || 0;
      text = total ? String(Math.min(current, 999)) : '…';
    }
    color = '#0b57d0';
  } else if (state.status === PHASES.COMPLETED) {
    text = state.counts.fail ? '!' : '✓';
    color = state.counts.fail ? '#b06000' : '#188038';
  } else if (state.status === PHASES.ERROR) {
    text = '!';
    color = '#b3261e';
  }
  chrome.action.setBadgeBackgroundColor({ color }, () => runtimeError());
  chrome.action.setBadgeText({ text }, () => runtimeError());
  chrome.action.setTitle({ title: state.message || '贴吧签到' }, () => runtimeError());
}

function notify(title, message) {
  if (!cachedSettings.notifications || !chrome.notifications) return;
  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message
    }, () => runtimeError());
  } catch {
    // Notifications are optional.
  }
}

async function offscreenContexts() {
  if (!chrome.runtime.getContexts) return [];
  try {
    return await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_URL]
    });
  } catch {
    return [];
  }
}

async function ensureOffscreen() {
  const existing = await offscreenContexts();
  if (existing.length) return;
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    throw new Error('当前 Edge 不支持隐藏执行器');
  }
  if (!offscreenCreatePromise) {
    offscreenCreatePromise = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING'],
      justification: '在不打开可见标签页的情况下执行贴吧签到并解析关注列表'
    }).finally(() => {
      offscreenCreatePromise = null;
    });
  }
  await offscreenCreatePromise;
}

async function closeOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.closeDocument) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // It may already have been closed by the browser.
  }
}

async function sendOffscreen(message, timeoutMs = 12000) {
  await ensureOffscreen();
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await sendRuntime({
        channel: CHANNEL,
        target: 'offscreen',
        type: MSG.OFFSCREEN_COMMAND,
        ...message
      });
      if (response) return response;
    } catch (error) {
      lastError = error;
    }
    await shared.sleep(200);
  }
  throw lastError || new Error('隐藏签到执行器未就绪');
}

function hasLoginToken(auth) {
  return Boolean(auth && auth.hasLoginToken);
}

async function syncAuth() {
  const current = await authStore.readBrowser();
  if (current.length) {
    const candidate = authStore.view({ tokenNames: [...new Set(current.map((cookie) => cookie.name))] });
    if (candidate.hasLoginToken || !cachedAuth || !cachedAuth.hasLoginToken) {
      cachedAuth = await authStore.saveBrowser(current);
    }
  }
  if (!cachedAuth || !cachedAuth.hasCookie) cachedAuth = authStore.view(await authStore.readSaved());
  broadcastSnapshot();
  return cachedAuth;
}

async function checkAuthWithTbs() {
  let attempt = 0;
  while (true) {
    try {
      const response = await sendOffscreen({ command: 'auth-check', timeout: 10000 }, 15000);
      if (response && response.ok && response.isLogin && response.tbs) return response.tbs;
      const category = String(response && response.category || shared.CATEGORIES.LOGIN_REQUIRED);
      if (category === shared.CATEGORIES.LOGIN_REQUIRED) return false;
      throw Object.assign(new Error(response && response.error || '登录状态检查失败'), { category });
    } catch (error) {
      const failure = shared.classifyError(error);
      if (failure.category !== shared.CATEGORIES.NETWORK_ERROR || attempt >= cachedSettings.networkRetries) throw error;
      await shared.sleep(shared.retryDelay(cachedSettings, failure.category, attempt));
      attempt += 1;
    }
  }
}

async function closeAuthWindow() {
  const id = authWindowId;
  authWindowId = null;
  await sessionRemove([STORAGE_KEYS.authWindow]).catch(() => {});
  if (!Number.isInteger(id)) return;
  try {
    await windowsRemove(id);
  } catch {}
}

async function focusOrCreateAuthWindow() {
  if (Number.isInteger(authWindowId)) {
    try {
      const current = await windowsGet(authWindowId);
      if (current) {
        await callbackApi(chrome.windows.update.bind(chrome.windows), authWindowId, { focused: true });
        return { windowId: authWindowId, opened: false };
      }
    } catch {}
    authWindowId = null;
    await sessionRemove([STORAGE_KEYS.authWindow]).catch(() => {});
  }
  const created = await windowsCreate({
    url: AUTH_URL,
    type: 'popup',
    focused: true,
    width: 520,
    height: 760
  });
  authWindowId = created.id;
  await sessionSet({ [STORAGE_KEYS.authWindow]: authWindowId });
  return { windowId: created.id, opened: true };
}

async function markAuthWaiting(message = '请在登录窗口完成贴吧登录') {
  cachedState.status = PHASES.AUTH;
  cachedState.phase = PHASES.AUTH;
  cachedState.message = message;
  cachedState.error = null;
  cachedState.updatedAt = new Date().toISOString();
  await persistNow();
  setBadge();
  broadcastSnapshot();
}

async function beginAuth(options = null) {
  pendingStart = options ? { ...options } : null;
  if (pendingStart) await storageSet({ [STORAGE_KEYS.pendingAuth]: pendingStart });
  else await storageRemove([STORAGE_KEYS.pendingAuth]);
  await markAuthWaiting();
  const windowInfo = await focusOrCreateAuthWindow();
  await tryCompleteAuth();
  return snapshotResponse({ awaitingLogin: Boolean(pendingStart), ...windowInfo });
}

async function tryCompleteAuth() {
  if (authAttemptInFlight) return;
  authAttemptInFlight = true;
  try {
    const auth = await syncAuth();
    if (!hasLoginToken(auth)) return;
    let valid = false;
    try {
      valid = Boolean(await checkAuthWithTbs());
    } catch {
      valid = false;
    }
    if (!valid) return;
    await closeAuthWindow();
    const next = pendingStart;
    pendingStart = null;
    await storageRemove([STORAGE_KEYS.pendingAuth]);
    if (next) await launchJob(next);
    else {
      if (cachedState.status === PHASES.AUTH || cachedState.phase === PHASES.AUTH) {
        cachedState.status = PHASES.IDLE;
        cachedState.phase = PHASES.IDLE;
        cachedState.message = '登录状态已更新';
      }
      cachedState.updatedAt = new Date().toISOString();
      await persistNow();
      await closeOffscreen();
      setBadge();
      broadcastSnapshot();
    }
  } finally {
    authAttemptInFlight = false;
  }
}

async function ensureAuthReady(options) {
  const browserCookies = await authStore.readBrowser();
  const browserAuth = authStore.view({
    cookie: browserCookies.length ? 'browser-session' : '',
    tokenNames: [...new Set(browserCookies.map((cookie) => cookie.name))]
  });
  if (!hasLoginToken(browserAuth)) {
    await authStore.restoreSaved();
  }
  const auth = await syncAuth();
  if (hasLoginToken(auth)) {
    try {
      if (await checkAuthWithTbs()) return 'ready';
    } catch (error) {
      const failure = shared.classifyError(error);
      cachedState.status = cachedState.phase = PHASES.ERROR;
      cachedState.error = { category: failure.category, code: failure.code, message: failure.message };
      cachedState.message = failure.message;
      cachedState.updatedAt = new Date().toISOString();
      await persistNow({ summary: true });
      await closeOffscreen();
      setBadge();
      broadcastSnapshot();
      return 'error';
    }
  }
  await beginAuth(options);
  return 'auth';
}

function nextDailyTime(time, now = new Date()) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ''));
  const hour = match ? Number(match[1]) : 9;
  const minute = match ? Number(match[2]) : 0;
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function syncDailyAlarm() {
  if (!chrome.alarms) return;
  await alarmsClear(DAILY_ALARM);
  if (!cachedSettings.autoSign) return;
  chrome.alarms.create(DAILY_ALARM, { when: nextDailyTime(cachedSettings.autoTime) });
}

function prepareRunState(mode, seedState = null) {
  if (mode === 'all') {
    const state = shared.emptyState();
    state.runId = shared.makeRunId();
    state.mode = 'all';
    state.executorMode = 'offscreen';
    state.startedAt = new Date().toISOString();
    return state;
  }
  const state = shared.sanitizeState(seedState);
  state.runId = shared.makeRunId();
  state.mode = mode;
  state.executorMode = 'offscreen';
  if (mode === 'retry') {
    state.currentIndex = 0;
    state.progress.current = 0;
  }
  state.startedAt = new Date().toISOString();
  return state;
}

async function launchJob(options = {}) {
  await ensureLoaded();
  const mode = options.mode === 'retry' || options.mode === 'resume' ? options.mode : 'all';
  let seedState = null;
  let queue = [];
  if (mode === 'retry') {
    seedState = shared.sanitizeState(cachedState);
    queue = seedState.forums.filter((forum) => forum.status === 'fail').map((forum) => forum.name);
    if (!queue.length) return { ...snapshotResponse(), ok: false, error: '当前没有失败贴吧可重试' };
  } else if (mode === 'resume') {
    seedState = shared.sanitizeState(cachedState);
    queue = seedState.queue;
    if (!seedState.forums.length || !queue.length) return { ...snapshotResponse(), ok: false, error: '没有可恢复的中断任务' };
  }
  cachedState = prepareRunState(mode, seedState);
  cachedState.status = PHASES.STARTING;
  cachedState.phase = PHASES.STARTING;
  cachedState.message = options.auto ? '正在执行每日签到' : '正在启动签到';
  cachedState.error = null;
  cachedState.updatedAt = new Date().toISOString();
  await persistNow({ includeSettings: Boolean(options.settings) });
  setBadge();
  broadcastSnapshot();
  try {
    const response = await sendOffscreen({
      command: 'start',
      job: {
        runId: cachedState.runId,
        mode,
        settings: cachedSettings,
        state: seedState,
        queue,
        startPaused: options.startPaused === true
      }
    });
    if (!response || !response.ok) throw new Error(response && response.error || '隐藏执行器拒绝了任务');
    return snapshotResponse({ accepted: true, runId: cachedState.runId });
  } catch (error) {
    cachedState.status = PHASES.ERROR;
    cachedState.phase = PHASES.ERROR;
    cachedState.error = { category: 'network_error', code: '', message: error.message };
    cachedState.message = error.message;
    cachedState.updatedAt = new Date().toISOString();
    await persistNow({ summary: true });
    await closeOffscreen();
    setBadge();
    broadcastSnapshot();
    notify('贴吧签到失败', error.message);
    return { ...snapshotResponse(), ok: false, error: error.message };
  }
}

async function startJob(options = {}) {
  await ensureLoaded();
  if (ACTIVE_PHASES.has(cachedState.status)) return { ...snapshotResponse(), ok: false, error: '已有签到任务正在运行' };
  if (options.auto && cachedState.date === shared.todayKey() && cachedState.status === PHASES.COMPLETED) {
    return snapshotResponse({ skipped: true, reason: '今日已完成签到' });
  }
  const authState = await ensureAuthReady(options);
  if (authState === 'error') return { ...snapshotResponse(), ok: false, error: cachedState.message };
  if (authState !== 'ready') return snapshotResponse({ accepted: true, awaitingLogin: true });
  return launchJob(options);
}

async function relayJobCommand(command) {
  await ensureLoaded();
  if (command === 'resume' && cachedState.status === PHASES.INTERRUPTED) return launchJob({ mode: 'resume' });
  if (![PHASES.AUTH, ...ACTIVE_PHASES].some((phase) => phase === cachedState.status)) {
    return { ...snapshotResponse(), ok: false, error: '当前没有运行中的任务' };
  }
  try {
    const response = await sendOffscreen({ command, runId: cachedState.runId });
    if (!response || !response.ok) throw new Error(response && response.error || '隐藏执行器拒绝了命令');
    if (command === 'pause') cachedState.status = cachedState.phase = PHASES.PAUSED;
    if (command === 'resume') cachedState.status = cachedState.phase = PHASES.SIGNING;
    if (command === 'stop') cachedState.status = cachedState.phase = PHASES.STOPPING;
    cachedState.updatedAt = new Date().toISOString();
    await persistNow();
    setBadge();
    broadcastSnapshot();
    return snapshotResponse();
  } catch (error) {
    if (command === 'stop') {
      cachedState.status = cachedState.phase = PHASES.STOPPED;
      cachedState.message = '任务已停止';
      await persistNow({ summary: true });
      await closeOffscreen();
      setBadge();
      broadcastSnapshot();
      return snapshotResponse();
    }
    return { ...snapshotResponse(), ok: false, error: error.message };
  }
}

async function saveSettings(message) {
  await ensureLoaded();
  cachedSettings = shared.normalizeSettings({ ...cachedSettings, ...(message.settings || {}) });
  await persistNow({ includeSettings: true });
  await syncDailyAlarm();
  broadcastSnapshot();
  return snapshotResponse();
}

async function clearResults() {
  await ensureLoaded();
  if (ACTIVE_PHASES.has(cachedState.status)) return { ...snapshotResponse(), ok: false, error: '请先停止运行中的任务，再清除结果' };
  cachedState = shared.emptyState();
  await persistNow();
  await storageRemove([STORAGE_KEYS.lastSummary]);
  setBadge();
  broadcastSnapshot();
  return snapshotResponse();
}

async function refreshAuth() {
  await ensureLoaded();
  if (ACTIVE_PHASES.has(cachedState.status) && cachedState.status !== PHASES.AUTH) {
    return { ...snapshotResponse(), ok: false, error: '签到任务运行中，暂不能同步 Cookie' };
  }
  const auth = await syncAuth();
  if (!hasLoginToken(auth)) return beginAuth(null);
  try {
    const valid = await checkAuthWithTbs();
    if (!valid) return beginAuth(null);
  } catch (error) {
    await closeOffscreen();
    const failure = shared.classifyError(error);
    return { ...snapshotResponse(), ok: false, error: failure.message };
  }
  await closeOffscreen();
  return snapshotResponse({ refreshed: true }, { includeCookie: true });
}

async function openAuth() {
  await ensureLoaded();
  if (ACTIVE_PHASES.has(cachedState.status) && cachedState.status !== PHASES.AUTH) {
    return { ...snapshotResponse(), ok: false, error: '签到任务运行中，暂不能打开登录窗口' };
  }
  await syncAuth();
  const windowInfo = await focusOrCreateAuthWindow();
  return snapshotResponse(windowInfo);
}

async function clearAuth() {
  await ensureLoaded();
  cachedAuth = await authStore.clear();
  broadcastSnapshot();
  return snapshotResponse({}, { includeCookie: true });
}

async function handleExecutorEvent(message) {
  await ensureLoaded();
  if (message.target !== 'offscreen') return { ok: false, error: '无效的执行器来源' };
  if (message.event === 'READY') return { ok: true, ready: true };
  if (!message.state || !message.runId) return { ok: false, error: '执行器事件格式无效' };
  if (cachedState.runId && message.runId !== cachedState.runId) return { ok: true, stale: true };
  const incoming = shared.sanitizeState(message.state);
  if (cachedState.runId === incoming.runId && incoming.revision <= cachedState.revision) {
    return { ok: true, stale: true };
  }
  incoming.executorMode = 'offscreen';
  incoming.executorTabId = null;
  incoming.ownedExecutor = false;
  cachedState = incoming;
  await persistEvent(message.event);
  setBadge();
  broadcastSnapshot();
  if (message.event === 'RUN_FINISHED') {
    const counts = cachedState.counts;
    if (cachedState.status === PHASES.COMPLETED) notify('贴吧签到完成', `成功 ${counts.ok}，已签 ${counts.signed}，失败 ${counts.fail}`);
    if (cachedState.status === PHASES.ERROR) notify('贴吧签到失败', cachedState.message || '未知错误');
    await closeOffscreen();
  }
  return { ok: true };
}

async function handleMessage(message) {
  if (message.type === MSG.OFFSCREEN_EVENT) return handleExecutorEvent(message);
  await ensureLoaded();
  switch (message.type) {
    case MSG.GET_SNAPSHOT: return snapshotResponse();
    case MSG.START_JOB: return startJob({ mode: 'all', auto: false, settings: message.settings });
    case MSG.RETRY_FAILED: return startJob({ mode: 'retry', auto: false });
    case MSG.PAUSE_JOB: return relayJobCommand('pause');
    case MSG.RESUME_JOB: return relayJobCommand('resume');
    case MSG.STOP_JOB: return relayJobCommand('stop');
    case MSG.SAVE_SETTINGS: return saveSettings(message);
    case MSG.CLEAR_RESULTS: return clearResults();
    case MSG.GET_AUTH: return snapshotResponse({}, { includeCookie: true });
    case MSG.REFRESH_AUTH: return refreshAuth();
    case MSG.CLEAR_AUTH: return clearAuth();
    case MSG.OPEN_AUTH: return openAuth();
    case MSG.OPEN_TIEBA: return openAuth();
    default: return { ok: false, error: '无法识别的扩展命令' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.channel && message.channel !== CHANNEL) || message.type === MSG.STATE_UPDATED) return undefined;
  if (message.target === 'offscreen' && message.type !== MSG.OFFSCREEN_EVENT) return undefined;
  if (!Object.values(MSG).includes(message.type)) return undefined;
  handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

if (chrome.cookies && chrome.cookies.onChanged) {
  let cookieTimer = null;
  chrome.cookies.onChanged.addListener((change) => {
    const domain = String(change && change.cookie && change.cookie.domain || '').replace(/^\./, '');
    const name = String(change && change.cookie && change.cookie.name || '');
    const removed = change && change.removed === true;
    if (domain !== 'baidu.com' && !domain.endsWith('.baidu.com')) return;
    if (!authApi.TOKEN_NAMES.has(name)) return;
    clearTimeout(cookieTimer);
    cookieTimer = setTimeout(() => {
      ensureLoaded()
        .then(() => {
          const waitingForAuth = Boolean(
            pendingStart ||
            Number.isInteger(authWindowId) ||
            cachedState.status === PHASES.AUTH ||
            cachedState.phase === PHASES.AUTH
          );
          if (waitingForAuth) return tryCompleteAuth();
          if (removed) return undefined;
          return syncAuth();
        })
        .catch(() => {});
    }, 200);
  });
}

async function handleAuthWindowRemoved(windowId) {
  await ensureLoaded();
  if (windowId !== authWindowId) return;
  authWindowId = null;
  await sessionRemove([STORAGE_KEYS.authWindow]);
  if (pendingStart) {
    pendingStart = null;
    await storageRemove([STORAGE_KEYS.pendingAuth]);
    cachedState.status = cachedState.phase = PHASES.ERROR;
    cachedState.error = { category: shared.CATEGORIES.LOGIN_REQUIRED, code: '', message: '登录窗口已关闭' };
    cachedState.message = '登录窗口已关闭';
    await persistNow({ summary: true });
    setBadge();
    broadcastSnapshot();
    await closeOffscreen();
    return;
  }
  if (cachedState.status === PHASES.AUTH || cachedState.phase === PHASES.AUTH) {
    cachedState.status = cachedState.phase = PHASES.ERROR;
    cachedState.error = { category: shared.CATEGORIES.LOGIN_REQUIRED, code: '', message: '登录窗口已关闭' };
    cachedState.message = '登录窗口已关闭';
    await persistNow({ summary: true });
    setBadge();
    broadcastSnapshot();
  }
  await closeOffscreen();
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    handleAuthWindowRemoved(windowId).catch(() => {});
  });
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== DAILY_ALARM) return;
    ensureLoaded()
      .then(() => startJob({ mode: 'all', auto: true }))
      .finally(() => syncDailyAlarm())
      .catch(() => {});
  });
}

function initializeWorker() {
  ensureLoaded()
    .then(async () => {
      const offscreenAlive = (await offscreenContexts()).length > 0;
      if (ACTIVE_PHASES.has(cachedState.status) && cachedState.status !== PHASES.AUTH && !offscreenAlive) {
        cachedState.status = cachedState.phase = PHASES.INTERRUPTED;
        cachedState.message = '隐藏执行器已中断，可以继续未完成任务';
        cachedState.updatedAt = new Date().toISOString();
        await persistNow({ summary: true });
        broadcastSnapshot();
      }
      await persistNow({ includeSettings: true });
      await syncDailyAlarm();
      setBadge();
      if (pendingStart) await tryCompleteAuth();
    })
    .catch((error) => {
      console.error('扩展后台初始化失败', error);
    });
}

chrome.runtime.onInstalled.addListener(initializeWorker);
chrome.runtime.onStartup.addListener(initializeWorker);
initializeWorker();
