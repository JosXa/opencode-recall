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

  public transaction(callback: () => void): () => void {
    return () => {
      this.#db.exec('begin')
      try {
        callback()
        this.#db.exec('commit')
      } catch (error) {
        this.#db.exec('rollback')
        throw error
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
