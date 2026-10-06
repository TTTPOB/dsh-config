# DSH config maintenance

- Respond to the user in Chinese; keep code comments in English.
- This repository stages configuration only. Do not modify real DSH profiles, installations, sessions, or storages, or restart a Host without explicit authorization.
- Public files must not contain actual machine endpoints, authentication headers, credentials, Cloudflare Access metadata, usernames, or private filesystem paths. Keep them in ignored `local/`; generated output is private too.
- Use chezmoi with `[[ ... ]]` delimiters. Preserve DSH `{{cwd}}`, `{{model}}`, and literal `!!js`; never evaluate expressions or read credential files while rendering.
- Use pnpm for project dependencies. Production plugin/fork references must use verified, exact GitHub Release asset URLs. Never invent an asset or substitute a different version automatically; report unresolved sources.
- Run focused tests, example renders, and baseline checks when private snapshots exist. Inspect staged content before publishing; do not encode real machine identifiers in public checking rules.
- Do not add a generic YAML deep merge engine. Whole private plugin rows currently preserve machine-specific provider/MCP configuration; extract smaller parameters only with baseline tests.
