// Espejo 1:1 de src-tauri/src/git/models.rs (camelCase)

export interface RepoInfo { id: string; path: string; name: string }

export interface FileChange {
  path: string;
  origPath: string | null;
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
}

export type RepoOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface RepoStatus {
  branch: string | null;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileChange[];
  operation: RepoOperation | null;
  detached: boolean;
  worktreeName: string | null;
}

export type RefKind = "local" | "remote" | "tag" | "head" | "stash";
export interface RefLabel { name: string; kind: RefKind }

export interface CommitNode {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerName: string;
  committerEmail: string;
  committerDate: number;
  subject: string;
  body: string;
  refs: RefLabel[];
}

export type SegmentKind = "pass" | "merge" | "branch" | "up" | "down";
export interface GraphSegment { fromCol: number; toCol: number; colorIdx: number; kind: SegmentKind }

export interface GraphRow {
  commit: CommitNode;
  column: number;
  colorIdx: number;
  lanes: GraphSegment[];
  isMerge: boolean;
  isWip: boolean;
  maxColumns: number;
}

export interface GraphPage { rows: GraphRow[]; nextCursor: number | null; total: number | null }

export interface BranchInfo {
  name: string;
  sha: string;
  isHead: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  isRemote: boolean;
  remote: string | null;
}

export interface TagInfo { name: string; sha: string; annotated: boolean; message: string | null }

export interface StashEntry { index: number; refName: string; message: string; branch: string; date: number }

export interface WordPart { text: string; changed: boolean }
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  content: string;
  oldNo: number | null;
  newNo: number | null;
  words?: WordPart[];
}
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

export interface ConflictRegion {
  startLine: number;
  endLine: number;
  oursLines: string[];
  theirsLines: string[];
  baseLines: string[];
}
export interface ConflictFile {
  path: string;
  ours: string;
  theirs: string;
  base: string | null;
  merged: string;
  regions: ConflictRegion[];
}

export interface BlameLine { sha: string; author: string; date: number; lineNo: number; content: string }

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";
export interface RebaseTodoItem { action: RebaseAction; sha: string; subject: string; newMessage: string | null }

export interface AppError { code: string; message: string }

// ---- Tipos de argumentos de comandos (sin repoPath: lo añade el store) ----
export type PullMode = "ff" | "rebase" | "merge";
export type ResetMode = "soft" | "mixed" | "hard";
export type HunkAction = "stage" | "unstage" | "discard";
export type LinesAction = "stage" | "unstage";

export interface FetchArgs { all: boolean; prune: boolean }
export interface PullArgs { mode: PullMode; autostash?: boolean }
export type ForceMode = "lease" | "force";
export interface PushArgs {
  force: boolean; setUpstream: boolean; noVerify?: boolean; tags?: boolean; followTags?: boolean; forceMode?: ForceMode;
}
export interface CheckoutArgs { target: string; create: boolean }
export interface CreateBranchArgs { name: string; startPoint: string | null; checkout: boolean }
export interface CreateTagArgs { name: string; target: string | null; message: string | null }
export interface ResetArgs { sha: string; mode: ResetMode }
export interface CommitArgs {
  summary: string; description: string; amend: boolean;
  signoff?: boolean; noVerify?: boolean; coAuthors?: string[]; gpgSign?: boolean;
}
export interface GetFileDiffArgs {
  path: string; staged: boolean; ignoreWhitespace: boolean; contextLines?: number; wordDiff?: boolean;
}
export interface ApplyHunkArgs {
  path: string; staged: boolean; hunkIndex: number; action: HunkAction; ignoreWhitespace: boolean;
}
export interface ApplyLinesArgs { path: string; hunkIndex: number; lineIndices: number[]; action: LinesAction }
export interface RebaseInteractiveArgs { baseSha: string; items: RebaseTodoItem[] }

export type MergeMode = "default" | "no-ff" | "ff-only" | "squash";
export interface MergeArgs { name: string; mode?: MergeMode }
export interface StashPushArgs {
  message?: string | null; untracked?: boolean; includeIgnored?: boolean; stagedOnly?: boolean; paths?: string[];
}
export type SearchScope = "all" | "message" | "author" | "sha" | "file" | "pickaxeS" | "pickaxeG";
export interface SearchArgs { query: string; scope?: SearchScope; since?: string; until?: string }
export interface GraphArgs {
  cursor: number; limit: number; hasWip: boolean;
  includeRefs?: string[]; excludeRefs?: string[]; author?: string; path?: string; grep?: string;
  since?: string; pickaxe?: string; pickaxeMode?: "S" | "G"; includeStashes?: boolean;
}

// ---- API R1 ----
export interface GitProgress { repoPath?: string; op: "clone"; percent: number; message: string }
export interface UndoState { undoLabel: string | null; redoLabel: string | null }
export interface CloneArgs { url: string; dest: string; depth?: number; recursive?: boolean; branch?: string }
export interface InitTemplates { gitignore: string[]; licenses: string[] }
export interface InitArgs { path: string; defaultBranch?: string; gitignoreTemplate?: string; license?: string }
export interface RemoteInfo { name: string; fetchUrl: string; pushUrl: string }
export interface SetRemoteUrlArgs { name: string; url: string; push?: boolean }
export interface PushBranchArgs { remote: string; local: string; remoteBranch: string; force: boolean }
export type IgnoreKind = "file" | "folder" | "extension";
export type IgnoreTarget = "gitignore" | "local";
export type ConflictSide = "ours" | "theirs";
export interface BlobData { base64: string; mime: string; size: number }
export interface ConfigEntry { key: string; local: string | null; effective: string | null }
export interface CommitTemplate { summary: string; description: string }
export interface AuthorInfo { name: string; email: string; count: number }
export type EditorId = "code" | "cursor" | "windsurf" | "zed" | "subl" | "idea" | "webstorm" | "pycharm";
export interface ActivityEntry {
  id: number; timestampMs: number; repo: string; kind: "read" | "write";
  command: string; ok: boolean; durationMs: number; error: string | null;
}

// ---- API R2 ----
export interface ReflogEntry { sha: string; selector: string; action: string; message: string; date: string }
export interface BisectStatus {
  active: boolean; current?: string; remaining?: number; log: string[]; firstBad?: string; message: string;
}
export type BisectMark = "good" | "bad" | "skip";
export type SubmoduleStatus = "ok" | "uninitialized" | "modified" | "conflict";
export interface Submodule { name: string; path: string; url: string; branch?: string; sha: string; status: SubmoduleStatus }
export interface Worktree {
  path: string; branch?: string; sha: string; locked: boolean; lockReason?: string;
  prunable: boolean; isMain: boolean; detached: boolean;
}
export interface LfsPattern { pattern: string; source: string }
export interface LfsFile { path: string; oid: string; downloaded: boolean }
export interface LfsStatus { installed: boolean; version: string | null; patterns: LfsPattern[]; files: LfsFile[] }
export interface LfsLock { id: string; path: string; owner: string; lockedAt: string }
export type FlowKind = "feature" | "release" | "hotfix" | "support";
export interface FlowConfig {
  initialized: boolean; master: string; develop: string; feature: string; release: string;
  hotfix: string; support: string; versionTag: string;
}
export interface FlowFinishOpts { keepBranch: boolean; squash: boolean; noFf: boolean; tag: boolean; tagMessage?: string; push: boolean }
export interface FlowStatus {
  initialized: boolean; config: FlowConfig; feature: string[]; release: string[]; hotfix: string[]; support: string[];
  current?: { kind: FlowKind; name: string };
}
export interface HookInfo { name: string; exists: boolean; active: boolean; isSample: boolean; disabled: boolean }
export interface HookTemplate { name: string; title: string; description: string; content: string }
export interface MoveCommitArgs { sha: string; direction: "up" | "down" }
export interface ConflictCheck { willConflict: boolean; files: string[]; truncated: boolean }
export interface ContributorStat { name: string; email: string; commits: number }
export interface RepoStats {
  commits: number; branches: number; remoteBranches: number; tags: number; contributors: ContributorStat[];
}

// ---- Selección y estado de UI compartido ----
export type Selection =
  | { kind: "wip" }
  | { kind: "commit"; sha: string }
  | { kind: "file"; path: string; staged: boolean; sha?: string }
  | null;

export type ModalState =
  | { kind: "diff"; path: string; staged: boolean; sha?: string }
  | { kind: "conflict"; path: string }
  | { kind: "blame"; path: string; rev?: string }
  | { kind: "rebase"; baseSha: string }
  | { kind: "clone" }
  | { kind: "init" }
  | { kind: "remotes" }
  | { kind: "reflog" }
  | { kind: "patch"; sha?: string }
  | { kind: "compare"; a: string; b: string }
  | { kind: "submodules" }
  | { kind: "worktrees" }
  | { kind: "lfs" }
  | { kind: "gitflow" }
  | { kind: "hooks" }
  | { kind: "activity" }
  | { kind: "shortcuts" }
  | { kind: "preferences" }
  | { kind: "repoSettings" }
  | { kind: "bisect" }
  | null;

export interface GraphFilter {
  includeRefs: string[];
  excludeRefs: string[];
  author: string;
  path: string;
  grep: string;
  since: string;
  pickaxe: string;
}

export type GraphColumnId = "ref" | "graph" | "message" | "author" | "date" | "sha";
export interface GraphColumn { id: GraphColumnId; visible: boolean; width: number }
export type PanelId = "left" | "right";
