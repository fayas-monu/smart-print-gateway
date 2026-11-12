/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Offline floating Print Assistant. Rule-based answers, no external APIs.
 * (AL SHAJAR TEAM)
 */
(function (global) {
  'use strict';

  var SPG = global.SPG;
  var panel, toggle, closeBtn, body, form, input;
  var getContext = function () { return {}; };
  var opened = false;
  var wired = false;

  function money(value) {
    return 'AED ' + (Number(value) || 0).toFixed(2);
  }

  function esc(value) {
    return SPG ? SPG.escapeHtml(value) : String(value == null ? '' : value);
  }

  function ctx() {
    try { return getContext() || {}; } catch (err) { return {}; }
  }

  function rateLines() {
    var c = ctx();
    var pricing = (c.config && c.config.pricing) || {};
    var block = (pricing.rates && pricing.rates.A4 && pricing.rates.A4.bwBlockPrice) || 1;
    var colour = (pricing.rates && pricing.rates.A4 && pricing.rates.A4.colorPagePrice) || 1;
    var a3bw = (pricing.rates && pricing.rates.A3 && pricing.rates.A3.bwPagePrice) || 2;
    var a3c = (pricing.rates && pricing.rates.A3 && pricing.rates.A3.colorPagePrice) || 3;
    var pages = pricing.bwBlockPages || 8;
    return '<ul>' +
      '<li>A4/A5 black &amp; white: <span class="msg-price">' + money(block) + '</span> per ' + pages + ' pages or part of ' + pages + '.</li>' +
      '<li>A4/A5 colour: <span class="msg-price">' + money(colour) + '</span> per page.</li>' +
      '<li>A3 black &amp; white: <span class="msg-price">' + money(a3bw) + '</span> per page; A3 colour: <span class="msg-price">' + money(a3c) + '</span> per page.</li>' +
      '</ul>';
  }

  function vatLine() {
    return 'All prices are in <strong>AED</strong> and <strong>already include 5% UAE VAT</strong>. We never add VAT on top. ' +
      'The receipt reverses the VAT from the final total so you can see the subtotal and the tax part.';
  }

  function deliveryLine() {
    var c = ctx();
    var delivery = (c.config && c.config.delivery) || { fee: 10, freeThreshold: 50 };
    return 'Home delivery is <span class="msg-price">' + money(delivery.fee) + '</span> for orders below ' +
      '<span class="msg-price">' + money(delivery.freeThreshold) + '</span>. Delivery is <strong>free</strong> when the print order reaches ' +
      money(delivery.freeThreshold) + '. Store pickup is always free.';
  }

  function quoteLine() {
    var c = ctx();
    if (!c.quote || !c.quote.pageCount) {
      return 'Add at least one file and the summary beside the preview will show the exact total, including the VAT breakdown.';
    }
    var q = c.quote;
    var parts = '<ul>' +
      '<li><strong>' + q.pageCount + '</strong> selected page' + (q.pageCount === 1 ? '' : 's') + ' × ' + q.copies + ' cop' + (q.copies === 1 ? 'y' : 'ies') + '</li>' +
      '<li>Printing: ' + money(q.printTotal) + '</li>';
    if (q.fulfillment === 'delivery') {
      parts += '<li>Delivery: ' + (q.freeDelivery ? '<strong>free</strong>' : money(q.deliveryFee)) + '</li>';
    }
    parts += '<li><strong>Total: ' + money(q.total) + '</strong> (VAT ' + money(q.vat) + ' included)</li></ul>';
    return 'Here is your current quote:' + parts;
  }

  function answer(question) {
    var q = String(question || '').toLowerCase();
    var c = ctx();

    if (!q.trim()) {
      return 'Ask me about prices, VAT, delivery, paper sizes, duplex, N-up layouts or how your files are handled.';
    }

    if (/(hello|hi|hey|salam|marhaba|good (morning|afternoon|evening))/.test(q) && q.length < 30) {
      return 'Hello! I can explain the print prices, VAT, delivery and layouts. What would you like to know?';
    }

    if (/(vat|tax|inclusive|included|gst)/.test(q)) {
      return vatLine() + '<br><br>' + quoteLine();
    }

    if (/(deliver|delivery|shipping|fee|threshold|free|driver|home)/.test(q)) {
      return deliveryLine();
    }

    if (/(pickup|pick up|collect|counter|store)/.test(q)) {
      return 'Choose <strong>Store pickup</strong> to collect from the AL SHAJAR STATIONERY counter. Pickup is free. ' +
        'When your job is completed, bring your job number and pay by cash or card at the counter.';
    }

    if (/(black|white|bw|mono|b&w|grayscale|grey)/.test(q)) {
      return 'For A4 and A5 black &amp; white, the price is <span class="msg-price">AED 1.00</span> for every 8 pages, or part of 8. ' +
        'That is the same whether you print single- or double-sided. So 1–8 pages cost AED 1.00, and 9–16 pages cost AED 2.00.' + rateLines();
    }

    if (/(colour|color|colored|coloured)/.test(q)) {
      return 'A4 and A5 colour pages are <span class="msg-price">AED 1.00 per page</span>. ' +
        'A3 colour is <span class="msg-price">AED 3.00 per page</span>. Copies multiply the page count.' + rateLines();
    }

    if (/(a3|large|poster)/.test(q)) {
      return 'A3 black &amp; white is <span class="msg-price">AED 2.00 per page</span> and A3 colour is ' +
        '<span class="msg-price">AED 3.00 per page</span>. Choose A3 under <strong>Paper size</strong>.';
    }

    if (/(duplex|double.?sided|single.?sided|both sides|two sides)/.test(q)) {
      return 'Double-sided (duplex) printing puts two pages on the two sides of one sheet. It saves paper, but the page price stays the same. ' +
        'Choose <strong>Double-sided</strong> under Printed sides, and the preview will show each front and back.';
    }

    if (/(n-?up|2-?up|4-?up|layout|pages per sheet|per sheet|impose|booklet)/.test(q)) {
      return 'N-up printing places more than one page on a single sheet:' +
        '<ul><li><strong>1-up</strong> — one page per side (normal).</li>' +
        '<li><strong>2-up</strong> — two pages per side, usually side by side on landscape paper.</li>' +
        '<li><strong>4-up</strong> — four pages per side in a 2 × 2 grid, like a handout.</li></ul>' +
        'N-up saves paper and does not change the price per page. The live preview shows the exact result.';
    }

    if (/(paper|a4|a5|size|orientation|portrait|landscape)/.test(q)) {
      return 'We print on <strong>A4</strong>, <strong>A5</strong> and <strong>A3</strong>. Choose the paper size and orientation in step 2. ' +
        'With <strong>Auto</strong> orientation, each sheet follows the page orientation so nothing is unexpectedly sideways.';
    }

    if (/(word|docx|doc|office|convert)/.test(q)) {
      var wordOk = c.config && c.config.capabilities && c.config.capabilities.wordConversion;
      return wordOk
        ? 'Word <strong>.docx</strong> files are converted to PDF on the shop computer before preview and printing, so the preview matches the printed pages. Older .doc files should be saved as .docx or PDF first.'
        : 'Word conversion is not available on this shop computer right now. Please save the document as PDF and upload that instead.';
    }

    if (/(pdf|jpg|jpeg|png|image|photo|scan|file|upload|format)/.test(q)) {
      return 'You can upload <strong>PDF</strong>, <strong>Word (.docx)</strong>, <strong>JPG</strong> and <strong>PNG</strong> files. ' +
        'You can add up to 12 files to one job. Files stay on the shop computer and are never sent to a cloud service.';
    }

    if (/(payment|pay|cash|card|visa|mastercard|apple pay|online)/.test(q)) {
      return 'No payment is taken online. Choose <strong>Cash</strong> or <strong>Card</strong> when you send the job, then pay at the counter on pickup or to the driver on delivery.';
    }

    if (/(privacy|data|store|stored|delete|retention|keep|secure|safe)/.test(q)) {
      return 'Your name, phone, optional address and files are stored only on the shop computer. The operator console is PIN-protected. ' +
        'Finished jobs are automatically deleted after 30 days, and you can ask the counter to delete a job earlier. See the Privacy Policy in the footer.';
    }

    if (/(how long|when|ready|wait|time|eta|hours|open)/.test(q)) {
      return 'Most jobs are reviewed and printed within a few minutes during shop hours. The status window updates automatically: ' +
        '<strong>Received → Printing → Ready</strong>. For a large job, the counter team will tell you when to collect it.';
    }

    if (/(cancel|change|edit|remove|wrong file)/.test(q)) {
      return 'You can cancel a job while it is still <strong>waiting for approval</strong> from the status window. Once printing has started it can no longer be cancelled. ' +
        'If you uploaded the wrong file, cancel and send a new job.';
    }

    if (/(copyright|legal|permission|terms|refund|reject)/.test(q)) {
      return 'By sending a job you confirm you have the right to print the files. We may reject unreadable, password-protected, unlawful or copyright-infringing jobs. ' +
        'Printed jobs cannot be refunded for customer errors such as the wrong file or page range. See Terms &amp; Conditions in the footer.';
    }

    if (/(preview|layout|sheet|look|see)/.test(q)) {
      return 'The <strong>Live preview</strong> beside your order shows the exact sheets that will print, including paper size, orientation, N-up and duplex. ' +
        'Use the arrows under the preview to look at the front and back of every sheet.';
    }

    if (/(price|cost|how much|rate|charge|total|quote|aed|estimate|expensive)/.test(q)) {
      return 'All prices already include 5% UAE VAT.' + rateLines() + '<br>' + quoteLine();
    }

    if (/(copy|copies|quantity|more than one)/.test(q)) {
      return 'Use the <strong>Number of copies</strong> stepper in step 2. Copies multiply every selected page, and the total updates immediately. ' +
        'For example, 10 pages × 3 copies at A4 black &amp; white is 30 pages, which is 4 blocks of 8 pages = AED 4.00.';
    }

    return 'I can help with <strong>prices</strong>, <strong>VAT</strong>, <strong>delivery</strong>, <strong>paper sizes</strong>, ' +
      '<strong>duplex</strong>, <strong>N-up layouts</strong>, <strong>payment</strong> and <strong>privacy</strong>. ' +
      'Try one of the quick questions below, or ask in your own words.';
  }

  function addMessage(html, who) {
    if (!body) return;
    var node = document.createElement('div');
    node.className = 'assistant-msg is-' + (who || 'bot');
    if (who === 'user') node.textContent = html;
    else node.innerHTML = html;
    body.appendChild(node);
    body.scrollTop = body.scrollHeight;
  }

  function send(question) {
    var text = String(question || '').trim();
    if (!text) return;
    addMessage(text, 'user');
    if (input) input.value = '';
    setTimeout(function () {
      addMessage(answer(text), 'bot');
    }, 240);
  }

  function openPanel() {
    if (!panel) return;
    panel.hidden = false;
    opened = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    if (!body.dataset.greeted) {
      body.dataset.greeted = '1';
      addMessage('Hello! I am the AL SHAJAR print assistant. Ask me about <strong>prices</strong>, <strong>VAT</strong>, ' +
        '<strong>delivery</strong> or <strong>layouts</strong>.', 'bot');
      addMessage('For example: “How much for 10 black and white pages?” or “Is VAT included?”', 'bot');
    }
    if (input) {
      setTimeout(function () {
        try { input.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
      }, 80);
    }
  }

  function closePanel() {
    if (!panel) return;
    panel.hidden = true;
    opened = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (toggle) {
      try { toggle.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }
  }

  function wire() {
    if (wired) return;
    panel = document.getElementById('assistant-panel');
    toggle = document.getElementById('assistant-toggle');
    closeBtn = document.getElementById('assistant-close');
    body = document.getElementById('assistant-body');
    form = document.getElementById('assistant-form');
    input = document.getElementById('assistant-input');
    if (!panel || !toggle) return;
    wired = true;

    toggle.addEventListener('click', function () {
      if (opened) closePanel();
      else openPanel();
    });

    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        send(input ? input.value : '');
      });
    }

    var quick = document.getElementById('assistant-quick');
    if (quick) {
      quick.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-question]');
        if (!button) return;
        send(button.getAttribute('data-question'));
      });
    }

    document.addEventListener('click', function (event) {
      if (!opened) return;
      if (event.target.closest && event.target.closest('.assistant')) return;
      closePanel();
    });

    global.SPGOnEscape = function () {
      if (opened) {
        closePanel();
        return true;
      }
      return false;
    };
  }

  function init(options) {
    if (options && typeof options.getContext === 'function') getContext = options.getContext;
    wire();
  }

  global.PrintAssistant = {
    init: init,
    open: openPanel,
    close: closePanel,
    ask: function (question) {
      openPanel();
      send(question);
    }
  };
})(window);
