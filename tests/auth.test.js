// tests/auth.test.js
// Unit tests for authentication, tokens, validation, rate limits, and key encryption (CONTRACT v3, A8)
// No database connection required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  tokenClaims,
  validateUsername,
  validatePassword,
  generateTempPassword,
  ipLimiter,
  userLimiter,
  invalidateUserCache,
  requireAuth,
  __setUserGetter,
} from '../server/auth.js';
import {
  encryptKey,
  decryptKey,
  deriveKey,
  hasValidKeysSecret,
} from '../server/crypto_keys.js';

test('auth: hashPassword & verifyPassword roundtrip', async () => {
  const pwd = 'TestPassword123!';
  const hash = await hashPassword(pwd);
  assert.ok(hash.includes(':'), 'Hash format must be salt:hex');

  const valid = await verifyPassword(pwd, hash);
  assert.equal(valid, true, 'Correct password must verify');

  const invalid = await verifyPassword('WrongPassword', hash);
  assert.equal(invalid, false, 'Wrong password must be rejected');

  const malformed = await verifyPassword(pwd, 'invalid-hash-string');
  assert.equal(malformed, false, 'Malformed hash must return false');
});

test('auth: validateUsername & validatePassword rules', () => {
  // Username rules: 3..32 chars, [a-zA-Z0-9_.-]
  assert.equal(Boolean(validateUsername('admin')), true);
  assert.equal(Boolean(validateUsername('user-1_test.name')), true);
  assert.equal(Boolean(validateUsername('ab')), false, 'Too short');
  assert.equal(Boolean(validateUsername('a'.repeat(33))), false, 'Too long');
  assert.equal(Boolean(validateUsername('user name')), false, 'Spaces not allowed');
  assert.equal(Boolean(validateUsername('user@domain')), false, 'Invalid chars');
  assert.equal(Boolean(validateUsername(null)), false);

  // Password rules: min 8 chars
  assert.equal(validatePassword('12345678'), true);
  assert.equal(validatePassword('short'), false, 'Under 8 chars');
  assert.equal(validatePassword(''), false);
  assert.equal(validatePassword(null), false);
});

test('auth: generateTempPassword alphabet & length', () => {
  const ambiguous = new Set(['0', 'O', 'o', 'l', '1', 'I']);
  const generated = new Set();

  for (let i = 0; i < 50; i++) {
    const pwd = generateTempPassword();
    assert.equal(pwd.length, 12, 'Password length must be exactly 12');
    for (const char of pwd) {
      assert.ok(!ambiguous.has(char), `Ambiguous character '${char}' found in password`);
    }
    generated.add(pwd);
  }
  assert.equal(generated.size, 50, 'Generated passwords must be unique');
});

test('auth: issueToken, verifyToken & tokenClaims', async () => {
  const mockUser = {
    id: 42,
    username: 'testuser',
    role: 'user',
    disabled: 0,
    ai_mode: 'shared',
    must_change_password: 0,
    token_version: 1,
  };
  __setUserGetter(async (id) => (id === 42 ? mockUser : null));

  const token = issueToken({ id: mockUser.id, role: mockUser.role }, mockUser.token_version);
  assert.ok(token.startsWith('v2.'), 'Token must start with v2.');

  const isValid = verifyToken(token);
  assert.equal(isValid, true, 'Valid token must be verified');

  const claims = tokenClaims(token);
  assert.ok(claims, 'Claims must be extracted');
  assert.equal(claims.userId, 42);
  assert.equal(claims.tokenVersion, 1);
});

test('auth: token tampering detection', () => {
  const token = issueToken(Date.now(), 42, 1);
  const parts = token.split('.');

  // Tamper with userId part
  parts[3] = '999';
  const tamperedUser = parts.join('.');
  assert.equal(verifyToken(tamperedUser), false, 'Tampered user id must fail signature check');

  // Tamper with signature
  parts[3] = '42';
  parts[5] = parts[5].slice(0, -1) + (parts[5].endsWith('a') ? 'b' : 'a');
  assert.equal(verifyToken(parts.join('.')), false, 'Tampered HMAC must fail verification');

  // Expired token
  const expired = issueToken(Date.now() - 31 * 24 * 60 * 60 * 1000, 42, 1);
  assert.equal(verifyToken(expired), false, 'Expired token must fail verification');
});

test('auth: token version mismatch with requireAuth', async () => {
  let currentVersion = 1;
  const mockUser = {
    id: 10,
    username: 'alice',
    role: 'user',
    disabled: 0,
    must_change_password: 0,
    ai_mode: 'shared',
    get token_version() {
      return currentVersion;
    },
  };
  __setUserGetter(async (id) => (id === 10 ? mockUser : null));

  const token = issueToken(Date.now(), 10, 1);
  assert.equal(verifyToken(token), true);

  // Simulate middleware with valid version
  let errCalled = null;
  const req1 = { cookies: { gt_session: token } };
  await requireAuth(req1, {}, (err) => {
    errCalled = err;
  });
  assert.equal(errCalled, undefined);
  assert.equal(req1.user.id, 10);

  // Bump version (e.g. after password change)
  currentVersion = 2;
  invalidateUserCache(10);

  // Old token with version 1 must now be rejected by requireAuth
  let rejectErr = null;
  const req2 = { cookies: { gt_session: token } };
  await requireAuth(req2, {}, (err) => {
    rejectErr = err;
  });
  assert.ok(rejectErr, 'Must fail when token version mismatches');
  assert.equal(rejectErr.status, 401);
});

test('auth: in-process rate limiters', () => {
  const ip = '192.168.1.100';
  const username = 'target_user';

  ipLimiter.reset();
  userLimiter.reset();

  // Test IP limiter (limit: 20 per 15 min)
  for (let i = 0; i < 20; i++) {
    assert.equal(ipLimiter.check(ip), true, `Attempt ${i + 1} should be allowed`);
  }
  assert.equal(ipLimiter.check(ip), false, '21st attempt must be blocked');

  // Test user limiter (limit: 8 per 15 min)
  for (let i = 0; i < 8; i++) {
    assert.equal(userLimiter.check(username), true, `User attempt ${i + 1} should be allowed`);
  }
  assert.equal(userLimiter.check(username), false, '9th attempt for user must be blocked');

  // Different user is not blocked
  assert.equal(userLimiter.check('other_user'), true);
});

test('crypto_keys: AES-256-GCM encryption round trip and tamper detection', () => {
  const testSecret = '0123456789abcdef0123456789abcdef'; // 32 chars
  assert.equal(hasValidKeysSecret(testSecret), true);
  assert.equal(hasValidKeysSecret('short_secret'), false);

  const plainKey = 'gsk_1234567890abcdefghijklmnopqrstuvwxyz';
  const encrypted = encryptKey(plainKey, testSecret);

  assert.ok(encrypted.ciphertext instanceof Buffer);
  assert.ok(encrypted.iv instanceof Buffer);
  assert.ok(encrypted.tag instanceof Buffer);
  assert.equal(encrypted.iv.length, 12, 'IV must be 12 bytes');
  assert.equal(encrypted.tag.length, 16, 'Auth tag must be 16 bytes');

  const decrypted = decryptKey(encrypted, testSecret);
  assert.equal(decrypted, plainKey, 'Decrypted key must match original');

  // Tamper with ciphertext
  const tamperedCipher = Buffer.from(encrypted.ciphertext);
  tamperedCipher[0] ^= 1;
  assert.throws(() => {
    decryptKey({ ...encrypted, ciphertext: tamperedCipher }, testSecret);
  }, 'Tampered ciphertext must fail auth tag check');

  // Tamper with auth tag
  const tamperedTag = Buffer.from(encrypted.tag);
  tamperedTag[0] ^= 1;
  assert.throws(() => {
    decryptKey({ ...encrypted, tag: tamperedTag }, testSecret);
  }, 'Tampered auth tag must fail decryption');
});
