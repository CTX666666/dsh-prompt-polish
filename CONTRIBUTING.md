# Contributing to Prompt Polish

Thanks for taking a look. This is a small plugin and the rules are small too.

## Before you change anything

```sh
node scripts/check.mjs
```

There is no install step and no build step, so this runs in a bare checkout. It
parses every shipped JavaScript and JSON file, then verifies that the manifest
wiring (`exports`, `files`, `dsh.bundle.patch`), the Client module id, and the
Host exports all still agree. **A pull request that fails this check will not be
merged.**

## Project shape

Two halves, one bundle:

| Path | Role | Module kind |
| --- | --- | --- |
| `src/index.js` | Host half: the HTTP route and the polish pipeline | ESM, exports `inject` + `apply` |
| `src/client.js` | Client half: the composer button | Classic script, self-registers with `window.__ModuleLoader__` |
| `cordis.patch.yml` | Bundle patch: inserts the Host row | YAML |
| `locale/*.json` | Plugin card title and description | JSON |
| `assets/icon.svg` | Plugin icon | SVG |

### Rules that keep it installable

1. **Do not add a build step.** `src/` is what loads. A bundler or transpiler
   would put a generated artifact between the source and the running system, and
   this plugin exists partly to show that is unnecessary.
2. **Do not import Harness packages in the Host half.** A workspace-installed
   bundle resolves bare imports against the workspace, not the running
   installation. The Host half builds the small request vocabulary it needs from
   plain object shapes — keep it that way. If you need a new service, reach it
   through `ctx.get('serviceName')` and handle `undefined`.
3. **Keep the Client module id equal to the package name.** The loader keys the
   factory by it and the profile's patch row resolves the same string.
   `scripts/check.mjs` enforces this.
4. **Wrap every registration in `ctx.effect`.** Unload must dispose cleanly; the
   composer must not be left with a dead slot entry.

## Changing behaviour

- **Prompts and styles** live at the top of `src/index.js`. Changing an
  instruction is a behaviour change: update `CHANGELOG.md` and, if the growth
  budget moves, say why in the commit message.
- **The fidelity guard** (`fidelityCheck`, `factTokens`) is the safety property
  of this plugin. Widening what counts as a "fact" makes the guard stricter and
  is usually welcome; loosening it needs a concrete example of a token that
  should not be preserved.
- **UI** lives in `src/client.js`. Match the existing state machine
  (`idle` / `loading` / `revert` / `error`) rather than adding a parallel one.
  Reuse the theme tokens already referenced (`--dsw-alias-*`); a hard-coded
  colour will not survive the light/dark switch.

## Local testing

Install the directory into a scratch profile and poke the route:

```sh
dsh plugin --profile <scratch-profile> add /path/to/prompt-polish-github
curl -sS -X POST http://127.0.0.1:<port>/dsh-prompt-polish/polish \
  -H 'content-type: application/json' \
  -d '{"text":"make the build faster","style":"balanced"}'
```

An empty `text` returns `{"ok":false,"code":"empty_input",...}` — a quick way to
confirm the Host half is mounted without spending a model call.

## Commit messages

Conventional commits, one concern per commit:

```
feat(client): keep the button visible while a rewrite is pending
fix(host): drop a trailing colon from the cleaned result
docs: explain why there is no build step
```

## Reporting a bug

Open an issue with:

- what you typed and which style was selected,
- what the tooltip said (the error text is surfaced there verbatim),
- the response body if you can get it from the network panel,
- whether the draft was restored (it should be untouched on failure).

Please **do not** paste credentials, tokens, or private prompt content. The draft
and the rewrite are yours; the shape of the failure is what is needed.
