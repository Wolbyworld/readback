export function evidencePassages(evidence) {
  if (typeof evidence !== "string") return [];
  const parts = /^Evidence A:/i.test(evidence)
    ? evidence.replace(/^Evidence A:\s*/i, "").split(/;\s*Evidence B:\s*/i)
    : [evidence];
  return [...new Set(parts
    .filter((part) => !/^Visual:/i.test(part.trim()))
    .map((part) => part.trim().replace(/^["“‘']+|["”’']+[.!?]?$/g, "").trim())
    .filter((part) => part.length >= 12 && part.length <= 1000))].slice(0, 2);
}

// This function runs in the page's isolated extension world. Keep it self-contained.
export function highlightSourceEvidence(passages, expectedUrl) {
  if (location.href !== expectedUrl) return { status: "page_changed", found: 0 };
  const highlightName = "readback-source-evidence";
  globalThis.__readbackClearEvidence?.();
  if (!CSS.highlights || typeof Highlight !== "function") return { status: "unsupported", found: 0 };

  const normalize = (value) => value.toLowerCase()
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2014]/g, "-").replace(/\s/g, " ");
  const noise = "script,style,noscript,nav,header,footer,aside,form,dialog,button,input,textarea,select,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],[role='navigation']";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const text = [];
  const positions = [];
  const visibility = new Map();
  const blocks = new Map();
  const isVisible = (element) => {
    if (!element || element === document.documentElement) return true;
    if (!visibility.has(element)) {
      const style = getComputedStyle(element);
      visibility.set(element, style.display !== "none" && style.visibility !== "hidden"
        && style.visibility !== "collapse" && Number(style.opacity) !== 0 && isVisible(element.parentElement));
    }
    return visibility.get(element);
  };
  const blockFor = (element) => {
    if (!blocks.has(element)) {
      const display = getComputedStyle(element).display;
      blocks.set(element, element === document.body || !["inline", "contents"].includes(display)
        ? element : blockFor(element.parentElement));
    }
    return blocks.get(element);
  };
  let previousBlock = null;
  let node;
  // Bound work on very large pages. Never search hidden controls or page scripts.
  while ((node = walker.nextNode()) && text.length < 300000) {
    const parent = node.parentElement;
    if (!parent || parent.closest(noise) || !isVisible(parent)) continue;
    const block = blockFor(parent);
    if (previousBlock && block !== previousBlock && text.at(-1) !== " ") {
      text.push(" ");
      positions.push(null);
    }
    previousBlock = block;
    for (let offset = 0; offset < node.length && text.length < 300000; offset += 1) {
      for (const character of normalize(node.data[offset])) {
        if (character === " " && text.at(-1) === " ") continue;
        text.push(character);
        positions.push({ node, offset });
      }
    }
  }
  const haystack = text.join("");
  const ranges = [];
  for (const passage of passages) {
    const needle = normalize(passage).replace(/ +/g, " ").trim();
    let offset = -1;
    while ((offset = haystack.indexOf(needle, offset + 1)) !== -1) {
      // Do not accept a phrase that is only part of a longer word.
      if (/[\p{L}\p{N}]/u.test(haystack[offset - 1] || "") && /[\p{L}\p{N}]/u.test(needle[0])) continue;
      if (/[\p{L}\p{N}]/u.test(haystack[offset + needle.length] || "") && /[\p{L}\p{N}]/u.test(needle.at(-1))) continue;
      const start = positions[offset];
      const end = positions[offset + needle.length - 1];
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      if (!Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) continue;
      ranges.push(range);
      break;
    }
  }
  if (!ranges.length) return { status: "not_found", found: 0 };

  const style = document.createElement("style");
  style.textContent = "::highlight(readback-source-evidence) { background-color: #ffe066; color: #171717; }";
  document.documentElement.append(style);
  CSS.highlights.set(highlightName, new Highlight(...ranges));
  const clear = () => {
    clearTimeout(timer);
    CSS.highlights.delete(highlightName);
    style.remove();
    if (globalThis.__readbackClearEvidence === clear) delete globalThis.__readbackClearEvidence;
  };
  const timer = setTimeout(clear, 45000);
  globalThis.__readbackClearEvidence = clear;
  ranges[0].startContainer.parentElement.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = ranges[0].getBoundingClientRect();
  window.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: "instant" });
  return { status: "found", found: ranges.length, total: passages.length };
}

export async function findSourceEvidence(browser, { tabId, pageUrl, evidence }) {
  const passages = evidencePassages(evidence);
  if (!passages.length) return { status: "no_text", found: 0 };
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.url !== pageUrl) return { status: "page_changed", found: 0 };
    const [{ result }] = await browser.scripting.executeScript({
      target: { tabId },
      func: highlightSourceEvidence,
      args: [passages, pageUrl]
    });
    return result || { status: "unavailable", found: 0 };
  } catch {
    return { status: "unavailable", found: 0 };
  }
}
