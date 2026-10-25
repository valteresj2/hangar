// Decides whether this installation can update itself ('auto') or only tell the user to download the new version
// ('manual'), and where that download lives. Kept free of `electron` imports so it can be unit tested.
//
// Manual installs:
//  - macOS without an Apple Developer ID (ad hoc or no signature): Squirrel.Mac refuses to install such updates;
//  - the Windows portable .exe (electron-builder sets PORTABLE_EXECUTABLE_FILE): nothing to update in place;
//  - the Linux .deb (resources/package-type is "deb"): updated by installing the new package with apt.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InstallMode } from '../../../shared/features/updater'

export type MacSignature = 'developer-id' | 'adhoc' | 'unsigned' | 'unknown'

/** Classifies the stderr of `codesign -dv --verbose=2 <app>`. */
export function parseCodesignOutput(output: string): MacSignature {
  if (/not signed at all/i.test(output)) return 'unsigned'
  if (/^Signature=adhoc$/im.test(output) || /^TeamIdentifier=not set$/im.test(output)) return 'adhoc'
  if (/^TeamIdentifier=[A-Z0-9]{10}$/im.test(output) && /^Authority=Developer ID Application:/im.test(output)) {
    return 'developer-id'
  }
  return 'unknown'
}

export interface InstallFacts {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** Contents of resources/package-type (electron-builder writes it for deb/rpm/pacman), if any. */
  packageType?: string
  /** macOS only: the bundle's signature. */
  macSignature?: MacSignature
}

export interface InstallModeResult {
  mode: InstallMode
  /** Why the update must be downloaded by hand (pt-BR, for the panel). */
  reason?: string
}

export function detectInstallMode(facts: InstallFacts): InstallModeResult {
  if (facts.platform === 'darwin' && facts.macSignature !== 'developer-id') {
    return {
      mode: 'manual',
      reason:
        'Este build do macOS não tem assinatura de desenvolvedor da Apple, então não pode se instalar sozinho. ' +
        'Baixe a versão nova e substitua o app em Aplicativos.'
    }
  }
  if (facts.platform === 'win32' && facts.env.PORTABLE_EXECUTABLE_FILE) {
    return {
      mode: 'manual',
      reason: 'A versão portátil não se atualiza sozinha. Baixe o executável novo e use-o no lugar deste.'
    }
  }
  if (facts.platform === 'linux' && facts.packageType?.trim() === 'deb') {
    return {
      mode: 'manual',
      reason: 'Instalado pelo pacote .deb: baixe o .deb da versão nova e instale com "sudo apt install ./arquivo.deb".'
    }
  }
  return { mode: 'auto' }
}

/** Top-level `key: value` pairs of app-update.yml (flat YAML written by electron-builder). */
export function parseUpdateConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/

/**
 * The page where the user downloads `version`: the GitHub release (provider github) or the generic feed URL.
 * Only https URLs are returned; `allowLoopback` (dev builds against a local test feed) also accepts
 * http://127.0.0.1 / http://localhost.
 */
export function downloadUrlFor(
  config: Record<string, string>,
  version: string,
  opts: { allowLoopback?: boolean } = {}
): string | undefined {
  let candidate: string | undefined
  if (config.provider === 'github') {
    const { owner, repo } = config
    if (!owner || !repo || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) return undefined
    const tag = /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? `v${version}` : undefined
    candidate = `https://github.com/${owner}/${repo}/releases${tag ? `/tag/${tag}` : ''}`
  } else if (config.provider === 'generic') {
    candidate = config.url
  }
  if (!candidate) return undefined
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  if (url.protocol === 'https:') return url.href
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  return opts.allowLoopback && url.protocol === 'http:' && loopback ? url.href : undefined
}

/** Runs `codesign -dv` on the running .app bundle (process.execPath is <app>/Contents/MacOS/<name>). */
export function probeMacSignature(execPath: string = process.execPath): Promise<MacSignature> {
  const bundle = dirname(dirname(dirname(execPath)))
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 10_000 }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}\n${stderr ?? ''}`
      const parsed = parseCodesignOutput(output)
      resolve(parsed === 'unknown' && err ? 'unknown' : parsed)
    })
  })
}

/** Gathers the facts about the running installation (codesign on macOS, package-type on Linux). */
export async function probeInstallFacts(resourcesPath: string): Promise<InstallFacts> {
  const facts: InstallFacts = { platform: process.platform, env: process.env }
  if (process.platform === 'darwin') facts.macSignature = await probeMacSignature()
  if (process.platform === 'linux') {
    try {
      facts.packageType = readFileSync(join(resourcesPath, 'package-type'), 'utf8').trim()
    } catch {
      // AppImage / unpacked: no package-type file.
    }
  }
  return facts
}
