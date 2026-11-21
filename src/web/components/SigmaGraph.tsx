import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MultiDirectedGraph } from 'graphology'
import Sigma from 'sigma'
import { sdfCircle, sdfRectangle } from 'sigma/rendering'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
import type { ArtifactType } from '../../core/types'
import { encodeDocId, type GraphEdgeItem, type GraphNodeItem, type GraphResponse } from '../api'
import { useTheme } from '../theme'

interface SigmaNodeAttrs {
  x: number
  y: number
  size: number
  shape: 'rectangle' | 'circle'
  label: string
  color: string
  nodeKind: 'doc' | 'block'
  artifactType: ArtifactType
  docId: string
}

interface SigmaEdgeAttrs {
  size: number
  color: string
  label: string
  edgeKind: GraphEdgeItem['kind']
}

interface ForceParams {
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
}

const DEFAULT_FORCES: ForceParams = {
  centerForce: 0.055,
  repelForce: 155,
  linkForce: 0.07,
  linkDistance: 34,
}

const TYPE_COLORS: Record<ArtifactType, string> = {
  goal: '#f59e0b',
  decision: '#f43f5e',
  domain: '#0ea5e9',
  spec: '#3b82f6',
  contract: '#22c55e',
  architecture: '#8b5cf6',
  design: '#14b8a6',
  verification: '#ef4444',
  guide: '#d946ef',
}

const EDGE_COLORS: Record<GraphEdgeItem['kind'], string> = {
  derives: '#f59e0b',
  satisfies: '#14b8a6',
  verifies: '#22c55e',
  supersedes: '#f43f5e',
  mentions: '#94a3b8',
  contains: '#94a3b8',
}

interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  mass: number
}

interface SimEdge {
  sourceIdx: number
  targetIdx: number
  strength: number
  distance: number
}

interface SigmaGraphProps {
  data: GraphResponse
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
}

function buildGraphAndSim(
  data: GraphResponse,
  isDark: boolean,
): {
  graph: MultiDirectedGraph<SigmaNodeAttrs, SigmaEdgeAttrs>
  simNodes: SimNode[]
  simEdges: SimEdge[]
  worldRadius: number
} {
  const graph = new MultiDirectedGraph<SigmaNodeAttrs, SigmaEdgeAttrs>()
  const nodeMap = new Map<string, GraphNodeItem>(data.nodes.map((n) => [n.id, n]))

  const degree = new Map<string, number>()
  const normalizedEdges: Array<{ source: string; target: string; kind: GraphEdgeItem['kind'] }> = []
  const edgeDedup = new Set<string>()

  for (const e of data.edges) {
    const source = data.granularity === 'blocks' && nodeMap.has(e.from) ? e.from : e.fromDocId
    const target = data.granularity === 'blocks' && nodeMap.has(e.to) ? e.to : e.toDocId
    if (source === target) continue
    if (!nodeMap.has(source) || !nodeMap.has(target)) continue
    const key = `${source}|${e.kind}|${target}`
    if (edgeDedup.has(key)) continue
    edgeDedup.add(key)
    normalizedEdges.push({ source, target, kind: e.kind })
    degree.set(source, (degree.get(source) ?? 0) + 1)
    degree.set(target, (degree.get(target) ?? 0) + 1)
  }

  // 黄金角スパイラルで円形・有機的に初期配置
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const count = Math.max(1, data.nodes.length)
  const spread = Math.max(22, Math.sqrt(count) * 10.5)
  const simNodes: SimNode[] = []
  const idxById = new Map<string, number>()

  data.nodes.forEach((n, i) => {
    const r = Math.sqrt((i + 0.5) / count) * spread
    const theta = i * goldenAngle
    const x = Math.cos(theta) * r
    const y = Math.sin(theta) * r
    const deg = degree.get(n.id) ?? 0
    // コンパクトで見やすいサイズに抑える (doc: 角丸長方形, block: 小ぶりな丸)
    const size = n.kind === 'doc' ? 5.2 + Math.min(deg * 0.45, 3.6) : 3.2 + Math.min(deg * 0.3, 2.0)

    idxById.set(n.id, simNodes.length)
    simNodes.push({
      id: n.id,
      x,
      y,
      vx: 0,
      vy: 0,
      mass: n.kind === 'doc' ? 1.2 + deg * 0.06 : 0.85,
    })

    graph.addNode(n.id, {
      x,
      y,
      size,
      shape: n.kind === 'doc' ? 'rectangle' : 'circle',
      label: n.title,
      color: TYPE_COLORS[n.type],
      nodeKind: n.kind,
      artifactType: n.type,
      docId: n.docId,
    })
  })

  const simEdges: SimEdge[] = []
  for (const e of normalizedEdges) {
    const sIdx = idxById.get(e.source)
    const tIdx = idxById.get(e.target)
    if (sIdx === undefined || tIdx === undefined) continue

    const color =
      e.kind === 'contains'
        ? isDark
          ? '#3b4252'
          : '#cbd5e1'
        : e.kind === 'mentions'
          ? isDark
            ? '#475569'
            : '#94a3b8'
          : EDGE_COLORS[e.kind]

    graph.addEdge(e.source, e.target, {
      size: e.kind === 'contains' ? 0.8 : e.kind === 'mentions' ? 1.0 : 1.4,
      color,
      label: e.kind === 'contains' ? '' : e.kind,
      edgeKind: e.kind,
    })

    simEdges.push({
      sourceIdx: sIdx,
      targetIdx: tIdx,
      strength: e.kind === 'contains' ? 1.35 : e.kind === 'mentions' ? 0.5 : 0.95,
      distance: e.kind === 'contains' ? 0.55 : 1.0,
    })
  }

  const worldRadius = Math.max(90, spread * 2.6)
  return { graph, simNodes, simEdges, worldRadius }
}

/**
 * Obsidian Graph View ライクなリアルタイム力学シミュレーション付き Sigma.js (WebGL) グラフ。
 * - 文書ノードはコンパクトな角丸長方形 (sdfRectangle)、ブロックノードは小ぶりな円形
 * - ホバー／選択時は他を消さず、対象と隣接ノードを枠 (backdrop border) で囲んで強調
 */
export default function SigmaGraph({ data, selectedNodeId, onSelectNode }: SigmaGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sigmaRef = useRef<Sigma<SigmaNodeAttrs, SigmaEdgeAttrs> | null>(null)
  const hoveredRef = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(selectedNodeId)
  const forcesRef = useRef<ForceParams>(DEFAULT_FORCES)
  const wakeRef = useRef<((energy?: number) => void) | null>(null)
  const shakeRef = useRef<(() => void) | null>(null)

  const navigate = useNavigate()
  const { resolved: theme } = useTheme()
  const isDark = theme === 'dark'

  const [query, setQuery] = useState('')
  const [forces, setForces] = useState<ForceParams>(DEFAULT_FORCES)
  const [showForces, setShowForces] = useState(false)
  const [webglError, setWebglError] = useState<string | null>(null)

  selectedRef.current = selectedNodeId
  forcesRef.current = forces

  const matchingNodes = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return data.nodes.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).slice(0, 8)
  }, [data.nodes, query])

  const updateForce = (key: keyof ForceParams, value: number) => {
    setForces((prev) => ({ ...prev, [key]: value }))
    wakeRef.current?.(0.9)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const { graph, simNodes, simEdges, worldRadius } = buildGraphAndSim(data, isDark)
    const simById = new Map(simNodes.map((n) => [n.id, n]))

    const labelColor = isDark ? '#e2e8f0' : '#1e293b'
    const focusBg = isDark ? 'rgba(24, 27, 34, 0.92)' : 'rgba(255, 255, 255, 0.94)'
    const neighborBg = isDark ? 'rgba(24, 27, 34, 0.78)' : 'rgba(255, 255, 255, 0.84)'
    const shadowColor = isDark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(15, 23, 42, 0.14)'

    let renderer: Sigma<SigmaNodeAttrs, SigmaEdgeAttrs>
    try {
      renderer = new Sigma<SigmaNodeAttrs, SigmaEdgeAttrs>(graph, container, {
        primitives: {
          nodes: {
            shapes: [sdfRectangle({ aspectRatio: 1.9, cornerRadius: 0.24 }), sdfCircle()],
          },
        },
        settings: {
          renderLabels: true,
          renderEdgeLabels: false,
          enableNodeDrag: true,
          allowInvalidContainer: true,
          autoRescale: 'once',
          stagePadding: 48,
          labelRenderedSizeThreshold: 2,
          labelDensity: 0.45,
          minCameraRatio: 0.12,
          maxCameraRatio: 5,
        },
        nodeReducer: (node, displayData, attrs) => {
          const focus = hoveredRef.current ?? selectedRef.current
          const base = {
            ...displayData,
            shape: attrs.shape,
            labelColor,
            labelSize: attrs.nodeKind === 'doc' ? 12 : 10.5,
            labelPosition: 'below' as const,
            backdropVisibility: 'hidden' as const,
          }

          if (!focus || !graph.hasNode(focus)) {
            return base
          }

          if (node === focus) {
            return {
              ...base,
              size: displayData.size * 1.12,
              labelVisibility: 'visible' as const,
              backdropVisibility: 'visible' as const,
              backdropArea: 'both' as const,
              backdropColor: focusBg,
              backdropBorderColor: displayData.color,
              backdropBorderWidth: 2,
              backdropCornerRadius: 6,
              backdropPadding: 5,
              backdropShadowColor: shadowColor,
              backdropShadowBlur: 10,
              zIndex: 3,
            }
          }

          if (graph.areNeighbors(focus, node)) {
            return {
              ...base,
              labelVisibility: 'visible' as const,
              backdropVisibility: 'visible' as const,
              backdropArea: 'both' as const,
              backdropColor: neighborBg,
              backdropBorderColor: displayData.color,
              backdropBorderWidth: 1,
              backdropCornerRadius: 5,
              backdropPadding: 3,
              backdropShadowColor: shadowColor,
              backdropShadowBlur: 4,
              zIndex: 2,
            }
          }

          // 他ノードは消さず・グレー化せず、そのまま自然な表示を維持する
          return base
        },
        edgeReducer: (edge, displayData) => {
          const focus = hoveredRef.current ?? selectedRef.current
          if (!focus || !graph.hasNode(focus)) {
            return {
              ...displayData,
              opacity: isDark ? 0.5 : 0.6,
              head: displayData.size >= 1.3 ? 'arrow' : undefined,
            }
          }
          const src = graph.source(edge)
          const dst = graph.target(edge)
          if (src === focus || dst === focus) {
            return {
              ...displayData,
              size: Math.max(displayData.size * 1.5, 2.0),
              head: 'arrow',
              opacity: 1,
              zIndex: 2,
            }
          }
          return {
            ...displayData,
            opacity: isDark ? 0.35 : 0.4,
            zIndex: 0,
          }
        },
      })
      renderer.setCustomBBox({ x: [-worldRadius, worldRadius], y: [-worldRadius, worldRadius] })
      setWebglError(null)
    } catch (e) {
      setWebglError(e instanceof Error ? e.message : 'WebGL グラフの初期化に失敗しました')
      return
    }

    sigmaRef.current = renderer

    // リアルタイム Force-Directed 物理エンジン (Obsidian Graph View スタイル)
    let draggedNodeId: string | null = null
    let alpha = 1.0
    let rafId: number | null = null
    let killed = false

    const tick = () => {
      rafId = null
      if (killed) return

      const p = forcesRef.current
      const nCount = simNodes.length
      const damping = 0.84
      const maxSpeed = 6.5

      if (draggedNodeId) {
        const pinned = simById.get(draggedNodeId)
        if (pinned && graph.hasNode(draggedNodeId)) {
          pinned.x = graph.getNodeAttribute(draggedNodeId, 'x')
          pinned.y = graph.getNodeAttribute(draggedNodeId, 'y')
          pinned.vx = 0
          pinned.vy = 0
        }
      }

      // 1. ノード間反発力 (Coulomb) + 中心引力
      for (let i = 0; i < nCount; i++) {
        const a = simNodes[i]!
        a.vx -= a.x * p.centerForce * 0.045 * alpha
        a.vy -= a.y * p.centerForce * 0.045 * alpha

        for (let j = i + 1; j < nCount; j++) {
          const b = simNodes[j]!
          let dx = b.x - a.x
          let dy = b.y - a.y
          let distSq = dx * dx + dy * dy
          if (distSq < 0.01) {
            dx = (Math.random() - 0.5) * 0.2
            dy = (Math.random() - 0.5) * 0.2
            distSq = dx * dx + dy * dy
          }
          const dist = Math.sqrt(distSq)
          const force = (p.repelForce / (distSq + 24)) * alpha
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          a.vx -= fx / a.mass
          a.vy -= fy / a.mass
          b.vx += fx / b.mass
          b.vy += fy / b.mass
        }
      }

      // 2. エッジのばね引力 (Hooke)
      for (const edge of simEdges) {
        const a = simNodes[edge.sourceIdx]!
        const b = simNodes[edge.targetIdx]!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001
        const targetDist = p.linkDistance * edge.distance
        const displacement = dist - targetDist
        const force = displacement * p.linkForce * edge.strength * alpha
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx += fx / a.mass
        a.vy += fy / a.mass
        b.vx -= fx / b.mass
        b.vy -= fy / b.mass
      }

      // 3. 位置更新・速度クランプ・Graphology へ反映
      let totalMotion = 0
      const bound = worldRadius * 0.94
      for (const node of simNodes) {
        if (node.id === draggedNodeId) continue
        node.vx *= damping
        node.vy *= damping
        const speed = Math.hypot(node.vx, node.vy)
        if (speed > maxSpeed) {
          node.vx = (node.vx / speed) * maxSpeed
          node.vy = (node.vy / speed) * maxSpeed
        }
        node.x = Math.max(-bound, Math.min(bound, node.x + node.vx))
        node.y = Math.max(-bound, Math.min(bound, node.y + node.vy))
        totalMotion += Math.abs(node.vx) + Math.abs(node.vy)
        graph.setNodeAttribute(node.id, 'x', node.x)
        graph.setNodeAttribute(node.id, 'y', node.y)
      }

      renderer.scheduleRender()

      if (draggedNodeId) {
        alpha = Math.max(alpha, 0.72)
        rafId = requestAnimationFrame(tick)
      } else {
        alpha *= 0.992
        if (alpha > 0.015 && totalMotion > 0.008) {
          rafId = requestAnimationFrame(tick)
        }
      }
    }

    const wake = (energy = 0.85) => {
      if (killed) return
      alpha = Math.max(alpha, energy)
      if (rafId === null) {
        rafId = requestAnimationFrame(tick)
      }
    }

    const shake = () => {
      for (const node of simNodes) {
        node.vx += (Math.random() - 0.5) * 10
        node.vy += (Math.random() - 0.5) * 10
      }
      wake(1.0)
    }

    wakeRef.current = wake
    shakeRef.current = shake
    wake(1.0)

    renderer.on('nodeDragStart', ({ node }) => {
      draggedNodeId = node
      wake(0.95)
    })

    renderer.on('nodeDrag', () => {
      wake(0.85)
    })

    renderer.on('nodeDragEnd', () => {
      draggedNodeId = null
      wake(0.65)
    })

    renderer.on('enterNode', ({ node }) => {
      hoveredRef.current = node
      renderer.refresh()
    })

    renderer.on('leaveNode', () => {
      hoveredRef.current = null
      renderer.refresh()
    })

    renderer.on('clickNode', ({ node }) => {
      onSelectNode(selectedRef.current === node ? null : node)
    })

    renderer.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
      preventSigmaDefault()
      const attrs = graph.getNodeAttributes(node)
      const hash = attrs.nodeKind === 'block' ? `#block-${encodeURIComponent(node)}` : ''
      navigate(`/docs/${encodeDocId(attrs.docId)}${hash}`)
    })

    renderer.on('clickStage', () => {
      onSelectNode(null)
    })

    return () => {
      killed = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      wakeRef.current = null
      shakeRef.current = null
      renderer.kill()
      sigmaRef.current = null
    }
  }, [data, isDark, navigate, onSelectNode])

  useEffect(() => {
    sigmaRef.current?.refresh()
  }, [selectedNodeId])

  const focusNode = (nodeId: string) => {
    const renderer = sigmaRef.current
    if (!renderer) return
    onSelectNode(nodeId)
    const display = renderer.getNodeDisplayData(nodeId)
    if (display) {
      void renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.45 }, { duration: 350 })
    }
    setQuery('')
  }

  return (
    <div className="sigma-wrapper sigma-full">
      <div className="sigma-overlay-top">
        <div className="sigma-search">
          <input
            type="search"
            className="sigma-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ノード検索でフォーカス…"
          />
          {matchingNodes.length > 0 && (
            <ul className="sigma-search-dropdown">
              {matchingNodes.map((n) => (
                <li key={n.id}>
                  <button type="button" className="sigma-search-item" onClick={() => focusNode(n.id)}>
                    <span className="sigma-dot" style={{ background: TYPE_COLORS[n.type] }} />
                    <span>{n.title}</span>
                    <span className="muted mono">{n.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="sigma-controls">
          <button
            type="button"
            className="sigma-ctrl-btn"
            onClick={() => void sigmaRef.current?.getCamera().zoomIn({ duration: 220 })}
            title="ズームイン"
          >
            +
          </button>
          <button
            type="button"
            className="sigma-ctrl-btn"
            onClick={() => void sigmaRef.current?.getCamera().zoomOut({ duration: 220 })}
            title="ズームアウト"
          >
            −
          </button>
          <button
            type="button"
            className="sigma-ctrl-btn"
            onClick={() => {
              onSelectNode(null)
              void sigmaRef.current?.getCamera().reset({ duration: 280 })
            }}
            title="全体表示へリセット"
          >
            ⟲
          </button>
          <button
            type="button"
            className="sigma-ctrl-btn"
            onClick={() => shakeRef.current?.()}
            title="揺らして再シミュレーション"
          >
            ⚡
          </button>
          <button
            type="button"
            className={`sigma-ctrl-btn${showForces ? ' active' : ''}`}
            onClick={() => setShowForces((v) => !v)}
            title="物理パラメータ調整 (Forces)"
          >
            ⚙
          </button>
        </div>
      </div>

      {showForces && (
        <div className="sigma-forces-panel">
          <div className="sigma-forces-head">
            <strong>Forces</strong>
            <button
              type="button"
              className="sem-diff-close"
              onClick={() => {
                setForces(DEFAULT_FORCES)
                wakeRef.current?.(1.0)
              }}
            >
              リセット
            </button>
          </div>
          <label className="sigma-slider">
            <span>Center force</span>
            <input
              type="range"
              min={0.01}
              max={0.25}
              step={0.005}
              value={forces.centerForce}
              onChange={(e) => updateForce('centerForce', Number(e.target.value))}
            />
          </label>
          <label className="sigma-slider">
            <span>Repel force</span>
            <input
              type="range"
              min={40}
              max={320}
              step={10}
              value={forces.repelForce}
              onChange={(e) => updateForce('repelForce', Number(e.target.value))}
            />
          </label>
          <label className="sigma-slider">
            <span>Link force</span>
            <input
              type="range"
              min={0.01}
              max={0.2}
              step={0.005}
              value={forces.linkForce}
              onChange={(e) => updateForce('linkForce', Number(e.target.value))}
            />
          </label>
          <label className="sigma-slider">
            <span>Link distance</span>
            <input
              type="range"
              min={14}
              max={70}
              step={2}
              value={forces.linkDistance}
              onChange={(e) => updateForce('linkDistance', Number(e.target.value))}
            />
          </label>
        </div>
      )}

      {webglError ? (
        <div className="sigma-fallback">
          <p className="error-text">{webglError}</p>
        </div>
      ) : (
        <div ref={containerRef} className="sigma-stage sigma-stage-full" />
      )}

      <div className="sigma-legend">
        <div className="sigma-legend-group">
          {(Object.keys(TYPE_COLORS) as ArtifactType[]).map((t) => (
            <span key={t} className="sigma-legend-item">
              <span className="sigma-dot" style={{ background: TYPE_COLORS[t] }} />
              {ARTIFACT_TYPE_LABELS[t]}
            </span>
          ))}
        </div>
        <div className="sigma-legend-hint">ノードをドラッグして引っ張る / ホイールでズーム / ダブルクリックで開く</div>
      </div>
    </div>
  )
}
