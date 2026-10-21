// The page frame shared by every screen: top bar, one tab per tool, and the account menu.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell({ title, head = '', bodyClass = '', content }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/hq.css">
${head}
</head>
<body class="${bodyClass}">
${content}
</body>
</html>
`;
}

export const wordmark = '<span class="wordmark">OUTTANS<span class="wordmark-tag">HQ</span></span>';

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

export function renderPage({ title, user, tools = [], active, body, head = '', notice }) {
  const tabs = tools.map((t) => `<a class="tab" href="/${t.id}"${active === t.id ? ' aria-current="page"' : ''}>${esc(t.name)}</a>`).join('');
  const menu = user ? `
    <details class="account">
      <summary aria-label="Account menu"><span class="avatar">${esc(initials(user.name))}</span><span class="account-name">${esc(user.name)}</span></summary>
      <div class="account-menu">
        <div class="account-who">${esc(user.name)}<span>${esc(user.email)}</span></div>
        <a href="/account"${active === 'account' ? ' aria-current="page"' : ''}>Your account</a>
        ${user.role === 'admin' ? `<a href="/team"${active === 'team' ? ' aria-current="page"' : ''}>Team</a>` : ''}
        <form method="post" action="/logout"><button type="submit">Log out</button></form>
      </div>
    </details>` : '';
  const content = `
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/" aria-label="OUTTANS HQ home">${wordmark}</a>
    <nav class="tabs" aria-label="Tools">${tabs}</nav>
    ${menu}
  </div>
</header>
<main class="main">
  ${notice ? `<div class="notice ${esc(notice.kind || 'info')}" role="status">${notice.html}</div>` : ''}
  ${body}
</main>`;
  return shell({ title: `${title} · OUTTANS HQ`, head, content });
}

// Pages without the top bar (the login screen).
export function renderBare({ title, body }) {
  return shell({ title: `${title} · OUTTANS HQ`, bodyClass: 'bare', content: body });
}
