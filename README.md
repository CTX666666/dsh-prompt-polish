<div align="center">

<img src="assets/icon.svg" width="96" height="96" alt="Prompt Polish icon">

# Prompt Polish

**A Work Buddy–style "polish prompt" button for the DeepSeek Harness composer.**

Left-click rewrites your draft into a clearer prompt using the model the
conversation is already on. Right-click picks a style.

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f7cff)](https://github.com/deepseek-ai)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![No build step](https://img.shields.io/badge/build-none-success)](#why-there-is-no-build-step)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-success)](#dependencies)

[中文说明](README.zh.md)

</div>

---

## What it does

The button sits in the composer's trailing control seat — immediately before the
model selector, exactly where Work Buddy puts it — and does one thing: it
rewrites the draft you are looking at into a more effective prompt.

- **Uses the conversation's own model.** No separate model picker, no hidden
  default. The Host reads the Session's durable `modelSelection` projection
  first, then the selection the Client reports from its model seat, then the
  profile default. Whichever it lands on is the model you were already using.
- **Four styles**, right-click to change, remembered across reloads:
  *Balanced* (default), *Concise*, *Detailed*, *Code-oriented*.
- **A fidelity guard, always on.** Every concrete fact in the original — numbers,
  versions, paths, URLs, quoted strings, code identifiers — must survive
  verbatim, and the rewrite may not inflate past the style's budget. A failed
  check triggers exactly one corrective retry; the guard is a gate, not a loop.
- **Conversation context, always on.** The last few turns are read from the
  Session log so the rewrite knows what "it" refers to. Nothing is uploaded
  anywhere else; the call goes through the `llm` service you already configured.
- **Revert is one click.** After a rewrite the button becomes a revert arrow, so
  the original text stays one click away. Editing the result drops that backup,
  because there is nothing left to revert to.

### Behaviour details

| State | What you see |
| --- | --- |
| Draft empty, nothing rewritten | Button hidden (same as Work Buddy) |
| Draft has text | Spark icon; hover shows the tooltip and current style |
| Rewrite running | Spinner; a second click cancels and restores the draft |
| Rewrite succeeded | Revert arrow; click restores the original |
| Rewrite failed | Draft untouched; the reason appears in the tooltip |
| `adjudicating` / `submitting` phase | Button disabled |

The style menu also opens with <kbd>Shift</kbd>+<kbd>F10</kbd> or the context-menu
key, and closes on outside press, <kbd>Esc</kbd>, or window blur.

## Install

Install straight from GitHub — one command, nothing to clone:

```sh
dsh plugin add github:CTX666666/dsh-prompt-polish
```

Or clone the **entire repository**, including all subdirectories, and install
that directory:

```sh
git clone https://github.com/CTX666666/dsh-prompt-polish.git
dsh plugin --profile <your-profile> add /path/to/dsh-prompt-polish
```

Quote Windows paths containing spaces. GitHub's complete ZIP also works after
extraction; downloading only the root files does not produce a usable plugin.

Either way the bundle declares its own `dsh.bundle.patch`, so installing it
inserts the Host row and the Client bundle in one step; no separate registration.

After installing, the button appears the next time the composer renders. No
rebuild and no extra dependency are needed — see below.

## Requirements

- DeepSeek Harness with a composer that exposes `conversation.input.right`
  and the `llm` + `webServer` services.
- The Client bundle injects `@deepseek-ai/dsh-client-ui-conversation` and
  `@deepseek-ai/dsh-client-locale`, so the locale and conversation packages must
  be present (they ship with the standard Web/Desktop profile).

## Why there is no build step

Both halves are shipped as plain JavaScript, and that is deliberate:

- the **Host half** is `src/index.js`, an ES module that exports `inject` and
  `apply`. It imports nothing from the Harness packages — a workspace-installed
  bundle resolves its own bare imports against the workspace rather than the
  running installation, so the small request vocabulary it needs is built from
  the plain shapes the `llm` service documents.
- the **Client half** is `src/client.js`, a classic script that registers itself
  with `window.__ModuleLoader__.load({ id, factory })` and resolves `react`
  through the loader's module table.

There is no bundler, no transpiler, and nothing to run before installing. What
you read in `src/` is exactly what loads.

## Dependencies

Zero runtime dependencies. The Client half requires `react`, which the Harness
loader already provides; the Host half requires nothing at all.

## Layout

```
dsh-prompt-polish/
├── src/
│   ├── index.js            # Host half: HTTP route + polish pipeline
│   └── client.js           # Client half: the composer button
├── docs/
│   └── IMPLEMENTATION.md   # replication spec: contract, verbatim prompts, edges
├── locale/
│   ├── en.json             # plugin card metadata (anchor locale)
│   └── zh.json             # Chinese metadata
├── assets/
│   └── icon.svg            # plugin icon
├── scripts/
│   └── check.mjs           # dependency-free sanity check
├── .github/
│   ├── workflows/ci.yml
│   └── ISSUE_TEMPLATE/
├── cordis.patch.yml        # bundle patch: one Host row
├── package.json
├── README.md               # this file
├── README.zh.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── .gitattributes
└── .gitignore
```

## Replication spec

[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) is the build-it-again document: the
behaviour contract, the **verbatim** system and user prompts, the four style
directives, the context block format, the fidelity-guard regexes, the model
fallback chain, fifteen edge cases, and a fourteen-item self-test. It is written
so another engineer — or another model — can reproduce this plugin on a different
host without reading `src/` first.

If you only want the prompt text to reuse in a single-turn tool, jump to §11 of
that document.

## Verify

```sh
npm run check
```

Checks syntax and manifest wiring, then runs 27 HTTP and component-state
regression tests. No `npm install` required. Running `node scripts/check.mjs`
alone only checks syntax and package files. Tests use controlled model outputs;
they do not establish end-to-end acceptance in a live Harness/model service.

## How it calls the model

1. `POST /dsh-prompt-polish/polish` with `{ text, style, sessionId?, provider?, model?, reasoningEffort? }`.
2. The Host picks a route (§ *What it does*), building the system prompt, the
   user prompt, the style directive, and the recent-context block.
3. One `ctx.llm.stream()` call at `temperature: 1`. Only `text-delta` chunks are
   accumulated; a `finish` with `kind: 'error' | 'aborted'` is surfaced as a
   failure.
4. The result is cleaned (one fenced block or surrounding quotes are stripped),
   then run through the fidelity guard. A failure retries once with an explicit
   correction note naming the missing tokens and the length limit.
5. The response is `{ ok: true, text, provider, model, style, fidelity, contextUsed }`,
   or `{ ok: false, code, error }` with `code` one of `empty_input`, `no_model`,
   `llm_error`, `aborted`, `empty_result`, `fidelity_failed`, `invalid_request`,
   `not_found`, `method_not_allowed`, `internal`. A failed corrective retry
   preserves the original draft and never returns rejected replacement text.

Editing the draft, navigating to another session or submitting invalidates an
in-flight result. Cancelling disconnects the Host request and aborts upstream
generation; the initial call and corrective retry share a 60-second deadline.

Only `text-delta` and `finish` are read, so a provider that streams reasoning
blocks costs nothing extra.

## Privacy

- The draft, the recent-context block, and the rewrite all travel to the `llm`
  provider **you** configured — that is the model call.
- Nothing is sent anywhere else. There is no telemetry, no analytics, no remote
  endpoint of this plugin's own.
- The chosen style is the only thing persisted, and it lives in the browser's
  `localStorage` under `dsh-prompt-polish.style`.
- No credential is stored, read, or forwarded by this plugin.

## Compatibility

The Client half targets the slot contract declared by
`@deepseek-ai/dsh-client-ui-conversation`. If a future Harness moves that slot,
the button stops appearing rather than breaking the composer — the registration
is wrapped in `ctx.effect`, so it is disposed cleanly on unload.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run check` must
pass, and behaviour changes need a sentence in [CHANGELOG.md](CHANGELOG.md).

## Repository

```sh
git clone https://github.com/CTX666666/dsh-prompt-polish.git
```

The manifest already points at this repository. Installation requires cloning
and installing the directory; users do not need to initialize or push a repository.

`package.json` keeps `"private": true` on purpose: this plugin is distributed as a
directory (or a git URL) that a DSH profile installs, not as a package on the npm
registry. That flag prevents an accidental `npm publish`; it does not restrict
cloning, forking, or installing.

## License

[MIT](LICENSE)
