// The Reader page. It runs in a sandboxed frame with an opaque origin and no
// network (CSP connect-src 'none'): everything goes through the page bridge (a MessagePort),
// which calls this plugin's own tools as the signed-in user
// (docs/PLUGIN-PACKAGES.md#pages). Saving (a write tool) is confirmed by the
// user in the app, outside this frame.
(function () {
  'use strict';

  // ── The bridge (docs/PLUGIN-PACKAGES.md#pages) ───────────────────────────
  // The app put a nonce and its own origin into this page's URL fragment. The
  // page opens a MessageChannel, hands one port to its parent with the nonce,
  // to that exact origin (never '*'), and from then on talks only over its own
  // port; it never listens on its window.
  var params = new URLSearchParams((location.hash || '').slice(1));
  var nonce = params.get('octipus');
  var parentOrigin = params.get('parent');
  /** Calls waiting for their answer, by numeric id. */
  var waiting = new Map();
  var nextId = 1;
  var port = null;
  if (nonce && parentOrigin) {
    var channel = new MessageChannel();
    channel.port1.onmessage = function (event) {
      var data = event.data;
      if (!data || data.octipus !== 'result' || typeof data.id !== 'number') return;
      var done = waiting.get(data.id);
      if (typeof done !== 'function') return;
      waiting.delete(data.id);
      done(data);
    };
    window.parent.postMessage({ octipus: 'ready', nonce: nonce }, parentOrigin, [channel.port2]);
    port = channel.port1;
  }

  /** Call one of this plugin's tools; resolves with its JSON result, rejects with a message. */
  function callTool(tool, args) {
    return new Promise(function (resolve, reject) {
      if (!port) { reject(new Error('Open the Reader from the Octipus app: this page has no connection to it.')); return; }
      var id = nextId++;
      waiting.set(id, function (reply) {
        if (!reply.ok) {
          reject(new Error(reply.code === 'denied_by_user' ? 'Not saved: you did not allow it.' : (reply.error || 'The call failed')));
          return;
        }
        var result = reply.result || {};
        var text = result.content && result.content[0] && result.content[0].text;
        if (result.isError) { reject(new Error(text || 'The reader failed')); return; }
        try { resolve(JSON.parse(text)); } catch (e) { resolve(text); }
      });
      port.postMessage({ octipus: 'call', id: id, tool: tool, args: args || {} });
    });
  }

  // ── The page ─────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var LABELS = { summarize: 'Summary', simplify: 'Simplified', translate: 'Translation', action_items: 'Action items', ask: 'Answer' };
  var ARG_PROMPTS = { translate: 'Target language (e.g. French)', ask: 'Your question about the article' };

  var state = { doc: null, result: null, busy: false, pending: null };

  function setStatus(text) { $('status').textContent = text || ''; }
  function showError(message) {
    var box = $('error');
    box.textContent = message || '';
    box.hidden = !message;
  }
  function setBusy(busy) {
    state.busy = busy;
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
  }

  function run(label, work) {
    if (state.busy) return Promise.resolve();
    setBusy(true);
    showError('');
    setStatus(label);
    return work().then(function () { setStatus(''); }, function (err) {
      setStatus('');
      showError(err.message);
    }).then(function () { setBusy(false); });
  }

  function renderDoc(doc) {
    state.doc = doc;
    state.result = null;
    $('result').hidden = true;
    $('article-saved').hidden = true;
    $('title').textContent = doc.title || doc.url;
    var meta = [];
    if (doc.siteName) meta.push(doc.siteName);
    if (doc.byline) meta.push(doc.byline);
    if (doc.publishedAt) {
      var d = new Date(doc.publishedAt);
      if (!isNaN(d.getTime())) meta.push(d.toLocaleDateString());
    }
    meta.push(doc.estReadMinutes + ' min · ' + doc.wordCount + ' words');
    $('meta').textContent = meta.join(' · ');
    var content = $('content');
    if (doc.contentHtml) {
      // Sanitized by the host (an allowlist of tags and attributes); this frame
      // also runs no inline script and loads nothing from outside (its CSP).
      content.innerHTML = doc.contentHtml;
    } else {
      content.textContent = '';
      String(doc.text || '').split(/\n{2,}/).forEach(function (para) {
        if (!para.trim()) return;
        var p = document.createElement('p');
        p.textContent = para.trim();
        content.appendChild(p);
      });
    }
    $('hint').hidden = true;
    $('layout').hidden = false;
    document.body.setAttribute('data-state', 'read');
  }

  function renderResult(result) {
    state.result = result;
    $('result').hidden = false;
    $('result-title').textContent = LABELS[result.action] || result.action;
    $('saved').hidden = true;
    var items = $('items');
    items.textContent = '';
    var hasItems = result.items && result.items.length > 0;
    items.hidden = !hasItems;
    $('output').textContent = hasItems ? '' : result.output;
    $('save-tasks').hidden = !hasItems;
    if (hasItems) {
      result.items.forEach(function (it) {
        var li = document.createElement('li');
        li.textContent = it;
        items.appendChild(li);
      });
    }
  }

  /** Say what was saved, in the panel it was saved from. */
  function saved(where, text) {
    var p = $(where);
    p.textContent = text;
    p.hidden = false;
    document.body.setAttribute('data-saved', text);
  }

  function read(url) {
    return run('reading…', function () {
      return callTool('read_url', { url: url, includeHtml: true }).then(renderDoc);
    });
  }

  function runAction(action, argument) {
    if (!state.doc) return Promise.resolve();
    var args = { action: action, text: state.doc.text, url: state.doc.url };
    if (argument) args.argument = argument;
    return run((LABELS[action] || action).toLowerCase() + '…', function () {
      return callTool('reader_action', args).then(renderResult);
    });
  }

  // Read a URL (a button and Enter: a sandboxed frame submits no form).
  function readFromField() {
    var url = $('url').value.trim();
    if (!/^https?:\/\//i.test(url)) { showError('Enter an http(s) link.'); return; }
    read(url);
  }
  $('read').addEventListener('click', readFromField);
  $('url').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); readFromField(); }
  });

  // The actions; translate and ask take their argument in a field here (a sandboxed frame opens no dialog).
  var buttons = document.querySelectorAll('[data-action]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function (event) {
      var action = event.currentTarget.getAttribute('data-action');
      if (ARG_PROMPTS[action]) {
        state.pending = action;
        $('arg-label').textContent = ARG_PROMPTS[action];
        $('arg').value = '';
        $('arg-form').hidden = false;
        $('arg').focus();
        return;
      }
      runAction(action);
    });
  }
  function runWithArgument() {
    var argument = $('arg').value.trim();
    if (!argument || !state.pending) return;
    var action = state.pending;
    state.pending = null;
    $('arg-form').hidden = true;
    runAction(action, argument);
  }
  $('arg-run').addEventListener('click', runWithArgument);
  $('arg').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); runWithArgument(); }
  });
  $('arg-cancel').addEventListener('click', function () {
    state.pending = null;
    $('arg-form').hidden = true;
  });

  // Save the article itself as a note.
  $('save-article').addEventListener('click', function () {
    var doc = state.doc;
    if (!doc) return;
    run('saving…', function () {
      return callTool('save_note', { title: doc.title || doc.url, body: doc.text, url: doc.url }).then(function (note) {
        saved('article-saved', 'Saved as the note "' + note.title + '".');
      });
    });
  });

  // Save what an action made of it as a note.
  $('save-result').addEventListener('click', function () {
    var doc = state.doc;
    var result = state.result;
    if (!doc || !result) return;
    var body = result.items && result.items.length ? result.items.map(function (it) { return '- ' + it; }).join('\n') : result.output;
    run('saving…', function () {
      return callTool('save_note', { title: (doc.title || doc.url) + ' — ' + (LABELS[result.action] || result.action), body: body, url: doc.url })
        .then(function (note) { saved('saved', 'Saved as the note "' + note.title + '".'); });
    });
  });

  // Save action items as to-dos.
  $('save-tasks').addEventListener('click', function () {
    var doc = state.doc;
    var result = state.result;
    if (!doc || !result || !result.items || !result.items.length) return;
    run('saving…', function () {
      return callTool('create_tasks', { items: result.items, url: doc.url, title: doc.title }).then(function (out) {
        saved('saved', out.created + ' added to your to-do list.');
      });
    });
  });

  // A link in the article is read here, not followed out of the frame.
  $('content').addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    event.preventDefault();
    var href = link.getAttribute('href') || '';
    try { href = new URL(href, state.doc ? state.doc.url : undefined).href; } catch (e) { return; }
    if (!/^https?:/i.test(href)) return;
    $('url').value = href;
    $('url').focus();
  });

  document.body.setAttribute('data-ready', 'true');
  document.body.setAttribute('data-bridge', port ? 'connected' : 'none');
})();
