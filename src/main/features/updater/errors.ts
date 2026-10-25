// Turns electron-updater / network errors into short pt-BR messages for the UI.

const RULES: [RegExp, string][] = [
  [/app-update\.yml/i, 'Este build não tem configuração de atualização.'],
  [
    /not signed by the application owner|publisherNames?|signature verification|code ?sign/i,
    'O instalador baixado não tem a assinatura esperada e foi descartado por segurança.'
  ],
  [/sha512 checksum mismatch|checksum/i, 'O download chegou corrompido (checksum diferente). Tente novamente.'],
  [/ENOSPC/i, 'Sem espaço em disco para baixar a atualização.'],
  [
    /\b(401|403)\b|Bad credentials|authentication/i,
    'O servidor de atualizações recusou o acesso (repositório privado?).'
  ],
  [
    /\b404\b|Cannot find .*\.yml|No published versions|Unable to find latest version/i,
    'Nenhuma versão publicada foi encontrada no canal de atualizações.'
  ],
  [
    /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo/i,
    'Sem conexão com o servidor de atualizações. Verifique a internet e tente de novo.'
  ]
]

export function readableUpdateError(err: unknown): string {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  for (const [pattern, message] of RULES) if (pattern.test(text)) return message
  const first = (err instanceof Error ? err.message : String(err)).split('\n')[0].trim()
  return `Falha ao atualizar: ${first.slice(0, 200) || 'erro desconhecido'}.`
}
