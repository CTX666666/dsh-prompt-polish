/**
 * Prompt Polish — Client half.
 *
 * Renders Work Buddy's "enhance prompt" button in the composer's trailing
 * control seat (immediately before the model selector, exactly where Work
 * Buddy puts it) and drives one Host polish call for the current draft.
 *
 * Left click polishes; right click opens the style menu (balanced / concise /
 * detailed / code). The chosen style persists in localStorage and defaults to
 * balanced. The Host always applies its fidelity guard and always reads the
 * conversation context, so neither is a menu item.
 *
 * Behaviour is Work Buddy's:
 * - hidden while the draft is empty and nothing was rewritten;
 * - a spinner replaces the icon while the rewrite runs, and a second click
 *   cancels it and restores the original draft;
 * - after a successful rewrite the button becomes a revert arrow, so the
 *   original text stays one click away;
 * - editing the rewritten text drops that backup (nothing left to revert to);
 * - a failure keeps the draft untouched and shows the reason in the tooltip.
 *
 * The model is not chosen here: the Host reads the Session's own durable
 * model selection, so the polish call always uses the model the conversation
 * is already on.
 */

window.__ModuleLoader__.load({
  id: '@local/prompt-polish',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'promptPolish'
    const ROUTE = '/dsh-prompt-polish/polish'
    /** Where the chosen style survives reloads. */
    const STYLE_KEY = 'dsh-prompt-polish.style'
    /** Menu order; the first entry is the default. */
    const STYLE_ORDER = ['balanced', 'concise', 'detailed', 'code']

    /** Theme-token styling, matching Work Buddy's `cr-enhance-button` geometry. */
    const CSS = `
.dsh-pp-wrap { position: relative; display: inline-flex; align-items: center; }
.dsh-pp-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, opacity 0.15s ease;
}
.dsh-pp-button:hover:not(:disabled) { background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dsh-pp-button:active:not(:disabled) { opacity: 0.8; }
.dsh-pp-button:disabled { opacity: 0.4; cursor: not-allowed; }
.dsh-pp-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-pp-button[data-state="loading"] { cursor: default; }
.dsh-pp-button[data-state="revert"] { color: var(--dsw-alias-label-tertiary); }
.dsh-pp-button > svg { width: 16px; height: 16px; flex-shrink: 0; }
.dsh-pp-spinner { display: flex; align-items: center; justify-content: center; animation: dsh-pp-spin 1s linear infinite; }
.dsh-pp-spinner > svg { width: 16px; height: 16px; }
@keyframes dsh-pp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.dsh-pp-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 168px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.18));
}
.dsh-pp-menu-title {
  padding: 6px 8px 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dsh-pp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-pp-item:hover { background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dsh-pp-item[aria-checked="true"] { color: var(--dsw-alias-brand-primary); }
.dsh-pp-check { width: 14px; flex: none; text-align: center; }
`

    /** Work Buddy's enhance icon: a double star spark. */
    function EnhanceIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
        h('path', {
          fill: 'currentColor',
          fillOpacity: '0.7',
          transform: 'matrix(1 0 0 1 0.524459 0.757238)',
          d: 'M6.1838 2.2198C6.6022 1.3093 7.8641 1.2266 8.1057 2.0938L8.84 4.7335C8.992 5.2783 9.3896 5.6893 9.929 5.8595L12.5432 6.6827C13.4014 6.9536 13.2757 8.2113 12.3517 8.5987L9.9973 9.5861L9.8362 9.6583C9.0366 10.0399 8.3731 10.7089 8.0031 11.5138L6.9377 13.8341L6.8488 13.9943C6.3971 14.7003 5.39 14.7669 5.0735 14.1115L5.0158 13.9601L4.2815 11.3205C4.1485 10.8435 3.8277 10.4679 3.3879 10.2677L3.1916 10.1935L0.5783 9.3712C-0.2801 9.1005 -0.155 7.8418 0.7687 7.4542L3.1242 6.4679C3.9412 6.1253 4.632 5.4846 5.0403 4.6983L5.1183 4.5392L6.1838 2.2198ZM6.2004 4.88C5.652 6.0736 4.6394 7.0538 3.4279 7.5616L1.5295 8.3565L3.719 9.046C4.5745 9.3157 5.2059 9.9689 5.4465 10.8331L6.0608 13.0431L6.9201 11.174C7.4685 9.9802 8.4821 9.0001 9.6935 8.4923L11.591 7.6964L9.4025 7.0069C8.547 6.7373 7.9156 6.085 7.675 5.2208L7.0598 3.0099L6.2004 4.88ZM12.7072 0.214C12.8295 -0.052 13.198 -0.0764 13.2687 0.1768L13.6194 1.4395C13.6415 1.5192 13.7005 1.5797 13.7795 1.6046L15.0285 1.9981C15.2795 2.0772 15.243 2.4445 14.9728 2.5577L13.6281 3.1212C13.5431 3.1568 13.4722 3.226 13.4338 3.3097L12.8254 4.6349C12.703 4.9009 12.3344 4.9245 12.2639 4.671L11.9124 3.4093C11.8901 3.3296 11.8319 3.2691 11.7531 3.2442L10.5031 2.8507C10.2522 2.7715 10.2888 2.4045 10.5588 2.2911L11.9035 1.7267C11.9884 1.6911 12.0593 1.6228 12.0978 1.5392L12.7072 0.214Z',
        }),
      )
    }

    /** Work Buddy's revert icon: a counter-clockwise arrow. */
    function RevertIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M3 7.5C3 7.5 4.5 4 8 4C11.5 4 13 7 13 8.5C13 10 11.5 12 8 12C5.5 12 4.27 10.77 3.5 10',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3 4V7.5H6.5',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Work Buddy's loading ring. */
    function LoadingSpinner() {
      return h(
        'span',
        { className: 'dsh-pp-spinner' },
        h(
          'svg',
          { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
          h('circle', {
            cx: '8',
            cy: '8',
            r: '6',
            stroke: 'currentColor',
            strokeWidth: '2',
            strokeLinecap: 'round',
            strokeDasharray: '28 10',
          }),
        ),
      )
    }

    /** One valid style id, falling back to the default. */
    function pickStyle(value) {
      return typeof value === 'string' && STYLE_ORDER.includes(value) ? value : STYLE_ORDER[0]
    }

    /** The persisted style; storage failures fall back to the default. */
    function readStyle() {
      try {
        return pickStyle(window.localStorage.getItem(STYLE_KEY))
      } catch {
        return STYLE_ORDER[0]
      }
    }

    /** Persist one style; a refused write only costs the preference. */
    function writeStyle(styleId) {
      try {
        window.localStorage.setItem(STYLE_KEY, styleId)
      } catch {
        /* private mode or a full quota: the in-memory choice still applies */
      }
    }

    function PolishButton(props) {
      const { sessionId, useInput, inputActions, t } = props
      const draft = useInput((state) => state.draft)
      const phase = useInput((state) => state.phase)

      const [status, setStatus] = useState('idle')
      const [errorMessage, setErrorMessage] = useState(undefined)
      const [backup, setBackup] = useState(undefined)
      const [styleId, setStyleId] = useState(readStyle)
      const [menuOpen, setMenuOpen] = useState(false)
      const controllerRef = useRef(undefined)
      const wrapRef = useRef(null)
      /** True between writing the rewrite and observing it in the draft store. */
      const awaitingApplyRef = useRef(false)

      const setDraft = inputActions?.setDraft
      const text = typeof draft === 'string' ? draft : ''
      const hasContent = text.trim().length > 0
      const busy = phase === 'adjudicating' || phase === 'submitting'
      const currentRef = useRef({ text, sessionId, busy })
      currentRef.current = { text, sessionId, busy }

      // Draft edits, submission and navigation invalidate an in-flight rewrite.
      useEffect(() => {
        if (controllerRef.current === undefined) return
        controllerRef.current.abort()
        controllerRef.current = undefined
        setStatus('idle')
      }, [text, sessionId, busy])

      useEffect(() => {
        awaitingApplyRef.current = false
        setBackup(undefined)
        setStatus('idle')
        setErrorMessage(undefined)
      }, [sessionId])

      // Editing the rewritten text drops the revert backup: there is nothing
      // left to revert to once the user has moved past the model's version.
      useEffect(() => {
        if (backup === undefined) return
        const same = text === backup.after
        if (awaitingApplyRef.current) {
          if (same) awaitingApplyRef.current = false
          return
        }
        if (same) return
        setBackup(undefined)
        setStatus((current) => (current === 'revert' ? 'idle' : current))
      }, [text, backup])

      useEffect(
        () => () => {
          controllerRef.current?.abort()
          controllerRef.current = undefined
        },
        [],
      )

      // The menu closes on an outside press, Escape, or a scroll that would
      // leave it detached from the button.
      useEffect(() => {
        if (!menuOpen) return undefined
        const onPointerDown = (event) => {
          if (wrapRef.current !== null && wrapRef.current.contains(event.target)) return
          setMenuOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenuOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        const onBlur = () => setMenuOpen(false)
        window.addEventListener('blur', onBlur)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('blur', onBlur)
        }
      }, [menuOpen])

      const chooseStyle = useCallback((nextStyle) => {
        setStyleId(nextStyle)
        writeStyle(nextStyle)
        setMenuOpen(false)
      }, [])

      const trigger = useCallback(async () => {
        if (typeof setDraft !== 'function') return
        const original = text
        if (original.trim() === '') return
        controllerRef.current?.abort()
        const controller = new AbortController()
        controllerRef.current = controller
        setErrorMessage(undefined)
        setStatus('loading')
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: original,
              style: styleId,
              // The Host always adds conversation context; the flag documents intent.
              context: true,
              ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
            }),
            signal: controller.signal,
          })
          const payload = await response.json().catch(() => undefined)
          if (controllerRef.current !== controller || controller.signal.aborted) return
          controllerRef.current = undefined
          const current = currentRef.current
          if (current.text !== original || current.sessionId !== sessionId || current.busy) {
            setStatus('idle')
            return
          }
          if (response.ok && payload?.ok === true && typeof payload.text === 'string' && payload.text.trim() !== '') {
            awaitingApplyRef.current = true
            setDraft(payload.text)
            setBackup({ before: original, after: payload.text })
            setStatus('revert')
            return
          }
          setStatus('error')
          setErrorMessage(typeof payload?.error === 'string' ? payload.error : t('failed'))
        } catch (error) {
          if (controllerRef.current !== controller) return
          controllerRef.current = undefined
          if (error?.name === 'AbortError') {
            setStatus('idle')
            return
          }
          setStatus('error')
          setErrorMessage(error instanceof Error ? error.message : String(error))
        }
      }, [setDraft, text, sessionId, styleId, t])

      const cancel = useCallback(() => {
        controllerRef.current?.abort()
        controllerRef.current = undefined
        setStatus('idle')
        setErrorMessage(undefined)
      }, [])

      const revert = useCallback(() => {
        if (typeof setDraft !== 'function' || backup === undefined) return
        awaitingApplyRef.current = false
        setDraft(backup.before)
        setBackup(undefined)
        setStatus('idle')
        setErrorMessage(undefined)
      }, [setDraft, backup])

      if (typeof setDraft !== 'function') return null
      const loading = status === 'loading'
      const reverting = status === 'revert' && backup !== undefined
      // Work Buddy hides the control until there is something to rewrite.
      if (!loading && !reverting && errorMessage === undefined && !hasContent) return null

      const styleLabel = t(`style.${styleId}`)
      const label =
        errorMessage ?? (loading ? t('enhancing') : reverting ? t('revert') : `${t('tooltip')} · ${styleLabel}`)
      const disabled = loading ? false : busy || !hasContent
      const onClick = loading ? cancel : reverting ? revert : trigger

      const menu =
        menuOpen && !loading
          ? h(
              'div',
              { className: 'dsh-pp-menu', role: 'menu', 'aria-label': t('styleMenu') },
              h('div', { className: 'dsh-pp-menu-title' }, t('styleMenu')),
              ...STYLE_ORDER.map((id) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    className: 'dsh-pp-item',
                    role: 'menuitemradio',
                    'aria-checked': id === styleId,
                    'data-style': id,
                    onClick: () => chooseStyle(id),
                  },
                  h('span', { className: 'dsh-pp-check' }, id === styleId ? '✓' : ''),
                  h('span', null, t(`style.${id}`)),
                ),
              ),
            )
          : null

      return h(
        React.Fragment,
        null,
        h('style', { 'data-plugin': '@local/prompt-polish' }, CSS),
        h(
          'span',
          { className: 'dsh-pp-wrap', ref: wrapRef },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-pp-button',
              'data-state': loading ? 'loading' : reverting ? 'revert' : 'idle',
              'data-style': styleId,
              'data-dsh-prompt-polish': '',
              onClick,
              onContextMenu: (event) => {
                event.preventDefault()
                if (loading) return
                setMenuOpen((open) => !open)
              },
              onKeyDown: (event) => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  if (!loading) setMenuOpen((open) => !open)
                }
              },
              disabled,
              title: label,
              'aria-label': label,
              'aria-haspopup': 'menu',
              'aria-expanded': menuOpen,
            },
            loading ? h(LoadingSpinner) : reverting ? h(RevertIcon) : h(EnhanceIcon),
          ),
          menu,
        ),
      )
    }

    return {
      name: 'prompt-polish-client',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: {
                tooltip: '润色提示词',
                enhancing: '润色中…',
                revert: '恢复原文',
                failed: '润色失败',
                styleMenu: '润色风格（右键切换）',
                'style.balanced': '平衡',
                'style.concise': '精简',
                'style.detailed': '详细',
                'style.code': '代码',
              },
              en: {
                tooltip: 'Polish prompt',
                enhancing: 'Polishing…',
                revert: 'Revert',
                failed: 'Polish failed',
                styleMenu: 'Polish style (right-click to change)',
                'style.balanced': 'Balanced',
                'style.concise': 'Concise',
                'style.detailed': 'Detailed',
                'style.code': 'Code',
              },
            }),
          'prompt-polish: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'prompt-polish',
              order: 20,
              inject: () => ({ t }),
            },
            PolishButton,
          ),
        )
      },
    }
  },
})
