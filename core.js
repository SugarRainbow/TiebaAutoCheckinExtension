(function initTiebaCore(root, factory) {
  const api = factory(root.TiebaShared);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TiebaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTiebaCore(shared) {
  'use strict';

  if (!shared) throw new Error('TiebaCore 缺少 TiebaShared');

  const DEFAULT_ORIGIN = 'https://tieba.baidu.com';

  function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : '';
  }

  function toUint8Array(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (buffer && buffer.buffer instanceof ArrayBuffer) return new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
    return new Uint8Array(0);
  }

  function makeError(message, fields = {}) {
    const error = new Error(message);
    Object.assign(error, fields);
    return error;
  }

  function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
  }

  class TiebaClient {
    constructor(options = {}) {
      this.origin = String(options.origin || DEFAULT_ORIGIN).replace(/\/$/, '');
      this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      this.timeout = shared.clampInteger(options.timeout, 1000, 120000, 20000);
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      if (!this.fetchImpl) throw new Error('当前浏览器不支持 Fetch API');
    }

    buildUrl(resource) {
      const value = String(resource || '');
      const url = value.startsWith('http') ? value : `${this.origin}${value.startsWith('/') ? value : `/${value}`}`;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw makeError('贴吧请求地址无效', { category: shared.CATEGORIES.FORUM_INVALID });
      }
      if (parsed.origin !== this.origin) {
        throw makeError('已拒绝非贴吧域名请求', { category: shared.CATEGORIES.NETWORK_ERROR });
      }
      return parsed.toString();
    }

    async request(resource, options = {}) {
      const url = this.buildUrl(resource);
      const method = String(options.method || 'GET').toUpperCase();
      const headers = {
        Accept: options.accept || 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        ...(options.headers || {})
      };
      // Cookie/User-Agent/Origin/Referer are intentionally absent. The browser
      // supplies the page session and security headers for this same-origin call.
      const requestInit = {
        method,
        headers,
        body: options.body,
        credentials: 'include',
        redirect: 'follow',
        signal: options.signal
      };

      let controller = null;
      let removeAbortListener = null;
      const timeoutMs = shared.clampInteger(options.timeout, 1000, 120000, this.timeout);
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        requestInit.signal = controller.signal;
        if (options.signal) {
          if (options.signal.aborted) controller.abort(options.signal.reason);
          else {
            const onAbort = () => controller.abort(options.signal.reason);
            options.signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => options.signal.removeEventListener('abort', onAbort);
          }
        }
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (controller) controller.abort();
      }, timeoutMs);

      try {
        const response = await this.fetchImpl(url, requestInit);
        const status = Number(response && response.status) || 0;
        const buffer = toUint8Array(await response.arrayBuffer());
        const contentType = headerValue(response.headers, 'content-type');
        const charsetMatch = contentType.match(/charset=([^;\s]+)/i);
        const charset = String(options.charset || (charsetMatch && charsetMatch[1]) || 'utf-8').toLowerCase();
        let text;
        try {
          const decoderName = /gbk|gb2312|gb18030/i.test(charset) ? 'gb18030' : 'utf-8';
          text = new TextDecoder(decoderName).decode(buffer);
        } catch {
          text = new TextDecoder('utf-8').decode(buffer);
        }
        if (!response.ok && !(status >= 200 && status < 300)) {
          throw makeError(`贴吧接口 HTTP ${status || '错误'}`, {
            statusCode: 502,
            category: shared.CATEGORIES.HTTP_ERROR,
            code: status,
            detail: text.slice(0, 500)
          });
        }
        return { response, text, buffer, contentType, status };
      } catch (error) {
        if (timedOut) {
          throw makeError('贴吧接口请求超时', { category: shared.CATEGORIES.NETWORK_ERROR, code: 'ETIMEDOUT' });
        }
        if (isAbortError(error) || (options.signal && options.signal.aborted)) throw error;
        if (error && error.category) throw error;
        throw makeError(error && error.message ? error.message : '贴吧网络请求失败', {
          category: shared.CATEGORIES.NETWORK_ERROR,
          cause: error
        });
      } finally {
        clearTimeout(timer);
        if (removeAbortListener) removeAbortListener();
      }
    }

    parseJson(text, source) {
      try {
        return JSON.parse(text);
      } catch (cause) {
        throw makeError(`${source} 返回内容不是 JSON`, {
          statusCode: 502,
          category: shared.CATEGORIES.NON_JSON,
          detail: String(text || '').slice(0, 500),
          cause
        });
      }
    }

    async getTbs(options = {}) {
      const result = await this.request('/dc/common/tbs', {
        ...options,
        accept: 'application/json, text/javascript, */*; q=0.01'
      });
      const data = this.parseJson(result.text, 'tbs');
      if (!data || !data.is_login || !data.tbs) {
        throw makeError('贴吧未登录或 tbs 获取失败，请先登录贴吧', {
          statusCode: 401,
          category: shared.CATEGORIES.LOGIN_REQUIRED,
          detail: data
        });
      }
      return String(data.tbs);
    }

    async getForumsFromPage(pageNo, options = {}) {
      const page = Math.max(1, Number(pageNo) || 1);
      const result = await this.request(`/f/like/mylike?&pn=${page}`, {
        ...options,
        charset: 'gb18030',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Charset': 'gb18030,utf-8;q=0.9',
          ...(options.headers || {})
        }
      });
      return {
        forums: shared.extractForums(result.text),
        hasNext: shared.hasNextPage(result.text, page),
        page
      };
    }

    async getAllForums(maxPages, options = {}) {
      const all = new Map();
      const pages = [];
      const cappedMaxPages = Math.max(1, Math.min(Number(maxPages) || 30, 100));
      let stalePages = 0;
      for (let page = 1; page <= cappedMaxPages; page += 1) {
        if (options.signal && options.signal.aborted) throw makeError('任务已停止', { name: 'AbortError' });
        if (typeof options.beforePage === 'function') await options.beforePage(page);
        const before = all.size;
        const result = await this.getForumsFromPage(page, options);
        result.forums
          .map((forum) => ({ ...forum, name: shared.normalizeForumName(forum.name), page }))
          .filter((forum) => forum.name && !shared.looksLikeEncodedKw(forum.name))
          .forEach((forum) => {
            if (!all.has(forum.name)) all.set(forum.name, forum);
          });
        const added = all.size - before;
        stalePages = added === 0 ? stalePages + 1 : 0;
        pages.push({ page, count: result.forums.length, added, total: all.size, hasNext: result.hasNext });
        if (typeof options.onPage === 'function') {
          await options.onPage(pages[pages.length - 1], [...all.values()]);
        }
        if (!result.hasNext || result.forums.length === 0 || stalePages >= 2) break;
      }
      return { forums: [...all.values()], pages };
    }

    async getSignInfo(kw, options = {}) {
      const name = shared.normalizeForumName(kw);
      if (!name) throw makeError('缺少贴吧名称', { category: shared.CATEGORIES.FORUM_INVALID });
      const url = `/sign/info?ie=utf-8&kw=${encodeURIComponent(name)}&t=${this.now()}`;
      const result = await this.request(url, {
        ...options,
        accept: 'application/json, text/javascript, */*; q=0.01'
      });
      return this.parseJson(result.text, 'sign/info');
    }

    async addSign(kw, tbs, options = {}) {
      const name = shared.normalizeForumName(kw);
      const token = shared.normalizeForumName(tbs);
      if (!name) throw makeError('缺少贴吧名称', { category: shared.CATEGORIES.FORUM_INVALID });
      if (!token) throw makeError('缺少 tbs', { category: shared.CATEGORIES.TBS_INVALID });
      const body = new URLSearchParams({ ie: 'utf-8', kw: name, tbs: token }).toString();
      const result = await this.request('/sign/add', {
        ...options,
        method: 'POST',
        body,
        accept: 'application/json, text/javascript, */*; q=0.01',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          ...(options.headers || {})
        }
      });
      return this.parseJson(result.text, 'sign/add');
    }

    async signWithFreshTbsRetry(kw, tbs, options = {}) {
      const maxRefreshes = shared.clampInteger(options.maxRefreshes, 0, 3, 1);
      let currentTbs = shared.normalizeForumName(tbs);
      let refreshes = 0;
      const attempts = [];
      while (true) {
        const raw = await this.addSign(kw, currentTbs, options);
        const result = shared.classifySignResult(raw);
        attempts.push({ raw, result, tbsRefreshedBeforeAttempt: refreshes > 0 });
        if (!result.needsTbsRefresh || refreshes >= maxRefreshes) {
          return { raw, result, tbs: currentTbs, tbsRefreshed: refreshes > 0, refreshes, attempts };
        }
        currentTbs = await this.getTbs(options);
        refreshes += 1;
      }
    }
  }

  return {
    DEFAULT_ORIGIN,
    TiebaClient,
    isAbortError,
    makeError
  };
});
