// ================================================================
// AdScale — Real Data Loader
// ================================================================
// This file replaces sample/fake data in the dashboard with
// real Amazon Ads data fetched via the MAP MCP backend.
// Loaded by index.html after the main app JS.
// ================================================================

(function () {
  'use strict';

  // Cache for loaded data
  const cache = {
    portfolios: null,
    campaigns: null,
    lastFetch: 0,
  };

  // ----------------------------------------------------------------
  // Override initApp to load real data on login
  // ----------------------------------------------------------------
  const originalInitApp = window.initApp;
  window.initApp = async function () {
    // Run original init (builds UI, sets date, etc.)
    if (originalInitApp) await originalInitApp();

    // Check if MAP is connected
    try {
      const status = await API.get('/auth/status');
      if (status.mapConnected) {
        // Update connection status in sidebar
        const connDot = document.getElementById('connDot');
        const connLabel = document.getElementById('connLabel');
        if (connDot) connDot.style.background = '#00c896';
        if (connLabel) {
          connLabel.textContent = 'Connected via MAP';
          connLabel.style.color = '#00c896';
        }

        // Load real data
        await loadRealPortfolios();
        await loadRealCampaigns();
        await loadRealDashboard();
      }
    } catch (e) {
      console.warn('Real data load failed:', e.message);
    }
  };

  // ----------------------------------------------------------------
  // Load real portfolios into dropdown
  // ----------------------------------------------------------------
  async function loadRealPortfolios() {
    try {
      const portfolios = await API.get('/api/portfolios');
      if (!Array.isArray(portfolios)) return;

      cache.portfolios = portfolios;

      const select = document.getElementById('portfolioFilter');
      if (!select) return;

      select.innerHTML = '<option value="">All Portfolios</option>';

      // Sort alphabetically
      portfolios.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      portfolios.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.portfolioId;
        const budgetInfo = p.budget && p.budget.amount
          ? ` ($${p.budget.amount}/day)`
          : p.budget && p.budget.policy === 'NO_CAP'
            ? ' (no cap)'
            : '';
        const statusIcon = p.inBudget === false ? '!' : '';
        opt.textContent = statusIcon + p.name + budgetInfo;
        select.appendChild(opt);
      });

      const none = document.createElement('option');
      none.value = 'none';
      none.textContent = '- No Portfolio';
      select.appendChild(none);

    } catch (e) {
      console.warn('Portfolio load failed:', e.message);
    }
  }

  // ----------------------------------------------------------------
  // Load real campaigns into campaigns table
  // ----------------------------------------------------------------
  async function loadRealCampaigns() {
    try {
      const campaigns = await API.get('/api/campaigns');
      if (!Array.isArray(campaigns) || campaigns.length === 0) return;

      cache.campaigns = campaigns;

      renderCampaignTable(campaigns);
    } catch (e) {
      console.warn('Campaign load failed:', e.message);
    }
  }

  // ----------------------------------------------------------------
  // Render campaigns into the campaigns page table
  // ----------------------------------------------------------------
  function renderCampaignTable(campaigns) {
    const page = document.getElementById('page-campaigns');
    if (!page) return;

    // Find or create table wrapper
    let tableWrap = page.querySelector('.table-wrap');
    if (!tableWrap) {
      tableWrap = document.createElement('div');
      tableWrap.className = 'table-wrap';
      page.appendChild(tableWrap);
    }

    // Get portfolio name lookup
    const portfolioMap = {};
    if (cache.portfolios) {
      cache.portfolios.forEach(p => {
        portfolioMap[p.portfolioId] = p.name;
      });
    }

    const strategyLabels = {
      'LEGACY_FOR_SALES': 'Down Only',
      'AUTO_FOR_SALES': 'Up & Down',
      'MANUAL': 'Fixed',
      'RULE_BASED': 'Rule Based',
    };

    // Build table HTML
    let html = `
      <div class="table-header">
        <span class="table-header-title">${campaigns.length} Campaigns</span>
        <span style="font-size:11px;color:var(--text3);font-family:var(--mono)">
          Live data from Amazon
        </span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Portfolio</th>
              <th>Type</th>
              <th>Status</th>
              <th>Budget</th>
              <th>Strategy</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
    `;

    campaigns.forEach(c => {
      const isEnabled = (c.state || '').toUpperCase() === 'ENABLED';
      const isAuto = (c.targetingType || '').toUpperCase() === 'AUTO';
      const type = c.campaignType || 'SP';
      const portfolio = portfolioMap[c.portfolioId] || '-';
      const budget = c.budget && c.budget.budget ? `$${c.budget.budget.toFixed(0)}` : '-';
      const strategy = strategyLabels[c.dynamicBidding?.strategy] || c.dynamicBidding?.strategy || '-';
      const isB2B = c.siteRestrictions && c.siteRestrictions.includes('AMAZON_BUSINESS');

      html += `
        <tr data-campaign-id="${c.campaignId}" data-state="${c.state}">
          <td>
            <span class="status-dot ${isEnabled ? 'live' : 'paused'}"></span>
            ${escapeHtml(c.name || '')}
            ${isB2B ? '<span class="type-tag" style="background:#3b82f6;color:white">B2B</span>' : ''}
          </td>
          <td style="font-size:12px;color:var(--text2)">${escapeHtml(portfolio)}</td>
          <td>
            <span class="badge ${isAuto ? 'badge-blue' : 'badge-gray'}">
              ${isAuto ? 'Auto' : 'Manual'}
            </span>
            <span class="type-tag">${type}</span>
          </td>
          <td>
            <span class="badge ${isEnabled ? 'badge-green' : 'badge-amber'}">
              ${isEnabled ? 'Enabled' : 'Paused'}
            </span>
          </td>
          <td style="font-family:var(--mono)">${budget}/day</td>
          <td style="font-size:12px;color:var(--text2)">${strategy}</td>
          <td>
            <button class="btn ${isEnabled ? 'enabled' : 'paused'}"
                    style="font-size:11px;padding:3px 8px;"
                    onclick="toggleCampaignState(this, '${c.campaignId}', '${c.campaignType || 'SP'}')">
              ${isEnabled ? 'Pause' : 'Enable'}
            </button>
          </td>
        </tr>
      `;
    });

    html += '</tbody></table></div>';
    tableWrap.innerHTML = html;
  }

  // ----------------------------------------------------------------
  // Toggle campaign state (enable/pause)
  // ----------------------------------------------------------------
  window.toggleCampaignState = async function (btn, campaignId, campaignType) {
    const row = btn.closest('tr');
    if (!row) return;

    const currentState = row.dataset.state;
    const newState = currentState === 'ENABLED' ? 'PAUSED' : 'ENABLED';

    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      await API.put(`/api/campaigns/${campaignId}`, {
        state: newState,
        _type: campaignType,
      });

      row.dataset.state = newState;
      const isEnabled = newState === 'ENABLED';

      // Update status dot
      const dot = row.querySelector('.status-dot');
      if (dot) {
        dot.className = `status-dot ${isEnabled ? 'live' : 'paused'}`;
      }

      // Update badge
      const badge = row.querySelector('td:nth-child(4) .badge');
      if (badge) {
        badge.className = `badge ${isEnabled ? 'badge-green' : 'badge-amber'}`;
        badge.textContent = isEnabled ? 'Enabled' : 'Paused';
      }

      // Update button
      btn.textContent = isEnabled ? 'Pause' : 'Enable';
      btn.className = `btn ${isEnabled ? 'enabled' : 'paused'}`;
      btn.style.fontSize = '11px';
      btn.style.padding = '3px 8px';
    } catch (e) {
      console.error('Campaign state update failed:', e.message);
      btn.textContent = currentState === 'ENABLED' ? 'Pause' : 'Enable';
    }

    btn.disabled = false;
  };

  // ----------------------------------------------------------------
  // Update dashboard metrics with real campaign data
  // ----------------------------------------------------------------
  async function loadRealDashboard() {
    if (!cache.campaigns) return;

    const campaigns = cache.campaigns;
    const enabledCount = campaigns.filter(c => c.state === 'ENABLED').length;
    const pausedCount = campaigns.filter(c => c.state === 'PAUSED').length;
    const totalBudget = campaigns
      .filter(c => c.state === 'ENABLED' && c.budget && c.budget.budget)
      .reduce((sum, c) => sum + c.budget.budget, 0);

    // Get portfolio stats
    const portfolioIds = new Set(campaigns.map(c => c.portfolioId).filter(Boolean));
    const outOfBudget = cache.portfolios
      ? cache.portfolios.filter(p => p.inBudget === false).length
      : 0;

    // Update dashboard metric cards
    const cards = document.querySelectorAll('#page-dashboard .metric-card');
    if (cards.length >= 5) {
      // Card 1: Total Campaigns
      cards[0].querySelector('.metric-label').textContent = 'Active Campaigns';
      cards[0].querySelector('.metric-value').textContent = enabledCount;
      cards[0].querySelector('.metric-delta').textContent = `${pausedCount} paused`;
      cards[0].querySelector('.metric-delta').className = 'metric-delta neutral';

      // Card 2: Daily Budget
      cards[1].querySelector('.metric-label').textContent = 'Daily Budget';
      cards[1].querySelector('.metric-value').textContent = `$${totalBudget.toLocaleString()}`;
      cards[1].querySelector('.metric-delta').textContent = 'Enabled campaigns total';
      cards[1].querySelector('.metric-delta').className = 'metric-delta neutral';

      // Card 3: Portfolios
      cards[2].querySelector('.metric-label').textContent = 'Portfolios';
      cards[2].querySelector('.metric-value').textContent = portfolioIds.size;
      cards[2].querySelector('.metric-delta').textContent =
        outOfBudget > 0 ? `${outOfBudget} out of budget` : 'All in budget';
      cards[2].querySelector('.metric-delta').className =
        outOfBudget > 0 ? 'metric-delta down' : 'metric-delta up';

      // Card 4: Campaign Types
      const autoCount = campaigns.filter(c => c.targetingType === 'AUTO' && c.state === 'ENABLED').length;
      const manualCount = enabledCount - autoCount;
      cards[3].querySelector('.metric-label').textContent = 'Manual / Auto';
      cards[3].querySelector('.metric-value').textContent = `${manualCount} / ${autoCount}`;
      cards[3].querySelector('.metric-delta').textContent = 'Targeting split';
      cards[3].querySelector('.metric-delta').className = 'metric-delta neutral';

      // Card 5: Data Source
      cards[4].querySelector('.metric-label').textContent = 'Data Source';
      cards[4].querySelector('.metric-value').textContent = 'MAP';
      cards[4].querySelector('.metric-delta').textContent = 'Live connection';
      cards[4].querySelector('.metric-delta').className = 'metric-delta up';
    }

    // Remove sample data banner if present
    const banners = document.querySelectorAll('#page-dashboard [style*="border: 1px dashed"]');
    banners.forEach(b => b.remove());

    // Remove sample data warning
    const warnings = document.querySelectorAll('#page-dashboard [style*="dashed"]');
    warnings.forEach(w => {
      if (w.textContent.includes('Sample data') || w.textContent.includes('sample')) {
        w.remove();
      }
    });

    // Update the top campaigns table on the dashboard
    renderDashboardCampaigns(campaigns);
  }

  // ----------------------------------------------------------------
  // Render top campaigns on dashboard
  // ----------------------------------------------------------------
  function renderDashboardCampaigns(campaigns) {
    // Find the "Top Campaigns" table on dashboard
    const dashPage = document.getElementById('page-dashboard');
    if (!dashPage) return;

    const tables = dashPage.querySelectorAll('.table-wrap');
    let topCampaignsTable = null;
    tables.forEach(t => {
      const header = t.querySelector('.table-header-title');
      if (header && header.textContent.includes('Campaign')) {
        topCampaignsTable = t;
      }
    });

    if (!topCampaignsTable) return;

    // Show first 10 enabled campaigns sorted by budget
    const top = campaigns
      .filter(c => c.state === 'ENABLED')
      .sort((a, b) => (b.budget?.budget || 0) - (a.budget?.budget || 0))
      .slice(0, 10);

    let html = `
      <div class="table-header">
        <span class="table-header-title">Top Campaigns (by budget)</span>
        <button class="btn" style="font-size:12px;padding:4px 10px;"
                onclick="navigate('campaigns',null)">View all ${campaigns.length} &rarr;</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Type</th>
              <th>Status</th>
              <th>Budget</th>
              <th>Strategy</th>
            </tr>
          </thead>
          <tbody>
    `;

    const strategyLabels = {
      'LEGACY_FOR_SALES': 'Down Only',
      'AUTO_FOR_SALES': 'Up & Down',
      'MANUAL': 'Fixed',
    };

    top.forEach(c => {
      const isAuto = c.targetingType === 'AUTO';
      const strategy = strategyLabels[c.dynamicBidding?.strategy] || '-';
      const type = c.campaignType || 'SP';
      const budget = c.budget?.budget ? `$${c.budget.budget.toFixed(0)}` : '-';
      const isB2B = c.siteRestrictions && c.siteRestrictions.includes('AMAZON_BUSINESS');

      html += `
        <tr>
          <td>
            <span class="status-dot live"></span>
            ${escapeHtml(c.name || '')}
            ${isB2B ? '<span class="type-tag" style="background:#3b82f6;color:white">B2B</span>' : ''}
            <span class="type-tag">${type}</span>
          </td>
          <td><span class="badge ${isAuto ? 'badge-blue' : 'badge-gray'}">${isAuto ? 'Auto' : 'Manual'}</span></td>
          <td><span class="badge badge-green">Enabled</span></td>
          <td style="font-family:var(--mono)">${budget}/day</td>
          <td style="font-size:12px;color:var(--text2)">${strategy}</td>
        </tr>
      `;
    });

    html += '</tbody></table></div>';
    topCampaignsTable.innerHTML = html;
  }

  // ----------------------------------------------------------------
  // Portfolio filter on campaigns page
  // ----------------------------------------------------------------
  window.filterCampaignsByPortfolio = function (portfolioId) {
    if (!cache.campaigns) return;

    let filtered = cache.campaigns;
    if (portfolioId === 'none') {
      filtered = cache.campaigns.filter(c => !c.portfolioId);
    } else if (portfolioId) {
      filtered = cache.campaigns.filter(c => String(c.portfolioId) === String(portfolioId));
    }

    renderCampaignTable(filtered);
  };

  // ----------------------------------------------------------------
  // Campaign search filter
  // ----------------------------------------------------------------
  function initCampaignSearch() {
    const page = document.getElementById('page-campaigns');
    if (!page) return;

    const searchInput = page.querySelector('.search-input');
    if (!searchInput) return;

    searchInput.addEventListener('input', function () {
      if (!cache.campaigns) return;

      const query = this.value.toLowerCase().trim();
      if (!query) {
        renderCampaignTable(cache.campaigns);
        return;
      }

      const filtered = cache.campaigns.filter(c =>
        (c.name || '').toLowerCase().includes(query)
      );
      renderCampaignTable(filtered);
    });
  }

  // Initialize search after a short delay (DOM needs to be ready)
  setTimeout(initCampaignSearch, 1000);

  // ----------------------------------------------------------------
  // Helper: escape HTML
  // ----------------------------------------------------------------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

})();
