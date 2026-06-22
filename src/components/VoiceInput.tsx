import { useCallback, useRef, useState } from 'react'
import { Mic, MicOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type VoiceState = 'idle' | 'listening' | 'processing' | 'confirming' | 'speaking'

interface VoiceInputProps {
  /** Called with the final spoken transcript text (before processing). */
  onTranscript?: (text: string) => void
  /** Optional className for the mic button wrapper. */
  className?: string
  /** When true the mic is in "confirm yes/no" mode. */
  confirmMode?: boolean
  /** The question/prompt text to show during confirmation. */
  confirmPrompt?: string
  /** Callback when user confirms or denies via voice or buttons. */
  onConfirm?: (confirmed: boolean) => void
}

/**
 * VoiceInput
 *
 * Browser-native SpeechRecognition (Web Speech API) per ADR-004.
 * Zero server audio cost in v1. Produces transcript -> pipeline.
 *
 * Also provides basic TTS via speechSynthesis for assistant spoken replies.
 */
export function VoiceInput({
  onTranscript,
  className,
  confirmMode = false,
  confirmPrompt,
  onConfirm,
}: VoiceInputProps) {
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  const recognitionRef = useRef<any>(null)
  const synthRef = useRef<SpeechSynthesis | null>(null)

  const isSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      const synth = window.speechSynthesis
      synthRef.current = synth
      synth.cancel()
      const utter = new SpeechSynthesisUtterance(text)
      utter.rate = 1.02
      utter.pitch = 1.0
      utter.onend = () => setState((s) => (s === 'speaking' ? 'idle' : s))
      setState('speaking')
      synth.speak(utter)
    } catch {
      // ignore TTS errors
      setState('idle')
    }
  }, [])

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current
    if (rec) {
      try {
        rec.onresult = null
        rec.onerror = null
        rec.onend = null
        rec.stop()
      } catch {}
      recognitionRef.current = null
    }
    setInterim('')
  }, [])

  const startListening = useCallback(
    (forConfirm = false) => {
      if (!isSupported) {
        setError('Voice not supported in this browser. Use Chrome/Edge or text input.')
        return
      }
      setError(null)
      setTranscript('')
      setInterim('')

      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      const rec = new SR()
      recognitionRef.current = rec

      rec.continuous = false
      rec.interimResults = true
      rec.lang = 'en-US'

      rec.onresult = (event: any) => {
        let finalText = ''
        let currentInterim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i]
          if (res.isFinal) {
            finalText += res[0].transcript
          } else {
            currentInterim += res[0].transcript
          }
        }
        if (currentInterim) setInterim(currentInterim.trim())
        if (finalText) {
          const cleaned = finalText.trim()
          setTranscript(cleaned)
          setInterim('')
          stopListening()

          if (forConfirm) {
            const isYes = /\byes\b|\byep\b|\bcorrect\b|\bdo it\b|\bokay\b/.test(cleaned.toLowerCase())
            const isNo = /\bno\b|\bcancel\b|\bstop\b|\bnevermind\b/.test(cleaned.toLowerCase())
            if (isYes) {
              onConfirm?.(true)
              setShowConfirm(false)
              setState('idle')
              speak('Confirmed.')
            } else if (isNo) {
              onConfirm?.(false)
              setShowConfirm(false)
              setState('idle')
              speak('Cancelled.')
            } else {
              // Ask again
              setState('confirming')
              speak(confirmPrompt || 'Please say yes or no.')
              // restart for confirm after short delay
              setTimeout(() => startListening(true), 650)
            }
          } else {
            onTranscript?.(cleaned)
            setState('processing')
          }
        }
      }

      rec.onerror = (e: any) => {
        stopListening()
        const msg = e?.error === 'no-speech' ? 'No speech detected.' : 'Voice recognition error.'
        setError(msg)
        setState('idle')
      }

      rec.onend = () => {
        recognitionRef.current = null
        if (state === 'listening' || state === 'confirming') {
          setState('idle')
        }
      }

      try {
        rec.start()
        setState(forConfirm ? 'confirming' : 'listening')
      } catch (e) {
        setError('Could not start microphone.')
        setState('idle')
      }
    },
    [isSupported, onTranscript, onConfirm, confirmPrompt, speak, stopListening, state]
  )

  const handleMicClick = () => {
    if (state === 'listening' || state === 'confirming') {
      stopListening()
      setState('idle')
      return
    }
    if (confirmMode) {
      setShowConfirm(true)
      startListening(true)
    } else {
      startListening(false)
    }
  }

  // Expose speak to parent via ref? For now, parent can call global or we process results here too.
  // When parent finishes processing a result, call speak via a small side effect pattern:
  // we also accept processing result here optionally.

  // When not in confirm, if transcript and parent hasn't taken over, auto process.
  // In practice parent (page) wires the call to processVoiceInput and speaks result.

  const processing = state === 'processing'
  const listening = state === 'listening' || state === 'confirming'
  const speaking = state === 'speaking'

  return (
    <>
      <div className={className}>
        <Button
          type="button"
          variant={listening ? 'default' : 'outline'}
          size="icon"
          onClick={handleMicClick}
          disabled={!isSupported || processing || speaking}
          aria-label={listening ? 'Stop listening' : 'Start voice input'}
          title={isSupported ? (listening ? 'Stop' : 'Speak') : 'Voice unsupported'}
          className="size-9"
        >
          {processing || speaking ? (
            <Loader2 className="size-4 animate-spin" />
          ) : listening ? (
            <MicOff className="size-4" />
          ) : (
            <Mic className="size-4" />
          )}
        </Button>
        {(interim || transcript) && (
          <div className="ml-2 text-xs text-muted-foreground max-w-[240px] truncate">
            {interim || transcript}
          </div>
        )}
        {error && <div className="ml-2 text-[10px] text-destructive">{error}</div>}
      </div>

      {/* Confirmation dialog (also used for destructive intents) */}
      <Dialog open={showConfirm} onOpenChange={(o) => {
        if (!o) {
          stopListening()
          setShowConfirm(false)
          setState('idle')
          onConfirm?.(false)
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm with your voice</DialogTitle>
            <DialogDescription>
              {confirmPrompt || 'Say “yes” to proceed or “no” to cancel.'}
            </DialogDescription>
          </DialogHeader>

          <div className="py-3 text-sm">
            {transcript && <div className="italic text-muted-foreground">Heard: “{transcript}”</div>}
            {interim && <div className="text-muted-foreground">Listening… {interim}</div>}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                stopListening()
                setShowConfirm(false)
                setState('idle')
                onConfirm?.(false)
                speak('Cancelled.')
              }}
            >
              No, cancel
            </Button>
            <Button
              onClick={() => {
                stopListening()
                setShowConfirm(false)
                setState('idle')
                onConfirm?.(true)
                speak('Confirmed.')
              }}
            >
              Yes, do it
            </Button>
            <Button variant="ghost" onClick={() => startListening(true)} disabled={listening}>
              {listening ? 'Listening…' : 'Speak yes / no'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Helper to speak assistant text from anywhere (TTS). Safe no-op when unsupported. */
export function speakAssistant(text: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  try {
    const synth = window.speechSynthesis
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.02
    synth.speak(u)
  } catch {
    /* no-op */
  }
}
