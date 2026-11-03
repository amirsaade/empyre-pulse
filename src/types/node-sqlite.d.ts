/** Node 22 built-in. `@types/node` in this repo does not ship these yet. */
declare module "node:sqlite" {
  export type SqlValue = string | number | bigint | null | Uint8Array;

  export class StatementSync {
    run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
