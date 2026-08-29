SALVA AGENT FOR WINDOWS

1. Extract this ZIP.
2. Prepare a public HTTPS tunnel hostname that forwards to http://127.0.0.1:8787.
3. Double-click Install-Salva-Agent.cmd and approve the Windows administrator prompt.
4. Select one existing storage folder and enter your public HTTPS endpoint.
5. The installer creates a secure token, installs the "Salva Agent" startup task,
   starts the agent, and writes connection details to your Desktop.
6. In Salva Cloud choose Add storage > Salva Agent API, then paste the endpoint and token.
7. Delete Salva-Agent-Connection.txt after pairing.

Node.js LTS is installed through winget when needed. The agent binds only to localhost.
Do not forward router ports directly; use an HTTPS tunnel.
