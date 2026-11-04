/**
 * Coding.gs — suggests the chart-of-accounts code for a purchase, and learns from the buyer's choice.
 *
 * Order (CLAUDE.md): 1 supplier history → 2 keyword rules → 3 learned words (past bills with the
 * same words; then words borrowed from other companies, Config WORD_BORROW_<company>) → 4 category
 * default → 5 fallback.
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
    words: wordIndexFor_(ent),
    borrowed: borrowedWordIndex_(ent, ref.accounts),
    config: {
      historyN: Number(getConfig('SUPPLIER_HISTORY_N', 5)),
      defaultAccount: String(getConfig('DEFAULT_ACCOUNT_' + ent, '') || ''),
      extraAccounts: String(getConfig('EXTRA_PURCHASE_ACCOUNTS_' + ent, '') || ''),
      purchaseTaxType: String(getConfig('PURCHASE_TAX_TYPE', 'INPUT3')),
      wordMinShare: Number(getConfig('WORD_MIN_SHARE', 0.6)) || 0.6,
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

  // 3. Learned words: what past bills with the same words in their description were coded to.
  if (desc && data.words) {
    const w = wordSuggest_(data.words, desc, allowed, { minShare: data.config.wordMinShare });
    if (w) {
      return result(w.code, 'words', w.count + ' earlier bill line' + (w.count === 1 ? '' : 's') + ' with “' + w.word + '” went to ' + w.code + ' ' + allowed[w.code].name + '.', '', false);
    }
  }
  // 3b. Borrowed: the same, from other companies' bills, only for accounts with the same code and name here.
  if (desc && data.borrowed) {
    const w = wordSuggest_(data.borrowed, desc, allowed, { minShare: data.config.wordMinShare });
    if (w) {
      return result(w.code, 'borrowed', w.count + ' bill line' + (w.count === 1 ? '' : 's') + ' at ' + (data.borrowed.from || []).join(' and ') + ' with “' + w.word + '” went to ' + w.code + ' ' + allowed[w.code].name + '.', '', false);
    }
  }

  // 4. Category default. A category ID from another company is not in `categories` and is ignored.
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

  // 5. Fallback.
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

// --- Learned words: what past bills with similar descriptions were coded to -------------------
//
// From each company's own bills: for every word in a line's description, how many lines carried it
// and which account each was coded to. A new description is scored word by word (rarer words count
// more), so "diesel for the bakkie" leans on "diesel" and "bakkie" and ignores "for" and "the".
// Pure functions here; the backtest is Tests.gs testWordSuggestions.

const WORD_STOP = Object.freeze(['the', 'and', 'for', 'with', 'from', 'per', 'inv', 'invoice', 'ref', 'reference', 'qty', 'each',
  'incl', 'excl', 'vat', 'total', 'subtotal', 'amount', 'pty', 'ltd', 'item', 'items', 'without', 'zero', 'rated', 'exempt',
  'payment', 'paid', 'order', 'purchase', 'po', 'desk', 'account', 'monthly', 'month', 'date', 'no', 'nr', 'number',
  // Filler that says nothing about what was bought (HPB backtest: "used" pointed 100% to one account).
  'used', 'single', 'expense', 'cost', 'general', 'various', 'sundry', 'misc', 'miscellaneous', 'other', 'new']);

/** Distinct meaningful words of a description: lower case, 3+ letters, no numbers or stop words, light plural folding. */
function wordsOf_(text) {
  const out = [];
  String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').forEach(w => {
    if (w.length < 3 || /^\d+$/.test(w) || /\d/.test(w) && w.length < 5) return;
    const s = stemWord_(w);
    if (WORD_STOP.indexOf(s) === -1 && WORD_STOP.indexOf(w) === -1 && companyWords_().indexOf(s) === -1 && out.indexOf(s) === -1) out.push(s);
  });
  return out;
}

/** The three companies' own names say nothing about what was bought ("NHP Global" on half the bills). */
function companyWords_() {
  if (!companyWords_.cache) {
    const out = [];
    ENTITY_SEED.forEach(e => [e.entity_id, e.short_name, e.legal_name].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .forEach(w => { if (w.length >= 3) out.push(w, stemWord_(w)); }));
    companyWords_.cache = out;
  }
  return companyWords_.cache;
}

function stemWord_(w) {
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /[^su]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * lines: [{ desc, code }] -> { lines: N, w: { word: [linesWithWord, { code: count }] } }, keeping only
 * words seen on at least minLines lines (a word seen once can't be trusted, and it keeps the index small).
 */
function buildWordIndex_(lines, minLines) {
  const w = {};
  let n = 0;
  lines.forEach(l => {
    const code = String(l.code || '').trim();
    const words = wordsOf_(l.desc);
    if (!code || !words.length) return;
    n++;
    words.forEach(x => {
      const e = w[x] || (w[x] = [0, {}]);
      e[0]++;
      e[1][code] = (e[1][code] || 0) + 1;
    });
  });
  Object.keys(w).forEach(x => { if (w[x][0] < (minLines || 2)) delete w[x]; });
  return { lines: n, w: w };
}

/**
 * The account past lines with these words were coded to, if the evidence is strong enough:
 * { code, word, count, share } or null. allowed: code -> account (only those can be suggested).
 * opts: { minLines: lines that must back the winning word (default 2), minShare: the winner's share
 * of all the evidence (default 0.6) }.
 */
function wordSuggest_(index, description, allowed, opts) {
  opts = opts || {};
  const minLines = opts.minLines || 2;
  const minShare = opts.minShare === undefined ? 0.6 : opts.minShare;
  if (!index || !index.w) return null;
  const scores = {};
  const why = {};
  wordsOf_(description).forEach(x => {
    const e = index.w[x];
    if (!e) return;
    const idf = Math.log(1 + index.lines / e[0]);
    Object.keys(e[1]).forEach(code => {
      if (allowed && !allowed[code]) return;
      scores[code] = (scores[code] || 0) + idf * e[1][code] / e[0];
      if (!why[code] || e[1][code] > why[code].count) why[code] = { word: x, count: e[1][code] };
    });
  });
  const codes = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  if (!codes.length) return null;
  const total = codes.reduce((s, c) => s + scores[c], 0);
  const best = codes[0];
  const share = scores[best] / total;
  if (why[best].count < minLines || share < minShare) return null;
  return { code: best, word: why[best].word, count: why[best].count, share: Math.round(share * 100) / 100 };
}

// --- Learned words: storage ---------------------------------------------------------------------
// Built by the nightly sync (Sync.gs) into the WordIndex tab and the script cache. Read here on
// every suggestion: from the cache, else from the tab (then cached), else none (no tab yet).

const WORD_CACHE_S = 21600;

function wordIndexFor_(ent) {
  const props = PropertiesService.getScriptProperties();
  const version = props.getProperty('WORDVER_' + ent) || '0';
  const key = 'words:' + ent + ':' + version;
  const hit = cacheGetJson_(key);
  if (hit) return hit.lines ? hit : null;
  let index = { lines: 0, w: {} };
  try {
    index = wordIndexFromRows_(readTable('WordIndex').rows.filter(r => r.entity_id === ent));
  } catch (err) {
    console.warn('WordIndex not readable (' + err.message + '); learned words are off until setupSheets and a sync.');
  }
  cachePutJson_(key, index);
  return index.lines ? index : null;
}

/** Saves a freshly built index: Sheet rows for durability, a new cache version for speed. */
function storeWordIndex_(ent, index, now) {
  replaceEntityRows_('WordIndex', ent, wordIndexRows_(ent, index, now));
  const version = String(Date.now());
  cachePutJson_('words:' + ent + ':' + version, index);
  PropertiesService.getScriptProperties().setProperty('WORDVER_' + ent, version);
}

function wordIndexRows_(ent, index, now) {
  const rows = [{ entity_id: ent, word: '#lines', account_code: '', lines: index.lines, synced_at: now }];
  Object.keys(index.w).sort().forEach(x => Object.keys(index.w[x][1]).forEach(code =>
    rows.push({ entity_id: ent, word: x, account_code: code, lines: index.w[x][1][code], synced_at: now })));
  return rows;
}

function wordIndexFromRows_(rows) {
  const index = { lines: 0, w: {} };
  rows.forEach(r => {
    if (r.word === '#lines') { index.lines = Number(r.lines) || 0; return; }
    const e = index.w[r.word] || (index.w[r.word] = [0, {}]);
    e[1][String(r.account_code)] = Number(r.lines) || 0;
    e[0] += Number(r.lines) || 0;
  });
  return index;
}

// --- Learned words borrowed from other companies --------------------------------------------------

/**
 * Pure. Other companies' word indexes merged into one, keeping only evidence for accounts that this
 * company has with the same code AND the same name (so "433 Vehicle - Petrol and oil" carries over,
 * a 404 that means something else here does not). sources: [{ name, index, accounts }].
 * Returns { lines, w, from: [names] } or null.
 */
function mergeBorrowedWords_(sources, myAccounts) {
  const mine = {};
  (myAccounts || []).forEach(a => { if (a.status === 'ACTIVE' && a.code) mine[String(a.code)] = normAccountName_(a.name); });
  const out = { lines: 0, w: {}, from: [] };
  (sources || []).forEach(src => {
    if (!src.index || !src.index.lines) return;
    const theirs = {};
    (src.accounts || []).forEach(a => { if (a.status === 'ACTIVE' && a.code) theirs[String(a.code)] = normAccountName_(a.name); });
    out.lines += src.index.lines;
    out.from.push(src.name);
    Object.keys(src.index.w).forEach(word => {
      const e = src.index.w[word];
      const m = out.w[word] || (out.w[word] = [0, {}]);
      m[0] += e[0];   // every line with the word counts, so a rare word stays rare
      Object.keys(e[1]).forEach(code => { if (mine[code] && theirs[code] === mine[code]) m[1][code] = (m[1][code] || 0) + e[1][code]; });
    });
  });
  return out.lines ? out : null;
}

function normAccountName_(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The borrowed index for this company (Config WORD_BORROW_<company>), cached per sync version. Never throws. */
function borrowedWordIndex_(ent, accounts) {
  try {
    const from = String(getConfig('WORD_BORROW_' + ent, '') || '').split(/[,;\s]+/).map(s => s.trim().toUpperCase())
      .filter((e, i, a) => e && e !== ent && a.indexOf(e) === i && ENTITY_SEED.some(x => x.entity_id === e));
    if (!from.length) return null;
    const props = PropertiesService.getScriptProperties();
    const key = 'wordsb:' + ent + ':' + [ent].concat(from).map(e => e + (props.getProperty('WORDVER_' + e) || '0') + '.' + (props.getProperty('REFVER_' + e) || '0')).join('|');
    const hit = cacheGetJson_(key);
    if (hit) return hit.lines ? hit : null;
    const sources = from.map(e => ({ name: entityById_(e).short_name, index: wordIndexFor_(e), accounts: getRefData(e).accounts }));
    const merged = mergeBorrowedWords_(sources, (accounts || []).filter(a => a.entity_id === ent)) || { lines: 0, w: {}, from: [] };
    cachePutJson_(key, merged);
    return merged.lines ? merged : null;
  } catch (err) {
    console.warn('Borrowed words unavailable for ' + ent + ': ' + err.message);
    return null;
  }
}
