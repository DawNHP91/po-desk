/**
 * Coding.gs — suggests the chart-of-accounts code for a purchase, and learns from the buyer's choice.
 *
 * Order (CLAUDE.md): 1 supplier history → 2 keyword rules (admins' keywords, then keywords learned
 * from old bills) → 3 learned words (past bills with the same words; then words borrowed from other
 * companies, Config WORD_BORROW_<company>) → 4 category default → 5 fallback.
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

  // 2. Keyword rules (admins' and learned), scored by matched characters so "lab coat" beats "lab";
  // an admin's keyword beats a learned one of the same length.
  const desc = String(description || '').toLowerCase();
  if (desc) {
    const tokens = keywordTokens_(desc);
    const scored = categories.map(c => {
      const hits = categoryKeywords_(c).filter(x => keywordMatches_(tokens, x.k)).sort((a, b) => b.k.length - a.k.length || a.learned - b.learned);
      return { cat: c, hits: hits, score: hits.reduce((s, x) => s + x.k.length + (x.learned ? 0 : 0.5), 0) };
    }).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (Number(a.cat.sort) || 0) - (Number(b.cat.sort) || 0));
    for (let i = 0; i < scored.length; i++) {
      const code = String(scored[i].cat.account_code || '');
      if (allowed[code]) {
        const top = scored[i].hits[0];
        return result(code, 'keyword', '"' + top.k + '" matches ' + scored[i].cat.name + (top.learned ? ' (learned from old bills).' : '.'), scored[i].cat.tax_type, false);
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

/** Lower-case words with plurals folded ("MOPS" -> mop, "dishes" -> dish), split on anything else. */
function keywordTokens_(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? t.split(' ').map(stemWord_) : [];
}

/** One form for comparing keywords: "Mops" and "mop" are the same keyword. */
function keywordKey_(keyword) {
  return keywordTokens_(keyword).join(' ');
}

/**
 * Whole words / phrases only, so "shell" doesn't match "shellfish" and "tea" doesn't match "team";
 * plurals fold, so "mop" matches "MOPS". desc: text or keywordTokens_(text).
 */
function keywordMatches_(desc, keyword) {
  const d = Array.isArray(desc) ? desc : keywordTokens_(desc);
  const k = keywordTokens_(keyword);
  if (!k.length || k.length > d.length) return false;
  for (let i = 0; i + k.length <= d.length; i++) {
    let j = 0;
    while (j < k.length && d[i + j] === k[j]) j++;
    if (j === k.length) return true;
  }
  return false;
}

/** A category's keywords: the admins' first, then learned ones not removed by an admin. [{ k, learned }] */
function categoryKeywords_(c) {
  const own = splitKeywords_(c.keywords);
  const ownKeys = own.map(keywordKey_);
  const removed = splitKeywords_(c.removed_keywords).map(keywordKey_);
  const out = own.map(k => ({ k: k, learned: false }));
  splitKeywords_(c.learned_keywords).forEach(k => {
    const key = keywordKey_(k);
    if (ownKeys.indexOf(key) === -1 && removed.indexOf(key) === -1) out.push({ k: k, learned: true });
  });
  return out;
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

// --- Keywords: typed by admins, learned from old bills, ideas from AI (Stage 10) ----------------------
//
// Categories.keywords are the admins' (Keywords screen, or the Sheet). learned_keywords are rewritten
// by the nightly sync: a word becomes a keyword when at least LEARN_MIN_SHARE of at least LEARN_MIN_LINES
// old bill lines carrying it went to one category's account. removed_keywords are words an admin took
// off; learning never adds them back. A category name is the same category in every company that has
// it, so an admin's keyword goes to all of them unless they pick one company.

const KEYWORD_RULES = Object.freeze({
  MIN_LEN: 2, MAX_LEN: 40, MAX_PER_ADD: 20,
  LEARN_MIN_LINES: 3, LEARN_MIN_SHARE: 0.9, LEARN_MAX_PER_CATEGORY: 25,
  IDEAS_MAX: 15,
});

// Words on till slips that describe the pack, not what was bought ("JIK REG 750ML", "SUNLIGHT RGLR REFILL").
const LEARN_STOP = Object.freeze(['reg', 'rglr', 'regular', 'refill', 'large', 'lrg', 'small', 'sml', 'medium', 'med', 'pack', 'pck', 'pkt',
  'assorted', 'asst', 'original', 'orig', 'classic', 'plain', 'mini', 'maxi', 'value', 'bulk', 'free', 'promo', 'special', 'extra', 'family',
  'tub', 'btl', 'can', 'box', 'bag', 'roll', 'litre', 'liter', 'ltr', 'gram', 'kg', 'ml', 'unit', 'units', 'piece', 'pcs', 'set']);

/** A keyword as stored: lower case, single spaces. Throws a buyer-readable error when it can't be a keyword. */
function cleanKeyword_(raw) {
  const k = String(raw === null || raw === undefined ? '' : raw).toLowerCase().replace(/\s+/g, ' ').trim();
  if (k.length < KEYWORD_RULES.MIN_LEN) throw new AppError('BAD_REQUEST', 'A keyword needs at least ' + KEYWORD_RULES.MIN_LEN + ' letters.');
  if (k.length > KEYWORD_RULES.MAX_LEN) throw new AppError('BAD_REQUEST', 'Keep each keyword under ' + KEYWORD_RULES.MAX_LEN + ' characters.');
  if (!/^[a-z0-9][a-z0-9 &'\/.\-]*$/.test(k) || !/[a-z]/.test(k)) throw new AppError('BAD_REQUEST', '“' + k + '”: use letters, numbers and spaces only.');
  const tokens = keywordTokens_(k);
  if (!tokens.length || tokens.every(t => WORD_STOP.indexOf(t) !== -1)) throw new AppError('BAD_REQUEST', '“' + k + '” is too general to point to one category.');
  return k;
}

/**
 * Pure. Keywords learned from one company's old bill lines: { categoryId: [words] }. Only categories whose
 * account is an active purchase account here; a word an admin already uses anywhere in this company, or
 * removed from that category, is left out. borrowed: other companies' words (same code and name only).
 */
function learnKeywords_(categories, index, borrowed, allowed, opts) {
  opts = opts || {};
  const minLines = opts.minLines || KEYWORD_RULES.LEARN_MIN_LINES;
  const minShare = opts.minShare || KEYWORD_RULES.LEARN_MIN_SHARE;
  const max = opts.max || KEYWORD_RULES.LEARN_MAX_PER_CATEGORY;
  const byCode = {};
  categories.slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)).forEach(c => {
    const code = String(c.account_code || '');
    if (allowed[code] && !byCode[code]) byCode[code] = c;   // two categories on one account: the first one learns
  });
  const taken = {};
  const removed = {};
  categories.forEach(c => {
    splitKeywords_(c.keywords).forEach(k => { taken[keywordKey_(k)] = true; });
    splitKeywords_(c.removed_keywords).forEach(k => { removed[c.category_id + '|' + keywordKey_(k)] = true; });
  });
  const found = {};
  [index, borrowed].forEach(idx => {
    if (!idx || !idx.w) return;
    Object.keys(idx.w).forEach(word => {
      if (/\d/.test(word) || word.length < 3 || LEARN_STOP.indexOf(word) !== -1) return;
      const e = idx.w[word];
      let best = '';
      Object.keys(e[1]).forEach(code => { if (!best || e[1][code] > e[1][best]) best = code; });
      const n = best ? e[1][best] : 0;
      if (n < minLines || n / e[0] < minShare) return;
      const cat = byCode[best];
      const key = keywordKey_(word);
      if (!cat || taken[key] || removed[cat.category_id + '|' + key]) return;
      const f = found[cat.category_id] || (found[cat.category_id] = {});
      if (!(word in f)) f[word] = n;   // own words first; a borrowed duplicate doesn't add to them
    });
  });
  const out = {};
  Object.keys(found).forEach(id => {
    out[id] = Object.keys(found[id]).sort((a, b) => found[id][b] - found[id][a] || a.localeCompare(b)).slice(0, max);
  });
  return out;
}

/** Rewrites one company's learned keywords from its current word index. Run by the nightly sync. */
function relearnKeywords_(ent) {
  ent = entityById_(ent).entity_id;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    invalidateTable_('Categories');
    const table = readTable('Categories');
    if (!keywordColumnsReady_(table)) return { skipped: 'Categories has no learned_keywords column yet: run setupSheets()' };
    const ref = getRefData(ent);
    const cats = table.rows.filter(r => r.entity_id === ent);
    const learned = learnKeywords_(cats, wordIndexFor_(ent), borrowedWordIndex_(ent, ref.accounts), allowedFor_(ent, ref));
    let words = 0;
    let changed = 0;
    cats.forEach(c => {
      const list = learned[c.category_id] || [];
      words += list.length;
      if (String(c.learned_keywords || '') !== list.join(', ')) {
        updateRowById('Categories', 'category_id', c.category_id, { learned_keywords: list.join(', ') });
        changed++;
      }
    });
    return { categories: cats.length, learnedKeywords: words, categoriesChanged: changed };
  } finally {
    lock.releaseLock();
  }
}

/** Every company's learned keywords, after the sync has rebuilt all word indexes (PK borrows HPB's and NHP's). */
function relearnAllKeywords_() {
  const out = {};
  ENTITY_SEED.forEach(e => {
    try { out[e.entity_id] = relearnKeywords_(e.entity_id); } catch (err) { out[e.entity_id] = { error: err.message }; }
  });
  return out;
}

function keywordColumnsReady_(table) {
  return table.headers.indexOf('learned_keywords') !== -1 && table.headers.indexOf('removed_keywords') !== -1;
}

function allowedFor_(ent, ref) {
  return allowedAccounts_({ accounts: (ref || getRefData(ent)).accounts, config: { extraAccounts: getConfig('EXTRA_PURCHASE_ACCOUNTS_' + ent, '') } }, ent);
}

/**
 * Pure. How old bill lines with this keyword were coded, over several companies:
 * { word, lines, right, other: { label, lines } | null } or null when no old line has it. right = lines that
 * went to that company's category account. A phrase is judged by its rarest word that old bills know.
 * sources: [{ index, code, allowed }].
 */
function keywordEvidence_(keyword, sources) {
  const tokens = keywordTokens_(keyword);
  let word = '';
  let fewest = Infinity;
  tokens.forEach(t => {
    const n = sources.reduce((s, src) => s + (src.index && src.index.w && src.index.w[t] ? src.index.w[t][0] : 0), 0);
    if (n > 0 && n < fewest) { fewest = n; word = t; }
  });
  if (!word) return null;
  let lines = 0;
  let right = 0;
  const others = {};
  sources.forEach(src => {
    const e = src.index && src.index.w && src.index.w[word];
    if (!e) return;
    lines += e[0];
    Object.keys(e[1]).forEach(code => {
      if (code === String(src.code)) { right += e[1][code]; return; }
      const label = code + (src.allowed && src.allowed[code] ? ' ' + src.allowed[code].name : '');
      others[label] = (others[label] || 0) + e[1][code];
    });
  });
  const top = Object.keys(others).sort((a, b) => others[b] - others[a])[0];
  return { word: word, lines: lines, right: right, other: top ? { label: top, lines: others[top] } : null };
}

// --- Keywords screen (admins only) ---------------------------------------------------------------

/** Every category (grouped by name across companies) with its keywords and how old bills back them. */
function keywordsOverview_(onlyName) {
  const table = readTable('Categories');
  const ent = {};
  ENTITY_SEED.forEach(e => {
    const ref = getRefData(e.entity_id);
    ent[e.entity_id] = { name: e.short_name, allowed: allowedFor_(e.entity_id, ref), index: wordIndexFor_(e.entity_id) };
  });
  const groups = {};
  const order = [];
  table.rows.forEach(r => {
    if (!ent[r.entity_id] || !String(r.name || '').trim()) return;
    const key = String(r.name).trim().toLowerCase();
    if (onlyName && key !== String(onlyName).trim().toLowerCase()) return;
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(r);
  });
  const categories = order.map(key => {
    const rows = groups[key].sort((a, b) => ENTITY_SEED.findIndex(e => e.entity_id === a.entity_id) - ENTITY_SEED.findIndex(e => e.entity_id === b.entity_id));
    const merge = (field, filter) => {
      const out = [];
      rows.forEach(r => {
        const list = field === 'learned' ? categoryKeywords_(r).filter(x => x.learned).map(x => x.k) : splitKeywords_(r[field]);
        list.forEach(k => {
          const kk = keywordKey_(k);
          let m = out.find(x => x.key === kk);
          if (!m) { m = { key: kk, k: k, entityIds: [] }; out.push(m); }
          if (m.entityIds.indexOf(r.entity_id) === -1) m.entityIds.push(r.entity_id);
        });
      });
      return out.map(m => {
        const v = { k: m.k, entityIds: m.entityIds };
        if (filter) {
          const sources = rows.filter(r => m.entityIds.indexOf(r.entity_id) !== -1)
            .map(r => ({ index: ent[r.entity_id].index, code: String(r.account_code || ''), allowed: ent[r.entity_id].allowed }));
          v.evidence = keywordEvidence_(m.k, sources);
        }
        return v;
      });
    };
    return {
      name: String(rows[0].name).trim(),
      sort: Number(rows[0].sort) || 0,
      companies: rows.map(r => {
        const code = String(r.account_code || '');
        const acct = ent[r.entity_id].allowed[code];
        return { entityId: r.entity_id, company: ent[r.entity_id].name, categoryId: r.category_id, accountCode: code, accountName: acct ? acct.name : '', valid: !!acct, active: isTrue_(r.active) };
      }),
      keywords: merge('keywords', true),
      learned: merge('learned', true),
      removed: merge('removed_keywords', false),
    };
  }).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  return {
    columnsReady: keywordColumnsReady_(table),
    companies: ENTITY_SEED.map(e => ({ entityId: e.entity_id, name: e.short_name })),
    categories: categories,
  };
}

function actionListKeywords_(req, ctx) {
  requireAdmin_(ctx);
  return keywordsOverview_();
}

/** The category rows for a name (every company that has it), read fresh. */
function categoryRowsByName_(name) {
  const key = String(name || '').trim().toLowerCase();
  const rows = key ? readTable('Categories').rows.filter(r => String(r.name || '').trim().toLowerCase() === key && ENTITY_SEED.some(e => e.entity_id === r.entity_id)) : [];
  if (!rows.length) throw new AppError('NOT_FOUND', 'Category not found.');
  return rows;
}

/**
 * Adds or removes keywords of a category. payload: { name, op: 'add'|'remove', keyword, entityIds? }.
 * add: several may be sent separated by commas; they go to every company with this category (or only
 * entityIds), and stop being "removed" or "learned" there. remove: takes it off the admins' and the
 * learned list and remembers it, so learning never adds it back.
 */
function actionSaveKeyword_(req, ctx) {
  requireAdmin_(ctx);
  const p = req.payload;
  const op = String(p.op || '');
  if (op !== 'add' && op !== 'remove') throw new AppError('BAD_REQUEST', 'Unknown keyword change.');
  rateLimit_('keywords', ctx.user.user_id, 200, 3600);
  const parts = String(p.keyword || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
  if (!parts.length) throw new AppError('BAD_REQUEST', 'Type a keyword.');
  if (parts.length > KEYWORD_RULES.MAX_PER_ADD) throw new AppError('BAD_REQUEST', 'Add at most ' + KEYWORD_RULES.MAX_PER_ADD + ' keywords at a time.');
  // Removing never validates: a word typed into the Sheet by hand must still be removable.
  const words = [];
  parts.map(op === 'add' ? cleanKeyword_ : (x => x.toLowerCase().replace(/\s+/g, ' ').trim())).forEach(w => { if (!words.some(x => keywordKey_(x) === keywordKey_(w))) words.push(w); });
  const keys = words.map(keywordKey_);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Please try again.');
  let name;
  let targets;
  try {
    invalidateTable_('Categories');
    const table = readTable('Categories');
    if (!keywordColumnsReady_(table)) throw new AppError('SETUP_ORDER', 'The Categories tab needs two new columns. Run setupSheets() once in the Apps Script editor.');
    const rows = categoryRowsByName_(p.name);
    name = String(rows[0].name).trim();
    const want = Array.isArray(p.entityIds) && p.entityIds.length ? p.entityIds.map(x => String(x).toUpperCase()) : null;
    targets = want ? rows.filter(r => want.indexOf(r.entity_id) !== -1) : rows;
    if (!targets.length) throw new AppError('BAD_REQUEST', 'That company doesn’t have this category.');
    const drop = (list) => splitKeywords_(list).filter(k => keys.indexOf(keywordKey_(k)) === -1);
    const add = (list) => { const l = splitKeywords_(list); words.forEach((w, i) => { if (!l.some(k => keywordKey_(k) === keys[i])) l.push(w); }); return l; };

    if (op === 'add') {
      // The same word on two categories of one company would make the suggestion a coin toss.
      targets.forEach(r => table.rows.forEach(o => {
        if (o.entity_id !== r.entity_id || o.category_id === r.category_id) return;
        const clash = splitKeywords_(o.keywords).find(k => keys.indexOf(keywordKey_(k)) !== -1);
        if (clash) throw new AppError('KEYWORD_TAKEN', '“' + clash + '” is already a keyword of ' + o.name + ' in ' + entityById_(o.entity_id).short_name + '. Remove it there first.');
      }));
      targets.forEach(r => {
        updateRowById('Categories', 'category_id', r.category_id, { keywords: add(r.keywords).join(', '), learned_keywords: drop(r.learned_keywords).join(', '), removed_keywords: drop(r.removed_keywords).join(', ') });
        // Learned elsewhere in this company: the admin's choice wins at once (the nightly relearn agrees).
        table.rows.filter(o => o.entity_id === r.entity_id && o.category_id !== r.category_id && splitKeywords_(o.learned_keywords).some(k => keys.indexOf(keywordKey_(k)) !== -1))
          .forEach(o => updateRowById('Categories', 'category_id', o.category_id, { learned_keywords: drop(o.learned_keywords).join(', ') }));
      });
    } else {
      targets.forEach(r => updateRowById('Categories', 'category_id', r.category_id, { keywords: drop(r.keywords).join(', '), learned_keywords: drop(r.learned_keywords).join(', '), removed_keywords: add(r.removed_keywords).join(', ') }));
    }
  } finally {
    lock.releaseLock();
  }
  auditLog({ userId: ctx.user.user_id, action: 'keywords.' + op, ref: name, ok: true, detail: { keywords: words, companies: targets.map(r => r.entity_id) } });
  return { category: keywordsOverview_(name).categories[0] };
}

/** Switches one company's category on or off. On needs an active purchase account in that company's chart. */
function actionSetCategoryActive_(req, ctx) {
  requireAdmin_(ctx);
  const id = str_(req.payload.categoryId, 60);
  const on = req.payload.active === true;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Please try again.');
  let row;
  try {
    invalidateTable_('Categories');
    row = readTable('Categories').rows.find(r => String(r.category_id) === id && ENTITY_SEED.some(e => e.entity_id === r.entity_id));
    if (!row) throw new AppError('NOT_FOUND', 'Category not found.');
    if (on) {
      const code = String(row.account_code || '');
      if (!allowedFor_(row.entity_id)[code]) {
        throw new AppError('NO_ACCOUNT', 'Account ' + (code || '(none)') + ' isn’t an active purchase account in ' + entityById_(row.entity_id).short_name + '. Fix account_code in the Categories tab first.');
      }
    }
    updateRowById('Categories', 'category_id', id, { active: on });
  } finally {
    lock.releaseLock();
  }
  auditLog({ userId: ctx.user.user_id, entityId: row.entity_id, action: on ? 'category.on' : 'category.off', ref: String(row.name), ok: true, detail: { categoryId: id, accountCode: String(row.account_code || '') } });
  return { category: keywordsOverview_(row.name).categories[0] };
}

/**
 * What PO Desk would suggest for a description in one company (no supplier, no category), and which
 * switched-off categories' keywords match it, so an admin sees what switching on would change.
 */
function actionTestKeywords_(req, ctx) {
  requireAdmin_(ctx);
  const ent = entityById_(req.payload.entityId).entity_id;
  const desc = str_(req.payload.description, PO_RULES.MAX_DESCRIPTION);
  if (!desc.trim()) throw new AppError('BAD_REQUEST', 'Type what is being bought.');
  const data = codingData_(ent);
  const s = suggestAccountWith_(data, ent, null, null, desc);
  const tokens = keywordTokens_(desc);
  const off = data.categories.filter(c => !isTrue_(c.active)).map(c => {
    const hit = categoryKeywords_(c).filter(x => keywordMatches_(tokens, x.k)).sort((a, b) => b.k.length - a.k.length)[0];
    return hit ? { name: String(c.name), keyword: hit.k } : null;
  }).filter(Boolean);
  return { accountCode: s.accountCode, accountName: s.accountName, source: s.source, reason: s.reason, needsReview: s.needsReview, switchedOff: off };
}

const IDEAS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      items: { type: 'object', properties: { keyword: { type: 'string' }, why: { type: 'string' } }, required: ['keyword', 'why'] },
    },
  },
  required: ['ideas'],
});

/**
 * Keyword ideas from Gemini for one category, each checked against old bills and the other categories.
 * Nothing is saved: the admin adds the good ones. payload: { name }.
 */
function actionKeywordIdeas_(req, ctx) {
  requireAdmin_(ctx);
  const rows = categoryRowsByName_(req.payload.name);
  rateLimit_('ideas', ctx.user.user_id, 30, 3600);
  const name = String(rows[0].name).trim();
  const key = name.toLowerCase();
  const all = readTable('Categories').rows.filter(r => ENTITY_SEED.some(e => e.entity_id === r.entity_id));
  const allowed = {};
  rows.forEach(r => { allowed[r.entity_id] = allowedFor_(r.entity_id); });
  const accts = uniq_(rows.map(r => { const a = allowed[r.entity_id][String(r.account_code)]; return String(r.account_code || '') + (a ? ' ' + a.name : ''); }).filter(Boolean));
  const mine = {};
  rows.forEach(r => categoryKeywords_(r).forEach(x => { mine[keywordKey_(x.k)] = x.k; }));
  const others = {};
  all.forEach(r => {
    const n = String(r.name || '').trim();
    if (!n || n.toLowerCase() === key) return;
    const o = others[n.toLowerCase()] || (others[n.toLowerCase()] = { name: n, kw: {} });
    splitKeywords_(r.keywords).forEach(k => { o.kw[keywordKey_(k)] = k; });
  });

  const prompt = [
    'PO Desk codes purchases by three South African companies (HP Biotech, NHP Global and Pharma Karu) to their charts of accounts.',
    'Purchases are described by staff ("bleach for the factory floor") or printed on till slips in short capitals ("JIK REG 750ML", "HANDY ANDY CRM").',
    'Suggest up to ' + KEYWORD_RULES.IDEAS_MAX + ' extra keywords for the category "' + name + '" (account ' + accts.join(' / ') + ').',
    'Good keywords clearly mean this category on their own: product words, South African brand names and the abbreviations South African till slips use.',
    'Avoid: words that could equally mean another category, pack or size words (refill, large, 750ml, pack), store names, and anything already listed.',
    'Already keywords of this category: ' + (Object.keys(mine).map(k => mine[k]).join(', ') || '(none)') + '.',
    'Other categories (do not suggest their words): ' + Object.keys(others).map(k => others[k].name + ' (' + Object.keys(others[k].kw).slice(0, 8).map(x => others[k].kw[x]).join(', ') + ')').join('; ') + '.',
    'Return each keyword in lower case (one to three words) with a short reason of at most eight words.',
  ].join('\n');
  const r = geminiJson_(prompt, IDEAS_SCHEMA, { userId: ctx.user.user_id, ref: 'keyword-ideas:' + name });
  if (!r.ok) throw new AppError('AI_UNAVAILABLE', r.message);

  const ent = {};
  rows.forEach(rw => { ent[rw.entity_id] = wordIndexFor_(rw.entity_id); });
  const sources = rows.map(rw => ({ index: ent[rw.entity_id], code: String(rw.account_code || ''), allowed: allowed[rw.entity_id] }));
  const seen = {};
  const ideas = [];
  ((r.data && r.data.ideas) || []).forEach(x => {
    let k;
    try { k = cleanKeyword_(x && x.keyword); } catch (err) { return; }
    const kk = keywordKey_(k);
    if (mine[kk] || seen[kk]) return;
    seen[kk] = true;
    const clash = Object.keys(others).find(o => others[o].kw[kk]);
    ideas.push({ k: k, why: truncate_(String((x && x.why) || ''), 80), takenBy: clash ? others[clash].name : '', evidence: keywordEvidence_(k, sources) });
  });
  return { name: name, ideas: ideas.slice(0, KEYWORD_RULES.IDEAS_MAX) };
}

/** Editor: relearn every company's keywords from the word indexes now (the nightly sync does it at 02:00). */
function learnKeywordsNow() {
  const r = relearnAllKeywords_();
  console.log('learnKeywordsNow ' + JSON.stringify(r, null, 2));
  return r;
}
