import * as vscode from 'vscode';
import { PlatformGuide } from './guideGenerator';
import { logger } from '../logging';

const CACHE_KEY = 'platformGuides';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class GuideCache {
  private guides = new Map<string, PlatformGuide>();

  constructor(private context: vscode.ExtensionContext) {
    const saved = context.globalState.get<Record<string, PlatformGuide>>(CACHE_KEY);
    if (saved) {
      for (const [key, val] of Object.entries(saved)) {
        this.guides.set(key, val);
      }
    }
  }

  get(tool: string): PlatformGuide | undefined {
    const guide = this.guides.get(tool);
    if (!guide) return undefined;
    if (Date.now() - new Date(guide.generatedAt).getTime() > CACHE_TTL_MS) {
      return undefined; // expired
    }
    return guide;
  }

  set(tool: string, guide: PlatformGuide): void {
    this.guides.set(tool, guide);
    this.persist();
  }

  isStale(tool: string): boolean {
    return !this.get(tool);
  }

  getAll(): Map<string, PlatformGuide> {
    return this.guides;
  }

  clear(): void {
    this.guides.clear();
    this.persist();
  }

  private async persist(): Promise<void> {
    const obj: Record<string, PlatformGuide> = {};
    for (const [k, v] of this.guides) { obj[k] = v; }
    await this.context.globalState.update(CACHE_KEY, obj);
  }
}
