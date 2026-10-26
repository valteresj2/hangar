// Product identity, shared by main and renderer. Packaging names live in electron-builder.yml (productName,
// copyright) and must match these.
export const BRAND = {
  /** Window title, installer, Start menu, About. */
  productName: 'Agent Hangar Desktop',
  /** Title bar wordmark: "Agent Hangar" + the "Desktop" tag. */
  wordmark: 'Agent Hangar',
  tag: 'Desktop',
  company: 'Agent Hangar',
  copyright: '© 2026 Agent Hangar',
  /** What the app is, in one line (pt-BR). */
  tagline: 'App de desktop para rodar e conduzir sessões do Claude Code, conectado à plataforma Agent Hangar.',
  license: 'Software proprietário. Todos os direitos reservados.',
  /** Title bar height (px); the window controls overlay uses the same. */
  titleBarHeight: 36
} as const
