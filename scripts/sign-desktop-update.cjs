const fs = require('node:fs');
const { createHash, createPrivateKey, sign } = require('node:crypto');
const [installer, keyPath, destination] = process.argv.slice(2);
if (!installer || !keyPath || !destination) throw new Error('Usage: installer key-file output-json');
const bytes = fs.readFileSync(installer);
const payload = Buffer.from(JSON.stringify({ audience: 'lalor-workbench-update',
  version: require('../package.json').version, size: bytes.length,
  sha512: createHash('sha512').update(bytes).digest('base64') })).toString('base64url');
const signature = sign(null, Buffer.from('LALOR-DESKTOP-UPDATE-V1\n' + payload), createPrivateKey(fs.readFileSync(keyPath))).toString('base64url');
fs.writeFileSync(destination, JSON.stringify({ payload, signature }), { flag: 'wx' });
console.log('Signed installer digest (independent of Windows Authenticode).');
