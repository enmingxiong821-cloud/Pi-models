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
node bin/pmh.mjs quick https://your-relay.example.com sk-xxxx
```

Then, inside pi:

```text
pi> /switch sonnet      # picker with relays first, or jump straight to a match
```

## One-click install

- Windows: double-click `一键安装.cmd` (or `powershell -ExecutionPolicy Bypass -File install.ps1`)
- macOS / Linux: `sh install.sh`

It checks Node ≥ 20, puts `bin/` on your PATH (so you can just type `pmh`), and installs the
`/switch` extension into pi when pi is present.

## Platform support

| Platform | Status | Notes |
|---|---|---|
| Windows 10/11 | ✅ primary | `pmh.cmd` / `install.ps1`; clipboard via PowerShell |
| macOS | ✅ | `install.sh`; clipboard via built-in `pbpaste` |
| Linux desktop | ✅ | `install.sh`; clipboard via `wl-paste` (Wayland) or `xclip`/`xsel` (X11) |
| WSL | ✅ | Same as Linux; point at a Windows-side pi with `--agent-dir /mnt/c/Users/<you>/.pi/agent` |
| Termux (Android) | ✅ | `pkg install nodejs`; clipboard needs `termux-api` (`termux-clipboard-get`) |
| Headless / CI | ✅ | Non-TTY environments skip the wizard and the arrow-key picker (`PMH_NONINTERACTIVE=1` forces this) |

Platform-specific behavior is covered by `node tools/platform-test.mjs`, and CI runs the whole
matrix on ubuntu / windows / macOS with Node 20, 22 and 24.

## One-shot provider setup

```bash
pmh quick <url> <key>   # add + fetch the model list + pick a default model, in one go
pmh quick               # same, but reads "url + key" from your clipboard
pmh add                 # or answer a short wizard: url → key → model list → pick a model
pmh local ollama        # local inference servers: Ollama / LM Studio / vLLM / SGLang / llama.cpp
```

Paste whatever you have: a full endpoint such as `https://relay.example.com/v1/chat/completions`,
`…/v1/responses` or `…/v1/models` is normalized back to the site root, and the scheme is optional.

`pmh local <ollama|lmstudio|vllm|sglang|llama-cpp> [--port N]` fills in the address, protocol and a
placeholder key automatically. Local servers usually don't check the key, but pi hides models it
can't resolve credentials for, so the placeholder goes into `models.json` (never `auth.json`). You
can write the config before starting the server, then run `pmh sync`.

## Why this exists

`pi` only lists built-in vendors in its `/login` onboarding, so people assume third-party
relays are unsupported. They are supported natively — you just have to hand-write a provider
in `~/.pi/agent/models.json`, including per-model metadata (context window, max output,
reasoning, input modalities, pricing). `pmh` automates all of it and adds fast switching.

## Install

GitHub is the primary distribution channel; npm is an optional extra.

```bash
git clone https://github.com/enmingxiong821-cloud/pi-model.git
cd pi-model
node bin/pmh.mjs doctor        # check where pi lives and which config dir is used
```

Four options, pick one:

1. **Run as-is**: `node bin/pmh.mjs <command>` (zero dependencies, Node 20+).
2. **Add to PATH**: put this repo's `bin/` on your PATH, then just type `pmh`.
3. **As a pi package**: `pi install git:github.com/enmingxiong821-cloud/pi-model`
   (the repo root is a conventional pi package; `package.json` declares
   `"pi": { "extensions": [...] }`, so `/switch` is available after `/reload` — no need to run
   `install-extension`)
4. **npm (optional)**: `npm i -g pmh-cli` (the command is still `pmh`).
   The npm package is not published yet — use one of the options above for now.

## Switch inside pi

```bash
pmh install-extension --link     # recommended: register as a pi package, load in place
# or: pmh install-extension      # copy into ~/.pi/agent/extensions/
```

`--link` only adds this repository to pi's `settings.json`; nothing is copied and pi itself is never
modified. After `git pull` or a code change, restart pi. Copy mode suits checkouts that don't stay around.

Run `/reload` (or restart pi), then:

| Action | Effect |
|---|---|
| `/switch` | Picker ordered **favorites → recently used → relays → current → others**; `●` marks the current model, type to filter |
| `/switch sonnet` | Fuzzy switch; a single match switches immediately |
| `/switch @code sonnet` | Limit to group `code`; `@fav` = favorites, `recent` = recently used |
| `/switch relay crow5` | Jump to that relay's last used model (falls back to its first) |
| `/switch-save` | Same, but also writes the choice as the default for new sessions |
| `/switch-fav` | Favorite/unfavorite the current relay model |
| `/switch-widget [on\|off\|auto]` | Toggle the relay widget (`auto` shows it when ≥2 relays exist) |
| `Ctrl+Shift+M` | Shortcut, same as `/switch` |

Filters can be combined: `@group`, `@fav`, `recent`, `reasoning`, `image`, `ctx:>=200k`,
`provider: crow5`. After a switch the status line shows
`pmh · crow5/sonnet-4-5 · 200K · thinking · key:default`. Restoring a session (pi re-applying the
previous model on startup) does **not** count as recent use, so MRU order survives cold starts.

## Difficulty-based auto routing (saves tokens)

pi gets a virtual model `pmh/auto`: you just ask, and it picks a real model from three tiers
according to how hard the current task looks.

```bash
# 1) assign a model to each tier (provider#model)
pmh auto set cheap    crow5#gpt-5-mini
pmh auto set standard crow5#claude-sonnet-4-5
pmh auto set strong   crow5#claude-opus-4-1

# 2) install extensions (re-run if you already have /switch; it refreshes both)
pmh install-extension --link
```

Then select `/model pmh/auto` in pi. After that:

| Action | Effect |
|---|---|
| `/auto status` | Show the switch, tier models and current tier |
| `/auto off` / `/auto on` | Disable/enable auto tiering (disabled = fixed `standard`, no classification) |
| `/auto pin strong` | Temporarily pin one tier; `/auto pin off` releases it |
| `/auto explain refactor the auth module` | Show the classification only, without switching |
| `pmh auto explain "..."` | Same logic from the terminal (`--json` for scripting) |

**How it classifies** (local rules only, no extra request): architecture/refactor/concurrency/low-level,
errors and stack traces, failing tests or builds, performance/security, algorithms/protocols raise the tier;
formatting, rename, translate, explain, comments, one-liners lower it; then multi-file paths, code blocks,
imperatives, prompt length and images add weight. Thresholds are adjustable:

```bash
pmh auto thresholds 0.12 0.5    # ≤0.12 → cheap, ≥0.5 → strong, otherwise standard
```

**The token saving comes from not flapping within a task**: classification happens only on new user
messages. Tool continuations reuse the previous physical model and thinking level, and a failed retry
escalates at most one tier, once. That keeps the prompt cache intact.

Config lives in `~/.pi/agent/extension-settings/pmh-auto.json`, **contains no keys**, and is re-read on
every request, so most changes need no reload. If no tier is configured it falls back to the current
available model with a one-time notice instead of failing.

### Staying compatible with pi updates

`pmh` never patches pi itself; it only uses pi's extension/package mechanisms. On every session start
the extension compares `install/current-version` and the extension API surface (virtual models,
commands, session hooks):

- **Package mode (`--link`)**: pi loads the extensions straight from the repo. After `pi update`, just
  restart; pmh verifies the API and reports the result.
- **Copy mode**: when pi's version or API changes, the latest extension files are synced from the repo
  into the agent directory (old files kept as `*.bak-<timestamp>`); restart to apply.
- If the API is incompatible, only `/auto` degrades with a warning; `/switch` keeps working. Detection
  errors are swallowed and never block pi startup.
- If the repo is already registered as a pi package, `pmh install-extension --copy` refuses to run
  (to avoid loading the extension twice); use `--force` only if you really mean it. If the source repo
  was moved or deleted, startup warns and the currently loaded version keeps working.

```bash
pmh auto doctor     # terminal check: pi version, extension API, install mode, source repo, stale files
pmh auto sync       # manual sync in copy mode (usually automatic on startup)
```

## Shell completion

`pmh completion` prints a completion script covering subcommands, providers, `provider#model`, `@group`, `@fav`, `recent` and common flags:

```bash
pmh completion powershell | Add-Content $PROFILE    # Windows PowerShell
pmh completion bash >> ~/.bashrc                    # bash
pmh completion zsh >> ~/.zshrc                      # zsh
pmh completion fish > ~/.config/fish/completions/pmh.fish
```

Reopen the shell and `pmh use <Tab>` lists relays and models. Completion reads local
config only — no network requests.

## Feedback

When something breaks:

```bash
pmh feedback "pi returns 401 after switching models"
```

It prints a redacted report (pmh/Node/pi versions, install mode, config scale, auto-router
state) and a prefilled GitHub issue link. On an interactive terminal it asks before opening
the browser; use `--open` to open directly, `--print` to only print the link, or `--json`
for structured output.

The report contains versions and counts only: **no API keys, relay URLs, model names or
usernames**, and nothing is submitted automatically — you review and submit in the browser.
Inside pi, `/feedback` gives you the same entry point.

## CLI

| Command | Purpose |
|---|---|
| `pmh quick [url] [key]` | One-shot setup: URL + key (or clipboard) → fetch models → pick a default |
| `pmh add <name> [--base <url>] [--key <key>]` | Add/update a provider, discover models, fill metadata; when updating, `--base`/`--api` may be omitted and the existing values are reused |
| `pmh local <ollama\|lmstudio\|vllm\|sglang\|llama-cpp> [--port N] [--as name]` | One-command local endpoint: fills address/protocol and a placeholder key, then discovers models (works even before the server is running) |
| `pmh model ls [provider] [--json]` | List one provider's `models` and `modelOverrides`, including built-in providers |
| `pmh model add <provider> <model-id> [--ctx 200k] [--max-output 64k] [--reasoning] [--image] [--cost-in 3 --cost-out 15]` | Add/replace a single model under any provider (built-in included), with metadata filled in |
| `pmh model override <provider> <model-id> [...same flags]` | Change metadata only via `modelOverrides`; never touches `api`/`baseUrl` |
| `pmh model rm <provider> <model-id> [--override-only]` | Remove a model entry or its override; an empty provider is cleaned up so pi won't reject it |
| `pmh auto status [--json]` | Auto-routing config: switch, tier models, thresholds, config path |
| `pmh auto set <cheap\|standard\|strong> <provider#model>` | Assign a tier; multiple pairs at once: `auto set cheap=crow5#mini strong=crow5#opus` |
| `pmh auto on\|off` / `unset <tier>` / `pin <tier\|off>` / `thresholds <cheap> <strong>` | Toggle, clear a tier, pin a tier, tune thresholds |
| `pmh auto explain <task> [--json]` | Preview the tier and model that would be used (no switching) |
| `pmh auto install` | Install/refresh only the auto-router extension |
| `pmh import [sources...] [--from clipboard\|claude\|codex\|ccswitch\|all] [--yes] [--dry-run]` | Batch onboarding from pasted text, files, URLs, clipboard, `ccswitch://` deep links, or existing Claude Code / Codex / cc-switch configs; dedupes and previews before writing |
| `pmh scan` | Preview candidates from clipboard and existing configs without writing |
| `pmh sync <name> [--ratio] [--refresh-meta]` | Re-discover models; hand-edited metadata is kept by default, `--refresh-meta` overwrites it from upstream; `--ratio` reads NewAPI pricing ratios |
| `pmh key <name> <api-key>` | Store/rotate a key in `auth.json` |
| `pmh key ls\|add\|use\|rm` | Named key aliases: `key add crow5 backup sk-…`, `key use crow5 backup` |
| `pmh ls [--models] [--group <g>] [--json]` | List providers, credential source, default model |
| `pmh current [--json] [--format template]` | One-line current-model summary, local only; `--format '{{provider}}/{{model}}'` customizes the output (alias `status`) |
| `pmh use [name[#model] \| keyword \| @group [keyword] \| @fav \| recent]` | Set the default; no argument opens an arrow-key picker; `-` toggles back to the previous CLI-set default |
| `pmh group ls\|add\|rm` / `pmh relay group <name> <group\|->` | Workspace groups |
| `pmh fav add\|rm\|toggle <name>#<model>` / `pmh fav ls` | Favorites, shared with `/switch @fav` |
| `pmh recent [--limit N]` | Cross-relay recently used models |
| `pmh meta <name> [--drift] [--verbose] [--json]` | Diff upstream `/v1/models` against your config (context, pricing, capabilities) |
| `pmh pick [--run] [--filter @group]` | Arrow-key picker (optionally launches pi) |
| `pmh run [name[#model] \| keyword \| @group [keyword]] [-- <pi args>]` | Launch pi on that model |
| `pmh test <name> [--model id] [--no-chat]` | Probe `/v1/models` and send one minimal request |
| `pmh scope <pattern...>` / `--clear` | Restrict pi's `Ctrl+P` cycling range |
| `pmh install-extension [--copy\|--link]` | Install the quick-switch and auto-router extensions; `--link` (recommended) registers a pi package that updates with the repo |
| `pmh completion [powershell\|bash\|zsh\|fish]` | Print a shell completion script (auto-detects `$SHELL`/platform when omitted) |
| `pmh alias` | Generate `pi-<provider>` shell shortcuts |
| `pmh rm <name> [--purge-key [--purge-backups]]` | Remove a provider (and optionally all its keys/aliases; `--purge-backups` also removes old backups containing them); also drops its `defaultProvider` / `enabledModels` entries from `settings.json` and its toggle-back history |
| `pmh doctor` | Environment check: pi version, config paths, built-in provider count, `models.json` structure/model/credential/default checks, registry health |
| `pmh feedback [description] [--print\|--open] [--json]` | Build a redacted environment report and open a prefilled GitHub issue (no keys, relay URLs or model names; never submits automatically) |

Useful flags:

- `--api openai-completions | openai-responses | anthropic-messages`
- `--api-rule "^claude=anthropic-messages"` (repeatable) — route per model, handy when one
  relay serves both Claude and GPT
- `--cost-multiplier 0.2` scale catalog prices for discounted relays, or `--no-cost`
- `--group <g>` / `--tag a,b` when onboarding, `--ratio` to use the relay's own pricing table
- `--no-reasoning-compat` to stop advertising `reasoning_effort`
- `--key-in models` keep the key in `models.json` instead of `auth.json`
- `--key-ref VAR` / `--key-cmd CMD` store `$VAR` or `!command` in `models.json` instead of a literal key (pi resolves it at request time; pmh expands it once for discovery)
- `--refresh-meta` let upstream metadata overwrite your hand-edited values in `add`/`sync` (kept by default)
- `--prompt-cache` copy `promptCache` from pi's official catalog (off by default)
- `pmh model` flags: `--ctx 200k`, `--max-output 64k`, `--reasoning` / `--no-reasoning`,
  `--image` / `--text-only`, `--cost-in 3 --cost-out 15 [--cache-read 0.3 --cache-write 3.75]`,
  `--name`, `--override-only`, `--override`
- `--agent-dir <dir>` / `--catalog <dir>` / `--proxy <url>` / `--dry-run` / `--verbose`

Already using cc-switch? `pmh import --from ccswitch` reads its legacy `config.json`. For v4
(SQLite storage), use cc-switch's Share action to produce a `ccswitch://v1/import?...` link and
pass it to `pmh import`; the link's `model` becomes that provider's model list. Gemini native
(`apiFormat=gemini_native`) isn't supported yet — onboard it through an OpenAI-compatible endpoint.

## What it writes

Everything stays inside pi's own config directory (`~/.pi/agent`, override with
`PI_CODING_AGENT_DIR`):

| File | Content |
|---|---|
| `models.json` | `providers.<name> = { baseUrl, api, models: [...] }` |
| `auth.json` | `{ "<name>": { "type": "api_key", "key": "..." }, "<name>@<alias>": {...} }` |
| `settings.json` | `defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `enabledModels` |
| `pmh-relays.json` | Ops metadata only — groups, tags, favorites, MRU, key aliases, metadata sources; **no secrets** |
| `extension-settings/pmh-auto.json` | Auto-routing switch, tier models, thresholds, pinned tier; **no secrets** |

Every write is backed up as `*.bak-<timestamp>` first, so you can always roll back (high-frequency
MRU updates excepted). Losing `pmh-relays.json` is harmless: `pmh ls` and the extension rebuild it
from `models.json` + `auth.json`.

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
- [farion1231/cc-switch](https://github.com/farion1231/cc-switch) — the reference provider switcher for Claude Code / Codex; `pmh` imports its legacy config and share links
- [nicobailon/pi-model-switch](https://github.com/nicobailon/pi-model-switch) — pi extension with aliases, a `switch_model` tool and fallback chains
- [Qihuanxishini/pi-model-manager](https://github.com/Qihuanxishini/pi-model-manager) — terminal TUI with native `models.json` persistence, header profiles and proxy routing; `pmh` is zero-dependency and scriptable
- [playmaker/pi-custom-openai-providers](https://github.com/playmaker/pi-custom-openai-providers) — register multiple OpenAI-compatible providers via `/custom-providers`; `pmh` also does model discovery, metadata filling and config validation

`pmh` stays deliberately thin: terminal-first, zero dependencies, and it only touches pi's own
config files, always with backups.

## Tests

```powershell
npm test                           # everything below except --real / --discover
node tools/smoke-test.mjs          # v0.1 flow end-to-end with a stubbed relay (no network)
node tools/args-test.mjs           # argument parsing: last-wins, repeatables, --no-x, -- passthrough
node tools/registry-test.mjs       # registry: groups, favorites, MRU, stale entries
node tools/keyring-test.mjs        # key aliases: validation, switch archiving, delete guard
node tools/metadata-test.mjs       # upstream metadata parsing, merging, price scaling
node tools/import-test.mjs         # import: JSON/YAML/env/curl/pmh:///base64/Codex/Claude
node tools/relay-test.mjs          # endpoint normalization (rootOf/baseUrlFor), response size cap
node tools/cli-v02-test.mjs        # v0.2 CLI end-to-end (use -, @group keyword, current --format, sync keeping edits, key refs, backup purge)
node tools/native-test.mjs         # local presets, built-in provider parsing, models.json validation, model add/override/rm
node tools/router-test.mjs         # auto routing: classifier, config I/O, virtual-model routing, retry escalation, CLI
node tools/compat-test.mjs         # pi version/API probing, extension self-sync, package vs copy install modes
node tools/feedback-test.mjs       # feedback: redaction, diagnostic counts, issue URL encoding/truncation, per-platform open
node tools/extension-test.mjs      # extension: filters, ranking, status line, widget
node tools/platform-test.mjs       # Windows/macOS/Linux launcher, clipboard, shell quoting
node tools/rpc-test.mjs            # drives a real pi over RPC and asserts /switch works
node tools/rpc-test.mjs --discover # verifies auto-discovery in a real ~/.pi/agent
```

## License

[MIT](LICENSE). Check your relay provider's terms before using it; this project only provides
configuration and switching glue.

## Docs

Design and research notes (Chinese) live in [`docs/`](docs/) — start from
[`docs/README.md`](docs/README.md); current design is [`docs/蓝图-v0.2.md`](docs/蓝图-v0.2.md),
with the original v0.1 blueprint in [`docs/蓝图.md`](docs/蓝图.md).
