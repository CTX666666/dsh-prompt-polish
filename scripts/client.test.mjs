import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

// Drive the shipped component through its hooks and slot contract without adding
// React as a package dependency. These are state/interaction tests, not visual QA.
function harness(t) {
  const hooks = []
  const pendingEffects = []
  const requests = []
  const writes = []
  const listeners = new Map()
  let cursor = 0
  let dirty = false
  let mounted = true
  let component
  let tree
  const state = { draft: '原始草稿', phase: 'idle' }
  const props = { sessionId: 'session-a', useInput: (select) => select(state),
    inputActions: { setDraft: (text) => { writes.push(text); state.draft = text; dirty = true } }, t: (key) => key }
  const changed = (left, right) => !left || left.length !== right.length || left.some((value, i) => !Object.is(value, right[i]))
  const React = {
    Fragment: 'fragment',
    createElement: (type, attributes, ...children) => ({ type, props: attributes ?? {}, children }),
    useState(initial) {
      const index = cursor++
      hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, (next) => {
        const value = typeof next === 'function' ? next(hooks[index].value) : next
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true }
      }]
    },
    useRef(initial) { const index = cursor++; hooks[index] ??= { current: initial }; return hooks[index] },
    useCallback(callback) { cursor++; return callback },
    useEffect(effect, dependencies) {
      const index = cursor++
      if (!changed(hooks[index]?.dependencies, dependencies)) return
      const previous = hooks[index]
      hooks[index] = { dependencies, cleanup: previous?.cleanup }
      pendingEffects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = effect() })
    },
  }
  const events = {
    addEventListener: (type, handler) => { const set = listeners.get(type) ?? new Set(); set.add(handler); listeners.set(type, set) },
    removeEventListener: (type, handler) => listeners.get(type)?.delete(handler),
  }
  const context = {
    AbortController,
    document: events,
    window: { ...events, localStorage: { getItem: () => null, setItem: () => {} },
      __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply({
        effect: (run) => run(), locale: { register: () => () => {}, bind: () => props.t },
        slots: { inject: (_slot, run) => run(), register: (_options, value) => { component = value; return () => {} } },
      }) },
    },
    fetch: (_url, options) => new Promise((resolve) => requests.push({ options, resolve })),
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), context)
  function render() {
    if (!mounted) return
    let renders = 0
    do {
      assert.ok(renders++ < 20, 'component effects must settle')
      dirty = false; cursor = 0; tree = component(props)
      pendingEffects.splice(0).forEach((effect) => effect())
    } while (dirty)
  }
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    return node.children?.flat().map((child) => find(child, predicate)).find(Boolean)
  }
  const button = () => find(tree, (node) => Object.hasOwn(node.props, 'data-dsh-prompt-polish'))
  const unmount = () => { mounted = false; hooks.forEach((hook) => hook?.cleanup?.()) }
  t.after(unmount)
  render()
  return {
    requests, writes, state, props, render, button, unmount,
    listeners: (type) => listeners.get(type)?.size ?? 0,
    set: (values, sessionId = props.sessionId) => { Object.assign(state, values); props.sessionId = sessionId; render() },
    click: () => { const result = button().props.onClick(); render(); return result },
    openMenu: () => { button().props.onContextMenu({ preventDefault() {} }); render() },
    reply: async (index = 0, payload = { ok: true, text: '润色后的草稿' }, ok = true) => {
      requests[index].resolve({ ok, json: async () => payload })
      await new Promise((resolve) => setImmediate(resolve))
      render()
    },
  }
}

test('successful rewrite supports exact undo', async (t) => {
  const h = harness(t)
  void h.click()
  await h.reply()
  assert.equal(h.state.draft, '润色后的草稿')
  assert.equal(h.button().props['data-state'], 'revert')
  h.click()
  assert.equal(h.state.draft, '原始草稿')
})

test('empty draft is hidden; submission disables the button', (t) => {
  const h = harness(t)
  h.set({ draft: '' })
  assert.equal(h.button(), undefined)
  h.set({ draft: '草稿', phase: 'submitting' })
  assert.equal(h.button().props.disabled, true)
})

test('manual edit during generation keeps the newer draft', async (t) => {
  const h = harness(t)
  void h.click()
  h.set({ draft: '用户后来输入的草稿' })
  assert.equal(h.requests[0].options.signal.aborted, true)
  await h.reply()
  assert.equal(h.state.draft, '用户后来输入的草稿')
  assert.equal(h.writes.length, 0)
})

test('navigation cancels generation and clears cross-session undo', async (t) => {
  const h = harness(t)
  void h.click()
  h.set({}, 'session-b')
  await h.reply()
  assert.equal(h.writes.length, 0)
  void h.click()
  await h.reply(1)
  h.set({}, 'session-c')
  assert.equal(h.button().props['data-state'], 'idle')
})

test('submission during generation prevents draft replacement', async (t) => {
  const h = harness(t)
  void h.click()
  h.set({ phase: 'submitting' })
  await h.reply()
  assert.equal(h.writes.length, 0)
})

test('cancel and unmount ignore late responses even if fetch ignores abort', async (t) => {
  const h = harness(t)
  void h.click()
  h.click()
  await h.reply()
  assert.equal(h.writes.length, 0)
  void h.click()
  h.unmount()
  await h.reply(1)
  assert.equal(h.writes.length, 0)
})

test('whitespace editing after rewrite invalidates undo', async (t) => {
  const h = harness(t)
  void h.click()
  await h.reply()
  h.set({ draft: '润色后的草稿 ' })
  assert.equal(h.button().props['data-state'], 'idle')
})

test('HTTP and fidelity failures preserve the original', async (t) => {
  const h = harness(t)
  void h.click()
  await h.reply(0, { ok: true, text: '不应覆盖' }, false)
  assert.equal(h.writes.length, 0)
  void h.click()
  await h.reply(1, { ok: false, code: 'fidelity_failed', error: '保真失败' })
  assert.equal(h.writes.length, 0)
  assert.equal(h.button().props.title, '保真失败')
})

test('menu listeners are removed when closing and unmounting', (t) => {
  const h = harness(t)
  h.openMenu()
  assert.equal(h.listeners('blur'), 1)
  h.openMenu()
  assert.equal(h.listeners('blur'), 0)
  h.openMenu()
  h.unmount()
  assert.equal(h.listeners('blur'), 0)
})
