// The built-in screens: log in, your account, and team management.

import { esc, renderBare, renderPage, wordmark } from './layout.js';
import { MIN_PASSWORD } from './auth.js';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never');

export function loginPage({ email = '', next = '/', error, noAccounts }) {
  return renderBare({
    title: 'Log in',
    body: `
<main class="login">
  <div class="login-card">
    <div class="login-brand">${wordmark}</div>
    <p class="login-sub">Internal tools for the OUTTANS team.</p>
    ${noAccounts ? `<div class="notice warn">No accounts exist yet. Add the <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code> variables on Railway, then restart the app.</div>` : ''}
    ${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ''}
    <form method="post" action="/login" class="form">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required value="${esc(email)}" ${email ? '' : 'autofocus'}>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required ${email ? 'autofocus' : ''}>
      <button class="btn primary" type="submit">Log in</button>
    </form>
    <p class="login-help">Forgot your password? Ask an admin to reset it.</p>
  </div>
</main>`,
  });
}

export function accountPage({ user, tools, error, notice, firstLogin }) {
  return renderPage({
    title: 'Your account',
    user,
    tools,
    active: 'account',
    notice: notice || (firstLogin ? { kind: 'warn', html: '<b>Welcome to OUTTANS HQ.</b> Please choose your own password before you continue.' } : null),
    body: `
<div class="page-head"><h1>Your account</h1></div>
<section class="panel narrow">
  <dl class="facts">
    <dt>Name</dt><dd>${esc(user.name)}</dd>
    <dt>Email</dt><dd>${esc(user.email)}</dd>
    <dt>Access</dt><dd>${user.role === 'admin' ? 'Admin (can manage the team)' : 'Member'}</dd>
  </dl>
</section>
<section class="panel narrow">
  <h2>Change password</h2>
  ${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/account/password" class="form">
    ${firstLogin ? '' : `<label for="current">Current password</label>
    <input id="current" name="current" type="password" autocomplete="current-password" required>`}
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
    <p class="hint">At least ${MIN_PASSWORD} characters. A short phrase is easy to remember and hard to guess.</p>
    <label for="confirm">Type the new password again</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
    <button class="btn primary" type="submit">Save new password</button>
  </form>
</section>`,
  });
}

export function teamPage({ user, tools, users, error, notice, form = {} }) {
  const rows = users
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => `
      <tr>
        <td><div class="who">${esc(u.name)}${u.id === user.id ? ' <span class="chip-small">You</span>' : ''}</div><div class="muted">${esc(u.email)}</div></td>
        <td>${u.role === 'admin' ? '<span class="pill accent">Admin</span>' : '<span class="pill">Member</span>'}</td>
        <td class="muted">${u.mustChangePassword ? 'Has not logged in yet' : fmtDate(u.lastLoginAt)}</td>
        <td><div class="row-actions">
          ${u.id === user.id ? '' : `
          <form method="post" action="/team/${esc(u.id)}/reset"><button class="btn small" type="submit">Reset password</button></form>
          <details class="confirm">
            <summary class="btn small danger">Remove</summary>
            <div class="confirm-box">
              <p>Remove ${esc(u.name)}? They will be logged out and can no longer sign in.</p>
              <form method="post" action="/team/${esc(u.id)}/remove"><button class="btn small danger" type="submit">Yes, remove</button></form>
            </div>
          </details>`}
        </div></td>
      </tr>`)
    .join('');

  return renderPage({
    title: 'Team',
    user,
    tools,
    active: 'team',
    notice,
    body: `
<div class="page-head"><h1>Team</h1><p class="muted">People who can log in to OUTTANS HQ.</p></div>
<section class="panel">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>Person</th><th>Access</th><th>Last login</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>
<section class="panel narrow">
  <h2>Add a person</h2>
  <p class="muted">You will get a temporary password to send them. They choose their own password the first time they log in.</p>
  ${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/team" class="form">
    <label for="name">Name</label>
    <input id="name" name="name" required value="${esc(form.name)}">
    <label for="new-email">Email</label>
    <input id="new-email" name="email" type="email" required value="${esc(form.email)}">
    <label for="role">Access</label>
    <select id="role" name="role">
      <option value="member"${form.role === 'admin' ? '' : ' selected'}>Member: can use all tools</option>
      <option value="admin"${form.role === 'admin' ? ' selected' : ''}>Admin: can also manage the team</option>
    </select>
    <button class="btn primary" type="submit">Add person</button>
  </form>
</section>`,
  });
}

// Shown once after adding someone or resetting a password.
export function passwordNotice(person, password, verb) {
  return {
    kind: 'success',
    html: `<b>${esc(person.name)} ${verb}.</b> Send them this temporary password and the address of this site. It is shown only once.
      <div class="secret"><code id="temp-pass">${esc(password)}</code>
      <button class="btn small" type="button" onclick="navigator.clipboard.writeText(document.getElementById('temp-pass').textContent).then(()=>{this.textContent='Copied'},()=>{})">Copy</button></div>`,
  };
}

export function notFoundPage({ user, tools }) {
  return renderPage({
    title: 'Not found',
    user,
    tools,
    body: '<div class="page-head"><h1>Page not found</h1><p class="muted">That page does not exist. Pick a tool from the tabs above.</p></div>',
  });
}
