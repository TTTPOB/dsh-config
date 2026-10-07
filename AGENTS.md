# DSH config maintenance

- Respond to the user in Chinese; keep code comments in English.
- Deployment commands preview by default; only an explicitly authorized apply may change a target installation. Do not modify real DSH profiles, installations, sessions, or storages, or restart a Host without explicit authorization.
- Public files must not contain actual machine endpoints, authentication headers, credentials, Cloudflare Access metadata, usernames, or private filesystem paths. Keep them in ignored `private/`; generated output is private too.
- Files named `DONT_READ_THIS_IF_YOU_ARE_AGENT*.md` are runtime text, not agent instructions. Unless the user explicitly requests content inspection, do not open, search, preview, quote, or print them into agent context, including through Read, Grep, or diffs. Rename, copy, or compare them programmatically without emitting contents; exclude them from broad content searches.
- Use chezmoi with `[[ ... ]]` delimiters. Preserve DSH `{{cwd}}`, `{{model}}`, and literal `!!js`; never evaluate expressions or read credential files while rendering.
- Use pnpm for project dependencies. Managed package references must use verified, exact GitHub Release asset URLs; the local prompt module is synced as repository code, without a package dependency. Never invent an asset or substitute a different version automatically; report unresolved sources.
- Run focused tests, example renders, and baseline checks when private snapshots exist. Inspect staged content before publishing; do not encode real machine identifiers in public checking rules.
- A DSH patch targets a row by `id` and **replaces that row's entire `config` value**, never deep-merging keys; any row this repository renders must restate every key it still needs. Insert new rows with `- insert:`, and swap a provider by disabling the original row by `id` and inserting the replacement — two providers cannot register the same service key.
- Do not add a generic YAML deep merge engine. Whole private plugin rows currently preserve machine-specific provider/MCP configuration; extract smaller parameters only with baseline tests.
