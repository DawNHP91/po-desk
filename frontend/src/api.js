// One POST helper for every backend call.
// Content-Type is text/plain so the browser sends a "simple" request with no CORS preflight:
// Apps Script cannot answer OPTIONS. No custom headers for the same reason.
import { API_URL } from './config.js';

let token = '';

export function setToken(t) {
  token = t || '';
}

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls a backend action and returns its `data`, or throws ApiError(code, message).
 * Retries once on a network error (no response at all). Timeouts are not retried: the request
 * may have reached the server, and waiting twice as long helps nobody on a weak signal.
 */
export async function call(action, payload = {}, { idemKey = '', timeoutMs = 25000 } = {}) {
  const body = JSON.stringify({ action, token, payload, idemKey });
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let env;
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        signal: ctrl.signal,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
      });
      try {
        env = await res.json();
      } catch {
        throw new ApiError('BAD_RESPONSE', 'PO Desk sent an unexpected answer. Please try again.');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err.name === 'AbortError') throw new ApiError('TIMEOUT', 'PO Desk took too long to answer. Check your signal and try again.');
      if (attempt === 1) { await sleep(800); continue; }
      throw new ApiError('NETWORK', 'Can’t reach PO Desk. Check your signal and try again.');
    } finally {
      clearTimeout(timer);
    }
    if (!env || typeof env.ok !== 'boolean') throw new ApiError('BAD_RESPONSE', 'PO Desk sent an unexpected answer. Please try again.');
    // Every action answers { ok: true, data }. A bare { ok: true } is the GET health check, which Google's
    // redirect has (rarely) served for a POST: never treat that as the action having worked.
    if (env.ok && !('data' in env)) throw new ApiError('BAD_RESPONSE', 'PO Desk sent an unexpected answer. Please try again.');
    if (!env.ok) {
      const code = (env.error && env.error.code) || 'ERROR';
      const err = new ApiError(code, (env.error && env.error.message) || 'Something went wrong. Please try again.');
      if (code === 'AUTH_REQUIRED' && action !== 'login') window.dispatchEvent(new CustomEvent('po:auth-required'));
      throw err;
    }
    return env.data;
  }
}
