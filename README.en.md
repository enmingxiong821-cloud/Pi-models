# pi-model (`pmh`)

<p>
  <a href="README.en.md">🇬🇧 English</a> ·
  <a href="README.md">🇨🇳 中文</a>
</p>

Connect [pi](https://pi.dev) to any third-party API — relay stations, self-hosted gateways,
OpenRouter, Ollama, vLLM — and switch models instantly.

```bash
git clone https://github.com/enmingxiong821-cloud/pi-model.git
cd pi-model
node bin/pmh.mjs add crow5 --base https://your-relay.example.com --key sk-xxxx
```

Then, inside pi:

```text
pi> /switch sonnet      # picker with relays first, or jump straight to a match
```

## Why this exists

`pi` only lists built-in vendors in its `/login` onboarding, so people assume third-party
relays are unsupported. They are supported natively — you just have to hand-write a provider
in `~/.pi/agent/models.json`, including per-model metadata (context window, max output,
reasoning, input modalities, pricing). `pmh` automates all of it and adds fast switching.

## Install

Three options, pick one:

1. **Run as-is**: `node bin/pmh.mjs <command>` (zero dependencies, Node 20+).
2. **Add to PATH**: put this repo's `bin/` on your PATH, then just type `pmh`.
3. **As a pi package**: `pi install git:github.com/enmingxiong821-cloud/pi-model`
   (the repo root is a conventional pi package; `extensions/` is picked up automatically).

## Switch inside pi

```bash
node bin/pmh.mjs install-extension   # copies quick-switch.js into ~/.pi/agent/extensions/
```

Run `/reload` (or restart pi), then:

| Action | Effect |
|---|---|
| `/switch` | Picker: **relay models first**, `●` marks the current model, type to filter |
| `/switch sonnet` | Fuzzy switch; a single match switches immediately |
| `/switch-save` | Same, but also writes the choice as the default for new sessions |
| `Ctrl+Shift+M` | Shortcut, same as `/switch` |

## CLI

| Command | Purpose |
|---|---|
| `pmh add <name> --base <url> [--key <key>]` | Add/update a provider, discover models, fill metadata |
| `pmh sync <name>` | Re-discover models; keeps fields you edited by hand |
| `pmh key <name> <api-key>` | Store/rotate a key in `auth.json` |
| `pmh ls [--models]` | List providers, credential source, default model |
| `pmh use [name[#model] \| keyword]` | Set the default; no argument opens an arrow-key picker |
| `pmh pick [--run]` | Arrow-key picker (optionally launches pi) |
| `pmh run [name[#model] \| keyword] [-- <pi args>]` | Launch pi on that model |
| `pmh test <name> [--model id] [--no-chat]` | Probe `/v1/models` and send one minimal request |
| `pmh scope <pattern...>` / `--clear` | Restrict pi's `Ctrl+P` cycling range |
| `pmh install-extension` | Install the `/switch` extension into pi |
| `pmh alias` | Generate `pi-<provider>` shell shortcuts |
| `pmh rm <name> [--purge-key]` | Remove a provider (and optionally its key) |
| `pmh doctor` | Environment check: pi version, config paths, catalog, JSON validity |

Useful flags:

- `--api openai-completions | openai-responses | anthropic-messages`
- `--api-rule "^claude=anthropic-messages"` (repeatable) — route per model, handy when one
  relay serves both Claude and GPT
- `--cost-multiplier 0.2` scale catalog prices for discounted relays, or `--no-cost`
- `--key-in models` keep the key in `models.json` instead of `auth.json`
- `--agent-dir <dir>` / `--catalog <dir>` / `--proxy <url>` / `--dry-run` / `--verbose`

## What it writes

Everything stays inside pi's own config directory (`~/.pi/agent`, override with
`PI_CODING_AGENT_DIR`):

| File | Content |
|---|---|
| `models.json` | `providers.<name> = { baseUrl, api, models: [...] }` |
| `auth.json` | `{ "<name>": { "type": "api_key", "key": "..." } }` |
| `settings.json` | `defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `enabledModels` |

Every write is backed up as `*.bak-<timestamp>` first, so you can always roll back.

## Where metadata comes from

pi ships a full official model catalog (43 data files). `pmh` matches relay model ids against
it: exact → normalized (vendor prefixes, `:free` suffixes, date stamps, `4.5` vs `4-5`) →
fuzzy → conservative heuristics. Measured on OpenRouter's public model list: 468 models,
427 matched official metadata, 41 fell back to heuristics.

Prices are **catalog reference prices**. If your relay bills differently, use
`--cost-multiplier` or `--no-cost`.

## Related projects

- [Wing900/Pi-switch](https://github.com/Wing900/Pi-switch) — desktop GUI configurator (Go + Wails)
- [Raingor/pi-web-switch](https://github.com/Raingor/pi-web-switch) — web UI for pi configuration
- [ttimasdf/pi-provider-newapi](https://github.com/ttimasdf/pi-provider-newapi) — NewAPI-specific pi extension
- [farion1231/cc-switch](https://github.com/farion1231/cc-switch) — the reference provider switcher for Claude Code / Codex

`pmh` stays deliberately thin: terminal-first, zero dependencies, and it only touches pi's own
config files, always with backups.

## Tests

```powershell
node tools/smoke-test.mjs          # end-to-end with a stubbed relay (no network, no pi needed)
node tools/extension-test.mjs      # extension unit tests (sorting, filtering, persistence)
node tools/rpc-test.mjs            # drives a real pi over RPC and asserts /switch works
node tools/rpc-test.mjs --discover # verifies auto-discovery in a real ~/.pi/agent
```

## License

[MIT](LICENSE). Check your relay provider's terms before using it; this project only provides
configuration and switching glue.
