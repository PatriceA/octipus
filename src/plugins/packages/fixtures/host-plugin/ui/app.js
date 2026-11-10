// The page side of the bridge: ask the parent to call one of this package's tools.
(function () {
  var next = 1;
  var waiting = {};
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || data.octipus !== 'result' || !waiting[data.id]) return;
    waiting[data.id](data);
    delete waiting[data.id];
  });
  function callTool(tool, args) {
    return new Promise(function (resolve) {
      var id = next++;
      waiting[id] = resolve;
      window.parent.postMessage({ octipus: 'call', id: id, tool: tool, args: args || {} }, '*');
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
  callTool(tool, {}).then(function (reply) {
    status.textContent = reply.ok ? 'ok' : 'refused: ' + reply.code;
    out.textContent = JSON.stringify(reply);
  });
})();
