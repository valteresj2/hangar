// MP4 export: every frame is drawn with the shared runtime on an OffscreenCanvas (time = i / fps),
// encoded as H.264 with WebCodecs and muxed by mediabunny. The muxer's positioned writes stream to the
// main process, which writes `<file>.part` and renames it when the export completes.
import {
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk
} from 'mediabunny'
import { totalDuration, type MotionSpec } from '@shared/motion/spec'
import { drawFrame, type MotionAssets } from '@renderer/motion/runtime'
import { PREVIEW } from '@shared/features/preview'
import { bridge } from '../../../core/api'

export class ExportCancelled extends Error {
  constructor() {
    super('Exportação cancelada.')
  }
}

// H.264 levels: [level_idc, max macroblocks per frame, max macroblocks per second].
const AVC_LEVELS: [number, number, number][] = [
  [0x1f, 3600, 108000], // 3.1
  [0x20, 5120, 216000], // 3.2
  [0x28, 8192, 245760], // 4.0
  [0x2a, 8704, 522240], // 4.2
  [0x32, 22080, 589824], // 5.0
  [0x33, 36864, 983040], // 5.1
  [0x34, 36864, 2073600] // 5.2
]
// High, Main, Constrained Baseline.
const AVC_PROFILES = ['6400', '4d40', '42e0']

function hex(n: number): string {
  return n.toString(16).padStart(2, '0')
}

/** Picks a supported H.264 encoder configuration, or explains why there is none. */
export async function pickAvcConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
  if (typeof VideoEncoder === 'undefined')
    throw new Error('Este ambiente não tem WebCodecs (VideoEncoder); não é possível gerar MP4.')
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16)
  const levels = AVC_LEVELS.filter(([, maxFrame, maxRate]) => mbs <= maxFrame && mbs * fps <= maxRate).map(([l]) => l)
  if (!levels.length) throw new Error(`Resolução ${width}×${height} @ ${fps} fps acima do que o H.264 suporta.`)
  // ~0.1 bit per pixel per frame: 1080p30 ≈ 6 Mbps.
  const bitrate = Math.round(Math.min(Math.max(width * height * fps * 0.1, 1_000_000), 40_000_000))
  for (const profile of AVC_PROFILES) {
    for (const level of levels.slice(0, 2)) {
      const config: VideoEncoderConfig = {
        codec: `avc1.${profile}${hex(level)}`,
        width,
        height,
        bitrate,
        framerate: fps,
        avc: { format: 'avc' }
      }
      try {
        const res = await VideoEncoder.isConfigSupported(config)
        if (res.supported) return res.config ?? config
      } catch {
        // malformed for this platform; try the next one
      }
    }
  }
  throw new Error(
    'O codificador H.264 (AVC) não está disponível neste computador, então não é possível gerar MP4. Nenhum arquivo foi gravado.'
  )
}

export interface ExportOptions {
  spec: MotionSpec
  assets: MotionAssets
  path: string
  signal: AbortSignal
  onProgress(frame: number, total: number): void
}

export async function exportMp4({ spec, assets, path, signal, onProgress }: ExportOptions): Promise<void> {
  // H.264 needs even dimensions.
  const width = Math.max(2, Math.floor(spec.width / 2) * 2)
  const height = Math.max(2, Math.floor(spec.height / 2) * 2)
  const fps = spec.fps
  const frames = Math.max(1, Math.round(totalDuration(spec) * fps))
  const config = await pickAvcConfig(width, height, fps)

  const exportId = await bridge.invoke(PREVIEW.exportOpen, path)
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(
      new WritableStream<StreamTargetChunk>({
        // slice(): send only this view, not the whole backing buffer.
        write: (chunk) => bridge.invoke(PREVIEW.exportWrite, exportId, chunk.position, chunk.data.slice())
      }),
      { chunked: true }
    )
  })
  const source = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(source, { frameRate: fps })

  let encoder: VideoEncoder | undefined
  let encoderError: Error | undefined
  // Packets must reach the muxer in order; chain them.
  let muxing: Promise<void> = Promise.resolve()

  try {
    await output.start()
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        muxing = muxing.then(() => source.add(EncodedPacket.fromEncodedChunk(chunk), meta))
      },
      error: (err) => {
        encoderError = err instanceof Error ? err : new Error(String(err))
      }
    })
    encoder.configure(config)

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Não foi possível criar o canvas de exportação.')
    const frameUs = 1_000_000 / fps
    const keyEvery = Math.max(1, Math.round(fps * 2))

    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new ExportCancelled()
      if (encoderError) throw encoderError
      // The runtime only uses the 2D API shared by both canvas kinds.
      drawFrame(ctx, spec, i / fps, assets)
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) })
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
      frame.close()
      // Backpressure: keep the encoder queue short and let the muxer catch up now and then.
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2))
      if (i % 15 === 0) {
        await muxing
        onProgress(i + 1, frames)
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    await encoder.flush()
    await muxing
    if (encoderError) throw encoderError
    if (signal.aborted) throw new ExportCancelled()
    encoder.close()
    await output.finalize()
    await bridge.invoke(PREVIEW.exportClose, exportId, true)
    onProgress(frames, frames)
  } catch (err) {
    try {
      if (encoder && encoder.state !== 'closed') encoder.close()
    } catch {
      // already closed
    }
    await output.cancel().catch(() => {})
    await bridge.invoke(PREVIEW.exportClose, exportId, false).catch(() => {})
    throw err
  }
}
