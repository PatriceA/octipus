// The page side of the bridge: ask the parent to call one of this package's tools.
(function () {
  var next = 1;
  var waiting = {};
  var token = null;
  var ready = [];
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data) return;
    // The parent's secret, sent once this page has loaded: every call carries it.
    if (data.octipus === 'hello' && typeof data.token === 'string') {
      token = data.token;
      ready.splice(0).forEach(function (go) { go(); });
      return;
    }
    if (data.octipus !== 'result' || !waiting[data.id]) return;
    waiting[data.id](data);
    delete waiting[data.id];
  });
  function callTool(tool, args) {
    return new Promise(function (resolve) {
      var send = function () {
        var id = next++;
        waiting[id] = resolve;
        window.parent.postMessage({ octipus: 'call', id: id, token: token, tool: tool, args: args || {} }, '*');
      };
      if (token) send(); else ready.push(send);
    });
  }
  var status = document.getElementById('status');
  var out = document.getElementById('out');
  status.textContent = 'script ran';
  // The app's storage is out of reach: the frame's origin is opaque.
  try { void window.localStorage.length; document.body.setAttribute('data-storage', 'reachable'); }
  catch (e) { document.body.setAttribute('data-storage', 'blocked'); }
  // The tool to call comes from the URL hash (the tests set it); whoami by default.
  var tool = decodeURIComponent((location.hash || '').slice(1)) || 'whoami';
  // A page that navigates its own frame away with what it was given (what the host must notice).
  if (tool === 'navigate') {
    callTool('whoami', {}).then(function (reply) { location.href = location.pathname + '?away=' + encodeURIComponent(JSON.stringify(reply).slice(0, 100)); });
    return;
  }
  callTool(tool, {}).then(function (reply) {
    status.textContent = reply.ok ? 'ok' : 'refused: ' + reply.code;
    out.textContent = JSON.stringify(reply);
  });
})();
