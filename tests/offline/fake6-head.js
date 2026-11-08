function fakeXero(tenant, method, path, body, full) {
  const st = X[tenant]; if (!st) return { status: 403, data: { Message: 'no tenant' } };
  const pth = new URL('https://x' + path).pathname;
  const key = (((full && full.parameters) || []).find(p => p.name === 'Idempotency-Key') || {}).value;
  if (key) idemSeen.push(method + ' ' + pth + ' ' + key);
  const fault = faults.find(f => f.times > 0 && f.method === method && f.re.test(pth));
  if (fault && !fault.process) { fault.times--; return { status: fault.status, data: { Message: 'injected ' + fault.status } }; }
  if (key && st.idem[key]) return st.idem[key];
  const res = fakeXeroRoute(st, tenant, method, path, body, full);
  if (key && res.status < 500) st.idem[key] = res;
  if (fault && fault.process) { fault.times--; return { status: fault.status, data: { Message: 'answer lost' } }; }
  return res;
}
function fakeXeroRoute(st, tenant, method, path, body, full) {
