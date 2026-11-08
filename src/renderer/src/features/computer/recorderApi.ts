// Typed wrappers for "Gravar uma tarefa", the store that mirrors RecorderState, and the narration: the window records
// the microphone (audio only) while the main process watches the screen, follows Pausar/Parar from the state (the
// red indicator can stop it too) and hands the audio to the main process when the recording stops.
import { create } from 'zustand'
import {
  RECORDER,
  type HireInput,
  type RecorderState,
  type RecordingDraft,
  type RecordingPatch,
  type StartRecording
} from '@shared/features/recorder'
import { bridge } from '../../core/api'

export const recorderApi = {
  state: () => bridge.invoke(RECORDER.state),
  start: (input: StartRecording) => bridge.invoke(RECORDER.start, input),
  pause: () => bridge.invoke(RECORDER.pause),
  resume: () => bridge.invoke(RECORDER.resume),
  stop: () => bridge.invoke(RECORDER.stop),
  saveAudio: (id: string, audio: Uint8Array, mime: string) => bridge.invoke(RECORDER.saveAudio, id, audio, mime),
  get: (id: string) => bridge.invoke(RECORDER.get, id),
  update: (id: string, patch: RecordingPatch) => bridge.invoke(RECORDER.update, id, patch),
  discard: (id: string) => bridge.invoke(RECORDER.discard, id),
  transcribe: (id: string) => bridge.invoke(RECORDER.transcribe, id),
  send: (id: string) => bridge.invoke(RECORDER.send, id),
  saveDraft: (id: string, draft: RecordingDraft) => bridge.invoke(RECORDER.saveDraft, id, draft),
  hire: (id: string, input: HireInput) => bridge.invoke(RECORDER.hire, id, input)
}

/** reviewId: a recording to open in the review (the composer's ● Parar sends the person there). */
export const useRecorderStore = create<{ state?: RecorderState; micError?: string; reviewId?: string }>(() => ({}))

// ------------------------------------------------------------------ microphone

let mic: { id: string; rec: MediaRecorder; stream: MediaStream; chunks: Blob[] } | undefined

/** Starts recording the narration for recording `id` (the person agreed to the microphone when starting). */
export async function startMicrophone(id: string): Promise<void> {
  useRecorderStore.setState({ micError: undefined })
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
    const m = { id, rec, stream, chunks: [] as Blob[] }
    rec.ondataavailable = (e) => {
      if (e.data.size) m.chunks.push(e.data)
    }
    rec.start(1000)
    mic = m
  } catch (e) {
    useRecorderStore.setState({
      micError: `O microfone não ligou (${(e as Error).message}). A gravação segue sem a narração: explique por escrito na revisão.`
    })
  }
}

async function finishMicrophone(): Promise<void> {
  const m = mic
  if (!m) return
  mic = undefined
  await new Promise<void>((resolve) => {
    if (m.rec.state === 'inactive') return resolve()
    m.rec.onstop = () => resolve()
    m.rec.stop()
  })
  for (const t of m.stream.getTracks()) t.stop()
  const blob = new Blob(m.chunks, { type: m.rec.mimeType || 'audio/webm' })
  if (!blob.size) return
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await recorderApi
    .saveAudio(m.id, bytes, blob.type)
    .catch((e) => useRecorderStore.setState({ micError: `A narração não foi guardada: ${(e as Error).message}` }))
}

/** The microphone follows the recording's state (paused, stopped from the indicator). */
function follow(state: RecorderState): void {
  const a = state.active
  if (!mic) return
  if (!a || a.id !== mic.id) {
    void finishMicrophone()
    return
  }
  if (a.paused && mic.rec.state === 'recording') mic.rec.pause()
  else if (!a.paused && mic.rec.state === 'paused') mic.rec.resume()
}

let subscribed = false
function subscribe(): void {
  if (subscribed) return
  subscribed = true
  bridge.on(RECORDER.evState, (state) => {
    useRecorderStore.setState({ state })
    follow(state)
  })
  void recorderApi
    .state()
    .then((state) => useRecorderStore.setState((s) => (s.state ? s : { state })))
    .catch((err) => console.warn('[recorder] state failed', err))
}

export function useRecorder(): RecorderState | undefined {
  subscribe()
  return useRecorderStore((s) => s.state)
}

export const clock = (ms: number): string => {
  const t = Math.floor(ms / 1000)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export const RECORDING_STATUS: Record<RecorderState['recordings'][number]['status'], string> = {
  recording: 'Gravando',
  paused: 'Pausada',
  review: 'Para revisar',
  sending: 'Montando o rascunho…',
  drafted: 'Rascunho pronto',
  hired: 'Funcionário contratado',
  failed: 'Não deu certo'
}
