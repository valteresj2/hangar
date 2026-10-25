import { isValidElement, memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlight } from './highlight'
import styles from './engine.module.css'

export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={styles.copyBtn}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? 'Copiado' : label}
    </button>
  )
}

export function CodeBlock({ code, lang, maxHeight }: { code: string; lang?: string; maxHeight?: number }) {
  const [html, setHtml] = useState<string>()
  useEffect(() => {
    let alive = true
    // Debounced so a block that is still streaming is not re-highlighted on every token.
    const timer = setTimeout(() => {
      highlight(code, lang).then(
        (h) => alive && setHtml(h),
        () => undefined
      )
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [code, lang])

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span>{lang || 'texto'}</span>
        <CopyButton text={code} />
      </div>
      <div className={styles.codeBody} style={maxHeight ? { maxHeight } : undefined}>
        {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <pre>{code}</pre>}
      </div>
    </div>
  )
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

const components: Components = {
  pre({ children }) {
    const child: ReactNode = Array.isArray(children) ? (children as ReactNode[])[0] : children
    const className = isValidElement<{ className?: string }>(child) ? (child.props.className ?? '') : ''
    const lang = /language-([\w+#.-]+)/.exec(className)?.[1]
    return <CodeBlock code={textOf(children).replace(/\n$/, '')} lang={lang} />
  },
  // Links open in the system browser (main's window-open handler); never navigate the app window.
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className={styles.tableWrap}>
        <table>{children}</table>
      </div>
    )
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
