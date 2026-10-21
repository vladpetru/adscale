// User accounts, password checks and login sessions.
// Passwords are never stored, only a salted scrypt hash of them.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './storage.js';

export const COOKIE = 'hq_session';
const SESSION_DAYS = 14;
export const MIN_PASSWORD = 10;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const given = crypto.scryptSync(String(password), salt, 64);
  const wanted = Buffer.from(hash, 'base64url');
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

// Readable temporary password, e.g. "maple-7421-cedar".
export function temporaryPassword() {
  const words = ['maple', 'cedar', 'birch', 'aspen', 'river', 'stone', 'meadow', 'harbor', 'summit', 'canyon', 'prairie', 'willow'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${crypto.randomInt(1000, 10000)}-${pick()}`;
}

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export function passwordProblem(password) {
  if (String(password || '').length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  return null;
}

export class Users {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'platform', 'users.json');
  }

  all() {
    return readJson(this.file, []);
  }

  find(id) {
    return this.all().find((u) => u.id === id) || null;
  }

  findByEmail(email) {
    const e = normalizeEmail(email);
    return this.all().find((u) => u.email === e) || null;
  }

  add({ name, email, role = 'member', password, mustChangePassword = true }) {
    email = normalizeEmail(email);
    name = String(name || '').trim();
    if (!name) throw new Error('Enter a name.');
    if (!validEmail(email)) throw new Error('Enter a valid email address.');
    if (this.findByEmail(email)) throw new Error('Someone with that email already has an account.');
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      role: role === 'admin' ? 'admin' : 'member',
      passwordHash: hashPassword(password),
      mustChangePassword,
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    this.save([...this.all(), user]);
    return user;
  }

  update(id, changes) {
    const list = this.all();
    const user = list.find((u) => u.id === id);
    if (!user) throw new Error('That account no longer exists.');
    Object.assign(user, changes);
    this.save(list);
    return user;
  }

  // Changing a password signs the person out everywhere else.
  setPassword(id, password, { mustChangePassword = false } = {}) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const user = this.find(id);
    return this.update(id, { passwordHash: hashPassword(password), mustChangePassword, sessionVersion: (user?.sessionVersion || 1) + 1 });
  }

  remove(id) {
    const list = this.all();
    const user = list.find((u) => u.id === id);
    if (!user) return;
    if (user.role === 'admin' && list.filter((u) => u.role === 'admin').length === 1) {
      throw new Error('You cannot remove the last admin.');
    }
    this.save(list.filter((u) => u.id !== id));
  }

  save(list) {
    writeJson(this.file, list);
  }
}

// First start: create the admin account from the ADMIN_EMAIL and ADMIN_PASSWORD variables.
export function createFirstAdmin(users, log = console) {
  if (users.all().length) return;
  const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    log.warn('No accounts yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin account.');
    return;
  }
  const name = process.env.ADMIN_NAME || email.split('@')[0];
  users.add({ name, email, role: 'admin', password, mustChangePassword: false });
  log.log(`Created the first admin account for ${normalizeEmail(email)}.`);
}

// The key that signs login cookies. Uses SESSION_SECRET if set, otherwise makes one and saves it.
export function sessionSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'platform', 'session.key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const key = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
    return key;
  }
}

const sign = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

export function makeSessionToken(user, secret) {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const value = `${user.id}.${expires}.${user.sessionVersion}`;
  return { token: `${value}.${sign(value, secret)}`, maxAge: SESSION_DAYS * 86400 };
}

export function userFromToken(token, users, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  const [id, expires, version, sig] = parts;
  const expected = Buffer.from(sign(`${id}.${expires}.${version}`, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (Number(expires) < Date.now()) return null;
  const user = users.find(id);
  if (!user || String(user.sessionVersion) !== version) return null;
  return user;
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setSessionCookie(req, res, value, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

// Slows down password guessing: 5 wrong tries from one address locks it out for 15 minutes.
export class LoginThrottle {
  constructor({ maxFails = 5, windowMs = 15 * 60000 } = {}) {
    this.maxFails = maxFails;
    this.windowMs = windowMs;
    this.fails = new Map();
  }

  minutesLocked(key) {
    const f = this.fails.get(key);
    if (!f || f.count < this.maxFails) return 0;
    const left = f.first + this.windowMs - Date.now();
    if (left <= 0) { this.fails.delete(key); return 0; }
    return Math.ceil(left / 60000);
  }

  fail(key) {
    const f = this.fails.get(key);
    if (!f || Date.now() - f.first > this.windowMs) this.fails.set(key, { count: 1, first: Date.now() });
    else f.count++;
  }

  clear(key) {
    this.fails.delete(key);
  }
}
