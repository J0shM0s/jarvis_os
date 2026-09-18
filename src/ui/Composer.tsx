import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'

/**
 * Keyboard composer — the fallback beside voice-first.
 *
 * Voice stays primary: the mic loop keeps running while this is open.
 * K opens it, Enter sends the line through the exact same turn pipeline
 * as a spoken utterance, Escape closes it without sending.
 */
export function Composer() {
  const open = useStore((s) => s.composerOpen)
  const phase = useStore((s) => s.phase)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      // Wait a frame so AnimatePresence has mounted the input.
      const id = requestAnimationFrame(() => inputRef.current?.focus())
      return () => cancelAnimationFrame(id)
    }
  }, [open ])

  if (phase === 'offline' || phase === 'boot') return null

  return (
    <AnimatePresence>
      {open && (
        <motion.form
          className="composer"
          initial={{ opacity: 0, y: 12, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          exit={{ opacity: 0, y: 12, x: '-50%' }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          onSubmit={(e) => {
            e.preventDefault()
            const value = inputRef.current?.value ?? ''
            if (value.trim()) useStore.getState().submitText(value)
            else useStore.getState().setComposerOpen(false)
          }}
        >
          <span className="composer-kicker">TYPE</span>
          <input
            ref={inputRef}
            className="composer-input"
            placeholder="Ask JARVIS anything…"
            autoComplete="off"
            spellCheck={false}
            maxLength={2000}
            onKeyDown={(e) => {
              // Escape here must only close the box — the global handler
              // would otherwise stand the whole thing down to dormant.
              if (e.key === 'Escape') {
                e.stopPropagation()
                useStore.getState().setComposerOpen(false)
              }
            }}
          />
          <span className="composer-keys">
            <kbd>↵</kbd> send · <kbd>esc</kbd> close
          </span>
        </motion.form>
      )}
    </AnimatePresence>
  )
}
