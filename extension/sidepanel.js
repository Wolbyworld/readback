const API_URL = "http://127.0.0.1:41739/api/quiz";
const DEFAULT_SETTINGS = { questionCount: 5, optionCount: 4, level: "apply" };
const LETTERS = ["A", "B", "C", "D", "E"];
const TAB_STATE_PREFIX = "readbackTab:";
const MEDIA_DB_NAME = "readback-tab-media";
const MEDIA_STORE_NAME = "tabMedia";
const LEVEL_HELP = {
  recall: "Check facts stated on the page.",
  explain: "Test meaning and connections.",
  apply: "Use the ideas in a new case."
};

const state = {
  screen: "start",
  settings: { ...DEFAULT_SETTINGS },
  tabId: null,
  pageTitle: "Current page",
  pageUrl: "",
  quiz: null,
  media: {},
  index: 0,
  answers: [],
  animating: false,
  abortController: null,
  requestedTabId: null,
  lastRequestId: null,
  switchRevision: 0
};

const $ = (selector) => document.querySelector(selector);
const screens = {
  start: $("#startScreen"),
  access: $("#accessScreen"),
  loading: $("#loadingScreen"),
  quiz: $("#quizScreen"),
  results: $("#resultsScreen"),
  error: $("#errorScreen")
};

function tabStateKey(tabId) {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

function freshTabState(tabId, tab = {}) {
  return {
    tabId,
    pageTitle: tab.title || "Current page",
    pageUrl: tab.url || "",
    screen: "start",
    quiz: null,
    media: {},
    index: 0,
    answers: [],
    animating: false,
    abortController: null,
    requestedTabId: null
  };
}

function showScreen(name) {
  state.screen = name;
  Object.entries(screens).forEach(([key, element]) => element.classList.toggle("is-active", key === name));
  const quizTitle = state.quiz?.title;
  $("#headerMeta").textContent = ["quiz", "results"].includes(name) && quizTitle ? quizTitle : state.pageTitle;
  $(".tab-marker").classList.toggle("is-saved", Boolean(state.quiz));
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("readbackSettings");
  state.settings = { ...DEFAULT_SETTINGS, ...(stored.readbackSettings || {}) };
  updateSettingsUI();
}

function updateSettingsUI() {
  for (const [name, value] of Object.entries(state.settings)) {
    const input = document.querySelector(`#quickSettings input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }
  $("#levelHelp").textContent = LEVEL_HELP[state.settings.level];
}

async function saveSettingsFromForm(formElement) {
  const form = new FormData(formElement);
  state.settings = {
    questionCount: Number(form.get("questionCount")),
    optionCount: Number(form.get("optionCount")),
    level: String(form.get("level"))
  };
  updateSettingsUI();
  await chrome.storage.local.set({ readbackSettings: state.settings });
}

function openMediaDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        request.result.createObjectStore(MEDIA_STORE_NAME, { keyPath: "tabId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readTabMedia(tabId) {
  try {
    const database = await openMediaDatabase();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(MEDIA_STORE_NAME).objectStore(MEDIA_STORE_NAME).get(tabId);
      request.onsuccess = () => resolve(request.result?.media || {});
      request.onerror = () => reject(request.error);
    });
  } catch {
    return {};
  }
}

async function writeTabMedia(tabId, media) {
  try {
    const database = await openMediaDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
      transaction.objectStore(MEDIA_STORE_NAME).put({ tabId, media });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Text questions and saved answers still work when media storage is unavailable.
  }
}

async function deleteTabMedia(tabId) {
  try {
    const database = await openMediaDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
      transaction.objectStore(MEDIA_STORE_NAME).delete(tabId);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // There may be no media record to remove.
  }
}

async function saveCurrentTabState() {
  if (!Number.isInteger(state.tabId)) return;
  const record = {
    pageTitle: state.pageTitle,
    pageUrl: state.pageUrl,
    screen: state.screen === "loading" ? "start" : state.screen,
    quiz: state.quiz,
    index: state.index,
    answers: state.answers
  };
  await Promise.all([
    chrome.storage.session.set({ [tabStateKey(state.tabId)]: record }),
    writeTabMedia(state.tabId, state.media)
  ]);
}

async function loadTabState(tabId, tab = {}) {
  const key = tabStateKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const record = stored[key];
  if (!record) return freshTabState(tabId, tab);
  const media = record.quiz ? await readTabMedia(tabId) : {};
  return {
    ...freshTabState(tabId, tab),
    ...record,
    tabId,
    pageTitle: tab.title || record.pageTitle || "Current page",
    pageUrl: tab.url || record.pageUrl || "",
    screen: record.screen === "loading" ? "start" : record.screen,
    media
  };
}

async function activateTab(tabId, tab = {}) {
  if (!Number.isInteger(tabId)) return;
  const revision = ++state.switchRevision;

  if (state.tabId === tabId) {
    if (tab.title) state.pageTitle = tab.title;
    if (tab.url) state.pageUrl = tab.url;
    renderCurrentState();
    return;
  }

  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
    state.screen = "start";
  }
  await saveCurrentTabState();

  if (!tab.title) {
    try {
      tab = { ...tab, ...(await chrome.tabs.get(tabId)) };
    } catch {
      // Tab identity remains available through stored state or extraction.
    }
  }

  const nextState = await loadTabState(tabId, tab);
  if (revision !== state.switchRevision) return;
  Object.assign(state, nextState);
  renderCurrentState();
}

async function resetTab(tabId, tab = {}) {
  await Promise.all([
    chrome.storage.session.remove(tabStateKey(tabId)),
    deleteTabMedia(tabId)
  ]);
  if (state.tabId !== tabId) return;
  const nextState = freshTabState(tabId, tab);
  Object.assign(state, nextState);
  renderCurrentState();
}

function renderCurrentState() {
  $("#pageTitle").textContent = state.pageTitle;
  $("#pageStatus").textContent = state.quiz ? "SAVED" : "READY";
  if (state.screen === "quiz" && state.quiz) renderQuestion();
  else if (state.screen === "results" && state.quiz) buildResults();
  else if (!["start", "access", "error"].includes(state.screen)) state.screen = "start";
  showScreen(state.screen);
}

async function generateQuiz() {
  const generationTabId = state.requestedTabId ?? state.tabId;
  if (!Number.isInteger(generationTabId)) {
    showError(new Error("No active page was found."));
    return;
  }

  state.requestedTabId = null;
  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;
  showScreen("loading");
  cycleLoadingMessage();

  try {
    const extraction = await chrome.runtime.sendMessage({ type: "READBACK_EXTRACT_PAGE", tabId: generationTabId });
    if (!extraction?.ok) {
      const extractionError = new Error(extraction?.error?.message || extraction?.error || "The page could not be read.");
      extractionError.code = extraction?.error?.code;
      throw extractionError;
    }
    if ((extraction.payload?.text || "").length < 250) {
      throw new Error("This page does not have enough readable text for a useful quiz.");
    }

    state.pageTitle = extraction.payload.title || state.pageTitle;
    state.pageUrl = extraction.payload.url || state.pageUrl;
    state.media = buildMediaMap(extraction.payload);
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: extraction.payload, settings: state.settings }),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `The local service returned ${response.status}.`);
    if (state.tabId !== generationTabId) return;

    state.quiz = payload.quiz;
    state.index = 0;
    state.answers = Array(state.quiz.questions.length).fill(null);
    state.animating = false;
    state.screen = "quiz";
    renderQuestion();
    showScreen("quiz");
    await saveCurrentTabState();
  } catch (error) {
    if (error.name === "AbortError") {
      if (state.tabId === generationTabId) showScreen("start");
      return;
    }
    if (state.tabId === generationTabId) showError(error);
  } finally {
    if (state.abortController === controller) state.abortController = null;
  }
}

function buildMediaMap(page) {
  const map = {};
  if (page.screenshot) map.page_view = { dataUrl: page.screenshot, caption: "Visible part of the page" };
  for (const image of page.images || []) {
    if (image.dataUrl) map[image.ref] = { dataUrl: image.dataUrl, caption: image.alt };
  }
  return map;
}

function renderQuestion() {
  const question = state.quiz.questions[state.index];
  const total = state.quiz.questions.length;
  const progress = Math.round(((state.index + 1) / total) * 100);

  $("#progressLabel").textContent = `Question ${state.index + 1} of ${total}`;
  $("#progressPercent").textContent = `${progress}%`;
  $("#progressBar").style.width = `${progress}%`;
  $("#cardNumber").textContent = String(state.index + 1).padStart(2, "0");
  $("#cardLevel").textContent = state.settings.level.toUpperCase();
  $("#questionText").textContent = question.prompt;

  const media = state.media[question.image_ref];
  $("#questionFigure").classList.toggle("is-hidden", !media);
  if (media) {
    $("#questionImage").src = media.dataUrl;
    $("#questionImage").alt = question.image_alt || media.caption || "Page image used for this question";
    $("#questionImageCaption").textContent = question.image_alt || media.caption || "Page image";
  } else {
    $("#questionImage").removeAttribute("src");
    $("#questionImage").alt = "";
  }

  $("#answers").replaceChildren(...question.options.map((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.answer = String(index);
    button.classList.toggle("is-selected", state.answers[state.index] === index);
    const letter = document.createElement("span");
    letter.textContent = LETTERS[index];
    button.append(letter, document.createTextNode(option));
    return button;
  }));

  $("#choiceStatus").textContent = state.answers[state.index] == null ? "Choose one answer." : "Answer saved.";
  $("#backButton").disabled = state.index === 0 || state.animating;
  $("#nextButton").disabled = state.answers[state.index] == null || state.animating;
  $("#nextButton").textContent = state.index === total - 1 ? "Check answers →" : "Next →";
}

function chooseAnswer(index) {
  if (state.animating || state.screen !== "quiz") return;
  state.answers[state.index] = index;
  [...$("#answers").children].forEach((button, answerIndex) => button.classList.toggle("is-selected", index === answerIndex));
  $("#choiceStatus").textContent = "Answer saved.";
  $("#nextButton").disabled = false;
  saveCurrentTabState();
}

function moveQuestion(nextIndex, direction) {
  if (state.animating || nextIndex < 0 || nextIndex >= state.quiz.questions.length) return;
  state.animating = true;
  const card = $("#questionCard");
  card.classList.add(`is-leaving-${direction}`);
  window.setTimeout(() => {
    state.index = nextIndex;
    card.className = `question-card pre-enter-${direction}`;
    renderQuestion();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      card.classList.remove(`pre-enter-${direction}`);
      state.animating = false;
      renderQuestion();
      saveCurrentTabState();
    }));
  }, 130);
}

function nextQuestion() {
  if (state.answers[state.index] == null || state.animating) return;
  if (state.index < state.quiz.questions.length - 1) moveQuestion(state.index + 1, "forward");
  else renderResults();
}

function previousQuestion() {
  if (state.index > 0) moveQuestion(state.index - 1, "back");
}

function buildResults() {
  const correct = state.answers.filter((answer, index) => answer === state.quiz.questions[index].answer_index).length;
  const total = state.quiz.questions.length;
  $("#scoreValue").textContent = `${correct}/${total}`;
  $("#scoreMessage").textContent = scoreMessage(correct / total);
  $("#resultModel").textContent = (state.quiz.model || "LUNA").replace("gpt-5.6-", "").toUpperCase();
  $("#reviewDetails").open = false;
  $("#reviewList").replaceChildren(...state.quiz.questions.map((question, index) => {
    const item = document.createElement("article");
    item.className = "review-item";
    const isCorrect = state.answers[index] === question.answer_index;
    const chosen = question.options[state.answers[index]];
    const answer = question.options[question.answer_index];
    item.innerHTML = `<header><span>QUESTION ${String(index + 1).padStart(2, "0")}</span><b class="${isCorrect ? "is-correct" : "is-wrong"}">${isCorrect ? "CORRECT" : "REVIEW"}</b></header>`;
    const heading = document.createElement("h3");
    heading.textContent = question.prompt;
    const response = document.createElement("p");
    response.textContent = isCorrect ? `Your answer: ${chosen}` : `Your answer: ${chosen}. Correct answer: ${answer}.`;
    const explanation = document.createElement("p");
    explanation.textContent = question.explanation;
    const evidence = document.createElement("p");
    evidence.className = "evidence";
    evidence.textContent = question.evidence;
    item.append(heading, response, explanation, evidence);
    return item;
  }));
}

function renderResults() {
  buildResults();
  showScreen("results");
  saveCurrentTabState();
}

function retryQuiz() {
  state.index = 0;
  state.answers = Array(state.quiz.questions.length).fill(null);
  $("#questionCard").className = "question-card";
  renderQuestion();
  showScreen("quiz");
  saveCurrentTabState();
}

function showError(error) {
  if (error?.code === "HOST_ACCESS_REQUIRED") {
    $("#accessNote").textContent = "Your browser will show a permission prompt. Readback still sends page content only when you start a quiz.";
    showScreen("access");
    return;
  }
  const message = error?.message || "Unknown error.";
  const serviceDown = /Failed to fetch|NetworkError|Load failed/i.test(message);
  $("#errorTitle").textContent = serviceDown ? "Start the Readback service." : "This quiz needs another try.";
  $("#errorMessage").textContent = serviceDown
    ? "The private local service is not running. Open start-readback.command, then try again."
    : message;
  showScreen("error");
}

function requestWebsiteAccess() {
  const button = $("#accessButton");
  button.disabled = true;
  $("#accessNote").textContent = "Waiting for your browser…";
  const request = chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
  request.then((granted) => {
    button.disabled = false;
    if (!granted) {
      $("#accessNote").textContent = "Access was not allowed. You can continue without changing anything.";
      return;
    }
    generateQuiz();
  }).catch((error) => {
    button.disabled = false;
    $("#accessNote").textContent = error?.message || "The browser could not request access.";
  });
}

function cycleLoadingMessage() {
  const messages = ["Finding the ideas worth testing…", "Separating signal from page noise…", "Writing plausible wrong answers…", "Checking every answer against the page…"];
  let index = 0;
  $("#loadingMessage").textContent = messages[0];
  const timer = window.setInterval(() => {
    if (state.screen !== "loading") return clearInterval(timer);
    index = (index + 1) % messages.length;
    $("#loadingMessage").textContent = messages[index];
  }, 1800);
}

function scoreMessage(ratio) {
  if (ratio === 1) return "You caught every important point.";
  if (ratio >= .8) return "Strong first-pass understanding.";
  if (ratio >= .6) return "Good base. Review the missed ideas.";
  return "The page deserves one more pass.";
}

async function consumeGenerateRequest(request) {
  if (!request || request.id === state.lastRequestId || Date.now() - request.createdAt > 15000) return;
  state.lastRequestId = request.id;
  await activateTab(request.tabId, { title: request.title, url: request.url });
  state.requestedTabId = request.tabId;
  await chrome.storage.session.remove("readbackGenerateRequest");
  generateQuiz();
}

$("#quickSettings").addEventListener("change", (event) => saveSettingsFromForm(event.currentTarget));
$("#generateButton").addEventListener("click", generateQuiz);
$("#accessButton").addEventListener("click", requestWebsiteAccess);
$("#accessHomeButton").addEventListener("click", () => showScreen("start"));
$("#cancelButton").addEventListener("click", () => state.abortController?.abort());
$("#answers").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-answer]");
  if (button) chooseAnswer(Number(button.dataset.answer));
});
$("#backButton").addEventListener("click", previousQuestion);
$("#nextButton").addEventListener("click", nextQuestion);
$("#retryButton").addEventListener("click", retryQuiz);
$("#newQuizButton").addEventListener("click", () => resetTab(state.tabId));
$("#errorRetryButton").addEventListener("click", generateQuiz);
$("#errorHomeButton").addEventListener("click", () => showScreen("start"));

document.addEventListener("keydown", (event) => {
  if (state.screen !== "quiz" || event.metaKey || event.ctrlKey || event.altKey) return;
  if (/^[1-5]$/.test(event.key)) chooseAnswer(Number(event.key) - 1);
  if (event.key === "ArrowRight") nextQuestion();
  if (event.key === "ArrowLeft") previousQuestion();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && changes.readbackGenerateRequest?.newValue) {
    consumeGenerateRequest(changes.readbackGenerateRequest.newValue);
  }
});

chrome.tabs.onActivated?.addListener(({ tabId }) => activateTab(tabId));
chrome.runtime.onMessage?.addListener((message) => {
  if (message?.type === "READBACK_TAB_RESET") resetTab(message.tabId, message.tab);
});

async function initialize() {
  await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await activateTab(tab?.id, tab || {});
  const stored = await chrome.storage.session.get("readbackGenerateRequest");
  await consumeGenerateRequest(stored.readbackGenerateRequest);
}

initialize();
