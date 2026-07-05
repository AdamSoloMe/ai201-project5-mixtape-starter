const fs = require('fs');
const path = require('path');

function main() {
  const [,, inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node ua-arch-analyze.js <input.json> <output.json>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const { fileNodes, importEdges, allEdges } = data;

  // A. Directory grouping
  const paths = fileNodes.map(n => n.filePath);
  function commonPrefix(strs) {
    if (!strs.length) return '';
    let prefix = strs[0].split('/').slice(0, -1);
    for (const s of strs.slice(1)) {
      const parts = s.split('/').slice(0, -1);
      let i = 0;
      while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
      prefix = prefix.slice(0, i);
    }
    return prefix.length ? prefix.join('/') + '/' : '';
  }
  const prefix = commonPrefix(paths);

  function groupOf(filePath) {
    let rel = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
    const parts = rel.split('/');
    if (parts.length > 1) {
      return parts[0];
    }
    // flat - group at root
    return 'root';
  }

  const directoryGroups = {};
  const idToGroup = {};
  for (const n of fileNodes) {
    const g = groupOf(n.filePath);
    idToGroup[n.id] = g;
    if (!directoryGroups[g]) directoryGroups[g] = [];
    directoryGroups[g].push(n.id);
  }

  // B. Node type grouping
  const nodeTypeGroups = {};
  for (const n of fileNodes) {
    if (!nodeTypeGroups[n.type]) nodeTypeGroups[n.type] = [];
    nodeTypeGroups[n.type].push(n.id);
  }

  // C. Import adjacency + fan in/out
  const fileFanIn = {};
  const fileFanOut = {};
  for (const n of fileNodes) { fileFanIn[n.id] = 0; fileFanOut[n.id] = 0; }
  for (const e of importEdges) {
    if (fileFanOut[e.source] !== undefined) fileFanOut[e.source]++;
    if (fileFanIn[e.target] !== undefined) fileFanIn[e.target]++;
  }

  // D. Cross-category dependency analysis
  const idToNode = {};
  for (const n of fileNodes) idToNode[n.id] = n;
  const crossCategoryMap = {};
  for (const e of allEdges) {
    const srcNode = idToNode[e.source];
    const tgtNode = idToNode[e.target];
    if (!srcNode || !tgtNode) continue;
    if (srcNode.type === tgtNode.type) continue;
    const key = `${srcNode.type}|${tgtNode.type}|${e.type}`;
    crossCategoryMap[key] = (crossCategoryMap[key] || 0) + 1;
  }
  const crossCategoryEdges = Object.entries(crossCategoryMap).map(([k, count]) => {
    const [fromType, toType, edgeType] = k.split('|');
    return { fromType, toType, edgeType, count };
  });

  // E. Inter-group import frequency
  const interGroupMap = {};
  for (const e of importEdges) {
    const g1 = idToGroup[e.source];
    const g2 = idToGroup[e.target];
    if (!g1 || !g2 || g1 === g2) continue;
    const key = `${g1}|${g2}`;
    interGroupMap[key] = (interGroupMap[key] || 0) + 1;
  }
  const interGroupImports = Object.entries(interGroupMap).map(([k, count]) => {
    const [from, to] = k.split('|');
    return { from, to, count };
  });

  // F. Intra-group density
  const intraGroupDensity = {};
  for (const g of Object.keys(directoryGroups)) {
    let internal = 0, total = 0;
    for (const e of importEdges) {
      const g1 = idToGroup[e.source];
      const g2 = idToGroup[e.target];
      if (g1 === g || g2 === g) {
        total++;
        if (g1 === g && g2 === g) internal++;
      }
    }
    intraGroupDensity[g] = { internalEdges: internal, totalEdges: total, density: total ? +(internal/total).toFixed(2) : 0 };
  }

  // G. Directory pattern matching
  const dirPatterns = {
    api: ['routes','api','controllers','endpoints','handlers','serializers','routers','blueprints'],
    service: ['services','core','lib','domain','logic','signals','composables','mailers','jobs','channels','internal'],
    data: ['models','db','data','persistence','repository','entities','migrations','entity','sql','database','schema'],
    ui: ['components','views','pages','ui','layouts','screens'],
    middleware: ['middleware','plugins','interceptors','guards'],
    utility: ['utils','helpers','common','shared','tools','templatetags','pkg'],
    config: ['config','constants','env','settings','management','commands'],
    test: ['__tests__','test','tests','spec','specs'],
    types: ['types','interfaces','schemas','contracts','dtos','dto','request','response'],
    hooks: ['hooks'],
    state: ['store','state','reducers','actions','slices'],
    assets: ['assets','static','public'],
    entry: ['cmd','bin'],
    documentation: ['docs','documentation','wiki'],
    infrastructure: ['deploy','deployment','infra','infrastructure','k8s','kubernetes','helm','charts','terraform','tf','docker'],
    'ci-cd': ['.github','.gitlab','.circleci'],
    root: []
  };
  const patternMatches = {};
  for (const g of Object.keys(directoryGroups)) {
    let matched = null;
    for (const [label, names] of Object.entries(dirPatterns)) {
      if (names.includes(g)) { matched = label; break; }
    }
    if (g === 'root') matched = 'root';
    patternMatches[g] = matched || 'unknown';
  }

  // H. Deployment topology detection
  const infraFiles = [];
  let hasDockerfile = false, hasCompose = false, hasK8s = false, hasTerraform = false, hasCI = false;
  for (const n of fileNodes) {
    const fp = n.filePath;
    const base = path.basename(fp);
    if (/^Dockerfile/.test(base)) { hasDockerfile = true; infraFiles.push(fp); }
    if (/docker-compose/.test(base)) { hasCompose = true; infraFiles.push(fp); }
    if (/\.ya?ml$/.test(base) && /k8s|kubernetes/i.test(fp)) { hasK8s = true; infraFiles.push(fp); }
    if (/\.tf$|\.tfvars$/.test(base)) { hasTerraform = true; infraFiles.push(fp); }
    if (/^\.github\/workflows\//.test(fp) || base === '.gitlab-ci.yml' || base === 'Jenkinsfile') { hasCI = true; infraFiles.push(fp); }
  }

  // I. Data pipeline detection
  const schemaFiles = [];
  const migrationFiles = [];
  const dataModelFiles = [];
  const apiHandlerFiles = [];
  for (const n of fileNodes) {
    const fp = n.filePath;
    if (/\.sql$|\.graphql$|\.gql$|\.proto$/.test(fp) || /schema/i.test(fp)) schemaFiles.push(fp);
    if (/migrations\//.test(fp)) migrationFiles.push(fp);
    if (patternMatches[idToGroup[n.id]] === 'data') dataModelFiles.push(fp);
    if (patternMatches[idToGroup[n.id]] === 'api') apiHandlerFiles.push(fp);
  }

  // J. Documentation coverage
  const docFiles = fileNodes.filter(n => n.type === 'document').map(n => n.filePath);
  let groupsWithDocs = 0;
  const undocumentedGroups = [];
  for (const g of Object.keys(directoryGroups)) {
    const hasDoc = docFiles.some(d => d.toLowerCase().includes(g.toLowerCase()) || d === 'README.md');
    if (hasDoc) groupsWithDocs++;
    else undocumentedGroups.push(g);
  }
  const totalGroups = Object.keys(directoryGroups).length;

  // K. Dependency direction
  const dependencyDirection = [];
  const seenPairs = new Set();
  for (const { from, to, count } of interGroupImports) {
    const pairKey = [from, to].sort().join('|');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const reverse = interGroupImports.find(x => x.from === to && x.to === from);
    const reverseCount = reverse ? reverse.count : 0;
    if (count > reverseCount) dependencyDirection.push({ dependent: from, dependsOn: to });
    else if (reverseCount > count) dependencyDirection.push({ dependent: to, dependsOn: from });
  }

  // fileStats
  const filesPerGroup = {};
  for (const [g, ids] of Object.entries(directoryGroups)) filesPerGroup[g] = ids.length;
  const nodeTypeCounts = {};
  for (const [t, ids] of Object.entries(nodeTypeGroups)) nodeTypeCounts[t] = ids.length;

  const result = {
    scriptCompleted: true,
    directoryGroups,
    nodeTypeGroups,
    crossCategoryEdges,
    interGroupImports,
    intraGroupDensity,
    patternMatches,
    deploymentTopology: { hasDockerfile, hasCompose, hasK8s, hasTerraform, hasCI, infraFiles },
    dataPipeline: { schemaFiles, migrationFiles, dataModelFiles, apiHandlerFiles },
    docCoverage: {
      groupsWithDocs,
      totalGroups,
      coverageRatio: totalGroups ? +(groupsWithDocs/totalGroups).toFixed(2) : 0,
      undocumentedGroups
    },
    dependencyDirection,
    fileStats: {
      totalFileNodes: fileNodes.length,
      filesPerGroup,
      nodeTypeCounts
    },
    fileFanIn,
    fileFanOut
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log('Analysis complete. Written to', outputPath);
}

try {
  main();
} catch (err) {
  console.error('Fatal error:', err.stack || err);
  process.exit(1);
}
