import SQLite from 'better-sqlite3'

export type SqliteBindValue = string | number | bigint | null | Buffer | Uint8Array
export type SqliteBindParams = readonly SqliteBindValue[]

export class Database {
  readonly #db: SQLite.Database

  public constructor(path: string, options: { readonly?: boolean } = {}) {
    this.#db = new SQLite(path, { readonly: options.readonly === true })
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
    const transaction = this.#db.transaction(callback)
    return () => {
      transaction()
    }
  }
}

class Statement<TResult, TParams extends SqliteBindParams> {
  readonly #statement: SQLite.Statement

  public constructor(statement: SQLite.Statement) {
    this.#statement = statement
  }

  public all(...params: TParams): TResult[] {
    return this.#statement.all(...params) as TResult[]
  }

  public get(...params: TParams): TResult | null {
    return (this.#statement.get(...params) as TResult | undefined) ?? null
  }

  public run(...params: TParams): SQLite.RunResult {
    return this.#statement.run(...params)
  }
}
