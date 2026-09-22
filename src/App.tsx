import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import { loadWorkflows, parseWorkflowCommand, saveWorkflow, type WorkflowCommand } from './lib/workflows'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchOsLog,
  watchSandboxImage,
  watchSandboxActive,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel, setMicEnabled } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { startQuotaPolling } from './lib/quota'
import { env } from './config'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const bm = store.getState().businessMode
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }, { businessMode: bm })

      if (stale()) return

      /**
       * A turn can resolve without a single streamed delta — an SDK build that
       * emits whole messages, or a result that arrives before the first
       * partial event. Until this existed the resolved text was dropped: no
       * transcript entry, nothing spoken, and the HUD snapped straight back
       * from thinking to listening to standby, which read exactly like an
       * assistant that ignores you. Such turns get the same treatment a
       * streamed one got: transcript, caption and voice. Only unstreamed
       * turns land here — a streamed one already has its deltas in the
       * transcript, and appending the final text would say it all twice.
       */
      if (!started && text) {
        started = true
        store.getState().setPhase('speaking')
        store.getState().setActiveTool(null)
        music.working(false)
        store.getState().pushTurn({ id: turnId, role: 'jarvis', text })
        spk.push(text)
      }

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      const msg = err instanceof Error ? err.message : 'Something went wrong.'
      /**
       * The free brain's day is spent. A raw 429 message would name retry
       * budgets and headers; what the person needs to know is that he is not
       * ignoring them and when he will be back. Spoken, once, plainly.
       */
      if (/rate.?limit|429|quota/i.test(msg)) {
        const quota = store.getState().quota
        const reset = quota?.reset ? new Date(quota.reset) : null
        const when =
          reset && reset.getTime() > Date.now()
            ? ` I will be back at ${reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
            : ' The daily allowance resets at midnight.'
        const line = `My free daily allowance is spent, sir.${when}`
        store.getState().setError(line)
        spk.say(line)
      } else {
        store.getState().setError(msg)
      }
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase —
   *  and muted overrules everything: M takes the ears away entirely, so the
   *  recogniser goes deaf even though the phases keep moving underneath. */
  const mode = (): VoiceMode => {
    if (store.getState().micMuted) return 'deaf'
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      const wcmd = parseWorkflowCommand(trailing)
      if (wcmd) {
        handleWorkflowCommand(wcmd)
        return
      }
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    // Workflow commands are matched on the raw line before the model sees it:
    // "run workflow standup" is a command, not a question about standups.
    const wcmd = parseWorkflowCommand(said)
    if (wcmd) {
      handleWorkflowCommand(wcmd)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- workflows ------------------------------------------------------------
  // Named prompt presets. "create a workflow named standup making ..." saves
  // the sentence; "run workflow standup" replays it through the normal turn
  // pipeline — tools, panels, speech — exactly as if it had just been said.
  // Storage is per-browser localStorage (see lib/workflows); list and delete
  // keep the feature drivable entirely by voice.

  const handleWorkflowCommand = (cmd: WorkflowCommand): void => {
    const ack = createSpeaker()
    switch (cmd.kind) {
      case 'create': {
        saveWorkflow(cmd.name, cmd.prompt)
        speaker.current = ack
        ack.say(`Workflow ${cmd.name} saved.`)
        void ack.end()
        listen(FOLLOW_UP_MS)
        return
      }
      case 'run': {
        const prompt = loadWorkflows()[cmd.name]
        if (!prompt) {
          speaker.current = ack
          ack.say(`No workflow named ${cmd.name}.`)
          void ack.end()
          listen(FOLLOW_UP_MS)
          return
        }
        // Same visual spin-up as a wake, then the ordinary pipeline — so
        // barge-in and follow-ups behave exactly like any other turn.
        store.getState().setPhase('waking')
        void respond(prompt)
        return
      }
      case 'delete': {
        const existed = cmd.name in loadWorkflows()
        saveWorkflow(cmd.name, '')
        speaker.current = ack
        ack.say(existed ? `Workflow ${cmd.name} deleted.` : `There was no workflow named ${cmd.name}.`)
        void ack.end()
        listen(FOLLOW_UP_MS)
        return
      }
      case 'list': {
        const names = Object.keys(loadWorkflows()).sort()
        speaker.current = ack
        ack.say(
          names.length
            ? `You have ${names.length === 1 ? 'one workflow' : `${names.length} workflows`}: ${names.join(', ')}.`
            : 'No workflows saved yet. Create one by saying: create a workflow named ... making ...',
        )
        void ack.end()
        listen(FOLLOW_UP_MS)
        return
      }
    }
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // Live OS log — jede Maus/Tastatur-Aktion meldet sich vor Ausführung (async, non-blocking)
    watchOsLog((text) => store.getState().pushOsLog(text))
    watchSandboxImage((dataUrl) => {
      const s = store.getState()
      if (dataUrl) s.setSandboxImage(dataUrl)
      s.setSandboxActive(true)
    })
    watchSandboxActive((on) => store.getState().setSandboxActive(on))
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await new Promise((r) => setTimeout(r, 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())
    // Probe FIRST, then name the voice. currentVoiceName() reports ElevenLabs
    // when the bridge says it has a key — asked before the probe, it can only
    // answer "default", and the HUD then labelled a session that was speaking
    // ElevenLabs as the browser voice until the next time V was pressed.

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()
    store.getState().setVoice(currentVoiceName())
    startQuotaPolling()

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

    store.getState().setPhase('dormant')
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- typed turns (keyboard fallback beside voice-first) ---------------------

  /**
   * A line from the composer takes the exact same road as a spoken utterance:
   * it interrupts an answer in flight and becomes the new turn. Voice keeps
   * running underneath — typing never mutes the loop.
   */
  const onTypedText = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)

    // A bare "jarvis" typed alone is a greeting, not a question.
    if (BARE_NAME.test(text)) {
      // From standby this is the wake itself; mid-conversation just re-open
      // the window without bothering the model.
      if (phase === 'dormant') onWake('')
      else listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim() || text

    // Typed lines can drive workflows too — same grammar as speech.
    const wcmd = parseWorkflowCommand(said)
    if (wcmd) {
      handleWorkflowCommand(wcmd)
      return
    }

    if (phase === 'dormant' || phase === 'waking' || phase === 'listening') {
      // Waking: the greeting may still be mid-sentence — cut it first, or the
      // typed answer and the greeting speak over each other.
      if (phase === 'waking') onSpeechStart()
      void respond(said)
      return
    }
    // Busy (thinking / tooling / speaking): cut him off first, exactly like
    // a spoken barge-in, then answer the typed line.
    onSpeechStart()
    void respond(said)
  }

  const pendingText = useStore((s) => s.pendingText)
  useEffect(() => {
    if (!pendingText) return
    store.getState().clearPendingText()
    onTypedText(pendingText.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingText])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      // Focused interactive controls own the keyboard: the global shortcuts
      // preventDefault, which would swallow a blade button's native Enter
      // activation and stop typing/selecting inside form fields entirely.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'BUTTON' ||
        tag === 'A' ||
        tag === 'SELECT' ||
        target?.isContentEditable
      )
        return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // M mutes the microphone — M again unmutes. The shared track is what
      // actually flips (see setMicEnabled), so VAD, the reactor meter and any
      // recording go silent in one place, and the browser recogniser fallback
      // is silenced through mode()'s deaf override. Space still talks, and the
      // composer still types: mute takes the ears, not the whole assistant.
      if (
        (e.key === 'm' || e.key === 'M') &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const st = store.getState()
        if (st.phase === 'offline') return
        const next = !st.micMuted
        // An analyser fed by a suspended track would freeze its meter at a
        // stale level and leave the reactor pulsing to a ghost; zero it now.
        if (next) store.getState().setLevel(0)
        st.setMicMuted(next)
        setMicEnabled(!next)
        return
      }

      // S speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (
        (e.key === 's' || e.key === 'S') &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all. Except while the composer is open: then it only
      // closes the box, so a stray Escape never kills the conversation.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().composerOpen) {
          store.getState().setComposerOpen(false)
          return
        }
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // T / Enter opens the keyboard composer — the fallback beside
      // voice-first. Voice stays primary: the loop keeps running underneath,
      // Enter inside the box sends the line through the same turn pipeline
      // as speech. K and / stay as aliases.
      if (
        (e.key === 't' ||
          e.key === 'T' ||
          e.key === 'k' ||
          e.key === 'K' ||
          e.key === '/' ||
          e.key === 'Enter') &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const st = store.getState()
        if (st.phase === 'offline') {
          // Enter (and T) also boot from the ignition screen, like Space.
          if (e.key === 'Enter' || e.key === 't' || e.key === 'T') {
            e.preventDefault()
            void powerOn()
          }
          return
        }
        if (st.phase === 'boot') return
        // While open, Enter belongs to the box (send), not to this toggle.
        if (st.composerOpen && e.key === 'Enter') return
        e.preventDefault()
        st.setComposerOpen(!st.composerOpen)
        return
      }

      // B toggles Business Partner mode — own brain, own tone.
      if ((e.key === 'b' || e.key === 'B') && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const st = store.getState()
        if (st.phase === 'offline' || st.phase === 'boot') return
        const next = !st.businessMode
        st.setBusinessMode(next)
        // Visual cue: amber in business, back to phase colour when leaving.
        if (next) {
          st.applyUi({ accent: '#f0a93c', background: '#1a1200' })
          st.fireEffect('pulse')
          sfx.play('wake')
          silence()
          const spk = createSpeaker()
          speaker.current = spk
          spk.say('Business mode. I am your partner now. What are we building?')
          void spk.end()
          st.pushTurn({ id: newId(), role: 'jarvis', text: 'Business mode — partner brain active.' })
        } else {
          st.applyUi({ accent: null, background: null })
          st.fireEffect('pulse')
          sfx.play('done')
          silence()
          const spk = createSpeaker()
          speaker.current = spk
          spk.say('Back to private mode, sir.')
          void spk.end()
          st.pushTurn({ id: newId(), role: 'jarvis', text: 'Private mode restored.' })
        }
        return
      }

      // O clears OS log
      if ((e.key === 'o' || e.key === 'O') && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        store.getState().clearOsLogs()
        sfx.play('done')
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    // The mic lives as long as the page, and so does M's mute — but so does a
    // browser's habit of swapping tracks from under a running stream (device
    // switch, driver reset, OS sleep). The replacement arrives unmuted whatever
    // the store says, so the mute is re-asserted for as long as it is held.
    // One interval for the life of the page is cheaper than wiring track
    // 'mute' events on every track the stream will ever contain.
    const micWatch = setInterval(() => {
      if (store.getState().micMuted) setMicEnabled(false)
    }, 1000)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      clearInterval(micWatch)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // TAP button — gleiche Logik wie Space
  useEffect(() => {
    const tap = () => {
      const phase = store.getState().phase
      if (phase === 'offline') void powerOn()
      else if (phase === 'boot') return
      else if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    ;(window as unknown as { __jarvisTap?: () => void }).__jarvisTap = tap
    return () => { delete (window as unknown as { __jarvisTap?: () => void }).__jarvisTap }
  }, [])

  return (
    <>
      <Scene />
      <Hud />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
