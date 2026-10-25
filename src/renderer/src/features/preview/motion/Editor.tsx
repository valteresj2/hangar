// Embedded motion editor: scenes, elements of the selected scene, and the selected element's properties.
import type { MotionElement, MotionScene, MotionSpec, SceneTransition } from '@shared/motion/spec'
import { ElementForm, FONT_LIST_ID, FONTS, type Edit } from './ElementForm'
import { ColorField, NumField, Section, SelectField, TextField } from './fields'
import styles from './motion.module.css'

interface Props {
  doc: MotionSpec
  edit: Edit
  sceneIndex: number
  elementId?: string
  onSelectScene(index: number): void
  onSelectElement(sceneIndex: number, id: string | undefined): void
}

const TYPE_LABEL: Record<MotionElement['type'], string> = {
  text: 'Texto',
  shape: 'Forma',
  image: 'Imagem',
  chart: 'Gráfico',
  counter: 'Contador'
}

/** Every id used in the document (scenes and elements). */
function usedIds(doc: MotionSpec): Set<string> {
  const ids = new Set<string>()
  for (const s of doc.scenes) {
    ids.add(s.id)
    for (const e of s.elements) ids.add(e.id)
  }
  return ids
}

/** A fresh id derived from `base`, unused in the document and in `reserved` (which it then joins). */
export function uniqueId(doc: MotionSpec, base: string, reserved = new Set<string>()): string {
  const ids = usedIds(doc)
  const root = base.replace(/-\d+$/, '')
  for (let n = 2; ; n++) {
    const id = `${root}-${n}`
    if (!ids.has(id) && !reserved.has(id)) {
      reserved.add(id)
      return id
    }
  }
}

function elementLabel(el: MotionElement): string {
  if (el.type === 'text') return el.text.split('\n')[0].slice(0, 40) || el.id
  if (el.type === 'counter') return `${el.prefix ?? ''}${el.to}${el.suffix ?? ''}`
  if (el.type === 'chart') return `${el.chart} · ${el.labels.length} itens`
  if (el.type === 'shape') return el.shape
  return el.src.split(/[\\/]/).pop() ?? el.src
}

function move<T>(list: T[], from: number, to: number): void {
  if (to < 0 || to >= list.length) return
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item)
}

export function Editor({ doc, edit, sceneIndex, elementId, onSelectScene, onSelectElement }: Props) {
  const scene: MotionScene | undefined = doc.scenes[sceneIndex]
  const element = scene?.elements.find((e) => e.id === elementId)

  const editScene = (mutate: (s: MotionScene) => void, key: string) =>
    edit((d) => {
      const s = d.scenes[sceneIndex]
      if (s) mutate(s)
    }, `scene:${scene?.id}:${key}`)

  const setTransition = (patch: Partial<SceneTransition> & { type?: SceneTransition['type'] | undefined }) =>
    editScene((s) => {
      if ('type' in patch && !patch.type) {
        delete s.transition
        return
      }
      const next = { ...(s.transition ?? { type: 'fade' }), ...patch } as SceneTransition
      if (next.duration === undefined) delete next.duration
      s.transition = next
    }, 'transition')

  const addElement = (type: 'text' | 'shape') => {
    let id = ''
    edit((d) => {
      const s = d.scenes[sceneIndex]
      if (!s) return
      id = uniqueId(d, type === 'text' ? 'texto' : 'forma')
      const el: MotionElement =
        type === 'text'
          ? {
              id,
              type: 'text',
              text: 'Novo texto',
              x: d.width / 2,
              y: d.height / 2,
              fontSize: 64,
              color: '#1f1e1d',
              enter: { type: 'fade', duration: 0.5 }
            }
          : {
              id,
              type: 'shape',
              shape: 'rect',
              x: d.width / 2,
              y: d.height / 2,
              width: 320,
              height: 180,
              fill: '#c96442',
              radius: 16
            }
      s.elements.push(el)
    })
    if (id) onSelectElement(sceneIndex, id)
  }

  return (
    <div className={styles.editor}>
      <datalist id={FONT_LIST_ID}>
        {FONTS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      <Section title="Animação">
        <div className={styles.grid}>
          <TextField label="Título" value={doc.title} onChange={(v) => edit((d) => (d.title = v ?? ''), 'doc:title')} />
          <ColorField
            label="Fundo padrão"
            value={doc.background}
            onChange={(v) => edit((d) => (d.background = v ?? '#ffffff'), 'doc:background')}
          />
          <TextField
            label="Fonte padrão"
            value={doc.fontFamily}
            optional
            list={FONT_LIST_ID}
            onChange={(v) => edit((d) => (v ? (d.fontFamily = v) : delete d.fontFamily), 'doc:font')}
          />
          <NumField
            label="FPS"
            value={doc.fps}
            min={1}
            max={60}
            onChange={(v) => v && edit((d) => (d.fps = v), 'doc:fps')}
          />
        </div>
      </Section>

      <Section title="Cenas">
        <ul className={styles.list}>
          {doc.scenes.map((s, i) => (
            <li
              key={s.id}
              className={`${styles.item} ${i === sceneIndex ? styles.itemActive : ''}`}
              onClick={() => onSelectScene(i)}
            >
              <span className={styles.index}>{i + 1}</span>
              <input
                className={`input ${styles.inlineInput}`}
                value={s.name ?? ''}
                placeholder={s.id}
                title="Nome da cena"
                onClick={(e) => e.stopPropagation()}
                onFocus={() => onSelectScene(i)}
                onChange={(e) =>
                  edit((d) => {
                    if (e.target.value) d.scenes[i].name = e.target.value
                    else delete d.scenes[i].name
                  }, `scene:${s.id}:name`)
                }
              />
              <input
                className={`input ${styles.inlineNum}`}
                type="number"
                min={0.1}
                step={0.5}
                value={s.duration}
                title="Duração (s)"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (v > 0) edit((d) => (d.scenes[i].duration = v), `scene:${s.id}:duration`)
                }}
              />
              <span className="muted">s</span>
              <div className={styles.itemBtns} onClick={(e) => e.stopPropagation()}>
                <button
                  className={styles.mini}
                  title="Mover para cima"
                  disabled={i === 0}
                  onClick={() => {
                    edit((d) => move(d.scenes, i, i - 1))
                    onSelectScene(i - 1)
                  }}
                >
                  ↑
                </button>
                <button
                  className={styles.mini}
                  title="Mover para baixo"
                  disabled={i === doc.scenes.length - 1}
                  onClick={() => {
                    edit((d) => move(d.scenes, i, i + 1))
                    onSelectScene(i + 1)
                  }}
                >
                  ↓
                </button>
                <button
                  className={styles.mini}
                  title="Duplicar cena"
                  onClick={() => {
                    edit((d) => {
                      // Copies get new ids; the originals keep theirs.
                      const reserved = new Set<string>()
                      const copy = structuredClone(d.scenes[i])
                      copy.id = uniqueId(d, copy.id, reserved)
                      if (copy.name) copy.name = `${copy.name} (cópia)`
                      for (const el of copy.elements) el.id = uniqueId(d, el.id, reserved)
                      d.scenes.splice(i + 1, 0, copy)
                    })
                    onSelectScene(i + 1)
                  }}
                >
                  ⧉
                </button>
                <button
                  className={styles.mini}
                  title="Excluir cena"
                  disabled={doc.scenes.length <= 1}
                  onClick={() => {
                    if (!window.confirm(`Excluir a cena "${s.name ?? s.id}"?`)) return
                    edit((d) => d.scenes.splice(i, 1))
                    onSelectScene(Math.max(0, Math.min(i, doc.scenes.length - 2)))
                  }}
                >
                  🗑
                </button>
              </div>
            </li>
          ))}
        </ul>
        {scene && (
          <div className={styles.grid}>
            <ColorField
              label="Fundo da cena"
              value={scene.background}
              optional
              onChange={(v) => editScene((s) => (v ? (s.background = v) : delete s.background), 'background')}
            />
            <SelectField
              label="Transição de entrada"
              value={scene.transition?.type}
              options={[
                { value: '', label: 'nenhuma' },
                { value: 'fade', label: 'fade' },
                { value: 'slide-left', label: 'slide-left' },
                { value: 'slide-up', label: 'slide-up' }
              ]}
              onChange={(v) => setTransition({ type: v })}
            />
            {scene.transition && scene.transition.type !== 'none' && (
              <NumField
                label="Duração da transição (s)"
                value={scene.transition.duration}
                step={0.1}
                min={0}
                optional
                placeholder="0,5"
                onChange={(v) => setTransition({ duration: v })}
              />
            )}
          </div>
        )}
      </Section>

      {scene && (
        <Section
          title={`Elementos · ${scene.name ?? scene.id}`}
          actions={
            <>
              <button className="btn" onClick={() => addElement('text')}>
                + Texto
              </button>
              <button className="btn" onClick={() => addElement('shape')}>
                + Forma
              </button>
            </>
          }
        >
          {scene.elements.length === 0 && <div className="muted">Cena sem elementos.</div>}
          <ul className={styles.list}>
            {scene.elements.map((el, j) => (
              <li
                key={el.id}
                className={`${styles.item} ${el.id === elementId ? styles.itemActive : ''}`}
                onClick={() => onSelectElement(sceneIndex, el.id)}
              >
                <span className={styles.badge}>{TYPE_LABEL[el.type]}</span>
                <span className={styles.itemLabel}>{elementLabel(el)}</span>
                <div className={styles.itemBtns} onClick={(e) => e.stopPropagation()}>
                  <button
                    className={styles.mini}
                    title="Trazer para trás"
                    disabled={j === 0}
                    onClick={() => edit((d) => move(d.scenes[sceneIndex].elements, j, j - 1))}
                  >
                    ↑
                  </button>
                  <button
                    className={styles.mini}
                    title="Trazer para frente"
                    disabled={j === scene.elements.length - 1}
                    onClick={() => edit((d) => move(d.scenes[sceneIndex].elements, j, j + 1))}
                  >
                    ↓
                  </button>
                  <button
                    className={styles.mini}
                    title="Duplicar elemento"
                    onClick={() => {
                      let newId = ''
                      edit((d) => {
                        const copy = structuredClone(d.scenes[sceneIndex].elements[j])
                        copy.id = newId = uniqueId(d, copy.id)
                        copy.x += 40
                        copy.y += 40
                        d.scenes[sceneIndex].elements.splice(j + 1, 0, copy)
                      })
                      if (newId) onSelectElement(sceneIndex, newId)
                    }}
                  >
                    ⧉
                  </button>
                  <button
                    className={styles.mini}
                    title="Excluir elemento"
                    onClick={() => {
                      edit((d) => d.scenes[sceneIndex].elements.splice(j, 1))
                      if (el.id === elementId) onSelectElement(sceneIndex, undefined)
                    }}
                  >
                    🗑
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {scene && element ? (
        <ElementForm key={element.id} el={element} sceneIndex={sceneIndex} edit={edit} />
      ) : (
        <div className={`muted ${styles.hint}`}>
          Clique num elemento no quadro ou na lista para editar. Arraste no quadro para mover.
        </div>
      )}
    </div>
  )
}
