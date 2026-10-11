/**
 * Desktop startup-password storage (plain Node, no Electron imports, so it is
 * unit-testable). The record lives in <userData>/desktop-lock.json:
 *   { version, salt, hash, createdAt }
 * Presence of the file = lock enabled. A salted scrypt hash is stored; the
 * password itself never touches disk.
 */
const crypto = require("crypto");
const fs = require("fs");

const SCRYPT_KEYLEN = 32;
const MIN_PASSWORD_LENGTH = 4;

function hashPassword(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN).toString("hex");
}

function createRecord(password) {
  const pw = String(password || "");
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  }
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    version: 1,
    salt,
    hash: hashPassword(pw, salt),
    createdAt: new Date().toISOString(),
  };
}

function verifyPassword(record, password) {
  if (!record || !record.salt || !record.hash) {
    return false;
  }
  const candidate = Buffer.from(hashPassword(password, record.salt), "hex");
  const expected = Buffer.from(record.hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function readRecord(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw && raw.salt && raw.hash) {
      return raw;
    }
  } catch {
    /* missing or corrupt -> treat as unlocked */
  }
  return null;
}

function writeRecord(filePath, record) {
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
}

function removeRecord(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* already gone */
  }
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  SCRYPT_KEYLEN,
  createRecord,
  hashPassword,
  readRecord,
  removeRecord,
  verifyPassword,
  writeRecord,
};
