/**
 * Main.gs — web app entry points.
 *
 * The browser sends POST with Content-Type text/plain so it is a "simple" CORS request:
 * Apps Script cannot answer an OPTIONS preflight, so JSON content types would fail.
 */

// Actions are added stage by stage. Handlers get (req, ctx); ctx is the verified session
// ({ user, grants }) and is null only for public routes. Wrapped in arrows so functions defined
// in other files are looked up at call time, not while this file loads.
const ROUTES = {
  ping: { public: true, fn: () => ({ pong: true, version: APP.VERSION }) },
  login: { public: true, fn: (req) => actionLogin_(req) },
  logout: { public: true, fn: (req) => actionLogout_(req) },
  me: { fn: (req, ctx) => actionMe_(req, ctx) },
  refData: { fn: (req, ctx) => actionRefData_(req, ctx) },
};

function doGet() {
  return json_({ ok: true, version: APP.VERSION });
}

function doPost(e) {
  let envelope;
  try {
    const req = parseRequest_(e);
    const route = Object.prototype.hasOwnProperty.call(ROUTES, req.action) ? ROUTES[req.action] : null;
    if (!route) throw new AppError('UNKNOWN_ACTION', 'Unknown action.');
    const ctx = route.public ? null : requireSession_(req.token);
    envelope = { ok: true, data: route.fn(req, ctx) };
  } catch (err) {
    envelope = { ok: false, error: publicError_(err) };
  }
  return json_(envelope);
}

function parseRequest_(e) {
  const raw = e && e.postData && e.postData.contents;
  if (!raw) throw new AppError('BAD_REQUEST', 'Empty request.');
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw new AppError('BAD_REQUEST', 'Request is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || typeof body.action !== 'string') {
    throw new AppError('BAD_REQUEST', 'Missing action.');
  }
  return {
    action: body.action,
    token: typeof body.token === 'string' ? body.token : '',
    payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
    idemKey: typeof body.idemKey === 'string' ? body.idemKey : '',
  };
}

/** Only AppErrors carry a message to the browser; anything else is logged server-side and hidden. */
function publicError_(err) {
  if (err instanceof AppError) {
    console.warn('AppError ' + err.code + ': ' + err.message);
    return { code: err.code, message: err.message };
  }
  console.error('Unhandled: ' + (err && err.stack ? err.stack : err));
  return { code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
