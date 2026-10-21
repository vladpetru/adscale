import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../platform/app.js';
import tools from '../tools/index.js';
import { startFakeAmazon } from './helpers/fake-amazon.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {}, error() {} };
let dir, server, base, fake;

// A tiny browser: remembers its login cookie and does not follow redirects.
function browser() {
  let cookie = '';
  const go = async (url, { form, method } = {}) => {
    const res = await fetch(base + url, {
      method: method || (form ? 'POST' : 'GET'),
      redirect: 'manual',
      headers: { cookie, accept: 'text/html', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  return { go, login: (email, password, next) => go('/login', { form: { email, password, ...(next ? { next } : {}) } }) };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-'));
  fake = await startFakeAmazon({
    products: { SOLO000001: { title: 'Acme Bench', bullets: ['Steel'], description: 'A bench.', images: ['bench1'] } },
    prices: { SOLO000001: 129.5 },
    aplus: { text: 'Great bench.', images: [] },
  });
  const amazon = `http://127.0.0.1:${fake.address().port}`;
  const productsFile = path.join(dir, 'products.json');
  fs.writeFileSync(productsFile, JSON.stringify({ settings: {}, products: [{ asin: 'SOLO000001', nickname: 'Acme bench' }] }));
  Object.assign(process.env, {
    ADMIN_EMAIL: 'Owner@Outtans.com', ADMIN_PASSWORD: 'first-admin-pass', ADMIN_NAME: 'Pat Owner',
    TRACKER_PRODUCTS_FILE: productsFile, TRACKER_FAST: '1',
    SPAPI_ENDPOINT: amazon, SPAPI_TOKEN_URL: amazon + '/auth', AMAZON_PAGE_BASE: amazon,
    SPAPI_CLIENT_ID: 'id', SPAPI_CLIENT_SECRET: 'secret', SPAPI_REFRESH_TOKEN: 'refresh',
  });
  const app = createApp({ dataDir: path.join(dir, 'data'), tools, log: quiet });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD and stores only a hash', () => {
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'data/platform/users.json'), 'utf8'));
  assert.equal(users.length, 1);
  assert.equal(users[0].email, 'owner@outtans.com');
  assert.equal(users[0].role, 'admin');
  assert.doesNotMatch(JSON.stringify(users), /first-admin-pass/);
});

test('logged-out visitors are sent to the login page', async () => {
  const b = browser();
  assert.equal((await b.go('/')).location, '/login?next=%2F');
  assert.equal((await b.go('/competitor-tracker')).location, '/login?next=%2Fcompetitor-tracker');
  assert.equal((await b.go('/competitor-tracker/run', { method: 'POST' })).status, 401);
  assert.equal((await b.go('/health')).status, 200);
  assert.equal((await b.go('/api/health')).status, 200);
  assert.match((await b.go('/login')).text, /OUTTANS<span class="wordmark-tag">HQ/);
});

test('login: wrong password is refused, right one opens the first tool tab', async () => {
  const b = browser();
  const wrong = await b.login('owner@outtans.com', 'nope-nope-nope');
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /do not match/);

  const ok = await b.login('OWNER@outtans.com ', 'first-admin-pass', '/competitor-tracker');
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/competitor-tracker');
  assert.equal((await b.go('/')).location, '/competitor-tracker');

  const page = await b.go('/competitor-tracker');
  assert.equal(page.status, 200);
  assert.match(page.text, /<a class="tab" href="\/competitor-tracker" aria-current="page">Competitor Watch<\/a>/);
  assert.match(page.text, /Acme|Competitor Watch/);
  assert.match(page.text, /href="\/team"/, 'admins see the Team link');

  // Never redirect to another website after login.
  const evil = await browser().login('owner@outtans.com', 'first-admin-pass', '//evil.example.com');
  assert.equal(evil.location, '/');
});

test('team: admin adds a member, who must choose a password, and cannot manage the team', async () => {
  const admin = browser();
  await admin.login('owner@outtans.com', 'first-admin-pass');
  const added = await admin.go('/team', { form: { name: 'Sam Rivera', email: 'sam@outtans.com', role: 'member' } });
  assert.equal(added.status, 200);
  const temp = /<code id="temp-pass">([^<]+)<\/code>/.exec(added.text)[1];
  assert.match(temp, /^[a-z]+-\d{4}-[a-z]+$/);

  const dup = await admin.go('/team', { form: { name: 'Sam again', email: 'SAM@outtans.com', role: 'member' } });
  assert.equal(dup.status, 400);
  assert.match(dup.text, /already has an account/);

  const sam = browser();
  assert.equal((await sam.login('sam@outtans.com', temp)).location, '/account');
  assert.equal((await sam.go('/competitor-tracker')).location, '/account', 'must change password first');
  assert.match((await sam.go('/account')).text, /choose your own password/);
  const short = await sam.go('/account/password', { form: { password: 'short', confirm: 'short' } });
  assert.match(short.text, /at least 10 characters/);
  const changed = await sam.go('/account/password', { form: { password: 'sams-own-password', confirm: 'sams-own-password' } });
  assert.equal(changed.location, '/');
  assert.equal((await sam.go('/competitor-tracker')).status, 200);
  assert.equal((await sam.go('/team')).status, 403);
  assert.doesNotMatch((await sam.go('/competitor-tracker')).text, /href="\/team"/);

  // Changing a password needs the current one.
  const bad = await sam.go('/account/password', { form: { current: 'wrong-current', password: 'another-password', confirm: 'another-password' } });
  assert.match(bad.text, /current password is not right/);
});

test('team: resetting a password logs that person out; removing them blocks login', async () => {
  const admin = browser();
  await admin.login('owner@outtans.com', 'first-admin-pass');
  const added = await admin.go('/team', { form: { name: 'Lee Park', email: 'lee@outtans.com', role: 'member' } });
  const temp = /<code id="temp-pass">([^<]+)<\/code>/.exec(added.text)[1];
  const lee = browser();
  await lee.login('lee@outtans.com', temp);
  await lee.go('/account/password', { form: { password: 'lees-password-1', confirm: 'lees-password-1' } });
  assert.equal((await lee.go('/competitor-tracker')).status, 200);

  const users = JSON.parse(fs.readFileSync(path.join(dir, 'data/platform/users.json'), 'utf8'));
  const leeId = users.find((u) => u.email === 'lee@outtans.com').id;
  const adminId = users.find((u) => u.role === 'admin').id;

  const reset = await admin.go(`/team/${leeId}/reset`, { form: {} });
  assert.match(reset.text, /new temporary password/);
  assert.match((await lee.go('/competitor-tracker')).location, /^\/login/, 'old session no longer works');

  await admin.go(`/team/${leeId}/remove`, { form: {} });
  assert.equal((await browser().login('lee@outtans.com', 'lees-password-1')).status, 401);

  // Admins cannot remove themselves.
  await admin.go(`/team/${adminId}/remove`, { form: {} });
  assert.equal((await admin.go('/team')).status, 200);
});

test('logout ends the session', async () => {
  const b = browser();
  await b.login('owner@outtans.com', 'first-admin-pass');
  await b.go('/logout', { form: {} });
  assert.match((await b.go('/competitor-tracker')).location, /^\/login/);
});

test('Competitor Watch: "Check now" runs a check for logged-in people', async () => {
  const b = browser();
  await b.login('owner@outtans.com', 'first-admin-pass');
  assert.equal((await b.go('/competitor-tracker/run', { method: 'POST' })).status, 202);
  let changes = [];
  for (let i = 0; i < 50 && !changes.length; i++) {
    await sleep(100);
    changes = JSON.parse((await b.go('/competitor-tracker/changes.json')).text);
  }
  assert.equal(changes[0]?.type, 'baseline');
  assert.match((await b.go('/competitor-tracker')).text, /Acme bench/);
  assert.ok(fs.existsSync(path.join(dir, 'data/tools/competitor-tracker/status.json')), 'tool data lives in its own folder');
});

// Runs last: it locks out this test's address.
test('5 wrong passwords lock the login for 15 minutes', async () => {
  const b = browser();
  for (let i = 0; i < 5; i++) await b.login('owner@outtans.com', 'wrong-guess-' + i);
  const locked = await b.login('owner@outtans.com', 'first-admin-pass');
  assert.equal(locked.status, 429);
  assert.match(locked.text, /Too many wrong tries/);
});
