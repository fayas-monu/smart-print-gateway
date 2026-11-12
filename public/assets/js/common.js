/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Shared browser helpers: API, toasts, modals, encoding, formatting.
 * (AL SHAJAR TEAM)
 */
(function (global) {
  'use strict';

  var modalStack = [];
  var lastFocused = null;

  function $(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function $$(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatAED(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return 'AED ' + n.toFixed(2);
  }

  function formatNumber(value) {
    var n = Number(value);
    if (!isFinite(n)) return '0';
    return n.toLocaleString('en-AE');
  }

  function formatBytes(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatDateTime(iso, timeZone) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat('en-AE', {
        timeZone: timeZone || 'Asia/Dubai',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }).format(date);
    } catch (err) {
      return date.toLocaleString();
    }
  }

  function timeAgo(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    var seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 90) return '1 min ago';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' hr ago';
    var days = Math.round(hours / 24);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var scope = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(scope, args); }, wait);
    };
  }

  /* ------------------------------- API ------------------------------- */

  async function api(path, options) {
    var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
    var headers = new Headers(opts.headers || {});
    if (opts.json !== undefined) {
      opts.body = JSON.stringify(opts.json);
      headers.set('Content-Type', 'application/json');
      delete opts.json;
    }
    if (opts.jsonBody !== undefined) {
      opts.body = JSON.stringify(opts.jsonBody);
      headers.set('Content-Type', 'application/json');
      delete opts.jsonBody;
    }
    opts.headers = headers;

    var response;
    try {
      response = await fetch(path, opts);
    } catch (err) {
      var netErr = new Error('Cannot reach the print gateway. Check you are still on the shop Wi-Fi.');
      netErr.cause = err;
      throw netErr;
    }

    var text = '';
    try { text = await response.text(); } catch (err) { text = ''; }
    var data = {};
    if (text) {
      try { data = JSON.parse(text); }
      catch (err) { data = { error: text.slice(0, 300) }; }
    }

    if (!response.ok) {
      var requestErr = new Error(data.error || ('Request failed (' + response.status + ').'));
      requestErr.status = response.status;
      requestErr.data = data;
      requestErr.retryAfter = data.retryAfter;
      throw requestErr;
    }
    return data;
  }

  /* ------------------------------ Toasts ----------------------------- */

  var TOAST_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16.5 9"/></svg>';
  var TOAST_ERROR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16v.01"/></svg>';

  function toast(message, type, duration) {
    var stack = document.getElementById('toast-stack');
    if (!stack) return;
    var node = el('div', 'toast' + (type ? ' is-' + type : ''));
    var icon = el('span');
    icon.innerHTML = type === 'error' ? TOAST_ERROR_ICON : TOAST_ICON;
    var text = el('span', null, String(message || ''));
    node.appendChild(icon);
    node.appendChild(text);
    stack.appendChild(node);
    var timeout = typeof duration === 'number' ? duration : (type === 'error' ? 6000 : 3800);
    var removeTimer = setTimeout(function () {
      node.classList.add('is-out');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }, timeout);
    node.addEventListener('click', function () {
      clearTimeout(removeTimer);
      node.classList.add('is-out');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    });
  }

  /* ------------------------------ Modals ----------------------------- */

  function openModal(target) {
    var modal = typeof target === 'string' ? document.getElementById(target) : target;
    if (!modal) return null;
    if (modal.hidden === false && modalStack.indexOf(modal) >= 0) return modal;
    lastFocused = document.activeElement;
    modal.hidden = false;
    modalStack.push(modal);
    document.body.classList.add('no-scroll');
    var focusTarget = modal.querySelector('[data-autofocus]') ||
      modal.querySelector('.modal-close') ||
      modal.querySelector('button, input, select, textarea, [href]');
    if (focusTarget) {
      setTimeout(function () {
        try { focusTarget.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
      }, 30);
    }
    return modal;
  }

  function closeModal(target) {
    var modal = typeof target === 'string' ? document.getElementById(target) : target;
    if (!modal) return;
    var index = modalStack.indexOf(modal);
    if (index >= 0) modalStack.splice(index, 1);
    modal.hidden = true;
    if (!modalStack.length) document.body.classList.remove('no-scroll');
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }
  }

  function closeTopModal() {
    if (!modalStack.length) return false;
    closeModal(modalStack[modalStack.length - 1]);
    return true;
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest ? event.target.closest('[data-open-modal]') : null;
    if (opener) {
      event.preventDefault();
      openModal(opener.getAttribute('data-open-modal'));
      return;
    }
    var closer = event.target.closest ? event.target.closest('[data-close-modal]') : null;
    if (closer) {
      event.preventDefault();
      var modal = closer.closest('.modal');
      if (modal) closeModal(modal);
      return;
    }
    if (event.target.classList && event.target.classList.contains('modal')) {
      closeModal(event.target);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (closeTopModal()) {
      event.stopPropagation();
      return;
    }
    if (typeof global.SPGOnEscape === 'function') global.SPGOnEscape(event);
  });

  /* ---------------------------- Encoding ----------------------------- */

  function bytesToBase64(bytes) {
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    var clean = String(value || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    var binary = atob(clean);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function readFileBytes(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(new Error('This file could not be read.')); };
      reader.readAsArrayBuffer(file);
    });
  }

  function fetchBytes(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}))
      .then(function (response) {
        if (!response.ok) throw new Error('The file could not be loaded (' + response.status + ').');
        return response.arrayBuffer();
      })
      .then(function (buffer) { return new Uint8Array(buffer); });
  }

  /* ----------------------------- Status ------------------------------ */

  var STATUS_LABELS = {
    pending: 'Waiting for approval',
    printing: 'Printing',
    completed: 'Completed',
    rejected: 'Rejected',
    failed: 'Needs attention',
    cancelled: 'Cancelled'
  };

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || 'Unknown');
  }

  function statusTone(status) {
    if (status === 'completed') return 'ok';
    if (status === 'printing') return 'warn';
    if (status === 'pending') return 'pending';
    if (status === 'rejected' || status === 'failed' || status === 'cancelled') return 'bad';
    return 'muted';
  }

  function initials(name) {
    var text = String(name || '').trim();
    if (!text) return '?';
    var parts = text.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span>' + escapeHtml(busyLabel || 'Working…');
    } else {
      button.disabled = false;
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  }

  global.SPG = {
    $: $,
    $$: $$,
    el: el,
    escapeHtml: escapeHtml,
    formatAED: formatAED,
    formatNumber: formatNumber,
    formatBytes: formatBytes,
    formatDateTime: formatDateTime,
    timeAgo: timeAgo,
    debounce: debounce,
    api: api,
    toast: toast,
    openModal: openModal,
    closeModal: closeModal,
    closeTopModal: closeTopModal,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    readFileBytes: readFileBytes,
    fetchBytes: fetchBytes,
    statusLabel: statusLabel,
    statusTone: statusTone,
    initials: initials,
    setBusy: setBusy
  };
})(window);
