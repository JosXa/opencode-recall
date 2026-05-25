import { rmSync } from 'node:fs'

import { HistoryDatabase } from '../src/db'
import { OllamaEmbeddingProvider } from '../src/embedding'
import { rankSearchRows } from '../src/search'
import { RecallSidecarIndex } from '../src/sidecar'

type RealHistoryCaseKind = 'known-hard-paraphrase' | 'must-top-1' | 'must-top-3'

interface RealHistoryCase {
  readonly name: string
  readonly query: string
  readonly expectedSessionId: string
  readonly kind: RealHistoryCaseKind
  readonly maxRank: number
  readonly maxFalsePositivesBeforeHit: number
}

const CASES: readonly RealHistoryCase[] = [
  {
    name: 'Figma title retrieval from original query',
    query: 'figma mcp',
    expectedSessionId: 'ses_1ea07e649ffe8rG0kUBk4oJQC8',
    kind: 'must-top-3',
    maxRank: 3,
    maxFalsePositivesBeforeHit: 2,
  },
  {
    name: 'Figma Azure API Center registry wording',
    query: 'azure mcp registry figma',
    expectedSessionId: 'ses_1ea07e649ffe8rG0kUBk4oJQC8',
    kind: 'must-top-3',
    maxRank: 3,
    maxFalsePositivesBeforeHit: 2,
  },
  {
    name: 'Figma API Center title phrase',
    query: 'figma azure api center',
    expectedSessionId: 'ses_1ea07e649ffe8rG0kUBk4oJQC8',
    kind: 'must-top-3',
    maxRank: 2,
    maxFalsePositivesBeforeHit: 1,
  },
  {
    name: 'Executor MCP crash is distinct from Figma',
    query: 'executor mcp unavailable crash investigation',
    expectedSessionId: 'ses_1e3f564a4ffehZjhypED2AiJWP',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'OpenCode recall semantic history session',
    query: 'history_search opencode recall semantic ollama',
    expectedSessionId: 'ses_1e67d9990ffetS3quA8GM8FtA2',
    kind: 'must-top-3',
    maxRank: 3,
    maxFalsePositivesBeforeHit: 2,
  },
  {
    name: 'Confluence admin spaces natural wording',
    query: 'which confluence spaces am I admin in',
    expectedSessionId: 'ses_1b083fceeffePsPC6T0K5qwuPu',
    kind: 'known-hard-paraphrase',
    maxRank: 5,
    maxFalsePositivesBeforeHit: 4,
  },
  {
    name: 'AICREW contenteditable task title',
    query: 'AICREW-89 contenteditable questions',
    expectedSessionId: 'ses_1b0abb56bffeeCGKORS30emSLW',
    kind: 'known-hard-paraphrase',
    maxRank: 5,
    maxFalsePositivesBeforeHit: 4,
  },
  {
    name: 'German document image translation',
    query: 'translate German document image to English',
    expectedSessionId: 'ses_1b0d391f1ffemK07e3R52zEWjn',
    kind: 'known-hard-paraphrase',
    maxRank: 5,
    maxFalsePositivesBeforeHit: 4,
  },
  {
    name: 'Ad paranoia psychology paraphrase',
    query: 'phone microphone spying ads psychology effect',
    expectedSessionId: 'ses_1b4edec2effemoWfcI1soaIxIz',
    kind: 'known-hard-paraphrase',
    maxRank: 5,
    maxFalsePositivesBeforeHit: 4,
  },
  {
    name: 'Ground Zero AI meeting scheduling',
    query: 'schedule teams meeting Ground Zero AI members',
    expectedSessionId: 'ses_1b5284a9effemZ64qRqK4ySsS3',
    kind: 'known-hard-paraphrase',
    maxRank: 5,
    maxFalsePositivesBeforeHit: 4,
  },
  {
    name: 'ICE Zugbindung rare German token',
    query: 'zugbindung',
    expectedSessionId: 'ses_1fbe12286ffe2rE3kLl2aUKtuR',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'Dell monitor wake issue',
    query: 'monitor came back',
    expectedSessionId: 'ses_1f31807dfffe86817RtAM6jxph',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'VSCode key repeat',
    query: 'key repeat',
    expectedSessionId: 'ses_1b6603c8effeHJrsLvdXOwotbZ',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'KPI upload stopped',
    query: 'kpi upload stopped',
    expectedSessionId: 'ses_22689a804ffe1LHHLTtKP46c0O',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'AI Hub costs paraphrase',
    query: 'costs few cents',
    expectedSessionId: 'ses_1b3f719b5ffeupZr9YRhGD4oml',
    kind: 'known-hard-paraphrase',
    maxRank: 5,
    maxFalsePositivesBeforeHit: 4,
  },
  {
    name: 'Ruzanna queue migration distinctive query',
    query: 'Ruzanna queue migration function app old queue race condition',
    expectedSessionId: 'ses_1bf5c0887ffegfWQsHfYNXOk0q',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'SharePoint shared XLSX programmatic access',
    query: 'SharePoint shared xlsx programmatically without browser Graph access',
    expectedSessionId: 'ses_1b5d4a332ffeLedXM5hG1TrtIC',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'Plugin logs followup queue keybind',
    query: 'followup queue alt return keybind create undefined',
    expectedSessionId: 'ses_1df0e4455ffeu1lUWS6BW9Zcrq',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'image_generation SSE timeout',
    query: 'image_generation no timeout SSE chatgpt backend codex responses',
    expectedSessionId: 'ses_1fd3561e1ffew8tV28hCsoSafl',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'Karabiner German keyboard backslash',
    query: 'Karabiner Caps Lock ß backslash Option Shift 7',
    expectedSessionId: 'ses_2212b07fbffek9h6UnD6JH89UO',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'GitLab SSH key setup',
    query: 'add ssh key gitlab public key id_ed25519 fingerprint',
    expectedSessionId: 'ses_225d62ad9ffeinLJSCdy04G0ot',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'MR 83 rebase conflict',
    query: 'rebase merge request 83 feat citation sentence highlight documentMethods conflict',
    expectedSessionId: 'ses_207669cddffebgTuNpGTMJ0GEL',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'Copilot Premium org policy notification plugin',
    query: 'Copilot Premium Usage blocked organization policy notification plugin',
    expectedSessionId: 'ses_2316838fdffeZQkTqILklQsoUB',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'LEAGUES project ports status',
    query: 'LEAGUES localhost 5174 6000 8088 Streaming Cutter API project status',
    expectedSessionId: 'ses_21f8bc866ffeD0clxoLPAczPeu',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
  {
    name: 'Progressive disclosure AGENTS docs',
    query: 'progressive disclosure AGENTS.md references context gate root-to-leaf',
    expectedSessionId: 'ses_1e3800833ffeudY8duZJ80r63U',
    kind: 'must-top-1',
    maxRank: 1,
    maxFalsePositivesBeforeHit: 0,
  },
]

const db = new HistoryDatabase()
const indexPath = '/tmp/opencode-recall-real-history-eval.db'
removeSqliteFiles(indexPath)
const sidecar = new RecallSidecarIndex(indexPath)
const lexicalOnly = process.argv.includes('--lexical-only')
const progress = process.argv.includes('--progress')

try {
  const provider = lexicalOnly ? undefined : new OllamaEmbeddingProvider()
  if (progress) {
    console.error(`mode=${lexicalOnly ? 'lexical-only' : 'semantic'} cases=${CASES.length}`)
  }
  const sync =
    provider === undefined
      ? { elapsedMs: 0, indexedRows: 0, deletedRows: 0, lockAcquired: false }
      : await sidecar.sync(
          (since) => db.readTextPartsForIndex(since),
          provider,
          () => db.readTextPartIds(),
          progress
            ? {
                onProgress: ({ processedRows, totalRows, indexedRows }) => {
                  if (processedRows === totalRows || processedRows % 400 === 0) {
                    console.error(`sync progress ${processedRows}/${totalRows} indexed=${indexedRows}`)
                  }
                },
              }
            : {},
        )
  if (progress) {
    console.error(
      `sync indexed=${sync.indexedRows} deleted=${sync.deletedRows} seconds=${(sync.elapsedMs / 1000).toFixed(2)}`,
    )
  }
  const results = []

  for (const [index, testCase] of CASES.entries()) {
    if (progress) {
      console.error(`case ${index + 1}/${CASES.length}: ${testCase.name}`)
    }
    const options = { limit: 8, before: Date.now() - 30_000 }
    const semanticRows = provider === undefined ? [] : await sidecar.search(testCase.query, options, provider)
    const rows = rankSearchRows(
      testCase.query,
      [...db.lexicalSearch(testCase.query, options), ...semanticRows],
      options.limit,
    )
    const rank = rows.findIndex((row) => row.sessionId === testCase.expectedSessionId) + 1
    const falsePositivesBeforeHit = rank === 0 ? rows.length : rank - 1
    const passed =
      rank > 0 &&
      rank <= testCase.maxRank &&
      falsePositivesBeforeHit <= testCase.maxFalsePositivesBeforeHit
    results.push({
      ...testCase,
      passed,
      rank,
      falsePositivesBeforeHit,
      topHits: rows.slice(0, 5).map((row, index) => ({
        rank: index + 1,
        sid: row.sessionId,
        title: row.sessionTitle,
        score: row.score,
        text: row.text.replaceAll(/\s+/gu, ' ').slice(0, 180),
      })),
    })
  }

  const passed = results.every((result) => result.passed)
  console.log(JSON.stringify({ sync, passed, results }, null, 2))

  if (!passed) {
    process.exitCode = 1
  }
} finally {
  sidecar.close()
  db.close()
}

function removeSqliteFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true })
  }
}
