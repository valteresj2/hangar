// macOS driver: a Swift helper (helper/HangarDesktopHelper.swift) over CGEvent (input), ScreenCaptureKit (capture of
// the allowed apps only) and the Accessibility API (elements, password fields), speaking the same JSON-lines protocol as
// the Windows helper. A prebuilt binary shipped with the app (resources/computer-helper-macos) is used when present;
// otherwise it is compiled on first use with `swiftc` (Xcode Command Line Tools: `xcode-select --install`) into
// <userData>/computer, cached by the source hash. Needs macOS 14+, and the person allows Agent Hangar Desktop in
// System Settings → Privacy & Security → Accessibility and Screen Recording (the helper asks on first start).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import source from './helper/HangarDesktopHelper.swift?raw'
import { HelperDriver } from './helper'

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 10_000_000, timeout: 300_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

export async function prepareMacHelper(dir: string): Promise<{ cmd: string; args: string[] }> {
  const bundled = join(process.resourcesPath ?? '', 'computer-helper-macos')
  if (process.resourcesPath && existsSync(bundled)) return { cmd: bundled, args: [] }
  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
  const bin = join(dir, `hangar-desktop-helper-${hash}`)
  if (existsSync(bin)) return { cmd: bin, args: [] }
  const swift = join(dir, `HangarDesktopHelper-${hash}.swift`)
  writeFileSync(swift, source, 'utf8')
  const r = await run('xcrun', ['swiftc', '-O', '-o', bin, swift])
  if (r.code !== 0 || !existsSync(bin))
    throw new Error(
      r.out.includes('xcrun: error') || r.out.includes('invalid active developer path')
        ? 'Para o posto no computador no macOS, instale as Command Line Tools do Xcode (xcode-select --install) e ligue de novo.'
        : `Não consegui compilar o ajudante do macOS: ${r.out.slice(-600)}`
    )
  return { cmd: bin, args: [] }
}

/** The macOS driver. hello reports the Accessibility and Screen Recording permissions. */
export class MacDriver extends HelperDriver {
  notice?: string

  constructor(dir: string, launcher: (target: string) => Promise<string>) {
    super('macos', dir, prepareMacHelper, launcher)
  }

  override async start(): Promise<void> {
    await super.start()
    const hello = this.permissions()
    const missing = [!hello.accessibility && 'Acessibilidade', !hello.screen && 'Gravação de Tela'].filter(Boolean)
    if (missing.length)
      throw new Error(
        `Permita o Agent Hangar Desktop em Ajustes do Sistema → Privacidade e Segurança → ${missing.join(' e ')}, e ligue o posto de novo.`
      )
  }
}
