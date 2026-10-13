/**
 * Conversation history, in SQLite via node:sqlite.
 *
 * Uses Node's own built-in sqlite rather than better-sqlite3 so the relay has
 * no native build step — which matters a lot for the Docker image and for a
 * site admin running `npm install` on an arbitrary machine.
 */

import { createRequire } from "node:module";
import { CHAT_DB_PATH, CHAT_HISTORY_LIMIT } from "./config.ts";
import type { ChatMessage, ToolCall } from "./llm.ts";

/**
 * `node:sqlite` is resolved through `createRequire` rather than a static
 * import. It is a real builtin, but Node does not list it in
 * `module.builtinModules`, so Vite (and therefore Vitest) treats the static
 * import as a missing package and fails with "Failed to load url sqlite".
 * Going through `createRequire` keeps it out of the bundler's module graph
 * while behaving identically at runtime.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDb;
};

/** The slice of node:sqlite's API this module uses. */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}


export interface StoredMessage {
  id: number;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** JSON-encoded ToolCall[] for assistant turns that called tools. */
  toolCallsJson: string | null;
  toolCallId: string | null;
  toolName: string | null;
  createdAt: string;
}

let db: SqliteDb | null = null;
let dbPath: string = CHAT_DB_PATH;
let historyLimit: number = CHAT_HISTORY_LIMIT;

function open(): SqliteDb {
  if (db) return db;
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT    NOT NULL,
      role            TEXT    NOT NULL,
      content         TEXT    NOT NULL,
      tool_calls_json TEXT,
      tool_call_id    TEXT,
      tool_name       TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages (conversation_id, id);
  `);
  return db;
}

export function appendMessage(args: {
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}): void {
  open()
    .prepare(
      `INSERT INTO messages (conversation_id, role, content, tool_calls_json, tool_call_id, tool_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.conversationId,
      args.role,
      args.content,
      args.toolCalls && args.toolCalls.length > 0 ? JSON.stringify(args.toolCalls) : null,
      args.toolCallId ?? null,
      args.toolName ?? null,
    );
}

/**
 * Replay a conversation as LLM messages, newest `CHAT_HISTORY_LIMIT` kept.
 *
 * Truncation has to respect tool-call pairing: an assistant message with
 * `tool_calls` must be followed by its `tool` results, or providers reject
 * the request outright. So if the window would start on an orphaned tool
 * result, we drop forward to the next clean boundary rather than send
 * something malformed.
 */
export function loadHistory(conversationId: string): ChatMessage[] {
  const rows = open()
    .prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(conversationId, historyLimit) as unknown as Record<string, unknown>[];

  let start = 0;
  while (start < rows.length && rows[start]!.role === "tool") start++;

  const out: ChatMessage[] = [];
  for (const r of rows.slice(start)) {
    const role = r.role as StoredMessage["role"];
    const content = (r.content as string) ?? "";
    if (role === "user") {
      out.push({ role: "user", content });
    } else if (role === "assistant") {
      const toolCalls = r.tool_calls_json
        ? (JSON.parse(r.tool_calls_json as string) as ToolCall[])
        : undefined;
      out.push({ role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) });
    } else {
      out.push({
        role: "tool",
        toolCallId: (r.tool_call_id as string) ?? "",
        name: (r.tool_name as string) ?? "",
        content,
      });
    }
  }
  return out;
}

/** Messages for display: user and assistant turns only, tool noise dropped. */
export function loadTranscript(conversationId: string): { role: string; content: string; at: string }[] {
  const rows = open()
    .prepare(
      `SELECT role, content, created_at FROM messages
       WHERE conversation_id = ? AND role IN ('user','assistant') AND content <> ''
       ORDER BY id ASC`,
    )
    .all(conversationId) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    role: r.role as string,
    content: r.content as string,
    at: r.created_at as string,
  }));
}

export function listConversations(limit = 20): { id: string; lastAt: string; preview: string }[] {
  const rows = open()
    .prepare(
      `SELECT conversation_id AS id,
              MAX(created_at)  AS last_at,
              (SELECT content FROM messages m2
                WHERE m2.conversation_id = m1.conversation_id AND m2.role = 'user'
                ORDER BY m2.id ASC LIMIT 1) AS preview
         FROM messages m1
        GROUP BY conversation_id
        ORDER BY last_at DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    lastAt: r.last_at as string,
    preview: ((r.preview as string) ?? "").slice(0, 80),
  }));
}

export function deleteConversation(conversationId: string): void {
  open().prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
}

/**
 * Point the store at a different database, closing any current one. Exists for
 * tests, which want a fresh in-memory db per case; `CHAT_DB_PATH` is read once
 * at module load so an env var cannot do this after the fact.
 */
export function configureStore(opts: { path?: string; historyLimit?: number } = {}): void {
  db?.close();
  db = null;
  if (opts.path !== undefined) dbPath = opts.path;
  if (opts.historyLimit !== undefined) historyLimit = opts.historyLimit;
}
