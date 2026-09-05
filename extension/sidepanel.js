import { createGenerationKeepAlive } from "./generation-lifecycle.js";
import { evidencePassages } from "./source-evidence.js";

const DEFAULT_SETTINGS = { questionCount: 5, optionCount: 4, level: "apply" };
const LETTERS = ["A", "B", "C", "D", "E"];
const TAB_STATE_PREFIX = "readbackTab:";
const MEDIA_DB_NAME = "readback-tab-media";
const MEDIA_STORE_NAME = "tabMedia";
const LEVEL_HELP = {
  recall: "Check facts stated on the page.",
  explain: "Test meaning and connections.",
  apply: "Use the ideas in a new case.",
  challenge: "Combine two source ideas in a new scenario."
};

const state = {
  screen: "start",
  settings: { ...DEFAULT_SETTINGS },
  tabId: null,
  pageTitle: "Current page",
  pageUrl: "",
  quiz: null,
  quizSettings: null,
  media: {},
  index: 0,
  answers: [],
  animating: false,
  abortController: null,
  requestedTabId: null,
  lastRequestId: null,
  switchRevision: 0,
  generationRequestId: null,
  pendingNewQuiz: null,
  keyStatus: { configured: false, mode: null },
  keyReturnScreen: "start",
  resumeAfterKeySave: false
};

const $ = (selector) => document.querySelector(selector);
let questionTransition = 0;
const generationKeepAlive = createGenerationKeepAlive({
  setTimer: (callback, delay) => window.setInterval(callback, delay),
  clearTimer: (timerId) => window.clearInterval(timerId),
  ping: () => chrome.runtime.sendMessage({ type: "READBACK_KEEP_ALIVE" }).catch(() => {})
});
const screens = {
  key: $("#keyScreen"),
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
    quizSettings: null,
    media: {},
    index: 0,
    answers: [],
    animating: false,
    abortController: null,
    requestedTabId: null,
    pendingNewQuiz: null
  };
}

function showScreen(name) {
  questionTransition += 1;
  state.animating = false;
  $("#questionCard").className = "question-card";
  state.screen = name;
  Object.entries(screens).forEach(([key, element]) => element.classList.toggle("is-active", key === name));
  const quizTitle = state.quiz?.title;
  $("#headerMeta").textContent = name === "key" ? "OpenAI setup" : (["quiz", "results"].includes(name) && quizTitle ? quizTitle : state.pageTitle);
  $(".tab-marker").classList.toggle("is-saved", Boolean(state.quiz));
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("readbackSettings");
  state.settings = { ...DEFAULT_SETTINGS, ...(stored.readbackSettings || {}) };
  updateSettingsUI();
}

async function sendWorkerMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
    const error = new Error("Readback received an invalid response.");
    error.code = "INVALID_RESPONSE";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(typeof response.error?.message === "string" ? response.error.message : "Readback could not complete the request.");
    error.code = typeof response.error?.code === "string" ? response.error.code : "REQUEST_FAILED";
    throw error;
  }
  return response.payload;
}

async function loadKeyStatus() {
  const status = await sendWorkerMessage({ type: "READBACK_KEY_STATUS" });
  state.keyStatus = {
    configured: status?.configured === true,
    mode: ["persistent", "session"].includes(status?.mode) ? status.mode : null
  };
  updateKeyStatusUI();
}

function updateKeyStatusUI() {
  const label = state.keyStatus.mode === "session" ? "OPENAI KEY · THIS SESSION" : "OPENAI KEY · ON THIS DEVICE";
  $("#keyStatus").textContent = state.keyStatus.configured ? label : "OPENAI KEY NEEDED";
}

function openKeySetup({ resumeGeneration = false, message = "" } = {}) {
  if (state.screen !== "key") state.keyReturnScreen = state.screen;
  state.resumeAfterKeySave = resumeGeneration;
  $("#apiKeyInput").value = "";
  $("#keyTitle").textContent = state.keyStatus.configured ? "Replace your OpenAI API key." : "Add your OpenAI API key.";
  $("#keyRemoveButton").classList.toggle("is-hidden", !state.keyStatus.configured);
  $("#keyBackButton").classList.toggle("is-hidden", !state.keyStatus.configured && !state.quiz);
  $("#keyNote").classList.toggle("is-error", Boolean(message));
  $("#keyNote").textContent = message || "Readback never syncs the key or shows it again after you save it.";
  showScreen("key");
  $("#apiKeyInput").focus();
}

async function saveKey(event) {
  event.preventDefault();
  const button = $("#keySaveButton");
  const input = $("#apiKeyInput");
  const form = new FormData(event.currentTarget);
  let key = input.value;
  const mode = String(form.get("keyMode"));
  input.value = "";
  button.disabled = true;
  $("#keyNote").classList.remove("is-error");
  $("#keyNote").textContent = "Saving the key…";
  try {
    const status = await sendWorkerMessage({ type: "READBACK_SAVE_API_KEY", key, mode });
    key = "";
    state.keyStatus = { configured: status?.configured === true, mode: status?.mode || null };
    updateKeyStatusUI();
    const resume = state.resumeAfterKeySave;
    state.resumeAfterKeySave = false;
    if (resume) await generateQuiz();
    else showScreen(state.keyReturnScreen === "key" ? "start" : state.keyReturnScreen);
  } catch (error) {
    key = "";
    $("#keyNote").classList.add("is-error");
    $("#keyNote").textContent = error?.message || "Readback could not save the key.";
  } finally {
    key = "";
    button.disabled = false;
  }
}

async function removeKey() {
  const button = $("#keyRemoveButton");
  button.disabled = true;
  try {
    const status = await sendWorkerMessage({ type: "READBACK_REMOVE_API_KEY" });
    state.keyStatus = { configured: status?.configured === true, mode: null };
    updateKeyStatusUI();
    state.resumeAfterKeySave = false;
    openKeySetup({ message: "The saved key was removed. Add a key to make another quiz." });
  } catch (error) {
    $("#keyNote").classList.add("is-error");
    $("#keyNote").textContent = error?.message || "Readback could not remove the key.";
  } finally {
    button.disabled = false;
  }
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
    quizSettings: state.quizSettings,
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
    cancelGeneration(false);
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
  if (state.tabId === tabId && state.abortController) {
    cancelGeneration(false);
  }
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
  else if (!["start", "access", "error", "key"].includes(state.screen)) state.screen = "start";
  showScreen(state.screen);
  if (state.screen === "start") updateSetupActions();
}

function returnToSetup() {
  if (!state.quiz) return;
  state.pendingNewQuiz = null;
  showScreen("start");
  updateSetupActions();
  saveCurrentTabState();
}

function updateSetupActions() {
  const canResume = Boolean(state.quiz);
  $("#generateButton span:first-child").textContent = canResume ? "Make a replacement quiz" : "Make my quiz";
  let resume = $("#resumeButton");
  if (!canResume) {
    resume?.remove();
    return;
  }
  if (!resume) {
    resume = document.createElement("button");
    resume.className = "secondary-button";
    resume.id = "resumeButton";
    resume.type = "button";
    resume.textContent = state.screen === "results" ? "Review current quiz" : "Resume current quiz";
    $("#generateButton").before(resume);
    resume.addEventListener("click", resumeQuiz);
  }
  resume.textContent = state.screen === "results" ? "Review current quiz" : "Resume current quiz";
}

function resumeQuiz() {
  if (!state.quiz) return;
  if (state.index >= state.quiz.questions.length - 1 && state.answers.every((answer) => answer != null)) {
    renderResults();
    return;
  }
  renderQuestion();
  showScreen("quiz");
}

function generateNewQuiz() {
  if (!state.quiz || state.abortController) return;
  state.pendingNewQuiz = {
    tabId: state.tabId,
    pageUrl: state.pageUrl,
    settings: { ...(state.quizSettings || state.settings) },
    previousQuestions: state.quiz.questions.map((question) => question.prompt)
  };
  return generateQuiz();
}

async function generateQuiz() {
  if (!state.keyStatus.configured) {
    openKeySetup({ resumeGeneration: true });
    return;
  }
  const replacement = state.pendingNewQuiz;
  const generationTabId = replacement?.tabId ?? state.requestedTabId ?? state.tabId;
  if (!Number.isInteger(generationTabId)) {
    showError(new Error("No active page was found."));
    return;
  }

  state.requestedTabId = null;
  if (state.abortController) cancelGeneration(false);
  const controller = new AbortController();
  state.abortController = controller;
  const requestId = crypto.randomUUID();
  const generationSettings = { ...(replacement?.settings || state.settings) };
  let generationPageUrl = state.pageUrl;
  state.generationRequestId = requestId;
  showScreen("loading");
  cycleLoadingMessage();
  startGenerationKeepAlive(requestId);

  try {
    const page = await sendWorkerMessage({ type: "READBACK_EXTRACT_PAGE", tabId: generationTabId });
    if (controller.signal.aborted) return;
    if (replacement && page?.url !== replacement.pageUrl) {
      throw new Error("The source page has changed. Return to the original page to make new questions.");
    }
    if ((page?.text || "").length < 250) {
      throw new Error("This page does not have enough readable text for a useful quiz.");
    }

    generationPageUrl = page.url || generationPageUrl;
    state.pageTitle = page.title || state.pageTitle;
    state.pageUrl = generationPageUrl;
    const media = buildMediaMap(page);
    const generated = await sendWorkerMessage({
      type: "READBACK_GENERATE_QUIZ",
      requestId,
      page,
      settings: generationSettings,
      ...(replacement ? { previousQuestions: replacement.previousQuestions } : {})
    });
    if (controller.signal.aborted) return;
    if (!generated?.quiz || !Array.isArray(generated.quiz.questions)) throw new Error("Readback received an invalid quiz.");
    if (
      state.tabId !== generationTabId ||
      state.pageUrl !== generationPageUrl ||
      state.generationRequestId !== requestId
    ) return;

    state.media = media;
    state.quiz = generated.quiz;
    state.quizSettings = generationSettings;
    state.index = 0;
    state.answers = Array(state.quiz.questions.length).fill(null);
    state.animating = false;
    state.pendingNewQuiz = null;
    state.screen = "quiz";
    $("#questionCard").className = "question-card";
    $("#questionCard").scrollTop = 0;
    renderQuestion();
    showScreen("quiz");
    await saveCurrentTabState();
  } catch (error) {
    const ownsRequest = state.generationRequestId === requestId;
    const ownsPage = state.tabId === generationTabId && state.pageUrl === generationPageUrl;
    if (controller.signal.aborted || error.code === "REQUEST_CANCELLED") {
      if (ownsRequest && ownsPage) showScreen("start");
      return;
    }
    if (ownsRequest && ownsPage) showError(error);
  } finally {
    stopGenerationKeepAlive(requestId);
    if (state.abortController === controller) state.abortController = null;
    if (state.generationRequestId === requestId) state.generationRequestId = null;
  }
}

function cancelGeneration(showStart = true) {
  const requestId = state.generationRequestId;
  state.abortController?.abort();
  state.abortController = null;
  state.generationRequestId = null;
  stopGenerationKeepAlive(requestId);
  if (requestId) chrome.runtime.sendMessage({ type: "READBACK_CANCEL_GENERATION", requestId }).catch(() => {});
  if (showStart) {
    if (state.pendingNewQuiz && state.quiz) {
      state.pendingNewQuiz = null;
      resumeQuiz();
    } else showScreen("start");
  }
}

function startGenerationKeepAlive(requestId) {
  generationKeepAlive.start(requestId);
}

function stopGenerationKeepAlive(requestId = null) {
  generationKeepAlive.stop(requestId);
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
  $("#cardLevel").textContent = (state.quizSettings?.level || state.settings.level).toUpperCase();
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

  const selectedAnswer = state.answers[state.index];
  $("#answers").replaceChildren(...question.options.map((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.answer = String(index);
    button.classList.toggle("is-selected", selectedAnswer === index);
    button.classList.toggle("is-correct", selectedAnswer != null && index === question.answer_index);
    button.classList.toggle("is-wrong", selectedAnswer === index && selectedAnswer !== question.answer_index);
    button.disabled = selectedAnswer != null;
    const letter = document.createElement("span");
    letter.className = "answer-letter";
    letter.textContent = LETTERS[index];
    const copy = document.createElement("span");
    copy.className = "answer-copy";
    copy.append(document.createTextNode(option));
    if (selectedAnswer != null && (index === question.answer_index || index === selectedAnswer)) {
      const label = document.createElement("span");
      label.className = "answer-state";
      label.textContent = index === question.answer_index
        ? (index === selectedAnswer ? "✓ Your answer · Correct" : "✓ Correct answer")
        : "✕ Your answer · Incorrect";
      copy.append(label);
    }
    button.append(letter, copy);
    return button;
  }));

  renderAnswerFeedback(question, selectedAnswer);
  $("#backButton").disabled = state.index === 0 || state.animating;
  $("#nextButton").disabled = selectedAnswer == null || state.animating;
  $("#nextButton").textContent = state.index === total - 1 ? "Check answers →" : "Next →";
}

function renderAnswerFeedback(question, selectedAnswer) {
  const feedback = $("#answerFeedback");
  feedback.replaceChildren();
  if (selectedAnswer == null) {
    const status = document.createElement("p");
    status.className = "choice-status";
    status.id = "choiceStatus";
    status.textContent = "Choose one answer.";
    feedback.append(status);
    return;
  }

  const correct = selectedAnswer === question.answer_index;
  const title = document.createElement("p");
  title.className = `feedback-title ${correct ? "is-correct" : "is-wrong"}`;
  title.textContent = correct ? "Correct" : "Not quite";
  const selectedFeedback = question.option_feedback?.[selectedAnswer];
  const answer = document.createElement("p");
  answer.className = "feedback-copy";
  const correctOption = String(question.options[question.answer_index] || "").replace(/[.!?]+$/, "");
  answer.textContent = selectedFeedback || (correct
    ? question.explanation
    : `Correct answer: ${correctOption}. ${question.explanation}`);
  const evidence = document.createElement("p");
  evidence.className = "feedback-evidence";
  evidence.textContent = question.evidence;
  if (selectedFeedback && question.explanation && selectedFeedback !== question.explanation) {
    const explanation = document.createElement("p");
    explanation.className = "feedback-copy";
    explanation.textContent = question.explanation;
    feedback.append(title, answer, explanation, evidence);
  } else {
    feedback.append(title, answer, evidence);
  }
  if (!evidencePassages(question.evidence).length) return;
  const find = document.createElement("button");
  find.type = "button";
  find.className = "text-button evidence-link";
  find.textContent = "Find on page";
  const status = document.createElement("p");
  status.className = "evidence-status";
  status.setAttribute("role", "status");
  const tabId = state.tabId;
  const pageUrl = state.pageUrl;
  find.addEventListener("click", async () => {
    find.disabled = true;
    status.textContent = "Finding source text…";
    try {
      const result = await sendWorkerMessage({ type: "READBACK_FIND_EVIDENCE", tabId, pageUrl, evidence: question.evidence });
      if (result.status === "found") {
        status.textContent = result.total > result.found
          ? "One passage highlighted. The other wording was not found."
          : result.found > 1 ? "Both passages highlighted on the page." : "Source text highlighted on the page.";
      } else {
        status.textContent = result.status === "page_changed"
          ? "The page has changed. Make a new quiz to find its source text."
          : result.status === "not_found" || result.status === "no_text"
            ? "This wording was not found on the page. The evidence may be a summary or translation."
            : "Readback could not search this page. Open the source tab and try again.";
      }
    } catch {
      status.textContent = "Readback could not search this page. Try again.";
    } finally {
      find.disabled = false;
    }
  });
  feedback.append(find, status);
}

function chooseAnswer(index, focusNext = false) {
  if (state.animating || state.screen !== "quiz" || state.answers[state.index] != null) return;
  state.answers[state.index] = index;
  renderQuestion();
  if (focusNext) $("#nextButton").focus();
  saveCurrentTabState();
}

function moveQuestion(nextIndex, direction) {
  if (state.animating || nextIndex < 0 || nextIndex >= state.quiz.questions.length) return;
  state.animating = true;
  const card = $("#questionCard");
  const quiz = state.quiz;
  const tabId = state.tabId;
  const transition = ++questionTransition;
  const switchRevision = state.switchRevision;
  const ownsQuiz = () => questionTransition === transition && state.switchRevision === switchRevision
    && state.quiz === quiz && state.tabId === tabId && state.screen === "quiz";
  card.classList.add(`is-leaving-${direction}`);
  window.setTimeout(() => {
    if (!ownsQuiz()) return;
    state.index = nextIndex;
    card.scrollTop = 0;
    card.className = `question-card pre-enter-${direction}`;
    state.animating = false;
    renderQuestion();
    // Commit the starting position without waiting for frame callbacks in a web panel.
    void card.offsetHeight;
    card.classList.remove(`pre-enter-${direction}`);
    saveCurrentTabState();
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
  $("#resultTitle").textContent = state.quiz.title || "Your results";
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
    const chosenText = String(chosen || "No answer").replace(/[.!?]+$/, "");
    const answerText = String(answer || "").replace(/[.!?]+$/, "");
    response.textContent = isCorrect ? `Your answer: ${chosenText}.` : `Your answer: ${chosenText}. Correct answer: ${answerText}.`;
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
  updateSetupActions();
  saveCurrentTabState();
}

function retryQuiz() {
  state.pendingNewQuiz = null;
  state.animating = false;
  state.index = 0;
  state.answers = Array(state.quiz.questions.length).fill(null);
  $("#questionCard").className = "question-card";
  $("#questionCard").scrollTop = 0;
  renderQuestion();
  showScreen("quiz");
  updateSetupActions();
  saveCurrentTabState();
}

function showError(error) {
  if (error?.code === "HOST_ACCESS_REQUIRED") {
    $("#accessNote").textContent = "Your browser will show a permission prompt. Readback still sends page content only when you start a quiz.";
    showScreen("access");
    return;
  }
  if (["MISSING_API_KEY", "INVALID_API_KEY"].includes(error?.code)) {
    if (error.code === "MISSING_API_KEY") state.keyStatus = { configured: false, mode: null };
    updateKeyStatusUI();
    openKeySetup({ resumeGeneration: true, message: error.message });
    return;
  }
  const message = error?.message || "Unknown error.";
  $("#errorTitle").textContent = error?.code === "RATE_LIMITED" ? "OpenAI needs a short pause." : "This quiz needs another try.";
  $("#errorMessage").textContent = message;
  $("#errorHomeButton").textContent = state.quiz ? "Back to current quiz" : "Back to start";
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
  const valid = request && typeof request === "object" &&
    typeof request.id === "string" && request.id.length <= 80 &&
    Number.isInteger(request.tabId) && request.tabId > 0 &&
    Number.isFinite(request.createdAt);
  if (!valid || request.id === state.lastRequestId || Date.now() - request.createdAt > 15000) return;
  state.lastRequestId = request.id;
  await activateTab(request.tabId, {
    title: typeof request.title === "string" ? request.title.slice(0, 300) : "",
    url: typeof request.url === "string" ? request.url.slice(0, 2048) : ""
  });
  state.requestedTabId = request.tabId;
  await chrome.storage.session.remove("readbackGenerateRequest");
  generateQuiz();
}

$("#quickSettings").addEventListener("change", (event) => saveSettingsFromForm(event.currentTarget));
$("#keyForm").addEventListener("submit", saveKey);
$("#keySetupButton").addEventListener("click", () => openKeySetup());
$("#keyRemoveButton").addEventListener("click", removeKey);
$("#keyBackButton").addEventListener("click", () => {
  state.resumeAfterKeySave = false;
  showScreen(state.keyReturnScreen === "key" ? "start" : state.keyReturnScreen);
});
$("#generateButton").addEventListener("click", generateQuiz);
$("#accessButton").addEventListener("click", requestWebsiteAccess);
$("#accessHomeButton").addEventListener("click", () => showScreen("start"));
$("#cancelButton").addEventListener("click", () => cancelGeneration());
$("#answers").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-answer]");
  if (button) chooseAnswer(Number(button.dataset.answer), event.detail === 0);
});
$("#backButton").addEventListener("click", previousQuestion);
$("#nextButton").addEventListener("click", nextQuestion);
$("#retryButton").addEventListener("click", retryQuiz);
$("#newQuizButton").addEventListener("click", generateNewQuiz);
$("#quizSetupButton").addEventListener("click", returnToSetup);
$("#resultsSetupButton").addEventListener("click", returnToSetup);
$("#errorRetryButton").addEventListener("click", generateQuiz);
$("#errorHomeButton").addEventListener("click", () => {
  state.pendingNewQuiz = null;
  if (state.quiz) resumeQuiz();
  else showScreen("start");
});

document.addEventListener("keydown", (event) => {
  if (state.screen !== "quiz" || event.metaKey || event.ctrlKey || event.altKey) return;
  if (/^[1-5]$/.test(event.key)) chooseAnswer(Number(event.key) - 1, true);
  if (event.key === "ArrowRight") nextQuestion();
  if (event.key === "ArrowLeft") previousQuestion();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && changes.readbackGenerateRequest?.newValue) {
    consumeGenerateRequest(changes.readbackGenerateRequest.newValue);
  }
});

chrome.tabs.onActivated?.addListener(({ tabId }) => {
  if (!Number.isInteger(tabId)) return;
  activateTab(tabId).then(() => {
    if (!state.keyStatus.configured && !state.quiz) openKeySetup();
  });
});

let activeTabSyncRunning = false;
async function syncActiveTab() {
  if (activeTabSyncRunning) return;
  activeTabSyncRunning = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) return;
    const changedTab = tab.id !== state.tabId;
    const changedPage = !changedTab && Boolean(tab.url) && tab.url !== state.pageUrl;
    const changedTitle = !changedTab && Boolean(tab.title) && tab.title !== state.pageTitle;
    if (changedPage) {
      await resetTab(tab.id, tab);
    } else if (changedTab || changedTitle) {
      await activateTab(tab.id, tab);
    }
    if (changedTab || changedPage || changedTitle) {
      if (!state.keyStatus.configured && !state.quiz) openKeySetup();
    }
  } catch {
    // Vivaldi can briefly make the active tab unavailable while switching workspaces.
  } finally {
    activeTabSyncRunning = false;
  }
}

// Vivaldi does not always forward tabs.onActivated to an already open web panel.
// Keep the panel aligned with the visible tab without requiring a panel reload.
setInterval(syncActiveTab, 750);
window.addEventListener("focus", syncActiveTab);

chrome.runtime.onMessage?.addListener((message) => {
  if (message?.type === "READBACK_TAB_RESET" && Number.isInteger(message.tabId) && message.tab && typeof message.tab === "object") {
    resetTab(message.tabId, {
      title: typeof message.tab.title === "string" ? message.tab.title.slice(0, 300) : "",
      url: typeof message.tab.url === "string" ? message.tab.url.slice(0, 2048) : ""
    }).then(() => {
      if (!state.keyStatus.configured) openKeySetup();
    });
  }
});

async function initialize() {
  await loadSettings();
  try {
    await loadKeyStatus();
  } catch (error) {
    showError(error);
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await activateTab(tab?.id, tab || {});
  const stored = await chrome.storage.session.get("readbackGenerateRequest");
  if (stored.readbackGenerateRequest) await consumeGenerateRequest(stored.readbackGenerateRequest);
  else if (!state.keyStatus.configured && !state.quiz) openKeySetup();
}

initialize();
