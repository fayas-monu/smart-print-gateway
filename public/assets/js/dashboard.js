/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Operator dashboard controller: queue, history, settings, printing.
 * (AL SHAJAR TEAM)
 */
(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var esc = function (value) { return SPG.escapeHtml(value == null ? '' : value); };

  var VIEWS = {
    queue: {
      title: 'Live queue',
      sub: 'Jobs appear here the moment a customer sends them. Accepting a job sends the print-ready file to the Canon printer.'
    },
    history: {
      title: 'Job history',
      sub: 'Search every job, review past totals and export a CSV for the shop records.'
    },
    settings: {
      title: 'Settings',
      sub: 'Shop details, VAT-inclusive AED rates, delivery, printing and console security.'
    }
  };

  var state = {
    session: false,
    usingDefaultPin: false,
    view: 'queue',
    queue: [],
    recent: [],
    stats: {},
    network: null,
    diagnostics: null,
    settings: null,
    printerDraft: [],
    activeJob: null,
    activeJobSyncPending: false,
    sse: null,
    sseRetryTimer: null,
    pollTimer: null,
    refreshSeconds: 15,
    history: { q: '', status: 'all', limit: 50, offset: 0, total: 0, loading: false },
    historyLoadedAt: 0
  };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function text(id, value) {
    var node = byId(id);
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function html(id, value) {
    var node = byId(id);
    if (node) node.innerHTML = value == null ? '' : value;
  }

  function valueOf(id) {
    var node = byId(id);
    return node ? String(node.value || '').trim() : '';
  }

  function numberOf(id, fallback) {
    var raw = valueOf(id);
    if (raw === '') return fallback;
    var n = Number(raw);
    return isFinite(n) ? n : fallback;
  }

  function checked(id) {
    var node = byId(id);
    return !!(node && node.checked);
  }

  function compactNumber(value) {
    var n = Number(value) || 0;
    return n.toLocaleString('en-AE');
  }

  function plural(count, one, many) {
    return count === 1 ? one : (many || one + 's');
  }

  function duration(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0));
    var days = Math.floor(total / 86400);
    var hours = Math.floor((total % 86400) / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    if (days) return days + 'd ' + hours + 'h';
    if (hours) return hours + 'h ' + minutes + 'm';
    return minutes + 'm';
  }

  function statusClass(status) {
    if (status === 'completed') return 'is-completed';
    if (status === 'printing') return 'is-printing';
    if (status === 'pending') return 'is-pending';
    if (status === 'rejected' || status === 'failed' || status === 'cancelled') return 'is-' + status;
    return 'is-pending';
  }

  function statusBadge(status) {
    return '<span class="status-badge ' + statusClass(status) + '">' + esc(SPG.statusLabel(status)) + '</span>';
  }

  function paymentLabel(value) {
    return value === 'card' ? 'Card' : 'Cash';
  }

  function fulfilmentLabel(value) {
    return value === 'delivery' ? 'Home delivery' : 'Store pickup';
  }

  function orientationLabel(value) {
    if (value === 'landscape') return 'Landscape';
    if (value === 'portrait') return 'Portrait';
    return 'Auto';
  }

  function pageRangeLabel(settings) {
    var range = (settings && settings.pageRange) || {};
    if (range.mode !== 'custom' || !range.value) return 'All pages';
    return 'Selected: ' + String(range.value).slice(0, 120);
  }

  function initials(name) {
    return SPG.initials(name || '');
  }

  function copyText(value) {
    var content = String(value || '');
    if (!content) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(content).then(function () { return true; }).catch(function () {
        return legacyCopy(content);
      });
    }
    return Promise.resolve(legacyCopy(content));
  }

  function legacyCopy(content) {
    try {
      var area = document.createElement('textarea');
      area.value = content;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (err) {
      return false;
    }
  }

  function fail(err, fallback) {
    if (err && err.status === 401) {
      showLogin('Your session ended. Enter the PIN to continue.');
      return;
    }
    var message = (err && err.message) || fallback || 'Something went wrong.';
    SPG.toast(message, 'error');
  }

  /* ------------------------------------------------------------------ */
  /* Authentication                                                     */
  /* ------------------------------------------------------------------ */

  function init() {
    bindEvents();
    SPG.api('/api/auth/session')
      .then(function (res) { showApp(res); })
      .catch(function () { showLogin(); });
  }

  function showLogin(message) {
    stopLive();
    state.session = false;
    state.activeJob = null;
    var app = byId('app');
    var login = byId('login-view');
    var boot = byId('boot-view');
    if (boot) boot.hidden = true;
    if (app) app.hidden = true;
    if (login) login.hidden = false;
    if (message) {
      text('login-error', message);
    } else {
      text('login-error', '');
    }
    var input = byId('pin-input');
    if (input) {
      input.value = '';
      input.classList.remove('is-invalid');
      setTimeout(function () {
        try { input.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
      }, 60);
    }
  }

  function showApp(session) {
    state.session = true;
    state.usingDefaultPin = !!(session && session.usingDefaultPin);
    applySecurity(state.usingDefaultPin);

    var boot = byId('boot-view');
    var login = byId('login-view');
    var app = byId('app');
    if (boot) boot.hidden = true;
    if (login) login.hidden = true;
    if (app) app.hidden = false;
    text('login-error', '');

    setView('queue');

    Promise.allSettled([
      loadQueue({ silent: true }),
      loadNetwork(),
      loadDiagnostics(),
      loadSettings({ silent: true })
    ]).then(function () {
      connectEvents();
      startPolling();
    });
  }

  function applySecurity(usingDefault) {
    state.usingDefaultPin = !!usingDefault;
    var pill = byId('default-pin-pill');
    if (pill) pill.hidden = !state.usingDefaultPin;
    var pinPill = byId('pin-state-pill');
    if (pinPill) {
      pinPill.textContent = state.usingDefaultPin ? 'Default PIN 1234' : 'Custom PIN set';
      pinPill.classList.toggle('pill-gold', state.usingDefaultPin);
      pinPill.classList.toggle('pill-green', !state.usingDefaultPin);
    }
  }

  function singleSubmit(form, handler) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      handler(form);
    });
  }

  function bindEvents() {
    singleSubmit(byId('login-form'), function () {
      var input = byId('pin-input');
      var pin = valueOf('pin-input');
      var error = byId('login-error');
      input.classList.remove('is-invalid');
      if (!/^\d{4,12}$/.test(pin)) {
        if (error) error.textContent = 'The PIN must be 4 to 12 digits.';
        input.classList.add('is-invalid');
        input.focus();
        return;
      }
      var button = byId('login-submit');
      SPG.setBusy(button, true, 'Checking…');
      SPG.api('/api/auth/login', { method: 'POST', json: { pin: pin } })
        .then(function (res) {
          input.value = '';
          showApp(res);
          SPG.toast('Console unlocked. Live queue connected.', 'ok');
        })
        .catch(function (err) {
          if (error) error.textContent = (err && err.message) || 'Sign in failed.';
          input.classList.add('is-invalid');
          input.value = '';
          setTimeout(function () { input.focus(); }, 20);
        })
        .then(function () {
          SPG.setBusy(button, false);
        });
    });

    var pinToggle = byId('pin-toggle');
    pinToggle.addEventListener('click', function () {
      var input = byId('pin-input');
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      pinToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      pinToggle.setAttribute('aria-label', show ? 'Hide PIN' : 'Show PIN');
      var svg = pinToggle.querySelector('use');
      if (svg) svg.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
      input.focus();
    });

    var help = byId('login-help');
    help.addEventListener('click', function (event) {
      event.preventDefault();
      SPG.toast('The PIN is managed at the counter. Ask the shop owner if you need it reset.', 'ok', 6000);
    });

    byId('logout-btn').addEventListener('click', function () {
      if (!window.confirm('Lock the operator console? The customer portal stays online.')) return;
      SPG.api('/api/auth/logout', { method: 'POST' })
        .catch(function () { /* ignore */ })
        .then(function () {
          showLogin('Console locked. Enter the PIN to continue.');
          SPG.toast('Console locked.', 'ok');
        });
    });

    var navs = SPG.$$('[data-view]');
    navs.forEach(function (button) {
      button.addEventListener('click', function () { setView(button.getAttribute('data-view')); });
    });

    byId('menu-btn').addEventListener('click', function () {
      var sidebar = byId('sidebar');
      var open = !sidebar.classList.contains('is-open');
      sidebar.classList.toggle('is-open', open);
      byId('sidebar-backdrop').classList.toggle('is-open', open);
      byId('menu-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    byId('sidebar-backdrop').addEventListener('click', closeSidebar);

    byId('global-refresh').addEventListener('click', function () { refreshAll(); });
    byId('queue-refresh').addEventListener('click', function () { loadQueue(); });
    byId('history-refresh').addEventListener('click', function () { loadHistory(); });
    byId('mode-settings').addEventListener('click', function () { setView('settings'); });
    byId('diag-refresh').addEventListener('click', function () { loadDiagnostics(true); });
    byId('run-diagnostics').addEventListener('click', function () { loadDiagnostics(true); });

    var search = byId('history-search');
    search.addEventListener('input', SPG.debounce(function () {
      state.history.q = String(search.value || '').trim();
      state.history.offset = 0;
      loadHistory();
    }, 320));

    byId('history-status').addEventListener('change', function () {
      state.history.status = byId('history-status').value;
      state.history.offset = 0;
      loadHistory();
    });
    byId('history-limit').addEventListener('change', function () {
      state.history.limit = Number(byId('history-limit').value) || 50;
      state.history.offset = 0;
      loadHistory();
    });

    singleSubmit(byId('shop-form'), function (form) {
      saveSettingsPatch({
        shop: {
          name: valueOf('shop-name'),
          shortName: valueOf('shop-short-name'),
          phone: valueOf('shop-phone'),
          whatsapp: valueOf('shop-whatsapp'),
          email: valueOf('shop-email'),
          address: valueOf('shop-address'),
          welcome: valueOf('shop-welcome'),
          pickupNote: valueOf('shop-pickup-note'),
          deliveryNote: valueOf('shop-delivery-note'),
          footerNote: valueOf('shop-footer-note')
        }
      }, form.querySelector('button[type="submit"]'));
    });

    singleSubmit(byId('pricing-form'), function (form) {
      saveSettingsPatch({
        pricing: {
          bwBlockPages: numberOf('price-bw-block-pages', 8),
          rates: {
            A4: {
              bwBlockPrice: numberOf('price-a4-bw', 1),
              colorPagePrice: numberOf('price-a4-color', 1)
            },
            A5: {
              bwBlockPrice: numberOf('price-a5-bw', 1),
              colorPagePrice: numberOf('price-a5-color', 1)
            },
            A3: {
              bwPagePrice: numberOf('price-a3-bw', 2),
              colorPagePrice: numberOf('price-a3-color', 3)
            }
          }
        }
      }, form.querySelector('button[type="submit"]'));
    });

    singleSubmit(byId('delivery-form'), function (form) {
      saveSettingsPatch({
        delivery: {
          fee: numberOf('delivery-fee', 10),
          freeThreshold: numberOf('delivery-threshold', 50)
        }
      }, form.querySelector('button[type="submit"]'));
    });

    singleSubmit(byId('server-form'), function (form) {
      saveSettingsPatch({
        server: {
          port: numberOf('server-port', 4173),
          retentionDays: numberOf('server-retention', 30),
          autoRefreshSeconds: numberOf('server-refresh', 15),
          maxFileMB: numberOf('server-max-file', 50),
          maxJobMB: numberOf('server-max-job', 120),
          maxPages: numberOf('server-max-pages', 500),
          sessionHours: numberOf('server-session', 12),
          printTimeoutSeconds: numberOf('server-timeout', 180),
          printMode: valueOf('server-print-mode'),
          defaultPrinterId: valueOf('server-default-printer'),
          sumatraPath: valueOf('server-sumatra'),
          sofficePath: valueOf('server-soffice'),
          lpPath: valueOf('server-lp')
        }
      }, form.querySelector('button[type="submit"]'));
    });

    singleSubmit(byId('pin-form'), function (form) {
      var current = valueOf('pin-current');
      var next = valueOf('pin-new');
      var confirm = valueOf('pin-confirm');
      if (!/^\d{4,12}$/.test(current)) return SPG.toast('Enter your current 4 to 12 digit PIN.', 'error');
      if (!/^\d{4,12}$/.test(next)) return SPG.toast('The new PIN must be 4 to 12 digits.', 'error');
      if (next !== confirm) return SPG.toast('The new PIN and confirmation do not match.', 'error');
      var button = form.querySelector('button[type="submit"]');
      SPG.setBusy(button, true, 'Updating…');
      SPG.api('/api/auth/pin', { method: 'POST', json: { currentPin: current, newPin: next } })
        .then(function (res) {
          applySecurity(res.usingDefaultPin);
          form.reset();
          SPG.toast('Console PIN updated. Other sessions have been signed out.', 'ok');
        })
        .catch(function (err) {
          fail(err, 'The PIN could not be changed.');
        })
        .then(function () {
          SPG.setBusy(button, false);
        });
    });

    byId('add-printer').addEventListener('click', function () {
      state.printerDraft = collectPrinterRows();
      state.printerDraft.push({
        id: '',
        name: '',
        model: '',
        systemName: '',
        location: '',
        capabilities: ['mono', 'duplex'],
        enabled: true
      });
      renderPrinterRows(state.printerDraft);
    });

    byId('save-printers').addEventListener('click', function () {
      savePrinters();
    });

    byId('printer-editor').addEventListener('click', function (event) {
      var remove = event.target.closest ? event.target.closest('.remove-printer') : null;
      if (!remove) return;
      var row = remove.closest('.printer-row');
      var rows = collectPrinterRows();
      var index = Number(row && row.getAttribute('data-row-index'));
      if (isFinite(index) && index >= 0) rows.splice(index, 1);
      state.printerDraft = rows;
      renderPrinterRows(state.printerDraft);
    });

    document.addEventListener('click', function (event) {
      var opener = event.target.closest ? event.target.closest('[data-job-open]') : null;
      if (opener) {
        event.preventDefault();
        openJob(opener.getAttribute('data-job-open'));
        return;
      }
      var accept = event.target.closest ? event.target.closest('[data-job-accept]') : null;
      if (accept) {
        event.preventDefault();
        quickAccept(accept.getAttribute('data-job-accept'), accept);
        return;
      }
      var copy = event.target.closest ? event.target.closest('[data-copy]') : null;
      if (copy) {
        event.preventDefault();
        copyText(copy.getAttribute('data-copy')).then(function (ok) {
          SPG.toast(ok ? 'Address copied.' : 'Copy failed. Select the address and copy it manually.', ok ? 'ok' : 'error');
        });
        return;
      }
      var page = event.target.closest ? event.target.closest('[data-page]') : null;
      if (page) {
        event.preventDefault();
        var direction = page.getAttribute('data-page');
        var pages = Math.max(1, Math.ceil(state.history.total / state.history.limit));
        var current = Math.floor(state.history.offset / state.history.limit) + 1;
        if (direction === 'prev' && current > 1) {
          state.history.offset = Math.max(0, (current - 2) * state.history.limit);
          loadHistory();
        } else if (direction === 'next' && current < pages) {
          state.history.offset = current * state.history.limit;
          loadHistory();
        }
      }
    });

    var modal = byId('job-modal');
    modal.addEventListener('click', function (event) {
      if (event.target === modal || (event.target.closest && event.target.closest('[data-close-modal]'))) {
        setTimeout(function () {
          if (byId('job-modal').hidden) clearJobModal();
        }, 40);
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        setTimeout(function () {
          if (byId('job-modal').hidden) clearJobModal();
        }, 20);
      }
    });

    byId('job-detail-col').addEventListener('click', handleJobAction);
  }

  function closeSidebar() {
    byId('sidebar').classList.remove('is-open');
    byId('sidebar-backdrop').classList.remove('is-open');
    byId('menu-btn').setAttribute('aria-expanded', 'false');
  }

  function setView(view) {
    if (!VIEWS[view]) view = 'queue';
    state.view = view;
    SPG.$$('.nav-item').forEach(function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-view') === view);
    });
    SPG.$$('.view').forEach(function (section) {
      section.hidden = section.id !== 'view-' + view;
    });
    text('view-title', VIEWS[view].title);
    text('view-sub', VIEWS[view].sub);
    closeSidebar();
    if (view === 'history') loadHistory();
    if (view === 'settings' && (!state.settings || Date.now() - (state.settingsLoadedAt || 0) > 60000)) {
      loadSettings();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Live queue                                                         */
  /* ------------------------------------------------------------------ */

  function refreshAll() {
    loadQueue();
    loadNetwork();
    loadDiagnostics();
    if (state.view === 'history') loadHistory();
    if (state.view === 'settings') loadSettings();
    SPG.toast('Dashboard refreshed.', 'ok', 2200);
  }

  function loadQueue(options) {
    var opts = options || {};
    return SPG.api('/api/operator/queue')
      .then(function (data) {
        state.session = true;
        setConnection(true);
        applyQueue(data);
      })
      .catch(function (err) {
        if (err && err.status === 401) {
          fail(err);
          return;
        }
        setConnection(false);
        if (!opts.silent) fail(err, 'The queue could not be loaded.');
      });
  }

  function applyQueue(payload) {
    if (!payload || typeof payload !== 'object') return;
    state.queue = Array.isArray(payload.queue) ? payload.queue : [];
    state.recent = Array.isArray(payload.recent) ? payload.recent : [];
    state.stats = payload.stats || {};
    renderStats();
    renderQueue();
    renderRecent();
    updateCounts();
    if (payload.printMode) {
      applyMode(payload.printMode);
    }
    syncActiveJob();
  }

  function syncActiveJob() {
    var active = state.activeJob;
    if (!active || state.activeJobSyncPending) return;
    var summary = state.queue.concat(state.recent).filter(function (job) {
      return job.id === active.id;
    })[0];
    if (!summary || summary.status === active.status) return;
    state.activeJobSyncPending = true;
    SPG.api('/api/operator/jobs/' + encodeURIComponent(active.id))
      .then(function (res) {
        if (state.activeJob && state.activeJob.id === active.id) {
          state.activeJob = res.job;
          renderJob(res.job);
        }
      })
      .catch(function () { /* keep the current panel */ })
      .then(function () { state.activeJobSyncPending = false; });
  }

  function renderStats() {
    var stats = state.stats || {};
    text('stat-pending', compactNumber(stats.pending || 0));
    text('stat-printing', compactNumber(stats.printing || 0));
    text('stat-completed', compactNumber(stats.completedToday || 0));
    text('stat-revenue', SPG.formatAED(stats.todayRevenue || 0));
  }

  function updateCounts() {
    var pending = Number(state.stats.pending) || 0;
    var printing = Number(state.stats.printing) || 0;
    var total = pending + printing;
    text('nav-queue-count', total);
    text('queue-count-pill', pending + ' waiting' + (printing ? ' · ' + printing + ' printing' : ''));
    text('side-queue', pending + ' waiting' + (printing ? ' · ' + printing + ' printing' : ''));
    var nav = byId('nav-queue-count');
    if (nav) nav.hidden = total === 0;
  }

  function renderQueue() {
    var list = byId('queue-list');
    if (!list) return;
    if (!state.queue.length) {
      list.innerHTML =
        '<div class="empty-state">' +
          '<span class="empty-icon"><svg aria-hidden="true"><use href="#i-check-circle"></use></svg></span>' +
          '<strong>Queue is clear</strong>' +
          '<p>New customer jobs will appear here automatically. Keep this screen open on the shop counter.</p>' +
        '</div>';
      return;
    }

    list.innerHTML = state.queue.map(function (job) {
      var tags = [];
      tags.push('<span class="tag">' + esc(job.paper) + '</span>');
      tags.push('<span class="tag' + (job.color === 'color' ? ' tag-colour' : '') + '">' + (job.color === 'color' ? 'Colour' : 'B&amp;W') + '</span>');
      tags.push('<span class="tag">' + (job.duplex ? 'Double-sided' : 'Single-sided') + '</span>');
      tags.push('<span class="tag">' + esc(job.nup) + '-up</span>');
      tags.push('<span class="tag">' + compactNumber(job.pageCount) + ' ' + plural(Number(job.pageCount) || 0, 'page') + '</span>');
      if (job.copies > 1) tags.push('<span class="tag">×' + compactNumber(job.copies) + ' copies</span>');
      if (job.printReadyPages) tags.push('<span class="tag">' + compactNumber(job.printReadyPages) + ' ' + plural(job.printReadyPages, 'side') + '</span>');
      tags.push('<span class="tag tag-gold">' + esc(paymentLabel(job.payment)) + '</span>');
      tags.push('<span class="tag">' + (job.fulfillment === 'delivery' ? 'Delivery' : 'Pickup') + '</span>');

      var actions = '<button class="btn btn-outline" type="button" data-job-open="' + esc(job.id) + '">Review</button>';
      if (job.status === 'pending') {
        actions += '<button class="btn btn-primary" type="button" data-job-accept="' + esc(job.id) + '">Accept &amp; print</button>';
      }

      var reason = job.rejectionReason || job.error;
      return '<article class="job-card' + (job.status === 'printing' ? ' is-printing' : '') + '" data-job="' + esc(job.id) + '">' +
        '<div>' +
          '<div class="job-top">' +
            (job.queuePosition ? '<span class="queue-pos" title="Queue position">' + esc(job.queuePosition) + '</span>' : '') +
            '<span class="job-id">#' + esc(job.id) + '</span>' +
            statusBadge(job.status) +
            '<span class="job-time">' + esc(SPG.timeAgo(job.createdAt)) + '</span>' +
          '</div>' +
          '<div class="job-customer">' +
            '<span class="job-avatar">' + esc(initials(job.customerName)) + '</span>' +
            '<strong>' + esc(job.customerName) + '</strong>' +
            (job.customerPhone ? '<span>· ' + esc(job.customerPhone) + '</span>' : '') +
            '<span>· ' + esc(fulfilmentLabel(job.fulfillment)) + '</span>' +
          '</div>' +
          '<div class="job-tags">' + tags.join('') + '</div>' +
          (reason ? '<p class="field-hint" style="margin-top:8px;color:var(--danger)">' + esc(reason) + '</p>' : '') +
        '</div>' +
        '<div class="job-side">' +
          '<div class="job-total">' + SPG.formatAED(job.total) + '</div>' +
          '<div class="job-actions">' + actions + '</div>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  function renderRecent() {
    var list = byId('recent-list');
    if (!list) return;
    if (!state.recent.length) {
      list.innerHTML =
        '<div class="empty-state" style="padding:26px 18px">' +
          '<strong>No activity yet</strong>' +
          '<p>Completed and rejected jobs will be listed here.</p>' +
        '</div>';
      return;
    }
    list.innerHTML = state.recent.map(function (job) {
      return '<button class="recent-row" type="button" data-job-open="' + esc(job.id) + '">' +
        '<span class="rr-main">' +
          '<span class="rr-id">#' + esc(job.id) + '</span>' +
          '<span class="rr-sub">' + esc(job.customerName) + ' · ' + esc(SPG.statusLabel(job.status)) + '</span>' +
        '</span>' +
        '<span class="rr-total">' + SPG.formatAED(job.total) + '</span>' +
      '</button>';
    }).join('');
  }

  function quickAccept(jobId, button) {
    if (!window.confirm('Accept job #' + jobId + ' and send it to the default printer?\n\nThe customer is charged ' + 'the amount shown in the job.')) return;
    SPG.setBusy(button, true, 'Sending…');
    SPG.api('/api/operator/jobs/' + encodeURIComponent(jobId) + '/accept', {
      method: 'POST',
      json: {}
    })
      .then(function () {
        SPG.toast('Job accepted. Sending the print-ready file to the printer.', 'ok');
        return loadQueue();
      })
      .catch(function (err) {
        fail(err, 'The job could not be accepted.');
      })
      .then(function () {
        SPG.setBusy(button, false);
      });
  }

  /* ------------------------------------------------------------------ */
  /* Live updates                                                       */
  /* ------------------------------------------------------------------ */

  function connectEvents() {
    stopLive();
    if (typeof EventSource === 'undefined') {
      setConnection(false);
      return;
    }
    var source = new EventSource('/api/operator/events');
    state.sse = source;

    source.onopen = function () { setConnection(true); };
    source.addEventListener('update', function (event) {
      setConnection(true);
      try {
        var payload = JSON.parse(event.data);
        if (payload && payload.type === 'queue') applyQueue(payload.data);
      } catch (err) { /* ignore malformed events */ }
    });
    source.onerror = function () {
      setConnection(false);
    };
  }

  function setConnection(online) {
    var pill = byId('conn-pill');
    if (pill) {
      pill.classList.toggle('is-warn', !online);
      pill.classList.toggle('is-off', !online);
    }
    text('conn-pill-text', online ? 'Live updates' : 'Reconnecting');
    text('side-conn', online ? 'Live' : 'Reconnecting…');
  }

  function startPolling() {
    stopPolling();
    var seconds = Math.max(5, Number(state.refreshSeconds) || 15);
    state.pollTimer = setInterval(function () {
      loadQueue({ silent: true });
    }, seconds * 1000);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function stopLive() {
    stopPolling();
    if (state.sseRetryTimer) clearTimeout(state.sseRetryTimer);
    state.sseRetryTimer = null;
    if (state.sse) {
      try { state.sse.close(); } catch (err) { /* ignore */ }
      state.sse = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Network / QR                                                       */
  /* ------------------------------------------------------------------ */

  function loadNetwork() {
    return SPG.api('/api/operator/network')
      .then(function (res) {
        state.network = res.network || null;
        renderNetwork();
      })
      .catch(function (err) { fail(err, 'The network address could not be loaded.'); });
  }

  function renderNetwork() {
    var network = state.network;
    var box = byId('qr-box');
    if (!network || !box) {
      if (box) box.innerHTML = '<span class="field-hint">No LAN address detected.</span>';
      return;
    }
    var primary = network.primaryUrl || network.localUrl || '';
    box.innerHTML = network.qrSvg || '<span class="field-hint">QR unavailable.</span>';
    text('qr-url', primary);

    var list = byId('network-list');
    if (!list) return;
    var urls = Array.isArray(network.urls) ? network.urls : [];
    if (!urls.length) {
      list.innerHTML = '<p class="qr-hint">No LAN IPv4 address was detected. Connect this computer to the shop Wi-Fi or router, then refresh.</p>';
      return;
    }
    list.innerHTML = urls.map(function (item) {
      return '<div class="network-row">' +
        '<span class="nr-name" title="' + esc(item.name) + '">' + esc(item.name) + '</span>' +
        '<span class="nr-url">' + esc(item.url) + '</span>' +
        '<button type="button" data-copy="' + esc(item.url) + '">Copy</button>' +
      '</div>';
    }).join('');
  }

  /* ------------------------------------------------------------------ */
  /* Diagnostics / print mode                                           */
  /* ------------------------------------------------------------------ */

  function loadDiagnostics(showToast) {
    return SPG.api('/api/operator/diagnostics')
      .then(function (res) {
        state.diagnostics = res.diagnostics || null;
        renderDiagnostics();
        renderModePanel();
        applyMode(state.diagnostics && state.diagnostics.mode);
        if (showToast) SPG.toast('Diagnostics refreshed.', 'ok', 2400);
      })
      .catch(function (err) { fail(err, 'Diagnostics could not be loaded.'); });
  }

  function applyMode(mode) {
    var live = mode === 'live';
    var pill = byId('mode-pill');
    if (pill) {
      pill.classList.toggle('is-warn', !live);
      pill.classList.toggle('is-off', !live);
    }
    text('mode-pill-text', live ? 'Live printing' : 'Simulate mode');
    text('side-mode', live ? 'Live printing' : 'Simulate');
    var statePill = byId('mode-state-pill');
    if (statePill) {
      statePill.textContent = live ? 'Live' : 'Simulate';
      statePill.classList.toggle('pill-green', live);
      statePill.classList.toggle('pill-gold', !live);
    }
    var serverPill = byId('server-mode-pill');
    if (serverPill) {
      serverPill.textContent = live ? 'Live printing' : 'Simulate mode';
      serverPill.classList.toggle('pill-green', live);
      serverPill.classList.toggle('pill-gold', !live);
    }
  }

  function renderModePanel() {
    var d = state.diagnostics;
    var dot = byId('mode-dot');
    var headline = byId('mode-headline');
    var note = byId('mode-note');
    var printers = byId('mode-printers');
    if (!d) {
      if (headline) headline.textContent = 'Driver status unavailable';
      return;
    }

    var live = d.mode === 'live';
    var ready = !!d.ready;
    if (dot) dot.classList.toggle('is-live', live && ready);
    if (headline) {
      headline.textContent = live
        ? (ready ? 'Live printing is ready' : 'Live mode needs attention')
        : 'Simulate mode — safe testing';
    }
    if (note) note.textContent = d.note || '';
    if (printers) {
      var enabled = (d.printers || []).filter(function (printer) { return printer.enabled; });
      printers.innerHTML = enabled.map(function (printer) {
        return '<div class="printer-mini">' +
          '<svg aria-hidden="true"><use href="#i-print"></use></svg>' +
          '<span class="pm-name">' + esc(printer.name) + '</span>' +
          '<span class="pm-loc">' + esc(printer.location || '') + '</span>' +
        '</div>';
      }).join('');
    }
    applyMode(d.mode);
  }

  function renderDiagnostics() {
    var grid = byId('diagnostics-grid');
    var d = state.diagnostics;
    if (!grid) return;
    if (!d) {
      grid.innerHTML = '<div class="diag-row"><span>Status</span><strong class="is-warn">Unavailable</strong></div>';
      return;
    }

    function row(label, value, tone, title) {
      return '<div class="diag-row"><span>' + esc(label) + '</span><strong' +
        (tone ? ' class="' + tone + '"' : '') +
        (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(value) + '</strong></div>';
    }

    var pathTone = function (value) { return value ? 'is-ok' : 'is-warn'; };
    var rows = [];
    rows.push(row('Print mode', d.mode === 'live' ? 'Live' : 'Simulate', d.mode === 'live' ? 'is-ok' : 'is-warn'));
    rows.push(row('Driver ready', d.ready ? 'Yes' : 'No', d.ready ? 'is-ok' : 'is-warn'));
    rows.push(row('SumatraPDF', d.sumatra ? 'Detected' : 'Not found', pathTone(d.sumatra), d.sumatra || ''));
    rows.push(row('CUPS lp', d.lp ? 'Detected' : 'Not found', d.lp ? 'is-ok' : '', d.lp || ''));
    rows.push(row('Word converter', d.wordConversion ? 'Available' : 'Unavailable', d.wordConversion ? 'is-ok' : 'is-warn'));
    rows.push(row('LibreOffice', d.soffice ? 'Detected' : 'Not found', pathTone(d.soffice), d.soffice || ''));
    rows.push(row('Microsoft Word', d.word ? 'Detected' : 'Not found', pathTone(d.word), d.word || ''));
    rows.push(row('Node.js', d.node || '—'));
    rows.push(row('Platform', d.platform || '—'));
    rows.push(row('Uptime', duration(d.uptimeSeconds)));
    rows.push(row('Port', d.port || '—'));
    rows.push(row('Stored files', SPG.formatBytes(d.dataBytes || 0)));
    rows.push(row('Jobs on record', compactNumber(d.jobs || 0)));
    rows.push(row('Console PIN', state.usingDefaultPin ? 'Default 1234' : 'Custom', state.usingDefaultPin ? 'is-warn' : 'is-ok'));
    grid.innerHTML = rows.join('');
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */

  function loadSettings(options) {
    var opts = options || {};
    return SPG.api('/api/operator/settings')
      .then(function (res) {
        applySettings(res);
      })
      .catch(function (err) {
        if (!opts.silent) fail(err, 'Settings could not be loaded.');
      });
  }

  function applySettings(res) {
    if (!res || !res.settings) return;
    state.settings = res.settings;
    state.settingsLoadedAt = Date.now();
    if (res.diagnostics) {
      state.diagnostics = Object.assign({}, state.diagnostics || {}, res.diagnostics);
    }
    if (res.security && res.security.usingDefaultPin != null) {
      applySecurity(res.security.usingDefaultPin);
    }
    state.refreshSeconds = Math.max(5, Number(state.settings.server.autoRefreshSeconds) || 15);
    state.printerDraft = (state.settings.printers || []).map(function (printer) {
      return JSON.parse(JSON.stringify(printer));
    });
    fillShop();
    fillPricing();
    fillDelivery();
    fillServer();
    renderPrinterRows(state.printerDraft);
    renderDiagnostics();
    renderModePanel();
    applyMode(state.settings.server.printMode);
    startPolling();
  }

  function fillShop() {
    var shop = (state.settings && state.settings.shop) || {};
    setValue('shop-name', shop.name);
    setValue('shop-short-name', shop.shortName);
    setValue('shop-phone', shop.phone);
    setValue('shop-whatsapp', shop.whatsapp);
    setValue('shop-email', shop.email);
    setValue('shop-address', shop.address);
    setValue('shop-welcome', shop.welcome);
    setValue('shop-pickup-note', shop.pickupNote);
    setValue('shop-delivery-note', shop.deliveryNote);
    setValue('shop-footer-note', shop.footerNote);
  }

  function fillPricing() {
    var pricing = (state.settings && state.settings.pricing) || {};
    var rates = pricing.rates || {};
    setValue('price-bw-block-pages', pricing.bwBlockPages || 8);
    setValue('price-a4-bw', ((rates.A4 || {}).bwBlockPrice));
    setValue('price-a4-color', ((rates.A4 || {}).colorPagePrice));
    setValue('price-a5-bw', ((rates.A5 || {}).bwBlockPrice));
    setValue('price-a5-color', ((rates.A5 || {}).colorPagePrice));
    setValue('price-a3-bw', ((rates.A3 || {}).bwPagePrice));
    setValue('price-a3-color', ((rates.A3 || {}).colorPagePrice));
  }

  function fillDelivery() {
    var delivery = (state.settings && state.settings.delivery) || {};
    setValue('delivery-fee', delivery.fee);
    setValue('delivery-threshold', delivery.freeThreshold);
  }

  function fillServer() {
    var server = (state.settings && state.settings.server) || {};
    setValue('server-print-mode', server.printMode === 'live' ? 'live' : 'simulate');
    fillDefaultPrinters(server.defaultPrinterId);
    setValue('server-retention', server.retentionDays);
    setValue('server-refresh', server.autoRefreshSeconds);
    setValue('server-max-file', server.maxFileMB);
    setValue('server-max-job', server.maxJobMB);
    setValue('server-max-pages', server.maxPages);
    setValue('server-session', server.sessionHours);
    setValue('server-timeout', server.printTimeoutSeconds);
    setValue('server-port', server.port);
    setValue('server-sumatra', server.sumatraPath);
    setValue('server-soffice', server.sofficePath);
    setValue('server-lp', server.lpPath);
  }

  function fillDefaultPrinters(selected) {
    var select = byId('server-default-printer');
    if (!select) return;
    var printers = (state.settings && state.settings.printers) || [];
    select.innerHTML = printers.map(function (printer) {
      return '<option value="' + esc(printer.id) + '">' + esc(printer.name) +
        (printer.enabled ? '' : ' (disabled)') + '</option>';
    }).join('');
    if (selected) select.value = selected;
    if (!select.value && printers.length) select.value = printers[0].id;
  }

  function setValue(id, value) {
    var node = byId(id);
    if (!node) return;
    node.value = value == null ? '' : String(value);
  }

  function saveSettingsPatch(patch, button, successMessage) {
    var previousPort = state.settings && state.settings.server ? state.settings.server.port : null;
    SPG.setBusy(button, true, 'Saving…');
    return SPG.api('/api/operator/settings', { method: 'PUT', json: patch })
      .then(function (res) {
        applySettings(res);
        SPG.toast(successMessage || 'Settings saved.', 'ok');
        if (patch.server && previousPort != null && Number(patch.server.port) !== Number(previousPort)) {
          SPG.toast('Restart the Node.js gateway to use the new port.', 'ok', 7000);
        }
        return true;
      })
      .catch(function (err) {
        fail(err, 'Settings could not be saved.');
        return false;
      })
      .then(function (result) {
        SPG.setBusy(button, false);
        return result;
      });
  }

  /* ------------------------------------------------------------------ */
  /* Printer editor                                                     */
  /* ------------------------------------------------------------------ */

  function renderPrinterRows(printers) {
    var editor = byId('printer-editor');
    if (!editor) return;
    if (!printers || !printers.length) {
      editor.innerHTML = '<div class="empty-state" style="padding:26px 18px"><strong>No printers configured</strong><p>Add at least one printer so jobs can be accepted.</p></div>';
      return;
    }
    editor.innerHTML = printers.map(function (printer, index) {
      return '<div class="printer-row" data-row-index="' + index + '" data-printer-id="' + esc(printer.id || '') + '">' +
        '<label class="field">' +
          '<span class="field-label">Printer name</span>' +
          '<input class="input" type="text" maxlength="80" data-field="name" value="' + esc(printer.name || '') + '" placeholder="Canon iR-ADV">' +
        '</label>' +
        '<label class="field">' +
          '<span class="field-label">Windows / CUPS queue</span>' +
          '<input class="input" type="text" maxlength="160" data-field="systemName" value="' + esc(printer.systemName || '') + '" placeholder="Canon iR-ADV C5760i">' +
        '</label>' +
        '<label class="field">' +
          '<span class="field-label">Location</span>' +
          '<input class="input" type="text" maxlength="100" data-field="location" value="' + esc(printer.location || '') + '" placeholder="Counter 1">' +
        '</label>' +
        '<label class="toggle enabled-toggle">' +
          '<input type="checkbox" data-field="enabled"' + (printer.enabled !== false ? ' checked' : '') + '>' +
          '<span class="track"></span>' +
          '<span class="label-text">Enabled</span>' +
        '</label>' +
        '<button class="remove-printer" type="button" aria-label="Remove printer" title="Remove printer">' +
          '<svg aria-hidden="true"><use href="#i-trash"></use></svg>' +
        '</button>' +
      '</div>';
    }).join('');
  }

  function collectPrinterRows() {
    var editor = byId('printer-editor');
    if (!editor) return [];
    var rows = SPG.$$('.printer-row', editor);
    return rows.map(function (row, index) {
      var existing = (state.settings && state.settings.printers || []).filter(function (printer) {
        return printer.id && printer.id === row.getAttribute('data-printer-id');
      })[0];
      var name = row.querySelector('[data-field="name"]');
      var systemName = row.querySelector('[data-field="systemName"]');
      var location = row.querySelector('[data-field="location"]');
      var enabled = row.querySelector('[data-field="enabled"]');
      return {
        id: row.getAttribute('data-printer-id') || '',
        name: name ? String(name.value || '').trim() : '',
        systemName: systemName ? String(systemName.value || '').trim() : '',
        location: location ? String(location.value || '').trim() : '',
        model: existing ? existing.model : '',
        capabilities: existing ? existing.capabilities : ['mono', 'duplex'],
        enabled: enabled ? !!enabled.checked : true,
        index: index
      };
    });
  }

  function slugId(name, index, used) {
    var base = 'printer-' + String(name || (index + 1)).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 44);
    if (!base || base === 'printer-') base = 'printer-' + (index + 1);
    var id = base;
    var suffix = 2;
    while (used.indexOf(id) >= 0) {
      id = base + '-' + suffix;
      suffix += 1;
    }
    used.push(id);
    return id;
  }

  function savePrinters() {
    var rows = collectPrinterRows();
    if (!rows.length) {
      SPG.toast('Add at least one printer before saving.', 'error');
      return;
    }
    var used = [];
    var printers = rows.map(function (row, index) {
      var id = row.id || slugId(row.name, index, used);
      if (used.indexOf(id) >= 0) id = slugId(row.name, index, used);
      else used.push(id);
      return {
        id: id,
        name: row.name || ('Printer ' + (index + 1)),
        model: row.model || '',
        systemName: row.systemName,
        location: row.location,
        capabilities: row.capabilities && row.capabilities.length ? row.capabilities : ['mono', 'duplex'],
        enabled: row.enabled !== false
      };
    });
    var button = byId('save-printers');
    saveSettingsPatch({ printers: printers }, button, 'Printer list saved.').then(function (ok) {
      if (!ok) return;
      var missing = printers.filter(function (printer) { return !printer.systemName; });
      if (missing.length) {
        SPG.toast('Add the exact Windows or CUPS queue name before live printing.', 'error', 8000);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* History                                                            */
  /* ------------------------------------------------------------------ */

  function loadHistory() {
    if (state.history.loading) return;
    state.history.loading = true;
    var query = new URLSearchParams();
    if (state.history.status && state.history.status !== 'all') query.set('status', state.history.status);
    if (state.history.q) query.set('q', state.history.q);
    query.set('limit', String(state.history.limit));
    query.set('offset', String(state.history.offset));
    byId('history-refresh').disabled = true;

    SPG.api('/api/operator/jobs?' + query.toString())
      .then(function (res) {
        state.history.total = Number(res.total) || 0;
        state.historyLoadedAt = Date.now();
        renderHistory(res.jobs || []);
      })
      .catch(function (err) {
        fail(err, 'Job history could not be loaded.');
      })
      .then(function () {
        state.history.loading = false;
        byId('history-refresh').disabled = false;
      });
  }

  function renderHistory(jobs) {
    var body = byId('history-body');
    if (!body) return;
    text('history-total-pill', compactNumber(state.history.total) + ' ' + plural(state.history.total, 'job'));

    if (!jobs.length) {
      body.innerHTML = '<tr><td colspan="8">' +
        '<div class="empty-state"><span class="empty-icon"><svg aria-hidden="true"><use href="#i-search"></use></svg></span>' +
        '<strong>No jobs found</strong><p>Try another search or status filter. New jobs will appear as customers send them.</p></div>' +
      '</td></tr>';
    } else {
      body.innerHTML = jobs.map(function (job) {
        var details = compactNumber(job.pageCount) + ' ' + plural(Number(job.pageCount) || 0, 'page') +
          ' · ' + esc(job.paper) +
          ' · ' + (job.color === 'color' ? 'Colour' : 'B&amp;W') +
          ' · ' + (job.duplex ? 'Duplex' : 'Single') +
          ' · ' + esc(job.nup) + '-up' +
          (job.copies > 1 ? ' · ×' + compactNumber(job.copies) : '');
        var actions = '<button class="btn btn-ghost btn-sm" type="button" data-job-open="' + esc(job.id) + '">Review</button>';
        if (job.status === 'pending') {
          actions += ' <button class="btn btn-primary btn-sm" type="button" data-job-accept="' + esc(job.id) + '">Accept</button>';
        }
        return '<tr>' +
          '<td class="cell-id">#' + esc(job.id) + '</td>' +
          '<td>' + esc(SPG.formatDateTime(job.createdAt)) + '</td>' +
          '<td>' + esc(job.customerName) + (job.customerPhone ? '<div class="tiny muted">' + esc(job.customerPhone) + '</div>' : '') + '</td>' +
          '<td>' + details + '</td>' +
          '<td>' + esc(fulfilmentLabel(job.fulfillment)) + ' · ' + esc(paymentLabel(job.payment)) + '</td>' +
          '<td>' + statusBadge(job.status) + '</td>' +
          '<td class="cell-total">' + SPG.formatAED(job.total) + '</td>' +
          '<td class="cell-actions">' + actions + '</td>' +
        '</tr>';
      }).join('');
    }

    var total = state.history.total;
    var limit = state.history.limit;
    var offset = state.history.offset;
    var from = total ? offset + 1 : 0;
    var to = Math.min(offset + limit, total);
    text('history-foot', total
      ? 'Showing ' + from + '–' + to + ' of ' + compactNumber(total) + ' ' + plural(total, 'job') + '.'
      : 'No jobs match the current filter.');

    var pages = Math.max(1, Math.ceil(total / limit));
    var current = Math.min(pages, Math.floor(offset / limit) + 1);
    html('history-page-label',
      '<button class="btn btn-ghost btn-sm" type="button" data-page="prev"' + (current <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<span style="display:inline-block;margin:0 8px">Page ' + current + ' of ' + pages + '</span>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-page="next"' + (current >= pages ? ' disabled' : '') + '>Next</button>'
    );
  }

  /* ------------------------------------------------------------------ */
  /* Job detail                                                         */
  /* ------------------------------------------------------------------ */

  function clearJobModal() {
    state.activeJob = null;
    var frame = byId('job-preview-frame');
    if (frame) frame.src = 'about:blank';
  }

  function openJob(jobId) {
    if (!jobId) return;
    SPG.openModal('job-modal');
    byId('job-loading').hidden = false;
    byId('job-loading').innerHTML = '<span class="spinner is-dark" aria-hidden="true"></span><span>Loading job…</span>';
    byId('job-modal-grid').hidden = true;
    byId('job-preview-fallback').hidden = true;
    text('job-modal-title', 'Job #' + jobId);
    html('job-modal-meta', '');
    var frame = byId('job-preview-frame');
    frame.hidden = false;
    frame.src = 'about:blank';

    SPG.api('/api/operator/jobs/' + encodeURIComponent(jobId))
      .then(function (res) {
        state.activeJob = res.job;
        renderJob(res.job);
      })
      .catch(function (err) {
        byId('job-loading').innerHTML = '<strong>Job could not be loaded</strong><span>' + esc((err && err.message) || 'Try again.') + '</span>';
        fail(err);
      });
  }

  function renderJob(job) {
    byId('job-loading').hidden = true;
    byId('job-modal-grid').hidden = false;

    text('job-modal-title', 'Job #' + job.id);
    html('job-modal-meta',
      statusBadge(job.status) +
      '<span>' + esc(SPG.formatDateTime(job.createdAt)) + '</span>' +
      '<span>· ' + esc(paymentLabel(job.payment)) + '</span>' +
      '<span>· ' + esc(fulfilmentLabel(job.fulfillment)) + '</span>' +
      (job.printer ? '<span>· ' + esc(job.printer.name) + '</span>' : '')
    );

    renderJobPreview(job);
    renderJobDetail(job);
  }

  function renderJobPreview(job) {
    var frame = byId('job-preview-frame');
    var fallback = byId('job-preview-fallback');
    var open = byId('job-open-pdf');
    var download = byId('job-download-pdf');
    var hasPdf = !!(job.printReady && job.printReady.storedName);
    var base = '/api/operator/jobs/' + encodeURIComponent(job.id) + '/print-ready';

    if (hasPdf) {
      frame.hidden = false;
      fallback.hidden = true;
      var previewSrc = base + '#toolbar=1&navpanes=0&view=FitH';
      if (frame.getAttribute('src') !== previewSrc) frame.src = previewSrc;
      open.href = base;
      open.hidden = false;
      download.href = base;
      download.setAttribute('download', job.id + '-print-ready.pdf');
      download.hidden = false;
    } else {
      frame.hidden = true;
      frame.src = 'about:blank';
      fallback.hidden = false;
      open.hidden = true;
      download.hidden = true;
    }
  }

  function renderJobDetail(job) {
    var customer = job.customer || {};
    var settings = job.settings || {};
    var plan = job.plan || {};
    var pricing = job.pricing || {};
    var printerName = job.printer ? job.printer.name : 'Not assigned';

    var details = [
      ['Selected pages', compactNumber(job.pageCount)],
      ['Document pages', compactNumber(job.totalDocumentPages)],
      ['Copies', compactNumber(settings.copies || 1)],
      ['Paper', settings.paper || 'A4'],
      ['Ink', settings.color === 'color' ? 'Colour' : 'Black & white'],
      ['Sides', settings.duplex ? 'Double-sided' : 'Single-sided'],
      ['Layout', (settings.nup || 1) + '-up'],
      ['Orientation', orientationLabel(settings.orientation)],
      ['Page range', pageRangeLabel(settings)],
      ['Output sides', compactNumber(plan.outputSides || (job.printReady && job.printReady.pages) || 0)],
      ['Print queue', printerName]
    ];
    if (job.queuePosition) details.push(['Queue position', job.queuePosition]);

    var rows = details.map(function (row) {
      return '<div class="dl-row"><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '</strong></div>';
    }).join('');

    var priceRows = '';
    if (pricing.printTotal != null) {
      priceRows += '<div class="price-box-row"><span>Printing (VAT included)</span><strong>' + SPG.formatAED(pricing.printTotal) + '</strong></div>';
    }
    if (pricing.fulfillment === 'delivery') {
      priceRows += '<div class="price-box-row"><span>Home delivery' +
        (pricing.freeDelivery ? ' · free' : '') + '</span><strong>' +
        (pricing.freeDelivery ? 'AED 0.00' : SPG.formatAED(pricing.deliveryFee)) + '</strong></div>';
    }
    priceRows += '<div class="price-box-row is-total"><span>Total to pay</span><strong>' + SPG.formatAED(pricing.total != null ? pricing.total : job.total) + '</strong></div>';
    if (pricing.subtotalExVat != null) {
      priceRows += '<div class="price-box-row"><span>Subtotal before VAT</span><strong>' + SPG.formatAED(pricing.subtotalExVat) + '</strong></div>';
      priceRows += '<div class="price-box-row"><span>Included VAT (5%)</span><strong>' + SPG.formatAED(pricing.vat) + '</strong></div>';
    }

    var files = (job.documents || []).map(function (doc) {
      var docUrl = '/api/operator/jobs/' + encodeURIComponent(job.id) + '/docs/' + encodeURIComponent(doc.id);
      return '<div class="job-file">' +
        '<svg aria-hidden="true"><use href="#i-file"></use></svg>' +
        '<span class="jf-name" title="' + esc(doc.name) + '">' + esc(doc.name) + '</span>' +
        '<span>' + compactNumber(doc.pageCount || 0) + 'p · ' + SPG.formatBytes(doc.size || 0) + '</span>' +
        '<a href="' + docUrl + '" target="_blank" rel="noopener">View</a>' +
      '</div>';
    }).join('');

    var timeline = (job.timeline || []).map(function (entry) {
      var tone = entry.status === 'completed' ? ' is-good' :
        (entry.status === 'failed' || entry.status === 'rejected' || entry.status === 'cancelled' ? ' is-bad' : '');
      return '<div class="timeline-item' + tone + '">' +
        '<span class="timeline-dot"></span>' +
        '<div>' +
          '<div class="timeline-msg">' + esc(entry.message) + '</div>' +
          '<div class="timeline-meta">' + esc(SPG.formatDateTime(entry.at)) + ' · ' + esc(entry.actor || 'system') + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    var actions = renderJobActions(job);

    html('job-detail-col',
      '<div class="job-section">' +
        '<h3>Customer</h3>' +
        '<div class="job-customer-card">' +
          '<span class="job-customer-avatar">' + esc(initials(customer.name)) + '</span>' +
          '<div class="jc-main">' +
            '<div class="jc-name">' + esc(customer.name || 'Walk-in customer') + '</div>' +
            '<div class="jc-meta">' + esc(customer.phone || 'No phone given') + '</div>' +
            '<div class="jc-meta">' + esc(fulfilmentLabel(job.fulfillment)) +
              (customer.address ? ' · ' + esc(customer.address) : '') + '</div>' +
          '</div>' +
        '</div>' +
        (customer.note ? '<p class="field-hint" style="margin-top:8px">Customer note: ' + esc(customer.note) + '</p>' : '') +
      '</div>' +
      '<div class="job-section">' +
        '<h3>Job settings</h3>' +
        '<div class="detail-list">' + rows + '</div>' +
      '</div>' +
      '<div class="job-section">' +
        '<h3>Price · AED, VAT inclusive</h3>' +
        '<div class="price-box">' + priceRows + '</div>' +
      '</div>' +
      '<div class="job-section">' +
        '<h3>Files</h3>' +
        '<div class="job-files">' + (files || '<p class="field-hint">No files on record.</p>') + '</div>' +
      '</div>' +
      '<div class="job-section">' +
        '<h3>Timeline</h3>' +
        '<div class="timeline">' + (timeline || '<p class="field-hint">No events yet.</p>') + '</div>' +
      '</div>' +
      '<div class="job-section">' +
        '<h3>Actions</h3>' + actions +
      '</div>'
    );
  }

  function printerSelectOptions(selected) {
    var printers = ((state.settings && state.settings.printers) || []).filter(function (printer) {
      return printer.enabled !== false;
    });
    if (!printers.length) return '<option value="">No enabled printer</option>';
    return printers.map(function (printer) {
      return '<option value="' + esc(printer.id) + '"' + (printer.id === selected ? ' selected' : '') + '>' +
        esc(printer.name) + (printer.location ? ' · ' + esc(printer.location) : '') + '</option>';
    }).join('');
  }

  function renderJobActions(job) {
    var printing = job.status === 'printing';
    var canAccept = job.canAccept || job.status === 'pending';
    var canReprint = job.canReprint || ['completed', 'failed', 'rejected'].indexOf(job.status) >= 0;
    var canDelete = job.canDelete !== false && !printing;
    var selected = job.printer ? job.printer.id : (job.printerId || '');
    var box = '<div class="job-action-box">';

    if (canAccept) {
      box += '<label class="field"><span class="field-label">Send to printer</span>' +
        '<select class="select" id="job-printer">' + printerSelectOptions(selected) + '</select></label>' +
        '<div class="job-action-row">' +
          '<button class="btn btn-primary" type="button" data-action="accept">Accept &amp; print</button>' +
          '<button class="btn btn-outline" type="button" data-action="reject-toggle">Reject…</button>' +
        '</div>' +
        '<div class="reject-box" id="job-reject-box" hidden>' +
          '<label class="field-label" for="job-reject-reason">Reason shown to the customer</label>' +
          '<textarea class="textarea" id="job-reject-reason" maxlength="240" rows="2" placeholder="For example: the file is password-protected or unreadable."></textarea>' +
          '<button class="btn btn-danger" type="button" data-action="reject">Confirm rejection</button>' +
        '</div>';
    } else if (printing) {
      box += '<p class="field-hint">The printer is working on this job. This panel refreshes when you reopen it.</p>' +
        '<div class="job-action-row">' +
          '<button class="btn btn-outline" type="button" data-action="refresh">Refresh status</button>' +
          '<button class="btn btn-outline" type="button" data-action="complete">Mark complete</button>' +
        '</div>';
    } else {
      if (canReprint) {
        box += '<label class="field"><span class="field-label">Send to printer</span>' +
          '<select class="select" id="job-printer">' + printerSelectOptions(selected) + '</select></label>' +
          '<button class="btn btn-gold btn-block" type="button" data-action="reprint">Reprint job</button>';
      }
      box += '<div class="job-action-row">' +
        '<button class="btn btn-outline" type="button" data-action="refresh">Refresh</button>' +
        (job.status !== 'completed' ? '<button class="btn btn-outline" type="button" data-action="complete">Mark complete</button>' : '') +
      '</div>';
    }

    if (canDelete) {
      box += '<button class="btn btn-danger btn-block" type="button" data-action="delete">Delete job &amp; files</button>';
    }
    box += '</div>';
    return box;
  }

  function handleJobAction(event) {
    var button = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!button) return;
    var action = button.getAttribute('data-action');
    var job = state.activeJob;
    if (!job) return;

    if (action === 'refresh') {
      openJob(job.id);
      return;
    }

    if (action === 'reject-toggle') {
      var box = byId('job-reject-box');
      if (box) {
        box.hidden = !box.hidden;
        if (!box.hidden) {
          var reason = byId('job-reject-reason');
          if (reason) setTimeout(function () { reason.focus(); }, 30);
        }
      }
      return;
    }

    if (action === 'accept') {
      var select = byId('job-printer');
      var printerId = select ? select.value : '';
      if (!printerId) {
        SPG.toast('Choose an enabled printer first.', 'error');
        return;
      }
      if (!window.confirm('Accept job #' + job.id + ' and send it to the selected printer?')) return;
      runJobAction(button, job.id, 'accept', { printerId: printerId }, 'Job accepted. Sending to the printer.');
      return;
    }

    if (action === 'reject') {
      var textarea = byId('job-reject-reason');
      var reason = textarea ? String(textarea.value || '').trim() : '';
      if (reason.length < 3) {
        SPG.toast('Enter a short reason for the customer.', 'error');
        if (textarea) textarea.focus();
        return;
      }
      if (!window.confirm('Reject job #' + job.id + '? The customer will see this reason and will not be charged.')) return;
      runJobAction(button, job.id, 'reject', { reason: reason }, 'Job rejected. The customer will see the reason.');
      return;
    }

    if (action === 'reprint') {
      var reprintSelect = byId('job-printer');
      var reprintPrinter = reprintSelect ? reprintSelect.value : '';
      if (!reprintPrinter) {
        SPG.toast('Choose an enabled printer first.', 'error');
        return;
      }
      if (!window.confirm('Reprint job #' + job.id + '? This sends the print-ready file again.')) return;
      runJobAction(button, job.id, 'reprint', { printerId: reprintPrinter }, 'Reprint queued.');
      return;
    }

    if (action === 'complete') {
      if (!window.confirm('Mark job #' + job.id + ' as completed and collected?')) return;
      runJobAction(button, job.id, 'complete', {}, 'Job marked complete.');
      return;
    }

    if (action === 'delete') {
      if (!window.confirm('Delete job #' + job.id + ' and its files permanently? This cannot be undone.')) return;
      SPG.setBusy(button, true, 'Deleting…');
      SPG.api('/api/operator/jobs/' + encodeURIComponent(job.id), { method: 'DELETE' })
        .then(function () {
          SPG.toast('Job deleted.', 'ok');
          SPG.closeModal('job-modal');
          clearJobModal();
          loadQueue();
          if (state.view === 'history') loadHistory();
        })
        .catch(function (err) { fail(err, 'The job could not be deleted.'); })
        .then(function () { SPG.setBusy(button, false); });
    }
  }

  function runJobAction(button, jobId, action, body, successMessage) {
    SPG.setBusy(button, true, action === 'accept' ? 'Sending…' : 'Working…');
    SPG.api('/api/operator/jobs/' + encodeURIComponent(jobId) + '/' + action, {
      method: 'POST',
      json: body || {}
    })
      .then(function () {
        SPG.toast(successMessage, 'ok');
        loadQueue();
        if (state.view === 'history') loadHistory();
        setTimeout(function () {
          if (state.activeJob && state.activeJob.id === jobId) {
            SPG.api('/api/operator/jobs/' + encodeURIComponent(jobId))
              .then(function (res) {
                state.activeJob = res.job;
                renderJob(res.job);
              })
              .catch(function () { /* keep the current panel */ });
          }
        }, 600);
      })
      .catch(function (err) {
        fail(err, 'The action could not be completed.');
      })
      .then(function () {
        SPG.setBusy(button, false);
      });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
