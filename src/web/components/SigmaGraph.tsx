import { Minus, Plus, RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import Sigma from 'sigma'
import { sdfCircle } from 'sigma/rendering'
import type { ArtifactType } from '../../core/types'
import { encodeDocId, type GraphResponse } from '../api'
import {
  buildGraphAndSim,
  DEFAULT_FORCES,
  stepForceSimulation,
  TYPE_COLORS,
  type ForceParams,
  type LodMode,
  type SigmaEdgeAttrs,
  type SigmaNodeAttrs,
} from '../graph/physics'
import { useTheme } from '../theme'

interface SigmaGraphProps {
  data: GraphResponse
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
}

/**
 * セマンティックズーム (LOD) 付き Sigma.js (WebGL) リアルタイム力学グラフ。
 * - 通常〜ズームイン時: 左に Type 色ドット＋右にタイトルを 1 枚のコンパクト角丸長方形カード (GPU backdrop) で描画
 * - ズームアウト / 大規模俯瞰時: 自動で小さい色付きドットへ縮退し、重なりを抑えて全体構造を俯瞰
 * - ホバー／選択時は他ノードを消さず、対象を全文タイトル＋太枠カード、隣接ノードを色枠カードで前面強調
 */
export default function SigmaGraph({ data, selectedNodeId, onSelectNode }: SigmaGraphProps) {
  const { t } = useTranslation()
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
    const cardBg = isDark ? 'rgba(24, 27, 34, 0.92)' : 'rgba(255, 255, 255, 0.94)'
    const cardBorder = isDark ? 'rgba(148, 163, 184, 0.28)' : 'rgba(148, 163, 184, 0.45)'
    const focusBg = isDark ? 'rgba(28, 32, 41, 0.97)' : 'rgba(255, 255, 255, 0.98)'
    const neighborBg = isDark ? 'rgba(24, 27, 34, 0.94)' : 'rgba(255, 255, 255, 0.96)'
    const shadowColor = isDark ? 'rgba(0, 0, 0, 0.48)' : 'rgba(15, 23, 42, 0.14)'

    // ノード総数に応じてセマンティックズーム (LOD) の切替しきい値を調整
    const docCardThreshold = data.nodes.length <= 60 ? 1.35 : data.nodes.length <= 180 ? 0.92 : 0.65
    const blockCardThreshold = 0.65
    const computeLod = (ratio: number): LodMode => {
      if (ratio <= blockCardThreshold) return 'all-card'
      if (ratio <= docCardThreshold) return 'doc-card'
      return 'dot'
    }
    let currentLod: LodMode = computeLod(1.0)

    let renderer: Sigma<SigmaNodeAttrs, SigmaEdgeAttrs>
    try {
      renderer = new Sigma<SigmaNodeAttrs, SigmaEdgeAttrs>(graph, container, {
        primitives: {
          nodes: {
            shapes: [sdfCircle()],
          },
        },
        settings: {
          renderLabels: true,
          renderEdgeLabels: false,
          enableNodeDrag: true,
          allowInvalidContainer: true,
          autoRescale: 'once',
          stagePadding: 56,
          labelRenderedSizeThreshold: 2,
          labelDensity: 0.55,
          minCameraRatio: 0.12,
          maxCameraRatio: 5,
        },
        nodeReducer: (node, displayData, attrs) => {
          const focus = hoveredRef.current ?? selectedRef.current
          const showAsCard = currentLod === 'all-card' || (currentLod === 'doc-card' && attrs.nodeKind === 'doc')

          const base = showAsCard
            ? {
                ...displayData,
                label: attrs.shortLabel,
                labelColor,
                labelFont: "'IBM Plex Sans', 'IBM Plex Sans JP', sans-serif",
                labelSize: attrs.nodeKind === 'doc' ? 11.5 : 10,
                labelPosition: 'right' as const,
                backdropVisibility: 'visible' as const,
                backdropArea: 'both' as const,
                backdropColor: cardBg,
                backdropBorderColor: cardBorder,
                backdropBorderWidth: 1,
                backdropCornerRadius: 6,
                backdropPadding: 4,
                backdropLabelPadding: 5,
                backdropShadowColor: shadowColor,
                backdropShadowBlur: 3,
              }
            : {
                ...displayData,
                label: attrs.shortLabel,
                labelColor,
                labelFont: "'IBM Plex Sans', 'IBM Plex Sans JP', sans-serif",
                labelSize: attrs.nodeKind === 'doc' ? 11 : 10,
                labelPosition: 'below' as const,
                backdropVisibility: 'hidden' as const,
              }

          if (!focus || !graph.hasNode(focus)) {
            return base
          }

          if (node === focus) {
            return {
              ...base,
              label: attrs.fullLabel,
              size: displayData.size * 1.15,
              labelPosition: 'right' as const,
              labelVisibility: 'visible' as const,
              backdropVisibility: 'visible' as const,
              backdropArea: 'both' as const,
              backdropColor: focusBg,
              backdropBorderColor: displayData.color,
              backdropBorderWidth: 2,
              backdropCornerRadius: 6,
              backdropPadding: 5,
              backdropLabelPadding: 6,
              backdropShadowColor: shadowColor,
              backdropShadowBlur: 10,
              zIndex: 3,
            }
          }

          if (graph.areNeighbors(focus, node)) {
            return {
              ...base,
              label: attrs.shortLabel,
              labelPosition: 'right' as const,
              labelVisibility: 'visible' as const,
              backdropVisibility: 'visible' as const,
              backdropArea: 'both' as const,
              backdropColor: neighborBg,
              backdropBorderColor: displayData.color,
              backdropBorderWidth: 1.25,
              backdropCornerRadius: 6,
              backdropPadding: 4,
              backdropLabelPadding: 5,
              backdropShadowColor: shadowColor,
              backdropShadowBlur: 5,
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
      setWebglError(e instanceof Error ? e.message : t('graph.webglError'))
      return
    }

    sigmaRef.current = renderer

    // ズーム倍率に応じたセマンティックズーム (LOD) 切替（状態が変わったときのみ再描画）
    const camera = renderer.getCamera()
    const onCameraUpdated = () => {
      const nextLod = computeLod(camera.getState().ratio)
      if (nextLod !== currentLod) {
        currentLod = nextLod
        renderer.refresh()
      }
    }
    camera.on('updated', onCameraUpdated)

    // リアルタイム Force-Directed 物理エンジン (Obsidian Graph View スタイル)
    let draggedNodeId: string | null = null
    let alpha = 1.0
    let rafId: number | null = null
    let killed = false

    const tick = () => {
      rafId = null
      if (killed) return

      const totalMotion = stepForceSimulation(
        simNodes,
        simEdges,
        graph,
        forcesRef.current,
        alpha,
        worldRadius,
        draggedNodeId,
        simById,
      )

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
      camera.off('updated', onCameraUpdated)
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

  const ctrlBtnClass = (active = false) =>
    `flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-lg border text-[15px] font-bold shadow-[0_4px_12px_rgba(0,0,0,0.08)] ${
      active ? 'border-accent bg-accent text-surface' : 'border-line bg-surface text-fg hover:bg-hover'
    }`

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-sidebar">
      <div className="pointer-events-none absolute top-3 right-3 left-3 z-15 flex items-start justify-between gap-2.5">
        <div className="pointer-events-auto relative w-[min(280px,65%)]">
          <input
            type="search"
            className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-fg shadow-[0_4px_12px_rgba(0,0,0,0.08)]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('graph.searchNodePlaceholder')}
          />
          {matchingNodes.length > 0 && (
            <ul className="absolute top-[calc(100%+4px)] right-0 left-0 m-0 max-h-[220px] list-none overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-[0_10px_24px_rgba(0,0,0,0.14)]">
              {matchingNodes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-xs text-fg hover:bg-hover"
                    onClick={() => focusNode(n.id)}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_COLORS[n.type] }} />
                    <span>{n.title}</span>
                    <span className="muted mono ml-auto text-[10.5px]">{n.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="pointer-events-auto flex gap-1">
          <button
            type="button"
            className={ctrlBtnClass()}
            onClick={() => void sigmaRef.current?.getCamera().zoomIn({ duration: 220 })}
            title={t('graph.zoomIn')}
            aria-label={t('graph.zoomIn')}
          >
            <Plus size={14} strokeWidth={1.85} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={ctrlBtnClass()}
            onClick={() => void sigmaRef.current?.getCamera().zoomOut({ duration: 220 })}
            title={t('graph.zoomOut')}
            aria-label={t('graph.zoomOut')}
          >
            <Minus size={14} strokeWidth={1.85} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={ctrlBtnClass()}
            onClick={() => {
              onSelectNode(null)
              void sigmaRef.current?.getCamera().reset({ duration: 280 })
            }}
            title={t('graph.resetView')}
            aria-label={t('graph.resetView')}
          >
            <RotateCcw size={13} strokeWidth={1.85} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={ctrlBtnClass()}
            onClick={() => shakeRef.current?.()}
            title={t('graph.resimulate')}
            aria-label={t('graph.resimulate')}
          >
            <Sparkles size={13} strokeWidth={1.85} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={ctrlBtnClass(showForces)}
            onClick={() => setShowForces((v) => !v)}
            title={t('graph.forcesSettings')}
            aria-label={t('graph.forcesLabel')}
          >
            <SlidersHorizontal size={13} strokeWidth={1.85} aria-hidden="true" />
          </button>
        </div>
      </div>

      {showForces && (
        <div className="absolute top-[52px] right-3 z-20 grid w-[220px] gap-2 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-xs shadow-[0_10px_28px_rgba(0,0,0,0.16)]">
          <div className="flex items-center justify-between">
            <strong>Forces</strong>
            <button
              type="button"
              className="sem-diff-close"
              onClick={() => {
                setForces(DEFAULT_FORCES)
                wakeRef.current?.(1.0)
              }}
            >
              {t('common.reset')}
            </button>
          </div>
          <label className="grid gap-[3px] text-[11.5px] text-fg-muted">
            <span>Center force</span>
            <input
              type="range"
              className="w-full accent-[var(--accent)]"
              min={0.01}
              max={0.25}
              step={0.005}
              value={forces.centerForce}
              onChange={(e) => updateForce('centerForce', Number(e.target.value))}
            />
          </label>
          <label className="grid gap-[3px] text-[11.5px] text-fg-muted">
            <span>Repel force</span>
            <input
              type="range"
              className="w-full accent-[var(--accent)]"
              min={40}
              max={320}
              step={10}
              value={forces.repelForce}
              onChange={(e) => updateForce('repelForce', Number(e.target.value))}
            />
          </label>
          <label className="grid gap-[3px] text-[11.5px] text-fg-muted">
            <span>Link force</span>
            <input
              type="range"
              className="w-full accent-[var(--accent)]"
              min={0.01}
              max={0.2}
              step={0.005}
              value={forces.linkForce}
              onChange={(e) => updateForce('linkForce', Number(e.target.value))}
            />
          </label>
          <label className="grid gap-[3px] text-[11.5px] text-fg-muted">
            <span>Link distance</span>
            <input
              type="range"
              className="w-full accent-[var(--accent)]"
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
        <div className="px-5 py-10 text-center">
          <p className="error-text">{webglError}</p>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="relative min-h-[460px] w-full flex-1 bg-[radial-gradient(circle_at_center,var(--bg)_0%,var(--bg-sidebar)_100%)]"
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-surface px-3 py-2 text-[11.5px] text-fg-muted">
        <div className="flex flex-wrap gap-2.5">
          {(Object.keys(TYPE_COLORS) as ArtifactType[]).map((type) => (
            <span key={type} className="inline-flex items-center gap-[5px]">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_COLORS[type] }} />
              {t(`types.singular.${type}`)}
            </span>
          ))}
        </div>
        <div className="text-[11px]">{t('graph.hint')}</div>
      </div>
    </div>
  )
}
