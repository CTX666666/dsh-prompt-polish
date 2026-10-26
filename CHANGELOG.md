# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-10-22

First packaged release. The behaviour is unchanged from the working plugin this
repository was extracted from; this entry records the packaging, not a feature
change.

### Added

- A Work Buddy–style polish button in the composer's trailing control seat
  (`conversation.input.right`, order 20), hidden until the draft has content.
- Four rewrite styles — balanced (default), concise, detailed, code-oriented —
  selected by right-click, `Shift`+`F10`, or the context-menu key, and persisted
  in `localStorage` under `dsh-prompt-polish.style`.
- A fidelity guard that requires every concrete token of the original (numbers,
  versions, paths, URLs, quoted strings, code identifiers) to survive verbatim
  and holds the rewrite to a per-style growth budget. A failed check retries
  exactly once with an explicit correction note.
- Recent-conversation context from the Session log tail, so pronouns in the
  draft resolve the way the user meant them.
- Model routing that prefers the Session's durable `modelSelection` projection,
  then the Client's reported seat, then the profile default — each candidate
  validated against the live provider registry.
- One-click revert after a successful rewrite; editing the result drops the
  backup.
- Cancellation: a second click while the rewrite runs aborts the request and
  restores the original draft.
- `docs/IMPLEMENTATION.md` — a replication spec written for a reader who wants to
  build the same button on another host: behaviour contract, verbatim system and
  user prompts, the four style directives, the context block format, the
  fidelity-guard regexes, the model fallback chain, fifteen edge cases, and a
  fourteen-item self-test.

### Notes

- Runtime dependencies: none. The Client half uses `react`, provided by the
  Harness module loader.
- No build step: `src/index.js` and `src/client.js` are shipped as authored.
- `scripts/check.mjs` validates parsing and manifest wiring without a network
  call or an install.
