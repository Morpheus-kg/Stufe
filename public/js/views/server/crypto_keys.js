// Шифрование персональных API-ключей пользователей (CONTRACT v3, A5)
// AES-256-GCM с ключом, полученным через HKDF-SHA256 из KEYS_SECRET.
import crypto from 'node:crypto';

const SALT = 'german_trainer_keys_salt_v1';
const INFO = 'user_api_keys_encryption';

/**
 * Проверка наличия и длины KEYS_SECRET (не менее 32 символов).
 */
export function hasValidKeysSecret(secret = process.env.KEYS_SECRET) {
  return typeof secret === 'string' && secret.length >= 32;
}

/**
 * Получить 32-байтный ключ шифрования через HKDF-SHA256.
 */
export function deriveKey(secret = process.env.KEYS_SECRET) {
  if (!hasValidKeysSecret(secret)) {
    throw new Error('KEYS_SECRET не задан или короче 32 символов');
  }
  return crypto.hkdfSync('sha256', secret, SALT, INFO, 32);
}

/**
 * Зашифровать ключ (AES-256-GCM).
 * @param {string} plainKey
 * @param {string} [secret]
 * @returns {{ciphertext: Buffer, iv: Buffer, tag: Buffer}}
 */
export function encryptKey(plainKey, secret = process.env.KEYS_SECRET) {
  const encKey = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Расшифровать ключ (AES-256-GCM). Бросает ошибку при повреждении данных/тега.
 * @param {{ciphertext: Buffer, iv: Buffer, tag: Buffer}} record
 * @param {string} [secret]
 * @returns {string}
 */
export function decryptKey({ ciphertext, iv, tag }, secret = process.env.KEYS_SECRET) {
  const encKey = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

