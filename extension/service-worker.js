import { apiKeyStatus, configureStorageAccess, KeyStorageError, readApiKey, removeApiKey, saveApiKey } from "./key-storage.js";
import { createQuizWithOpenAI, ReadbackApiError, validateGenerationInput } from "./openai-request.js";

const SCREENSHOT_QUALITY = 68;
const MAX_TEXT_LENGTH = 28000;
const MAX_VISUALS = 3;
const MAX_VISUAL_EDGE = 1000;
const MAX_VISUAL_DATA_URL_LENGTH = 1_500_000;
const TAB_STATE_PREFIX = "readbackTab:";
const generationControllers = new Map();
const storageReady = configureStorageAccess(chrome.storage);
storageReady.catch(() => {});

function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  const useBrowserManagedOpening = !chrome.sidePanel.open;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: useBrowserManagedOpening }).catch(() => {});
}

configureSidePanel();
chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
  configureStorageAccess(chrome.storage).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  configureSidePanel();
  configureStorageAccess(chrome.storage).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let task;
  try {
    task = routeMessage(message, sender);
  } catch (error) {
    sendResponse({ ok: false, error: friendlyWorkerError(error) });
    return false;
  }
  if (!task) return false;
  task
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: friendlyWorkerError(error) }));
  return true;
});

function routeMessage(message, sender) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (sender?.id && sender.id !== chrome.runtime.id) return null;

  switch (message.type) {
    case "READBACK_EXTRACT_PAGE":
      assertOnlyKeys(message, ["type", "tabId"]);
      if (!Number.isInteger(message.tabId) || message.tabId < 1) throw new ReadbackApiError("INVALID_REQUEST", "The page request was not valid.", 400);
      return extractActivePage(message.tabId);
    case "READBACK_KEY_STATUS":
      assertOnlyKeys(message, ["type"]);
      return storageReady.then(() => apiKeyStatus(chrome.storage));
    case "READBACK_SAVE_API_KEY":
      assertOnlyKeys(message, ["type", "key", "mode"]);
      return storageReady.then(() => saveApiKey(chrome.storage, message.key, message.mode));
    case "READBACK_REMOVE_API_KEY":
      assertOnlyKeys(message, ["type"]);
      return storageReady.then(() => removeApiKey(chrome.storage));
    case "READBACK_GENERATE_QUIZ":
      assertOnlyKeys(message, ["type", "requestId", "page", "settings"]);
      assertRequestId(message.requestId);
      return generateQuiz(message);
    case "READBACK_CANCEL_GENERATION":
      assertOnlyKeys(message, ["type", "requestId"]);
      assertRequestId(message.requestId);
      generationControllers.get(message.requestId)?.abort();
      return Promise.resolve({ cancelled: true });
    default:
      return null;
  }
}

function assertOnlyKeys(message, allowed) {
  if (Object.keys(message).some((key) => !allowed.includes(key))) {
    throw new ReadbackApiError("INVALID_REQUEST", "The Readback request was not valid.", 400);
  }
}

function assertRequestId(requestId) {
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 80 || !/^[A-Za-z0-9-]+$/.test(requestId)) {
    throw new ReadbackApiError("INVALID_REQUEST", "The quiz request identifier was not valid.", 400);
  }
}

async function generateQuiz(message) {
  const input = validateGenerationInput({ page: message.page, settings: message.settings });
  await storageReady;
  const stored = await readApiKey(chrome.storage);
  if (!stored.key) throw new ReadbackApiError("MISSING_API_KEY", "Add an OpenAI API key before you make a quiz.", 401);

  generationControllers.get(message.requestId)?.abort();
  const controller = new AbortController();
  generationControllers.set(message.requestId, controller);
  try {
    const quiz = await createQuizWithOpenAI(input, stored.key, { signal: controller.signal });
    return { quiz };
  } finally {
    if (generationControllers.get(message.requestId) === controller) generationControllers.delete(message.requestId);
  }
}

chrome.action.onClicked.addListener((tab) => {
  const request = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    title: tab.title,
    url: tab.url,
    createdAt: Date.now()
  };

  // Chrome only permits sidePanel.open while this handler still has the
  // toolbar click's user gesture. Do not await storage before opening it.
  if (chrome.sidePanel?.open) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
      // setPanelBehavior handles opening on browsers that reject an explicit open call.
    });
  }

  chrome.storage.session.set({ readbackGenerateRequest: request }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading") return;
  chrome.storage.session.remove(`${TAB_STATE_PREFIX}${tabId}`).catch(() => {});
  chrome.runtime.sendMessage({ type: "READBACK_TAB_RESET", tabId, tab: { title: tab.title, url: tab.url } }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`${TAB_STATE_PREFIX}${tabId}`).catch(() => {});
});

async function extractActivePage(requestedTabId) {
  let tab;
  if (Number.isInteger(requestedTabId)) tab = await chrome.tabs.get(requestedTabId);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active page was found.");

  const restricted = /^(chrome|vivaldi|edge|about|devtools|chrome-extension):/.test(tab.url || "");
  if (restricted) throw new Error("This browser page does not allow extensions to read its content.");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectReadablePage,
    args: [MAX_TEXT_LENGTH, {
      maxVisuals: MAX_VISUALS,
      maxVisualEdge: MAX_VISUAL_EDGE,
      maxDataUrlLength: MAX_VISUAL_DATA_URL_LENGTH
    }]
  });

  let screenshot = null;
  if (!result.images.length) {
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality: SCREENSHOT_QUALITY
      });
    } catch {
      // Text-only quizzes still work when a browser blocks capture.
    }
  }

  return {
    title: result.title || tab.title || "Untitled page",
    url: tab.url || "",
    text: result.text,
    diagrams: result.diagrams,
    images: result.images,
    screenshot
  };
}

async function collectReadablePage(maxTextLength, limits) {
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const structuralNoise = "nav,header,footer,aside,form,dialog,[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary'],[role='dialog'],[aria-hidden='true'],[hidden]";
  const decorativeWords = /(^|[\s_:/.-])(advert(?:isement)?|avatar|badge|banner|brand|cookie|decor(?:ation|ative)?|emoji|icon|logo|masthead|nav|pixel|placeholder|profile|promo|sponsor|spacer|tracking)([\s_:/.-]|$)/i;
  const sourceNoise = /(?:doubleclick|adservice|adserver|analytics|pixel|spacer|tracking)/i;

  const nearbyDescriptor = (element) => {
    const parts = [];
    let node = element;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      parts.push(node.id, typeof node.className === "string" ? node.className : "", node.getAttribute?.("role"), node.getAttribute?.("aria-label"));
    }
    return clean(parts.join(" "));
  };

  const captionFor = (element) => {
    const caption = element.closest("figure")?.querySelector("figcaption");
    return caption && isVisible(caption) ? clean(caption.textContent).slice(0, 300) : "";
  };

  const labelFor = (element, caption) => clean(
    element.getAttribute("alt") ||
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    caption
  ).slice(0, 300);

  const isUsefulVisual = (element) => {
    if (!isVisible(element) || element.closest(structuralNoise)) return false;
    if (["none", "presentation"].includes(element.getAttribute("role"))) return false;

    const rect = element.getBoundingClientRect();
    const ratio = rect.width / rect.height;
    if (rect.width < 160 || rect.height < 100 || rect.width * rect.height < 30000 || ratio < 0.15 || ratio > 6.5) return false;

    const tag = element.tagName.toLowerCase();
    const caption = captionFor(element);
    const label = labelFor(element, caption);
    const visibleText = tag === "svg" ? clean(element.textContent) : "";
    const descriptor = nearbyDescriptor(element);
    const source = tag === "img" ? clean(element.currentSrc || element.src) : "";
    if (decorativeWords.test(descriptor) || sourceNoise.test(source)) return false;
    if (!label && !visibleText) return false;

    if (tag === "img") {
      if ((element.naturalWidth > 0 && element.naturalWidth < 32) || (element.naturalHeight > 0 && element.naturalHeight < 32)) return false;
      if (!element.complete || element.naturalWidth < 1 || element.naturalHeight < 1) return false;
    }
    return true;
  };

  const scoreVisual = (element, index) => {
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const caption = captionFor(element);
    const label = labelFor(element, caption);
    return {
      element,
      index,
      tag,
      caption,
      label,
      visibleText: tag === "svg" ? clean(element.textContent).slice(0, 900) : "",
      score: (tag === "svg" || tag === "canvas" ? 40 : 0) + (caption ? 30 : 0) + (label ? 20 : 0) + (element.closest("article,main,[role='main']") ? 10 : 0) + Math.min(20, Math.round(rect.width * rect.height / 50000))
    };
  };

  const makeOutputCanvas = (width, height) => {
    const scale = Math.min(1, limits.maxVisualEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas, context };
  };

  const boundedDataUrl = (source) => {
    let current = source;
    for (const shrink of [1, 0.82, 0.66]) {
      if (shrink !== 1) {
        const resized = document.createElement("canvas");
        resized.width = Math.max(1, Math.round(source.width * shrink));
        resized.height = Math.max(1, Math.round(source.height * shrink));
        const context = resized.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, resized.width, resized.height);
        context.drawImage(source, 0, 0, resized.width, resized.height);
        current = resized;
      }
      for (const quality of [0.76, 0.62, 0.48]) {
        const dataUrl = current.toDataURL("image/jpeg", quality);
        if (dataUrl.length <= limits.maxDataUrlLength) return dataUrl;
      }
    }
    return null;
  };

  const rasterize = async ({ element, tag }) => {
    const rect = element.getBoundingClientRect();
    let width = tag === "img" ? element.naturalWidth : element.width;
    let height = tag === "img" ? element.naturalHeight : element.height;
    if (!Number.isFinite(Number(width)) || Number(width) < 1) width = rect.width;
    if (!Number.isFinite(Number(height)) || Number(height) < 1) height = rect.height;

    if (tag !== "svg") {
      const { canvas, context } = makeOutputCanvas(Number(width), Number(height));
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      return boundedDataUrl(canvas);
    }

    width = rect.width;
    height = rect.height;
    const clone = element.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(Math.round(width)));
    clone.setAttribute("height", String(Math.round(height)));
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const originals = [element, ...element.querySelectorAll("*")];
    const copies = [clone, ...clone.querySelectorAll("*")];
    const styleProperties = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "opacity", "font-family", "font-size", "font-style", "font-weight", "text-anchor", "dominant-baseline"];
    copies.forEach((node, index) => {
      [...node.attributes].forEach((attribute) => {
        const externalValue = /(?:https?:|data:|javascript:)/i.test(attribute.value) || /url\s*\(\s*(?!["']?#)/i.test(attribute.value);
        if (/^on/i.test(attribute.name) || attribute.name === "style" || externalValue) node.removeAttribute(attribute.name);
        if ((attribute.name === "href" || attribute.name.endsWith(":href")) && !attribute.value.startsWith("#")) node.removeAttribute(attribute.name);
      });
      const computed = getComputedStyle(originals[index]);
      for (const property of styleProperties) {
        const value = computed.getPropertyValue(property);
        if (value && !/(?:https?:|data:|javascript:)/i.test(value) && !/url\s*\(\s*(?!["']?#)/i.test(value)) node.style.setProperty(property, value);
      }
    });
    clone.querySelectorAll("script,foreignObject,animate,animateMotion,animateTransform,set").forEach((node) => node.remove());

    const serialized = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([serialized], { type: "image/svg+xml" });
    let drawable;
    let dispose = () => {};
    try {
      drawable = await createImageBitmap(blob);
      dispose = () => drawable.close();
    } catch {
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.src = objectUrl;
      try {
        await image.decode();
        drawable = image;
        dispose = () => URL.revokeObjectURL(objectUrl);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
    }
    try {
      const { canvas, context } = makeOutputCanvas(width, height);
      context.drawImage(drawable, 0, 0, canvas.width, canvas.height);
      return boundedDataUrl(canvas);
    } finally {
      dispose();
    }
  };

  const primary = document.querySelector("article,main,[role='main']") || document.body;
  const blocks = [...primary.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,figcaption,td,th,dt,dd")]
    .filter(isVisible)
    .filter((node) => !node.closest("nav,footer,form,[aria-hidden='true'],[hidden]"))
    .map((node) => clean(node.textContent))
    .filter((text) => text.length >= 24);
  let text = blocks.join("\n");
  if (text.length < 500) text = clean(primary.innerText);
  text = text.slice(0, maxTextLength);

  const images = [];
  const diagrams = [];
  const candidates = [...document.querySelectorAll("img,svg,canvas")]
    .filter(isUsefulVisual)
    .map(scoreVisual)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(limits.maxVisuals * 4, limits.maxVisuals));

  for (const candidate of candidates) {
    if (images.length >= limits.maxVisuals) break;
    try {
      const dataUrl = await rasterize(candidate);
      if (!dataUrl) continue;
      const ref = `visual_${images.length + 1}`;
      const fallbackLabel = candidate.tag === "canvas" ? "Page chart" : candidate.tag === "svg" ? "Page diagram" : "Meaningful page image";
      images.push({
        ref,
        alt: candidate.caption || candidate.label || fallbackLabel,
        dataUrl
      });
      if (candidate.tag === "svg" || candidate.tag === "canvas") {
        diagrams.push({ ref, label: candidate.caption || candidate.label || fallbackLabel, visibleText: candidate.visibleText });
      }
    } catch {
      // A cross-origin raster or tainted canvas can fail. Try the next candidate.
    }
  }

  return { title: document.title, text, images, diagrams };
}

function friendlyExtractionError(error) {
  const message = error?.message || String(error);
  if (/Missing host permission|Cannot access contents|must request permission/i.test(message)) {
    return {
      code: "HOST_ACCESS_REQUIRED",
      message: "Readback needs permission to read this website."
    };
  }
  if (/Cannot access|extensions gallery|The extensions gallery|browser page does not allow/i.test(message)) {
    return {
      code: "RESTRICTED_PAGE",
      message: "This page is protected by the browser. Open a normal website and try again."
    };
  }
  return { code: "EXTRACTION_FAILED", message: "Readback could not read this page. Try another page or reload it." };
}

function friendlyWorkerError(error) {
  if (error instanceof ReadbackApiError || error instanceof KeyStorageError) {
    return { code: error.code, message: error.message };
  }
  return friendlyExtractionError(error);
}
