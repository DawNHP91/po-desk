/**
 * Composio.gs — the only place that talks to Composio's REST API.
 *
 * Verified against docs.composio.dev (Nov 2026):
 *   POST {base}/tools/execute/{tool_slug}   body { connected_account_id, user_id?, arguments }
 *        -> 200 { data, error, successful, log_id }
 *   POST {base}/tools/execute/proxy         body { endpoint, method, connected_account_id, body?, binary_body?, parameters[] }
 *        -> 200 { data, status, headers, binary_data? }   (status is the upstream Xero status)
 *   POST {base}/files/upload/request        body { toolkit_slug, tool_slug, filename, mimetype, md5 }
 *        -> 200 { id, key, new_presigned_url, metadata.storage_backend }
 *   Auth: x-api-key header. Base: https://backend.composio.dev/api/v3.1 (v3 is still accepted).
 */

const COMPOSIO_BASE_URL = 'https://backend.composio.dev/api/v3.1';
const COMPOSIO_MAX_ATTEMPTS = 3;

// Counts calls (including retries) in this execution, so syncs can report their cost against the
// ~20,000/month free-tier budget.
const composioStats_ = { calls: 0 };

/**
 * Runs a Composio tool and returns its `data`. Throws AppError on failure.
 * ctx (optional): { entityId, userId, ref } for the audit log.
 * Callers outside Xero.gs should not use this for Xero tools: Xero.gs enforces the tenant guard.
 */
function composioExecute(toolSlug, args, ctx) {
  const body = { connected_account_id: getSecret_('COMPOSIO_XERO_ACCOUNT_ID'), arguments: args || {} };
  const userId = getOptionalSecret_('COMPOSIO_USER_ID');
  if (userId) body.user_id = userId;

  const res = composioRequest_('/tools/execute/' + encodeURIComponent(toolSlug), body, toolSlug, ctx, function (status, json) {
    if (status === 200 && json && json.successful === true) return { ok: true };
    const msg = errorText_(json) || ('HTTP ' + status);
    return { ok: false, retryable: isRetryableStatus_(status) || looksTransient_(msg), message: msg };
  });
  return res.json.data;
}

/**
 * Calls an upstream API through Composio's proxy using the connected account's OAuth token.
 * opts: { body, binaryBase64, contentType, headers: {name: value}, query: {name: value} }
 * Returns { status, data, headers }.
 */
function composioProxy(method, endpoint, opts, ctx) {
  const res = composioRequest_('/tools/execute/proxy', proxyBody_(method, endpoint, opts), proxyLabel_(method, endpoint), ctx, classifyProxy_);
  return { status: res.json.status, data: res.json.data, headers: res.json.headers || {} };
}

function proxyBody_(method, endpoint, opts) {
  opts = opts || {};
  const body = {
    endpoint: endpoint,
    method: method,
    connected_account_id: getSecret_('COMPOSIO_XERO_ACCOUNT_ID'),
  };
  const userId = getOptionalSecret_('COMPOSIO_USER_ID');
  if (userId) body.user_id = userId;
  if (opts.body !== undefined) body.body = opts.body;
  if (opts.binaryBase64) body.binary_body = { base64: opts.binaryBase64, content_type: opts.contentType || 'application/octet-stream' };
  const params = [];
  Object.keys(opts.headers || {}).forEach(k => params.push({ name: k, value: String(opts.headers[k]), type: 'header' }));
  Object.keys(opts.query || {}).forEach(k => params.push({ name: k, value: String(opts.query[k]), type: 'query' }));
  if (params.length) body.parameters = params;
  return body;
}

function proxyLabel_(method, endpoint) {
  return 'proxy ' + method + ' ' + endpoint.replace(/^https:\/\/api\.xero\.com\/api\.xro\/2\.0/, '');
}

function classifyProxy_(status, json) {
  const upstream = json && typeof json.status === 'number' ? json.status : 0;
  if (status === 200 && upstream >= 200 && upstream < 300) return { ok: true };
  const msg = errorText_(json) || ('HTTP ' + status + (upstream ? ' / upstream ' + upstream : ''));
  return { ok: false, retryable: isRetryableStatus_(status) || isRetryableStatus_(upstream), message: msg, upstream: upstream };
}

/**
 * Several proxy calls at once (UrlFetchApp.fetchAll), for independent steps such as the two slip
 * attachments of a bill: in sequence they cost the buyer ~2 s each. A retryable failure gets one more
 * try (again in parallel); whatever still fails is RETURNED, not thrown, so the caller can queue only
 * that step. calls: [{ method, endpoint, opts, entityId }]. Returns [{ ok, status, data, error, upstream }].
 */
function composioProxyAll(calls, ctx) {
  ctx = ctx || {};
  if (!calls.length) return [];
  const apiKey = getSecret_('COMPOSIO_API_KEY');
  const out = calls.map(() => null);
  const attempts = calls.map(() => 0);
  const t0 = Date.now();
  for (let round = 1; round <= 2; round++) {
    const todo = calls.map((c, i) => i).filter(i => !out[i] || (!out[i].ok && out[i].retryable && round === 2));
    if (!todo.length) break;
    if (round === 2) backoff_(1, null);
    const live = [];
    todo.forEach(i => {
      attempts[i]++;
      composioStats_.calls++;
      if (consumeForcedFailure_(proxyLabel_(calls[i].method, calls[i].endpoint))) {
        out[i] = { ok: false, retryable: false, status: 0, error: 'Forced failure for testing (Script Property TEST_FAIL_NEXT)', forced: true };
      } else {
        live.push(i);
      }
    });
    const responses = live.length ? UrlFetchApp.fetchAll(live.map(i => ({
      url: COMPOSIO_BASE_URL + '/tools/execute/proxy', method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey }, payload: JSON.stringify(proxyBody_(calls[i].method, calls[i].endpoint, calls[i].opts)), muteHttpExceptions: true,
    }))) : [];
    responses.forEach((resp, k) => {
      const i = live[k];
      const status = resp.getResponseCode();
      let json = null;
      try { json = JSON.parse(resp.getContentText()); } catch (e) { json = null; }
      const v = classifyProxy_(status, json);
      out[i] = v.ok
        ? { ok: true, status: json.status, data: json.data, log_id: json.log_id }
        : { ok: false, retryable: !!v.retryable, status: status, upstream: v.upstream || 0, error: truncate_(v.message, 300), data: json && json.data, log_id: json && json.log_id };
    });
  }
  const ms = Date.now() - t0;
  out.forEach((r, i) => {
    auditLog({
      userId: ctx.userId, entityId: calls[i].entityId || ctx.entityId, action: 'composio.' + proxyLabel_(calls[i].method, calls[i].endpoint), ref: ctx.ref, ok: r.ok,
      detail: { ms: ms, attempts: attempts[i], parallel: calls.length, status: r.status, upstream: r.upstream || undefined, forced: r.forced || undefined, error: r.ok ? undefined : r.error, log_id: r.log_id },
    });
  });
  return out;
}

/**
 * Uploads a blob to Composio's file store so it can be passed to a tool as { name, mimetype, s3key }.
 * Two steps: mint a presigned URL, then PUT the bytes straight to storage.
 */
function composioUploadFile(blob, toolkitSlug, toolSlug, ctx) {
  const bytes = blob.getBytes();
  const md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  const meta = { toolkit_slug: toolkitSlug, tool_slug: toolSlug, filename: blob.getName(), mimetype: blob.getContentType(), md5: md5 };

  const res = composioRequest_('/files/upload/request', meta, 'files.upload_request', ctx, function (status, json) {
    if ((status === 200 || status === 201) && json && json.key && (json.new_presigned_url || json.newPresignedUrl)) return { ok: true };
    const msg = errorText_(json) || ('HTTP ' + status);
    return { ok: false, retryable: isRetryableStatus_(status), message: msg };
  });

  const url = res.json.new_presigned_url || res.json.newPresignedUrl;
  const headers = {};
  if (res.json.metadata && res.json.metadata.storage_backend === 'azure_blob_storage') headers['x-ms-blob-type'] = 'BlockBlob';
  const t0 = Date.now();
  const put = UrlFetchApp.fetch(url, { method: 'put', payload: bytes, contentType: blob.getContentType(), headers: headers, muteHttpExceptions: true });
  const putOk = put.getResponseCode() >= 200 && put.getResponseCode() < 300;
  auditLog({ userId: ctx && ctx.userId, entityId: ctx && ctx.entityId, action: 'composio.files.put', ref: ctx && ctx.ref, ok: putOk, detail: { ms: Date.now() - t0, status: put.getResponseCode() } });
  if (!putOk) throw new AppError('COMPOSIO_UPLOAD_FAILED', 'File upload to Composio storage failed (HTTP ' + put.getResponseCode() + ').');
  return { name: blob.getName(), mimetype: blob.getContentType(), s3key: res.json.key };
}

/**
 * Shared POST with retry, backoff and audit. classify(status, json) -> { ok, retryable, message }.
 * Retries 429 and 5xx up to COMPOSIO_MAX_ATTEMPTS; never retries 4xx validation errors,
 * because repeating a rejected create would just burn the monthly tool-call budget.
 */
function composioRequest_(path, body, label, ctx, classify) {
  ctx = ctx || {};
  const apiKey = getSecret_('COMPOSIO_API_KEY');
  const t0 = Date.now();
  const forced = consumeForcedFailure_(label);
  let attempt = 0;
  let last = { status: 0, json: null, verdict: { ok: false, message: 'not attempted' } };

  while (attempt < COMPOSIO_MAX_ATTEMPTS) {
    attempt++;
    composioStats_.calls++;
    if (forced) {
      // Test hook: behaves like Composio being unreachable on every attempt, retries and backoff included.
      last = { status: 0, json: null, verdict: { ok: false, retryable: true, message: 'Forced failure for testing (Script Property TEST_FAIL_NEXT)' } };
      if (attempt < COMPOSIO_MAX_ATTEMPTS) { backoff_(attempt, null); continue; }
      break;
    }
    let resp;
    try {
      resp = UrlFetchApp.fetch(COMPOSIO_BASE_URL + path, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-api-key': apiKey },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      });
    } catch (err) {
      // Network-level failure (DNS, timeout): treat as transient.
      last = { status: 0, json: null, verdict: { ok: false, retryable: true, message: 'Network error: ' + err.message } };
      if (attempt < COMPOSIO_MAX_ATTEMPTS) { backoff_(attempt, null); continue; }
      break;
    }
    const status = resp.getResponseCode();
    let json = null;
    try { json = JSON.parse(resp.getContentText()); } catch (e) { json = null; }
    const verdict = classify(status, json);
    last = { status: status, json: json, verdict: verdict };
    if (verdict.ok || !verdict.retryable || attempt >= COMPOSIO_MAX_ATTEMPTS) break;
    backoff_(attempt, resp.getHeaders()['Retry-After'] || resp.getHeaders()['retry-after']);
  }

  const ms = Date.now() - t0;
  auditLog({
    userId: ctx.userId, entityId: ctx.entityId, action: 'composio.' + label, ref: ctx.ref, ok: last.verdict.ok,
    detail: { ms: ms, attempts: attempt, status: last.status, upstream: last.verdict.upstream || undefined, forced: forced || undefined, error: last.verdict.ok ? undefined : truncate_(last.verdict.message, 500), log_id: last.json && last.json.log_id },
  });

  if (!last.verdict.ok) {
    throw new AppError(last.status === 0 ? 'COMPOSIO_UNREACHABLE' : 'XERO_FAILED', truncate_(last.verdict.message, 300), { status: last.status, upstream: last.verdict.upstream || 0, attempts: attempt, ms: ms });
  }
  return { status: last.status, json: last.json, ms: ms, attempts: attempt };
}

/**
 * Test hook for the "Composio is down" acceptance tests. Script Property TEST_FAIL_NEXT holds a call
 * label prefix (e.g. "proxy PUT /PurchaseOrders"), optionally "$" for an exact label and "|n" for n
 * calls; each matching call fails every attempt, then the property is deleted, so the queue's retry
 * afterwards goes through normally.
 */
function consumeForcedFailure_(label) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('TEST_FAIL_NEXT');
  if (!raw) return false;
  // "<label prefix>[$][|count]": "$" = this exact label only; count = how many calls to fail (default 1).
  const m = /^(.*?)(\$)?(?:\|(\d+))?$/.exec(raw);
  const want = m[1];
  const hit = m[2] ? String(label) === want : String(label).indexOf(want) === 0;
  if (!hit) return false;
  const left = (Number(m[3]) || 1) - 1;
  if (left > 0) props.setProperty('TEST_FAIL_NEXT', want + (m[2] || '') + '|' + left);
  else props.deleteProperty('TEST_FAIL_NEXT');
  console.warn('TEST_FAIL_NEXT: forcing failure of ' + label + (left ? ' (' + left + ' more to come)' : ''));
  return true;
}

function backoff_(attempt, retryAfter) {
  let waitMs = Math.min(8000, 500 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
  const ra = Number(retryAfter);
  if (ra > 0) waitMs = Math.min(10000, ra * 1000);
  Utilities.sleep(waitMs);
}

function isRetryableStatus_(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Composio wraps upstream failures in a 200 with successful:false, so the status code alone
// can't tell a Xero rate limit from a validation error.
function looksTransient_(msg) {
  return /\b(429|50[0-9])\b|rate.?limit|too many requests|timed? ?out|temporar|unavailable/i.test(String(msg || ''));
}

/** Pulls a readable message out of any Composio / Xero error shape, without credentials. */
function errorText_(json) {
  if (!json) return '';
  const parts = [];
  if (typeof json.error === 'string') parts.push(json.error);
  else if (json.error && json.error.message) parts.push(json.error.message + (json.error.suggested_fix ? ' (' + json.error.suggested_fix + ')' : ''));
  const v = xeroValidationMessages_(json.data);
  if (v.length) parts.push(v.join('; '));
  if (!parts.length && json.data && json.data.Message) parts.push(json.data.Message);
  return parts.join(' | ');
}

function xeroValidationMessages_(data) {
  const out = [];
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    if (Array.isArray(o)) { o.forEach(x => visit(x, depth + 1)); return; }
    if (Array.isArray(o.ValidationErrors)) o.ValidationErrors.forEach(v => v && v.Message && out.push(v.Message));
    Object.keys(o).forEach(k => { if (k !== 'ValidationErrors' && typeof o[k] === 'object') visit(o[k], depth + 1); });
  };
  visit(data, 0);
  return out.filter((m, i) => out.indexOf(m) === i);
}

function truncate_(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
