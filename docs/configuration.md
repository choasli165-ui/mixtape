# AI and API configuration

Only **AI playlists** ("Surprise Me", For You, AI-written titles and notes) use a large language model. Everything else works without one, and no audio is ever sent to an AI service.

| Provider | Setting | Needs | Good for |
|---|---|---|---|
| **Claude CLI** (default) | `claude-cli` | [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) installed and signed in | No API key; uses your existing Claude login and plan |
| **Custom API, Anthropic format** | `anthropic` | An Anthropic API key, or an Anthropic-compatible endpoint | Claude via the API |
| **Custom API, OpenAI format** | `openai` | An endpoint URL, model name, and usually a key | OpenAI, OpenRouter, DeepSeek, Groq, Together, vLLM, and **local** Ollama / LM Studio (no key, nothing leaves your PC) |

Claude itself can also **drive** Mixtape through MCP; see [installation.md](installation.md#optional-claude-cli-and-mcp). In that mode Claude does the curation in your Claude chat, and Mixtape's own LLM setting isn't used.

## In the app

**Settings** (⚙, bottom left of the sidebar):

* **Claude CLI.** Nothing to fill in. Press *Save & test*.
* **Custom API:**
  * **Quick setup** fills in a known provider: OpenAI, Anthropic, OpenRouter, DeepSeek, Groq, Ollama (this PC), or LM Studio (this PC).
  * **API endpoint URL:** any base URL, e.g. `https://api.example.com/v1`. Full endpoint URLs ending in `/chat/completions` or `/v1/messages` work too.
  * **API format:** *OpenAI-compatible (Chat Completions)* or *Anthropic (Messages)*.
  * **Model:** the provider's model name.
  * **API key:** optional for local servers.

*Save & test* sends a tiny request and shows the reply and timing.

## From the terminal

```bash
# Anthropic API
node bin/mixtape.js config set llm.provider anthropic
node bin/mixtape.js config set llm.anthropic.apiKey sk-ant-...
node bin/mixtape.js config set llm.anthropic.model claude-sonnet-5-5

# Any OpenAI-compatible API (here: local Ollama)
node bin/mixtape.js config set llm.provider openai
node bin/mixtape.js config set llm.openai.baseUrl http://localhost:11434/v1
node bin/mixtape.js config set llm.openai.model llama3.1

# Back to the Claude CLI, optionally pinning a model alias
node bin/mixtape.js config set llm.provider claude-cli
node bin/mixtape.js config set llm.claudeCli.model sonnet

node bin/mixtape.js doctor      # tests the AI and SoundCloud
```

Model names change over time; use whatever your provider currently offers.

## The config file

`%USERPROFILE%\.mixtape-agent\config.json` (or `$MIXTAPE_HOME/config.json`). It is written with owner-only permissions where supported. **Never commit or share it**, because it can contain API keys. The `config` command and the UI always show keys masked.

| Key | Default | Meaning |
|---|---|---|
| `llm.provider` | `claude-cli` | `claude-cli`, `anthropic` or `openai` |
| `llm.claudeCli.command` | `claude` | Path or name of the Claude CLI |
| `llm.claudeCli.model` | *(CLI default)* | e.g. `sonnet`, `opus`, `haiku` |
| `llm.claudeCli.timeoutMs` | `180000` | Per request |
| `llm.anthropic.{apiKey, model, baseUrl, maxTokens}` | key empty, `https://api.anthropic.com` | A key is only required for `api.anthropic.com` |
| `llm.openai.{apiKey, model, baseUrl, maxTokens}` | `https://api.openai.com/v1` | Any OpenAI-compatible server |
| `soundcloud.clientId` | *(auto-discovered)* | See [soundcloud.md](soundcloud.md) |
| `soundcloud.minDurationSec` / `maxDurationSec` | `75` / `900` | Tracks outside this range are skipped |
| `server.port` | `4321` | Local player port |
| `ui.language` | *(system)* | `en`, `zh` or `ja` |

## Environment variables

These override the file:

| Variable | Effect |
|---|---|
| `MIXTAPE_LLM_PROVIDER`, `MIXTAPE_LLM_MODEL`, `MIXTAPE_LLM_BASE_URL`, `MIXTAPE_LLM_API_KEY` | Provider settings |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Used if no key is set in the file |
| `SOUNDCLOUD_CLIENT_ID` | Use this client id |
| `MIXTAPE_PORT`, `MIXTAPE_HOST` | Server address (keep the host on `127.0.0.1`) |
| `MIXTAPE_HOME` | Data folder (default `~/.mixtape-agent`) |
| `MIXTAPE_SEED` | Path to a My Songs list |
| `MIXTAPE_ENGINE_DIR` | Folder with a bundled stem-separation engine ([local-runtime.md](local-runtime.md)) |
| `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1` | Proxy for the browser/CLI version ([proxy.md](proxy.md)) |

## What the AI receives

For a playlist request, Mixtape sends:
* your request text;
* up to about 40 "artist – title" lines from My Songs and Liked Songs, as taste context;
* about 90 candidate tracks to choose from (SoundCloud id, artist, title, genre and tags, length, play count).

It receives back search queries, a title, and the chosen track ids with short notes. No audio, account data or files are sent. For **Claude CLI**, the request goes through your Claude Code login under Anthropic's terms. For **Custom API**, it goes to the endpoint you entered.

## My Songs

**My Songs** is a list of songs you like, matched on SoundCloud the first time the player starts. The repository ships a small starter list (`data/my-songs.example.json`). To use your own:

1. Copy it to `%USERPROFILE%\.mixtape-agent\my-songs.json` (or `data/my-songs.json` in a source checkout, which is git-ignored, so it stays private).
2. Edit it:

```json
{
  "title": "My Songs",
  "tracks": [
    { "artist": "Artist name", "title": "Song title" },
    { "artist": "Another artist", "title": "Another song", "version": "Slowed" }
  ]
}
```

`version` (optional) prefers a particular edit such as *Slowed*, *Sped Up* or *Remix*.

3. Press **Re-match** on the My Songs page, or run `node bin/mixtape.js import-songs`. Songs that can't be found are listed.

**For You** builds 15 recommendations from My Songs plus your likes. Press **Refresh** or run `node bin/mixtape.js recommend`.
