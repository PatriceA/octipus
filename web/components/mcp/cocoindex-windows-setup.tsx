const installCommands = String.raw`uv tool install --upgrade 'cocoindex-code[full]'
$cocoExe = Join-Path (uv tool dir --bin) 'ccc.exe'
$env:COCOINDEX_CODE_DIR = Join-Path $env:LOCALAPPDATA 'Octipus\cocoindex-manual'
Set-Location 'C:\src\project'
& $cocoExe init
& $cocoExe index
& $cocoExe search 'session authentication'
Write-Output $cocoExe
Write-Output "COCOINDEX_CODE_DIR=$env:COCOINDEX_CODE_DIR"`;

export function CocoIndexWindowsSetup() {
  return (
    <details className="text-sm text-on-surface-variant">
      <summary className="cursor-pointer text-primary">Windows manual setup</summary>
      <div className="mt-3 space-y-3">
        <p>Run these steps on the Windows machine hosting the Octipus backend, using the same Windows account. If the backend runs in Linux or Docker, use its setup flow instead.</p>
        <ol className="list-decimal pl-5 space-y-3">
          <li>Install uv in PowerShell: <code className="select-text">winget install --id=astral-sh.uv -e</code>. Then open a new PowerShell window.</li>
          <li>
            Replace the example repository path below. During <code>init</code>, choose sentence-transformers for local embeddings and select a model. Wait for indexing to finish and check the search result.
            <pre className="mt-2 overflow-x-auto select-text rounded-lg bg-surface-container-low p-3 text-xs text-on-surface"><code>{installCommands}</code></pre>
          </li>
          <li>As an administrator, open <strong>MCP Servers → Add Server</strong> and choose <strong>stdio</strong>. Enter:</li>
        </ol>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt>Name</dt><dd>CocoIndex Windows</dd>
          <dt>Command</dt><dd>The full ccc.exe path printed above, without surrounding quotes</dd>
          <dt>Arguments</dt><dd><code>mcp</code></dd>
          <dt>Working directory</dt><dd>Your repository folder, for example <code>{String.raw`C:\src\project`}</code></dd>
          <dt>Process settings</dt><dd>Timeout: 1800 seconds. Turn off “Treat stderr output as an error”.</dd>
          <dt>Environment Variables</dt><dd>The printed <code>COCOINDEX_CODE_DIR=…</code> line, with its full path</dd>
        </dl>
        <p>Save and check that the server connects and exposes <code>search</code>. Manage this manual installation from MCP Servers; the managed connector card does not track it. Its tools are shared with agents on this Octipus server.</p>
        <p className="text-xs"><a href="https://github.com/PatriceA/octipus/blob/main/docs/MCP-INTEGRATION.md#windows-manual-cocoindex-setup" target="_blank" rel="noopener noreferrer" className="text-primary underline">Setup and troubleshooting guide</a></p>
      </div>
    </details>
  );
}
