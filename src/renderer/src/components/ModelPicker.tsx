import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft } from 'lucide-react'
import { PROVIDERS, type ModelInfo, type ProviderId } from '../../../shared/types.ts'
import { usePane } from '../pane.ts'
import { loadModels, paneAt, selectModel, setProvider, useApp } from '../store.ts'
import { ProviderGlyph } from './glyphs.tsx'

// Provider first, model second: the menu lists the four providers, and resting on one opens its
// models beside it. The model list opens to the left because the trigger sits at the right end
// of the composer, which keeps the whole menu over the chat column and never over the browser
// (a native view that would paint on top of it).

function Models({ provider, onPick }: { provider: ProviderId; onPick: () => void }) {
  const pane = usePane()
  const models = useApp((state) => state.models[provider])
  const chosen = useApp((state) => paneAt(state, pane).modelChoice[provider])
  const label = PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider
  const pick = (model: ModelInfo | null): void => {
    selectModel(pane, provider, model)
    onPick()
  }
  return (
    <div className="picker-models" role="menu" aria-label={`${label} models`}>
      <div className="picker-heading">{label} models</div>
      {!models && <div className="picker-empty">Reading models…</div>}
      {models?.length === 0 && <div className="picker-empty">No models reported. Check that {label} is installed and signed in.</div>}
      {models && models.length > 0 && !models.some((model) => model.isDefault) && (
        <button type="button" role="menuitemradio" aria-checked={!chosen} className="picker-model" onClick={() => pick(null)}>
          <span className="picker-model-text">
            <span className="picker-model-name">Default</span>
            <span className="picker-model-note">Whatever {label} is set to use</span>
          </span>
          {!chosen && <Check size={14} className="picker-check" />}
        </button>
      )}
      {models?.map((model) => {
        const selected = chosen ? chosen.id === model.id : model.isDefault
        return (
          <button
            key={model.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className="picker-model"
            // Choosing the provider's own default clears the override, so it follows the provider.
            onClick={() => pick(model.isDefault ? null : model)}
          >
            <span className="picker-model-text">
              <span className="picker-model-name">
                {model.label}
                {model.isDefault && <span className="picker-default">Default</span>}
              </span>
              {model.description && <span className="picker-model-note">{model.description}</span>}
            </span>
            {selected && <Check size={14} className="picker-check" />}
          </button>
        )
      })}
    </div>
  )
}

export function ModelPicker({ onClose }: { onClose?: () => void }) {
  const pane = usePane()
  const provider = useApp((state) => paneAt(state, pane).provider)
  const modelChoice = useApp((state) => paneAt(state, pane).modelChoice)
  const models = useApp((state) => state.models)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState<ProviderId>(provider)
  const root = useRef<HTMLDivElement>(null)

  const modelLabel = (id: ProviderId): string | null =>
    modelChoice[id]?.label ?? models[id]?.find((model) => model.isDefault)?.label ?? null

  const close = (): void => {
    setOpen(false)
    onClose?.()
  }

  useEffect(() => {
    if (!open) return
    setHovered(provider)
    for (const entry of PROVIDERS) void loadModels(entry.id)
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const current = PROVIDERS.find((entry) => entry.id === provider)!
  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className={`picker-trigger provider-${provider}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose the provider and model for the next message"
        onClick={() => setOpen(!open)}
      >
        <ProviderGlyph provider={provider} size={14} />
        <span className="picker-trigger-name">{current.label}</span>
        {modelLabel(provider) && <span className="picker-trigger-model">{modelLabel(provider)}</span>}
        <ChevronDown size={13} className="picker-caret" />
      </button>
      {open && (
        <div className="picker-menu">
          <Models provider={hovered} onPick={close} />
          <div className="picker-providers" role="menu" aria-label="Providers">
            {PROVIDERS.map(({ id, label }, index) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={provider === id}
                className={`picker-provider provider-${id}${hovered === id ? ' is-hovered' : ''}`}
                onMouseEnter={() => setHovered(id)}
                onFocus={() => setHovered(id)}
                onClick={() => {
                  setProvider(pane, id)
                  close()
                }}
              >
                <ChevronLeft size={13} className="picker-arrow" />
                <span className="picker-provider-glyph"><ProviderGlyph provider={id} size={15} /></span>
                <span className="picker-provider-text">
                  <span className="picker-provider-name">{label}</span>
                  <span className="picker-model-note">{modelLabel(id) ?? 'Default model'}</span>
                </span>
                {provider === id ? <Check size={14} className="picker-check" /> : <kbd className="picker-key">⌃{index + 1}</kbd>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
