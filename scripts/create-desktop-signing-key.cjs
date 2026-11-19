const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('Provide an absolute private key directory');
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const publicKeys = [];
for (const name of ['desktop-auth', 'desktop-update']) {
  const key = generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(destination, `${name}.pem`), key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  publicKeys.push(key.publicKey.export({ type: 'spki', format: 'pem' }).toString());
}
fs.writeFileSync(path.join(destination, 'relay-auth.key'), randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 });
const trust = path.join(__dirname, '..', 'security');
fs.mkdirSync(trust, { recursive: true });
fs.writeFileSync(path.join(trust, 'desktop-trust.json'), JSON.stringify({ publicKeys: [publicKeys[0]], updatePublicKeys: [publicKeys[1]] }, null, 2), { flag: 'wx' });
console.log('Created separate authorization/update keys. Only public keys enter the package.');
