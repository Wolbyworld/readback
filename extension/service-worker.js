const SCREENSHOT_QUALITY = 68;
const MAX_TEXT_LENGTH = 28000;
const TAB_STATE_PREFIX = "readbackTab:";

function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  const useBrowserManagedOpening = !chrome.sidePanel.open;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: useBrowserManagedOpening }).catch(() => {});
}

configureSidePanel();
chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "READBACK_EXTRACT_PAGE") return false;

  extractActivePage(message.tabId)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: friendlyExtractionError(error) }));
  return true;
});

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
    args: [MAX_TEXT_LENGTH]
  });

  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: SCREENSHOT_QUALITY
    });
  } catch {
    // Text-only quizzes still work when a browser blocks capture.
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

function collectReadablePage(maxTextLength) {
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
  };

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const primary = document.querySelector("article,main,[role='main']") || document.body;
  const blocks = [...primary.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,figcaption,td,th,dt,dd")]
    .filter(isVisible)
    .filter((node) => !node.closest("nav,footer,form,[aria-hidden='true'],[hidden]"))
    .map((node) => clean(node.textContent))
    .filter((text) => text.length >= 24);
  let text = blocks.join("\n");
  if (text.length < 500) text = clean(primary.innerText);
  text = text.slice(0, maxTextLength);

  const candidates = [...document.images]
    .filter(isVisible)
    .map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        image,
        area: rect.width * rect.height,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        alt: clean(image.alt || image.getAttribute("aria-label") || image.closest("figure")?.querySelector("figcaption")?.textContent)
      };
    })
    .filter(({ area, width, height }) => area >= 30000 && width >= 160 && height >= 100)
    .sort((a, b) => b.area - a.area)
    .slice(0, 3);

  const images = [];
  for (const candidate of candidates) {
    try {
      const naturalWidth = candidate.image.naturalWidth || candidate.width;
      const naturalHeight = candidate.image.naturalHeight || candidate.height;
      const scale = Math.min(1, 1000 / Math.max(naturalWidth, naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(naturalHeight * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(candidate.image, 0, 0, canvas.width, canvas.height);
      images.push({
        ref: `image_${images.length + 1}`,
        alt: candidate.alt || `Meaningful page image ${images.length + 1}`,
        dataUrl: canvas.toDataURL("image/jpeg", 0.76)
      });
    } catch {
      // Cross-origin images can taint a canvas. The viewport capture remains available.
    }
  }

  const diagrams = [...document.querySelectorAll("svg")]
    .filter(isVisible)
    .map((svg, index) => {
      const rect = svg.getBoundingClientRect();
      const label = clean(svg.getAttribute("aria-label") || svg.querySelector("title")?.textContent || svg.closest("figure")?.querySelector("figcaption")?.textContent);
      const visibleText = clean(svg.textContent).slice(0, 900);
      return { ref: `diagram_${index + 1}`, label, visibleText, area: rect.width * rect.height };
    })
    .filter((item) => item.area >= 24000 && (item.label || item.visibleText))
    .sort((a, b) => b.area - a.area)
    .slice(0, 3)
    .map(({ area: _area, ...item }) => item);

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
  return { code: "EXTRACTION_FAILED", message };
}
