# AGENTS.md

Instructions for AI coding agents working in this repository. Contribution
rules and the mandatory pre-commit checks are in
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Z-Library skills

Route natural-language requests to the appropriate skill below, whether or not
Codex lists it. Read its `SKILL.md` before running commands. Resolve references
relative to that skill's directory. Users do not need to name a skill or use a
special invocation.

- Z-Library search, saved books, and connectivity: [zlib](.agents/skills/zlib/SKILL.md)
- Local e-book metadata: [metadata](.agents/skills/metadata/SKILL.md)
- Kindle delivery: [kindle](.agents/skills/kindle/SKILL.md)

### Cloud CLI invocation

For this cloud checkout, replace the leading `zlib` in every skill command with
the repository launcher. From the repository root use:

```sh
./scripts/zlib.sh version
./scripts/zlib.sh meta --help
./scripts/zlib.sh kindle send --help
```

From the parent workspace use `./Z-library/scripts/zlib.sh` instead. From any
other directory use the launcher's absolute path, derived from this checkout.
The launcher preserves the working directory, arguments and CLI exit status.
It locates the persisted binary under the checkout's parent at
`.zlib-tools/codex-install-home/.local/bin/zlib`; it does not search `PATH`,
change `HOME`, or install or build anything. A missing or non-executable binary
is an error: report it instead of following a skill's installation fallback.

Use this route for all three skills. Native skill discovery and a bare `zlib`
command on `PATH` are not prerequisites. Follow each skill's account, network,
file-editing and delivery rules; invoking the launcher grants no additional
authorization. For an offline availability check, use `version` and the relevant
command's `--help`; these checks do not verify login, search or delivery.

### Cloud search and private Drive delivery

For natural-language search or EPUB delivery requests in Codex Cloud, also read
[the cloud workflow](docs/cloud-workflow.md) and use
`node scripts/zlib-workflow.mjs` from this checkout. This is the Cloud account
route instead of the skill's interactive-login recovery. It uses the existing
launcher and Personal vault variables, an isolated writable temporary HOME,
one verified domain, and automatic session cleanup. Do not install another CLI,
persist credentials, or ask for passwords in chat.

This executable entry checks Git before every invocation and starts the synced
workflow in a fresh process. It stops on dirty worktrees, branches other than
main or detached HEAD, non-fast-forward histories and inaccessible remotes.
Request command-level network permission for every invocation, including status
and completion. Never bypass the preflight by importing the internal core.
Existing environment `start_skill` synchronization guidance is auxiliary; the
entry enforces the check. A snapshot predating this entry needs a one-time
environment baseline update; repository instructions cannot bootstrap absent code.

Use `deliver` (or guarded `fetch`) with the connected Drive JSON-lines bridge
described in the cloud workflow. Respond to connector requests using the existing
Drive tools, not another API. The program exhausts available search pages and requires a
complete destination listing on search misses or unknown search completeness, private metadata and EPUB byte
readback before reuse. If the connector cannot prove listing completeness, stop;
never mark a truncated or unknown listing complete. Direct `begin-upload` is
disabled; upload authorization is issued only inside reconciled delivery.

Search-only requests stop at results. Download only when explicitly requested
and the user's rights are established; ask for a selection when the edition is
ambiguous. Use the already connected Google Drive `upload_file` tool for private
EPUB delivery, then read back metadata before reporting completion. Do not
implement another Drive API, create public sharing, or configure Kindle or
WeRead for this flow. Retain files after an uncertain or failed upload and use
the recovery procedure before retrying. Never treat an unverified upload as
delivery. All network commands need the platform's command-level network
permission when required; an available domain alone proves no authentication.

## Documentation privacy

These rules apply to every file in the repository and to issue, PR and commit
text. Treat anything committed as public forever: deleting it later does not
remove it from history, forks or tags.

### Layers

| Layer | What it catches | Where |
| --- | --- | --- |
| `node scripts/check-docs.mjs` | Local paths, the current OS username, emails, private IPs and credential values in every Markdown, skill, tape and example file (plus `docs/handoff.md` and `CLAUDE.md`); non-English text in `docs/` | `scripts/check.sh`, CI |
| gitleaks with `.gitleaks.toml` | Built-in secret rules, plus `remix_userkey` values and paths into a real home directory, in every file type | `scripts/check.sh` (staged), `gitleaks.yml` (pushes, PRs, weekly full history) |
| GitHub secret scanning and push protection | Provider tokens, server side | Repository settings |
| Review | Names in prose, screenshots, GIF and PNG content | You, before every commit |

Never weaken a check, add a broad allowlist or use `--no-verify` to get a file
through. Fix the file.

### Rules

- **English only in `docs/`.** Research notes included. The only Chinese
  documents are `README.zh.md`, the generated `site/zh/` and the `repo-readme`
  skill templates. Quoting non-English strings as test data needs an entry in
  `cjkAllowed` in `scripts/check-docs.mjs` with the reason.
- **No absolute local paths.** Never write a path from your machine: no drive
  letters (`<drive>:\...`), no `/Users/<name>` or `/home/<name>`, no Git Bash or
  WSL drive paths (`/d/...`, `/mnt/d/...`), no temp or config directories. Use a
  repository-relative path (`internal/zlib/eapi.go`), a link to the upstream
  project, or a placeholder such as `<temp-dir>`, `<jadx-dir>`,
  `<crush-checkout>` or `<claude-config-dir>`. Generic forms such as
  `~/.config/zlib/` and `C:\Users\<name>` are fine.
- **Reserved names in examples.** Domains from RFC 2606/6761 (`example.com`,
  `.example`, `.test`, `.invalid`), IPs from RFC 5737 (`192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`) or `127.0.0.1`, and placeholder accounts
  (`you`, `user`, `test`). Kindle examples may use `reader@kindle.com`.
- **No personal or environment details.** No OS usernames, real names, personal
  email addresses, hostnames, internal IPs, machine-specific environment
  variable values or local tool setups.
- **No credentials.** Never record `remix_userid`/`remix_userkey` values,
  passwords, SMTP passwords, Cookie headers, session files, tokens, signed
  download URLs or constants extracted from third-party apps. Show the field
  name and a placeholder (`remix_userkey=<key>`). Test fixtures use obviously
  fake values (`FAKE-KEY`, `fixture`), never real ones.
- **Research docs carry technical content only.** No analysis dates, session
  narrative ("this round", "the user provided", "at the time"), branch history
  or tool chatter. Identify sources by version, revision or checksum, and keep
  statements about zlib true for the current code.
- **Measurements describe shape, not content.** When a doc records live
  responses, keep status codes, key names and counts; leave out account data,
  book titles, raw bodies and download links.

### When something leaks

1. **Credential** (session key, password, token): treat it as compromised.
   Ask the owner to revoke it (log out of Z-Library sessions, change the
   password) first; removing it from the repository comes second.
2. **Fix the current files** and run both checks.
3. **History** is rewritten only with the maintainer's explicit approval
   (`git filter-repo`, then a force push that also moves tags). For a
   non-credential finding the maintainer chooses not to rewrite, add its
   fingerprint to `.gitleaksignore` with a comment. Never ignore a credential.
