/**
 * Approvals.gs — approval and buyer notifications (MailApp). The approve/decline screen and actions
 * are built in the Approvals stage; Flow 1 only needs approvers told and buyers kept informed.
 *
 * Email is best effort: a failed email never fails a PO. Everything is in the AuditLog either way.
 */

/**
 * Emails every active approver of the PO's company except the buyer. Returns
 * { notified, names, warning } for the PO-issued screen.
 */
function notifyApprovers_(row, buyer, account) {
  const ent = row.entity_id;
  const approverIds = readTable('UserEntities').rows
    .filter(r => r.entity_id === ent && isTrue_(r.can_approve) && String(r.user_id) !== String(buyer.user_id))
    .map(r => String(r.user_id));
  const approvers = readTable('Users').rows.filter(u => approverIds.indexOf(String(u.user_id)) !== -1 && isTrue_(u.active));
  if (!approvers.length) {
    auditLog({ userId: buyer.user_id, entityId: ent, action: 'po.approvers', ok: false, ref: row.po_id, detail: { reason: 'no other approver' } });
    return { notified: 0, names: [], warning: 'No one else can approve ' + entityById_(ent).short_name + ' POs yet. Ask your PO Desk admin.' };
  }
  const company = entityById_(ent).short_name;
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
    'Open PO Desk to approve or decline it.',
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
