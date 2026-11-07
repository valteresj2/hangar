// The workstation's tools: the same names and arguments as the platform's governed desktop
// (central_agents central/app/services/desktop.py), so an employee's instructions and skills work on both. Here they
// run on this computer, only inside the apps the person allowed, and every action except looking and scrolling asks
// the platform first (POST /gate with tool "desktop:<action>").
import { str, type ToolSpec } from './agui'

export const COMPUTER_TOOLS: ToolSpec[] = [
  {
    name: 'desktop_open',
    description:
      'Abre (ou traz para a frente) um aplicativo liberado para você neste computador e devolve a tela: a captura da ' +
      'janela e os elementos clicáveis com número. Só os apps liberados pela pessoa funcionam.',
    parameters: {
      type: 'object',
      required: ['app'],
      properties: { app: { type: 'string', description: 'nome do app liberado, ex.: Bloco de Notas' } }
    }
  },
  {
    name: 'desktop_look',
    description: 'Olha de novo a janela do app: captura e elementos (com número para clicar).',
    parameters: {
      type: 'object',
      properties: { window: { type: 'string', description: 'parte do título, se houver mais de uma janela' } }
    }
  },
  {
    name: 'desktop_click',
    description:
      'Clica na janela do app: pelo número do elemento (element) ou por x,y em pixels da última captura. Diga em label ' +
      'o que está clicando (o texto do botão). Clique que confirma algo — salvar, confirmar, lançar, enviar, pagar — ' +
      'passa pela sua alçada com a captura; marque commit=true quando o botão confirmar algo e o texto não deixar claro.',
    parameters: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string', description: 'o texto do botão/campo clicado' },
        element: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        double: { type: 'boolean' },
        button: { type: 'string', description: 'left (padrão) ou right' },
        commit: { type: 'boolean' },
        repeat: {
          type: 'boolean',
          description:
            'true só para confirmar de novo algo idêntico a uma confirmação já feita nesta tarefa, de propósito'
        }
      }
    }
  },
  {
    name: 'desktop_type',
    description:
      'Digita texto na janela do app — no campo indicado (element ou x,y: clica nele antes) ou onde o cursor está. Use ' +
      '\\t (Tab) e \\n (Enter) para preencher vários campos de uma vez. Um \\n num diálogo de salvar/confirmar confirma e ' +
      'passa pela sua alçada. Para senhas use text="secret://nome" (o cofre digita num campo de senha; você nunca vê o valor).',
    parameters: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        label: { type: 'string', description: 'o campo' },
        element: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' }
      }
    }
  },
  {
    name: 'desktop_key',
    description:
      'Aperta uma tecla (Return, Tab, Escape, F2…) ou um atalho (modifiers: ["ctrl"] + key "s"). Atalho que salva ou ' +
      'confirma (ctrl+s, Return num diálogo de confirmação) passa pela alçada: marque commit=true. Teclas do Windows ' +
      '(Win, Alt+Tab, Ctrl+Alt+Del) não funcionam: troque de app com desktop_open.',
    parameters: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string' } },
        commit: { type: 'boolean' }
      }
    }
  },
  {
    name: 'desktop_scroll',
    description:
      'Rola a janela do app (direction: up, down, left, right), no ponto x,y da última captura ou no centro.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string' },
        amount: { type: 'integer' },
        x: { type: 'number' },
        y: { type: 'number' }
      }
    }
  },
  {
    name: 'desktop_screenshot',
    description: 'Salva a captura da janela atual na tarefa (como evidência).',
    parameters: { type: 'object', properties: {} }
  }
]

export const COMPUTER_TOOL_NAMES: ReadonlySet<string> = new Set(COMPUTER_TOOLS.map((t) => t.name))

/** One line about a call for the timeline and the panel (never the text of a secret). */
export function summarize(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => str(v).replace(/\s+/g, ' ').trim()
  switch (name) {
    case 'desktop_open':
      return s(input.app)
    case 'desktop_click':
      return (
        s(input.label) || (input.element !== undefined ? `elemento ${s(input.element)}` : `${s(input.x)},${s(input.y)}`)
      )
    case 'desktop_type': {
      const t = s(input.text)
      const what = t.startsWith('secret://') ? '[segredo]' : t.length > 60 ? `${t.slice(0, 60)}…` : t
      return input.label ? `${s(input.label)}: ${what}` : what
    }
    case 'desktop_key':
      return [...(Array.isArray(input.modifiers) ? input.modifiers.map(s) : []), s(input.key)].join('+')
    case 'desktop_scroll':
      return s(input.direction) || 'down'
    case 'desktop_look':
      return s(input.window)
    default:
      return ''
  }
}
