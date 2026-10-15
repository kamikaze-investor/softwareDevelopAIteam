# AIteamOS MCP Gateway / Secure MCP Tunnel systemd units

These files are templates for user-level systemd services, in the same form as
`apps/api/ops/systemd/`. They are not installed by any automation.

```
ChatGPT → OpenAI Secure MCP Tunnel → tunnel-client (outbound HTTPS only)
        → 127.0.0.1:3100 MCP Gateway (local_static_bearer)
        → OPERATOR_GATEWAY credential → AIteamOS API 127.0.0.1:3000 (default-deny allowlist)
```

No inbound port, public hostname, reverse proxy or OAuth server is added.
Who may reach the gateway from ChatGPT is decided by the OpenAI Tunnel ACL (the tunnel's
organization / workspace and the Tunnels **Use** permission). The local bearer only keeps other
local processes out of the loopback gateway. The gateway never forwards the caller's
Authorization header to the API and never holds an ADMIN or WORKER credential.

| File | Purpose |
|---|---|
| `ai-team-mcp-gateway.service` | MCP Gateway on `127.0.0.1:3100` |
| `mcp-gateway.env.example` | Names of the gateway's EnvironmentFile entries |
| `ai-team-tunnel-client.service` | OpenAI tunnel-client, health on `127.0.0.1:3180` |
| `tunnel-client.env.example` | Names of the tunnel-client's EnvironmentFile entries |

Secrets are never written in a unit. Each unit reads them from an EnvironmentFile
(mode `0600`, owned by the service user) kept **outside the repository checkout**
(for example `/srv/ai-team/env/`), so it can never be committed. Values in an EnvironmentFile override the unit's
`Environment=` lines, so do not put host, port or target URL settings in those files.

## Stage A: loopback gateway (no OpenAI connection)

1. Install the workspace dependencies from the lockfile (the MCP SDK is only used by the gateway):
   `pnpm install --frozen-lockfile`, with the Worker stopped. Confirm `better-sqlite3` still loads before starting it again.
2. Generate two random values (for example `openssl rand -hex 32`). Hash the bare value with no
   trailing newline, `printf %s "$T" | sha256sum` (the API and the gateway compare the SHA-256 of the
   trimmed token; `echo` would hash a newline and every request would get 401):
   - the OPERATOR_GATEWAY credential: plaintext in `mcp-gateway.env`, SHA-256 as `OPERATOR_GATEWAY_TOKEN_SHA256` for the API;
   - the local bearer: SHA-256 in `mcp-gateway.env`, plaintext kept for Stage B only.
3. Give the API the new hash through the API unit's existing environment (check `systemctl --user cat ai-team-api`
   first: the API may start with an explicit environment allowlist, in which case the variable must be added
   to that allowlist too), then restart the API only.
4. Edit the placeholder paths in `ai-team-mcp-gateway.service`, copy it to `~/.config/systemd/user/`,
   run `systemctl --user daemon-reload` and `systemctl --user enable --now ai-team-mcp-gateway`.
5. Verify, passing tokens to `curl` through stdin (`-H @-`) so they never appear in argv or shell history:
   - the gateway listens only on `127.0.0.1:3100`;
   - `POST /mcp` without a bearer or with a wrong bearer returns 401;
   - with the local bearer, `initialize`, `tools/list` and `get_system_state` succeed;
   - with the OPERATOR_GATEWAY credential, the API returns 403 for ADMIN routes (for example `GET /api/projects`);
   - `ask_pl` creates only an Operator Request (no Task / Job / Approval change);
   - neither plaintext value appears in the API or gateway journal.

## Stage B: Secure MCP Tunnel (after Stage A is verified)

Done by a person in the OpenAI UI (Platform / ChatGPT): confirm Tunnel and developer mode are
available for the workspace, create the tunnel for the organization **and** the ChatGPT workspace,
issue a **Restricted** runtime key with Tunnels **Read + Use** only, and later create the ChatGPT app
with **Connection: Tunnel and no authentication**. The gateway's Authorization header is added by
tunnel-client; a connector that forwards its own Authorization (OAuth / Mixed) overrides it and every
call fails with 401.

1. Download the `runtime` flavor, `tunnel-client-runtime` (no bundled cloudflared), from the official
   release (https://github.com/openai/tunnel-client/releases) and verify it against `SHA256SUMS.txt`,
   plus the signed provenance (`gh attestation verify`) when `gh` is available. The runtime binary
   exposes only `run`, `--help` and `--version`.
2. Create `tunnel-client.env` from `tunnel-client.env.example`, with
   `MCP_EXTRA_HEADERS` and `MCP_DISCOVERY_EXTRA_HEADERS` both set to `Authorization: env:MCP_GATEWAY_AUTH`.
3. Optionally run `doctor --explain` with the full `client` flavor (`tunnel-client`, verified the same
   way; the runtime binary has no `doctor`). Then run `tunnel-client-runtime run` in the foreground once and
   check `http://127.0.0.1:3180/readyz`. Treat `/readyz` together with a successful `tools/list` from
   ChatGPT as the acceptance signal, not `/readyz` alone.
4. Edit the placeholder paths in `ai-team-tunnel-client.service`, copy it, `daemon-reload`, and
   `systemctl --user enable --now ai-team-tunnel-client`. Run exactly one instance per tunnel id.

## Emergency disconnect and rollback

- **Cut ChatGPT off immediately:** `systemctl --user disable --now ai-team-tunnel-client` (the only path to
  the gateway is the outbound tunnel; `disable` keeps it from coming back at the next login or reboot).
  Revoking the runtime key or deleting the tunnel in the OpenAI Platform is the authoritative kill switch;
  remove the ChatGPT app as well.
- **Remove the gateway:** `systemctl --user disable --now ai-team-mcp-gateway`.
- **Invalidate the OPERATOR_GATEWAY credential:** remove `OPERATOR_GATEWAY_TOKEN_SHA256` from the API
  environment and restart the API; any copy of the plaintext is then rejected. To rotate instead, set a
  new hash and restart.
- Delete the two EnvironmentFiles when the services are removed.

If the services must run while the user is logged out, enable linger for that user:

```bash
loginctl enable-linger <user>
```
