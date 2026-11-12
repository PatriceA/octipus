// The Research page. It runs in a sandboxed frame with an opaque origin and no
// network (CSP connect-src 'none'): everything goes through the page bridge (a MessagePort),
// which calls this plugin's own tools as the signed-in user
// (docs/PLUGIN-PACKAGES.md#pages). Starting a run and saving the report (write
// tools) are confirmed by the user in the app, outside this frame; reading a
// run's status (a read tool) is not.
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
      if (!port) { reject(new Error('Open Research from the Octipus app: this page has no connection to it.')); return; }
      var id = nextId++;
      waiting.set(id, function (reply) {
        if (!reply.ok) {
          reject(new Error(reply.code === 'denied_by_user' ? 'Not done: you did not allow it.' : (reply.error || 'The call failed')));
          return;
        }
        var result = reply.result || {};
        var text = result.content && result.content[0] && result.content[0].text;
        if (result.isError) { reject(new Error(text || 'The research plugin failed')); return; }
        try { resolve(JSON.parse(text)); } catch (e) { resolve(text); }
      });
      port.postMessage({ octipus: 'call', id: id, tool: tool, args: args || {} });
    });
  }

  // ── The page ─────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  /** First look at a run after this long, then every POLL_MS. */
  var FIRST_POLL_MS = 1000;
  var POLL_MS = 3000;
  var STAGES = { working: 'researching: searching and reading sources…', done: 'done' };

  var state = { runId: null, question: '', report: null, documentId: null, busy: false, timer: null };

  function setStatus(text) { $('status').textContent = text || ''; }
  function showError(message) {
    var box = $('error');
    box.textContent = message || '';
    box.hidden = !message;
  }
  function setBusy(busy) {
    state.busy = busy;
    $('start').disabled = busy;
    $('save').disabled = busy || !state.report;
  }

  // ── A small Markdown view: text only (textContent), so nothing in the report runs or loads.
  /** Inline text: a [label](url) link becomes "label (url)"; nothing navigates out of the frame. */
  function appendInline(parent, text) {
    var re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) parent.appendChild(document.createTextNode(m[1] + ' ('));
      var url = document.createElement('span');
      url.className = 'url';
      url.textContent = m[2] || m[3];
      parent.appendChild(url);
      if (m[1]) parent.appendChild(document.createTextNode(')'));
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderMarkdown(container, markdown) {
    container.textContent = '';
    var list = null;
    var para = null;
    function close() { list = null; para = null; }
    String(markdown).split('\n').forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      var h = /^(#{1,3})\s+(.*)$/.exec(line);
      var bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      var numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (!line.trim()) { close(); return; }
      if (h) {
        close();
        var heading = document.createElement('h' + h[1].length);
        appendInline(heading, h[2]);
        container.appendChild(heading);
        return;
      }
      if (bullet || numbered) {
        var tag = bullet ? 'UL' : 'OL';
        if (!list || list.tagName !== tag) { para = null; list = document.createElement(tag.toLowerCase()); container.appendChild(list); }
        var li = document.createElement('li');
        appendInline(li, (bullet || numbered)[1]);
        list.appendChild(li);
        return;
      }
      list = null;
      if (!para) { para = document.createElement('p'); container.appendChild(para); } else para.appendChild(document.createTextNode(' '));
      appendInline(para, line.trim());
    });
  }

  function showRun(run) {
    if (run.status === 'running') {
      setStatus(STAGES[run.stage] || 'researching…');
      return false;
    }
    setStatus('');
    if (run.status === 'done' && run.report) {
      state.report = run.report;
      $('result').hidden = false;
      $('result-title').textContent = 'Report';
      renderMarkdown($('report'), run.report);
      document.body.setAttribute('data-state', 'done');
    } else if (run.status === 'done' && run.withheld) {
      showError(run.withheld);
      document.body.setAttribute('data-state', 'withheld');
    } else {
      showError(run.error || 'The research did not finish.');
      document.body.setAttribute('data-state', 'error');
    }
    return true;
  }

  function poll(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      var runId = state.runId;
      callTool('research_status', { runId: runId }).then(function (run) {
        if (runId !== state.runId) return;
        if (showRun(run)) setBusy(false);
        else poll(POLL_MS);
      }, function (err) {
        if (runId !== state.runId) return;
        setStatus('');
        showError(err.message);
        setBusy(false);
      });
    }, delay);
  }

  function start() {
    if (state.busy) return;
    var question = $('question').value.trim();
    if (!question) { showError('Enter a question.'); return; }
    clearTimeout(state.timer);
    state.runId = null;
    state.report = null;
    state.documentId = null;
    state.question = question;
    $('result').hidden = true;
    $('saved').hidden = true;
    $('save').textContent = 'Save to documents';
    showError('');
    setBusy(true);
    setStatus('starting…');
    document.body.setAttribute('data-state', 'starting');
    callTool('start_research', { question: question, depth: $('depth').value }).then(function (run) {
      state.runId = run.runId;
      document.body.setAttribute('data-state', 'running');
      setStatus(STAGES.working);
      poll(FIRST_POLL_MS);
    }, function (err) {
      setStatus('');
      showError(err.message);
      setBusy(false);
      document.body.removeAttribute('data-state');
    });
  }

  function save() {
    if (state.busy || !state.runId || !state.report) return;
    setBusy(true);
    showError('');
    setStatus('saving…');
    var args = { runId: state.runId };
    if (state.documentId) args.documentId = state.documentId;
    callTool('save_report', args).then(function (doc) {
      state.documentId = doc.documentId;
      var p = $('saved');
      p.textContent = (doc.updated ? 'Updated' : 'Saved to your documents as') + ' "' + doc.name + '".';
      p.hidden = false;
      $('save').textContent = 'Save again';
      document.body.setAttribute('data-saved', doc.documentId);
    }, function (err) {
      showError(err.message);
    }).then(function () {
      setStatus('');
      setBusy(false);
    });
  }

  $('start').addEventListener('click', start);
  $('question').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); start(); }
  });
  $('save').addEventListener('click', save);

  setBusy(false);
  document.body.setAttribute('data-ready', 'true');
  document.body.setAttribute('data-bridge', port ? 'connected' : 'none');
})();
