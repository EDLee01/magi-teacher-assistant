import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

import BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);

export type SqliteValue = null | number | bigint | string | Uint8Array;

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: SqliteValue[]): SqliteRunResult;
  get(...params: SqliteValue[]): unknown;
  all(...params: SqliteValue[]): unknown[];
  iterate(...params: SqliteValue[]): IterableIterator<unknown>;
}

export interface SqliteDatabase {
  prepare(source: string): SqliteStatement;
  exec(source: string): unknown;
  pragma(source: string): unknown;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): unknown;
}

export function openSqliteDatabase(filename: string): SqliteDatabase {
  if (process.env.MAGI_SQLITE_DRIVER === "builtin") {
    return new BuiltinSqliteDatabase(filename);
  }
  return new BetterSqlite3(filename) as unknown as SqliteDatabase;
}

class BuiltinSqliteDatabase implements SqliteDatabase {
  private readonly database: DatabaseSync;
  private savepointId = 0;

  constructor(filename: string) {
    const { DatabaseSync: BuiltinDatabase } =
      require("node:sqlite") as typeof import("node:sqlite");
    this.database = new BuiltinDatabase(filename);
  }

  prepare(source: string): SqliteStatement {
    return this.database.prepare(source) as unknown as SqliteStatement;
  }

  exec(source: string): void {
    this.database.exec(source);
  }

  pragma(source: string): unknown[] {
    return this.database.prepare(`pragma ${source}`).all();
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    return ((...args: Parameters<F>): ReturnType<F> => {
      const nested = this.database.isTransaction;
      const savepoint = `magi_nested_${this.savepointId++}`;
      this.database.exec(nested ? `savepoint ${savepoint}` : "begin");
      try {
        const result = fn(...args) as ReturnType<F>;
        this.database.exec(nested ? `release ${savepoint}` : "commit");
        return result;
      } catch (error) {
        if (nested) {
          this.database.exec(`rollback to ${savepoint}`);
          this.database.exec(`release ${savepoint}`);
        } else {
          this.database.exec("rollback");
        }
        throw error;
      }
    }) as F;
  }

  close(): void {
    this.database.close();
  }
}
