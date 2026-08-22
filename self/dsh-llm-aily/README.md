# dsh-llm-aily

An **out-of-tree DeepSeek Harness plugin** (profile bundle) that routes model
calls through the **aily services** API using the **aily-blockly account
quota** — the same account/login you use in the aily-blockly desktop app. It
registers an `aily` provider on `ctx.llm` (display name "Aily 额度"),
exposing the Auto / Aily Max / Aily Fast presets in the model picker.

The deepseek-harness checkout is **not modified**: `dsh plugin` installs this
package into the profile directory and composes it as one more bundle layer.

## Install

From a harness checkout (or anywhere `dsh` is on PATH):

```
dsh plugin --profile web add file:D:\Github\Aily\aily-blockly\packages\dsh-llm-aily
```

`dsh plugin` copies the package into `~/.dsh/profiles/web/node_modules/` and —
because `package.json` declares `dsh.bundle.patch` — appends it to the
profile's bundle layer list. Restart `dsh web` afterwards to mount it.

Peer packages (`@deepseek-ai/dsh-llm`, `cordis`, `schemastery`, …) are not
installed: Node resolves them from the installation's flat fallback at
`~/.dsh/profiles/node_modules/`, so the plugin shares the running dsh's single
copy of each.

## Update after editing

The installed copy is a snapshot of this directory. After changing files here,
re-sync with:

```
dsh plugin --profile web remove dsh-llm-aily
dsh plugin --profile web add file:D:\Github\Aily\aily-blockly\packages\dsh-llm-aily
```

## How it works

- **Credential**: the bearer token is read per request from the aily-blockly
  login file (`.aily`), defaulting to
  `%LOCALAPPDATA%\aily-project\.aily`. When the token nears expiry it is
  refreshed through `POST /api/v1/auth/refresh` and written back, so the
  aily app does **not** need to be running.
- **Transport**: `POST /api/v2/chat_stateless`, an SSE stream of typed events
  (`thinking`, `text_delta`, `tool_call`, `usage`, `done`, `error`) translated
  into harness `StreamChunk`s.
- **Routable models**: only the aily **presets** are routable
  (`model_preset_id`); raw model ids are not.

## Configuration

A `llm-aily:` section in `$DSH_HOME/settings.yaml` (no restart needed):

```yaml
llm-aily:
  baseUrl: https://api.aily.pro
  tokenFile: C:/Users/me/AppData/Local/aily-project/.aily
  defaultPreset: auto-fast
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | string | `https://api.aily.pro` | aily services API base |
| `tokenFile` | path | `%LOCALAPPDATA%\aily-project\.aily` | aily login token file |
| `defaultPreset` | string | `auto` | preset used when the model id is not in the catalog |
| `presets` | AilyPreset[] | Auto / Aily Max / Aily Fast | selectable presets |
| `defaultContextWindow` | number | `800000` | context when a preset lacks one |
| `defaultMaxTokens` | number | `65536` | output cap when a preset lacks one |
| `maxRequestImageBytes` | number | `20MiB` | base64 image payload cap |
| `streamIdleTimeoutMs` | number | `300000` | idle timeout per stream read |
| `retryPolicy` | object | normal / 5 retries | provider request-retry policy |

## Rebuilding `lib/`

`lib/index.js` is the shipped, self-contained build artifact produced by the
deepseek-harness toolchain (tsc project build + bundle). After editing `src/`,
copy `src/` into a harness checkout's `packages/llm/llm-aily/`, rebuild there,
and copy the resulting `lib/` back into this directory, then re-sync the
install (see above). The runtime only needs `lib/index.js`,
`lib/invariant.js`, `lib/types/`, `cordis.patch.yml`, and `package.json`.
