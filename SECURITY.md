# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include steps to reproduce and the version affected. You'll get a reply as soon as the maintainers can. This is a hobby project, so please be patient.

## Scope and design

Mixtape runs a local HTTP server. Its security relies on:

* **Binding to `127.0.0.1` only** by default. Don't change `server.host` / `MIXTAPE_HOST` to a public interface: the API has no authentication.
* **Rejecting requests whose `Host` or `Origin` isn't local**, which blocks DNS-rebinding and cross-site requests from web pages.
* **A stream proxy that only fetches SoundCloud hosts**, so it can't be abused as an open proxy.
* **Masking API keys** in the UI, logs and `config` output, and writing `config.json` with owner-only permissions where supported.
* **No npm dependencies**, so there's no third-party package supply chain at runtime. The stem-separation runtime is downloaded from the npm registry only when you choose to set it up.

Things that are **out of scope** or known:
* Anyone with access to your user account can read `~/.mixtape-agent/config.json`, including API keys.
* The Windows installer is not code-signed. Verify downloads against the release checksums.
* The Claude CLI provider spawns your installed `claude` command with tools and MCP servers disabled (`--tools "" --strict-mcp-config`).
