import { useEffect, useMemo, useState } from 'react'
import type { PermissionMode } from '@shared/contracts'
import {
  DEFAULT_LAB_VARIANTS,
  isHarnessPath,
  LAB_PARALLEL_MAX,
  LAB_SEQUENTIAL_MAX,
  labRoundPlan,
  MAX_LAB_VARIANTS,
  type HarnessTree,
  type LabMode
} from '@shared/harness'
import type { CreateLabRoundInput, LabPrepareInfo, LabRoundView, VariantExecReview } from '@shared/features/lab'
import { HarnessTreeEditor } from '../harness'
import { ExecWarning } from './ExecWarning'
import { errorMessage, formatCost, labApi } from './labApi'
import { treeChanges } from './treeDiff'
import styles from './lab.module.css'

const MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable']
const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'acceptEdits', label: 'Aceitar edições (padrão)' },
  { value: 'default', label: 'Perguntar sempre' },
  { value: 'auto', label: 'Automático' },
  { value: 'bypassPermissions', label: 'Ignorar permissões' }
]

const ROUND_MODES: { value: LabMode; label: string; hint: string }[] = [
  { value: 'manual', label: 'Manual', hint: 'Você escreve as variantes; cada uma roda uma vez, ao lado da base.' },
  {
    value: 'parallel',
    label: 'Automático · paralelo',
    hint: 'A base roda uma vez; k proponentes INV (como o agente trabalha) e k DOM (o que um especialista sabe) propõem harnesses a partir dessa execução; cada proposta roda; um compositor monta um harness a partir de toda a evidência; ele roda; seleção cega entre base, propostas e composto.'
  },
  {
    value: 'sequential',
    label: 'Automático · sequencial',
    hint: 'A base roda uma vez; em cada passo um INV e um DOM editam o checkpoint atual com todo o histórico, ambos rodam, o compositor produz o próximo checkpoint e ele roda (é a evidência do passo seguinte); seleção cega entre base e checkpoints.'
  }
]

/** Mean of the known costs, or undefined without data. */
function mean(xs: (number | undefined)[]): number | undefined {
  const known = xs.filter((x): x is number => x !== undefined && x > 0)
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : undefined
}

interface Draft {
  key: number
  label: string
  /** 'base' or a snapshot id. */
  origin: string
  tree: HarnessTree
}

let nextKey = 1

function QuickTreeEditor({ tree, onChange }: { tree: HarnessTree; onChange(tree: HarnessTree): void }) {
  const paths = Object.keys(tree).sort()
  const [path, setPath] = useState(paths.includes('CLAUDE.md') ? 'CLAUDE.md' : (paths[0] ?? ''))
  const [newPath, setNewPath] = useState('')
  const newValid = newPath.trim() !== '' && isHarnessPath(newPath.trim())

  return (
    <div className={styles.quickEditor}>
      <div className={styles.row}>
        <select className="input" value={path} onChange={(e) => setPath(e.target.value)}>
          {!paths.length && <option value="">(sem arquivos de harness)</option>}
          {paths.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {path && (
          <button
            className="btn"
            onClick={() => {
              const next = { ...tree }
              delete next[path]
              onChange(next)
              setPath(Object.keys(next).sort()[0] ?? '')
            }}
          >
            Remover arquivo
          </button>
        )}
      </div>
      {path && tree[path] !== undefined && (
        <textarea
          className={`input ${styles.code}`}
          rows={10}
          spellCheck={false}
          value={tree[path]}
          onChange={(e) => onChange({ ...tree, [path]: e.target.value })}
        />
      )}
      <div className={styles.row}>
        <input
          className="input"
          placeholder="Novo arquivo (ex.: .claude/skills/revisao/SKILL.md)"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
        />
        <button
          className="btn"
          disabled={!newValid || tree[newPath.trim()] !== undefined}
          title={newPath && !newValid ? 'Fora da superfície de harness' : undefined}
          onClick={() => {
            const p = newPath.trim().replace(/\\/g, '/')
            onChange({ ...tree, [p]: '' })
            setPath(p)
            setNewPath('')
          }}
        >
          Adicionar
        </button>
      </div>
    </div>
  )
}

export function NewRound({
  cwd,
  history,
  onCreated,
  onCancel
}: {
  cwd: string
  /** Earlier rounds of this project, for the cost estimate. */
  history: LabRoundView[]
  onCreated(roundId: string): void
  onCancel(): void
}) {
  const [info, setInfo] = useState<LabPrepareInfo>()
  const [error, setError] = useState<string>()
  const [task, setTask] = useState('')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<PermissionMode>('acceptEdits')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [editing, setEditing] = useState<number>()
  const [quick, setQuick] = useState(false)
  const [busy, setBusy] = useState(false)
  const [roundMode, setRoundMode] = useState<LabMode>('manual')
  const [execReviews, setExecReviews] = useState<VariantExecReview[]>()
  const [depth, setDepth] = useState(1)
  const [proposerModel, setProposerModel] = useState('')
  const [cap, setCap] = useState('')

  useEffect(() => {
    labApi.prepare(cwd).then(
      (i) => {
        setInfo(i)
        setDrafts(
          Array.from({ length: DEFAULT_LAB_VARIANTS }, (_, n) => ({
            key: nextKey++,
            label: `Variante ${n + 1}`,
            origin: 'base',
            tree: { ...i.baseTree }
          }))
        )
      },
      (e) => setError(errorMessage(e))
    )
  }, [cwd])

  const base = info?.baseTree ?? {}
  const changes = useMemo(() => drafts.map((d) => treeChanges(base, d.tree)), [drafts, base])

  const setCount = (k: number) => {
    setDrafts((prev) => {
      if (k <= prev.length) return prev.slice(0, k)
      const extra = Array.from({ length: k - prev.length }, (_, n) => ({
        key: nextKey++,
        label: `Variante ${prev.length + n + 1}`,
        origin: 'base',
        tree: { ...base }
      }))
      return [...prev, ...extra]
    })
  }

  const patchDraft = (key: number, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))

  const setOrigin = (d: Draft, origin: string) => {
    const snap = info?.snapshots.find((s) => s.id === origin)
    const autoLabel = /^Variante \d+$|^Snapshot: /.test(d.label)
    patchDraft(d.key, {
      origin,
      tree: snap ? { ...snap.tree } : { ...base },
      label: autoLabel ? (snap ? `Snapshot: ${snap.label}` : `Variante ${drafts.indexOf(d) + 1}`) : d.label
    })
  }

  const auto = roundMode !== 'manual'
  const capValue = cap.trim() ? Number(cap.replace(',', '.')) : undefined
  const capInvalid = capValue !== undefined && !(capValue > 0)

  const chooseMode = (m: LabMode) => {
    setRoundMode(m)
    setDepth(m === 'sequential' ? 2 : 1)
  }

  const estimate = useMemo(() => {
    const plan = roundMode === 'manual' ? { executions: 1 + drafts.length, calls: 0 } : labRoundPlan(roundMode, depth)
    const runCost = mean(history.flatMap((r) => r.variants.map((v) => v.costUsd)))
    const callCost = mean(history.flatMap((r) => (r.stages ?? []).map((s) => s.costUsd)))
    const usd =
      runCost !== undefined && (plan.calls === 0 || callCost !== undefined)
        ? plan.executions * runCost + plan.calls * (callCost ?? 0)
        : undefined
    return { ...plan, usd }
  }, [roundMode, depth, drafts.length, history])

  const submit = async (confirmExec?: string) => {
    setBusy(true)
    setError(undefined)
    try {
      const input: CreateLabRoundInput = {
        projectCwd: cwd,
        task,
        model: model || undefined,
        permissionMode: mode,
        mode: roundMode,
        depth: auto ? depth : undefined,
        proposerModel: auto ? proposerModel || undefined : undefined,
        costCapUsd: capValue,
        variants: auto
          ? []
          : drafts.map((d) => ({
              label: d.label,
              tree: d.tree,
              snapshotId: d.origin === 'base' ? undefined : d.origin
            }))
      }
      if (!auto && confirmExec === undefined) {
        // Variants that change hooks/scripts run that code in the round's worktrees: show it first.
        const reviews = await labApi.createReview(input)
        if (reviews.some((r) => r.fingerprint)) {
          setExecReviews(reviews)
          setBusy(false)
          return
        }
      }
      const round = await labApi.create({ ...input, ...(confirmExec ? { confirmExec } : {}) })
      setExecReviews(undefined)
      onCreated(round.id)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  if (!info) {
    return (
      <div className={styles.detail}>
        {error ? <div className={styles.error}>{error}</div> : <div className="muted">Carregando…</div>}
      </div>
    )
  }

  if (!info.isRepo || !info.hasHead) {
    return (
      <div className={styles.detail}>
        <h2 className={styles.h2}>Nova rodada</h2>
        <div className={styles.callout}>
          <strong>
            {info.isRepo ? 'O repositório ainda não tem commits.' : 'Esta pasta não é um repositório git.'}
          </strong>
          <p>
            O Lab roda a mesma tarefa com o harness atual e com cada variante, cada uma num <em>worktree</em> git
            separado criado a partir do último commit.{' '}
            {info.isRepo ? 'Faça o primeiro commit' : 'Inicialize um repositório (git init) e faça um commit'} para usar
            o Lab nesta pasta.
          </p>
        </div>
        <div className={styles.actions}>
          <button className="btn" onClick={onCancel}>
            Voltar
          </button>
        </div>
      </div>
    )
  }

  const baseFiles = Object.keys(base).length
  const canSubmit = !busy && task.trim().length > 0 && (auto || drafts.length > 0) && !capInvalid
  const maxDepth = roundMode === 'parallel' ? LAB_PARALLEL_MAX : LAB_SEQUENTIAL_MAX

  return (
    <div className={styles.detail}>
      <h2 className={styles.h2}>Nova rodada</h2>
      {error && <div className={styles.error}>{error}</div>}

      <label className={styles.field}>
        <span className={styles.label}>Tarefa</span>
        <textarea
          className="input"
          rows={4}
          placeholder="O que cada variante deve fazer (o mesmo prompt vai para todas)"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.label}>Modo</span>
        <div className={styles.segmented}>
          {ROUND_MODES.map((m) => (
            <button
              key={m.value}
              className={roundMode === m.value ? styles.segActive : ''}
              onClick={() => chooseMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className={styles.hint}>{ROUND_MODES.find((m) => m.value === roundMode)?.hint}</p>
      </div>

      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span className={styles.label}>{auto ? 'Modelo das execuções' : 'Modelo'}</span>
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m || 'Padrão das configurações'}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Permissões</span>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {auto ? (
          <label className={styles.field}>
            <span className={styles.label}>{roundMode === 'parallel' ? 'Largura (k)' : 'Passos (K)'}</span>
            <select className="input" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {Array.from({ length: maxDepth }, (_, i) => i + 1).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className={styles.field}>
            <span className={styles.label}>Variantes (K)</span>
            <select className="input" value={drafts.length} onChange={(e) => setCount(Number(e.target.value))}>
              {Array.from({ length: MAX_LAB_VARIANTS }, (_, i) => i + 1).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className={styles.fieldRow}>
        {auto && (
          <label className={styles.field}>
            <span className={styles.label}>Modelo dos proponentes</span>
            <select className="input" value={proposerModel} onChange={(e) => setProposerModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m || 'Padrão das configurações'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.label}>Teto de custo (US$, opcional)</span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="sem teto"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
      </div>
      <div className={styles.estimate}>
        <strong>Estimativa:</strong> {estimate.executions} {estimate.executions === 1 ? 'execução' : 'execuções'} da
        tarefa
        {estimate.calls > 0 && (
          <>
            {' '}
            + {estimate.calls} chamadas de proponente/compositor (até {estimate.calls * 2} se propostas inválidas
            pedirem nova tentativa)
          </>
        )}
        .
        {estimate.usd !== undefined && (
          <> Pelo custo médio das rodadas anteriores deste projeto: ≈ {formatCost(estimate.usd)}.</>
        )}
        {capInvalid ? (
          <span className={styles.warnText}> O teto precisa ser um valor maior que zero.</span>
        ) : capValue !== undefined ? (
          <> A rodada é interrompida se o gasto (execuções + chamadas) passar de {formatCost(capValue)}.</>
        ) : null}
      </div>
      <p className={styles.hint}>
        Pedidos de permissão param a variante até você responder na sessão dela.
        {mode === 'bypassPermissions' &&
          ' Com "Ignorar permissões" as variantes executam qualquer comando sem perguntar.'}
      </p>
      {info.dirty && (
        <p className={styles.warn}>
          Há alterações não commitadas fora do harness: os worktrees partem do último commit e não vão vê-las.
        </p>
      )}

      <div className={styles.variantCard}>
        <div className={styles.variantHead}>
          <strong>Base</strong>
          <span className="muted">
            harness atual do projeto · {baseFiles} arquivo{baseFiles === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {!auto &&
        drafts.map((d, i) => {
          const diff = changes[i]
          const open = editing === d.key
          return (
            <div key={d.key} className={styles.variantCard}>
              <div className={styles.variantHead}>
                <input
                  className={`input ${styles.labelInput}`}
                  value={d.label}
                  onChange={(e) => patchDraft(d.key, { label: e.target.value })}
                />
                <select className="input" value={d.origin} onChange={(e) => setOrigin(d, e.target.value)}>
                  <option value="base">Cópia editada da base</option>
                  {info.snapshots.map((s) => (
                    <option key={s.id} value={s.id}>
                      Snapshot: {s.label}
                    </option>
                  ))}
                </select>
                <button className="btn" onClick={() => setEditing(open ? undefined : d.key)}>
                  {open ? 'Fechar editor' : 'Editar'}
                </button>
              </div>
              <div className={styles.diffSummary}>
                {diff.length === 0 ? (
                  <span className={styles.warnText}>Igual à base — edite para que a comparação diga algo.</span>
                ) : (
                  diff.map((c) => (
                    <span key={c.path} className={styles.diffChip}>
                      <span className={styles[c.kind]}>
                        {c.kind === 'added' ? 'novo' : c.kind === 'removed' ? 'removido' : 'alterado'}
                      </span>{' '}
                      {c.path} <span className={styles.plus}>+{c.added}</span>{' '}
                      <span className={styles.minus}>−{c.removed}</span>
                    </span>
                  ))
                )}
              </div>
              {open && (
                <div className={styles.editor}>
                  <div className={styles.editorTabs}>
                    <button className={!quick ? styles.tabActive : ''} onClick={() => setQuick(false)}>
                      Editor de harness
                    </button>
                    <button className={quick ? styles.tabActive : ''} onClick={() => setQuick(true)}>
                      Edição rápida
                    </button>
                  </div>
                  {quick ? (
                    <QuickTreeEditor tree={d.tree} onChange={(tree) => patchDraft(d.key, { tree })} />
                  ) : (
                    <HarnessTreeEditor tree={d.tree} onChange={(tree) => patchDraft(d.key, { tree })} />
                  )}
                </div>
              )}
            </div>
          )
        })}

      {execReviews && (
        <ExecWarning
          title="Variantes alteram hooks ou scripts"
          sections={execReviews.filter((r) => r.changes.length).map((r) => ({ label: r.label, changes: r.changes }))}
          confirmLabel="Rodar com estas mudanças"
          busy={busy}
          onConfirm={() =>
            void submit(
              execReviews
                .map((r) => r.fingerprint)
                .filter(Boolean)
                .join(',')
            )
          }
          onCancel={() => setExecReviews(undefined)}
        />
      )}

      <div className={styles.actions}>
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={!canSubmit || !!execReviews} onClick={() => void submit()}>
          {busy
            ? 'Preparando…'
            : auto
              ? 'Iniciar rodada automática'
              : `Rodar base + ${drafts.length} variante${drafts.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  )
}
