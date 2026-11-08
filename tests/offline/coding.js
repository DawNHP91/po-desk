// Runs Tests.gs testCoding() (the account-suggestion engine's fixed cases) in Node.
//   node tests/offline/coding.js apps-script
const fs = require('fs'), vm = require('vm');
const dir = process.argv[2]; const logs = [];
const ctx = { console: { log: m => logs.push(m), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m) }, Utilities: { newBlob: (s) => ({ getBytes: () => Buffer.from(String(s), 'utf8') }) } };
vm.createContext(ctx);
const src = ['Config', 'Db', 'Main', 'Auth', 'Approvals', 'Composio', 'Xero', 'Sync', 'Coding', 'Drive', 'Ocr', 'Setup', 'Tests'].map(f => fs.readFileSync(dir + '/' + f + '.gs', 'utf8')).join('\n');
vm.runInContext(src + '\ntestCoding();', ctx);
const out = logs.join('\n');
console.log(out.split('\n').filter(l => /^===|^FAIL/.test(l)).join('\n'));
process.exitCode = /all \d+ passed/.test(out) ? 0 : 1;
