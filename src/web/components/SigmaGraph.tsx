import { Minus, Plus, RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Sigma } from 'sigma'
import { sdfCircle } from 'sigma/rendering'
import type { ArtifactType } from '../../core/types'
import { encodeDocId, type GraphResponse } from '../api'
import {
  buildGraphAndSim,
  DEFAULT_FORCES,
  stepForceSimulation,
  TYPE_COLORS,
  type ForceParams,
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
 * Sigma.js (WebGL) リアルタイム力学グラフ。
 * - 通常時: 小さめの Type 色ドット＋下中央の短縮ラベル（枠なし）でエッジとクラスタ構造を見渡しやすく描画
 * - ホバー／選択時: ドット外周を円形リングで囲み、接続エッジ上に向きに沿って流れる光の粒（パルス）を描画
 */
function ctrlBtnClass(active = false) {
  return `flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-lg border text-[15px] font-bold shadow-[0_4px_12px_rgba(0,0,0,0.08)] ${
    active ? 'border-accent bg-accent text-surface' : 'border-line bg-surface text-fg hover:bg-hover'
  }`
}

export default function SigmaGraph({ data, selectedNodeId, onSelectNode }: SigmaGraphProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const sigmaRef = useRef<Sigma<SigmaNodeAttrs, SigmaEdgeAttrs> | null>(null)
  const hoveredRef = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(selectedNodeId)
  const forcesRef = useRef<ForceParams>(DEFAULT_FORCES)
  const wakeRef = useRef<((energy?: number) => void) | null>(null)
  const shakeRef = useRef<(() => void) | null>(null)
  const syncPulseRef = useRef<(() => void) | null>(null)

  const navigate = useNavigate()
  const { resolved: theme } = useTheme()
  const isDark = theme === 'dark'

  const [query, setQuery] = useState('')
  const [forces, setForces] = useState<ForceParams>(DEFAULT_FORCES)
  const [showForces, setShowForces] = useState(false)
  const [webglError, setWebglError] = useState<string | null>(null)

  useEffect(() => {
    selectedRef.current = selectedNodeId
  }, [selectedNodeId])

  useEffect(() => {
    forcesRef.current = forces
  }, [forces])

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
    let disposed = false

    const { graph, simNodes, simEdges, worldRadius } = buildGraphAndSim(data, isDark)
    const simById = new Map(simNodes.map((n) => [n.id, n]))

    const labelColor = isDark ? '#cbd5e1' : '#334155'
    const focusLabelColor = isDark ? '#f8fafc' : '#0f172a'
    const mutedLabelColor = isDark ? 'rgba(148, 163, 184, 0.55)' : 'rgba(100, 116, 139, 0.55)'

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
          labelRenderedSizeThreshold: 1.5,
          labelDensity: 0.7,
          minCameraRatio: 0.12,
          maxCameraRatio: 5,
        },
        nodeReducer: (node, displayData, attrs) => {
          const focus = hoveredRef.current ?? selectedRef.current
          const base = {
            ...displayData,
            label: attrs.shortLabel,
            labelColor,
            labelFont: "'IBM Plex Sans', 'IBM Plex Sans JP', sans-serif",
            labelSize: attrs.nodeKind === 'doc' ? 10.5 : 9.5,
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
              size: displayData.size * 1.06,
              labelColor: focusLabelColor,
              labelPosition: 'below' as const,
              labelVisibility: 'visible' as const,
              backdropVisibility: 'visible' as const,
              backdropArea: 'node' as const,
              backdropColor: 'transparent',
              backdropBorderColor: displayData.color,
              backdropBorderWidth: 1.5,
              backdropPadding: 3,
              backdropCornerRadius: 0,
              backdropShadowColor: 'transparent',
              backdropShadowBlur: 0,
              zIndex: 3,
            }
          }

          if (graph.areNeighbors(focus, node)) {
            return {
              ...base,
              label: attrs.shortLabel,
              labelColor: focusLabelColor,
              labelPosition: 'below' as const,
              labelVisibility: 'visible' as const,
              backdropVisibility: 'visible' as const,
              backdropArea: 'node' as const,
              backdropColor: 'transparent',
              backdropBorderColor: displayData.color,
              backdropBorderWidth: 1,
              backdropPadding: 2.5,
              backdropCornerRadius: 0,
              backdropShadowColor: 'transparent',
              backdropShadowBlur: 0,
              zIndex: 2,
            }
          }

          return {
            ...base,
            opacity: isDark ? 0.65 : 0.68,
            labelColor: mutedLabelColor,
          }
        },
        edgeReducer: (edge, displayData) => {
          const focus = hoveredRef.current ?? selectedRef.current
          if (!focus || !graph.hasNode(focus)) {
            return {
              ...displayData,
              opacity: isDark ? 0.42 : 0.52,
              head: displayData.size >= 1.1 ? 'arrow' : undefined,
            }
          }
          const src = graph.source(edge)
          const dst = graph.target(edge)
          if (src === focus || dst === focus) {
            return {
              ...displayData,
              size: Math.max(displayData.size * 1.1, 1.2),
              head: 'arrow',
              opacity: 0.78,
              zIndex: 2,
            }
          }
          return {
            ...displayData,
            opacity: isDark ? 0.3 : 0.34,
            zIndex: 0,
          }
        },
      })
      renderer.setCustomBBox({ x: [-worldRadius, worldRadius], y: [-worldRadius, worldRadius] })
      queueMicrotask(() => {
        if (!disposed) setWebglError(null)
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : t('graph.webglError')
      queueMicrotask(() => {
        if (!disposed) setWebglError(message)
      })
      return () => {
        disposed = true
      }
    }

    sigmaRef.current = renderer
    const camera = renderer.getCamera()

    // Figma / Miro 方式のトラックパッド＆マウス操作:
    // - 通常 wheel (2本指スワイプ): 上下左右パン
    // - ctrlKey / metaKey 付き wheel (トラックパッドのピンチ / ⌘・Ctrl+ホイール): カーソル中心ズーム
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const modeScale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
      const dx = e.deltaX * modeScale
      const dy = e.deltaY * modeScale

      if (e.ctrlKey || e.metaKey) {
        if (dy === 0) return
        const rect = container.getBoundingClientRect()
        const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        const clampedDy = Math.max(-120, Math.min(120, dy))
        const zoomFactor = Math.exp(clampedDy * 0.008)
        const currentRatio = camera.getState().ratio
        const nextRatio = camera.getBoundedRatio(currentRatio * zoomFactor)
        if (nextRatio === currentRatio) return
        camera.setState(renderer.getViewportZoomedState(cursor, nextRatio))
      } else {
        if (dx === 0 && dy === 0) return
        const p0 = renderer.viewportToFramedGraph({ x: 0, y: 0 })
        const p1 = renderer.viewportToFramedGraph({ x: dx, y: dy })
        const state = camera.getState()
        camera.setState({
          x: state.x + (p1.x - p0.x),
          y: state.y + (p1.y - p0.y),
        })
      }
    }
    const preventSafariGesture = (e: Event) => {
      e.preventDefault()
    }
    container.addEventListener('wheel', onWheel, { passive: false, capture: true })
    container.addEventListener('gesturestart', preventSafariGesture, { passive: false })
    container.addEventListener('gesturechange', preventSafariGesture, { passive: false })

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

    let pulseRafId: number | null = null
    const reducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    const clearPulseCanvas = () => {
      const canvas = overlayCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
    }

    const drawPulses = (now: number) => {
      pulseRafId = null
      if (killed || reducedMotion) return
      const focus = hoveredRef.current ?? selectedRef.current
      const canvas = overlayCanvasRef.current
      if (!focus || !graph.hasNode(focus) || !canvas) {
        clearPulseCanvas()
        return
      }

      const dpr = window.devicePixelRatio || 1
      const width = container.clientWidth
      const height = container.clientHeight
      if (width <= 0 || height <= 0) return

      const targetW = Math.round(width * dpr)
      const targetH = Math.round(height * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      const edges = graph.edges(focus)
      const periodMs = 1750
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i]!
        const src = graph.source(edge)
        const dst = graph.target(edge)
        const srcAttrs = graph.getNodeAttributes(src)
        const dstAttrs = graph.getNodeAttributes(dst)
        const p0 = renderer.graphToViewport({ x: srcAttrs.x, y: srcAttrs.y })
        const p1 = renderer.graphToViewport({ x: dstAttrs.x, y: dstAttrs.y })
        const dx = p1.x - p0.x
        const dy = p1.y - p0.y
        const len = Math.hypot(dx, dy)
        if (len < 16) continue

        const phase = (i * 0.27) % 1
        const progress = (now / periodMs + phase) % 1
        const tailProgress = Math.max(0, progress - Math.min(0.22, 24 / len))

        const hx = p0.x + dx * progress
        const hy = p0.y + dy * progress
        const tx = p0.x + dx * tailProgress
        const ty = p0.y + dy * tailProgress
        const edgeColor = graph.getEdgeAttribute(edge, 'color')
        const fadeEdge = Math.min(progress / 0.12, (1 - progress) / 0.12, 1)

        // 細い尾（フラット・影なし）
        const grad = ctx.createLinearGradient(tx, ty, hx, hy)
        grad.addColorStop(0, 'rgba(255, 255, 255, 0)')
        grad.addColorStop(1, edgeColor)
        ctx.globalAlpha = 0.55 * fadeEdge
        ctx.strokeStyle = grad
        ctx.lineWidth = 1.75
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(tx, ty)
        ctx.lineTo(hx, hy)
        ctx.stroke()

        // 先端の粒（フラット・影なし）
        ctx.globalAlpha = 0.88 * fadeEdge
        ctx.fillStyle = edgeColor
        ctx.beginPath()
        ctx.arc(hx, hy, 2, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()
      pulseRafId = requestAnimationFrame(drawPulses)
    }

    const syncPulse = () => {
      if (killed || reducedMotion) return
      const focus = hoveredRef.current ?? selectedRef.current
      if (focus && graph.hasNode(focus)) {
        if (pulseRafId === null) {
          pulseRafId = requestAnimationFrame(drawPulses)
        }
      } else {
        if (pulseRafId !== null) {
          cancelAnimationFrame(pulseRafId)
          pulseRafId = null
        }
        clearPulseCanvas()
      }
    }

    wakeRef.current = wake
    shakeRef.current = shake
    syncPulseRef.current = syncPulse
    wake(1.0)
    syncPulse()

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
      syncPulse()
    })

    renderer.on('leaveNode', () => {
      hoveredRef.current = null
      renderer.refresh()
      syncPulse()
    })

    renderer.on('clickNode', ({ node }) => {
      onSelectNode(selectedRef.current === node ? null : node)
    })

    renderer.on('doubleClickNode', (event) => {
      event.preventSigmaDefault()
      const attrs = graph.getNodeAttributes(event.node)
      const hash = attrs.nodeKind === 'block' ? `#block-${encodeURIComponent(event.node)}` : ''
      void navigate(`/docs/${encodeDocId(attrs.docId)}${hash}`)
    })

    renderer.on('clickStage', () => {
      onSelectNode(null)
    })

    return () => {
      disposed = true
      killed = true
      container.removeEventListener('wheel', onWheel, { capture: true })
      container.removeEventListener('gesturestart', preventSafariGesture)
      container.removeEventListener('gesturechange', preventSafariGesture)
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (pulseRafId !== null) cancelAnimationFrame(pulseRafId)
      clearPulseCanvas()
      wakeRef.current = null
      shakeRef.current = null
      syncPulseRef.current = null
      renderer.kill()
      sigmaRef.current = null
    }
  }, [data, isDark, navigate, onSelectNode, t])

  useEffect(() => {
    sigmaRef.current?.refresh()
    syncPulseRef.current?.()
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
              className="w-full accent-accent"
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
              className="w-full accent-accent"
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
              className="w-full accent-accent"
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
              className="w-full accent-accent"
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
        <div className="relative min-h-[460px] w-full flex-1">
          <div
            ref={containerRef}
            className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--bg)_0%,var(--bg-sidebar)_100%)]"
          />
          <canvas
            ref={overlayCanvasRef}
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden="true"
          />
        </div>
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
