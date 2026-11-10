// The page side of the bridge (docs/PLUGIN-PACKAGES.md#pages): the parent put a
// nonce and its own origin into this page's URL fragment; the page opens a
// MessageChannel, hands one port to the parent with the nonce (to that exact
// origin, never '*'), and from then on talks only over its own port.
(function () {
  var status = document.getElementById('status');
  var out = document.getElementById('out');
  status.textContent = 'script ran';
  // The app's storage is out of reach: the frame's origin is opaque.
  try { void window.localStorage.length; document.body.setAttribute('data-storage', 'reachable'); }
  catch (e) { document.body.setAttribute('data-storage', 'blocked'); }

  var params = new URLSearchParams((location.hash || '').slice(1));
  var nonce = params.get('octipus');
  var parentOrigin = params.get('parent');
  if (!nonce || !parentOrigin) {
    // Not opened by the app (or navigated to without the fragment): no bridge.
    status.textContent = 'no bridge';
    document.body.setAttribute('data-bridge', 'none');
    return;
  }

  /** Calls waiting for their answer, by numeric id. */
  var waiting = new Map();
  var next = 1;
  function connect() {
    var channel = new MessageChannel();
    channel.port1.onmessage = function (event) {
      var data = event.data;
      if (!data || data.octipus !== 'result' || typeof data.id !== 'number') return;
      var resolve = waiting.get(data.id);
      if (typeof resolve !== 'function') return;
      waiting.delete(data.id);
      resolve(data);
    };
    window.parent.postMessage({ octipus: 'ready', nonce: nonce }, parentOrigin, [channel.port2]);
    return channel.port1;
  }
  var port = connect();
  function callTool(tool, args, via) {
    return new Promise(function (resolve) {
      var id = next++;
      waiting.set(id, resolve);
      (via || port).postMessage({ octipus: 'call', id: id, tool: tool, args: args || {} });
    });
  }

  // What to do comes from the page itself (the tests set `data-tool` on <body>); whoami by default.
  var tool = document.body.getAttribute('data-tool') || 'whoami';
  if (tool === 'navigate') {
    // A page that navigates its frame away with what it was given (what the host must notice).
    callTool('whoami', {}).then(function (reply) { location.href = location.pathname + '?away=' + encodeURIComponent(JSON.stringify(reply).slice(0, 100)); });
    return;
  }
  if (tool === 'navigate-early') {
    // Navigates while still parsing, before any answer: the next document has no fragment, so no bridge.
    location.href = location.pathname + '?early=1';
    return;
  }
  if (tool === 'ready-twice') {
    // A second port is never answered: the parent talks over the first only.
    var second = connect();
    var answered = false;
    callTool('whoami', {}, second).then(function () { answered = true; });
    callTool('whoami', {}).then(function (reply) {
      setTimeout(function () {
        document.body.setAttribute('data-second-port', answered ? 'answered' : 'ignored');
        status.textContent = reply.ok ? 'ok' : 'refused: ' + reply.code;
      }, 500);
    });
    return;
  }
  callTool(tool, {}).then(function (reply) {
    status.textContent = reply.ok ? 'ok' : 'refused: ' + reply.code;
    out.textContent = JSON.stringify(reply);
  });
})();
