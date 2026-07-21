(function initTiebaContent(root) {
  'use strict';

  const shared = root.TiebaShared;
  const core = root.TiebaCore;
  if (!shared || !core || typeof chrome === 'undefined' || !chrome.runtime) return;
  if (window.top !== window) return;

  const { MSG, CHANNEL, PHASES, CATEGORIES } = shared;
  const { TiebaClient, isAbortError } = core;
  const isOffscreen = location.protocol === 'chrome-extension:';
  const eventMessageType = isOffscreen ? MSG.OFFSCREEN_EVENT : MSG.CONTENT_EVENT;
  const client = new TiebaClient();

  let active = null;
  let lastState = shared.emptyState();
  let eventChain = Promise.resolve();

  function postEvent(event, payload = {}) {
    const sourceState = payload.state || (active && active.state) || lastState;
    sourceState.revision = Math.max(Number(sourceState.revision) || 0, Number(lastState.revision) || 0) + 1;
    const state = shared.sanitizeState(sourceState);
    state.updatedAt = new Date().toISOString();
    lastState = state;
    if (active && active.state && active.state.runId === state.runId) active.state.revision = state.revision;
    const message = {
      ...payload,
      channel: CHANNEL,
      type: eventMessageType,
      target: isOffscreen ? 'offscreen' : undefined,
      event,
      runId: payload.runId || state.runId || '',
      state
    };
    delete message.raw;
    if (!message.target) delete message.target;
    eventChain = eventChain
      .catch(() => {})
      .then(() => chrome.runtime.sendMessage(message))
      .catch(() => {});
  }

  function log(activeRun, kind, message) {
    activeRun.state = shared.appendLog(activeRun.state, kind, message);
    postEvent('STATE', { runId: activeRun.runId, state: activeRun.state });
  }

  function setPhase(activeRun, phase, label = '') {
    activeRun.state.status = phase;
    activeRun.state.phase = phase;
    activeRun.state.message = label;
    activeRun.state.updatedAt = new Date().toISOString();
    if (label) activeRun.state.progress.label = label;
    postEvent('STATE', { runId: activeRun.runId, state: activeRun.state });
  }

  function updateCounts(activeRun) {
    activeRun.state.counts = shared.countForums(activeRun.state.forums);
    activeRun.state.total = activeRun.state.forums.length;
    activeRun.state.progress.total = activeRun.queue.length;
  }

  function findForum(activeRun, name) {
    return activeRun.state.forums.find((forum) => forum.name === name);
  }

  function updateForum(activeRun, name, patch) {
    const forum = findForum(activeRun, name);
    if (!forum) return null;
    const previous = forum.status;
    Object.assign(forum, patch);
    if (['ok', 'signed', 'fail'].includes(forum.status)) forum.finishedAt = new Date().toISOString();
    updateCounts(activeRun);
    activeRun.state.currentForum = name;
    activeRun.state.progress.label = patch.message || name;
    activeRun.state.updatedAt = new Date().toISOString();
    if (previous !== forum.status || patch.message) postEvent('STATE', { runId: activeRun.runId, state: activeRun.state });
    return forum;
  }

  function createForumList(items) {
    const map = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const forum = shared.sanitizeForum(shared.createForumRecord(item));
      if (forum.name && !map.has(forum.name)) map.set(forum.name, forum);
    }
    return [...map.values()];
  }

  function resetForum(forum, resetRetries = false) {
    forum.status = 'pending';
    forum.category = '';
    forum.code = '';
    forum.message = forum.page ? `第 ${forum.page} 页${forum.source ? `，来源 ${forum.source}` : ''}` : '';
    forum.finishedAt = '';
    forum.raw = null;
    if (resetRetries) forum.retryCount = 0;
  }

  function prepareRun(message) {
    const settings = shared.normalizeSettings(message.settings);
    const requestedMode = message.mode === 'retry' || message.mode === 'resume' ? message.mode : 'all';
    const sourceState = message.state ? shared.sanitizeState(message.state) : null;
    let forums;
    let queue;
    let currentIndex = 0;

    if (requestedMode === 'resume' && sourceState) {
      forums = sourceState.forums;
      queue = sourceState.queue.length ? sourceState.queue : forums.map((forum) => forum.name);
      currentIndex = Math.max(0, Math.min(sourceState.currentIndex, queue.length));
    } else if (requestedMode === 'retry') {
      forums = sourceState ? sourceState.forums : createForumList(message.forums);
      const failedNames = Array.isArray(message.queue) && message.queue.length
        ? message.queue.map(shared.normalizeForumName).filter(Boolean)
        : forums.filter((forum) => forum.status === 'fail').map((forum) => forum.name);
      queue = [...new Set(failedNames)];
      for (const name of queue) {
        const forum = forums.find((entry) => entry.name === name);
        if (forum) resetForum(forum, false);
      }
    } else {
      forums = createForumList(message.forums);
      queue = forums.map((forum) => forum.name);
      currentIndex = 0;
    }

    const state = sourceState && requestedMode === 'resume' ? sourceState : shared.emptyState();
    if (sourceState) state.revision = Math.max(0, Number(sourceState.revision) || 0);
    state.runId = String(message.runId || shared.makeRunId());
    state.date = shared.todayKey();
    state.status = PHASES.STARTING;
    state.phase = PHASES.STARTING;
    state.mode = requestedMode;
    state.startedAt = state.startedAt || new Date().toISOString();
    state.currentIndex = currentIndex;
    state.queue = queue;
    state.forums = forums;
    state.total = forums.length;
    state.progress = { current: currentIndex, total: queue.length, label: '' };
    state.error = null;
    state.message = '';
    state.counts = shared.countForums(forums);
    return { state: shared.sanitizeState(state), settings, queue };
  }

  async function waitForPermit(activeRun) {
    while (activeRun.paused && !activeRun.stopped) {
      if (activeRun.state.phase !== PHASES.PAUSED) setPhase(activeRun, PHASES.PAUSED, '任务已暂停');
      try {
        await shared.sleep(200, activeRun.controller.signal);
      } catch (error) {
        if (!operationStopped(activeRun)) throw error;
      }
    }
    if (activeRun.stopped) return false;
    if (activeRun.state.phase === PHASES.PAUSED) setPhase(activeRun, PHASES.SIGNING, '任务已继续');
    return true;
  }

  function operationStopped(activeRun) {
    return activeRun.stopped || (activeRun.controller && activeRun.controller.signal.aborted);
  }

  function applySignInfo(activeRun, name, raw) {
    const result = shared.classifySignInfo(raw);
    if (result.signed) {
      updateForum(activeRun, name, { status: 'signed', category: result.category || CATEGORIES.ALREADY_SIGNED, code: result.code || '', message: result.reason || '今日已签到' });
    } else if (result.status === 'fail') {
      updateForum(activeRun, name, { status: 'fail', category: result.category || CATEGORIES.UNKNOWN, code: result.code || '', message: result.reason || '签到状态检查失败' });
    } else {
      updateForum(activeRun, name, { status: 'unsigned', category: result.category || CATEGORIES.NOT_SIGNED, code: result.code || '', message: result.reason || '今日未签到' });
    }
    return result;
  }

  function applySignResult(activeRun, name, data) {
    const result = data && data.result ? data.result : shared.classifySignResult(data && data.raw);
    const message = [result.message || '', result.code ? `错误码 ${result.code}` : '', data && data.tbsRefreshed ? `已刷新 tbs（${data.refreshes || 1} 次）` : '']
      .filter(Boolean)
      .join('; ');
    if (result.status === 'ok') {
      updateForum(activeRun, name, { status: 'ok', category: result.category || CATEGORIES.SUCCESS, code: result.code || '', message: message || '签到成功' });
    } else if (result.status === 'already') {
      updateForum(activeRun, name, { status: 'signed', category: result.category || CATEGORIES.ALREADY_SIGNED, code: result.code || '', message: message || '今日已签到' });
    } else {
      updateForum(activeRun, name, { status: 'fail', category: result.category || CATEGORIES.UNKNOWN, code: result.code || '', message: message || '签到失败' });
    }
    return result;
  }

  async function waitForRetry(activeRun, forum, category, attempt) {
    const delay = shared.retryDelay(activeRun.settings, category, attempt);
    const message = `${shared.categoryLabel(category)}，${Math.ceil(delay / 1000)} 秒后自动重试`;
    if (forum) {
      forum.retryCount += 1;
      updateForum(activeRun, forum.name, { status: 'pending', category, message });
    } else {
      activeRun.state.message = message;
      activeRun.state.progress.label = message;
      log(activeRun, 'warning', message);
    }
    await shared.sleep(delay, activeRun.controller.signal);
    return waitForPermit(activeRun);
  }

  async function requestWithNetworkRetry(activeRun, forum, operation) {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (operationStopped(activeRun)) throw error;
        const failure = shared.classifyError(error);
        if (failure.category !== CATEGORIES.NETWORK_ERROR || attempt >= activeRun.settings.networkRetries) throw error;
        if (!(await waitForRetry(activeRun, forum, failure.category, attempt))) throw error;
        attempt += 1;
      }
    }
  }

  async function signOne(activeRun, name) {
    if (!(await waitForPermit(activeRun))) return false;
    const forum = findForum(activeRun, name);
    if (!forum) return true;
    if (activeRun.state.mode === 'retry') forum.retryCount += 1;

    if (activeRun.settings.signMode === 'safe') {
      setPhase(activeRun, PHASES.CHECKING, `正在检查：${name}`);
      updateForum(activeRun, name, { status: 'checking', category: '', code: '', message: '检查今日签到状态' });
      try {
        const info = await requestWithNetworkRetry(activeRun, forum, () => client.getSignInfo(name, {
          signal: activeRun.controller.signal,
          timeout: activeRun.settings.requestTimeout
        }));
        const status = applySignInfo(activeRun, name, info);
        if (status.category === CATEGORIES.LOGIN_REQUIRED) {
          throw Object.assign(new Error(status.reason || '贴吧登录已失效'), { category: CATEGORIES.LOGIN_REQUIRED });
        }
        if (status.signed || status.status === 'fail') return true;
      } catch (error) {
        if (operationStopped(activeRun)) return false;
        const failure = shared.classifyError(error);
        updateForum(activeRun, name, { status: 'fail', category: failure.category, code: failure.code, message: failure.message });
        if (failure.category === CATEGORIES.LOGIN_REQUIRED) throw error;
        return true;
      }
    }

    if (!(await waitForPermit(activeRun))) return false;
    const delay = shared.randomDelay(activeRun.settings.minDelay, activeRun.settings.maxDelay);
    if (delay) await shared.sleep(delay, activeRun.controller.signal);
    if (!(await waitForPermit(activeRun))) return false;
    if (operationStopped(activeRun)) return false;

    setPhase(activeRun, PHASES.SIGNING, `正在签到：${name}`);
    updateForum(activeRun, name, { status: 'signing', category: '', code: '', message: '正在提交签到' });
    try {
      let rateAttempt = 0;
      while (true) {
        const data = await requestWithNetworkRetry(activeRun, forum, () => client.signWithFreshTbsRetry(name, activeRun.tbs, {
          maxRefreshes: activeRun.settings.maxRefreshes,
          signal: activeRun.controller.signal,
          timeout: activeRun.settings.requestTimeout
        }));
        activeRun.tbs = data.tbs || activeRun.tbs;
        const tbsRefreshes = Math.max(0, Math.floor(Number(data.refreshes) || 0));
        if (tbsRefreshes) forum.retryCount += tbsRefreshes;
        const result = data.result || shared.classifySignResult(data.raw);
        if (result.category === CATEGORIES.RATE_LIMITED && rateAttempt < activeRun.settings.rateLimitRetries) {
          if (!(await waitForRetry(activeRun, forum, result.category, rateAttempt))) return false;
          rateAttempt += 1;
          continue;
        }
        applySignResult(activeRun, name, data);
        if (result.category === CATEGORIES.LOGIN_REQUIRED) {
          throw Object.assign(new Error(result.message || '贴吧登录已失效'), { category: CATEGORIES.LOGIN_REQUIRED });
        }
        break;
      }
    } catch (error) {
      if (operationStopped(activeRun)) return false;
      const failure = shared.classifyError(error);
      updateForum(activeRun, name, { status: 'fail', category: failure.category, code: failure.code, message: failure.message });
      if (failure.category === CATEGORIES.LOGIN_REQUIRED) throw error;
    }
    return true;
  }

  async function scanForums(activeRun) {
    setPhase(activeRun, PHASES.SCANNING, '正在扫描关注贴吧');
    log(activeRun, 'info', `最多扫描 ${activeRun.settings.maxPages} 页`);
    const result = await requestWithNetworkRetry(activeRun, null, () => client.getAllForums(activeRun.settings.maxPages, {
      signal: activeRun.controller.signal,
      timeout: activeRun.settings.requestTimeout,
      beforePage: async (page) => {
        if (!(await waitForPermit(activeRun))) throw Object.assign(new Error('任务已停止'), { name: 'AbortError' });
        activeRun.state.progress.label = `正在扫描第 ${page} 页`;
        postEvent('STATE', { runId: activeRun.runId, state: activeRun.state });
      },
      onPage: async (pageInfo, found) => {
        activeRun.state.forums = createForumList(found);
        activeRun.state.queue = activeRun.state.forums.map((forum) => forum.name);
        activeRun.queue = activeRun.state.queue;
        updateCounts(activeRun);
        activeRun.state.progress = { current: 0, total: activeRun.queue.length, label: `已扫描第 ${pageInfo.page} 页` };
        postEvent('PAGE_SCANNED', { runId: activeRun.runId, page: pageInfo, state: activeRun.state });
      }
    }));
    activeRun.state.forums = createForumList(result.forums);
    activeRun.queue = activeRun.state.forums.map((forum) => forum.name);
    activeRun.state.queue = activeRun.queue;
    activeRun.state.currentIndex = 0;
    updateCounts(activeRun);
    activeRun.state.progress = { current: 0, total: activeRun.queue.length, label: '扫描完成' };
    postEvent('STATE', { runId: activeRun.runId, state: activeRun.state });
    log(activeRun, 'info', `共发现 ${activeRun.queue.length} 个关注贴吧`);
    return activeRun.queue.length > 0;
  }

  async function execute(activeRun) {
    if (!(await waitForPermit(activeRun))) return;
    setPhase(activeRun, PHASES.STARTING, '正在检查贴吧登录状态');
    activeRun.tbs = await requestWithNetworkRetry(activeRun, null, () => client.getTbs({
      signal: activeRun.controller.signal,
      timeout: activeRun.settings.requestTimeout
    }));
    if (!activeRun.queue.length || (activeRun.mode === 'all' && !activeRun.state.forums.length)) {
      if (!(await scanForums(activeRun))) throw new Error('没有找到关注贴吧');
    }
    if (!activeRun.queue.length) throw new Error('没有可处理的贴吧');

    for (let index = activeRun.state.currentIndex; index < activeRun.queue.length; index += 1) {
      if (operationStopped(activeRun)) break;
      activeRun.state.currentIndex = index;
      activeRun.state.progress = { current: index, total: activeRun.queue.length, label: activeRun.queue[index] };
      postEvent('STATE', { runId: activeRun.runId, state: activeRun.state });
      const processed = await signOne(activeRun, activeRun.queue[index]);
      if (!processed && operationStopped(activeRun)) break;
      activeRun.state.currentIndex = index + 1;
      activeRun.state.progress = { current: index + 1, total: activeRun.queue.length, label: activeRun.queue[index] };
      updateCounts(activeRun);
      postEvent('FORUM_RESULT', { runId: activeRun.runId, forum: activeRun.queue[index], state: activeRun.state });
    }
    if (operationStopped(activeRun)) {
      activeRun.state.status = PHASES.STOPPED;
      activeRun.state.phase = PHASES.STOPPED;
      activeRun.state.message = `任务已停止：${activeRun.state.currentIndex}/${activeRun.queue.length}`;
      return;
    }
    activeRun.state.status = PHASES.COMPLETED;
    activeRun.state.phase = PHASES.COMPLETED;
    activeRun.state.currentIndex = activeRun.queue.length;
    activeRun.state.progress = { current: activeRun.queue.length, total: activeRun.queue.length, label: '签到完成' };
    activeRun.state.message = '签到任务完成';
  }

  async function startJob(message) {
    if (active && active.task) return { ok: false, error: '已有签到任务正在运行' };
    const prepared = prepareRun(message || {});
    const activeRun = {
      runId: prepared.state.runId,
      state: prepared.state,
      settings: prepared.settings,
      queue: prepared.queue,
      mode: prepared.state.mode,
      tbs: '',
      paused: message.startPaused === true,
      stopped: false,
      controller: new AbortController(),
      task: null
    };
    active = activeRun;
    lastState = activeRun.state;
    postEvent('RUN_STARTED', { runId: activeRun.runId, state: activeRun.state });
    activeRun.task = execute(activeRun)
      .catch((error) => {
        if (operationStopped(activeRun)) return;
        const failure = shared.classifyError(error);
        activeRun.state.status = PHASES.ERROR;
        activeRun.state.phase = PHASES.ERROR;
        activeRun.state.error = { category: failure.category, code: failure.code, message: failure.message };
        activeRun.state.message = failure.message;
        log(activeRun, 'error', failure.message);
      })
      .finally(() => {
        if (activeRun.state.status === PHASES.STOPPING || activeRun.state.phase === PHASES.STOPPING) {
          activeRun.state.status = PHASES.STOPPED;
          activeRun.state.phase = PHASES.STOPPED;
          activeRun.state.message = `任务已停止：${activeRun.state.currentIndex}/${activeRun.queue.length}`;
        }
        activeRun.state.updatedAt = new Date().toISOString();
        postEvent('RUN_FINISHED', { runId: activeRun.runId, state: activeRun.state });
        lastState = activeRun.state;
        active = null;
      });
    return { ok: true, accepted: true, runId: activeRun.runId };
  }

  function commandResponse(message) {
    if (!active) return { ok: false, error: '当前没有运行中的任务' };
    if (message.runId && message.runId !== active.runId) return { ok: false, error: '任务标识已过期' };
    if (message.type === MSG.PAUSE_JOB || message.command === 'pause') {
      active.paused = true;
      active.state.status = PHASES.PAUSED;
      active.state.phase = PHASES.PAUSED;
      active.state.message = '任务已暂停';
      postEvent('STATE', { runId: active.runId, state: active.state });
      return { ok: true };
    }
    if (message.type === MSG.RESUME_JOB || message.command === 'resume') {
      active.paused = false;
      active.state.message = '正在继续任务';
      postEvent('STATE', { runId: active.runId, state: active.state });
      return { ok: true };
    }
    if (message.type === MSG.STOP_JOB || message.command === 'stop') {
      active.stopped = true;
      active.paused = false;
      active.state.status = PHASES.STOPPING;
      active.state.phase = PHASES.STOPPING;
      active.state.message = '正在停止任务';
      if (active.controller) active.controller.abort();
      postEvent('STATE', { runId: active.runId, state: active.state });
      return { ok: true };
    }
    return { ok: false, error: '无法识别的任务命令' };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.channel !== CHANNEL) return undefined;
    if (message.type === MSG.CONTENT_COMMAND || message.type === MSG.OFFSCREEN_COMMAND) {
      if (message.command === 'auth-check') {
        client.getTbs({ timeout: message.timeout || 10000 })
          .then((tbs) => sendResponse({ ok: true, isLogin: true, tbs, origin: client.origin }))
          .catch((error) => {
            const failure = shared.classifyError(error);
            sendResponse({ ok: false, isLogin: false, error: failure.message, category: failure.category, origin: client.origin });
          });
        return true;
      }
      if (message.command === 'start' || message.job) {
        startJob(message.job || message)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      sendResponse(commandResponse(message));
      return false;
    }
    // The service worker is the sole source of truth for snapshots. An
    // offscreen document must not race it with its local, usually empty state.
    if (!isOffscreen && message.type === MSG.GET_SNAPSHOT) {
      sendResponse({ ok: true, state: shared.sanitizeState((active && active.state) || lastState) });
      return false;
    }
    return undefined;
  });

  function announceReady() {
    postEvent('READY', { url: location.href });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announceReady, { once: true });
  else announceReady();
})(typeof globalThis !== 'undefined' ? globalThis : this);
