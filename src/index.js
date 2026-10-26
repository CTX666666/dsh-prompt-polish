/**
 * Prompt Polish — Host half.
 *
 * One HTTP route that rewrites a composer draft into a clearer prompt. The
 * model is the one the owning conversation is already using: the Session's
 * durable `modelSelection` projection first, then the selection the Client
 * reports from its model seat, then the profile's default selection.
 *
 * Three behaviours are always on:
 * - a style preset (balanced by default) selected in the Client;
 * - a fidelity guard: concrete facts of the original must survive and the
 *   rewrite may not inflate past the style's budget — a failed check retries
 *   once with an explicit correction before the result is returned;
 * - recent conversation context, so the rewrite knows what "it" refers to.
 *
 * The route is served by the same `webServer` that serves the GUI, so the
 * browser calls it same-origin with no extra credential handling.
 *
 * The module deliberately imports nothing from the harness packages: a
 * workspace-installed bundle resolves its own bare imports against the
 * workspace, not against the running installation, so it builds the small
 * request vocabulary (`GenerateOptions` messages and chunk assembly) it needs
 * from the plain shapes the `llm` service documents.
 *
 * @module @local/prompt-polish
 */

/** Service keys this plugin needs; `llm` and `webServer` are hard dependencies. */
export const inject = ['webServer', 'llm']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/dsh-prompt-polish'

/** Bound on one accepted request body (a draft, not a document). */
const MAX_BODY_BYTES = 256 * 1024

/** Upper bound on one polish call; the draft itself bounds the useful wait. */
const CALL_TIMEOUT_MS = 60_000

/** Call identity recorded on the request so adapters may key on it. */
const CALL_IDENTITY = 'dsh-prompt-polish'

/** Recent-context bounds: cheap enough to read before every click. */
const CONTEXT_MESSAGES = 6
const CONTEXT_EVENT_TAIL = 80
const CONTEXT_MESSAGE_CHARS = 400
const CONTEXT_TOTAL_CHARS = 1500

/** Style ids in menu order; the first one is the default. */
const STYLE_ORDER = ['balanced', 'concise', 'detailed', 'code']

/** Per-style rewrite instruction and the largest growth factor the guard allows. */
const STYLES = {
  balanced: {
    instruction:
      'STYLE: Balanced. Make the prompt clear and specific — state the task, its scope, the constraints, and the expected output — in roughly the same length as the original. Do not pad it with requirements the original does not imply.',
    growth: 1.6,
  },
  concise: {
    instruction:
      'STYLE: Concise. Keep the rewrite as short as possible while removing ambiguity: one compact paragraph or a few short points. Cut every word that does not add meaning.',
    growth: 1.2,
  },
  detailed: {
    instruction:
      'STYLE: Detailed. Expand into a structured prompt with explicit parts for task, context, constraints, and expected output format. Prefer short labelled lines over long prose.',
    growth: 2.2,
  },
  code: {
    instruction:
      'STYLE: Code-oriented. Frame the request for a coding assistant: name the language or runtime only when the original implies it, specify inputs, outputs, edge cases, and how the result is verified. Do not invent libraries, APIs, or versions.',
    growth: 1.9,
  },
}

/** Base brief: Work Buddy's prompt-engineering role, kept in intent. */
const SYSTEM_PROMPT = `You are a Prompt Engineering Expert specializing in improving user prompts for a development code assistant. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose.

TASK: Analyze the draft under USER INPUT and rewrite it into a more effective prompt.

ANALYSIS PROCESS:
Identify the main objective, note any ambiguities or gaps, assess the clarity of instructions, and check for missing context.
Apply these prompt engineering principles: write clear, specific instructions; include necessary context; set explicit parameters and constraints; structure the expected output; remove redundant information.
Create the enhanced version: maintain the original goal and keep it realistic in the features it adds.
Do NOT request guides/how-tos unless the user asks. Do NOT suggest specific technologies unless mentioned in the user's prompt. Do NOT explain HOW to do things, focus on WHAT. Do NOT answer the request — rewrite it to be more specific.

FIDELITY GUARD (mandatory):
1. Every concrete fact in the original must survive verbatim: numbers, versions, names, file paths, URLs, code identifiers, quoted strings, and every explicit requirement or constraint.
2. Never invent facts, requirements, technologies, libraries, or acceptance criteria the original does not imply.
3. Never drop, soften, or contradict a stated constraint.

IMPORTANT CONSTRAINTS:
1. Language matching is the highest priority — respond in the exact same language as the user's input, and keep a natural mix if the input mixes languages.
2. Keep the rewrite concise and free of padding.
FORMAT: Provide only the rewritten prompt with no additional commentary.`

/** User prompt template; style and context are appended per request. */
const USER_PROMPT = `You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.

USER INPUT:
{input}
{context}

TASK:
Rewrite the user input into a clearer, more specific prompt for the target AI assistant.

CRITICAL PRIORITY - LANGUAGE CONSISTENCY:
1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.
2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.
3. If the user writes in English, the enhanced prompt MUST be entirely in English.
4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.
5. If the user mixes languages, keep a natural matching mix. Do not translate the user's intent into a single language.
6. These language rules are behavior instructions only; never include language analysis or language labels in the output.

ENHANCEMENT REQUIREMENTS:
1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.
2. Do not include language labels or meta notes such as "User input is in Chinese".
3. Preserve the user's original intent, topic, constraints, and target output type. Do not answer the request.
4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.
5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.
6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list, dangling conjunction, or trailing colon.
7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.

EXAMPLES:
User input (Chinese): "请帮我解释这段代码的功能"
Enhanced prompt: "请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。"

User input (English): "Please explain what this code does"
Enhanced prompt: "Explain what this code does, including its main purpose, key control flow, and any important edge cases."`

/** Normalize one requested style id. */
function pickStyle(value) {
  return typeof value === 'string' && Object.hasOwn(STYLES, value) ? value : STYLE_ORDER[0]
}

/** Render the user prompt for one draft, style, and conversation context. */
function renderUserPrompt(input, styleId, contextBlock) {
  return USER_PROMPT.replace(/\{input\}|\{context\}/gu, (marker) =>
    marker === '{input}' ? input : contextBlock === '' ? '' : `\n\n${contextBlock}`,
  )
}

/** The style directive block appended to a request. */
function styleBlock(styleId) {
  return STYLES[pickStyle(styleId)].instruction
}

/**
 * Strip a wrapper the model may still add despite the format instruction:
 * one fenced block, or surrounding quotes.
 * @param text - raw model output.
 * @returns the prompt text meant for the composer.
 */
function cleanResult(text) {
  let out = text.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(out)
  if (fenced !== null) out = fenced[1].trim()
  out = out.replace(/^["'“”‘’]|["'“”‘’]$/gu, '').trim()
  return out
}

/**
 * Read one JSON request body under a byte bound.
 * @param req - incoming request.
 * @returns the parsed body, or undefined when it is unreadable or oversized.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size <= MAX_BODY_BYTES) chunks.push(chunk)
  }
  if (size > MAX_BODY_BYTES) return undefined
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * One request-only user message in the `llm` service's message vocabulary.
 * @param text - the prompt text.
 * @returns the message value.
 */
function userMessage(text) {
  return {
    id: `prompt-polish-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Join the text blocks of one message value. */
function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
}

/**
 * Recent conversation turns from the Session log tail, as text for the model.
 * Reads only the last events, so a long conversation costs nothing extra.
 * @param ctx - plugin context.
 * @param sessionId - Session the composer belongs to.
 * @returns a context block, or '' when the Session or its history is unavailable.
 */
function recentContext(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return ''
  try {
    const agents = ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    const session = agent?.session
    if (session === undefined || session === null) return ''
    const end = typeof session.seq === 'number' ? session.seq : 0
    const from = Math.max(0, end - CONTEXT_EVENT_TAIL)
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(from, end) : []
    const turns = []
    for (const event of [...events].reverse()) {
      if (turns.length >= CONTEXT_MESSAGES) break
      if (event?.type === 'user/message') {
        const message = event.data
        // Only human-authored turns: model-selection notices, goal continuations
        // and command echoes are bookkeeping, not conversation.
        if (message?.source?.kind !== 'user') continue
        const text = messageText(message).trim()
        if (text !== '') turns.push({ role: 'user', text })
      } else if (event?.type === 'assistant/message') {
        const message = event.data?.message
        if (message?.source?.kind !== 'model') continue
        const text = messageText(message).trim()
        if (text !== '') turns.push({ role: 'assistant', text })
      }
    }
    const recent = turns.slice(-CONTEXT_MESSAGES)
    if (recent.length === 0) return ''
    let budget = CONTEXT_TOTAL_CHARS
    const lines = []
    for (const turn of recent) {
      if (budget <= 0) break
      const room = Math.min(CONTEXT_MESSAGE_CHARS, budget - turn.role.length - 3)
      if (room <= 0) break
      const clipped = turn.text.length > room ? `${turn.text.slice(0, room - 1)}…` : turn.text
      budget -= clipped.length + turn.role.length + 2 + 1
      lines.push(`${turn.role}: ${clipped}`)
    }
    if (lines.length === 0) return ''
    return `RECENT CONVERSATION (context only — do not rewrite it, answer it, or repeat it; use it only to resolve references such as "it", "this", or "the above"):\n${lines.reverse().join('\n')}`
  } catch {
    return ''
  }
}

/**
 * The model selection one Session currently uses, from its durable projection.
 * @param ctx - plugin context.
 * @param sessionId - Session the composer belongs to.
 * @returns provider/model/effort, or undefined when unavailable.
 */
function sessionSelection(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  try {
    const agents = ctx.get('agents')
    const projections = ctx.get('sessionProjections')
    if (agents === undefined || projections === undefined) return undefined
    const agent = agents.get(sessionId)
    if (agent === undefined || agent === null) return undefined
    const state = projections.stateOf(agent.session, 'modelSelection')
    const selection = state?.pending ?? state?.lastUsed
    if (selection === null || selection === undefined) return undefined
    if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : undefined,
    }
  } catch {
    return undefined
  }
}

/** The profile's default selection, used when no Session-scoped one exists. */
function defaultSelection(ctx) {
  try {
    const current = ctx.get('agentDefaultModel')?.currentSelection()
    if (current === undefined || current === null) return undefined
    if (typeof current.provider !== 'string' || typeof current.model !== 'string') return undefined
    return {
      provider: current.provider,
      model: current.model,
      reasoningEffort: typeof current.reasoningEffort === 'string' ? current.reasoningEffort : undefined,
    }
  } catch {
    return undefined
  }
}

/** Whether one provider is registered on the live `llm` service. */
function providerRegistered(ctx, provider) {
  try {
    const providers = ctx.llm.listProviders()
    if (!Array.isArray(providers)) return false
    return providers.some((entry) => entry?.id === provider || entry?.provider === provider)
  } catch {
    return true
  }
}

/**
 * Pick the route for one request: Session projection, then the Client's model
 * seat, then the profile default. Each candidate must name a live provider.
 * @param ctx - plugin context.
 * @param request - validated request body.
 * @returns the chosen selection, or undefined when nothing is routable.
 */
function chooseSelection(ctx, request) {
  const fromClient =
    typeof request.provider === 'string' &&
    typeof request.model === 'string' &&
    request.provider !== '' &&
    request.model !== ''
      ? {
          provider: request.provider,
          model: request.model,
          reasoningEffort: typeof request.reasoningEffort === 'string' ? request.reasoningEffort : undefined,
        }
      : undefined
  const candidates = [sessionSelection(ctx, request.sessionId), fromClient, defaultSelection(ctx)]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (!providerRegistered(ctx, candidate.provider)) continue
    return candidate
  }
  return undefined
}

/**
 * The reasoning effort to send: the selection's own effort only when that exact
 * model advertises it, otherwise nothing (the adapter default applies).
 * @param ctx - plugin context.
 * @param selection - chosen route.
 * @returns the effort id, or undefined.
 */
async function resolveEffort(ctx, selection) {
  const requested = selection.reasoningEffort
  if (requested === undefined) return undefined
  try {
    const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
    const efforts = info?.reasoning?.efforts
    if (efforts === undefined) return undefined
    if (!efforts.some((effort) => effort.id === requested)) return undefined
    return requested
  } catch {
    return undefined
  }
}

/**
 * Concrete tokens a rewrite must not lose: URLs, quoted strings, code spans,
 * paths, version-like numbers, and camelCase or snake_case identifiers.
 * Ordinary words are deliberately excluded — they are what a rewrite changes.
 * @param text - the original draft.
 * @returns distinct tokens, longest first.
 */
function factTokens(text) {
  const found = new Set()
  const patterns = [
    /https?:\/\/[^\s)>\]]+/gu,
    /`([^`\n]{2,120})`/gu,
    /"([^"\n]{2,120})"/gu,
    /'([^'\n]{2,120})'/gu,
    /“([^”\n]{2,120})”/gu,
    /(?:[A-Za-z]:)?[\\/]?[\p{L}\p{N}_.@-]+(?:[\\/][\p{L}\p{N}_.@-]+)+/gu,
    /[\p{L}_][\p{L}\p{N}_@-]*\.(?:[A-Za-z][A-Za-z0-9]*)(?:\.[A-Za-z0-9]+)*/gu,
    /\b\d+(?:\.\d+){1,}\b/gu,
    /\d+/gu,
    /\b[a-z]+[A-Z][A-Za-z0-9]*\b/gu,
    /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gu,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = (match[1] ?? match[0]).trim()
      if (token.length >= 1) found.add(token)
    }
  }
  return [...found].sort((a, b) => b.length - a.length)
}

/**
 * Run the fidelity guard: concrete facts preserved, and growth inside budget.
 * @param input - the original draft.
 * @param output - the rewrite.
 * @param styleId - selected style.
 * @returns `{ ok, missing, overBudget, limit }`.
 */
function fidelityCheck(input, output, styleId) {
  const missing = []
  for (const token of factTokens(input)) {
    const boundary = /^\d+$/u.test(token) ? '\\d' : /^[A-Za-z][A-Za-z0-9_]*$/u.test(token) ? '[A-Za-z0-9_]' : undefined
    const preserved = boundary === undefined
      ? output.includes(token)
      : new RegExp(`(?<!${boundary})${token}(?!${boundary})`, 'u').test(output)
    if (!preserved) missing.push(token)
  }
  const growth = STYLES[pickStyle(styleId)].growth
  const base = Math.max(input.trim().length, 1)
  const limit = Math.round(base * growth) + 120
  const overBudget = output.length > limit
  return { ok: missing.length === 0 && !overBudget, missing, overBudget, limit }
}

/**
 * One model call for the rewrite.
 * @param ctx - plugin context.
 * @param selection - chosen route.
 * @param effort - validated reasoning effort.
 * @param userPrompt - rendered user prompt.
 * @returns `{ ok: true, text }` or `{ ok: false, code, error }`.
 */
async function callModel(ctx, selection, effort, userPrompt, signal) {
  let output = ''
  let finish
  try {
    signal.throwIfAborted()
    for await (const chunk of ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      sessionId: CALL_IDENTITY,
      messages: [userMessage(userPrompt)],
      system: SYSTEM_PROMPT,
      temperature: 1,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
      else if (chunk?.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    return { ok: false, code: signal.aborted ? 'aborted' : 'llm_error', error: error instanceof Error ? error.message : String(error) }
  }
  if (signal.aborted) return { ok: false, code: 'aborted', error: 'Cancelled or timed out' }
  if (finish?.kind === 'error') {
    return { ok: false, code: 'llm_error', error: finish.failure?.message ?? 'LLM completion failed' }
  }
  if (finish?.kind === 'aborted') {
    return { ok: false, code: 'aborted', error: finish.failure?.message ?? 'Cancelled' }
  }
  const cleaned = cleanResult(output)
  if (cleaned === '') return { ok: false, code: 'empty_result', error: 'The model returned no text' }
  return { ok: true, text: cleaned }
}

/** The correction note a retry carries when the guard rejected the first pass. */
function correctionNote(input, check, styleId) {
  const lines = ['CORRECTION — the previous rewrite failed the guard. Apply it exactly:']
  if (check.missing.length > 0) {
    lines.push(
      `1. These exact tokens from the original are missing. Put every one of them back verbatim, unchanged: ${check.missing
        .map((token) => `«${token}»`)
        .join(', ')}`,
    )
  }
  if (check.overBudget) {
    lines.push(
      `2. The rewrite was too long. Keep it at or under ${check.limit} characters — the original is ${input.trim().length}. Remove padding rather than requirements.`,
    )
  }
  lines.push('3. Return only the corrected prompt, with no commentary.')
  lines.push(`STYLE (unchanged): ${STYLES[pickStyle(styleId)].instruction}`)
  return lines.join('\n')
}

/**
 * Run one polish call and return the rewritten prompt.
 * @param ctx - plugin context.
 * @param request - validated request body.
 * @returns `{ ok: true, text, provider, model, style, fidelity, contextUsed }` or a failure.
 */
async function polish(ctx, request, signal) {
  const text = typeof request.text === 'string' ? request.text : ''
  if (text.trim() === '') return { ok: false, code: 'empty_input', error: 'Empty input' }
  const selection = chooseSelection(ctx, request)
  if (selection === undefined) {
    return { ok: false, code: 'no_model', error: 'No model is available for this conversation' }
  }
  const styleId = pickStyle(request.style)
  const contextUsed = request.context !== false
  const contextBlock = contextUsed ? recentContext(ctx, request.sessionId) : ''
  const effort = await resolveEffort(ctx, selection)
  const basePrompt = `${renderUserPrompt(text, styleId, contextBlock)}\n\n${styleBlock(styleId)}`

  const first = await callModel(ctx, selection, effort, basePrompt, signal)
  if (!first.ok) return first

  const check = fidelityCheck(text, first.text, styleId)
  if (check.ok) {
    return {
      ok: true,
      text: first.text,
      provider: selection.provider,
      model: selection.model,
      style: styleId,
      fidelity: 'ok',
      contextUsed: contextBlock !== '',
    }
  }

  // One corrective retry: the guard is a gate, not a rewrite loop.
  const retry = await callModel(ctx, selection, effort, `${basePrompt}\n\n${correctionNote(text, check, styleId)}`, signal)
  if (!retry.ok) return retry
  const retryCheck = fidelityCheck(text, retry.text, styleId)
  if (!retryCheck.ok) {
    return { ok: false, code: 'fidelity_failed', error: 'The rewrite did not preserve the original facts or length budget. Your draft is unchanged.' }
  }
  return {
    ok: true,
    text: retry.text,
    provider: selection.provider,
    model: selection.model,
    style: styleId,
    fidelity: 'corrected',
    contextUsed: contextBlock !== '',
  }
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Host half of the bundle.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const pathname = (req.url ?? '/').split('?')[0]
          if (pathname !== `${ROUTE_PREFIX}/polish`) {
            sendJson(res, 404, { ok: false, code: 'not_found', error: 'Unknown prompt-polish route' })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use POST' })
            return
          }
          const body = await readJsonBody(req).catch(() => undefined)
          if (body === undefined) {
            sendJson(res, 400, { ok: false, code: 'invalid_request', error: 'Expected a JSON body under 256 KiB' })
            return
          }
          const controller = new AbortController()
          const cancel = () => controller.abort()
          const timeout = setTimeout(cancel, CALL_TIMEOUT_MS)
          timeout.unref()
          res.once('close', cancel)
          try {
            sendJson(res, 200, await polish(ctx, body, controller.signal))
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              code: 'internal',
              error: error instanceof Error ? error.message : String(error),
            })
          } finally {
            clearTimeout(timeout)
            res.removeListener('close', cancel)
          }
        },
      }),
    'prompt-polish: polish route',
  )
}
