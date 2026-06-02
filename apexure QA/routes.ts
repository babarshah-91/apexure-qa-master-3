import type { Express } from "express";
import { storage } from "./storage";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";

// --- COMPARISON HELPERS ---
function rgbNumbersToHex(r: number, g: number, b: number) {
  const toHex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function parseCssColor(colorStr: string) {
  if (!colorStr) return null;
  const rgbMatch = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return { r: parseInt(rgbMatch[1]), g: parseInt(rgbMatch[2]), b: parseInt(rgbMatch[3]) };
  }
  const hexMatch = colorStr.match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    return {
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16),
    };
  }
  return null;
}

function normalizeFontWeight(weight: any) {
  const map: any = { normal: '400', bold: '700', lighter: '300', bolder: '700' };
  const w = String(weight).toLowerCase().trim();
  return map[w] || w;
}

function normalizeFigmaFontWeight(style: any) {
  if (!style) return '400';
  const map: any = {
    thin: '100', extralight: '200', 'extra light': '200', ultralight: '200',
    light: '300', regular: '400', normal: '400', medium: '500',
    semibold: '600', 'semi bold': '600', demibold: '600', bold: '700',
    extrabold: '800', 'extra bold': '800', ultrabold: '800', black: '900', heavy: '900',
  };
  const s = String(style).toLowerCase().trim();
  return map[s] || '400';
}

function parsePx(value: any) {
  if (typeof value === 'number') return value;
  if (!value) return null;
  const match = String(value).match(/([\d.]+)\s*px/);
  return match ? parseFloat(match[1]) : null;
}

function normalizeForMatching(str: string) {
  return str
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- FIGMA CACHE ---
// Caches Figma API responses for 10 minutes to avoid rate limits
const figmaCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in ms
const CACHE_MAX_SIZE = 100; // FIX #7: prevent unbounded memory growth

function getCachedFigma(key: string) {
  const entry = figmaCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    figmaCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedFigma(key: string, data: any) {
  // FIX #7: evict oldest entry when cache is full
  if (figmaCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = figmaCache.keys().next().value;
    if (oldestKey) figmaCache.delete(oldestKey);
  }
  figmaCache.set(key, { data, timestamp: Date.now() });
}

// --- HELPERS ---
function normalizeUrl(url: string | undefined): string | null {
  if (!url) return null;
  let normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
  try { new URL(normalized); return normalized; } catch { return null; }
}

function parseFigmaUrl(url: string) {
  try {
    const urlObj = new URL(url.trim());
    const fileKey = urlObj.pathname.split('/')[2];
    const nodeId = urlObj.searchParams.get('node-id');
    if (!nodeId) return null;
    // FIX #5: intentionally only replace the first hyphen (Figma node IDs are "123-456")
    const nodeIdColon = nodeId.replace(/-/, ':');
    return { fileKey, nodeId: nodeIdColon, nodeIdRaw: nodeId };
  } catch { return null; }
}

function rgbToHex(rgbString: string): string {
  const rgbMatch = rgbString.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`.toUpperCase();
  }
  const rgbaMatch = rgbString.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1]).toString(16).padStart(2, '0');
    const g = parseInt(rgbaMatch[2]).toString(16).padStart(2, '0');
    const b = parseInt(rgbaMatch[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`.toUpperCase();
  }
  if (rgbString.startsWith('#')) return rgbString.toUpperCase();
  return rgbString;
}

function normalizeLineHeight(lineHeight: string, fontSize: string): string {
  const lhNum = parseFloat(lineHeight);
  const fsNum = parseFloat(fontSize);
  if (!isNaN(lhNum) && !isNaN(fsNum) && !lineHeight.includes('px')) {
    return `${Math.round(lhNum * fsNum)}px`;
  }
  if (lineHeight === 'normal' || lineHeight === 'Normal') return 'Normal';
  return lineHeight.includes('px') ? `${Math.round(parseFloat(lineHeight))}px` : lineHeight;
}

// --- FIGMA: extract all text nodes with section info ---
function extractTextNodesFromFigma(node: any, sectionName: string = 'Section 1', depth: number = 0): any[] {
  const results: any[] = [];
  const isContainer = node.type === 'FRAME' || node.type === 'GROUP' ||
    node.type === 'COMPONENT' || node.type === 'INSTANCE';
  const currentSection = (isContainer && node.name) ? node.name : sectionName;

  if (node.type === 'TEXT') {
    const style = node.style ?? {};
    const fills = node.fills ?? [];
    const fill = fills.find((f: any) => f.type === 'SOLID' && f.visible !== false);
    const color = fill?.color
      ? `#${Math.round(fill.color.r * 255).toString(16).padStart(2, '0')}${Math.round(fill.color.g * 255).toString(16).padStart(2, '0')}${Math.round(fill.color.b * 255).toString(16).padStart(2, '0')}`
      : "#000000";
    const text = node.characters?.trim() ?? '';
    if (!text) return results;
    results.push({
      section: sectionName,
      text,
      fontFamily: style.fontFamily ?? 'Unknown',
      fontSize: style.fontSize ? `${style.fontSize}px` : 'Unknown',
      lineHeight: style.lineHeightPx ? `${Math.round(style.lineHeightPx)}px` : 'Normal',
      color: color.toUpperCase()
    });
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      results.push(...extractTextNodesFromFigma(child, currentSection, depth + 1));
    }
  }
  return results;
}

// --- FIGMA: extract all image nodes ---
function extractImageNodesFromFigma(node: any, sectionName: string = 'Section 1', depth: number = 0): any[] {
  const results: any[] = [];
  const isContainer = node.type === 'FRAME' || node.type === 'GROUP' ||
    node.type === 'COMPONENT' || node.type === 'INSTANCE';
  const currentSection = (isContainer && node.name) ? node.name : sectionName;

  const hasImageFill = node.fills?.some((f: any) => f.type === 'IMAGE' && f.visible !== false);
  if (hasImageFill) {
    const box = node.absoluteBoundingBox;
    results.push({
      section: sectionName,
      layerName: (node.name ?? 'Unnamed').trim(),
      width: box ? Math.round(box.width) : null,
      height: box ? Math.round(box.height) : null,
    });
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      results.push(...extractImageNodesFromFigma(child, currentSection, depth + 1));
    }
  }
  return results;
}

// --- FIGMA FETCH WITH RETRY ---
// Handles Figma 429 rate limit responses with exponential backoff
async function fetchWithRetry(url: string, options: RequestInit, retries = 3, baseDelay = 1000): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (res.status === 429) {
        const retryAfterRaw = parseInt(res.headers.get('retry-after') || '0');
        // Figma returns retry-after in ms if > 1000, otherwise treat as seconds
        const retryAfterMs = retryAfterRaw > 1000 ? retryAfterRaw : retryAfterRaw * 1000;
        const backoff = baseDelay * Math.pow(2, i); // 1s, 2s, 4s
        const delay = Math.min(retryAfterMs || backoff, 30000); // cap at 30s
        console.log(`[Figma] Rate limited — retrying in ${delay}ms (attempt ${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') throw new Error('Figma API request timed out');
      throw error;
    }
  }
  throw new Error('Figma API rate limit exceeded — please wait a moment and try again');
}

async function fetchFigmaData(fileKey: string, nodeId: string, nodeIdRaw: string, token: string) {
  const cacheKey = `${fileKey}:${nodeId}`;
  const cached = getCachedFigma(cacheKey);
  if (cached) {
    console.log(`[Figma Cache] HIT for ${cacheKey}`);
    return cached;
  }
  console.log(`[Figma Cache] MISS for ${cacheKey} — fetching from API`);

  const res = await fetchWithRetry(
    `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`,
    { headers: { 'X-Figma-Token': token } }
  );
  const data = await res.json();
  if (data.status === 403 || data.err) throw new Error(`Figma API error: ${data.err || 'Unauthorized'}`);
  const nodeData = data.nodes[nodeId] || data.nodes[nodeIdRaw];
  if (!nodeData) throw new Error(`Node not found in Figma response.`);
  const rootNode = nodeData.document;
  const result = {
    textNodes: extractTextNodesFromFigma(rootNode, rootNode.name || 'Section 1', 0),
    imageNodes: extractImageNodesFromFigma(rootNode, rootNode.name || 'Section 1', 0),
  };
  setCachedFigma(cacheKey, result);
  return result;
}

// --- WEB FETCH: text + images in ONE browser session ---
// FIX #1: merged fetchWebData + fetchWebImages to avoid spinning up two browsers for the same URL
// FIX #2: switched from networkidle (can hang 60s on sites with polling/analytics) to domcontentloaded + short wait
async function fetchWebDataAndImages(url: string) {
  const { browser, context } = await launchStealthBrowser();
  try {
    const page = await context.newPage();

    // FIX #2: domcontentloaded is much faster; 1500ms wait lets JS hydrate
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);

    // Expand accordions / tabs so hidden text is captured
    // NOTE: all callbacks use arrow functions — esbuild wraps `function` keywords with __name()
    // which is not available in the browser context Playwright sends evaluated code to
    await page.evaluate(() => {
      document.querySelectorAll('details:not([open])').forEach((el) => { (el as any).open = true; });
      const triggerSelectors = [
        '[aria-expanded="false"]', '[data-accordion-target]', '[data-bs-toggle="collapse"]',
        '.accordion-button.collapsed', '.accordion-header button',
        '[class*="accordion"] button', '[class*="accordion"] [role="button"]',
        '.w-dropdown-toggle', '.w-tab-link:not(.w--current)',
        '[class*="toggle"]:not(input)', '[class*="trigger"]', '[class*="expand"]',
        '[role="tab"][aria-selected="false"]',
      ];
      triggerSelectors.forEach((sel) => {
        try {
          document.querySelectorAll(sel).forEach((el) => {
            try { (el as any).click(); } catch (e) { }
          });
        } catch (e) { }
      });
    });

    await page.waitForTimeout(1500);

    // Scroll to trigger lazy-loaded content — arrow functions throughout to avoid esbuild __name issue
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 250;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 80);
      });
    });

    await page.waitForTimeout(800);

    // Wait for images to finish loading
    await page.waitForFunction(
      () => Array.from(document.images).every(img => img.complete),
      { timeout: 5000 }
    ).catch(() => { });

    // Extract text nodes
    // IMPORTANT: no named const arrow functions inside evaluate — esbuild/tsx wraps them
    // with __name() which is not defined in the browser context Playwright sends code to.
    // getSectionLabel is inlined directly into the forEach loop to avoid this.
    const textResults = await page.evaluate(() => {
      const items: any[] = [];
      const seenTexts = new Set<string>();

      const allTextEls = Array.from(
        document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, button, label, a, span, td, th, blockquote, figcaption')
      );

      allTextEls.forEach((el) => {
        const hasBlockChildren = el.querySelector('p, h1, h2, h3, h4, h5, h6, li, div, section, article, blockquote');
        if (hasBlockChildren) return;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
        const computedStyle = window.getComputedStyle(el);
        const isHidden = computedStyle.display === 'none' || computedStyle.visibility === 'hidden' ||
          parseFloat(computedStyle.opacity) === 0 || (el as HTMLElement).offsetParent === null;
        const rawText = isHidden
          ? el.textContent?.replace(/\s+/g, ' ').trim()
          : (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim();
        if (!rawText || rawText.length < 2) return;
        if (seenTexts.has(rawText)) return;
        seenTexts.add(rawText);

        // Inline section label — no named const to avoid esbuild __name wrapping
        let section = 'Page';
        let cur: Element | null = el.parentElement;
        let d = 0;
        while (cur && cur !== document.body && d < 10) {
          const t = cur.tagName.toLowerCase();
          if (t === 'header') { section = 'Header'; break; }
          if (t === 'footer') { section = 'Footer'; break; }
          if (t === 'nav') { section = 'Navigation'; break; }
          if (t === 'main') { section = 'Main'; break; }
          if (t === 'aside') { section = 'Sidebar'; break; }
          const id = cur.getAttribute('id');
          if (id && id.length > 1 && !/^\d+$/.test(id)) { section = id; break; }
          const aria = cur.getAttribute('aria-label');
          if (aria && aria.length > 1) { section = aria; break; }
          const ds = (cur as HTMLElement).dataset;
          const dval = ds?.section || ds?.name || ds?.block;
          if (dval && dval.length > 1) { section = dval; break; }
          cur = cur.parentElement;
          d++;
        }

        items.push({
          section,
          text: rawText,
          fontFamily: computedStyle.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
          fontSize: computedStyle.fontSize,
          lineHeight: computedStyle.lineHeight,
          color: computedStyle.color,
          fromAccordion: isHidden,
        });
      });
      return items;
    });

    const textNodes = textResults.map((item: any) => ({
      ...item,
      color: rgbToHex(item.color),
      lineHeight: normalizeLineHeight(item.lineHeight, item.fontSize)
    }));

    // Extract image nodes
    const images = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll(
        'img, [role="img"], svg, canvas, picture, figure, [style*="background-image"], [class*="image"], [class*="img"], [class*="photo"], [class*="banner"], [class*="avatar"], [class*="logo"], [class*="icon"]'
      ));
      const seen = new Set<string>();
      const results: any[] = [];
      allEls.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const alt = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLElement).dataset.alt || '';
        const key = el.getAttribute('src') || `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.top)}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({
          alt: alt.trim(),
          src: el.getAttribute('src') || null,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
      });
      return results;
    });

    return { textNodes, images };
  } finally {
    await browser.close();
  }
}

// --- COMPARE IMAGES ---
function compareImages(figmaImages: any[], webImages: any[]) {
  const TOLERANCE = 15;
  const dimensionMatch = (fi: any, wi: any) =>
    fi.width && wi.width && Math.abs(fi.width - wi.width) <= TOLERANCE && Math.abs(fi.height - wi.height) <= TOLERANCE;
  const nameMatch = (fi: any, wi: any) => {
    if (!wi.alt || wi.alt.length === 0) return false;
    const a = fi.layerName.toLowerCase().replace(/[_\s-]+/g, ' ').trim();
    const b = wi.alt.toLowerCase().replace(/[_\s-]+/g, ' ').trim();
    return a === b || a.includes(b) || b.includes(a);
  };
  const figmaResults = figmaImages.map(fi => {
    const match = webImages.find(wi => nameMatch(fi, wi) || dimensionMatch(fi, wi));
    return {
      source: 'figma', section: fi.section, layerName: fi.layerName,
      figmaSize: fi.width && fi.height ? `${fi.width}x${fi.height}` : 'Unknown',
      webAlt: match?.alt ?? null, webSize: match ? `${match.width}x${match.height}` : null,
      status: match ? 'present' : 'missing_on_web',
      matchedBy: match ? (nameMatch(fi, match) && dimensionMatch(fi, match) ? 'name+size' : nameMatch(fi, match) ? 'name' : 'size') : null,
    };
  });
  const matchedKeys = new Set(figmaResults.filter(r => r.status === 'present').map(r => r.webSize + '|' + (r.webAlt ?? '')));
  const extraWebImages = webImages
    .filter(wi => { const key = `${wi.width}x${wi.height}|${wi.alt ?? ''}`; return !matchedKeys.has(key) && wi.width >= 20 && wi.height >= 20; })
    .map(wi => ({ source: 'web', section: null, layerName: null, figmaSize: null, webAlt: wi.alt || null, webSize: `${wi.width}x${wi.height}`, status: 'missing_on_figma', matchedBy: null }));
  return [...figmaResults, ...extraWebImages];
}

// --- COMPARE TEXT ---
function compareTextNodes(figmaNodes: any[], webNodes: any[]) {
  const sectionMap: Record<string, any[]> = {};
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

  // FIX #4: pre-build O(1) exact-match lookup — avoids O(n²) norm() calls on every figma node
  const webNormMap = new Map<string, any>();
  for (const wn of webNodes) {
    webNormMap.set(norm(wn.text), wn);
  }

  const wordSimilarity = (a: string, b: string): number => {
    const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'of', 'is', 'it', 'as']);
    const words = (s: string) => norm(s).split(' ').filter(w => w.length > 3 && !STOP_WORDS.has(w));
    const wa = new Set(words(a)); const wb = words(b);
    if (wa.size === 0 || wb.length === 0) return 0;
    return wb.filter(w => wa.has(w)).length / Math.max(wa.size, wb.length);
  };
  const lengthRatio = (a: string, b: string) => Math.min(a.length, b.length) / Math.max(a.length, b.length);

  const findMatch = (figmaText: string, nodes: any[]) => {
    const fn = norm(figmaText);
    // O(1) exact match via pre-built map
    const exact = webNormMap.get(fn);
    if (exact) return exact;
    // Fall back to fuzzy only when needed
    return nodes.find(wn => {
      const wn_norm = norm(wn.text);
      return lengthRatio(fn, wn_norm) >= 0.5 && wordSimilarity(fn, wn_norm) >= 0.7;
    });
  };

  for (const fn of figmaNodes) {
    if (!sectionMap[fn.section]) sectionMap[fn.section] = [];
    const webMatch = findMatch(fn.text, webNodes);
    const contentMatch = webMatch !== undefined;
    const styleMatch = webMatch ? fn.fontFamily === webMatch.fontFamily && fn.fontSize === webMatch.fontSize && fn.color === webMatch.color : false;
    sectionMap[fn.section].push({
      section: fn.section, figmaText: fn.text, webText: webMatch?.text ?? null,
      contentStatus: contentMatch ? 'match' : 'diff',
      styleStatus: styleMatch ? 'match' : 'diff',
      figmaStyle: { fontFamily: fn.fontFamily, fontSize: fn.fontSize, lineHeight: fn.lineHeight, color: fn.color },
      webStyle: webMatch ? { fontFamily: webMatch.fontFamily, fontSize: webMatch.fontSize, lineHeight: webMatch.lineHeight, color: webMatch.color } : null
    });
  }
  return Object.entries(sectionMap).map(([sectionName, items], index) => ({ sectionIndex: index + 1, sectionName, items }));
}

// --- BROKEN LINK CHECKER ---
async function extractLinks(url: string): Promise<any[]> {
  const { browser, context } = await launchStealthBrowser();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    return await page.evaluate((baseUrl) => {
      const links: any[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('a[href]').forEach(el => {
        const href = el.getAttribute('href') ?? '';
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        let resolved = href;
        try { resolved = new URL(href, baseUrl).href; } catch { }
        if (seen.has(resolved)) return;
        seen.add(resolved);
        links.push({ url: resolved, text: (el as HTMLElement).innerText?.trim().slice(0, 80) || null, type: href.startsWith('mailto:') ? 'mailto' : href.startsWith('tel:') ? 'tel' : resolved.startsWith(baseUrl) ? 'internal' : 'external' });
      });
      document.querySelectorAll('img[src]').forEach(el => {
        const src = el.getAttribute('src') ?? '';
        if (!src || src.startsWith('data:')) return;
        let resolved = src;
        try { resolved = new URL(src, baseUrl).href; } catch { }
        if (seen.has(resolved)) return;
        seen.add(resolved);
        links.push({ url: resolved, text: el.getAttribute('alt') || null, type: 'image' });
      });
      return links;
    }, url);
  } finally {
    await browser.close();
  }
}

async function checkLink(link: any): Promise<any> {
  if (link.type === 'mailto' || link.type === 'tel') return { ...link, status: 'valid', statusCode: null };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(link.url, { method: 'HEAD', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' }, redirect: 'follow' });
    clearTimeout(timeout);
    if (res.status === 405) {
      const res2 = await fetch(link.url, { method: 'GET', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' }, redirect: 'follow' });
      return { ...link, statusCode: res2.status, status: res2.ok ? 'valid' : 'broken' };
    }
    return { ...link, statusCode: res.status, status: res.ok ? 'valid' : 'broken' };
  } catch (err: any) {
    return { ...link, statusCode: null, status: 'error', error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

// --- TEXTGEARS SPELL CHECK ---
// Free spell check API — 100 requests/day free, very accurate
async function textGearsSpellCheck(text: string): Promise<any[]> {
  const apiKey = process.env.TEXTGEARS_API_KEY || 'DEMO';

  const cleanText = text
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const CHUNK_SIZE = 1000;
  const chunks: string[] = [];
  for (let i = 0; i < cleanText.length; i += CHUNK_SIZE) {
    let end = i + CHUNK_SIZE;
    if (end < cleanText.length) {
      while (end > i && cleanText[end] !== ' ') end--;
    }
    chunks.push(cleanText.slice(i, end).trim());
  }

  const allIssues: any[] = [];
  const seenWords = new Set<string>();

  for (const chunk of chunks) {
    if (!chunk) continue;
    try {
      const params = new URLSearchParams({ text: chunk, language: 'en-US', ai: '1' });
      if (apiKey !== 'DEMO') params.append('key', apiKey);

      const res = await fetch(`https://api.textgears.com/spelling?${params.toString()}`);
      if (!res.ok) continue;

      const data = await res.json();
      if (!data.status || !data.response?.errors) continue;

      data.response.errors.forEach((err: any) => {
        const word = err.bad ?? '';
        const wordLower = word.toLowerCase();
        if (!word || word.length < 4) return;
        if (seenWords.has(wordLower)) return;
        seenWords.add(wordLower);

        const suggestions = (err.better ?? []).slice(0, 3);
        const hasDifferentSuggestion = suggestions.some((s: string) => s.toLowerCase() !== wordLower);
        if (suggestions.length > 0 && !hasDifferentSuggestion) return;

        allIssues.push({
          word,
          type: 'spelling',
          category: 'Spelling',
          message: suggestions.length > 0 ? `Did you mean "${suggestions[0]}"?` : `"${word}" may be misspelled`,
          shortMessage: suggestions.length > 0 ? `Did you mean "${suggestions[0]}"?` : 'Possible misspelling',
          replacements: suggestions,
          context: chunk.substring(Math.max(0, chunk.toLowerCase().indexOf(wordLower) - 30), chunk.toLowerCase().indexOf(wordLower) + 50).trim(),
          offset: err.offset ?? 0,
          length: word.length,
        });
      });
    } catch {
      continue;
    }
  }

  return allIssues;
}

async function launchStealthBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });
  return { browser, context };
}

export async function registerRoutes(app: Express): Promise<void> {
  // --- FIGMA BRIDGE STATE ---
  let latestFigmaData: any = null;
  let latestFrameData: any = null;
  const clientLogs: any[] = [];

  // Receive logs from clients (Figma plugin, Frontend)
  app.post("/api/logs", (req, res) => {
    const { level, message, context } = req.body;
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level || 'INFO',
      message: message || 'No message',
      context: context || {}
    };
    clientLogs.push(logEntry);
    if (clientLogs.length > 100) clientLogs.shift(); // Keep last 100

    console.log(`[CLIENT-LOG][${logEntry.level}] ${logEntry.message}`, JSON.stringify(logEntry.context));
    res.json({ ok: true });
  });

  // Get recent logs (for debugging)
  app.get("/api/logs", (req, res) => {
    res.json(clientLogs);
  });

  // Bridge routes
  app.post("/api/figma-data", (req, res) => {
    latestFigmaData = req.body;
    console.log(`[Bridge] Received data from plugin`);
    res.status(200).json({ ok: true });
  });

  app.get("/api/figma-data", (req, res) => {
    res.json(latestFigmaData || { nodes: [] });
  });

  app.post("/api/figma-frame", (req, res) => {
    latestFrameData = req.body;
    console.log(`[Bridge] Received frame from plugin`);
    res.status(200).json({ ok: true });
  });

  app.get("/api/figma-frame", (req, res) => {
    const data = latestFrameData;
    latestFrameData = null;
    res.json(data || null);
  });

  // --- NEW: PLUGIN-BASED COMPARISON (DESIGN SENTINEL) ---
  app.post("/api/compare-sentinel", async (req, res) => {
    const { url: liveUrl } = req.body;
    if (!liveUrl) return res.status(400).json({ error: 'Missing "url" in request body' });

    if (!latestFigmaData) {
      return res.status(400).json({ error: 'No Figma data loaded. Run the Figma plugin first.' });
    }

    let browser;
    try {
      const textNodes = latestFigmaData.nodes.filter((n: any) => n.type === 'TEXT' && n.content);
      const mismatches: any[] = [];

      const stealth = await launchStealthBrowser();
      browser = stealth.browser;
      const context = stealth.context;

      const page = await context.newPage();
      await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });

      // Parallel evaluation
      const evaluationResults = await Promise.all(
        textNodes.map(async (node: any) => {
          const content = normalizeForMatching(node.content.trim());
          if (!content || content.length < 2) return { node, elementData: null, skipped: true };

          // Use a string-based evaluate to completely bypass TSX compiler injection of __name
          const elementData = await page.evaluate(new Function('searchText', `
            const semanticTags = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'A', 'BUTTON', 'LI', 'LABEL'];
            
            const findDeepestTextElement = (el, targetText) => {
              if (semanticTags.includes(el.tagName)) return el;
              for (const tag of semanticTags) {
                const children = el.querySelectorAll(tag.toLowerCase());
                for (const child of children) {
                  if ((child.textContent || '').trim().includes(targetText.slice(0, 30))) return child;
                }
              }
              return el;
            };

            const allElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, div, li, a, button, label');
            let bestElement = null;
            let bestScore = 0;

            for (const el of allElements) {
              const rawText = (el.textContent || '').replace(/\\s+/g, ' ').trim();
              if (!rawText) continue;
              let score = 0;
              if (rawText === searchText) score = 100;
              else if (rawText.includes(searchText)) score = 70;

              if (score > bestScore) {
                bestScore = score;
                bestElement = el;
              }
              if (score === 100) break;
            }

            if (!bestElement || bestScore < 25) return null;
            const actual = findDeepestTextElement(bestElement, searchText);
            const style = window.getComputedStyle(actual);
            return {
              fontSize: style.fontSize,
              fontFamily: style.fontFamily,
              fontWeight: style.fontWeight,
              color: style.color,
              lineHeight: style.lineHeight,
              textContent: actual.textContent.trim(),
            };
          `) as any, content);

          return { node, content, elementData };
        })
      );

      // Process mismatches
      for (const { node, content, elementData, skipped } of evaluationResults as any) {
        if (skipped) continue;

        if (!elementData) {
          mismatches.push({ nodeId: node.id, nodeName: node.name, property: 'element', figmaValue: content, liveValue: 'NOT FOUND', status: 'fail' });
          continue;
        }

        // Compare color
        if (node.fills && node.fills.length > 0 && node.fills[0] && node.fills[0].color) {
          const figmaColor = node.fills[0].color;
          const figmaHex = rgbNumbersToHex(figmaColor.r, figmaColor.g, figmaColor.b);
          const liveColor = parseCssColor(elementData.color);
          if (liveColor) {
            const liveHex = rgbNumbersToHex(liveColor.r, liveColor.g, liveColor.b);
            const dr = Math.abs(figmaColor.r - liveColor.r);
            const dg = Math.abs(figmaColor.g - liveColor.g);
            const db = Math.abs(figmaColor.b - liveColor.b);
            let status = 'pass';
            if (dr > 2 || dg > 2 || db > 2) status = 'fail';
            else if (dr > 0 || dg > 0 || db > 0) status = 'warn';
            mismatches.push({
              nodeId: node.id, nodeName: node.name, property: 'color',
              figmaValue: figmaHex, liveValue: liveHex, status,
            });
          }
        }

        if (node.fontSize) {
          const liveSize = parsePx(elementData.fontSize);
          mismatches.push({ nodeId: node.id, nodeName: node.name, property: 'fontSize', figmaValue: `${node.fontSize}px`, liveValue: `${liveSize}px`, status: liveSize !== node.fontSize ? 'fail' : 'pass' });
        }
        if (node.fontFamily) {
          const liveFamily = elementData.fontFamily ? elementData.fontFamily.split(',')[0].trim().replace(/['"]/g, '') : 'Unknown';
          mismatches.push({ nodeId: node.id, nodeName: node.name, property: 'fontFamily', figmaValue: node.fontFamily, liveValue: liveFamily, status: liveFamily.toLowerCase() === node.fontFamily.toLowerCase() ? 'pass' : 'fail' });
        }
        if (node.fontWeight) {
          const liveWeight = normalizeFontWeight(elementData.fontWeight);
          const figmaWeight = normalizeFigmaFontWeight(node.fontWeight);
          mismatches.push({ nodeId: node.id, nodeName: node.name, property: 'fontWeight', figmaValue: figmaWeight, liveValue: liveWeight, status: liveWeight === figmaWeight ? 'pass' : 'fail' });
        }
      }

      res.json({
        pageName: latestFigmaData.pageName || 'Unknown',
        url: liveUrl,
        checkedAt: new Date().toISOString(),
        total: mismatches.length,
        passed: mismatches.filter(m => m.status === 'pass').length,
        failed: mismatches.filter(m => m.status === 'fail').length,
        warned: mismatches.filter(m => m.status === 'warn').length,
        mismatches,
      });

    } catch (err: any) {
      console.error('[Server] Comparison error:', err.message);
      res.status(500).json({ error: `Comparison failed: ${err.message}` });
    } finally {
      if (browser) await browser.close();
    }
  });

  app.post("/api/compare", async (req, res) => {
    try {
      const { figmaUrl, figmaToken, liveUrl } = req.body;
      if (!figmaUrl || !figmaToken || !liveUrl) return res.status(400).json({ message: "figmaUrl, figmaToken, and liveUrl are all required." });
      if (typeof figmaToken !== 'string' || figmaToken.trim().length === 0) return res.status(400).json({ message: "Invalid Figma token." });

      const figmaParsed = parseFigmaUrl(figmaUrl);
      const webUrl = normalizeUrl(liveUrl);
      if (!figmaParsed) throw new Error("Invalid Figma URL. Make sure it includes a node-id parameter.");
      if (!webUrl) throw new Error("Invalid live URL.");

      // FIX #1: single browser session for web — fetches text + images in one page load
      const [figmaData, webResult] = await Promise.all([
        fetchFigmaData(figmaParsed.fileKey, figmaParsed.nodeId, figmaParsed.nodeIdRaw, figmaToken),
        fetchWebDataAndImages(webUrl),
      ]);

      const { textNodes: figmaNodes, imageNodes: figmaImages } = figmaData;
      const { textNodes: webNodes, images: webImages } = webResult;

      if (!figmaNodes || figmaNodes.length === 0) throw new Error("No text nodes found in the selected Figma frame.");
      if (!webNodes || webNodes.length === 0) throw new Error("Could not extract text from the live URL.");

      const sections = compareTextNodes(figmaNodes, webNodes);
      const images = compareImages(figmaImages, webImages);
      const imagesSummary = {
        total: images.length,
        present: images.filter(i => i.status === 'present').length,
        missingOnWeb: images.filter(i => i.status === 'missing_on_web').length,
        missingOnFigma: images.filter(i => i.status === 'missing_on_figma').length,
        items: images,
      };

      const comparison = await storage.createComparison({ figmaUrl, liveUrl: webUrl, result: { sections, images: imagesSummary } });
      res.json(comparison);
    } catch (error: any) {
      console.error('Comparison error:', error);
      res.status(500).json({ message: error.message || 'An unexpected error occurred.' });
    }
  });

  app.post("/api/check-links", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ message: "url is required." });
      const normalized = normalizeUrl(url);
      if (!normalized) return res.status(400).json({ message: "Invalid URL." });

      const links = await extractLinks(normalized);
      const BATCH_SIZE = 10;
      const results: any[] = [];
      for (let i = 0; i < links.length; i += BATCH_SIZE) {
        const batch = links.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(checkLink));
        results.push(...batchResults);
      }

      res.json({
        total: results.length,
        valid: results.filter(r => r.status === 'valid').length,
        broken: results.filter(r => r.status === 'broken').length,
        errors: results.filter(r => r.status === 'error').length,
        byType: {
          internal: results.filter(r => r.type === 'internal').length,
          external: results.filter(r => r.type === 'external').length,
          image: results.filter(r => r.type === 'image').length,
          mailto: results.filter(r => r.type === 'mailto').length,
          tel: results.filter(r => r.type === 'tel').length,
        },
        links: results,
      });
    } catch (error: any) {
      console.error('Link check error:', error);
      res.status(500).json({ message: error.message || 'An unexpected error occurred.' });
    }
  });

  // --- SEO AUDIT ---
  app.post("/api/seo-audit", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ message: "url is required." });
      const normalized = normalizeUrl(url);
      if (!normalized) return res.status(400).json({ message: "Invalid URL." });

      const stealth = await launchStealthBrowser();
      const browser = stealth.browser;
      try {
        const context = stealth.context;
        const page = await context.newPage();
        await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);

        const getMeta = async (name: string) =>
          page.$eval(`meta[name="${name}"]`, (el: Element) => (el as HTMLMetaElement).getAttribute('content')).catch(() => null);

        const getMetaProp = async (prop: string) =>
          page.$eval(`meta[property="${prop}"]`, (el: Element) => (el as HTMLMetaElement).getAttribute('content')).catch(() => null);

        const [
          title,
          description, keywords, author, robots, viewport,
          lang, canonical, charset,
          ogTitle, ogDescription, ogImage, ogType,
          twitterCard, twitterTitle, twitterDescription, twitterImage,
          publisher,
          h1Count, h2Count, h3Count, h4Count, h5Count, h6Count,
          h1Text,
          pageUrl,
        ] = await Promise.all([
          page.title(),
          getMeta('description'), getMeta('keywords'), getMeta('author'), getMeta('robots'), getMeta('viewport'),
          page.$eval('html', (el: Element) => (el as HTMLElement).lang || null).catch(() => null),
          page.$eval('link[rel="canonical"]', (el: Element) => (el as HTMLLinkElement).href).catch(() => null),
          page.$eval('meta[charset]', (el: Element) => el.getAttribute('charset')).catch(() => null),
          getMetaProp('og:title'), getMetaProp('og:description'), getMetaProp('og:image'), getMetaProp('og:type'),
          getMeta('twitter:card'), getMeta('twitter:title'), getMeta('twitter:description'), getMeta('twitter:image'),
          page.$eval('meta[property="article:publisher"]', (el: Element) => (el as HTMLMetaElement).getAttribute('content')).catch(() => getMeta('publisher')),
          page.locator('h1').count(),
          page.locator('h2').count(),
          page.locator('h3').count(),
          page.locator('h4').count(),
          page.locator('h5').count(),
          page.locator('h6').count(),
          page.$eval('h1', (el: Element) => (el as HTMLElement).innerText?.trim() || null).catch(() => null),
          page.url(),
        ]);

        // FIX #3: parallelise image attribute fetching — was sequential (up to 60 awaits)
        const imageHandles = await page.$$('img');
        const imageDetails = await Promise.all(
          imageHandles.slice(0, 20).map(async (img) => {
            const [src, alt, dims] = await Promise.all([
              img.getAttribute('src').catch(() => null),
              img.getAttribute('alt').catch(() => null),
              img.evaluate((el: Element) => {
                const i = el as HTMLImageElement;
                return { w: i.naturalWidth || i.width || 0, h: i.naturalHeight || i.height || 0 };
              }).catch(() => ({ w: 0, h: 0 })),
            ]);
            return { src, alt, width: dims.w || null, height: dims.h || null, hasAlt: !!(alt && alt.trim()) };
          })
        );
        const imagesWithoutAlt = imageDetails.filter(i => !i.hasAlt).length;
        const totalImages = await page.locator('img').count();

        const totalLinks = await page.locator('a[href]').count();
        const internalLinks = await page.evaluate((baseUrl: string) => {
          return Array.from(document.querySelectorAll('a[href]')).filter((a) => {
            try { return new URL((a as HTMLAnchorElement).href).hostname === new URL(baseUrl).hostname; }
            catch { return false; }
          }).length;
        }, normalized);
        const externalLinks = totalLinks - internalLinks;

        const seoData = {
          url: pageUrl,
          title: title || null,
          description, keywords, author, robots, lang,
          canonical, publisher, viewport, charset,
          og: { title: ogTitle, description: ogDescription, image: ogImage, type: ogType },
          twitter: { card: twitterCard, title: twitterTitle, description: twitterDescription, image: twitterImage },
          headings: { h1: h1Count, h2: h2Count, h3: h3Count, h4: h4Count, h5: h5Count, h6: h6Count, h1Text },
          images: { total: totalImages, withoutAlt: imagesWithoutAlt, items: imageDetails },
          links: { total: totalLinks, internal: internalLinks, external: externalLinks },
        };

        const issues: { type: 'error' | 'warning' | 'pass'; field: string; message: string }[] = [];

        if (!seoData.title) issues.push({ type: 'error', field: 'Title', message: 'Title tag is missing' });
        else if (seoData.title.length < 30) issues.push({ type: 'warning', field: 'Title', message: `Title is too short (${seoData.title.length} chars, recommended 30-60)` });
        else if (seoData.title.length > 60) issues.push({ type: 'warning', field: 'Title', message: `Title is too long (${seoData.title.length} chars, recommended 30-60)` });
        else issues.push({ type: 'pass', field: 'Title', message: `Title length is good (${seoData.title.length} chars)` });

        if (!seoData.description) issues.push({ type: 'error', field: 'Description', message: 'Meta description is missing' });
        else if (seoData.description.length < 70) issues.push({ type: 'warning', field: 'Description', message: `Description is too short (${seoData.description.length} chars, recommended 70-160)` });
        else if (seoData.description.length > 160) issues.push({ type: 'warning', field: 'Description', message: `Description is too long (${seoData.description.length} chars, recommended 70-160)` });
        else issues.push({ type: 'pass', field: 'Description', message: `Description length is good (${seoData.description.length} chars)` });

        if (!seoData.keywords) issues.push({ type: 'warning', field: 'Keywords', message: 'Keywords meta tag is missing' });
        else issues.push({ type: 'pass', field: 'Keywords', message: 'Keywords meta tag is present' });

        if (!seoData.canonical) issues.push({ type: 'warning', field: 'Canonical', message: 'Canonical URL is not defined' });
        else issues.push({ type: 'pass', field: 'Canonical', message: 'Canonical URL is defined' });

        if (!seoData.robots) issues.push({ type: 'warning', field: 'Robots Tag', message: 'Robots meta tag is not defined' });
        else issues.push({ type: 'pass', field: 'Robots Tag', message: `Robots: ${seoData.robots}` });

        if (!seoData.author) issues.push({ type: 'warning', field: 'Author', message: 'Author meta tag is missing' });
        else issues.push({ type: 'pass', field: 'Author', message: `Author: ${seoData.author}` });

        if (!seoData.lang) issues.push({ type: 'warning', field: 'Language', message: 'Page language is not defined' });
        else issues.push({ type: 'pass', field: 'Language', message: `Language: ${seoData.lang}` });

        if (seoData.headings.h1 === 0) issues.push({ type: 'error', field: 'H1', message: 'No H1 tag found on the page' });
        else if (seoData.headings.h1 > 1) issues.push({ type: 'warning', field: 'H1', message: `Multiple H1 tags found (${seoData.headings.h1}) — should have only one` });
        else issues.push({ type: 'pass', field: 'H1', message: `H1 is present: "${seoData.headings.h1Text}"` });

        if (seoData.images.withoutAlt > 0) issues.push({ type: 'warning', field: 'Images', message: `${seoData.images.withoutAlt} image(s) missing alt text` });
        else issues.push({ type: 'pass', field: 'Images', message: 'All images have alt text' });

        const socialImage = seoData.og.image || seoData.twitter.image;
        if (!socialImage) issues.push({ type: 'warning', field: 'Social Image', message: 'No social share image found (og:image or twitter:image missing)' });
        else issues.push({ type: 'pass', field: 'Social Image', message: 'Social share image is present' });

        if (!seoData.viewport) issues.push({ type: 'error', field: 'Viewport', message: 'Viewport meta tag is missing — page may not be mobile friendly' });
        else issues.push({ type: 'pass', field: 'Viewport', message: 'Viewport meta tag is present' });

        const errors = issues.filter(i => i.type === 'error').length;
        const warnings = issues.filter(i => i.type === 'warning').length;
        const passes = issues.filter(i => i.type === 'pass').length;
        const score = Math.round((passes / issues.length) * 100);

        res.json({ ...seoData, issues, score, errors, warnings, passes });
      } finally {
        await browser.close();
      }
    } catch (error: any) {
      console.error('SEO audit error:', error);
      res.status(500).json({ message: error.message || 'An unexpected error occurred.' });
    }
  });

  // --- TECH STACK DETECTOR ---
  app.post("/api/tech-stack", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ message: "url is required." });
      const normalized = normalizeUrl(url);
      if (!normalized) return res.status(400).json({ message: "Invalid URL." });

      const stealth = await launchStealthBrowser();
      const browser = stealth.browser;
      try {
        const context = stealth.context;
        const page = await context.newPage();

        const headers: Record<string, string> = {};
        page.on('response', response => {
          if (response.url() === normalized) {
            const h = response.headers();
            Object.assign(headers, h);
          }
        });

        await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        const techData = await page.evaluate(() => {
          const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => (s as HTMLScriptElement).src);
          const allScripts = document.documentElement.innerHTML;
          const metas = Array.from(document.querySelectorAll('meta')).map((m) => ({
            name: m.getAttribute('name') || m.getAttribute('property') || '',
            content: m.getAttribute('content') || '',
          }));
          const links = Array.from(document.querySelectorAll('link')).map((l) => (l as HTMLLinkElement).href);
          const classes = document.documentElement.className + ' ' + document.body.className;
          const win = window as any;

          return {
            scripts, allScripts, metas, links, classes,
            hasReact: !!(win.React || win.__REACT_DEVTOOLS_GLOBAL_HOOK__),
            hasVue: !!(win.Vue || win.__vue_app__),
            hasAngular: !!(win.angular || win.getAllAngularRootElements),
            hasJQuery: !!(win.jQuery || win.$?.fn?.jquery),
            hasGTM: !!(win.google_tag_manager || allScripts.includes('googletagmanager.com')),
            hasGA: !!(win.ga || win.gtag || allScripts.includes('google-analytics.com') || allScripts.includes('googletagmanager.com')),
            hasHotjar: !!(win.hj || allScripts.includes('hotjar.com')),
            hasFBPixel: !!(win.fbq || allScripts.includes('connect.facebook.net')),
            hasIntercom: !!(win.Intercom || allScripts.includes('intercom.io')),
            hasHubspot: !!(win._hsq || allScripts.includes('hubspot.com') || allScripts.includes('hs-scripts.com')),
            hasMailchimp: !!(allScripts.includes('mailchimp.com') || allScripts.includes('list-manage.com')),
            hasZendesk: !!(win.zE || allScripts.includes('zendesk.com')),
            hasCrisp: !!(win.$crisp || allScripts.includes('crisp.chat')),
            hasTidio: !!(allScripts.includes('tidio.co')),
            hasWebflow: !!(allScripts.includes('webflow.com') || document.querySelector('[data-wf-site]') || document.querySelector('[data-wf-page]')),
            hasWordPress: !!(allScripts.includes('wp-content') || allScripts.includes('wp-includes') || document.querySelector('meta[name="generator"][content*="WordPress"]')),
            hasShopify: !!(win.Shopify || allScripts.includes('shopify.com') || allScripts.includes('cdn.shopify.com')),
            hasSquarespace: !!(allScripts.includes('squarespace.com') || win.Squarespace),
            hasWix: !!(allScripts.includes('wix.com') || allScripts.includes('wixstatic.com')),
            hasFramer: !!(allScripts.includes('framer.com') || allScripts.includes('framerusercontent.com')),
            hasGhostCMS: !!(allScripts.includes('ghost.io') || document.querySelector('meta[name="generator"][content*="Ghost"]')),
            hasDrupal: !!(win.Drupal || allScripts.includes('/sites/default/files/')),
            hasJoomla: !!(allScripts.includes('/media/jui/') || win.Joomla),
            hasTailwind: !!(allScripts.includes('tailwind') || document.querySelector('[class*="bg-"]')),
            hasBootstrap: !!(allScripts.includes('bootstrap') || document.querySelector('.container.row') !== null),
            hasNextJS: !!(win.__NEXT_DATA__ || allScripts.includes('/_next/')),
            hasNuxtJS: !!(win.__NUXT__ || allScripts.includes('/_nuxt/')),
            hasGatsbyJS: !!(win.___gatsby || allScripts.includes('/static/gatsby')),
            hasGoogleFonts: !!(allScripts.includes('fonts.googleapis.com') || allScripts.includes('fonts.gstatic.com')),
            hasCloudflare: !!(allScripts.includes('cloudflare.com') || allScripts.includes('cdn-cgi')),
            hasVercel: !!(allScripts.includes('vercel.app') || allScripts.includes('_vercel')),
            hasNetlify: !!(allScripts.includes('netlify.com') || allScripts.includes('netlify.app')),
            hasAWS: !!(allScripts.includes('amazonaws.com') || allScripts.includes('cloudfront.net')),
            hasRecaptcha: !!(allScripts.includes('recaptcha') || allScripts.includes('hcaptcha')),
            hasSentry: !!(win.Sentry || allScripts.includes('sentry.io')),
            hasStripe: !!(win.Stripe || allScripts.includes('stripe.com')),
            hasTypekit: !!(allScripts.includes('typekit.net') || allScripts.includes('use.typekit')),
            hasCookiebot: !!(allScripts.includes('cookiebot.com') || win.Cookiebot),
            hasOneTrust: !!(allScripts.includes('onetrust.com') || win.OneTrust),
            hasTikTokPixel: !!(allScripts.includes('tiktok.com') && allScripts.includes('pixel')),
            hasLinkedInInsight: !!(allScripts.includes('snap.licdn.com') || allScripts.includes('linkedin.com/insight')),
            hasGoogleAds: !!(allScripts.includes('googleadservices.com') || allScripts.includes('google.com/pagead')),
            hasMixpanel: !!(win.mixpanel || allScripts.includes('mixpanel.com')),
            hasSegment: !!(win.analytics?.initialize || allScripts.includes('segment.com') || allScripts.includes('segment.io')),
            hasAmplitude: !!(win.amplitude || allScripts.includes('amplitude.com')),
            hasLiveChat: !!(win.LiveChatWidget || allScripts.includes('livechat.com')),
            hasTypeform: !!(allScripts.includes('typeform.com')),
            hasCalendly: !!(allScripts.includes('calendly.com')),
            hasCapterra: !!(allScripts.includes('capterra.com')),
            hasDrift: !!(win.drift || allScripts.includes('drift.com')),
          };
        });

        const detected: { name: string; category: string; icon: string }[] = [];

        if (techData.hasWebflow) detected.push({ name: 'Webflow', category: 'CMS', icon: '🌊' });
        if (techData.hasWordPress) detected.push({ name: 'WordPress', category: 'CMS', icon: '📝' });
        if (techData.hasShopify) detected.push({ name: 'Shopify', category: 'E-commerce', icon: '🛒' });
        if (techData.hasSquarespace) detected.push({ name: 'Squarespace', category: 'CMS', icon: '◻' });
        if (techData.hasWix) detected.push({ name: 'Wix', category: 'CMS', icon: '🔷' });
        if (techData.hasFramer) detected.push({ name: 'Framer', category: 'CMS', icon: '🎨' });
        if (techData.hasGhostCMS) detected.push({ name: 'Ghost', category: 'CMS', icon: '👻' });
        if (techData.hasDrupal) detected.push({ name: 'Drupal', category: 'CMS', icon: '💧' });
        if (techData.hasJoomla) detected.push({ name: 'Joomla', category: 'CMS', icon: '🔥' });
        if (techData.hasReact) detected.push({ name: 'React', category: 'JavaScript Framework', icon: '⚛' });
        if (techData.hasVue) detected.push({ name: 'Vue.js', category: 'JavaScript Framework', icon: '💚' });
        if (techData.hasAngular) detected.push({ name: 'Angular', category: 'JavaScript Framework', icon: '🅰' });
        if (techData.hasNextJS) detected.push({ name: 'Next.js', category: 'JavaScript Framework', icon: '▲' });
        if (techData.hasNuxtJS) detected.push({ name: 'Nuxt.js', category: 'JavaScript Framework', icon: '💚' });
        if (techData.hasGatsbyJS) detected.push({ name: 'Gatsby', category: 'JavaScript Framework', icon: '💜' });
        if (techData.hasJQuery) detected.push({ name: 'jQuery', category: 'JavaScript Library', icon: '📦' });
        if (techData.hasTailwind) detected.push({ name: 'Tailwind CSS', category: 'CSS Framework', icon: '🎨' });
        if (techData.hasBootstrap) detected.push({ name: 'Bootstrap', category: 'CSS Framework', icon: '🅱' });
        if (techData.hasGA) detected.push({ name: 'Google Analytics', category: 'Analytics', icon: '📊' });
        if (techData.hasGTM) detected.push({ name: 'Google Tag Manager', category: 'Tag Manager', icon: '🏷' });
        if (techData.hasHotjar) detected.push({ name: 'Hotjar', category: 'Analytics', icon: '🔥' });
        if (techData.hasMixpanel) detected.push({ name: 'Mixpanel', category: 'Analytics', icon: '📈' });
        if (techData.hasSegment) detected.push({ name: 'Segment', category: 'Analytics', icon: '📡' });
        if (techData.hasAmplitude) detected.push({ name: 'Amplitude', category: 'Analytics', icon: '📉' });
        if (techData.hasFBPixel) detected.push({ name: 'Facebook Pixel', category: 'Advertising', icon: '📘' });
        if (techData.hasGoogleAds) detected.push({ name: 'Google Ads', category: 'Advertising', icon: '🎯' });
        if (techData.hasTikTokPixel) detected.push({ name: 'TikTok Pixel', category: 'Advertising', icon: '🎵' });
        if (techData.hasLinkedInInsight) detected.push({ name: 'LinkedIn Insight', category: 'Advertising', icon: '💼' });
        if (techData.hasHubspot) detected.push({ name: 'HubSpot', category: 'CRM / Marketing', icon: '🧡' });
        if (techData.hasMailchimp) detected.push({ name: 'Mailchimp', category: 'Email Marketing', icon: '🐒' });
        if (techData.hasIntercom) detected.push({ name: 'Intercom', category: 'Live Chat', icon: '💬' });
        if (techData.hasZendesk) detected.push({ name: 'Zendesk', category: 'Support', icon: '🎧' });
        if (techData.hasCrisp) detected.push({ name: 'Crisp', category: 'Live Chat', icon: '💬' });
        if (techData.hasTidio) detected.push({ name: 'Tidio', category: 'Live Chat', icon: '💬' });
        if (techData.hasDrift) detected.push({ name: 'Drift', category: 'Live Chat', icon: '💬' });
        if (techData.hasLiveChat) detected.push({ name: 'LiveChat', category: 'Live Chat', icon: '💬' });
        if (techData.hasCalendly) detected.push({ name: 'Calendly', category: 'Scheduling', icon: '📅' });
        if (techData.hasTypeform) detected.push({ name: 'Typeform', category: 'Forms', icon: '📋' });
        if (techData.hasStripe) detected.push({ name: 'Stripe', category: 'Payments', icon: '💳' });
        if (techData.hasGoogleFonts) detected.push({ name: 'Google Fonts', category: 'Fonts', icon: '🔤' });
        if (techData.hasTypekit) detected.push({ name: 'Adobe Fonts', category: 'Fonts', icon: '🔤' });
        if (techData.hasCloudflare) detected.push({ name: 'Cloudflare', category: 'CDN / Security', icon: '🛡' });
        if (techData.hasVercel) detected.push({ name: 'Vercel', category: 'Hosting', icon: '▲' });
        if (techData.hasNetlify) detected.push({ name: 'Netlify', category: 'Hosting', icon: '🟩' });
        if (techData.hasAWS) detected.push({ name: 'AWS / CloudFront', category: 'Hosting', icon: '☁' });
        if (techData.hasRecaptcha) detected.push({ name: 'reCAPTCHA', category: 'Security', icon: '🔒' });
        if (techData.hasCookiebot) detected.push({ name: 'Cookiebot', category: 'Cookie Consent', icon: '🍪' });
        if (techData.hasOneTrust) detected.push({ name: 'OneTrust', category: 'Cookie Consent', icon: '🍪' });
        if (techData.hasSentry) detected.push({ name: 'Sentry', category: 'Error Tracking', icon: '🐛' });

        const server = headers['server'] || headers['x-powered-by'] || null;
        if (server) {
          if (server.toLowerCase().includes('nginx')) detected.push({ name: 'Nginx', category: 'Web Server', icon: '🌐' });
          if (server.toLowerCase().includes('apache')) detected.push({ name: 'Apache', category: 'Web Server', icon: '🌐' });
          if (server.toLowerCase().includes('cloudflare')) {
            if (!detected.find(d => d.name === 'Cloudflare')) detected.push({ name: 'Cloudflare', category: 'CDN / Security', icon: '🛡' });
          }
        }

        const grouped: Record<string, { name: string; category: string; icon: string }[]> = {};
        detected.forEach(tech => {
          if (!grouped[tech.category]) grouped[tech.category] = [];
          grouped[tech.category].push(tech);
        });

        res.json({ url: normalized, total: detected.length, technologies: detected, grouped });
      } finally {
        await browser.close();
      }
    } catch (error: any) {
      console.error('Tech stack error:', error);
      res.status(500).json({ message: error.message || 'An unexpected error occurred.' });
    }
  });

  // --- SPELL CHECK ---
  app.post("/api/spell-check", async (req, res) => {
    try {
      const { url, language = 'en-US' } = req.body;
      if (!url) return res.status(400).json({ message: "url is required." });
      const normalized = normalizeUrl(url);
      if (!normalized) return res.status(400).json({ message: "Invalid URL." });

      // FIX #8: use domcontentloaded — we only need body text, not full asset load
      const stealth = await launchStealthBrowser();
      const browser = stealth.browser;
      let pageText = '';
      try {
        const context = stealth.context;
        const page = await context.newPage();
        await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000);
        pageText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
      } finally {
        await browser.close();
      }

      const issues = await textGearsSpellCheck(pageText);

      const byCategory: Record<string, number> = {};
      issues.forEach(i => { byCategory[i.category] = (byCategory[i.category] || 0) + 1; });

      res.json({
        url: normalized,
        language,
        engine: 'textgears',
        totalIssues: issues.length,
        spelling: issues.filter(i => i.type === 'spelling').length,
        grammar: 0,
        style: 0,
        byCategory,
        issues,
      });
    } catch (error: any) {
      console.error('Spell check error:', error);
      res.status(500).json({ message: error.message || 'An unexpected error occurred.' });
    }
  });

  // --- SCREENSHOT DIFF ---
  app.post("/api/screenshot-diff", async (req, res) => {
    try {
      const { liveUrl, figmaFrameBase64 } = req.body;
      const webUrl = normalizeUrl(liveUrl);
      if (!webUrl) return res.status(400).json({ message: "Please provide a valid live URL." });

      // Step 1: Get Figma frame image — from request body or bridge server
      let figmaImageBuffer: Buffer;
      let frameName: string | null = null;
      let figmaNodes: any[] | null = null;

      if (figmaFrameBase64) {
        const raw = figmaFrameBase64.replace(/^data:image\/\w+;base64,/, '');
        figmaImageBuffer = Buffer.from(raw, 'base64');
      } else {
        try {
          const bridgeRes = await fetch('http://localhost:3333/figma-frame');
          if (bridgeRes.ok) {
            const bridgeData = await bridgeRes.json();
            if (bridgeData && bridgeData.frameBase64) {
              figmaImageBuffer = Buffer.from(bridgeData.frameBase64, 'base64');
              frameName = bridgeData.frameName || null;
              figmaNodes = bridgeData.nodes || null;
            } else {
              return res.status(400).json({ message: "Please export a frame from Figma plugin or upload an image" });
            }
          } else {
            return res.status(400).json({ message: "Please export a frame from Figma plugin or upload an image" });
          }
        } catch {
          return res.status(400).json({ message: "Please export a frame from Figma plugin or upload an image" });
        }
      }

      // Step 2: Screenshot the live page with Playwright
      const VIEWPORT = { width: 1440, height: 900 };
      let liveScreenshotBuffer: Buffer;
      
      const stealth = await launchStealthBrowser();
      const browser = stealth.browser;
      try {
        const context = stealth.context;
        const page = await context.newPage();
        await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        liveScreenshotBuffer = Buffer.from(await page.screenshot({ fullPage: true, type: 'png' }));
        
        // --- SMART HEATMAP INTEGRATION ---
        if (figmaNodes && figmaNodes.length > 0) {
          try {
            const heatmapResult = await generateTypographyHeatmap(page, figmaNodes, liveScreenshotBuffer);
            const targetWidth = VIEWPORT.width;
            const targetHeight = VIEWPORT.height;
            const figmaResized = await sharp(figmaImageBuffer).resize(targetWidth, targetHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
            const liveResized = await sharp(liveScreenshotBuffer).resize(targetWidth, targetHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
            
            const diffPercentage = heatmapResult.totalCount > 0 ? parseFloat(((heatmapResult.mismatchCount / heatmapResult.totalCount) * 100).toFixed(2)) : 0;
            
            return res.json({
              figmaImage: `data:image/png;base64,${figmaResized.toString('base64')}`,
              liveImage: `data:image/png;base64,${liveResized.toString('base64')}`,
              diffImage: `data:image/png;base64,${heatmapResult.diffBuffer.toString('base64')}`,
              mismatchPercentage: diffPercentage,
              mismatchPixels: heatmapResult.mismatchCount,
              totalPixels: heatmapResult.totalCount,
              viewport: `${targetWidth}x${targetHeight}`,
              aiExplanation: `Found ${heatmapResult.mismatchCount} Typography property discrepancies out of ${heatmapResult.totalCount} evaluated text nodes.`,
              frameName: frameName || null,
            });
          } catch (e) {
            console.error('[Smart Heatmap] Generation failed, falling back to pixelmatch.', e);
          }
        }
      } finally {
        await browser.close();
      }

      // Step 3: Fallback (pixelmatch) if no nodes found or smart heatmap failed
      const liveMeta = await sharp(liveScreenshotBuffer).metadata();
      const targetWidth = liveMeta.width!;
      const targetHeight = liveMeta.height!;

      const figmaResized = await sharp(figmaImageBuffer).resize(targetWidth, targetHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
      const liveResized = await sharp(liveScreenshotBuffer).resize(targetWidth, targetHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();

      const figmaPng = PNG.sync.read(figmaResized);
      const livePng = PNG.sync.read(liveResized);
      const diffPng = new PNG({ width: targetWidth, height: targetHeight });

      const mismatchPixels = pixelmatch(
        figmaPng.data, livePng.data, diffPng.data, targetWidth, targetHeight,
        { threshold: 0.1, diffColor: [255, 0, 0] }
      );

      const totalPixels = targetWidth * targetHeight;
      const mismatchPercentage = parseFloat(((mismatchPixels / totalPixels) * 100).toFixed(2));
      const diffBuffer = PNG.sync.write(diffPng);

      // Step 5: AI explanation via OpenRouter if mismatch > 2%
      let aiExplanation: string | null = null;
      if (mismatchPercentage > 2) {
        const openrouterKey = process.env.OPENROUTER_API_KEY;
        if (openrouterKey) {
          try {
            const https = await import('https');
            const aiResult: string = await new Promise((resolve, reject) => {
              const postData = JSON.stringify({
                model: 'openrouter/auto',
                max_tokens: 200,
                messages: [
                  {
                    role: 'system',
                    content: 'You are a QA engineer. Describe visual differences between a Figma design and live webpage based on pixel diff percentage. Be specific and concise. Max 3 sentences.',
                  },
                  {
                    role: 'user',
                    content: `Pixel diff shows ${mismatchPercentage}% mismatch between Figma design and live page. Describe what visual differences are likely present.`,
                  },
                ],
              });
              const options = {
                hostname: 'openrouter.ai',
                port: 443,
                path: '/api/v1/chat/completions',
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${openrouterKey}`,
                  'Content-Type': 'application/json',
                  'HTTP-Referer': 'http://localhost:5000',
                  'X-Title': 'Apexure QA',
                  'Content-Length': Buffer.byteLength(postData),
                },
              };
              const aiReq = https.request(options, (aiRes: any) => {
                let data = '';
                aiRes.on('data', (chunk: any) => { data += chunk; });
                aiRes.on('end', () => {
                  try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.choices?.[0]?.message?.content || '');
                  } catch { resolve(''); }
                });
              });
              aiReq.on('error', () => resolve(''));
              aiReq.write(postData);
              aiReq.end();
            });
            if (aiResult) aiExplanation = aiResult;
          } catch {
            aiExplanation = null;
          }
        }
      }

      res.json({
        figmaImage: `data:image/png;base64,${figmaResized.toString('base64')}`,
        liveImage: `data:image/png;base64,${liveResized.toString('base64')}`,
        diffImage: `data:image/png;base64,${diffBuffer.toString('base64')}`,
        mismatchPercentage,
        mismatchPixels,
        totalPixels,
        viewport: `${targetWidth}x${targetHeight}`,
        aiExplanation,
        frameName: frameName || null,
      });
    } catch (error: any) {
      console.error('Screenshot diff error:', error);
      res.status(500).json({ message: error.message || 'An unexpected error occurred.' });
    }
  });

  // --- PAGESPEED INSIGHTS ---
  app.post("/api/pagespeed", async (req, res) => {
    try {
      const { url, strategy = "mobile" } = req.body;
      if (!url) return res.status(400).json({ message: "url is required." });
      const normalized = normalizeUrl(url);
      if (!normalized) return res.status(400).json({ message: "Invalid URL." });

      const apiKey = process.env.GOOGLE_PSI_API_KEY || "";
      const categories = ["performance", "accessibility", "best-practices", "seo"];
      const params = new URLSearchParams({
        url: normalized,
        strategy: strategy === "desktop" ? "desktop" : "mobile",
      });
      categories.forEach(c => params.append("category", c));
      if (apiKey) params.append("key", apiKey);

      const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`;
      console.log(`[PSI] Fetching ${strategy} report for ${normalized}`);

      const psiRes = await fetch(psiUrl, { signal: AbortSignal.timeout(120000) });
      if (!psiRes.ok) {
        const errBody = await psiRes.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || `PSI API returned ${psiRes.status}`);
      }
      const psi = await psiRes.json();

      // --- Extract category scores ---
      const lhCategories = psi.lighthouseResult?.categories ?? {};
      const scores: Record<string, number | null> = {};
      for (const cat of categories) {
        const key = cat;
        scores[key] = lhCategories[key]?.score != null ? Math.round(lhCategories[key].score * 100) : null;
      }

      // --- Extract field data (CrUX) ---
      const fieldMetricsRaw = psi.loadingExperience?.metrics ?? {};
      const fieldData: Record<string, any> = {};
      const fieldKeys: Record<string, string> = {
        LARGEST_CONTENTFUL_PAINT_MS: "LCP",
        INTERACTION_TO_NEXT_PAINT: "INP",
        CUMULATIVE_LAYOUT_SHIFT_SCORE: "CLS",
        FIRST_CONTENTFUL_PAINT_MS: "FCP",
        FIRST_INPUT_DELAY_MS: "FID",
      };
      for (const [rawKey, label] of Object.entries(fieldKeys)) {
        const m = fieldMetricsRaw[rawKey];
        if (m) {
          fieldData[label] = {
            percentile: m.percentile,
            category: m.category, // FAST / AVERAGE / SLOW
            distributions: m.distributions,
          };
        }
      }
      const fieldOverallCategory = psi.loadingExperience?.overall_category ?? null;

      // --- Extract lab metrics ---
      const audits = psi.lighthouseResult?.audits ?? {};
      const labMetricKeys: Record<string, string> = {
        "first-contentful-paint": "FCP",
        "largest-contentful-paint": "LCP",
        "total-blocking-time": "TBT",
        "cumulative-layout-shift": "CLS",
        "speed-index": "Speed Index",
      };
      const labMetrics: Record<string, any> = {};
      for (const [auditId, label] of Object.entries(labMetricKeys)) {
        const a = audits[auditId];
        if (a) {
          labMetrics[label] = {
            displayValue: a.displayValue ?? null,
            numericValue: a.numericValue ?? null,
            score: a.score != null ? Math.round(a.score * 100) : null,
          };
        }
      }

      // --- Extract opportunities & diagnostics ---
      const auditRefs = psi.lighthouseResult?.categories?.performance?.auditRefs ?? [];
      const opportunityIds = auditRefs.filter((r: any) => r.group === "load-opportunities").map((r: any) => r.id);
      const diagnosticIds = auditRefs.filter((r: any) => r.group === "diagnostics").map((r: any) => r.id);

      const extractAuditItems = (ids: string[]) =>
        ids
          .map((id: string) => audits[id])
          .filter((a: any) => a && a.score !== null && a.score < 1)
          .map((a: any) => ({
            id: a.id,
            title: a.title,
            description: a.description,
            score: a.score != null ? Math.round(a.score * 100) : null,
            displayValue: a.displayValue ?? null,
            numericValue: a.numericValue ?? null,
            details: a.details ?? null,
          }));

      const opportunities = extractAuditItems(opportunityIds);
      const diagnostics = extractAuditItems(diagnosticIds);

      // --- Extract image optimization audit items ---
      const imageAuditIds = ["uses-optimized-images", "modern-image-formats", "uses-responsive-images"];
      const imageItems: any[] = [];
      const seenUrls = new Set<string>();
      for (const auditId of imageAuditIds) {
        const audit = audits[auditId];
        if (!audit?.details?.items) continue;
        for (const item of audit.details.items) {
          const imgUrl = item.url || item.node?.snippet?.match(/src="([^"]+)"/)?.[1];
          if (!imgUrl || seenUrls.has(imgUrl)) continue;
          seenUrls.add(imgUrl);
          const totalBytes = item.totalBytes ?? item.wastedBytes ?? 0;
          const wastedBytes = item.wastedBytes ?? 0;
          const optimizedBytes = totalBytes > 0 ? totalBytes - wastedBytes : 0;
          imageItems.push({
            url: imgUrl,
            sourceAudit: auditId,
            totalBytes,
            wastedBytes,
            optimizedBytes: optimizedBytes > 0 ? optimizedBytes : null,
            mimeType: item.mimeType ?? null,
            displayedWidth: item.node?.boundingRect?.width ?? null,
            displayedHeight: item.node?.boundingRect?.height ?? null,
            naturalWidth: item.width ?? null,
            naturalHeight: item.height ?? null,
            label: item.node?.nodeLabel ?? null,
            weightLifted: totalBytes > 0 ? parseFloat(((wastedBytes / totalBytes) * 100).toFixed(1)) : 0,
          });
        }
      }

      // Sort by wastedBytes descending for quick-wins pinning
      imageItems.sort((a, b) => b.wastedBytes - a.wastedBytes);

      // --- Quick Wins: top 3 heaviest items across all opportunities ---
      const allItems: any[] = [];
      for (const opp of opportunities) {
        if (opp.details?.items) {
          for (const item of opp.details.items) {
            allItems.push({
              source: opp.title,
              url: item.url ?? null,
              totalBytes: item.totalBytes ?? 0,
              wastedBytes: item.wastedBytes ?? 0,
              label: item.node?.nodeLabel ?? item.label ?? null,
            });
          }
        }
      }
      allItems.sort((a, b) => b.wastedBytes - a.wastedBytes);
      const quickWins = allItems.slice(0, 3);

      res.json({
        url: normalized,
        strategy,
        scores,
        fieldData,
        fieldOverallCategory,
        labMetrics,
        opportunities,
        diagnostics,
        imageItems,
        quickWins,
        fetchTime: psi.lighthouseResult?.fetchTime ?? null,
        finalUrl: psi.lighthouseResult?.finalUrl ?? normalized,
      });
    } catch (error: any) {
      console.error("PSI error:", error);
      res.status(500).json({ message: error.message || "An unexpected error occurred." });
    }
  }); // closes /api/pagespeed try/finally
  // --- Image Optimizer Route ---
  app.post("/api/pagespeed/optimize-image", async (req, res) => {
    try {
      const { imageUrl, format = "webp" } = req.body;
      if (!imageUrl) return res.status(400).json({ message: "imageUrl is required." });

      const imgRes = await fetch(imageUrl as string);
      if (!imgRes.ok) return res.status(400).json({ message: "Failed to fetch image." });

      const originalBuffer = Buffer.from(await imgRes.arrayBuffer());
      const optimizedBuffer = await sharp(originalBuffer)
        .toFormat(format as keyof sharp.FormatEnum, { quality: 80 })
        .toBuffer();

      res.setHeader("Content-Type", `image/${format}`);
      res.send(optimizedBuffer);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ message: msg });
    }
  });

} // closes registerRoutes