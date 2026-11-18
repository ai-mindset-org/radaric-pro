const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Generate a random secure password
const password = crypto.randomBytes(16).toString('base64').slice(0, 16);

// Create hash
const hash = bcrypt.hashSync(password, 10);

// Generate NextAuth secret
const secret = crypto.randomBytes(32).toString('base64');

console.log('\n🔐 Generated credentials for Radaric\n');
console.log('================================');
console.log('Username: admin');
console.log('Password:', password);
console.log('\n⚠️  SAVE THIS PASSWORD NOW! It will not be shown again.\n');
console.log('================================');
console.log('\nAdd this to your .env file:\n');
console.log(`NEXTAUTH_SECRET="${secret}"`);
console.log(`NEXTAUTH_URL="http://localhost:3000"`);
console.log('\nThen create the operator account (RAD-285 — AUTH_USER/AUTH_PASSWORD_HASH were removed):\n');
console.log(`node scripts/create-user.js admin '${password}' "Admin" --admin`);
console.log('\n================================\n');
