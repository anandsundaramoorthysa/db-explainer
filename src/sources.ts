import * as path from 'path';
import { Connector } from './db/connector';
import { openConnector } from './db/open';
import { importSql } from './importer/sqlText';
import { Source } from './chat/conversation';
import { ConnectionProfile } from './types';

export interface SourceInfo {
  id: string;
  label: string;
  kind: 'live' | 'sql';
  engine: string;
  summary: string;
  warnings: string[];
}

type Listener = () => void;

/** Everything the developer has shared in this window: live connections and pasted or dropped SQL. */
export class SourceManager {
  private readonly sources = new Map<string, Source & { kind: 'live' | 'sql'; profile?: ConnectionProfile }>();
  private listeners: Listener[] = [];
  activeId: string | undefined;

  constructor(private readonly assetsDir: string) {}

  onDidChange(l: Listener): void {
    this.listeners.push(l);
  }

  private fire(): void {
    this.listeners.forEach((l) => l());
  }

  list(): Array<Source & { kind: 'live' | 'sql'; profile?: ConnectionProfile }> {
    return [...this.sources.values()];
  }

  get(id: string | undefined): (Source & { kind: 'live' | 'sql' }) | undefined {
    return id ? this.sources.get(id) : undefined;
  }

  active(): (Source & { kind: 'live' | 'sql' }) | undefined {
    return this.get(this.activeId) ?? this.list()[0];
  }

  isConnected(profileId: string): boolean {
    return this.sources.has(profileId);
  }

  setActive(id: string): void {
    if (this.sources.has(id)) {
      this.activeId = id;
      this.fire();
    }
  }

  /** Connects, reads the structure and keeps the connection for questions and queries. Throws a readable error on failure. */
  async connect(profile: ConnectionProfile, password: string | undefined): Promise<Source> {
    await this.disconnect(profile.id);
    const connector: Connector = openConnector(profile, password, { assetsDir: this.assetsDir });
    try {
      const model = await connector.introspect();
      const source = { id: profile.id, label: profile.name, model, connector, kind: 'live' as const, profile };
      this.sources.set(profile.id, source);
      this.activeId = profile.id;
      this.fire();
      return source;
    } catch (e) {
      await connector.close();
      throw e;
    }
  }

  async refresh(id: string): Promise<void> {
    const s = this.sources.get(id);
    if (s?.connector) {
      s.model = await s.connector.introspect();
      this.fire();
    }
  }

  async disconnect(id: string): Promise<void> {
    const s = this.sources.get(id);
    if (!s) return;
    this.sources.delete(id);
    await s.connector?.close();
    if (this.activeId === id) this.activeId = this.list()[0]?.id;
    this.fire();
  }

  /** Builds a model from SQL text. Statements it cannot read are kept for the AI to see as raw text. */
  addSharedSql(label: string, text: string): { source: Source; queries: string[]; skipped: number } {
    const base = path.basename(label);
    const result = importSql(text, base);
    let id = `sql:${base}`;
    for (let n = 2; this.sources.has(id); n += 1) id = `sql:${base} (${n})`;
    const source = { id, label: base, model: result.model, sharedSql: text, kind: 'sql' as const };
    this.sources.set(id, source);
    this.activeId = id;
    this.fire();
    return { source, queries: result.queries, skipped: result.skipped.length };
  }

  info(): SourceInfo[] {
    return this.list().map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      engine: s.model.engine,
      summary: `${s.model.tables.filter((t) => t.kind === 'table').length} tables, ${s.model.tables.filter((t) => t.kind === 'view').length} views`,
      warnings: s.model.warnings,
    }));
  }

  async disposeAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.connector?.close()));
    this.sources.clear();
  }
}
