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
}

export type RefKind = "local" | "remote" | "tag" | "head";
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

export interface DiffLine { kind: "add" | "del" | "ctx"; content: string; oldNo: number | null; newNo: number | null }
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
export interface PullArgs { mode: PullMode }
export interface PushArgs { force: boolean; setUpstream: boolean }
export interface CheckoutArgs { target: string; create: boolean }
export interface CreateBranchArgs { name: string; startPoint: string | null; checkout: boolean }
export interface CreateTagArgs { name: string; target: string | null; message: string | null }
export interface ResetArgs { sha: string; mode: ResetMode }
export interface CommitArgs { summary: string; description: string; amend: boolean }
export interface GetFileDiffArgs { path: string; staged: boolean; ignoreWhitespace: boolean }
export interface ApplyHunkArgs {
  path: string; staged: boolean; hunkIndex: number; action: HunkAction; ignoreWhitespace: boolean;
}
export interface ApplyLinesArgs { path: string; hunkIndex: number; lineIndices: number[]; action: LinesAction }
export interface RebaseInteractiveArgs { baseSha: string; items: RebaseTodoItem[] }

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
  | null;
