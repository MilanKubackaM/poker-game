import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SNAPSHOT_VERSION, type TableSnapshot } from './Table';

const CODE_PATTERN = /^[A-Z0-9]{6}$/;

/** Súborové úložisko stolov: jeden JSON na stôl v `<dataDir>/tables/<CODE>.json`, zapisovaný atomicky (tmp + rename). */
export class TableStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'tables');
    mkdirSync(this.dir, { recursive: true });
  }

  loadAll(): TableSnapshot[] {
    const snapshots: TableSnapshot[] = [];
    for (const file of readdirSync(this.dir)) {
      const code = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
      if (!CODE_PATTERN.test(code)) {
        continue;
      }
      try {
        const data = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as TableSnapshot;
        if (data.version !== SNAPSHOT_VERSION || data.code !== code || !Array.isArray(data.players)) {
          console.warn(`Stôl ${code}: nepodporovaný formát súboru, preskakujem`);
          continue;
        }
        snapshots.push(data);
      } catch (error) {
        console.warn(`Stôl ${code}: súbor sa nedá načítať, preskakujem`, error);
      }
    }
    return snapshots;
  }

  save(snapshot: TableSnapshot): void {
    const target = this.file(snapshot.code);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, target);
  }

  /**
   * Skopíruje pôvodné súbory stolov do `targetDir` — len ak ešte neexistuje (záloha sa nikdy neprepíše novšími dátami).
   * Vráti, či zálohu vytvoril.
   */
  backup(targetDir: string): boolean {
    if (existsSync(targetDir)) {
      return false;
    }
    const tmp = `${targetDir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const file of readdirSync(this.dir)) {
      if (file.endsWith('.json') && CODE_PATTERN.test(file.slice(0, -'.json'.length))) {
        copyFileSync(path.join(this.dir, file), path.join(tmp, file));
      }
    }
    // Celý priečinok naraz — prerušená záloha nezostane ako „hotová“.
    renameSync(tmp, targetDir);
    return true;
  }

  remove(code: string): void {
    const target = this.file(code);
    if (existsSync(target)) {
      rmSync(target);
    }
  }

  private file(code: string): string {
    if (!CODE_PATTERN.test(code)) {
      throw new Error(`Invalid table code ${code}`);
    }
    return path.join(this.dir, `${code}.json`);
  }
}
