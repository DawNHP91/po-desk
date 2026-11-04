/**
 * Approvals.gs — approving and declining POs over a buyer's limit, the emails around it (approvers
 * on submit, a reminder after 4 working hours, the buyer on the decision), and the 08:00 digest.
 *
 * Email is best effort: a failed email never fails a PO or a decision. Everything is in the AuditLog
 * either way.
 *
 * Own POs (decided 4 Nov 2026): nobody approves their own PO, except an admin when no one else can
 * approve for that company. That case is logged and marked "self-approved" everywhere it shows.
 */

// --- Who may decide --------------------------------------------------------------------------

/** Active users with can_approve for a company, optionally leaving one person out. */
function approversFor_(ent, exceptUserId) {
  const ids = readTable('UserEntities').rows
    .filter(r => r.entity_id === ent && isTrue_(r.can_approve) && String(r.user_id) !== String(exceptUserId || ''))
    .map(r => String(r.user_id));
  return readTable('Users').rows.filter(u => ids.indexOf(String(u.user_id)) !== -1 && isTrue_(u.active));
}

/** May this user decide their own PO in this company? Only an admin, and only when nobody else can. */
function canApproveOwn_(user, ent) {
  return user.role === 'admin' && approversFor_(ent, user.user_id).length === 0;
}

function appUrl_(path) {
  return String(getConfig('APP_URL', 'https://po.pharmakaru.co.za/')).replace(/\/?$/, '/') + '#' + path;
}

// --- Emails on submit --------------------------------------------------------------------------

/**
 * Emails every active approver of the PO's company except the buyer, with a link straight to the
 * item. Returns { notified, names, warning } for the PO-issued screen.
 */
function notifyApprovers_(row, buyer, account) {
  const ent = row.entity_id;
  const company = entityById_(ent).short_name;
  const approvers = approversFor_(ent, buyer.user_id);
  if (!approvers.length) {
    const own = canApproveOwn_(buyer, ent) && isTrue_((readTable('UserEntities').rows.find(r => String(r.user_id) === String(buyer.user_id) && r.entity_id === ent) || {}).can_approve);
    auditLog({ userId: buyer.user_id, entityId: ent, action: 'po.approvers', ok: false, ref: row.po_id, detail: { reason: 'no other approver', selfApprovalAllowed: own } });
    return {
      notified: 0, names: [],
      warning: own ? 'No one else can approve ' + company + ' POs, so you may approve this one yourself in Approvals. It will be marked self-approved.'
        : 'No one else can approve ' + company + ' POs yet. Ask your PO Desk admin.',
    };
  }
  const number = row.po_number || row.provisional_ref;
  const subject = number + ' needs your approval: ' + company + ', ' + randText_(row.amount_incl_zar);
  const body = [
    firstName_(buyer.name) + ' raised ' + number + ' for ' + randText_(row.amount_incl_zar) + ' at ' + row.supplier_name + '.',
    '',
    'What: ' + row.description,
    'Account: ' + row.account_code + (account ? ' ' + account.name : ''),
    'Company: ' + company,
    '',
    'It is above their limit, so it waits in Xero as "Submitted" until someone approves it. They have been told not to buy yet.',
    '',
    'Approve or decline it here: ' + appUrl_('/approvals/' + row.po_id),
  ].join('\n');
  const sent = approvers.filter(u => sendMail_(u.email, subject, body));
  auditLog({ userId: buyer.user_id, entityId: ent, action: 'po.approvers', ok: sent.length > 0, ref: row.po_id, detail: { notified: sent.length } });
  return { notified: sent.length, names: sent.map(u => firstName_(u.name)), warning: sent.length ? '' : 'The approval email could not be sent. Please tell an approver yourself.' };
}

/** Tells the buyer the real PO number once the queue has turned a provisional ref into a Xero PO. */
function notifyBuyerConverted_(row, buyer) {
  const waiting = row.status === PO_STATUS.AWAITING_APPROVAL;
  const subject = (waiting ? 'Awaiting approval: ' : 'Your PO number: ') + row.po_number + ' (was ' + row.provisional_ref + ')';
  const body = [
    'Hi ' + firstName_(buyer.name) + ',',
    '',
    'Xero is back. Your provisional reference ' + row.provisional_ref + ' is now ' + row.po_number + '.',
    'Supplier: ' + row.supplier_name + ', ' + randText_(row.amount_incl_zar) + '.',
    '',
    waiting ? 'This PO is above your limit and is waiting for approval: don’t buy yet.' : 'Use ' + row.po_number + ' from now on. It is also in My POs.',
  ].join('\n');
  return sendMail_(buyer.email, subject, body);
}

// --- The Approvals screen ------------------------------------------------------------------------

/** Everything waiting for this user's decision, oldest first. Own POs only where self-approval is allowed. */
function actionListApprovals_(req, ctx) {
  const ents = Object.keys(ctx.grants).filter(e => ctx.grants[e].canApprove);
  if (!ents.length) throw new AppError('FORBIDDEN', 'You can’t approve POs.');
  const users = {};
  readTable('Users').rows.forEach(u => { users[String(u.user_id)] = u; });
  const limits = {};
  readTable('UserEntities').rows.forEach(r => { limits[r.user_id + '|' + r.entity_id] = Number(r.po_limit_zar) || 0; });
  const pms = pmIndex_();
  const accounts = {};
  ents.forEach(e => { accounts[e] = getRefData(e).accounts; });
  const now = new Date();
  const items = readTable('POs').rows
    .filter(r => r.status === PO_STATUS.AWAITING_APPROVAL && ents.indexOf(r.entity_id) !== -1)
    .filter(r => String(r.buyer_user_id) !== String(ctx.user.user_id) || canApproveOwn_(ctx.user, r.entity_id))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(r => {
      const buyer = users[String(r.buyer_user_id)] || {};
      return Object.assign(poView_(r, { accounts: accounts[r.entity_id] }, pms[r.pm_id], null), {
        company: entityById_(r.entity_id).short_name,
        buyerName: String(buyer.name || ''),
        buyerLimitZar: limits[r.buyer_user_id + '|' + r.entity_id] || 0,
        waitingWorkMinutes: workingMinutesBetween_(new Date(r.created_at), now),
        own: String(r.buyer_user_id) === String(ctx.user.user_id),
      });
    });
  return { items: items };
}

/**
 * Approve (Xero PO SUBMITTED -> AUTHORISED, row ISSUED) or decline (Xero DELETED, row DECLINED),
 * with an optional note. Under the lock, so two approvers deciding at once can't both win.
 * payload: { poId, decision: 'approve' | 'decline', note }
 */
function actionDecidePO_(req, ctx) {
  const p = req.payload;
  const decision = p.decision === 'approve' || p.decision === 'decline' ? p.decision : '';
  if (!decision) throw new AppError('BAD_REQUEST', 'Choose approve or decline.');
  const note = String(p.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const poId = str_(p.poId, 60);
  rateLimit_('decide', ctx.user.user_id, 60, 3600);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Please try again.');
  let po;
  let self = false;
  try {
    if (!fastRead_(['POs'], true)) invalidateTable_('POs');
    po = poId ? findBy('POs', 'po_id', poId)[0] : null;
    const g = po ? ctx.grants[po.entity_id] : null;
    // Same answer for "no such PO" and "not your company": PO IDs can't be probed.
    if (!po || !g || !g.canApprove) throw new AppError('NOT_FOUND', 'PO not found.');
    self = String(po.buyer_user_id) === String(ctx.user.user_id);
    if (self && !canApproveOwn_(ctx.user, po.entity_id)) {
      auditLog({ userId: ctx.user.user_id, entityId: po.entity_id, action: 'po.decide', ok: false, ref: po.po_id, detail: { refused: 'own PO' } });
      throw new AppError('FORBIDDEN', 'You can’t decide your own PO. Another approver of ' + entityById_(po.entity_id).short_name + ' must.');
    }
    if (po.status !== PO_STATUS.AWAITING_APPROVAL) {
      const by = po.approver_user_id ? (findBy('Users', 'user_id', po.approver_user_id)[0] || {}).name : '';
      throw new AppError('ALREADY_DECIDED', 'This PO was already ' + (po.status === PO_STATUS.DECLINED ? 'declined' : 'decided') + (by ? ' by ' + by : '') + '.');
    }
    const t = entityById_(po.entity_id).xero_tenant_id;
    const xstatus = decision === 'approve' ? 'AUTHORISED' : 'DELETED';
    try {
      xeroRunCall_(xeroPoUpdateCall_(t, String(po.xero_po_id), xstatus, '', 'po-desk-decide-' + po.po_id + '-' + xstatus), { userId: ctx.user.user_id, ref: po.po_id });
    } catch (err) {
      if (isXeroRejection_(err)) throw new AppError('XERO_REJECTED', 'Xero didn’t accept this: ' + err.message);
      throw new AppError('XERO_DOWN', 'Xero isn’t answering right now. Nothing was changed; please try again in a few minutes.');
    }
    updateRowById('POs', 'po_id', po.po_id, {
      status: decision === 'approve' ? PO_STATUS.ISSUED : PO_STATUS.DECLINED,
      approver_user_id: ctx.user.user_id, decided_at: new Date(), decision_note: note,
    });
    po = findBy('POs', 'po_id', po.po_id)[0];
  } finally {
    lock.releaseLock();
  }

  // The record in Xero says who decided; best effort, after the lock.
  const who = String(ctx.user.name) + (self ? ' (self-approved: no other approver)' : '');
  try {
    xeroAddHistoryNote(entityById_(po.entity_id).xero_tenant_id, 'PurchaseOrders', String(po.xero_po_id),
      'PO Desk: ' + (decision === 'approve' ? 'approved' : 'declined') + ' by ' + who + (note ? '. Note: ' + note : '.'), { userId: ctx.user.user_id, ref: po.po_id });
  } catch (err) { console.warn('History note failed: ' + err.message); }
  const emailed = notifyBuyerDecision_(po, ctx.user, decision, note, self);
  auditLog({ userId: ctx.user.user_id, entityId: po.entity_id, action: 'po.' + decision, ok: true, ref: po.po_id, detail: { po: po.po_number, self: self || undefined, note: note || undefined, emailed: emailed } });
  return { poId: po.po_id, poNumber: String(po.po_number), status: po.status, self: self, buyerEmailed: emailed };
}

function notifyBuyerDecision_(po, approver, decision, note, self) {
  const buyer = findBy('Users', 'user_id', po.buyer_user_id)[0];
  if (!buyer || self) return false;
  const yes = decision === 'approve';
  const subject = po.po_number + (yes ? ' approved: you can buy' : ' declined: don’t buy');
  const body = [
    'Hi ' + firstName_(buyer.name) + ',',
    '',
    firstName_(approver.name) + (yes ? ' approved ' : ' declined ') + po.po_number + ' (' + po.supplier_name + ', ' + randText_(po.amount_incl_zar) + ').',
    note ? 'Note: ' + note : '',
    '',
    yes ? 'You can buy now. Give the supplier ' + po.po_number + ', then photograph the slip in PO Desk.' : 'Please don’t buy this. The PO is cancelled in Xero.',
    '',
    'Open the PO: ' + appUrl_('/po/' + po.po_id),
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return sendMail_(buyer.email, subject, body);
}

// --- Reminder after 4 working hours ---------------------------------------------------------------

/**
 * Called by every processQueue run (every 5 minutes). Sends ONE reminder per PO, to the same people
 * the first email went to, once it has waited APPROVAL_REMINDER_HOURS working hours. reminded_at is
 * written under the lock before anything is sent, so a second trigger can't send it twice.
 */
function sendApprovalReminders_() {
  const now = new Date();
  const needMin = Number(getConfig('APPROVAL_REMINDER_HOURS', 4)) * 60;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return [];
  let due = [];
  try {
    invalidateTable_('POs');
    due = readTable('POs').rows.filter(r => r.status === PO_STATUS.AWAITING_APPROVAL && !r.reminded_at && r.created_at &&
      workingMinutesBetween_(new Date(r.created_at), now) >= needMin);
    due.forEach(r => updateRowById('POs', 'po_id', r.po_id, { reminded_at: now }));
  } finally {
    lock.releaseLock();
  }
  return due.map(r => {
    const buyer = findBy('Users', 'user_id', r.buyer_user_id)[0] || { user_id: '', name: 'A buyer' };
    let approvers = approversFor_(r.entity_id, buyer.user_id);
    if (!approvers.length && canApproveOwn_(buyer, r.entity_id)) approvers = [buyer];
    const subject = 'Reminder: ' + r.po_number + ' is still waiting for approval (' + entityById_(r.entity_id).short_name + ', ' + randText_(r.amount_incl_zar) + ')';
    const body = [
      firstName_(buyer.name) + '’s PO ' + r.po_number + ' (' + r.supplier_name + ', ' + randText_(r.amount_incl_zar) + ') has waited more than ' +
        getConfig('APPROVAL_REMINDER_HOURS', 4) + ' working hours. They can’t buy until someone decides.',
      '',
      'Approve or decline it here: ' + appUrl_('/approvals/' + r.po_id),
    ].join('\n');
    const sent = approvers.filter(u => sendMail_(u.email, subject, body)).length;
    auditLog({ entityId: r.entity_id, action: 'po.reminder', ok: sent > 0, ref: r.po_id, detail: { po: r.po_number, notified: sent } });
    return r.po_number + ': ' + sent + ' reminded';
  });
}

/**
 * Minutes between two moments that fall inside working hours: Monday to Friday, WORKDAY_START_HOUR
 * to WORKDAY_END_HOUR in South African time (UTC+2 all year, no daylight saving). Public holidays
 * are not known to PO Desk and count as working days.
 */
function workingMinutesBetween_(from, to) {
  if (!(from instanceof Date) || isNaN(from.getTime()) || !(to > from)) return 0;
  const OFFSET = 2 * 3600e3;
  const startH = Number(getConfig('WORKDAY_START_HOUR', 8));
  const endH = Number(getConfig('WORKDAY_END_HOUR', 17));
  const a = from.getTime() + OFFSET;
  const b = to.getTime() + OFFSET;
  let total = 0;
  for (let day = Math.floor(a / 86400000) * 86400000; day < b; day += 86400000) {
    const dow = new Date(day).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const s = Math.max(a, day + startH * 3600e3);
    const e = Math.min(b, day + endH * 3600e3);
    if (e > s) total += e - s;
  }
  return Math.floor(total / 60000);
}

// --- The 08:00 digest for admins ------------------------------------------------------------------

/** Trigger handler (08:00 daily). A second trigger, or a second run the same day, sends nothing. */
function dailyDigest() {
  if (!claimDailyRun_('digest')) { console.log('dailyDigest: already sent today.'); return 'already sent today'; }
  return sendDigestNow();
}

/** Builds and emails the digest to every active admin. Run from the editor to see it any time. */
function sendDigestNow() {
  const d = digest_(new Date());
  const admins = readTable('Users').rows.filter(u => u.role === 'admin' && isTrue_(u.active));
  const sent = admins.filter(u => sendMail_(u.email, d.subject, d.body)).length;
  auditLog({ action: 'digest.send', ok: sent > 0, detail: { admins: admins.length, sent: sent, counts: d.counts } });
  console.log(d.subject + '\n\n' + d.body + '\n\n(sent to ' + sent + ' of ' + admins.length + ' admin(s))');
  return d;
}

/**
 * Per company: POs issued yesterday; POs issued more than DIGEST_OPEN_DAYS days ago still without a
 * bill, by buyer; provisional refs still waiting for Xero; yesterday's bills with flags, plus bills
 * still finishing in Xero; and how many POs wait for approval.
 */
function digest_(now) {
  ['POs', 'Bills', 'Queue', 'Users'].forEach(invalidateTable_);
  const ymd = (d) => Utilities.formatDate(d, APP.TZ, 'yyyy-MM-dd');
  const yesterday = ymd(new Date(now.getTime() - 86400000));
  const openDays = Number(getConfig('DIGEST_OPEN_DAYS', 3));
  const users = {};
  readTable('Users').rows.forEach(u => { users[String(u.user_id)] = String(u.name); });
  const bills = readTable('Bills').rows;
  const sent = {};
  bills.forEach(b => { if (b.status) sent[b.po_id] = b; });
  const jobs = readTable('Queue').rows;
  const FLAG_TEXT = {
    VARIANCE: 'amount differs from the PO', SUPPLIER_MISMATCH: 'slip names another supplier', NO_VAT_NUMBER: 'no supplier VAT number',
    FULL_TAX_INVOICE: 'over the full-tax-invoice limit', DATE_GAP: 'slip date far from the PO', DUPLICATE: 'possible duplicate slip',
  };
  const counts = {};
  const sections = [];
  ENTITY_SEED.forEach(e => {
    const ent = e.entity_id;
    const pos = readTable('POs').rows.filter(r => r.entity_id === ent && r.status);
    const byId = {};
    pos.forEach(r => { byId[r.po_id] = r; });
    const line = (r) => (r.po_number || r.provisional_ref) + '  ' + randText_(r.amount_incl_zar) + '  ' + r.supplier_name + ' (' + firstName_(users[String(r.buyer_user_id)]) + ')';
    const issued = pos.filter(r => r.status !== PO_STATUS.CANCELLED && r.created_at && ymd(new Date(r.created_at)) === yesterday);
    const open = pos.filter(r => r.status === PO_STATUS.ISSUED && !sent[r.po_id] && (now - new Date(r.created_at)) > openDays * 86400000);
    const pending = pos.filter(r => r.status === PO_STATUS.PENDING_XERO);
    const awaiting = pos.filter(r => r.status === PO_STATUS.AWAITING_APPROVAL);
    const flagged = bills.filter(b => b.entity_id === ent && b.status && b.flags && b.flags !== '[]' &&
      ymd(new Date((parseJson_(b.steps_json) || {}).startedAt || b.created_at)) === yesterday);
    const unfinished = bills.filter(b => b.entity_id === ent && (b.status === BILL_STATUS.QUEUED || b.status === BILL_STATUS.POSTING));
    counts[ent] = { issued: issued.length, open: open.length, pending: pending.length, flagged: flagged.length, unfinished: unfinished.length, awaiting: awaiting.length };

    const out = ['== ' + e.short_name + ' =='];
    if (!issued.length && !open.length && !pending.length && !flagged.length && !unfinished.length && !awaiting.length) {
      sections.push(out.concat(['Nothing to report.']).join('\n'));
      return;
    }
    out.push('', 'Issued yesterday: ' + issued.length + (issued.length ? ' (' + randText_(issued.reduce((s, r) => s + Number(r.amount_incl_zar), 0)) + ')' : ''));
    issued.forEach(r => out.push('  ' + line(r) + (r.status !== PO_STATUS.ISSUED && r.status !== PO_STATUS.BILLED ? '  [' + r.status.replace('_', ' ').toLowerCase() + ']' : '')));
    out.push('', 'Open more than ' + openDays + ' days without a slip: ' + open.length);
    const byBuyer = {};
    open.forEach(r => { const n = users[String(r.buyer_user_id)] || 'Unknown'; (byBuyer[n] = byBuyer[n] || []).push(r); });
    Object.keys(byBuyer).sort().forEach(n => {
      out.push('  ' + n + ':');
      byBuyer[n].forEach(r => out.push('    ' + line(r) + ', ' + Math.floor((now - new Date(r.created_at)) / 86400000) + ' days'));
    });
    out.push('', 'Waiting for Xero (provisional refs): ' + pending.length);
    pending.forEach(r => {
      const job = jobs.find(j => String(j.payload_json).indexOf(r.po_id) !== -1);
      out.push('  ' + line(r) + (job && job.last_error ? ' — ' + truncate_(job.last_error, 120) : ''));
    });
    out.push('', 'Bills from yesterday with notes: ' + flagged.length);
    flagged.forEach(b => {
      const po = byId[b.po_id] || {};
      const notes = (parseJson_(b.flags) || []).map(c => FLAG_TEXT[c] || c).join('; ');
      out.push('  ' + ((parseJson_(b.steps_json) || {}).reference || po.po_number) + '  ' + randText_(b.total_incl_zar) + ': ' + notes);
    });
    if (unfinished.length) {
      out.push('', 'Bills still finishing in Xero: ' + unfinished.length);
      unfinished.forEach(b => out.push('  ' + ((byId[b.po_id] || {}).po_number || b.po_id) + ': ' + truncate_((parseJson_(b.steps_json) || {}).lastError || 'waiting for its next try', 120)));
    }
    if (awaiting.length) out.push('', 'Waiting for approval: ' + awaiting.length);
    sections.push(out.join('\n'));
  });
  const totals = Object.keys(counts).reduce((s, k) => s + counts[k].open + counts[k].pending + counts[k].flagged + counts[k].unfinished, 0);
  return {
    subject: 'PO Desk daily: ' + Utilities.formatDate(now, APP.TZ, 'd MMM yyyy') + (totals ? ' — ' + totals + ' item(s) to look at' : ' — nothing needs attention'),
    body: sections.join('\n\n') + '\n\nOpen PO Desk: ' + appUrl_('/home'),
    counts: counts,
  };
}

/**
 * True the first time it is called for `name` on a given day (SAST), false after that. Lets a job
 * cope with its trigger being installed twice. The check and the mark happen under the script lock.
 */
function claimDailyRun_(name) {
  const key = 'RAN_' + name.toUpperCase();
  const today = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return false;
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(key) === today) return false;
    props.setProperty(key, today);
    return true;
  } finally {
    lock.releaseLock();
  }
}

// --- Mail helpers -------------------------------------------------------------------------------

/** Emails every active admin (queue jobs that gave up, suspected tenant problems). */
function alertAdmins_(subject, body) {
  readTable('Users').rows
    .filter(u => u.role === 'admin' && isTrue_(u.active))
    .forEach(u => sendMail_(u.email, 'PO Desk: ' + subject, body));
}

function sendMail_(to, subject, body) {
  if (!isDeliverable_(to)) { console.log('Email skipped (test address): ' + to + ' — ' + subject); return false; }
  try {
    if (MailApp.getRemainingDailyQuota() < 1) { console.warn('Email quota used up; not sent: ' + subject); return false; }
    MailApp.sendEmail({ to: String(to), subject: subject, body: body, name: 'PO Desk' });
    return true;
  } catch (err) {
    console.warn('Email to ' + to + ' failed: ' + err.message);
    return false;
  }
}

/** Test accounts use the reserved .test domain; mail to them would only bounce. */
function isDeliverable_(email) {
  const e = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !/\.test$/.test(e);
}

function firstName_(name) {
  return String(name || '').split(/\s+/)[0];
}

function randText_(n) {
  const v = Number(n) || 0;
  return 'R' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
