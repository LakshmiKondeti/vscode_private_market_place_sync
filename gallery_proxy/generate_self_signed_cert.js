/**
 * generate-selfsigned-cert.js
 *
 * Quick, no-OpenSSL way to generate a self-signed key.pem + cert.pem for
 * the gallery proxy — useful for a demo where you don't have time to go
 * through the org CA / CSR-signing process. Uses node-forge (pure JS,
 * no system OpenSSL, no openssl.cnf needed).
 *
 * For anything beyond a one-off demo, switch to the CSR + org-CA flow
 * (generate-csr.js) instead, so machines don't need a manual trust-import
 * step (see below).
 *
 * Usage:
 *   npm install node-forge
 *   node generate-selfsigned-cert.js
 *
 * Produces in the current folder:
 *   key.pem
 *   cert.pem
 *
 * After generating, trust it once on the demo machine (needs admin,
 * one-time, only for THIS machine):
 *   Import-Certificate -FilePath .\cert.pem -CertStoreLocation Cert:\LocalMachine\Root
 */

const forge = require('node-forge');
const fs = require('fs');

console.log('Generating 2048-bit RSA key pair (a few seconds)...');
const keys = forge.pki.rsa.generateKeyPair(2048);

const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

const attrs = [{ name: 'commonName', value: 'localhost' }];
cert.setSubject(attrs);
cert.setIssuer(attrs); // self-signed: issuer == subject

cert.setExtensions([
  { name: 'basicConstraints', cA: false },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
  { name: 'extKeyUsage', serverAuth: true },
  {
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: 'localhost' },  // DNS
      { type: 7, ip: '127.0.0.1' }       // IP — required, VS Code's
                                          // Electron networking layer
                                          // rejects certs without it
    ]
  }
]);

// Self-sign with its own private key
cert.sign(keys.privateKey, forge.md.sha256.create());

const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
const certPem = forge.pki.certificateToPem(cert);

fs.writeFileSync('key.pem', keyPem);
fs.writeFileSync('cert.pem', certPem);

console.log('\nDone. Created in the current folder:');
console.log('  key.pem');
console.log('  cert.pem');
console.log('\nTo trust it on THIS machine for the demo (one-time, needs admin PowerShell):');
console.log('  Import-Certificate -FilePath .\\cert.pem -CertStoreLocation Cert:\\LocalMachine\\Root');
console.log('\nWithout that import step, VS Code will show ERR_CERT_AUTHORITY_INVALID.');
console.log('For a real multi-machine rollout, use generate-csr.js + your org CA instead,');
console.log('so machines trust it automatically with no per-machine import step.');
