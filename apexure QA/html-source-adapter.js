import { chromium } from "playwright";
import path from "path";
import { pathToFileURL } from "url";

function rgbToHex(rgbString) {
  if (!rgbString) return "#000000";
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

function normalizeLineHeight(lineHeight, fontSize) {
  const lhNum = parseFloat(lineHeight);
  const fsNum = parseFloat(fontSize);
  if (!isNaN(lhNum) && !isNaN(fsNum) && !String(lineHeight).includes('px')) {
    return `${Math.round(lhNum * fsNum)}px`;
  }
  if (lineHeight === 'normal' || lineHeight === 'Normal') return 'Normal';
  return String(lineHeight).includes('px') ? `${Math.round(parseFloat(lineHeight))}px` : lineHeight;
}

// Normalize function to map computed style property values to the project's spec shape
function normalize(nodes) {
  return nodes.map(node => {
    const fsStr = `${node.fontSize}px`;
    return {
      section: node.section || "Page",
      text: node.text,
      fontFamily: node.fontFamily ? node.fontFamily.split(',')[0].replace(/['"]/g, '').trim() : "Unknown",
      fontSize: fsStr,
      lineHeight: normalizeLineHeight(node.lineHeight, fsStr),
      color: rgbToHex(node.color),
    };
  });
}

export async function extractHtmlSpec(htmlPath, { viewport = { width: 1440, height: 900 } } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage({ viewport });
    
    // load the local file using a valid file URL
    const fileUrl = pathToFileURL(path.resolve(htmlPath)).href;
    await page.goto(fileUrl, { waitUntil: "load", timeout: 30000 });
    
    // If the HTML is a SingleFile/bundled archive, wait for the unpacker to finish
    try {
      await page.waitForSelector("#__bundler_loading", { state: "detached", timeout: 10000 });
    } catch (e) {
      // not a bundled archive or already detached
    }

    // Allow dynamic layout and fonts to settle
    await page.waitForTimeout(1000);
    try {
      await page.evaluate(() => document.fonts.ready);
    } catch (e) {}

    const nodes = await page.evaluate(() => {
      const out = [];
      const walk = (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || cs.display === "none" || cs.visibility === "hidden") {
          for (const c of el.children) walk(c);
          return;
        }
        // only capture leaf-ish text nodes + boxes you care about
        const directText = [...el.childNodes]
          .filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(" ").trim();

        if (directText && directText.length >= 2) {
          // Section detection logic
          let section = 'Page';
          let cur = el.parentElement;
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
            const ds = cur.dataset;
            const dval = ds?.section || ds?.name || ds?.block;
            if (dval && dval.length > 1) { section = dval; break; }
            cur = cur.parentElement;
            d++;
          }

          out.push({
            section,
            tag: el.tagName.toLowerCase(),
            text: directText,
            x: Math.round(r.x), y: Math.round(r.y),
            width: Math.round(r.width), height: Math.round(r.height),
            fontFamily: cs.fontFamily,
            fontSize: parseFloat(cs.fontSize),
            fontWeight: cs.fontWeight,
            lineHeight: cs.lineHeight,
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            borderRadius: cs.borderTopLeftRadius,
            paddingTop: cs.paddingTop, paddingLeft: cs.paddingLeft,
            marginTop: cs.marginTop,
          });
        }
        for (const c of el.children) walk(c);
      };
      walk(document.body);
      return out;
    });

    return normalize(nodes);
  } finally {
    await browser.close();
  }
}

export async function getSourceSpec(input) {
  if (input.type === "figma") return extractFigmaSpec(input.fileKey, input.nodeId);
  if (input.type === "html")  return extractHtmlSpec(input.htmlPath);
}

async function extractFigmaSpec(fileKey, nodeId) {
  throw new Error("extractFigmaSpec is not implemented yet.");
}
