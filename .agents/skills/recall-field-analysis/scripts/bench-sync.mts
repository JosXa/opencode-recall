// Usage: pnpm exec tsx bench-sync.mts <history.db> <index-copy.db> [rounds]
// Writes to the index, so pass a copy.
import { HistoryDatabase } from '../../../../src/db.js'
import { OllamaEmbeddingProvider } from '../../../../src/embedding.js'
import { RecallSidecarIndex } from '../../../../src/sidecar.js'

const [historyPath, indexPath, rounds = '3'] = process.argv.slice(2)
if (historyPath === undefined || indexPath === undefined) {
  throw new Error('usage: bench-sync.mts <history.db> <index-copy.db> [rounds]')
}
const history = new HistoryDatabase(historyPath)
const index = new RecallSidecarIndex(indexPath)
const provider = new OllamaEmbeddingProvider()
for (let round = 0; round < Number(rounds); round += 1) {
  const semantic = await index.syncHistory(history, provider)
  const lexical = index.syncLexicalHistory(history)
  console.log(
    JSON.stringify({
      round,
      semanticMs: Math.round(semantic.elapsedMs),
      semanticRows: semantic.indexedRows,
      semanticDeleted: semantic.deletedRows,
      lexicalMs: Math.round(lexical.elapsedMs),
      lexicalRows: lexical.indexedRows,
      lexicalDeleted: lexical.deletedRows,
    }),
  )
}
index.close()
history.close()
