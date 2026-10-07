// In-memory filesystem for isomorphic-git in Workers.
// Adapted from Cloudflare's Artifacts documentation example.
// Workers have no local disk, so git operations run against this.

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; mtimeMs: number };

class MemoryStats {
  entry: Entry;
  constructor(entry: Entry) {
    this.entry = entry;
  }
  get size() {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
  }
  get mtimeMs() {
    return this.entry.mtimeMs;
  }
  get ctimeMs() {
    return this.entry.mtimeMs;
  }
  get mode() {
    return this.entry.kind === "file" ? 0o100644 : 0o040000;
  }
  isFile() {
    return this.entry.kind === "file";
  }
  isDirectory() {
    return this.entry.kind === "dir";
  }
  isSymbolicLink() {
    return false;
  }
}

export class MemoryFS {
  encoder = new TextEncoder();
  decoder = new TextDecoder();
  entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);

  // isomorphic-git checks for fs.promises and uses it exclusively if present.
  // A getter returning `this` keeps the method list in sync automatically:
  // any method added to the class is visible via fs.promises without
  // maintaining a separate dictionary.
  get promises(): this {
    return this;
  }

  // Stubs for isomorphic-git. We never create symlinks, but the binder
  // requires these methods to exist.
  async readlink(_path: string): Promise<string> {
    throw this.fsError("ENOSYS", _path);
  }
  async symlink(_target: string, _path: string): Promise<void> {
    throw this.fsError("ENOSYS", _path);
  }

  normalize(input: string) {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join("/")}` || "/";
  }

  parent(path: string) {
    const normalized = this.normalize(path);
    if (normalized === "/") return "/";
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
  }

  basename(path: string) {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  getEntry(path: string) {
    return this.entries.get(this.normalize(path));
  }

  // Create an error with a .code property so isomorphic-git's exists()
  // recognizes ENOENT/ENOTDIR instead of re-throwing as unhandled.
  fsError(code: string, path: string): Error {
    const e = new Error(`${code}: ${path}`) as Error & { code: string };
    e.code = code;
    return e;
  }

  requireEntry(path: string) {
    const entry = this.getEntry(path);
    if (!entry) throw this.fsError("ENOENT", path);
    return entry;
  }

  requireDir(path: string) {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") throw this.fsError("ENOTDIR", path);
    return entry;
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    const target = this.normalize(path);
    if (target === "/") return;
    const recursive = typeof options === "object" && options !== null && options.recursive;
    const parent = this.parent(target);
    if (!this.entries.has(parent)) {
      if (!recursive) throw this.fsError("ENOENT", parent);
      await this.mkdir(parent, { recursive: true });
    }
    if (this.entries.has(target)) return;
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    this.requireDir(parent).children.add(this.basename(target));
  }

  async writeFile(path: string, data: string | Uint8Array) {
    const target = this.normalize(path);
    await this.mkdir(this.parent(target), { recursive: true });
    const bytes =
      typeof data === "string"
        ? this.encoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
    this.requireDir(this.parent(target)).children.add(this.basename(target));
  }

  async readFile(path: string, options?: string | { encoding?: string }) {
    const entry = this.requireEntry(path);
    if (entry.kind !== "file") throw this.fsError("EISDIR", path);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(entry.data) : entry.data;
  }

  async readdir(path: string) {
    return [...this.requireDir(path).children].sort();
  }

  async unlink(path: string) {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind !== "file") throw this.fsError("EISDIR", path);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async rmdir(path: string) {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0) throw this.fsError("ENOTEMPTY", path);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async stat(path: string) {
    return new MemoryStats(this.requireEntry(path));
  }

  async lstat(path: string) {
    return this.stat(path);
  }
}
