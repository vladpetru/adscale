// Builds the OUTTANS HQ web app: logins, team management, and one tab per tool.

import path from 'node:path';
import express from 'express';
import { ROOT } from './storage.js';
import {
  Users, LoginThrottle, COOKIE, createFirstAdmin, sessionSecret, makeSessionToken, userFromToken,
  readCookie, setSessionCookie, verifyPassword, temporaryPassword,
} from './auth.js';
import { renderPage, esc } from './layout.js';
import { loginPage, accountPage, teamPage, passwordNotice, notFoundPage } from './pages.js';

const safeNext = (next) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/');

export function createApp({ dataDir, tools, log = console }) {
  const app = express();
  const users = new Users(dataDir);
  const throttle = new LoginThrottle();
  createFirstAdmin(users, log);
  const secret = sessionSecret(dataDir);
  const toolList = tools.map((t) => ({ id: t.id, name: t.name }));

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  // Railway's health check. /api/health is kept because the old AdScale app used that address.
  app.get(['/health', '/api/health'], (req, res) => res.type('text').send('ok'));

  // Who is logged in (if anyone)?
  app.use((req, res, next) => {
    req.user = userFromToken(readCookie(req, COOKIE), users, secret);
    next();
  });

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    res.send(loginPage({ next: safeNext(req.query.next), noAccounts: !users.all().length }));
  });

  app.post('/login', (req, res) => {
    const email = String(req.body.email || '');
    const next = safeNext(req.body.next);
    const key = req.ip;
    const locked = throttle.minutesLocked(key);
    if (locked) {
      return res.status(429).send(loginPage({ email, next, error: `Too many wrong tries. Wait ${locked} minute${locked > 1 ? 's' : ''} and try again.` }));
    }
    const user = users.findByEmail(email);
    if (!user || !verifyPassword(req.body.password, user.passwordHash)) {
      throttle.fail(key);
      return res.status(401).send(loginPage({ email, next, error: 'That email and password do not match.', noAccounts: !users.all().length }));
    }
    throttle.clear(key);
    users.update(user.id, { lastLoginAt: new Date().toISOString() });
    const { token, maxAge } = makeSessionToken(user, secret);
    setSessionCookie(req, res, token, maxAge);
    res.redirect(user.mustChangePassword ? '/account' : next);
  });

  app.post('/logout', (req, res) => {
    setSessionCookie(req, res, '', 0);
    res.redirect('/login');
  });

  // Everything below needs a logged-in person.
  app.use((req, res, next) => {
    if (!req.user) {
      if (req.method === 'GET' && req.accepts('html')) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return res.status(401).json({ error: 'Please log in again.' });
    }
    // People with a temporary password must choose their own first.
    if (req.user.mustChangePassword && !['/account', '/account/password'].includes(req.path)) return res.redirect('/account');
    next();
  });

  const render = (req, active, opts) => renderPage({ user: req.user, tools: toolList, active, ...opts });

  app.get('/', (req, res) => res.redirect(tools.length ? `/${tools[0].id}` : '/account'));

  app.get('/account', (req, res) => {
    res.send(accountPage({ user: req.user, tools: toolList, firstLogin: req.user.mustChangePassword }));
  });

  app.post('/account/password', (req, res) => {
    const firstLogin = req.user.mustChangePassword;
    const fail = (error) => res.status(400).send(accountPage({ user: req.user, tools: toolList, firstLogin, error }));
    if (!firstLogin && !verifyPassword(req.body.current, req.user.passwordHash)) return fail('Your current password is not right.');
    if (req.body.password !== req.body.confirm) return fail('The two new passwords do not match.');
    if (verifyPassword(req.body.password, req.user.passwordHash)) return fail('Choose a password different from the current one.');
    let updated;
    try {
      updated = users.setPassword(req.user.id, req.body.password);
    } catch (err) {
      return fail(err.message);
    }
    const { token, maxAge } = makeSessionToken(updated, secret);
    setSessionCookie(req, res, token, maxAge);
    if (firstLogin) return res.redirect('/');
    res.send(accountPage({ user: updated, tools: toolList, notice: { kind: 'success', html: '<b>Password changed.</b> You were logged out on your other devices.' } }));
  });

  // Team management, admins only.
  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).send(notFoundPage({ user: req.user, tools: toolList })));
  const team = (req, extra = {}) => teamPage({ user: req.user, tools: toolList, users: users.all(), ...extra });

  app.get('/team', adminOnly, (req, res) => res.send(team(req)));

  app.post('/team', adminOnly, (req, res) => {
    const form = { name: req.body.name, email: req.body.email, role: req.body.role };
    const password = temporaryPassword();
    try {
      const person = users.add({ ...form, password, mustChangePassword: true });
      res.send(team(req, { notice: passwordNotice(person, password, 'was added') }));
    } catch (err) {
      res.status(400).send(team(req, { error: err.message, form }));
    }
  });

  app.post('/team/:id/reset', adminOnly, (req, res) => {
    const person = users.find(req.params.id);
    if (!person || person.id === req.user.id) return res.redirect('/team');
    const password = temporaryPassword();
    users.setPassword(person.id, password, { mustChangePassword: true });
    res.send(team(req, { notice: passwordNotice(person, password, 'has a new temporary password') }));
  });

  app.post('/team/:id/remove', adminOnly, (req, res) => {
    const person = users.find(req.params.id);
    if (!person || person.id === req.user.id) return res.redirect('/team');
    try {
      users.remove(person.id);
      res.send(team(req, { notice: { kind: 'success', html: `<b>${esc(person.name)} was removed.</b>` } }));
    } catch (err) {
      res.status(400).send(team(req, { notice: { kind: 'error', html: esc(err.message) } }));
    }
  });

  // Each tool gets its own tab at /<tool id> and its own data folder.
  const started = [];
  for (const tool of tools) {
    const router = express.Router();
    const result = tool.setup({
      router,
      dataDir: path.join(dataDir, 'tools', tool.id),
      basePath: `/${tool.id}`,
      render: (req, opts) => render(req, tool.id, opts),
      log,
    }) || {};
    if (result.start) started.push(result.start);
    app.use(`/${tool.id}`, router);
  }
  app.locals.startTools = () => started.forEach((start) => start());

  app.use((req, res) => res.status(404).send(notFoundPage({ user: req.user, tools: toolList })));
  app.use((err, req, res, next) => {
    log.error(err);
    res.status(500).send(render(req, null, { title: 'Error', body: '<div class="page-head"><h1>Something went wrong</h1><p class="muted">Please try again. If it keeps happening, check the logs on Railway.</p></div>' }));
  });

  return app;
}
