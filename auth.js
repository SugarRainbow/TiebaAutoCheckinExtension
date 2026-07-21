(function initTiebaAuth(root) {
  'use strict';

  const shared = root.TiebaShared;
  if (!shared) throw new Error('TiebaShared must be loaded before TiebaAuth');

  const TOKEN_NAMES = new Set([
    'BDUSS',
    'BDUSS_BFESS',
    'STOKEN',
    'STOKEN_BFESS',
    'PTOKEN',
    'PTOKEN_BFESS',
    'BAIDUID',
    'BAIDUID_BFESS',
    'PSTM',
    'BIDUPSID'
  ]);
  const COOKIE_URLS = ['https://tieba.baidu.com/', 'https://www.baidu.com/'];

  function lastError() {
    return chrome.runtime && chrome.runtime.lastError
      ? new Error(chrome.runtime.lastError.message)
      : null;
  }

  function callApi(fn, ...args) {
    return new Promise((resolve, reject) => {
      fn(...args, (value) => {
        const error = lastError();
        if (error) reject(error);
        else resolve(value);
      });
    });
  }

  function cookieUrl(cookie) {
    if (cookie.url) return cookie.url;
    const domain = String(cookie.domain || '').replace(/^\./, '');
    const path = cookie.path || '/';
    return `${cookie.secure === false ? 'http' : 'https'}://${domain}${path}`;
  }

  function isBaiduCookie(cookie) {
    const domain = String(cookie && cookie.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'baidu.com' || domain.endsWith('.baidu.com');
  }

  function dedupeCookies(cookies) {
    const map = new Map();
    for (const cookie of cookies || []) {
      if (!isBaiduCookie(cookie) || !cookie.name || !TOKEN_NAMES.has(cookie.name)) continue;
      const key = `${cookie.domain || ''}|${cookie.path || '/'}|${cookie.name}`;
      if (!map.has(key)) map.set(key, cookie);
    }
    return [...map.values()];
  }

  function tokenNames(cookies) {
    return [...new Set((cookies || []).filter((cookie) => TOKEN_NAMES.has(cookie.name)).map((cookie) => cookie.name))];
  }

  function formatCookie(cookies) {
    const byName = new Map();
    for (const cookie of dedupeCookies(cookies)) {
      if (!byName.has(cookie.name)) byName.set(cookie.name, String(cookie.value || ''));
    }
    return [...byName.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function legacyCookieView(value) {
    const entries = [];
    for (const part of String(value || '').split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const name = part.slice(0, separator).trim();
      if (!TOKEN_NAMES.has(name)) continue;
      entries.push([name, part.slice(separator + 1).trim()]);
    }
    const unique = new Map(entries);
    return {
      cookie: [...unique.entries()].map(([name, cookieValue]) => `${name}=${cookieValue}`).join('; '),
      tokenNames: [...unique.keys()]
    };
  }

  function serializableCookie(cookie) {
    return {
      url: cookieUrl(cookie),
      name: String(cookie.name || ''),
      value: String(cookie.value || ''),
      domain: cookie.domain || '',
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite || 'unspecified',
      expirationDate: Number.isFinite(cookie.expirationDate) ? cookie.expirationDate : undefined
    };
  }

  function cookieFingerprint(cookies) {
    return JSON.stringify((cookies || [])
      .map(serializableCookie)
      .sort((left, right) => `${left.domain}|${left.path}|${left.name}`.localeCompare(`${right.domain}|${right.path}|${right.name}`)));
  }

  class CookieStore {
    constructor(storageKey = shared.STORAGE_KEYS.auth) {
      this.storageKey = storageKey;
    }

    async readBrowser() {
      const results = await Promise.all(COOKIE_URLS.map((url) => callApi(chrome.cookies.getAll.bind(chrome.cookies), { url })));
      return dedupeCookies(results.flat());
    }

    async readSaved() {
      const result = await callApi(chrome.storage.local.get.bind(chrome.storage.local), [this.storageKey]);
      return result && result[this.storageKey] && typeof result[this.storageKey] === 'object'
        ? result[this.storageKey]
        : null;
    }

    view(saved) {
      const value = saved && typeof saved === 'object' ? saved : {};
      const hasStructuredCookies = Array.isArray(value.cookies);
      const legacy = hasStructuredCookies ? { cookie: '', tokenNames: [] } : legacyCookieView(value.cookie);
      const cookie = hasStructuredCookies ? formatCookie(value.cookies) : legacy.cookie;
      const names = hasStructuredCookies
        ? tokenNames(dedupeCookies(value.cookies))
        : [...new Set([
            ...(Array.isArray(value.tokenNames) ? value.tokenNames.map(String).filter((name) => TOKEN_NAMES.has(name)) : []),
            ...legacy.tokenNames
          ])];
      return {
        cookie,
        tokenNames: names,
        savedAt: String(value.savedAt || ''),
        hasCookie: Boolean(cookie),
        hasLoginToken: names.some((name) => /^(?:BDUSS|STOKEN)(?:_BFESS)?$/.test(name))
      };
    }

    async saveBrowser(cookies = null) {
      const current = dedupeCookies(cookies || await this.readBrowser());
      const saved = await this.readSaved();
      const currentTokenNames = tokenNames(current).sort();
      const savedTokenNames = saved && Array.isArray(saved.tokenNames)
        ? saved.tokenNames.map(String).sort()
        : [];
      const canonicalSaved = saved
        && Array.isArray(saved.cookies)
        && !Object.prototype.hasOwnProperty.call(saved, 'cookie')
        && cookieFingerprint(saved.cookies) === cookieFingerprint(current)
        && JSON.stringify(savedTokenNames) === JSON.stringify(currentTokenNames);
      if (canonicalSaved) {
        return this.view(saved);
      }
      const snapshot = {
        cookies: current.map(serializableCookie),
        tokenNames: currentTokenNames,
        savedAt: new Date().toISOString()
      };
      await callApi(chrome.storage.local.set.bind(chrome.storage.local), { [this.storageKey]: snapshot });
      return this.view(snapshot);
    }

    async restoreSaved() {
      const saved = await this.readSaved();
      if (!saved || !Array.isArray(saved.cookies)) return this.view(saved);
      const now = Date.now() / 1000;
      for (const cookie of dedupeCookies(saved.cookies)) {
        if (!cookie || !cookie.name || !cookie.value) continue;
        if (Number.isFinite(cookie.expirationDate) && cookie.expirationDate <= now) continue;
        const details = { ...cookie, url: cookie.url || cookieUrl(cookie) };
        delete details.hostOnly;
        try {
          await callApi(chrome.cookies.set.bind(chrome.cookies), details);
        } catch {
          // A cookie may be rejected when the browser has tightened its policy.
        }
      }
      return this.view(saved);
    }

    async sync() {
      const current = await this.readBrowser();
      if (current.length) return this.saveBrowser(current);
      return this.view(await this.readSaved());
    }

    async clear() {
      await callApi(chrome.storage.local.remove.bind(chrome.storage.local), [this.storageKey]);
      return this.view(null);
    }
  }

  root.TiebaAuth = { CookieStore, COOKIE_URLS, TOKEN_NAMES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
