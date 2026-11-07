// What the employee may touch on this computer, checked in the main process before every action (pure, unit-tested):
// only windows of the apps the person allowed, never the ones that can never be allowed, a point must fall inside the
// target window and on a window of an allowed app, and system-level shortcuts are refused. The lists cover Windows,
// macOS and Linux (process names rarely collide; where they do, both are blocked).
import type { AllowedApp } from '../../../shared/features/computer'
import type { Rect, WindowInfo } from './driver/types'

const lower = (s: string): string => s.toLowerCase().replace(/\.exe$/, '')

/** Processes that can never be allowed (the app that holds the approvals, system and security tools, credentials). */
export const BLOCKED_PROCESSES: Record<string, string> = {
  hangar: 'o próprio Agent Hangar Desktop (é onde as decisões são aprovadas)',
  'agent hangar desktop': 'o próprio Agent Hangar Desktop (é onde as decisões são aprovadas)',
  electron: 'o próprio Agent Hangar Desktop (é onde as decisões são aprovadas)',
  taskmgr: 'Gerenciador de Tarefas',
  systemsettings: 'Configurações do Windows',
  regedit: 'Editor do Registro',
  control: 'Painel de Controle (muda configurações do Windows)',
  msconfig: 'Configuração do Sistema',
  gpedit: 'Editor de Política de Grupo',
  mmc: 'console de administração do Windows',
  consent: 'pedido de elevação (UAC)',
  credentialuibroker: 'pedido de credenciais do Windows',
  logonui: 'tela de entrada do Windows',
  sechealthui: 'Segurança do Windows',
  securityhealthsystray: 'Segurança do Windows',
  applicationframehost: 'apps UWP (Configurações, Calculadora antiga): não suportados',
  lockapp: 'tela de bloqueio',
  '1password': 'gerenciador de senhas',
  keepass: 'gerenciador de senhas',
  keepassxc: 'gerenciador de senhas',
  bitwarden: 'gerenciador de senhas',
  lastpass: 'gerenciador de senhas',
  dashlane: 'gerenciador de senhas',
  powershell_ise: 'terminal de administração',
  // macOS
  'system settings': 'Ajustes do Sistema',
  'system preferences': 'Preferências do Sistema',
  'keychain access': 'Acesso às Chaves (senhas)',
  'activity monitor': 'Monitor de Atividade',
  securityagent: 'pedido de senha do macOS',
  loginwindow: 'tela de entrada do macOS',
  dock: 'Dock do macOS',
  systemuiserver: 'barra de menus do macOS',
  'control center': 'Central de Controle do macOS',
  controlcenter: 'Central de Controle do macOS',
  notificationcenter: 'Central de Notificações do macOS',
  coreservicesuiagent: 'avisos de segurança do macOS',
  'screen sharing': 'Compartilhamento de Tela',
  passwords: 'gerenciador de senhas',
  // Linux
  'gnome-control-center': 'configurações do sistema',
  'gnome-system-monitor': 'monitor do sistema',
  'plasma-systemmonitor': 'monitor do sistema',
  ksysguard: 'monitor do sistema',
  seahorse: 'chaves e senhas',
  kwalletmanager5: 'carteira de senhas',
  'polkit-gnome-authentication-agent-1': 'pedido de senha de administrador',
  'polkit-kde-authentication-agent-1': 'pedido de senha de administrador',
  'gnome-shell': 'interface do sistema',
  plasmashell: 'interface do sistema',
  'xfce4-panel': 'painel do sistema',
  xfdesktop: 'área de trabalho',
  lxpanel: 'painel do sistema',
  'xfce4-settings-manager': 'configurações do sistema',
  'gnome-tweaks': 'configurações do sistema'
}

/** Allowed only with a warning. */
export const WARN_PROCESSES: Record<string, string> = {
  chrome: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  msedge: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  firefox: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  brave: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  opera: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  vivaldi: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  iexplore: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  cmd: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  powershell: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  pwsh: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  windowsterminal: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  wt: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  explorer: 'Explorador de Arquivos: dá acesso a todas as suas pastas',
  code: 'editor de código: para código, prefira o posto do VS Code (arquivos e terminal com alçada própria)',
  // macOS
  safari: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  'google chrome': 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  'microsoft edge':
    'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  arc: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  terminal: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  iterm2: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  finder: 'Finder: dá acesso a todas as suas pastas',
  // Linux
  chromium: 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  'google-chrome': 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  'brave-browser': 'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  'microsoft-edge':
    'navegador: o portal da plataforma abre nele com o seu login — o funcionário poderia agir como você',
  'gnome-terminal-server': 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  konsole: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  xterm: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  alacritty: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  kitty: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  tilix: 'terminal: comandos rodam com o seu usuário (para código, use o posto do VS Code)',
  nautilus: 'gerenciador de arquivos: dá acesso a todas as suas pastas',
  dolphin: 'gerenciador de arquivos: dá acesso a todas as suas pastas',
  thunar: 'gerenciador de arquivos: dá acesso a todas as suas pastas'
}

/** Window classes of the shell (Windows taskbar/Start/desktop; on Linux the driver reports the EWMH window type as the
 *  class: dock, desktop): never clickable, whatever app is allowed. */
const SHELL_CLASSES = new Set([
  'shell_traywnd',
  'shell_secondarytraywnd',
  'progman',
  'workerw',
  'windows.ui.core.corewindow',
  'notifyiconoverflowwindow',
  'tasklistthumbnailwnd',
  'multitaskingviewframe',
  'xamlexplorerhostislandwindow',
  'dock',
  'desktop',
  'panel'
])

export type OsKind = 'win32' | 'darwin' | 'linux'
const currentOs = (): OsKind =>
  process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32'

export function blockedReason(process: string): string | undefined {
  return BLOCKED_PROCESSES[lower(process)]
}

export function warningFor(process: string): string | undefined {
  return WARN_PROCESSES[lower(process)]
}

/** The allowed app a window belongs to (by its process, or its owner's for a dialog); undefined = not allowed. */
export function allowedAppOf(
  w: WindowInfo | undefined,
  apps: AllowedApp[],
  opts: { selfPid?: number } = {}
): AllowedApp | undefined {
  if (!w || !w.process || w.elevated) return undefined
  if (opts.selfPid && (w.pid === opts.selfPid || w.ownerPid === opts.selfPid)) return undefined
  if (blockedReason(w.process) || SHELL_CLASSES.has(w.className.toLowerCase())) return undefined
  const p = lower(w.process)
  return apps.find((a) => lower(a.process) === p && !blockedReason(a.process))
}

/** Why the employee cannot act on this window (pt-BR, for the model), or undefined. */
export function windowRefusal(w: WindowInfo | undefined, apps: AllowedApp[], selfPid?: number): string | undefined {
  if (!w) return 'nenhuma janela em primeiro plano'
  if (w.elevated)
    return `a janela "${w.title}" é de um programa de administrador: o sistema não deixa outro programa operá-la`
  if (allowedAppOf(w, apps, { selfPid })) return undefined
  const b = w.process ? blockedReason(w.process) : undefined
  if (b) return `"${w.title}" é ${b}: nunca liberado`
  const names = apps.map((a) => a.name).join(', ') || 'nenhum'
  return `"${w.title}" (${w.process || 'app desconhecido'}) não está entre os apps liberados neste computador (${names})`
}

export function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/** Image coordinates of the last capture → screen pixels. */
export function toScreen(cap: { rect: Rect; scale: number }, x: number, y: number): { x: number; y: number } {
  const s = cap.scale > 0 ? cap.scale : 1
  return { x: Math.round(cap.rect.x + x / s), y: Math.round(cap.rect.y + y / s) }
}

/** Screen pixels → image coordinates of a capture. */
export function toImage(cap: { rect: Rect; scale: number }, x: number, y: number): { x: number; y: number } {
  const s = cap.scale > 0 ? cap.scale : 1
  return { x: Math.round((x - cap.rect.x) * s), y: Math.round((y - cap.rect.y) * s) }
}

/** The "logo" key: Win on Windows, Cmd on macOS (a normal modifier there: Cmd+S saves), Super on Linux. */
const LOGO: Record<OsKind, string> = { win32: 'win', darwin: 'cmd', linux: 'super' }
const LOGO_NAMES = new Set(['win', 'windows', 'super', 'meta', 'cmd', 'command', 'lwin', 'rwin'])

export function normalizeCombo(
  key: string,
  modifiers: string[],
  os: OsKind = currentOs()
): { key: string; modifiers: string[]; combo: string } {
  const norm = (m: string): string => {
    const l = m.toLowerCase()
    if (l === 'control' || l === 'ctl') return 'ctrl'
    if (l === 'option' || l === 'opt') return 'alt'
    return LOGO_NAMES.has(l) ? LOGO[os] : l
  }
  const mods = [...new Set(modifiers.map(norm))]
  const k = key.trim()
  return { key: k, modifiers: mods, combo: [...mods, k.toLowerCase()].join('+') }
}

/** Shortcuts that leave the allowed app or reach the system itself; undefined = fine. */
export function comboRefusal(key: string, modifiers: string[], os: OsKind = currentOs()): string | undefined {
  const { modifiers: mods, combo } = normalizeCombo(key, modifiers, os)
  const k = key.toLowerCase()
  const has = (m: string): boolean => mods.includes(m)
  if (k === 'end' && has('ctrl') && has('alt')) return 'Ctrl+Alt+End é o botão de parar da pessoa: bloqueado'
  if (os === 'darwin') {
    if (LOGO_NAMES.has(k)) return 'a tecla Cmd sozinha não faz nada no posto'
    if (has('cmd') && (k === 'tab' || k === 'space' || k === '`'))
      return `${combo} troca de app ou abre a busca: use desktop_open`
    if (has('cmd') && has('alt') && (k === 'escape' || k === 'esc'))
      return 'Cmd+Option+Esc (Forçar Encerrar): bloqueado'
    if (has('ctrl') && has('alt') && (k === 'escape' || k === 'esc'))
      return 'Ctrl+Option+Esc é o botão de parar da pessoa: bloqueado'
    if (has('cmd') && has('ctrl') && k === 'q') return 'Ctrl+Cmd+Q bloqueia a tela: bloqueado'
    if (has('cmd') && has('shift') && k === 'q') return 'Cmd+Shift+Q encerra a sessão: bloqueado'
    if (has('ctrl') && ['up', 'down', 'left', 'right'].includes(k))
      return `${combo} troca de mesa (Mission Control): bloqueado`
    return undefined
  }
  if (has(LOGO[os]) || LOGO_NAMES.has(k))
    return os === 'linux'
      ? 'teclas com Super não funcionam no posto'
      : 'teclas com Windows (Win) não funcionam no posto'
  if (k === 'tab' && has('alt')) return 'Alt+Tab troca de app: use desktop_open para ir a um app liberado'
  if (k === 'escape' || k === 'esc') {
    if (has('ctrl') && has('shift')) return 'Ctrl+Shift+Esc abre o Gerenciador de Tarefas: bloqueado'
    if (has('ctrl') || has('alt')) return `${combo} abre o menu Iniciar ou troca de app: bloqueado`
  }
  if ((k === 'delete' || k === 'del') && has('ctrl') && has('alt')) return 'Ctrl+Alt+Del: bloqueado'
  if (os === 'linux') {
    if (has('ctrl') && has('alt') && (/^f\d+$/.test(k) || k === 'backspace' || k === 'l' || k === 't'))
      return `${combo} troca de console, encerra a sessão, bloqueia a tela ou abre um terminal: bloqueado`
    if (has('alt') && (k === 'f1' || k === 'f2')) return `${combo} abre o menu ou a execução de comandos: bloqueado`
  }
  return undefined
}
