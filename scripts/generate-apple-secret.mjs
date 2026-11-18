// Generates Apple client secret JWT for Sign In with Apple
// Usage: node scripts/generate-apple-secret.mjs
// Outputs the secret to stdout. Valid for 6 months.

import { SignJWT } from 'jose';
import { readFileSync } from 'fs';

const TEAM_ID = process.env.APPLE_TEAM_ID || '<your-team-id>';
const KEY_ID = process.env.APPLE_KEY_ID || '<your-key-id>';
const CLIENT_ID = process.env.APPLE_ID || 'com.radaric.web';

// Read private key from env or file
let privateKeyPem = process.env.APPLE_PRIVATE_KEY;
if (!privateKeyPem) {
  try {
    privateKeyPem = readFileSync(new URL('../apple-auth-key.p8', import.meta.url), 'utf-8');
  } catch {
    console.error('No APPLE_PRIVATE_KEY env var and no apple-auth-key.p8 file found');
    process.exit(1);
  }
}

// Import the key
const privateKey = await import('crypto').then(crypto =>
  crypto.createPrivateKey(privateKeyPem)
);

const now = Math.floor(Date.now() / 1000);
const secret = await new SignJWT({})
  .setAudience('https://appleid.apple.com')
  .setIssuer(TEAM_ID)
  .setSubject(CLIENT_ID)
  .setIssuedAt(now)
  .setExpirationTime(now + 86400 * 180) // 6 months
  .setProtectedHeader({ alg: 'ES256', kid: KEY_ID })
  .sign(privateKey);

console.log(secret);
