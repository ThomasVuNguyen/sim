#!/usr/bin/env bun
/**
 * Heap Snapshot Analyzer
 * Analyzes a .heapsnapshot file and extracts memory usage by type
 * 
 * Usage: 
 *   bun scripts/analyze-heap.ts <file>                    # Overview
 *   bun scripts/analyze-heap.ts <file> --type string      # Drill into strings
 *   bun scripts/analyze-heap.ts <file> --type object      # Drill into objects
 *   bun scripts/analyze-heap.ts <file> --type array       # Drill into arrays
 *   bun scripts/analyze-heap.ts <file> --top 50           # Show top 50 items
 */

import { readFileSync, statSync } from 'fs'

const args = process.argv.slice(2)
const filepath = args.find(a => !a.startsWith('--'))
const typeFilter = args.includes('--type') ? args[args.indexOf('--type') + 1] : null
const topCount = args.includes('--top') ? parseInt(args[args.indexOf('--top') + 1]) || 50 : 30

if (!filepath) {
  console.error('Usage: bun scripts/analyze-heap.ts <path-to-heapsnapshot> [--type <type>] [--top <n>]')
  console.error('')
  console.error('Options:')
  console.error('  --type <type>  Filter by type: string, object, array, closure, code, etc.')
  console.error('  --top <n>      Show top N items (default: 30)')
  console.error('')
  console.error('Examples:')
  console.error('  bun scripts/analyze-heap.ts heap.heapsnapshot')
  console.error('  bun scripts/analyze-heap.ts heap.heapsnapshot --type string --top 100')
  process.exit(1)
}

interface CategoryStats {
  count: number
  selfSize: number
  maxSelfSize: number
  maxName: string
}

interface ItemWithRetainer {
  name: string
  size: number
  nodeIndex: number
  retainerName?: string
  retainerType?: string
}

async function analyzeHeap(filepath: string) {
  const fileStats = statSync(filepath)
  console.log(`\n📂 Analyzing: ${filepath}`)
  console.log(`📏 File size: ${formatBytes(fileStats.size)}\n`)
  console.log('⏳ Loading and parsing (this may take a minute for large files)...\n')

  const startTime = Date.now()

  // For files under 2GB, we can load directly
  // For larger files, we'd need streaming, but Bun/Node string limit is ~512MB-1GB
  let data: any
  try {
    const content = readFileSync(filepath, 'utf8')
    data = JSON.parse(content)
  } catch (err: any) {
    if (err.message?.includes('string longer than')) {
      console.error('❌ File too large to parse in memory.')
      console.error('   Try opening in Chrome DevTools instead.')
      process.exit(1)
    }
    throw err
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`✅ Loaded in ${elapsed}s`)

  // Extract metadata - handle different snapshot formats
  const { snapshot, nodes, strings } = data
  
  if (!snapshot) {
    console.error('❌ Invalid heap snapshot format: missing "snapshot" field')
    console.log('Top-level keys:', Object.keys(data))
    process.exit(1)
  }

  // Debug: show snapshot structure
  console.log(`📊 Snapshot keys: ${Object.keys(snapshot).join(', ')}`)
  
  const meta = snapshot.meta || snapshot
  const nodeFields = meta.node_fields as string[]
  
  if (!nodeFields) {
    console.error('❌ Invalid heap snapshot format: missing node_fields')
    console.log('Snapshot structure:', JSON.stringify(snapshot, null, 2).substring(0, 500))
    process.exit(1)
  }

  // node_types can be nested differently
  let nodeTypes: string[]
  if (meta.node_types) {
    nodeTypes = Array.isArray(meta.node_types[0]) ? meta.node_types[0] : meta.node_types
  } else {
    nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint']
  }

  const nodeFieldCount = nodeFields.length

  // Find field indices
  const typeIdx = nodeFields.indexOf('type')
  const nameIdx = nodeFields.indexOf('name')
  const selfSizeIdx = nodeFields.indexOf('self_size')

  console.log(`📊 Node fields: ${nodeFields.join(', ')}`)
  console.log(`📊 Node types: ${nodeTypes.slice(0, 10).join(', ')}${nodeTypes.length > 10 ? '...' : ''}`)
  console.log(`📊 Field indices - type: ${typeIdx}, name: ${nameIdx}, self_size: ${selfSizeIdx}\n`)

  // Build retainer map from edges (what holds what)
  console.log('📊 Building retainer map...')
  const { edges } = data
  const edgeFields = meta.edge_fields as string[]
  const edgeFieldCount = edgeFields.length
  const edgeTypeIdx = edgeFields.indexOf('type')
  const edgeNameIdx = edgeFields.indexOf('name_or_index')
  const edgeToNodeIdx = edgeFields.indexOf('to_node')

  // Map from node index (in nodes array) to retainer info
  const retainerMap = new Map<number, { name: string; type: string }>()
  
  // First pass: collect node info for lookup
  const nodeInfo = new Map<number, { name: string; type: string }>()
  for (let i = 0; i < nodes.length; i += nodeFieldCount) {
    const typeId = nodes[i + typeIdx]
    const nameId = nodes[i + nameIdx]
    const typeName = nodeTypes[typeId] || 'unknown'
    const name = strings[nameId] || '(anonymous)'
    nodeInfo.set(i, { name, type: typeName })
  }

  // Second pass: build retainer map from edges
  let currentNodeIdx = 0
  let edgeIdx = 0
  for (let i = 0; i < nodes.length; i += nodeFieldCount) {
    const edgeCount = nodes[i + 4] || 0 // edge_count is usually at index 4
    const sourceInfo = nodeInfo.get(i)
    
    for (let e = 0; e < edgeCount && edgeIdx < edges.length; e++) {
      const toNodeIdx = edges[edgeIdx + edgeToNodeIdx]
      // Only track if we don't have a retainer yet, or this is a more interesting one
      if (sourceInfo && sourceInfo.type !== 'hidden' && sourceInfo.name !== '(GC roots)') {
        const existing = retainerMap.get(toNodeIdx)
        if (!existing || existing.type === 'hidden') {
          retainerMap.set(toNodeIdx, { name: sourceInfo.name, type: sourceInfo.type })
        }
      }
      edgeIdx += edgeFieldCount
    }
  }
  console.log(`📊 Retainer map built with ${retainerMap.size.toLocaleString()} entries\n`)

  // Aggregate by type
  const categories = new Map<string, CategoryStats>()
  const topByType = new Map<string, Array<ItemWithRetainer>>()

  let totalNodes = 0
  let totalSize = 0

  for (let i = 0; i < nodes.length; i += nodeFieldCount) {
    totalNodes++
    
    const typeId = nodes[i + typeIdx]
    const nameId = nodes[i + nameIdx]
    const selfSize = nodes[i + selfSizeIdx] || 0

    const typeName = nodeTypes[typeId] || 'unknown'
    const name = strings[nameId] || '(anonymous)'

    totalSize += selfSize

    // Update category stats
    if (!categories.has(typeName)) {
      categories.set(typeName, { count: 0, selfSize: 0, maxSelfSize: 0, maxName: '' })
    }
    const cat = categories.get(typeName)!
    cat.count++
    cat.selfSize += selfSize
    if (selfSize > cat.maxSelfSize) {
      cat.maxSelfSize = selfSize
      cat.maxName = name.substring(0, 60)
    }

    // Track top items per type
    const minSize = typeFilter ? 1024 : 100 * 1024 // Lower threshold when filtering
    if (selfSize > minSize) {
      if (!topByType.has(typeName)) {
        topByType.set(typeName, [])
      }
      const arr = topByType.get(typeName)!
      const retainer = retainerMap.get(i)
      arr.push({ 
        name, 
        size: selfSize, 
        nodeIndex: i,
        retainerName: retainer?.name,
        retainerType: retainer?.type,
      })
      // Keep buffer for sorting later
      if (arr.length > topCount * 3) {
        arr.sort((a, b) => b.size - a.size)
        arr.length = topCount * 2
      }
    }
  }

  // Sort and trim top items
  for (const [, arr] of topByType) {
    arr.sort((a, b) => b.size - a.size)
    arr.length = Math.min(arr.length, topCount)
  }

  // Print results
  console.log(`📈 Total nodes: ${totalNodes.toLocaleString()}`)
  console.log(`📈 Total size: ${formatBytes(totalSize)}\n`)

  if (typeFilter) {
    // Drill-down mode: show details for one type
    printTypeDetail(typeFilter, categories, topByType, topCount)
  } else {
    // Overview mode
    printCategories(categories, totalSize)
    printTopItems('string', 'TOP STRINGS (potential data leak)', topByType, 15)
    printTopItems('object', 'TOP OBJECTS', topByType, 15)
    printTopItems('array', 'TOP ARRAYS (potential accumulation)', topByType, 15)
    printTopItems('closure', 'TOP CLOSURES (potential callback leak)', topByType, 15)
    printDiagnosis(categories, totalSize)
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function printCategories(categories: Map<string, CategoryStats>, totalSize: number) {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('                    MEMORY BY TYPE')
  console.log('═══════════════════════════════════════════════════════════════')

  const sorted = Array.from(categories.entries())
    .sort((a, b) => b[1].selfSize - a[1].selfSize)

  console.log(`\n${'Type'.padEnd(20)} ${'Count'.padStart(12)} ${'Size'.padStart(12)} ${'%'.padStart(8)} ${'Max Item'.padStart(12)}`)
  console.log('─'.repeat(70))

  for (const [type, stats] of sorted) {
    if (stats.selfSize === 0) continue
    const pct = totalSize > 0 ? ((stats.selfSize / totalSize) * 100).toFixed(1) : '0'
    console.log(
      `${type.padEnd(20)} ${stats.count.toLocaleString().padStart(12)} ${formatBytes(stats.selfSize).padStart(12)} ${(pct + '%').padStart(8)} ${formatBytes(stats.maxSelfSize).padStart(12)}`
    )
  }

  console.log('─'.repeat(70))
  console.log(`${'TOTAL'.padEnd(20)} ${Array.from(categories.values()).reduce((s, v) => s + v.count, 0).toLocaleString().padStart(12)} ${formatBytes(totalSize).padStart(12)}`)
  console.log()
}

function printTopItems(type: string, title: string, topByType: Map<string, Array<ItemWithRetainer>>, limit: number) {
  const items = topByType.get(type)
  if (!items || items.length === 0) return

  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`                    ${title}`)
  console.log('═══════════════════════════════════════════════════════════════\n')

  for (let i = 0; i < Math.min(items.length, limit); i++) {
    const item = items[i]
    const preview = item.name.replace(/\n/g, '\\n').substring(0, 40)
    const retainer = item.retainerName ? ` ← ${item.retainerType}:${item.retainerName.substring(0, 25)}` : ''
    console.log(`${(i + 1).toString().padStart(3)}. ${formatBytes(item.size).padStart(10)}  ${preview}${retainer}`)
  }
  console.log()
}

function printTypeDetail(
  type: string,
  categories: Map<string, CategoryStats>,
  topByType: Map<string, Array<ItemWithRetainer>>,
  limit: number
) {
  const stats = categories.get(type)
  const items = topByType.get(type) || []

  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`                    DRILL-DOWN: ${type.toUpperCase()}`)
  console.log('═══════════════════════════════════════════════════════════════\n')

  if (stats) {
    console.log(`📊 Count: ${stats.count.toLocaleString()}`)
    console.log(`📊 Total size: ${formatBytes(stats.selfSize)}`)
    console.log(`📊 Max item: ${formatBytes(stats.maxSelfSize)} - "${stats.maxName}"`)
    console.log(`📊 Avg size: ${formatBytes(Math.round(stats.selfSize / stats.count))}`)
    console.log()
  }

  if (items.length === 0) {
    console.log('No large items found for this type.')
    console.log('Try lowering the size threshold or check if the type name is correct.')
    console.log()
    console.log('Available types:')
    for (const [t, s] of categories) {
      console.log(`  - ${t} (${s.count.toLocaleString()} items, ${formatBytes(s.selfSize)})`)
    }
    return
  }

  console.log(`Top ${Math.min(items.length, limit)} items:\n`)
  console.log(`${'#'.padStart(4)}  ${'Size'.padStart(10)}  ${'Name'.padEnd(35)}  Held by`)
  console.log('─'.repeat(100))

  for (let i = 0; i < Math.min(items.length, limit); i++) {
    const item = items[i]
    const preview = item.name
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '')
      .substring(0, 35)
      .padEnd(35)
    const retainer = item.retainerName 
      ? `${item.retainerType}:${item.retainerName.substring(0, 30)}`
      : '(root or unknown)'
    console.log(`${(i + 1).toString().padStart(4)}. ${formatBytes(item.size).padStart(10)}  ${preview}  ${retainer}`)
  }

  console.log()
  
  // Group by retainer to find patterns
  const retainerGroups = new Map<string, { count: number; totalSize: number }>()
  for (const item of items) {
    const key = item.retainerName ? `${item.retainerType}:${item.retainerName}` : '(unknown)'
    if (!retainerGroups.has(key)) {
      retainerGroups.set(key, { count: 0, totalSize: 0 })
    }
    const g = retainerGroups.get(key)!
    g.count++
    g.totalSize += item.size
  }

  const sortedRetainers = Array.from(retainerGroups.entries())
    .sort((a, b) => b[1].totalSize - a[1].totalSize)
    .slice(0, 10)

  if (sortedRetainers.length > 1) {
    console.log('📍 Top retainers (what\'s holding these):')
    for (const [name, data] of sortedRetainers) {
      console.log(`   ${data.count.toString().padStart(5)} items (${formatBytes(data.totalSize).padStart(10)}) held by: ${name.substring(0, 50)}`)
    }
    console.log()
  }

  console.log('💡 Tips:')
  if (type === 'string') {
    console.log('   - Look for repeated patterns (cached data, logs, JSON)')
    console.log('   - Module code strings are normal in dev mode')
  } else if (type === 'object') {
    console.log('   - Look for class names you recognize')
    console.log('   - "(anonymous)" often means plain objects from literals')
  } else if (type === 'array') {
    console.log('   - Large arrays might be growing unbounded')
    console.log('   - "(object elements)" is the internal backing store')
  } else if (type === 'closure') {
    console.log('   - High count = potential event listener leak')
    console.log('   - Each closure captures variables from outer scope')
  }
  console.log()
}

function printDiagnosis(categories: Map<string, CategoryStats>, totalSize: number) {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('                    DIAGNOSIS')
  console.log('═══════════════════════════════════════════════════════════════\n')

  const stringStats = categories.get('string')
  const objectStats = categories.get('object')
  const arrayStats = categories.get('array')
  const closureStats = categories.get('closure')
  const codeStats = categories.get('code')

  if (stringStats && stringStats.selfSize > totalSize * 0.4) {
    console.log(`⚠️  STRINGS are using ${((stringStats.selfSize / totalSize) * 100).toFixed(0)}% of memory (${formatBytes(stringStats.selfSize)})`)
    console.log('    → Look for: JSON responses cached, large log accumulation, template strings')
    console.log()
  }

  if (arrayStats && arrayStats.count > 100000) {
    console.log(`⚠️  HIGH ARRAY COUNT: ${arrayStats.count.toLocaleString()} (${formatBytes(arrayStats.selfSize)})`)
    console.log('    → Look for: unbounded arrays, event history, message queues')
    console.log()
  }

  if (closureStats && closureStats.count > 50000) {
    console.log(`⚠️  HIGH CLOSURE COUNT: ${closureStats.count.toLocaleString()} (${formatBytes(closureStats.selfSize)})`)
    console.log('    → Look for: event listeners not removed, callbacks not cleaned up')
    console.log()
  }

  if (objectStats && objectStats.count > 500000) {
    console.log(`⚠️  HIGH OBJECT COUNT: ${objectStats.count.toLocaleString()} (${formatBytes(objectStats.selfSize)})`)
    console.log('    → Look for: Maps/Sets growing unbounded, cached responses')
    console.log()
  }

  if (codeStats && codeStats.selfSize > 50 * 1024 * 1024) {
    console.log(`⚠️  COMPILED CODE is ${formatBytes(codeStats.selfSize)}`)
    console.log('    → Look for: dynamic code generation, eval(), vm.runInContext()')
    console.log()
  }

  console.log('💡 Common leak sources to check:')
  console.log('   - Module-level Map/Set/Array that grows forever')
  console.log('   - Event listeners added but never removed')
  console.log('   - Caches without TTL or size limits')
  console.log('   - Closures capturing large objects')
  console.log()
}

// Run
analyzeHeap(filepath).catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
