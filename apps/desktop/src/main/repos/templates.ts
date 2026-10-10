import fs from 'node:fs';
import path from 'node:path';

import type { LicenseChoice } from '../../shared/ipc/repos2-contract';

/**
 * Bundled Init templates (spec 03 §5): `<dir>/gitignore/*.gitignore` (condensed from github/gitignore,
 * CC0-1.0) and `<dir>/licenses/{index.json,*.txt}` (standard license texts with `{{year}}` / `{{fullname}}`
 * placeholders; the Apache-2.0 appendix uses `[yyyy]` / `[name of copyright owner]`). Packaged builds
 * ship them via electron-builder `extraResources` → `resources/templates`.
 */

/** Where the templates live: `process.resourcesPath/templates` when packaged, `<app>/resources/templates` in dev. */
export function templatesDir(o: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.isPackaged
    ? path.join(o.resourcesPath, 'templates')
    : path.join(o.appPath, 'resources', 'templates');
}

interface LicenseIndexEntry {
  spdxId: string;
  name: string;
  file: string;
}

export class TemplateStore {
  constructor(private readonly dir: string) {}

  gitignoreNames(): string[] {
    try {
      return fs
        .readdirSync(path.join(this.dir, 'gitignore'))
        .filter((f) => f.endsWith('.gitignore'))
        .map((f) => f.slice(0, -'.gitignore'.length))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch {
      return [];
    }
  }

  /** Several templates combined, each under a `### Name ###` header (spec 03 `templates:gitignore:get`). */
  gitignore(names: string[]): string {
    if (!Array.isArray(names)) throw new Error('Invalid template list');
    const known = new Set(this.gitignoreNames());
    const parts: string[] = [];
    for (const n of [...new Set(names)]) {
      // Only names from the bundled list: no path traversal through the request.
      if (typeof n !== 'string' || !known.has(n))
        throw new Error(`Unknown .gitignore template: ${String(n)}`);
      const text = fs
        .readFileSync(path.join(this.dir, 'gitignore', `${n}.gitignore`), 'utf8')
        .replace(/\r\n/g, '\n');
      parts.push(`### ${n} ###\n${text.trimEnd()}\n`);
    }
    return parts.join('\n');
  }

  private licenseIndex(): LicenseIndexEntry[] {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(this.dir, 'licenses', 'index.json'), 'utf8'),
      ) as unknown;
      return Array.isArray(raw)
        ? (raw as LicenseIndexEntry[]).filter(
            (e) =>
              typeof e?.spdxId === 'string' && typeof e.name === 'string' && /^[\w.-]+\.txt$/.test(e.file),
          )
        : [];
    } catch {
      return [];
    }
  }

  licenses(): { spdxId: string; name: string }[] {
    return this.licenseIndex().map(({ spdxId, name }) => ({ spdxId, name }));
  }

  renderLicense(choice: LicenseChoice): string {
    const entry = this.licenseIndex().find((e) => e.spdxId === choice?.spdxId);
    if (!entry) throw new Error(`Unknown license: ${String(choice?.spdxId)}`);
    const author = String(choice.author ?? '')
      .replace(/[\0-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, 200);
    const year =
      Number.isInteger(choice.year) && choice.year > 1900 && choice.year < 3000
        ? choice.year
        : new Date().getFullYear();
    const text = fs.readFileSync(path.join(this.dir, 'licenses', entry.file), 'utf8').replace(/\r\n/g, '\n');
    return text
      .replace(/\{\{year\}\}|\[yyyy\]/g, String(year))
      .replace(/\{\{fullname\}\}|\[name of copyright owner\]/g, author || 'the authors');
  }
}
