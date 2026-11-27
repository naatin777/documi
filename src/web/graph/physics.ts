import { MultiDirectedGraph } from 'graphology'
import type { ArtifactType } from '../../core/types'
import type { GraphEdgeItem, GraphNodeItem, GraphResponse } from '../api'

export interface SigmaNodeAttrs {
  x: number
  y: number
  size: number
  label: string
  fullLabel: string
  shortLabel: string
  color: string
  nodeKind: 'doc' | 'block'
  artifactType: ArtifactType
  docId: string
}

export interface SigmaEdgeAttrs {
  size: number
  color: string
  label: string
  edgeKind: GraphEdgeItem['kind']
}

export interface ForceParams {
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
}

export const DEFAULT_FORCES: ForceParams = {
  centerForce: 0.05,
  repelForce: 210,
  linkForce: 0.065,
  linkDistance: 46,
}

export const TYPE_COLORS: Record<ArtifactType, string> = {
  goal: '#f59e0b',
  decision: '#f43f5e',
  domain: '#0ea5e9',
  spec: '#3b82f6',
  contract: '#22c55e',
  design: '#14b8a6',
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

export interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  mass: number
}

export interface SimEdge {
  sourceIdx: number
  targetIdx: number
  strength: number
  distance: number
}

function truncateLabel(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, maxChars - 1).join('')}…`
}

/** グラフデータから Graphology インスタンスと物理シミュレーション初期状態を構築する */
export function buildGraphAndSim(
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
    const size = n.kind === 'doc' ? 3.2 + Math.min(deg * 0.28, 1.8) : 2.2 + Math.min(deg * 0.2, 1.1)
    const shortLabel = truncateLabel(n.title, n.kind === 'doc' ? 16 : 22)

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
      label: shortLabel,
      fullLabel: n.title,
      shortLabel,
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
      size: e.kind === 'contains' ? 0.7 : e.kind === 'mentions' ? 0.9 : 1.2,
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
 * Force-Directed 物理エンジンを 1 フレーム進める (Coulomb 反発 + 中心引力 + Hooke ばね + 減衰)。
 * 総移動量 (totalMotion) を返す。
 */
export function stepForceSimulation(
  simNodes: SimNode[],
  simEdges: SimEdge[],
  graph: MultiDirectedGraph<SigmaNodeAttrs, SigmaEdgeAttrs>,
  params: ForceParams,
  alpha: number,
  worldRadius: number,
  draggedNodeId: string | null,
  simById: ReadonlyMap<string, SimNode>,
): number {
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
    a.vx -= a.x * params.centerForce * 0.045 * alpha
    a.vy -= a.y * params.centerForce * 0.045 * alpha

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
      const force = (params.repelForce / (distSq + 24)) * alpha
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
    const targetDist = params.linkDistance * edge.distance
    const displacement = dist - targetDist
    const force = displacement * params.linkForce * edge.strength * alpha
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

  return totalMotion
}
