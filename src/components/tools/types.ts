// Tipos de API-R1/R2 usados por las herramientas (locales a tools/).
import type { DiffFile } from "../../types/git";

export type { DiffFile };

export interface ToolProps { onClose?: () => void }

export interface RemoteInfo { name: string; fetchUrl: string; pushUrl: string }
export interface InitTemplates { gitignore: string[]; licenses: string[] }
export interface GitProgress { repoPath?: string; op: string; percent: number; message: string }
export interface ConfigEntry { key: string; local: string | null; effective: string | null }
export interface ActivityEntry {
  id: number; timestampMs: number; repo: string; kind: "read" | "write";
  command: string; ok: boolean; durationMs: number; error: string | null;
}
export interface ReflogEntry { sha: string; selector: string; action: string; message: string; date: string }
export interface BisectStatus {
  active: boolean; current?: string | null; remaining?: number | null; log: string[]; firstBad?: string | null; message: string;
}
export interface Submodule {
  name: string; path: string; url: string; branch?: string | null; sha: string;
  status: "ok" | "uninitialized" | "modified" | "conflict";
}
export interface Worktree {
  path: string; branch?: string | null; sha: string; locked: boolean; lockReason?: string | null;
  prunable: boolean; isMain: boolean; detached: boolean;
}
export interface LfsStatus {
  installed: boolean; version: string | null;
  patterns: { pattern: string; source: string }[];
  files: { path: string; oid: string; downloaded: boolean }[];
}
export interface LfsLock { id: string; path: string; owner: string; lockedAt: string }
export interface FlowConfig {
  initialized: boolean; master: string; develop: string; feature: string; release: string; hotfix: string;
  support: string; versionTag: string;
}
export type FlowKind = "feature" | "release" | "hotfix" | "support";
export interface FlowStatus {
  initialized: boolean; config: FlowConfig; feature: string[]; release: string[]; hotfix: string[]; support: string[];
  current?: { kind: FlowKind; name: string } | null;
}
export interface HookInfo { name: string; exists: boolean; active: boolean; isSample: boolean; disabled: boolean }
export interface HookTemplate { name: string; title: string; description: string; content: string }
