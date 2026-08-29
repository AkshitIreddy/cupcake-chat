import { basename, dirname, extname, join, normalize } from 'node:path';
import { lstat, realpath, stat } from 'node:fs/promises';
import type { OpaqueFileHandle } from '../shared/desktop-api';
import { uuidV7 } from './ids';

export interface InternalFileGrant extends OpaqueFileHandle {
  absolutePath: string;
  createdAt: number;
}

const MAX_ACTIVE_HANDLES = 2_048;

export class FileHandleRegistry {
  readonly #handles = new Map<string, InternalFileGrant>();

  async registerExisting(absolutePath: string, writable = false): Promise<OpaqueFileHandle> {
    const canonicalPath = await realpath(absolutePath);
    const details = await stat(canonicalPath);
    const kind = details.isDirectory() ? 'directory' : 'file';
    return this.#register({
      id: uuidV7(),
      kind,
      name: basename(canonicalPath),
      extension:
        kind === 'file' ? extname(canonicalPath).slice(1).toLowerCase() || undefined : undefined,
      size: kind === 'file' ? details.size : undefined,
      writable,
      absolutePath: canonicalPath,
      createdAt: Date.now(),
    });
  }

  async registerSaveTarget(requestedPath: string): Promise<OpaqueFileHandle> {
    const safeParent = await realpath(dirname(requestedPath));
    const targetName = basename(normalize(requestedPath));
    if (!targetName || targetName === '.' || targetName === '..')
      throw new Error('Invalid save target');
    const targetPath = join(safeParent, targetName);
    try {
      const existing = await lstat(targetPath);
      if (existing.isSymbolicLink() || existing.isDirectory())
        throw new Error('Invalid save target type');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    return this.#register({
      id: uuidV7(),
      kind: 'save-target',
      name: targetName,
      extension: extname(targetName).slice(1).toLowerCase() || undefined,
      writable: true,
      absolutePath: targetPath,
      createdAt: Date.now(),
    });
  }

  resolve(handleId: string): InternalFileGrant | undefined {
    return this.#handles.get(handleId);
  }

  release(handleId: string): void {
    this.#handles.delete(handleId);
  }

  clear(): void {
    this.#handles.clear();
  }

  #register(grant: InternalFileGrant): OpaqueFileHandle {
    if (this.#handles.size >= MAX_ACTIVE_HANDLES) {
      const oldest = this.#handles.keys().next().value;
      if (oldest) this.#handles.delete(oldest);
    }
    this.#handles.set(grant.id, grant);
    return this.toPublic(grant);
  }

  toPublic(grant: InternalFileGrant): OpaqueFileHandle {
    return {
      id: grant.id,
      kind: grant.kind,
      name: grant.name,
      extension: grant.extension,
      size: grant.size,
      writable: grant.writable,
    };
  }
}
