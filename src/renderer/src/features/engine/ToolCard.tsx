import { memo, useState } from 'react'
import type { TranscriptEntry } from '@shared/features/engine'
import { DiffView } from './DiffView'
import { CodeBlock } from './Markdown'
import { langForPath } from './highlight'
import { EDIT_TOOLS, SHELL_TOOLS, toolLabel, toolSummary } from './tools'
import styles from './engine.module.css'

type ToolUse = Extract<TranscriptEntry, { kind: 'tool_use' }>
type ToolResult = Extract<TranscriptEntry, { kind: 'tool_result' }>

function s(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Read results come as `cat -n` output; drop the line-number gutter when every line has one. */
function stripLineNumbers(text: string): string {
  const lines = text.split('\n')
  const numbered = /^\s*\d+\t/
  return lines.every((l) => numbered.test(l) || !l) ? lines.map((l) => l.replace(numbered, '')).join('\n') : text
}

function EditBody({ use }: { use: ToolUse }) {
  const input = use.input
  if (use.name === 'Edit') return <DiffView before={s(input.old_string)} after={s(input.new_string)} />
  if (use.name === 'MultiEdit' && Array.isArray(input.edits)) {
    return (
      <>
        {(input.edits as Record<string, unknown>[]).map((e, i) => (
          <DiffView key={i} before={s(e.old_string)} after={s(e.new_string)} />
        ))}
      </>
    )
  }
  if (use.name === 'Write') return <DiffView before="" after={s(input.content)} />
  if (use.name === 'NotebookEdit') return <CodeBlock code={s(input.new_source)} lang={s(input.cell_type) === 'markdown' ? 'markdown' : 'python'} />
  return null
}

function ResultBlock({ result }: { result: ToolResult }) {
  if (!result.content.trim()) return <div className={styles.toolEmpty}>(sem saída)</div>
  return <pre className={`${styles.toolOutput} ${result.isError ? styles.toolOutputError : ''}`}>{result.content}</pre>
}

export const ToolCard = memo(function ToolCard({ use, result, running }: { use: ToolUse; result?: ToolResult; running: boolean }) {
  const isEdit = EDIT_TOOLS.has(use.name)
  const [open, setOpen] = useState(isEdit)
  const failed = result?.isError
  const state = result ? (failed ? 'error' : 'done') : running ? 'running' : 'stopped'
  const summary = toolSummary(use.name, use.input)
  const path = s(use.input.file_path)

  return (
    <div className={`${styles.tool} ${failed ? styles.toolFailed : ''}`}>
      <button className={styles.toolHeader} onClick={() => setOpen((o) => !o)}>
        <span className={`${styles.toolDot} ${styles[`dot_${state}`]}`} />
        <span className={styles.toolName}>{toolLabel(use.name)}</span>
        <span className={styles.toolSummary} title={summary}>
          {summary}
        </span>
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {(open || (failed && !isEdit)) && (
        <div className={styles.toolBody}>
          {SHELL_TOOLS.has(use.name) ? (
            <>
              <pre className={styles.toolCommand}>
                <span className="muted">{use.name === 'PowerShell' ? 'PS> ' : '$ '}</span>
                {s(use.input.command)}
              </pre>
              {result && <ResultBlock result={result} />}
            </>
          ) : isEdit ? (
            <>
              <EditBody use={use} />
              {failed && result && <ResultBlock result={result} />}
            </>
          ) : use.name === 'Read' && result && !failed ? (
            <CodeBlock code={stripLineNumbers(result.content)} lang={langForPath(path)} maxHeight={360} />
          ) : (
            <>
              <pre className={styles.toolInput}>{JSON.stringify(use.input, null, 2)}</pre>
              {result && <ResultBlock result={result} />}
            </>
          )}
        </div>
      )}
    </div>
  )
})
