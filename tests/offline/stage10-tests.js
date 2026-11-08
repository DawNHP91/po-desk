// ===================== Stage 10: categories and keywords =====================
{
const atok10 = createSession_(admin.user_id);
const ec10 = (r) => (r && r.error ? r.error.code : 'OK');
const cat10 = (id) => MEM.Categories.find(c => c.category_id === id);
MEM.Accounts.push({ entity_id: 'PK', account_id: 'PK404', code: '404', name: 'Cleaning', type: 'EXPENSE', class: 'EXPENSE', tax_type: 'INPUT3', status: 'ACTIVE' });
invalidateRefCache('PK');
MEM.Categories.push(
  { category_id: 'cat10-hpb-clean', entity_id: 'HPB', name: 'Cleaning', account_code: '404', tax_type: 'INPUT3', keywords: 'bleach', sort: 70, active: false },
  { category_id: 'cat10-pk-clean', entity_id: 'PK', name: 'cleaning', account_code: '404', tax_type: 'INPUT3', keywords: '', sort: 70, active: false },
  { category_id: 'cat10-nhp-fuel', entity_id: 'NHP', name: 'Fuel', account_code: '433', tax_type: 'INPUT3', keywords: 'diesel, petrol', sort: 10, active: false });
cat10('cat-s9-clean').active = false;   // as in production: off until an admin switches it on

// who may use the screen
check('Keywords screen: a buyer is refused (list, add, switch on, test, AI ideas)', ['listKeywords', 'saveKeyword', 'setCategoryActive', 'testKeywords', 'keywordIdeas'].every(a => ec10(call(a, { name: 'Cleaning', op: 'add', keyword: 'x', categoryId: 'cat-s9-clean', active: true, entityId: 'NHP', description: 'x' })) === 'FORBIDDEN'), '');

// the overview groups a category by name over the companies that have it
const lk10 = call('listKeywords', {}, atok10);
const clean10 = lk10.ok && lk10.data.categories.find(c => c.name === 'Cleaning');
check('listKeywords: Cleaning in HPB, NHP and PK (name case ignored) with each account, on/off, and whether the account is valid there',
  !!clean10 && clean10.companies.map(c => c.entityId + ':' + c.accountCode + ':' + c.valid + ':' + c.active).join() === 'HPB:404:false:false,NHP:404:true:false,PK:404:true:false' &&
  clean10.companies[1].accountName === 'Cleaning' && clean10.keywords.length === 1 && clean10.keywords[0].k === 'bleach' && clean10.keywords[0].entityIds.join() === 'HPB,NHP' && lk10.data.columnsReady === true,
  JSON.stringify(clean10).slice(0, 400));

// adding keywords: all companies by default, several at once, plurals and case folded
const add10 = call('saveKeyword', { name: 'Cleaning', op: 'add', keyword: 'Dish Washing Liquid, Mops, mop' }, atok10);
check('add "Dish Washing Liquid, Mops, mop": stored lower case in all three companies, "mop" not twice',
  add10.ok && ['cat10-hpb-clean', 'cat-s9-clean', 'cat10-pk-clean'].every(id => /dish washing liquid/.test(cat10(id).keywords) && (cat10(id).keywords.match(/\\bmops?\\b/g) || []).length === 1) &&
  add10.data.category.keywords.find(k => k.k === 'dish washing liquid').entityIds.join() === 'HPB,NHP,PK', JSON.stringify(['cat10-hpb-clean', 'cat-s9-clean', 'cat10-pk-clean'].map(id => cat10(id).keywords)) + JSON.stringify(add10.data.category.keywords));
const one10 = call('saveKeyword', { name: 'Cleaning', op: 'add', keyword: 'sta-soft', entityIds: ['PK'] }, atok10);
check('add to one company only: PK has "sta-soft", NHP doesn’t', one10.ok && /sta-soft/.test(cat10('cat10-pk-clean').keywords) && !/sta-soft/.test(cat10('cat-s9-clean').keywords), JSON.stringify(one10).slice(0, 200));
const clash10 = call('saveKeyword', { name: 'Cleaning', op: 'add', keyword: 'Diesel' }, atok10);
check('a keyword another category already has in that company is refused, naming it', ec10(clash10) === 'KEYWORD_TAKEN' && /Fuel in NHP Global/.test(clash10.error.message) && !/diesel/.test(cat10('cat-s9-clean').keywords), JSON.stringify(clash10));
check('nonsense is refused with a clear message', ec10(call('saveKeyword', { name: 'Cleaning', op: 'add', keyword: 'the' }, atok10)) === 'BAD_REQUEST' && ec10(call('saveKeyword', { name: 'Nope', op: 'add', keyword: 'jik' }, atok10)) === 'NOT_FOUND', '');

// test box, and switching on
const t10a = call('testKeywords', { entityId: 'NHP', description: 'DISH WASHING LIQUID 750ML' }, atok10);
check('test while Cleaning is off: no keyword suggestion, but it says switching Cleaning on would catch it', t10a.ok && t10a.data.source !== 'keyword' && t10a.data.switchedOff.some(x => x.name === 'Cleaning' && x.keyword === 'dish washing liquid'), JSON.stringify(t10a));
const on10 = call('setCategoryActive', { categoryId: 'cat-s9-clean', active: true }, atok10);
const t10b = call('testKeywords', { entityId: 'NHP', description: 'MOPS X2' }, atok10);
check('switch NHP Cleaning on: saved; "MOPS X2" now -> 404 by keyword', on10.ok && cat10('cat-s9-clean').active === true && on10.data.category.companies.find(c => c.entityId === 'NHP').active === true && t10b.data.source === 'keyword' && t10b.data.accountCode === '404', JSON.stringify(t10b));
const hpbOn10 = call('setCategoryActive', { categoryId: 'cat10-hpb-clean', active: true }, atok10);
check('switching on where the account isn’t in that company’s chart is refused; stays off', ec10(hpbOn10) === 'NO_ACCOUNT' && /HP Biotech/.test(hpbOn10.error.message) && cat10('cat10-hpb-clean').active === false, JSON.stringify(hpbOn10));
check('switching off always works', call('setCategoryActive', { categoryId: 'cat10-hpb-clean', active: false }, atok10).ok, '');

// learned keywords from old bills (the nightly sync's step), removed by an admin, added back by hand
MEM.WordIndex = [{ entity_id: 'NHP', word: '#lines', account_code: '', lines: 30 },
  { entity_id: 'NHP', word: 'sunlight', account_code: '404', lines: 4 }, { entity_id: 'NHP', word: 'liquid', account_code: '404', lines: 3 }, { entity_id: 'NHP', word: 'liquid', account_code: '426', lines: 3 }];
props.set('WORDVER_NHP', 'v10');
const rl10 = relearnKeywords_('NHP');
check('relearn: "sunlight" (4 of 4 old lines to 404) becomes a learned keyword of Cleaning; "liquid" (3 of 6) doesn’t', /^sunlight$/.test(cat10('cat-s9-clean').learned_keywords) && rl10.learnedKeywords === 1, JSON.stringify(rl10) + ' ' + cat10('cat-s9-clean').learned_keywords);
const t10c = call('testKeywords', { entityId: 'NHP', description: 'SUNLIGHT LIQUID 750ML' }, atok10);
check('…and the engine uses it, saying it was learned', t10c.data.source === 'keyword' && t10c.data.accountCode === '404' && /learned from old bills/.test(t10c.data.reason), JSON.stringify(t10c));
const lk10b = call('listKeywords', {}, atok10).data.categories.find(c => c.name === 'Cleaning');
check('the screen shows it under learned, with the old bills behind it (4 lines, all to Cleaning)', lk10b.learned.length === 1 && lk10b.learned[0].k === 'sunlight' && lk10b.learned[0].evidence.lines === 4 && lk10b.learned[0].evidence.right === 4, JSON.stringify(lk10b.learned));
const rm10 = call('saveKeyword', { name: 'Cleaning', op: 'remove', keyword: 'sunlight', entityIds: ['NHP'] }, atok10);
relearnKeywords_('NHP');
check('an admin removes the learned word: gone, remembered as removed, and the next relearn doesn’t bring it back', rm10.ok && !cat10('cat-s9-clean').learned_keywords && /sunlight/.test(cat10('cat-s9-clean').removed_keywords) && rm10.data.category.removed.some(x => x.k === 'sunlight') && call('testKeywords', { entityId: 'NHP', description: 'SUNLIGHT' }, atok10).data.source !== 'keyword', JSON.stringify(cat10('cat-s9-clean')));
call('saveKeyword', { name: 'Cleaning', op: 'add', keyword: 'Sunlight', entityIds: ['NHP'] }, atok10);
check('typing it back as a keyword clears "removed"', /sunlight/.test(cat10('cat-s9-clean').keywords) && !/sunlight/.test(cat10('cat-s9-clean').removed_keywords || ''), JSON.stringify(cat10('cat-s9-clean')));
call('saveKeyword', { name: 'Cleaning', op: 'remove', keyword: 'mops' }, atok10);
check('removing an admin’s keyword takes it off every company that had it', ['cat10-hpb-clean', 'cat-s9-clean', 'cat10-pk-clean'].every(id => !/\\bmop\\b/.test(cat10(id).keywords)), JSON.stringify(['cat10-hpb-clean', 'cat-s9-clean', 'cat10-pk-clean'].map(id => cat10(id).keywords)));

// AI ideas
const g10 = geminiCalls().length;
setGemini('ok', { ideas: [{ keyword: 'Domestos', why: 'Bleach brand' }, { keyword: 'bleach', why: 'already there' }, { keyword: 'Petrol', why: 'clash' }, { keyword: '<x>', why: 'bad' }, { keyword: 'Handy Andy', why: 'Cleaner brand sold in SA' }] });
const id10 = call('keywordIdeas', { name: 'Cleaning' }, atok10);
const req10 = geminiCalls()[g10] && geminiCalls()[g10].body;
check('AI ideas: new ones listed (domestos, handy andy), a clash flagged with its category, existing and invalid ones dropped; nothing saved',
  id10.ok && id10.data.ideas.map(i => i.k + '/' + i.takenBy).join() === 'domestos/,petrol/Fuel,handy andy/' && !/domestos/.test(cat10('cat-s9-clean').keywords), JSON.stringify(id10).slice(0, 300));
check('AI ideas request: text only (no image), JSON schema, names the category and its keywords', !!req10 && req10.contents[0].parts.length === 1 && !req10.contents[0].parts[0].inlineData && req10.generationConfig.responseJsonSchema.required[0] === 'ideas' && /"Cleaning"/.test(req10.contents[0].parts[0].text) && /dish washing liquid/.test(req10.contents[0].parts[0].text), JSON.stringify(req10).slice(0, 300));
setGemini('429');
const busy10 = call('keywordIdeas', { name: 'Cleaning' }, atok10);
setGemini('ok', ANSWER);
check('AI busy (429): a clear message, nothing breaks', ec10(busy10) === 'AI_UNAVAILABLE' && /busy/.test(busy10.error.message), JSON.stringify(busy10));
check('every change is in the audit log', ['keywords.add', 'keywords.remove', 'category.on', 'category.off'].every(a => MEM.AuditLog.some(x => x.action === a && x.ok)), '');
}
