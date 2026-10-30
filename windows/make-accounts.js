#!/usr/bin/env node
// Writes the deck's account list from Claude sign-in emails:
//   node make-accounts.js <accounts.js> email[,email...]
// Each email gets its own Claude folder (~/.claude-<name>), named after the
// part before the @, and a panel colour.
const fs = require('fs');
const [file, list] = process.argv.slice(2);
const COLORS = ['245;153;91', '94;202;221', '154;201;87', '214;128;214', '235;203;98', '120;160;240', '240;120;120', '160;220;180', '200;170;120', '180;180;180'];
const emails = String(list || '').split(/[\s,;]+/).map(e => e.trim()).filter(Boolean);
if (!file || !emails.length) { console.error('Usage: make-accounts.js <accounts.js> email[,email...]'); process.exit(1); }
if (emails.length > 10) { console.error('At most 10 accounts.'); process.exit(1); }
const taken = new Set();
const accounts = emails.map((email, i) => {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Not an email address: ' + email); process.exit(1); }
  const [local, domain] = email.toLowerCase().split('@');
  let slug = local.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
  // Two emails with the same name before the @ keep apart by their domain.
  if (taken.has(slug)) slug += '-' + domain.split('.')[0].replace(/[^a-z0-9]+/g, '');
  while (taken.has(slug)) slug += '-' + (i + 1);
  taken.add(slug);
  const name = slug[0].toUpperCase() + slug.slice(1);
  return { name, provider: 'claude', slot: name, email: email.toLowerCase(), color: COLORS[i], home: '~/.claude-' + slug };
});
fs.writeFileSync(file, 'module.exports=' + JSON.stringify(accounts, null, 2) + ';\n', { mode: 0o600 });
console.log(accounts.map(a => a.name + ' <' + a.email + '>').join('\n'));
