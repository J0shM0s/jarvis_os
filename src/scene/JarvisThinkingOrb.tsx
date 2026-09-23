import { ThinkingOrb } from 'thinking-orbs'
import type { OrbState } from 'thinking-orbs'
import { useStore, type Phase } from '../store'
import type { Drive } from './Scene'

// Phase -> OrbState mapping, hand-tuned for Jarvis semantics
const PHASE_TO_ORB: Record<Phase, OrbState> = {
  offline: 'breathing',   // calm, slow ring
  boot: 'connecting',     // wiring constellation - boot sequence
  dormant: 'breathing',   // idle breath
  waking: 'connecting',   // coming online
  listening: 'listening', // waveform through rings
  thinking: 'solving',    // bands scramble - deep thought
  tooling: 'searching',   // scan meridian - working / searching
  speaking: 'composing',  // undulating sash - composing answer
}

// Fallbacks for tooling sub-states via activeTool
function stateForPhase(phase: Phase, activeTool: string | null): OrbState {
  if (phase === 'tooling' && activeTool) {
    const t = activeTool.toLowerCase()
    if (t.includes('search') || t.includes('exa') || t.includes('serper')) return 'searching'
    if (t.includes('chrome') || t.includes('browser')) return 'searching'
    if (t.includes('write') || t.includes('edit') || t.includes('univer')) return 'weaving'
    if (t.includes('image') || t.includes('higgs') || t.includes('generate')) return 'shaping'
    if (t.includes('memory') || t.includes('brain')) return 'weaving'
    return 'working' // generic working for other tools
  }
  return PHASE_TO_ORB[phase] ?? 'breathing'
}

// Speed multiplier per phase — matches old spinFor but for 2D orb
const speedFor: Record<Phase, number> = {
  offline: 0.5,
  boot: 1.2,
  dormant: 0.6,
  waking: 1.4,
  listening: 1.0,
  thinking: 1.3,
  tooling: 1.5,
  speaking: 0.9,
}

export function JarvisThinkingOrb({ drive }: { drive: Drive }) {
  const phase = useStore(s => s.phase)
  const activeTool = useStore(s => s.activeTool)
  const level = useStore(s => s.level)

  // Use Drive for color/scale/intensity so UI controls still work
  // drive is mutated every frame via Rig, we read it directly for reactive values
  const orbState = stateForPhase(phase, activeTool)
  const baseSpeed = speedFor[phase] ?? 1

  // Scale via CSS: ThinkingOrb size is fixed 64, we scale the wrapper
  // drive.reactor.scale 0.2..3 maps to 64*scale
  const scale = drive.reactor.scale
  const intensity = drive.reactor.intensity
  const visible = drive.reactor.visible

  // Color tint: thinking-orbs is monochrome, we tint via filter
  // Use CSS drop-shadow + hue-rotate to approximate accent color
  const accent = drive.reactor.color.getStyle() // e.g. #00e5ff
  // For true monochrome we just overlay a colored glow; the orb itself stays light on dark
  // Use opacity for intensity, scale for size
  const size = 64 // base preset

  const wrapperStyle: React.CSSProperties = {
    position: 'fixed',
    left: '50%',
    top: '50%',
    transform: `translate(-50%, calc(-50% - 2vh)) scale(${scale * 4.2})`,
    opacity: visible ? Math.min(1, 0.9 * intensity + 0.1) : 0,
    filter: `drop-shadow(0 0 22px ${accent}) drop-shadow(0 0 42px ${accent}66)`,
    transition: 'opacity 400ms ease, filter 600ms ease',
    pointerEvents: 'none',
    zIndex: 2,
  }

  const pulseScale = 1 + level * 0.04
  const finalStyle: React.CSSProperties = {
    ...wrapperStyle,
    transform: `translate(-50%, calc(-50% - 2vh)) scale(${scale * 4.2 * pulseScale})`,
  }

  // Theme dark for Jarvis (light ink on dark bg)
  // Speed includes level influence like old uPhase
  const speed = baseSpeed * (0.9 + level * 0.6) * drive.reactor.spin

  return (
    <div style={finalStyle} aria-hidden>
      <ThinkingOrb
        state={orbState}
        size={size as 64}
        theme="dark"
        speed={speed}
        style={{ display: 'block' }}
      />
    </div>
  )
}
