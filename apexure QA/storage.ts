import { db } from "./db";
import {
  comparisons,
  figmaFrames,
  webPages,
  type CreateComparisonInput,
  type Comparison,
  type InsertFigmaFrame,
  type FigmaFrame,
  type InsertWebPage,
  type WebPage,
} from "./shared/schema";
import { desc, eq } from "drizzle-orm";

export interface IStorage {
  createComparison(comparison: CreateComparisonInput): Promise<Comparison>;
  getHistory(): Promise<Comparison[]>;
  saveFrame(frame: InsertFigmaFrame): Promise<FigmaFrame>;
  getFramesByFileKey(fileKey: string): Promise<FigmaFrame[]>;
  deleteFramesByFileKey(fileKey: string): Promise<void>;
  saveWebPage(page: InsertWebPage): Promise<WebPage>;
  getWebPageByUrl(url: string): Promise<WebPage | null>;
  deleteWebPageByUrl(url: string): Promise<void>;
}

export class MemStorage implements IStorage {
  private comparisons: Comparison[] = [];
  private figmaFrames: FigmaFrame[] = [];
  private webPages: WebPage[] = [];
  private currentComparisonId = 1;
  private currentFrameId = 1;
  private currentWebPageId = 1;

  async createComparison(input: CreateComparisonInput): Promise<Comparison> {
    const comparison: Comparison = {
      id: this.currentComparisonId++,
      figmaUrl: input.figmaUrl,
      liveUrl: input.liveUrl,
      result: input.result ?? null,
      createdAt: new Date(),
    };
    this.comparisons.unshift(comparison);
    return comparison;
  }

  async getHistory(): Promise<Comparison[]> {
    return [...this.comparisons];
  }

  async saveFrame(input: InsertFigmaFrame): Promise<FigmaFrame> {
    const frame: FigmaFrame = {
      id: this.currentFrameId++,
      fileKey: input.fileKey,
      frameId: input.frameId,
      frameName: input.frameName,
      width: input.width ?? null,
      height: input.height ?? null,
      elements: input.elements ?? null,
      createdAt: new Date(),
    };
    this.figmaFrames.push(frame);
    return frame;
  }

  async getFramesByFileKey(fileKey: string): Promise<FigmaFrame[]> {
    return this.figmaFrames
      .filter((f) => f.fileKey === fileKey)
      .sort((a, b) => a.frameName.localeCompare(b.frameName));
  }

  async deleteFramesByFileKey(fileKey: string): Promise<void> {
    this.figmaFrames = this.figmaFrames.filter((f) => f.fileKey !== fileKey);
  }

  async saveWebPage(input: InsertWebPage): Promise<WebPage> {
    const page: WebPage = {
      id: this.currentWebPageId++,
      url: input.url,
      content: input.content ?? null,
      createdAt: new Date(),
    };
    this.webPages.unshift(page);
    return page;
  }

  async getWebPageByUrl(url: string): Promise<WebPage | null> {
    return this.webPages.find((p) => p.url === url) || null;
  }

  async deleteWebPageByUrl(url: string): Promise<void> {
    this.webPages = this.webPages.filter((p) => p.url !== url);
  }
}

export class DatabaseStorage implements IStorage {
  private memFallback = new MemStorage();

  async createComparison(input: CreateComparisonInput): Promise<Comparison> {
    if (!db) return this.memFallback.createComparison(input);
    try {
      const [comparison] = await db
        .insert(comparisons)
        .values(input)
        .returning();
      return comparison;
    } catch (err: any) {
      console.warn(`[storage] Database query failed (${err.message}). Using in-memory fallback.`);
      return this.memFallback.createComparison(input);
    }
  }

  async getHistory(): Promise<Comparison[]> {
    if (!db) return this.memFallback.getHistory();
    try {
      return await db
        .select()
        .from(comparisons)
        .orderBy(desc(comparisons.createdAt));
    } catch (err: any) {
      console.warn(`[storage] Database query failed (${err.message}). Using in-memory fallback.`);
      return this.memFallback.getHistory();
    }
  }

  async saveFrame(input: InsertFigmaFrame): Promise<FigmaFrame> {
    if (!db) return this.memFallback.saveFrame(input);
    try {
      const [frame] = await db
        .insert(figmaFrames)
        .values(input)
        .returning();
      return frame;
    } catch (err: any) {
      console.warn(`[storage] Database query failed (${err.message}). Using in-memory fallback.`);
      return this.memFallback.saveFrame(input);
    }
  }

  async getFramesByFileKey(fileKey: string): Promise<FigmaFrame[]> {
    if (!db) return this.memFallback.getFramesByFileKey(fileKey);
    try {
      return await db
        .select()
        .from(figmaFrames)
        .where(eq(figmaFrames.fileKey, fileKey))
        .orderBy(figmaFrames.frameName);
    } catch (err: any) {
      console.warn(`[storage] Database query failed (${err.message}). Using in-memory fallback.`);
      return this.memFallback.getFramesByFileKey(fileKey);
    }
  }

  async deleteFramesByFileKey(fileKey: string): Promise<void> {
    if (!db) return this.memFallback.deleteFramesByFileKey(fileKey);
    try {
      await db.delete(figmaFrames).where(eq(figmaFrames.fileKey, fileKey));
    } catch (err: any) {
      console.warn(`[storage] Database query failed (${err.message}). Using in-memory fallback.`);
      return this.memFallback.deleteFramesByFileKey(fileKey);
    }
  }

  async saveWebPage(input: InsertWebPage): Promise<WebPage> {
    if (!db) return this.memFallback.saveWebPage(input);
    try {
      const [page] = await db
        .insert(webPages)
        .values(input)
        .returning();
      return page;
    } catch (err: any) {
      console.warn(`[storage] Database query failed (${err.message}). Using in-memory fallback.`);
      return this.memFallback.saveWebPage(input);
    }
  }

  async getWebPageByUrl(url: string): Promise<WebPage | null> {
    if (!db) return this.memFallback.getWebPageByUrl(url);
    try {
      const results = await db
        .select()
        .from(webPages)
        .where(eq(webPages.url, url))
        .orderBy(desc(webPages.createdAt))
        .limit(1);
      return results[0] || null;
    } catch (err: any) {
      console.warn(`[storage] Database query failed (${err.message}). Using in-memory fallback.`);
      return this.memFallback.getWebPageByUrl(url);
    }
  }

  async deleteWebPageByUrl(url: string): Promise<void> {
    if (!db) return this.memFallback.deleteWebPageByUrl(url);
    try {
      await db.delete(webPages).where(eq(webPages.url, url));
    } catch (err: any) {
      console.warn(`[storage] Database query failed (${err.message}). Using in-memory fallback.`);
      return this.memFallback.deleteWebPageByUrl(url);
    }
  }
}

export const storage = new DatabaseStorage();
