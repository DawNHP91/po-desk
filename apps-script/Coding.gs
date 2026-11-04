/**
 * Coding.gs — suggests the chart-of-accounts code for a purchase, and learns from the buyer's choice.
 *
 * Order (CLAUDE.md): 1 supplier history → 2 keyword rules → 3 category default → 4 fallback.
 * Every candidate must be an ACTIVE purchase account in THIS company's synced chart; anything else
 * (archived, another company's code, a balance-sheet account) is skipped, never returned.
 */

const PURCHASE_ACCOUNT_TYPES = Object.freeze(['EXPENSE', 'DIRECTCOSTS', 'OVERHEADS']);

/** Public entry point. Returns { accountCode, accountName, taxType, source, reason, needsReview }. */
function suggestAccount(entityId, contactId, categoryId, description) {
  const ent = entityById_(entityId).entity_id;
  return suggestAccountWith_(codingData_(ent), ent, contactId, categoryId, description);
}

/**
 * Records the buyer's final code for this supplier. Call it inside the PO-creation script lock:
 * it read-modify-writes the supplier's SupplierHistory rows. The nightly sync rebuilds the table
 * from Xero anyway, so a rare race only skews counts until 02:00.
 */
function recordChoice(entityId, contactId, accountCode) {
  const ent = entityById_(entityId).entity_id;
  if (!contactId) throw new AppError('BAD_REQUEST', 'A supplier is required.');
  const data = codingData_(ent);
  const allowed = allowedAccounts_(data, ent);
  const code = String(accountCode || '').trim();
  if (!allowed[code]) throw new AppError('ACCOUNT_NOT_ALLOWED', 'Account ' + code + ' is not an active purchase account for ' + ent + '.');

  const current = readTable('SupplierHistory').rows.filter(r => r.entity_id === ent && String(r.contact_id) === String(contactId));
  const next = applyChoice_(current.map(r => ({ account_code: String(r.account_code), uses: Number(r.uses) || 0, last_used: r.last_used })),
    code, new Date(), Number(data.config.historyN));

  // Rewrite this supplier's rows in place: update survivors, delete dropped ones bottom-up so row numbers stay valid.
  const sh = sheet_('SupplierHistory');
  const byCode = {};
  next.forEach(r => { byCode[r.account_code] = r; });
  const toDelete = [];
  current.forEach(r => {
    const n = byCode[String(r.account_code)];
    if (n) { updateHistoryRow_(r, n); delete byCode[String(r.account_code)]; } else toDelete.push(r._row);
  });
  toDelete.sort((a, b) => b - a).forEach(rowNum => sh.deleteRow(rowNum));
  invalidateTable_('SupplierHistory');
  Object.keys(byCode).forEach(c => appendRow('SupplierHistory', { entity_id: ent, contact_id: contactId, account_code: c, uses: byCode[c].uses, last_used: byCode[c].last_used }));
  return next;
}

function updateHistoryRow_(row, n) {
  const table = readTable('SupplierHistory');
  row.uses = n.uses;
  row.last_used = n.last_used;
  sheet_('SupplierHistory').getRange(row._row, 1, 1, table.headers.length).setValues([table.headers.map(h => cell_(row[h]))]);
}

/**
 * Pure: adds one purchase with `code`, then trims the supplier back to its last N purchases by
 * removing uses from the least recently used code. Keeps the "last N" meaning between nightly syncs.
 */
function applyChoice_(rows, code, when, n) {
  const out = rows.map(r => ({ account_code: r.account_code, uses: r.uses, last_used: r.last_used }));
  const hit = out.find(r => r.account_code === code);
  if (hit) { hit.uses++; hit.last_used = when; } else out.push({ account_code: code, uses: 1, last_used: when });
  let total = out.reduce((s, r) => s + r.uses, 0);
  while (total > n) {
    const oldest = out.filter(r => r.account_code !== code || out.length === 1)
      .sort((a, b) => new Date(a.last_used) - new Date(b.last_used))[0];
    oldest.uses--;
    total--;
    if (oldest.uses <= 0) out.splice(out.indexOf(oldest), 1);
  }
  return out;
}

// --- Data loading ----------------------------------------------------------------------------

function codingData_(ent) {
  const ref = getRefData(ent);
  return {
    accounts: ref.accounts,
    taxRates: ref.taxRates,
    suppliers: ref.suppliers,
    categories: readTable('Categories').rows.filter(r => r.entity_id === ent),
    history: readTable('SupplierHistory').rows.filter(r => r.entity_id === ent),
    config: {
      historyN: Number(getConfig('SUPPLIER_HISTORY_N', 5)),
      defaultAccount: String(getConfig('DEFAULT_ACCOUNT_' + ent, '') || ''),
      extraAccounts: String(getConfig('EXTRA_PURCHASE_ACCOUNTS_' + ent, '') || ''),
      purchaseTaxType: String(getConfig('PURCHASE_TAX_TYPE', 'INPUT3')),
    },
  };
}

// --- Pure engine (unit-tested with fixtures in Tests.gs) ------------------------------------

function suggestAccountWith_(data, ent, contactId, categoryId, description) {
  const allowed = allowedAccounts_(data, ent);
  const skipped = [];
  const result = (code, source, reason, preferredTax, needsReview) => {
    const acct = allowed[code];
    return {
      accountCode: code, accountName: acct.name, taxType: pickTaxType_(data, ent, preferredTax, acct),
      source: source, reason: reason, needsReview: !!needsReview, skipped: skipped,
    };
  };

  // 1. Supplier history: one row for this supplier means its last N purchases all shared that code.
  if (contactId) {
    const rows = (data.history || []).filter(r => r.entity_id === ent && String(r.contact_id) === String(contactId));
    if (rows.length === 1) {
      const code = String(rows[0].account_code);
      const uses = Number(rows[0].uses) || 0;
      if (allowed[code]) {
        return result(code, 'history', 'Last ' + uses + ' purchase' + (uses === 1 ? '' : 's') + ' from this supplier used ' + code + ' ' + allowed[code].name + '.', '', false);
      }
      skipped.push('history code ' + code + ' is not an active purchase account here');
    } else if (rows.length > 1) {
      skipped.push('supplier history is mixed (' + rows.map(r => r.account_code).join(', ') + ')');
    }
  }

  const categories = (data.categories || []).filter(c => c.entity_id === ent && isTrue_(c.active));

  // 2. Keyword rules, scored by matched characters so "lab coat" beats "lab".
  const desc = String(description || '').toLowerCase();
  if (desc) {
    const scored = categories.map(c => {
      const hits = splitKeywords_(c.keywords).filter(k => keywordMatches_(desc, k));
      return { cat: c, hits: hits, score: hits.reduce((s, k) => s + k.length, 0) };
    }).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (Number(a.cat.sort) || 0) - (Number(b.cat.sort) || 0));
    for (let i = 0; i < scored.length; i++) {
      const code = String(scored[i].cat.account_code || '');
      if (allowed[code]) {
        return result(code, 'keyword', '"' + scored[i].hits[0] + '" matches ' + scored[i].cat.name + '.', scored[i].cat.tax_type, false);
      }
      skipped.push('keyword category ' + scored[i].cat.name + ' has code ' + (code || '(blank)') + ', not an active purchase account here');
    }
  }

  // 3. Category default. A category ID from another company is not in `categories` and is ignored.
  if (categoryId) {
    const cat = categories.find(c => String(c.category_id) === String(categoryId));
    if (cat) {
      const code = String(cat.account_code || '');
      if (allowed[code]) return result(code, 'category', 'Default for ' + cat.name + '.', cat.tax_type, false);
      skipped.push('category ' + cat.name + ' has code ' + (code || '(blank)') + ', not an active purchase account here');
    } else {
      skipped.push('category ' + categoryId + ' is not an active category of ' + ent);
    }
  }

  // 4. Fallback.
  const fallback = data.config.defaultAccount;
  if (fallback && allowed[fallback]) {
    return result(fallback, 'fallback', 'No supplier history or matching category: default account, needs review.', '', true);
  }
  if (fallback) skipped.push('DEFAULT_ACCOUNT_' + ent + ' (' + fallback + ') is not an active purchase account here');
  return {
    accountCode: null, accountName: null, taxType: pickTaxType_(data, ent, '', null),
    source: 'none', reason: 'No valid account found: please choose one.', needsReview: true, skipped: skipped,
  };
}

/** code -> account for ACTIVE accounts of THIS company that are purchase accounts (or listed extras). */
function allowedAccounts_(data, ent) {
  const extras = String(data.config.extraAccounts || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  const out = {};
  (data.accounts || []).forEach(a => {
    if (a.entity_id !== ent || a.status !== 'ACTIVE' || !a.code) return;
    const code = String(a.code);
    const isPurchase = a.class === 'EXPENSE' && PURCHASE_ACCOUNT_TYPES.indexOf(a.type) !== -1;
    if (isPurchase || extras.indexOf(code) !== -1) out[code] = a;
  });
  return out;
}

/**
 * First usable of: category tax type, the account's default, Config PURCHASE_TAX_TYPE.
 * "Usable" = ACTIVE in this company and not a legacy 14% rate: SA VAT went to 15% in April 2018,
 * yet some accounts (e.g. 318/319 in HPB and PK) still default to the old 14% INPUT code.
 */
function pickTaxType_(data, ent, preferred, account) {
  const rates = {};
  (data.taxRates || []).forEach(r => { if (r.entity_id === ent) rates[String(r.tax_type)] = r; });
  const usable = t => t && rates[t] && rates[t].status === 'ACTIVE' && Number(rates[t].rate) !== 14;
  const candidates = [preferred, account && account.tax_type, data.config.purchaseTaxType];
  for (let i = 0; i < candidates.length; i++) if (usable(String(candidates[i] || ''))) return String(candidates[i]);
  return '';
}

function splitKeywords_(s) {
  return String(s || '').toLowerCase().split(/[,;\n]+/).map(k => k.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** Whole words / phrases only, so "shell" doesn't match "shellfish" and "tea" doesn't match "team". */
function keywordMatches_(descLower, keyword) {
  const pattern = keyword.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp('(^|[^a-z0-9])' + pattern + '($|[^a-z0-9])', 'i').test(descLower);
}

function isTrue_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

/**
 * recordChoice() as write requests for the PO hot path, planned from rows read inside the lock.
 * Returns { reqs } for parallel Sheets API writes, or null when rows must be deleted (the supplier's
 * window dropped a code); deletions are rare and go through recordChoice() instead.
 */
function planChoiceWrites_(ent, contactId, accountCode, freshRows, n) {
  const current = freshRows.filter(r => r.entity_id === ent && String(r.contact_id) === String(contactId));
  const next = applyChoice_(current.map(r => ({ account_code: String(r.account_code), uses: Number(r.uses) || 0, last_used: r.last_used })),
    String(accountCode), new Date(), n);
  const byCode = {};
  next.forEach(r => { byCode[r.account_code] = r; });
  if (current.some(r => !byCode[String(r.account_code)])) return null;
  const reqs = [];
  current.forEach(r => {
    const nr = byCode[String(r.account_code)];
    if (Number(r.uses) !== nr.uses || String(r.last_used) !== String(nr.last_used)) {
      reqs.push(updateReq_('SupplierHistory', r._row, { entity_id: ent, contact_id: contactId, account_code: nr.account_code, uses: nr.uses, last_used: nr.last_used }));
    }
    delete byCode[String(r.account_code)];
  });
  const fresh = Object.keys(byCode).map(c => ({ entity_id: ent, contact_id: contactId, account_code: c, uses: byCode[c].uses, last_used: byCode[c].last_used }));
  if (fresh.length) reqs.push(appendReq_('SupplierHistory', fresh));
  return { reqs: reqs };
}
