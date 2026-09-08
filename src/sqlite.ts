import { DatabaseSync, type StatementSync } from 'node:sqlite'

const BUSY_TIMEOUT_MS = 5000

export type SqliteBindValue = string | number | bigint | null | Buffer | Uint8Array
export type SqliteBindParams = readonly SqliteBindValue[]
export interface SqliteRunResult {
  readonly changes: number | bigint
  readonly lastInsertRowid: number | bigint
}

export class Database {
  readonly #db: DatabaseSync
  #transactionDepth = 0

  public constructor(path: string, options: { readonly?: boolean } = {}) {
    this.#db = new DatabaseSync(path, {
      readOnly: options.readonly === true,
      timeout: BUSY_TIMEOUT_MS,
    })
    this.#db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`)
  }

  public exec(sql: string): void {
    this.#db.exec(sql)
  }

  public function(name: string, callback: (type: string, data: string) => string): void {
    this.#db.function(name, { deterministic: true }, (type, data) =>
      callback(String(type), String(data)),
    )
  }

  public close(): void {
    this.#db.close()
  }

  public query<TResult, TParams extends SqliteBindParams = SqliteBindParams>(
    sql: string,
  ): Statement<TResult, TParams> {
    return new Statement(this.#db.prepare(sql))
  }

  public prepare<TResult, TParams extends SqliteBindParams = SqliteBindParams>(
    sql: string,
  ): Statement<TResult, TParams> {
    return this.query(sql)
  }

  public transaction<TResult>(callback: () => TResult, immediate = false): () => TResult {
    return () => {
      const depth = this.#transactionDepth
      const outermost = depth === 0
      const savepoint = `nested_transaction_${depth}`
      this.#db.exec(
        outermost ? (immediate ? 'begin immediate' : 'begin') : `savepoint ${savepoint}`,
      )
      this.#transactionDepth = depth + 1
      try {
        const result = callback()
        this.#db.exec(outermost ? 'commit' : `release savepoint ${savepoint}`)
        return result
      } catch (error) {
        if (outermost) {
          this.#db.exec('rollback')
        } else {
          this.#db.exec(`rollback to savepoint ${savepoint}`)
          this.#db.exec(`release savepoint ${savepoint}`)
        }
        throw error
      } finally {
        this.#transactionDepth = depth
      }
    }
  }
}

class Statement<TResult, TParams extends SqliteBindParams> {
  readonly #statement: StatementSync

  public constructor(statement: StatementSync) {
    this.#statement = statement
  }

  public all(...params: TParams): TResult[] {
    return this.#statement.all(...params) as TResult[]
  }

  public get(...params: TParams): TResult | null {
    return (this.#statement.get(...params) as TResult | undefined) ?? null
  }

  public run(...params: TParams): SqliteRunResult {
    return this.#statement.run(...params)
  }
}
