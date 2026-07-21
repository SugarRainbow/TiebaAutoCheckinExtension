(() => {
  'use strict';

  const shared = globalThis.TIEBA_EXT || globalThis.TiebaShared || {};
  const CHANNEL = shared.CHANNEL || 'tieba-sign-extension-v1';
  const MSG = shared.MSG || {};
  const EXTENSION_VERSION = String(globalThis.chrome?.runtime?.getManifest?.().version || '3.1.1');
  const STORAGE_KEYS = new Set([
    shared.STORAGE_KEYS?.settings || 'tieba.extension.settings.v1',
    shared.STORAGE_KEYS?.state || 'tieba.extension.state.v1',
    shared.STORAGE_KEYS?.lastSummary || 'tieba.extension.last-summary.v1',
    shared.STORAGE_KEYS?.auth || 'tieba.extension.auth.v1'
  ]);

  const DEFAULT_SETTINGS = {
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
  };

  const EMPTY_COUNTS = { ok: 0, signed: 0, fail: 0, pending: 0, total: 0 };

  const STATUS_LABELS = {
    pending: '等待',
    checking: '检查中',
    unsigned: '未签',
    signing: '签到中',
    ok: '成功',
    signed: '已签',
    fail: '失败'
  };

  const PHASE_LABELS = {
    preparing: '正在准备',
    auth: '正在检查登录状态',
    tbs: '正在获取 tbs',
    scanning: '正在扫描关注贴吧',
    scan: '正在扫描关注贴吧',
    checking: '正在检查签到状态',
    check: '正在检查签到状态',
    signing: '正在签到',
    sign: '正在签到',
    retrying: '正在重试失败项',
    retry: '正在重试失败项',
    stopping: '正在停止任务'
  };

  // AndroidX Material 3 LinearWavyProgressIndicator defaults (v0_7_0 tokens).
  const WAVY_PROGRESS_TOKENS = Object.freeze({
    containerHeight: 10,
    strokeWidth: 4,
    amplitude: 3,
    wavelength: 40,
    minimumVisibleLength: 40,
    gapSize: 4,
    stopSize: 4,
    waveSpeed: 40
  });
  const SIGNING_PHASES = new Set(['signing', 'sign']);
  const INACTIVE_SIGNING_STATUSES = new Set([
    'auth', 'completed', 'error', 'idle', 'interrupted', 'paused', 'stopped', 'stopping'
  ]);
  const INDETERMINATE_PHASES = new Set(['auth', 'starting', 'preparing', 'tbs', 'scanning', 'scan']);
  const reducedMotionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') || {
    matches: false
  };

  // Apache-2.0 Material Symbols Rounded paths from google/material-design-icons.
  const MATERIAL_SYMBOL_PATHS = Object.freeze({
    play_arrow: 'M320-273v-414q0-17 12-28.5t28-11.5q5 0 10.5 1.5T381-721l326 207q9 6 13.5 15t4.5 19q0 10-4.5 19T707-446L381-239q-5 3-10.5 4.5T360-233q-16 0-28-11.5T320-273Z',
    pause: 'M640-200q-33 0-56.5-23.5T560-280v-400q0-33 23.5-56.5T640-760q33 0 56.5 23.5T720-680v400q0 33-23.5 56.5T640-200Zm-320 0q-33 0-56.5-23.5T240-280v-400q0-33 23.5-56.5T320-760q33 0 56.5 23.5T400-680v400q0 33-23.5 56.5T320-200Z',
    stop: 'M240-320v-320q0-33 23.5-56.5T320-720h320q33 0 56.5 23.5T720-640v320q0 33-23.5 56.5T640-240H320q-33 0-56.5-23.5T240-320Z',
    check: 'm382-354 339-339q12-12 28-12t28 12q12 12 12 28.5T777-636L410-268q-12 12-28 12t-28-12L182-440q-12-12-11.5-28.5T183-497q12-12 28.5-12t28.5 12l142 143Z',
    priority_high: 'M480-120q-33 0-56.5-23.5T400-200q0-33 23.5-56.5T480-280q33 0 56.5 23.5T560-200q0 33-23.5 56.5T480-120Zm0-240q-33 0-56.5-23.5T400-440v-320q0-33 23.5-56.5T480-840q33 0 56.5 23.5T560-760v320q0 33-23.5 56.5T480-360Z',
    pause_circle: 'M400-320q17 0 28.5-11.5T440-360v-240q0-17-11.5-28.5T400-640q-17 0-28.5 11.5T360-600v240q0 17 11.5 28.5T400-320Zm160 0q17 0 28.5-11.5T600-360v-240q0-17-11.5-28.5T560-640q-17 0-28.5 11.5T520-600v240q0 17 11.5 28.5T560-320ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Z',
    progress_activity: 'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q17 0 28.5 11.5T520-840q0 17-11.5 28.5T480-800q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160q133 0 226.5-93.5T800-480q0-17 11.5-28.5T840-520q17 0 28.5 11.5T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Z',
    login: 'M520-120q-17 0-28.5-11.5T480-160q0-17 11.5-28.5T520-200h240v-560H520q-17 0-28.5-11.5T480-800q0-17 11.5-28.5T520-840h240q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H520Zm-73-320H160q-17 0-28.5-11.5T120-480q0-17 11.5-28.5T160-520h287l-75-75q-11-11-11-27t11-28q11-12 28-12.5t29 11.5l143 143q12 12 12 28t-12 28L429-309q-12 12-28.5 11.5T372-310q-11-12-10.5-28.5T373-366l74-74Z',
    task_alt: 'M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q48 0 93.5 11t87.5 32q15 8 19.5 24t-5.5 30q-10 14-26.5 18t-32.5-4q-32-15-66.5-23t-69.5-8q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160q133 0 226.5-93.5T800-480q0-8-.5-15.5T798-511q-2-17 6.5-32.5T830-564q16-5 30 3t16 24q2 14 3 28t1 29q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm-56-328 372-373q11-11 27.5-11.5T852-781q11 11 11 28t-11 28L452-324q-12 12-28 12t-28-12L282-438q-11-11-11-28t11-28q11-11 28-11t28 11l86 86Z',
    warning: 'M109-120q-11 0-20-5.5T75-140q-5-9-5.5-19.5T75-180l370-640q6-10 15.5-15t19.5-5q10 0 19.5 5t15.5 15l370 640q6 10 5.5 20.5T885-140q-5 9-14 14.5t-20 5.5H109Zm69-80h604L480-720 178-200Zm302-40q17 0 28.5-11.5T520-280q0-17-11.5-28.5T480-320q-17 0-28.5 11.5T440-280q0 17 11.5 28.5T480-240Zm0-120q17 0 28.5-11.5T520-400v-120q0-17-11.5-28.5T480-560q-17 0-28.5 11.5T440-520v120q0 17 11.5 28.5T480-360Z',
    error: 'M480-280q17 0 28.5-11.5T520-320q0-17-11.5-28.5T480-360q-17 0-28.5 11.5T440-320q0 17 11.5 28.5T480-280Zm0-160q17 0 28.5-11.5T520-480v-160q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640v160q0 17 11.5 28.5T480-440Zm0 360q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Z',
    stop_circle: 'M360-320h240q17 0 28.5-11.5T640-360v-240q0-17-11.5-28.5T600-640H360q-17 0-28.5 11.5T320-600v240q0 17 11.5 28.5T360-320ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Z'
  });

  const els = {
    versionText: document.querySelector('#versionText'),
    refreshButton: document.querySelector('#refreshButton'),
    settingsButton: document.querySelector('#settingsButton'),
    mainView: document.querySelector('#mainView'),
    settingsView: document.querySelector('#settingsView'),
    statusPanel: document.querySelector('#statusPanel'),
    statusGlyph: document.querySelector('#statusGlyph'),
    statusGlyphPath: document.querySelector('#statusGlyphPath'),
    statusTitle: document.querySelector('#statusTitle'),
    statusMessage: document.querySelector('#statusMessage'),
    progressBlock: document.querySelector('#progressBlock'),
    progressLabel: document.querySelector('#progressLabel'),
    progressCount: document.querySelector('#progressCount'),
    progressTrack: document.querySelector('#progressTrack'),
    progressWaveSvg: document.querySelector('#progressWaveSvg'),
    progressWaveTrack: document.querySelector('#progressWaveTrack'),
    progressBar: document.querySelector('#progressBar'),
    progressStop: document.querySelector('#progressStop'),
    currentForum: document.querySelector('#currentForum'),
    idleActions: document.querySelector('#idleActions'),
    runningActions: document.querySelector('#runningActions'),
    startButton: document.querySelector('#startButton'),
    startButtonText: document.querySelector('#startButtonText'),
    pauseButton: document.querySelector('#pauseButton'),
    resumeButton: document.querySelector('#resumeButton'),
    stopButton: document.querySelector('#stopButton'),
    totalCount: document.querySelector('#totalCount'),
    successCount: document.querySelector('#successCount'),
    signedCount: document.querySelector('#signedCount'),
    failCount: document.querySelector('#failCount'),
    resultMeta: document.querySelector('#resultMeta'),
    clearButton: document.querySelector('#clearButton'),
    resultList: document.querySelector('#resultList'),
    footerActions: document.querySelector('#footerActions'),
    retryButton: document.querySelector('#retryButton'),
    retryButtonText: document.querySelector('#retryButtonText'),
    backButton: document.querySelector('#backButton'),
    cancelSettingsButton: document.querySelector('#cancelSettingsButton'),
    settingsForm: document.querySelector('#settingsForm'),
    maxPagesInput: document.querySelector('#maxPagesInput'),
    maxRefreshesInput: document.querySelector('#maxRefreshesInput'),
    minDelayInput: document.querySelector('#minDelayInput'),
    maxDelayInput: document.querySelector('#maxDelayInput'),
    requestTimeoutInput: document.querySelector('#requestTimeoutInput'),
    networkRetriesInput: document.querySelector('#networkRetriesInput'),
    rateLimitRetriesInput: document.querySelector('#rateLimitRetriesInput'),
    retryBaseDelayInput: document.querySelector('#retryBaseDelayInput'),
    autoSignInput: document.querySelector('#autoSignInput'),
    autoTimeRow: document.querySelector('#autoTimeRow'),
    autoTimeInput: document.querySelector('#autoTimeInput'),
    notificationsInput: document.querySelector('#notificationsInput'),
    savedCookieInput: document.querySelector('#savedCookieInput'),
    cookieVisibilityButton: document.querySelector('#cookieVisibilityButton'),
    refreshCookieButton: document.querySelector('#refreshCookieButton'),
    clearCookieButton: document.querySelector('#clearCookieButton'),
    openAuthButton: document.querySelector('#openAuthButton'),
    authStatus: document.querySelector('#authStatus'),
    cookieMeta: document.querySelector('#cookieMeta'),
    saveSettingsButton: document.querySelector('#saveSettingsButton'),
    formError: document.querySelector('#formError'),
    toast: document.querySelector('#toast')
  };

  let snapshot = {
    status: 'idle',
    phase: '',
    progress: { current: 0, total: 0, label: '' },
    counts: { ...EMPTY_COUNTS },
    forums: [],
    logs: [],
    message: '',
    error: null
  };
  let settings = { ...DEFAULT_SETTINGS };
  let auth = {
    cookie: '',
    tokenNames: [],
    savedAt: '',
    hasCookie: false,
    hasLoginToken: false
  };
  let cookieVisible = false;
  let busyAction = '';
  let toastTimer = null;
  let storageRefreshTimer = null;
  let waveAnimationFrame = 0;
  let waveLastFrameTime = 0;
  let wavePhase = 0;
  let waveProgressRatio = 0;

  Object.assign(els.progressTrack.dataset, {
    waveStroke: String(WAVY_PROGRESS_TOKENS.strokeWidth),
    wavePeak: String(WAVY_PROGRESS_TOKENS.amplitude),
    waveWavelength: String(WAVY_PROGRESS_TOKENS.wavelength),
    waveMinimum: String(WAVY_PROGRESS_TOKENS.minimumVisibleLength),
    waveGap: String(WAVY_PROGRESS_TOKENS.gapSize),
    waveStop: String(WAVY_PROGRESS_TOKENS.stopSize),
    waveSpeed: String(WAVY_PROGRESS_TOKENS.waveSpeed)
  });

  function messageType(name) {
    return MSG[name] || name;
  }

  async function sendMessage(type, payload = {}) {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error('扩展运行环境不可用');
    }
    const response = await globalThis.chrome.runtime.sendMessage({
      channel: CHANNEL,
      type: messageType(type),
      ...payload
    });
    if (!response) throw new Error('后台没有返回结果');
    if (response.ok === false) {
      const message = typeof response.error === 'string'
        ? response.error
        : response.error?.message || response.message || '操作失败';
      throw new Error(message);
    }
    return response;
  }

  function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function buildWavePath(startX, endX, phase) {
    if (!(endX > startX)) return '';
    const { amplitude, containerHeight, wavelength } = WAVY_PROGRESS_TOKENS;
    const centerY = containerHeight / 2;
    const halfWavelength = wavelength / 2;
    const baseEnd = endX + phase;
    let baseCursor = startX + phase;
    let segmentIndex = Math.floor(baseCursor / halfWavelength);
    const parts = [];

    while (baseCursor < baseEnd - 0.0001) {
      const segmentStart = segmentIndex * halfWavelength;
      const segmentEnd = segmentStart + halfWavelength;
      const chunkEnd = Math.min(baseEnd, segmentEnd);
      const startT = clamp((baseCursor - segmentStart) / halfWavelength, 0, 1);
      const endT = clamp((chunkEnd - segmentStart) / halfWavelength, 0, 1);
      const interval = endT - startT;
      const direction = segmentIndex % 2 === 0 ? 1 : -1;
      const ordinate = (t) => centerY + direction * 4 * amplitude * t * (1 - t);
      const startY = ordinate(startT);
      const endY = ordinate(endT);
      // Re-parameterize the requested sub-curve with De Casteljau. AndroidX
      // uses a control offset of 2 × amplitude, which peaks at exactly 3dp.
      const controlX = baseCursor + (chunkEnd - baseCursor) / 2 - phase;
      const controlY = startY + interval * 2 * amplitude * direction * (1 - 2 * startT);
      const renderedStartX = baseCursor - phase;
      const renderedEndX = chunkEnd - phase;
      if (!parts.length) parts.push(`M${renderedStartX.toFixed(2)} ${startY.toFixed(2)}`);
      parts.push(
        `Q${controlX.toFixed(2)} ${controlY.toFixed(2)} ${renderedEndX.toFixed(2)} ${endY.toFixed(2)}`
      );
      baseCursor = chunkEnd;
      segmentIndex += 1;
    }
    return parts.join('');
  }

  function renderWavyGeometry() {
    if (!els.progressTrack || !els.progressWaveSvg || !els.progressWaveTrack || !els.progressBar || !els.progressStop) return;
    const width = els.progressTrack.getBoundingClientRect().width;
    if (!(width > 0)) return;

    const {
      containerHeight,
      gapSize,
      minimumVisibleLength,
      stopSize,
      strokeWidth
    } = WAVY_PROGRESS_TOKENS;
    const centerY = containerHeight / 2;
    const strokeInset = strokeWidth / 2;
    const ratio = clamp(waveProgressRatio, 0, 1);
    const semanticHead = width * ratio;
    const minimumHead = Math.min(width - strokeInset, strokeInset + minimumVisibleLength);
    const visualHead = els.progressTrack.dataset.variant === 'wavy' && ratio < 1
      ? Math.max(semanticHead, minimumHead)
      : semanticHead;
    const activeVisible = visualHead >= strokeInset;
    const activeHead = clamp(visualHead, strokeInset, width - strokeInset);
    const wavePath = activeVisible
      ? buildWavePath(strokeInset, activeHead, wavePhase)
      : '';

    // AndroidX adds the requested 4dp visible gap plus both rounded cap radii.
    const trackStart = activeVisible
      ? Math.min(width - strokeInset, activeHead + gapSize + strokeWidth)
      : strokeInset;
    const trackEnd = width - strokeInset;
    const trackPath = ratio < 1 && trackEnd > trackStart
      ? `M${trackStart.toFixed(2)} ${centerY}H${trackEnd.toFixed(2)}`
      : '';

    // Match drawStopIndicator(): the 4dp stop shrinks only when progress reaches it.
    let renderedStopSize = Math.min(strokeWidth, stopSize);
    let stopLeft = width - renderedStopSize;
    const progressX = semanticHead + strokeInset;
    if (stopLeft <= progressX) {
      renderedStopSize = Math.max(0, renderedStopSize - (progressX - stopLeft));
      stopLeft = progressX;
    }

    els.progressWaveSvg.setAttribute('viewBox', `0 0 ${width.toFixed(2)} ${containerHeight}`);
    els.progressWaveTrack.setAttribute('d', trackPath);
    els.progressBar.setAttribute('d', wavePath);
    els.progressStop.setAttribute('cx', (stopLeft + renderedStopSize / 2).toFixed(2));
    els.progressStop.setAttribute('cy', String(centerY));
    els.progressStop.setAttribute('r', (renderedStopSize / 2).toFixed(2));
  }

  function stopWaveAnimation() {
    if (waveAnimationFrame) globalThis.cancelAnimationFrame?.(waveAnimationFrame);
    waveAnimationFrame = 0;
    waveLastFrameTime = 0;
  }

  function animateWave(timestamp) {
    if (els.progressTrack.dataset.variant !== 'wavy' || reducedMotionQuery.matches || els.progressBlock.hidden) {
      stopWaveAnimation();
      renderWavyGeometry();
      return;
    }
    if (waveLastFrameTime) {
      const elapsed = Math.min(64, Math.max(0, timestamp - waveLastFrameTime));
      wavePhase = (wavePhase + elapsed * WAVY_PROGRESS_TOKENS.waveSpeed / 1000)
        % WAVY_PROGRESS_TOKENS.wavelength;
    }
    waveLastFrameTime = timestamp;
    renderWavyGeometry();
    waveAnimationFrame = globalThis.requestAnimationFrame?.(animateWave) || 0;
  }

  function syncWaveAnimation() {
    const shouldAnimate = els.progressTrack.dataset.variant === 'wavy'
      && !reducedMotionQuery.matches
      && !document.hidden
      && !els.progressBlock.hidden;
    if (shouldAnimate && !waveAnimationFrame) {
      waveLastFrameTime = 0;
      waveAnimationFrame = globalThis.requestAnimationFrame?.(animateWave) || 0;
    } else if (!shouldAnimate) {
      stopWaveAnimation();
      if (reducedMotionQuery.matches) wavePhase = 0;
      renderWavyGeometry();
    }
  }

  function normalizeState(value) {
    const next = value && typeof value === 'object' ? value : {};
    const progress = next.progress && typeof next.progress === 'object' ? next.progress : {};
    const counts = next.counts && typeof next.counts === 'object' ? next.counts : {};
    const forums = Array.isArray(next.forums) ? next.forums : [];
    const logs = Array.isArray(next.logs) ? next.logs : [];
    const total = asNumber(counts.total, asNumber(next.total, forums.length));
    const current = asNumber(progress.current, asNumber(next.currentIndex, 0));

    return {
      ...snapshot,
      ...next,
      status: String(next.status || 'idle').toLowerCase(),
      phase: String(next.phase || '').toLowerCase(),
      progress: {
        current,
        total: asNumber(progress.total, total),
        label: String(progress.label || '')
      },
      counts: {
        ok: asNumber(counts.ok, 0),
        signed: asNumber(counts.signed, 0),
        fail: asNumber(counts.fail, 0),
        pending: asNumber(counts.pending, 0),
        total
      },
      forums,
      logs,
      message: String(next.message || ''),
      error: next.error && typeof next.error === 'object' ? next.error : null
    };
  }

  function normalizeAuth(value) {
    const next = value && typeof value === 'object' ? value : {};
    const includesCookie = Object.prototype.hasOwnProperty.call(next, 'cookie');
    return {
      cookie: includesCookie ? String(next.cookie || '') : auth.cookie,
      tokenNames: Array.isArray(next.tokenNames) ? next.tokenNames.map(String) : [],
      savedAt: String(next.savedAt || ''),
      hasCookie: Boolean(next.hasCookie || next.cookie),
      hasLoginToken: Boolean(next.hasLoginToken)
    };
  }

  function applyPayload(payload) {
    if (payload?.state) {
      const incoming = normalizeState(payload.state);
      const sameRun = incoming.runId && incoming.runId === snapshot.runId;
      if (!sameRun || asNumber(incoming.revision, 0) >= asNumber(snapshot.revision, 0)) snapshot = incoming;
    }
    if (payload?.settings) settings = { ...DEFAULT_SETTINGS, ...payload.settings };
    if (payload?.auth) auth = normalizeAuth(payload.auth);
    render();
  }

  function isRunning(state = snapshot) {
    return ['running', 'starting', 'scanning', 'checking', 'signing', 'paused', 'stopping'].includes(state.status)
      || ['preparing', 'auth', 'tbs', 'scanning', 'scan', 'checking', 'check', 'signing', 'sign', 'retrying', 'retry', 'paused', 'stopping'].includes(state.phase);
  }

  function isLoginError(state = snapshot) {
    const category = String(state.error?.category || '');
    const message = `${state.error?.message || ''} ${state.message || ''}`;
    return category === 'login_required' || /未登录|登录.*失效|请.*登录|cookie|bduss/i.test(message);
  }

  function isRateLimited(state = snapshot) {
    const category = String(state.error?.category || '');
    const message = `${state.error?.message || ''} ${state.message || ''}`;
    return category === 'rate_limited' || /频率|风控|稍后.*重试/.test(message);
  }

  function isInterrupted(state = snapshot) {
    return state.status === 'interrupted' || state.phase === 'interrupted';
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  }

  function statusPresentation() {
    const active = isRunning();
    const loginError = isLoginError();
    const failCount = snapshot.counts.fail;
    const updatedAt = formatTime(snapshot.updatedAt || snapshot.startedAt);

    if (snapshot.status === 'paused' || snapshot.phase === 'paused') {
      return {
        tone: 'warning',
        icon: 'pause',
        title: '任务已暂停',
        message: snapshot.message || (snapshot.currentForum ? `停在：${snapshot.currentForum}` : '可以继续或停止当前任务')
      };
    }

    if (active) {
      const waitingForLogin = snapshot.status === 'auth' || snapshot.phase === 'auth';
      return {
        tone: 'active',
        icon: waitingForLogin ? 'login' : snapshot.status === 'stopping' ? 'stop_circle' : 'progress_activity',
        title: waitingForLogin ? '等待贴吧登录' : PHASE_LABELS[snapshot.phase] || '任务正在运行',
        message: snapshot.message || (snapshot.currentForum ? `正在处理：${snapshot.currentForum}` : '关闭弹窗不会中断任务')
      };
    }

    if (snapshot.status === 'completed' || snapshot.status === 'success' || snapshot.status === 'done') {
      return {
        tone: failCount > 0 ? 'warning' : 'success',
        icon: failCount > 0 ? 'warning' : 'check',
        title: failCount > 0 ? `签到完成，${failCount} 个失败` : '今日签到完成',
        message: snapshot.message || (updatedAt ? `完成于 ${updatedAt}` : '所有贴吧均已处理')
      };
    }

    if (snapshot.status === 'error' || snapshot.error) {
      if (loginError) {
        return {
          tone: 'warning',
          icon: 'login',
          title: '需要登录贴吧',
          message: snapshot.error?.message || snapshot.message || '登录贴吧后再重新签到'
        };
      }
      if (isRateLimited()) {
        return {
          tone: 'warning',
          icon: 'warning',
          title: '请求受到限制',
          message: snapshot.error?.message || snapshot.message || '请稍后再试，或调高请求间隔'
        };
      }
      return {
        tone: 'danger',
        icon: 'priority_high',
        title: '签到遇到问题',
        message: snapshot.error?.message || snapshot.message || '请刷新状态后重试'
      };
    }

    if (snapshot.status === 'stopped' || snapshot.status === 'cancelled') {
      return {
        tone: 'neutral',
        icon: 'stop',
        title: '任务已停止',
        message: snapshot.message || (updatedAt ? `停止于 ${updatedAt}` : '可以重新开始签到')
      };
    }

    if (isInterrupted()) {
      return {
        tone: 'warning',
        icon: 'warning',
        title: '任务已中断',
        message: snapshot.message || '可以从已保存进度继续任务'
      };
    }

    return {
      tone: 'neutral',
      icon: 'play_arrow',
      title: snapshot.forums.length ? '可以再次签到' : '准备签到',
      message: snapshot.message || '使用当前 Edge 的贴吧登录状态'
    };
  }

  function renderStatus() {
    const presentation = statusPresentation();
    const running = isRunning();
    const waitingForLogin = snapshot.status === 'auth' || snapshot.phase === 'auth';
    const loginError = isLoginError();
    const current = clamp(asNumber(snapshot.progress.current, 0), 0, Number.MAX_SAFE_INTEGER);
    const total = Math.max(0, asNumber(snapshot.progress.total, snapshot.counts.total));
    const percentage = total > 0 ? clamp((current / total) * 100, 0, 100) : 0;
    const statusPhase = String(snapshot.status || '').toLowerCase();
    const taskPhase = String(snapshot.phase || '').toLowerCase();
    const progressPhase = taskPhase || statusPhase;
    const indeterminatePhase = INDETERMINATE_PHASES.has(progressPhase);
    const determinate = total > 0 && !waitingForLogin && !indeterminatePhase;
    const signingPhase = (SIGNING_PHASES.has(taskPhase) || SIGNING_PHASES.has(statusPhase))
      && !INACTIVE_SIGNING_STATUSES.has(statusPhase);
    const progressRatio = percentage / 100;

    els.statusPanel.dataset.tone = presentation.tone;
    const icon = MATERIAL_SYMBOL_PATHS[presentation.icon] ? presentation.icon : 'play_arrow';
    els.statusGlyph.dataset.icon = icon;
    els.statusGlyphPath.setAttribute('d', MATERIAL_SYMBOL_PATHS[icon]);
    els.statusTitle.textContent = presentation.title;
    els.statusMessage.textContent = presentation.message;
    els.versionText.textContent = `版本 ${EXTENSION_VERSION}`;
    els.progressBlock.hidden = !running;
    els.idleActions.hidden = running && !waitingForLogin;
    els.runningActions.hidden = !running || waitingForLogin;
    els.settingsButton.disabled = (running && !waitingForLogin) || busyAction !== '';
    els.progressTrack.dataset.mode = determinate ? 'determinate' : 'indeterminate';
    els.progressTrack.dataset.variant = signingPhase ? 'wavy' : 'linear';
    els.progressTrack.dataset.complete = String(determinate && percentage >= 100);
    els.progressTrack.dataset.waveAmplitude = signingPhase && determinate
      ? 'full'
      : 'flat';
    els.progressTrack.style.setProperty('--progress-ratio', String(progressRatio));
    els.progressTrack.dataset.progress = percentage.toFixed(2);
    waveProgressRatio = progressRatio;

    if (running) {
      els.progressLabel.textContent = waitingForLogin
        ? '正在检查登录状态'
        : snapshot.progress.label || PHASE_LABELS[snapshot.phase] || '正在处理';
      els.progressCount.textContent = determinate ? `${current} / ${total}` : '处理中';
      if (determinate) {
        els.progressTrack.setAttribute('aria-valuemax', String(total));
        els.progressTrack.setAttribute('aria-valuenow', String(current));
        els.progressTrack.removeAttribute('aria-valuetext');
      } else {
        els.progressTrack.removeAttribute('aria-valuemax');
        els.progressTrack.removeAttribute('aria-valuenow');
        els.progressTrack.setAttribute('aria-valuetext', '处理中');
      }
      els.currentForum.textContent = waitingForLogin
        ? '等待登录状态更新'
        : snapshot.currentForum ? `当前：${snapshot.currentForum}` : '正在准备任务';
      els.currentForum.title = waitingForLogin ? '' : snapshot.currentForum || '';
    }

    renderWavyGeometry();
    syncWaveAnimation();

    const paused = snapshot.status === 'paused' || snapshot.phase === 'paused';
    els.pauseButton.hidden = !running || paused || waitingForLogin;
    els.resumeButton.hidden = !running || !paused || waitingForLogin;

    els.startButton.dataset.action = loginError || waitingForLogin
      ? 'open-auth'
      : isInterrupted() ? 'resume-interrupted' : 'start';
    els.startButtonText.textContent = loginError || waitingForLogin
      ? '打开登录窗口'
      : isInterrupted()
        ? '继续任务'
      : (snapshot.status === 'completed' || snapshot.status === 'done' || snapshot.status === 'success')
        ? '再次签到'
        : '开始签到';
    els.startButton.disabled = busyAction !== '';
    els.pauseButton.disabled = busyAction !== '';
    els.resumeButton.disabled = busyAction !== '';
    els.stopButton.disabled = busyAction !== '';
  }

  function renderCounts() {
    els.totalCount.textContent = String(snapshot.counts.total);
    els.successCount.textContent = String(snapshot.counts.ok);
    els.signedCount.textContent = String(snapshot.counts.signed);
    els.failCount.textContent = String(snapshot.counts.fail);
  }

  function forumMessage(forum) {
    if (forum.message) return String(forum.message);
    if (forum.status === 'pending') return '等待处理';
    if (forum.status === 'checking') return '正在检查签到状态';
    if (forum.status === 'signing') return '正在提交签到';
    if (forum.status === 'unsigned') return '今日尚未签到';
    if (forum.status === 'ok') return '签到成功';
    if (forum.status === 'signed') return '今日已签到';
    if (forum.status === 'fail') return forum.category || '签到失败';
    return '';
  }

  function renderResults() {
    const forums = snapshot.forums;
    const oldScrollTop = els.resultList.scrollTop;
    const wasNearBottom = els.resultList.scrollHeight - els.resultList.clientHeight - oldScrollTop < 24;
    els.resultList.replaceChildren();

    if (!forums.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<span class="empty-icon" aria-hidden="true"><svg class="material-symbol" viewBox="0 -960 960 960"><path d="m424-408-86-86q-11-11-28-11t-28 11q-11 11-11 28t11 28l114 114q12 12 28 12t28-12l226-226q11-11 11-28t-11-28q-11-11-28-11t-28 11L424-408Zm56 328q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z"/></svg></span><p>暂无签到记录</p>';
      els.resultList.appendChild(empty);
      els.resultMeta.textContent = '尚无签到记录';
      els.clearButton.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const forum of forums) {
      const status = String(forum.status || 'pending').toLowerCase();
      const row = document.createElement('div');
      row.className = 'result-row';
      row.setAttribute('role', 'listitem');

      const copy = document.createElement('div');
      copy.className = 'result-copy';
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = String(forum.name || '未命名贴吧');
      name.title = name.textContent;
      const message = document.createElement('span');
      message.className = 'result-message';
      message.textContent = forumMessage(forum);
      message.title = message.textContent;
      copy.append(name, message);

      const badge = document.createElement('span');
      badge.className = 'status-badge';
      badge.dataset.status = status;
      badge.textContent = STATUS_LABELS[status] || '未知';

      row.append(copy, badge);
      fragment.appendChild(row);
    }
    els.resultList.appendChild(fragment);
    els.resultMeta.textContent = `已记录 ${forums.length} 个贴吧`;
    els.clearButton.hidden = isRunning();
    els.clearButton.disabled = busyAction !== '';

    if (wasNearBottom && isRunning()) {
      els.resultList.scrollTop = els.resultList.scrollHeight;
    } else {
      els.resultList.scrollTop = oldScrollTop;
    }
  }

  function renderActions() {
    const failures = snapshot.counts.fail;
    const showRetry = failures > 0 && !isRunning();
    els.footerActions.hidden = !showRetry;
    els.retryButtonText.textContent = `重试失败项（${failures}）`;
    els.retryButton.disabled = busyAction !== '';
    els.refreshButton.disabled = busyAction !== '';
  }

  function renderAuth() {
    const hasCookie = Boolean(auth.hasCookie && auth.cookie);
    const ready = Boolean(auth.hasLoginToken && hasCookie);
    els.savedCookieInput.value = auth.cookie;
    els.savedCookieInput.placeholder = hasCookie ? '' : '未保存';
    els.savedCookieInput.type = cookieVisible ? 'text' : 'password';
    els.cookieVisibilityButton.disabled = !hasCookie || busyAction !== '';
    els.cookieVisibilityButton.setAttribute('aria-pressed', String(cookieVisible));
    els.cookieVisibilityButton.setAttribute('aria-label', cookieVisible ? '隐藏 Cookie' : '显示 Cookie');
    els.cookieVisibilityButton.title = cookieVisible ? '隐藏 Cookie' : '显示 Cookie';
    els.refreshCookieButton.disabled = busyAction !== '';
    els.clearCookieButton.disabled = !hasCookie || busyAction !== '';
    els.openAuthButton.disabled = busyAction !== '';

    if (ready) {
      els.authStatus.dataset.state = 'ready';
      els.authStatus.textContent = '已保存';
    } else if (hasCookie) {
      els.authStatus.dataset.state = 'invalid';
      els.authStatus.textContent = '需登录';
    } else {
      els.authStatus.dataset.state = 'missing';
      els.authStatus.textContent = '未保存';
    }

    const savedAt = formatTime(auth.savedAt);
    const tokens = auth.tokenNames.length ? auth.tokenNames.join(' / ') : '';
    els.cookieMeta.textContent = hasCookie
      ? [savedAt ? `保存于 ${savedAt}` : '', tokens].filter(Boolean).join(' · ') || '登录 Cookie 已保存'
      : '尚未捕获登录 Cookie';
    els.cookieMeta.title = els.cookieMeta.textContent;
  }

  function render() {
    renderStatus();
    renderCounts();
    renderResults();
    renderActions();
    renderAuth();
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.hidden = false;
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2600);
  }

  function showFormError(message = '') {
    els.formError.textContent = message;
    els.formError.hidden = !message;
  }

  async function performAction(name, task) {
    if (busyAction) return;
    busyAction = name;
    render();
    try {
      const response = await task();
      applyPayload(response);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '操作失败');
    } finally {
      busyAction = '';
      render();
    }
  }

  async function refreshSnapshot({ silent = false } = {}) {
    try {
      const response = await sendMessage('GET_SNAPSHOT');
      applyPayload(response);
    } catch (error) {
      if (!silent) showToast(error instanceof Error ? error.message : '读取状态失败');
    }
  }

  function fillSettingsForm() {
    const signModeInput = els.settingsForm.elements.namedItem('signMode');
    if (signModeInput && typeof signModeInput.length === 'number') {
      for (const radio of signModeInput) radio.checked = radio.value === settings.signMode;
    }
    els.maxPagesInput.value = String(settings.maxPages);
    els.maxRefreshesInput.value = String(settings.maxRefreshes);
    els.minDelayInput.value = String(settings.minDelay);
    els.maxDelayInput.value = String(settings.maxDelay);
    els.requestTimeoutInput.value = String(Math.round(settings.requestTimeout / 1000));
    els.networkRetriesInput.value = String(settings.networkRetries);
    els.rateLimitRetriesInput.value = String(settings.rateLimitRetries);
    els.retryBaseDelayInput.value = String(settings.retryBaseDelay);
    els.autoSignInput.checked = Boolean(settings.autoSign);
    els.autoTimeInput.value = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(settings.autoTime || '')) ? settings.autoTime : '09:00';
    els.notificationsInput.checked = settings.notifications !== false;
    updateAutomationFields();
    showFormError();
  }

  function showSettings() {
    fillSettingsForm();
    els.mainView.hidden = true;
    els.settingsView.hidden = false;
    document.body.dataset.view = 'settings';
    els.settingsForm.querySelector('.settings-scroll').scrollTop = 0;
    els.backButton.focus();
    sendMessage('GET_AUTH').then(applyPayload).catch(() => {});
  }

  function hideSettings() {
    els.settingsView.hidden = true;
    els.mainView.hidden = false;
    document.body.dataset.view = 'main';
    els.settingsButton.focus();
  }

  function updateAutomationFields() {
    const enabled = els.autoSignInput.checked;
    els.autoTimeInput.disabled = !enabled;
    els.autoTimeRow.classList.toggle('is-disabled', !enabled);
  }

  function readInteger(input, min, max, label) {
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${label}应为 ${min} 到 ${max} 之间的整数`);
    }
    return value;
  }

  function readSettingsForm() {
    const minDelay = readInteger(els.minDelayInput, 0, 60000, '最短间隔');
    const maxDelay = readInteger(els.maxDelayInput, 0, 60000, '最长间隔');
    if (minDelay > maxDelay) throw new Error('最短间隔不能大于最长间隔');

    return {
      maxPages: readInteger(els.maxPagesInput, 1, 100, '扫描页数'),
      minDelay,
      maxDelay,
      signMode: els.settingsForm.querySelector('input[name="signMode"]:checked')?.value === 'safe' ? 'safe' : 'fast',
      maxRefreshes: readInteger(els.maxRefreshesInput, 0, 3, 'tbs 刷新次数'),
      requestTimeout: readInteger(els.requestTimeoutInput, 5, 120, '请求超时') * 1000,
      closeWorkerTab: true,
      autoSign: els.autoSignInput.checked,
      autoTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(els.autoTimeInput.value) ? els.autoTimeInput.value : '09:00',
      notifications: els.notificationsInput.checked,
      networkRetries: readInteger(els.networkRetriesInput, 0, 4, '网络重试次数'),
      rateLimitRetries: readInteger(els.rateLimitRetriesInput, 0, 3, '限流重试次数'),
      retryBaseDelay: readInteger(els.retryBaseDelayInput, 250, 30000, '退避基数')
    };
  }

  function bindEvents() {
    globalThis.addEventListener?.('resize', renderWavyGeometry);
    document.addEventListener('visibilitychange', syncWaveAnimation);
    const handleReducedMotionChange = () => {
      wavePhase = 0;
      renderWavyGeometry();
      syncWaveAnimation();
    };
    if (typeof reducedMotionQuery.addEventListener === 'function') {
      reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
    } else {
      reducedMotionQuery.addListener?.(handleReducedMotionChange);
    }

    els.refreshButton.addEventListener('click', () => {
      performAction('refresh', () => sendMessage('GET_SNAPSHOT'));
    });

    els.settingsButton.addEventListener('click', showSettings);
    els.backButton.addEventListener('click', hideSettings);
    els.cancelSettingsButton.addEventListener('click', hideSettings);

    els.startButton.addEventListener('click', () => {
      const action = els.startButton.dataset.action;
      if (action === 'open-auth') {
        performAction('open-auth', () => sendMessage('OPEN_AUTH'));
        return;
      }
      if (action === 'resume-interrupted') {
        performAction('resume', () => sendMessage('RESUME_JOB'));
        return;
      }
      performAction('start', () => sendMessage('START_JOB'));
    });

    els.cookieVisibilityButton.addEventListener('click', () => {
      if (!auth.hasCookie) return;
      cookieVisible = !cookieVisible;
      renderAuth();
    });

    els.refreshCookieButton.addEventListener('click', () => {
      performAction('refresh-auth', async () => {
        const response = await sendMessage('REFRESH_AUTH');
        showToast(response.awaitingLogin ? '登录窗口已打开' : 'Cookie 已同步');
        return response;
      });
    });

    els.openAuthButton.addEventListener('click', () => {
      performAction('open-auth', async () => {
        const response = await sendMessage('OPEN_AUTH');
        showToast('登录窗口已打开');
        return response;
      });
    });

    els.clearCookieButton.addEventListener('click', () => {
      performAction('clear-auth', async () => {
        const response = await sendMessage('CLEAR_AUTH');
        cookieVisible = false;
        showToast('已清除保存副本');
        return response;
      });
    });

    els.stopButton.addEventListener('click', () => {
      performAction('stop', () => sendMessage('STOP_JOB'));
    });

    els.pauseButton.addEventListener('click', () => {
      performAction('pause', () => sendMessage('PAUSE_JOB'));
    });

    els.resumeButton.addEventListener('click', () => {
      performAction('resume', () => sendMessage('RESUME_JOB'));
    });

    els.retryButton.addEventListener('click', () => {
      performAction('retry', () => sendMessage('RETRY_FAILED'));
    });

    els.clearButton.addEventListener('click', () => {
      performAction('clear', async () => {
        const response = await sendMessage('CLEAR_RESULTS');
        showToast('记录已清除');
        return response;
      });
    });

    els.settingsForm.addEventListener('change', (event) => {
      if (event.target === els.autoSignInput) updateAutomationFields();
    });

    els.settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      showFormError();
      let nextSettings;
      try {
        nextSettings = readSettingsForm();
      } catch (error) {
        showFormError(error instanceof Error ? error.message : '请检查设置');
        return;
      }

      els.saveSettingsButton.disabled = true;
      try {
        const mergedSettings = { ...settings, ...nextSettings };
        const response = await sendMessage('SAVE_SETTINGS', { settings: mergedSettings });
        settings = { ...settings, ...nextSettings };
        applyPayload(response);
        hideSettings();
        showToast('设置已保存');
      } catch (error) {
        showFormError(error instanceof Error ? error.message : '保存设置失败');
      } finally {
        els.saveSettingsButton.disabled = false;
      }
    });

    globalThis.chrome?.runtime?.onMessage?.addListener((message) => {
      if (!message || message.channel !== CHANNEL) return;
      if (message.type === messageType('STATE_UPDATED')) applyPayload(message);
    });

    globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (!Object.keys(changes).some((key) => STORAGE_KEYS.has(key))) return;
      clearTimeout(storageRefreshTimer);
      storageRefreshTimer = setTimeout(() => refreshSnapshot({ silent: true }), 80);
    });
  }

  document.body.dataset.view = 'main';
  bindEvents();
  render();
  refreshSnapshot();
})();
