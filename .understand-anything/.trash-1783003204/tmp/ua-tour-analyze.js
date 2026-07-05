#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function main() {
  const [,, inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node ua-tour-analyze.js <input.json> <output.json>');
    process.exit(1);
  }
  const raw = fs.readFileSync(inputPath, 'utf8');
  const data = JSON.parse(raw);
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const layers = data.layers || [];

  const nodeById = new Map(nodes.map(n => [n.id, n]));

  const fanIn = new Map();
  const fanOut = new Map();
  nodes.forEach(n => { fanIn.set(n.id, 0); fanOut.set(n.id, 0); });
  edges.forEach(e => {
    if (fanOut.has(e.source)) fanOut.set(e.source, fanOut.get(e.source) + 1);
    if (fanIn.has(e.target)) fanIn.set(e.target, fanIn.get(e.target) + 1);
  });

  const fanInRanking = nodes.map(n => ({ id: n.id, fanIn: fanIn.get(n.id) || 0, name: n.name }))
    .sort((a, b) => b.fanIn - a.fanIn).slice(0, 20);
  const fanOutRanking = nodes.map(n => ({ id: n.id, fanOut: fanOut.get(n.id) || 0, name: n.name }))
    .sort((a, b) => b.fanOut - a.fanOut).slice(0, 20);

  // Entry point candidates
  const entryFilenames = new Set(['index.ts','index.js','main.ts','main.js','app.ts','app.js','server.ts','server.js',
    'mod.rs','main.go','main.py','main.rs','manage.py','app.py','wsgi.py','asgi.py','run.py','__main__.py',
    'Application.java','Main.java','Program.cs','config.ru','index.php','App.swift','Application.kt','main.cpp','main.c']);

  const fanOutValues = nodes.map(n => fanOut.get(n.id) || 0).sort((a,b)=>a-b);
  const fanInValues = nodes.map(n => fanIn.get(n.id) || 0).sort((a,b)=>a-b);
  function percentileThreshold(arr, pct) {
    if (arr.length === 0) return 0;
    const idx = Math.floor(arr.length * pct);
    return arr[Math.min(idx, arr.length - 1)];
  }
  const fanOutTop10Threshold = percentileThreshold(fanOutValues, 0.90);
  const fanInBottom25Threshold = percentileThreshold(fanInValues, 0.25);

  const entryCandidates = [];
  nodes.forEach(n => {
    let score = 0;
    const depth = (n.filePath || '').split('/').length - 1;
    if (n.type === 'document') {
      const base = path.basename(n.filePath || n.name || '');
      if (base === 'README.md' && depth === 0) score += 5;
      else if (/\.md$/i.test(base) && depth === 0) score += 2;
    } else if (n.type === 'file') {
      const base = path.basename(n.filePath || n.name || '');
      if (entryFilenames.has(base)) score += 3;
      if (depth <= 1) score += 1;
      if ((fanOut.get(n.id) || 0) >= fanOutTop10Threshold && fanOutTop10Threshold > 0) score += 1;
      if ((fanIn.get(n.id) || 0) <= fanInBottom25Threshold) score += 1;
    }
    if (score > 0) entryCandidates.push({ id: n.id, score, name: n.name, summary: n.summary });
  });
  entryCandidates.sort((a, b) => b.score - a.score);
  const entryPointCandidates = entryCandidates.slice(0, 5);

  // BFS from top code entry point (skip document nodes)
  const topCodeEntry = entryCandidates.find(c => {
    const n = nodeById.get(c.id);
    return n && n.type !== 'document';
  });

  const adjacency = new Map();
  nodes.forEach(n => adjacency.set(n.id, []));
  edges.forEach(e => {
    if ((e.type === 'imports' || e.type === 'calls') && adjacency.has(e.source)) {
      adjacency.get(e.source).push(e.target);
    }
  });

  let bfsTraversal = { startNode: null, order: [], depthMap: {}, byDepth: {} };
  if (topCodeEntry) {
    const start = topCodeEntry.id;
    const visited = new Set([start]);
    const order = [start];
    const depthMap = { [start]: 0 };
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      const d = depthMap[cur];
      const neighbors = adjacency.get(cur) || [];
      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          depthMap[nb] = d + 1;
          order.push(nb);
          queue.push(nb);
        }
      }
    }
    const byDepth = {};
    Object.entries(depthMap).forEach(([id, d]) => {
      byDepth[d] = byDepth[d] || [];
      byDepth[d].push(id);
    });
    bfsTraversal = { startNode: start, order, depthMap, byDepth };
  }

  // Non-code file inventory
  const nonCodeFiles = { documentation: [], infrastructure: [], data: [], config: [] };
  nodes.forEach(n => {
    if (n.type === 'document') nonCodeFiles.documentation.push({ id: n.id, name: n.name, summary: n.summary });
    else if (['service', 'pipeline', 'resource'].includes(n.type)) nonCodeFiles.infrastructure.push({ id: n.id, name: n.name, type: n.type, summary: n.summary });
    else if (['table', 'schema', 'endpoint'].includes(n.type)) nonCodeFiles.data.push({ id: n.id, name: n.name, type: n.type, summary: n.summary });
    else if (n.type === 'config') nonCodeFiles.config.push({ id: n.id, name: n.name, summary: n.summary });
  });

  // Tightly coupled clusters
  const edgeSet = new Set(edges.map(e => `${e.source}=>${e.target}=>${e.type}`));
  function hasEdge(a, b, types) {
    return types.some(t => edgeSet.has(`${a}=>${b}=>${t}`));
  }
  const bidirPairs = [];
  const seenPairs = new Set();
  edges.forEach(e => {
    if (!['imports', 'calls'].includes(e.type)) return;
    const a = e.source, b = e.target;
    const key = [a, b].sort().join('||');
    if (seenPairs.has(key)) return;
    if (hasEdge(a, b, ['imports', 'calls']) && hasEdge(b, a, ['imports', 'calls'])) {
      bidirPairs.push([a, b]);
      seenPairs.add(key);
    }
  });

  function countEdgesBetween(nodeList) {
    let count = 0;
    const setL = new Set(nodeList);
    edges.forEach(e => {
      if (setL.has(e.source) && setL.has(e.target)) count++;
    });
    return count;
  }

  const clusters = [];
  const usedInCluster = new Set();
  bidirPairs.forEach(([a, b]) => {
    if (usedInCluster.has(a) || usedInCluster.has(b)) return;
    let clusterNodes = new Set([a, b]);
    let expanded = true;
    while (expanded && clusterNodes.size < 5) {
      expanded = false;
      for (const n of nodes) {
        if (clusterNodes.has(n.id)) continue;
        let connections = 0;
        edges.forEach(e => {
          if ((e.source === n.id && clusterNodes.has(e.target)) || (e.target === n.id && clusterNodes.has(e.source))) {
            connections++;
          }
        });
        if (connections >= 2) {
          clusterNodes.add(n.id);
          expanded = true;
          if (clusterNodes.size >= 5) break;
        }
      }
    }
    const nodeList = Array.from(clusterNodes);
    nodeList.forEach(n => usedInCluster.add(n));
    clusters.push({ nodes: nodeList, edgeCount: countEdgesBetween(nodeList) });
  });
  clusters.sort((a, b) => b.edgeCount - a.edgeCount);
  const topClusters = clusters.slice(0, 10);

  // Layers
  const layersOut = { count: layers.length, list: layers.map(l => ({ id: l.id, name: l.name, description: l.description })) };

  // Node summary index
  const nodeSummaryIndex = {};
  nodes.forEach(n => { nodeSummaryIndex[n.id] = { name: n.name, type: n.type, summary: n.summary }; });

  const result = {
    scriptCompleted: true,
    entryPointCandidates,
    fanInRanking,
    fanOutRanking,
    bfsTraversal,
    nonCodeFiles,
    clusters: topClusters,
    layers: layersOut,
    nodeSummaryIndex,
    totalNodes: nodes.length,
    totalEdges: edges.length
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('Fatal error:', err && err.stack ? err.stack : err);
  process.exit(1);
}
