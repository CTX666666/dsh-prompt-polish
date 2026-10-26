import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { apply } from '../src/index.js'

async function harness(t, { outputs = ['请清楚地解释这段代码。'], events = [], selection, providers = [{ id: 'test' }], stream } = {}) {
  const calls = []
  let handler
  const ctx = {
    effect: (run) => run(),
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    get: (key) => ({
      agents: { get: () => ({ session: { seq: events.length, snapshotEvents: (from, end) => events.slice(from, end) } }) },
      sessionProjections: { stateOf: () => ({ pending: selection, lastUsed: null }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'default' }) },
    })[key],
    llm: {
      listProviders: () => providers,
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }),
      stream: async function* (options) {
        calls.push(options)
        if (stream) { yield* stream(options); return }
        const output = outputs.shift()
        if (output instanceof Error) throw output
        yield { type: 'text-delta', text: output ?? '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  apply(ctx)
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/dsh-prompt-polish/polish`
  const request = async (body, options = {}) => {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(body), ...options })
    return { status: response.status, ...await response.json() }
  }
  return { calls, request, url }
}

test('polishes using the session model and supported effort', async (t) => {
  const h = await harness(t, { selection: { provider: 'test', model: 'session', reasoningEffort: 'high' } })
  const result = await h.request({ text: '解释代码', sessionId: 'current', provider: 'test', model: 'client' })
  assert.equal(result.ok, true)
  assert.equal(result.model, 'session')
  assert.equal(h.calls[0].reasoningEffort, 'high')
  assert.equal(h.calls[0].sessionId, 'dsh-prompt-polish')
  assert.equal(h.calls[0].messages.length, 1)
})

test('client selection is used before profile default', async (t) => {
  const h = await harness(t)
  assert.equal((await h.request({ text: '解释代码', provider: 'test', model: 'client' })).model, 'client')
})

test('empty provider registry rejects calls', async (t) => {
  const h = await harness(t, { providers: [] })
  assert.equal((await h.request({ text: '解释代码' })).code, 'no_model')
  assert.equal(h.calls.length, 0)
})

test('recent context contains the latest six turns, excluding notices and tools', async (t) => {
  const events = Array.from({ length: 10 }, (_, i) => ({ type: 'user/message', data: {
    source: { kind: 'user' }, content: [{ type: 'text', text: `turn-${i}` }],
  } }))
  events.push({ type: 'user/message', data: { source: { kind: 'model-selection' }, content: [{ type: 'text', text: 'NOTICE' }] } })
  events.push({ type: 'tool/output', data: 'SECRET TOOL LOG' })
  const h = await harness(t, { events })
  await h.request({ text: '解释代码', sessionId: 'current' })
  const prompt = h.calls[0].messages[0].content[0].text
  assert.ok(prompt.includes('turn-9'))
  assert.ok(prompt.includes('turn-4'))
  assert.ok(!prompt.includes('turn-3'))
  assert.ok(!prompt.includes('NOTICE'))
  assert.ok(!prompt.includes('SECRET TOOL LOG'))
})

test('context clipping preserves the newest turn', async (t) => {
  const events = Array.from({ length: 6 }, (_, i) => ({ type: 'user/message', data: {
    source: { kind: 'user' }, content: [{ type: 'text', text: `turn-${i}: ${'中'.repeat(450)}` }],
  } }))
  const h = await harness(t, { events })
  await h.request({ text: '解释代码', sessionId: 'current' })
  const context = h.calls[0].messages[0].content[0].text.split('RECENT CONVERSATION')[1].split('\n\nTASK:')[0]
  assert.ok(context.includes('turn-5'))
  assert.ok(context.length < 1750)
})

test('draft replacement markers and dollar sequences remain literal', async (t) => {
  const text = '保留 {context}、$&、$` 和 $\' 的原样文本'
  const h = await harness(t, { outputs: [text] })
  await h.request({ text })
  assert.ok(h.calls[0].messages[0].content[0].text.includes(text))
})

test('failed fidelity retry never returns text for replacement', async (t) => {
  const h = await harness(t, { outputs: ['解释 React 即可', '继续解释 React'] })
  const result = await h.request({ text: '解释 React 18.3.1 与 fetchUserData' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'fidelity_failed')
  assert.equal(result.text, undefined)
  assert.equal(h.calls.length, 2)
})

test('retry provider error remains a failure instead of returning rejected output', async (t) => {
  const h = await harness(t, { outputs: ['解释 React', new Error('provider offline')] })
  const result = await h.request({ text: '解释 React 18.3.1' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'llm_error')
})

test('one corrective retry can succeed', async (t) => {
  const text = '解释 React 18.3.1 与 fetchUserData'
  const h = await harness(t, { outputs: ['解释 React', `请${text}。`] })
  const result = await h.request({ text })
  assert.equal(result.ok, true)
  assert.equal(result.fidelity, 'corrected')
  assert.equal(h.calls.length, 2)
})

for (const [name, text, output] of [
  ['case-sensitive identifier', '检查 fetchUserData', '检查 fetchuserdata'],
  ['relative filename', '检查 src/App.tsx', '检查其他文件'],
  ['single-digit count', '需要 3 个结果', '需要几个结果'],
  ['numeric boundaries', '需要 3 个结果', '需要 30 个结果'],
  ['identifier boundaries', '检查 fetchUserData', '检查 fetchUserDataCached'],
  ['Chinese path', '检查 D:\\项目\\配置.json', '检查其他目录'],
]) {
  test(`fidelity preserves ${name}`, async (t) => {
    const h = await harness(t, { outputs: [output, output] })
    assert.equal((await h.request({ text })).code, 'fidelity_failed')
  })
}

test('provider failures and empty results keep errors', async (t) => {
  const h = await harness(t, { outputs: [new Error('offline'), ''] })
  assert.equal((await h.request({ text: '解释代码' })).code, 'llm_error')
  assert.equal((await h.request({ text: '解释代码' })).code, 'empty_result')
})

test('validates routes, methods and malformed bodies before model calls', async (t) => {
  const h = await harness(t)
  assert.equal((await h.request({ text: '' })).code, 'empty_input')
  assert.equal((await h.request(null)).status, 400)
  assert.equal((await h.request([])).status, 400)
  assert.equal((await h.request({}, { body: '{' })).status, 400)
  assert.equal((await h.request({}, { body: 'x'.repeat(256 * 1024 + 1) })).status, 400)
  assert.equal((await fetch(h.url)).status, 405)
  assert.equal((await fetch(`${h.url}/unknown`)).status, 404)
  assert.equal(h.calls.length, 0)
})

test('disconnect aborts upstream generation', async (t) => {
  let started
  let aborted
  const running = new Promise((resolve) => { started = resolve })
  const stopped = new Promise((resolve) => { aborted = resolve })
  const h = await harness(t, { stream: async function* ({ signal }) {
    started()
    await new Promise((resolve) => signal.addEventListener('abort', () => { aborted(); resolve() }, { once: true }))
    yield { type: 'finish', reason: { kind: 'aborted' } }
  } })
  const controller = new AbortController()
  const request = fetch(h.url, { method: 'POST', body: JSON.stringify({ text: '解释代码' }), signal: controller.signal }).catch(() => {})
  await running
  controller.abort()
  const result = await Promise.race([stopped.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 200))])
  // Release the baseline's unconnected signal as well so a failed assertion cannot hang the test process.
  if (!result) h.calls[0].signal.dispatchEvent(new Event('abort'))
  await request
  assert.equal(result, true)
})
