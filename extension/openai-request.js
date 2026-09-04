import { buildPrompt } from "./prompt.js";
import { buildQuizSchema, validateQuizShape } from "./quiz-schema.js";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_MODEL = "gpt-5.6-luna";
export const OPENAI_TIMEOUT_MS = 110000;

const QUESTION_COUNTS = new Set([3, 5, 7, 10]);
const OPTION_COUNTS = new Set([2, 3, 4, 5]);
const LEVELS = new Set(["recall", "explain", "apply", "challenge"]);
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MEDIA_REF = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class ReadbackApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "ReadbackApiError";
    this.code = code;
    this.status = status;
  }
}

function validDataImage(value) {
  return typeof value === "string" && value.length <= 4_500_000 && DATA_IMAGE.test(value);
}

function validMediaRef(value) {
  return typeof value === "string" && MEDIA_REF.test(value);
}

function normalizeImage(image) {
  if (!image || typeof image !== "object" || !validMediaRef(image.ref) || !validDataImage(image.dataUrl)) return null;
  return {
    ref: image.ref,
    alt: String(image.alt || "").slice(0, 300),
    dataUrl: image.dataUrl
  };
}

function normalizeDiagram(diagram) {
  if (!diagram || typeof diagram !== "object" || !validMediaRef(diagram.ref)) return null;
  return {
    ref: diagram.ref,
    label: String(diagram.label || "").slice(0, 300),
    visibleText: String(diagram.visibleText || "").slice(0, 900)
  };
}

export function normalizeRequest(body) {
  const page = body?.page || {};
  const raw = body?.settings || {};
  const settings = {
    questionCount: QUESTION_COUNTS.has(Number(raw.questionCount)) ? Number(raw.questionCount) : 5,
    optionCount: OPTION_COUNTS.has(Number(raw.optionCount)) ? Number(raw.optionCount) : 4,
    level: LEVELS.has(raw.level) ? raw.level : "apply"
  };
  const seenRefs = new Set();
  const images = (Array.isArray(page.images) ? page.images : [])
    .slice(0, 3)
    .map(normalizeImage)
    .filter((image) => image && !seenRefs.has(image.ref) && seenRefs.add(image.ref));
  return {
    page: {
      title: String(page.title || "Untitled page").slice(0, 300),
      url: String(page.url || "").slice(0, 2048),
      text: String(page.text || "").slice(0, 28000),
      diagrams: (Array.isArray(page.diagrams) ? page.diagrams : []).slice(0, 3).map(normalizeDiagram).filter(Boolean),
      images,
      screenshot: validDataImage(page.screenshot) ? page.screenshot : null
    },
    settings
  };
}

export function validateGenerationInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ReadbackApiError("INVALID_REQUEST", "The quiz request was not valid.", 400);
  if (!body.page || typeof body.page !== "object" || Array.isArray(body.page)) throw new ReadbackApiError("INVALID_REQUEST", "The page data was not valid.", 400);
  if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw new ReadbackApiError("INVALID_REQUEST", "The quiz settings were not valid.", 400);
  if (typeof body.page.text !== "string" || body.page.text.length < 250 || body.page.text.length > 28000) {
    throw new ReadbackApiError("INVALID_PAGE", "This page does not have enough readable text for a useful quiz.", 400);
  }
  if ((body.page.title != null && typeof body.page.title !== "string") || (body.page.url != null && typeof body.page.url !== "string")) {
    throw new ReadbackApiError("INVALID_PAGE", "The page details were not valid.", 400);
  }
  if (!QUESTION_COUNTS.has(body.settings.questionCount) || !OPTION_COUNTS.has(body.settings.optionCount) || !LEVELS.has(body.settings.level)) {
    throw new ReadbackApiError("INVALID_SETTINGS", "Choose valid quiz settings and try again.", 400);
  }
  if (body.page.images != null && !Array.isArray(body.page.images)) throw new ReadbackApiError("INVALID_PAGE", "The page visuals were not valid.", 400);
  if (body.page.diagrams != null && !Array.isArray(body.page.diagrams)) throw new ReadbackApiError("INVALID_PAGE", "The page diagrams were not valid.", 400);
  if ((body.page.images || []).length > 3 || (body.page.diagrams || []).length > 3) throw new ReadbackApiError("INVALID_PAGE", "The page included too many visuals.", 400);
  if ((body.page.images || []).some((image) => !normalizeImage(image))) throw new ReadbackApiError("INVALID_PAGE", "A page visual was not valid.", 400);
  if ((body.page.diagrams || []).some((diagram) => !normalizeDiagram(diagram))) throw new ReadbackApiError("INVALID_PAGE", "A page diagram was not valid.", 400);
  if (body.page.screenshot != null && !validDataImage(body.page.screenshot)) throw new ReadbackApiError("INVALID_PAGE", "The page capture was not valid.", 400);
  const refs = (body.page.images || []).map((image) => image.ref);
  if (new Set(refs).size !== refs.length || (body.page.screenshot && refs.includes("page_view"))) {
    throw new ReadbackApiError("INVALID_PAGE", "The page visual references were not valid.", 400);
  }
  return normalizeRequest(body);
}

export function buildOpenAIRequest(input, model = DEFAULT_MODEL) {
  const media = [];
  const mediaRefs = ["none"];
  if (input.page.screenshot) {
    mediaRefs.push("page_view");
    media.push({ type: "input_image", image_url: input.page.screenshot, detail: "low" });
  }
  for (const image of input.page.images) {
    if (mediaRefs.includes(image.ref)) continue;
    mediaRefs.push(image.ref);
    media.push({ type: "input_image", image_url: image.dataUrl, detail: "low" });
  }

  const answerBudget = 2500 + input.settings.questionCount * (350 + input.settings.optionCount * 120);
  const reasoningBudget = input.settings.level === "challenge" ? 6500 : input.settings.level === "explain" ? 2500 : 0;

  return {
    request: {
      model,
      store: false,
      reasoning: { effort: input.settings.level === "challenge" ? "high" : input.settings.level === "explain" ? "medium" : "low" },
      max_output_tokens: Math.min(24000, answerBudget + reasoningBudget),
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: buildPrompt({ ...input, mediaRefs }) },
          ...media
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "readback_quiz",
          strict: true,
          schema: buildQuizSchema(input.settings.questionCount, input.settings.optionCount, mediaRefs, input.settings.level)
        }
      }
    },
    mediaRefs
  };
}

export function extractOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

export function balanceQuizAnswerPositions(quiz, random = Math.random) {
  if (!Array.isArray(quiz?.questions) || quiz.questions.length === 0) return quiz;
  const optionCount = quiz.questions[0]?.options?.length || 0;
  if (optionCount < 2) return quiz;

  const randomIndex = (length) => Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * length);
  const shuffle = (values) => {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const swapIndex = randomIndex(index + 1);
      [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
    }
    return values;
  };
  const targets = [];
  while (targets.length < quiz.questions.length) {
    const deck = shuffle(Array.from({ length: optionCount }, (_, index) => index));
    if (targets.length && deck[0] === targets.at(-1)) [deck[0], deck[1]] = [deck[1], deck[0]];
    targets.push(...deck);
  }

  quiz.questions.forEach((question, questionIndex) => {
    const entries = question.options.map((option, index) => ({ option, feedback: question.option_feedback[index], correct: index === question.answer_index }));
    const correct = entries.find((entry) => entry.correct);
    const wrong = entries.filter((entry) => !entry.correct);
    shuffle(wrong);
    const target = targets[questionIndex];
    wrong.splice(target, 0, correct);
    question.options = wrong.map((entry) => entry.option);
    question.option_feedback = wrong.map((entry) => entry.feedback);
    question.answer_index = target;
  });
  return quiz;
}

export function mapOpenAIHttpError(status) {
  if (status === 401) return new ReadbackApiError("INVALID_API_KEY", "OpenAI did not accept this API key. Replace it and try again.", 401);
  if (status === 429) return new ReadbackApiError("RATE_LIMITED", "OpenAI limited this account. Check its API usage or wait a moment, then try again.", 429);
  if (status === 403) return new ReadbackApiError("OPENAI_ACCESS_DENIED", "This OpenAI account cannot use the selected model.", 403);
  if (status >= 500) return new ReadbackApiError("OPENAI_UNAVAILABLE", "OpenAI is not available now. Try again in a moment.", 502);
  return new ReadbackApiError("OPENAI_REQUEST_FAILED", "OpenAI could not create this quiz. Check the key and try again.", 400);
}

export async function createQuizWithOpenAI(input, apiKey, options = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new ReadbackApiError("MISSING_API_KEY", "Add an OpenAI API key before you make a quiz.", 401);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? OPENAI_TIMEOUT_MS;
  const { request, mediaRefs } = buildOpenAIRequest(input, options.model || DEFAULT_MODEL);
  const invalidQuiz = () => new ReadbackApiError("QUIZ_INVALID", "OpenAI returned a quiz Readback could not use. Please try again.", 502);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (options.signal?.aborted) throw new ReadbackApiError("REQUEST_CANCELLED", "Quiz generation was cancelled.", 499);
        throw new ReadbackApiError("OPENAI_TIMEOUT", "OpenAI took too long to answer. Try again.", 504);
      }
      throw new ReadbackApiError("OPENAI_NETWORK", "Readback could not reach OpenAI. Check the connection and try again.", 502);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (!response.ok) throw mapOpenAIHttpError(response.status);
    const payload = await response.json().catch(() => null);
    const outputText = extractOutputText(payload);
    let quiz = null;
    if (outputText) {
      try {
        quiz = JSON.parse(outputText);
      } catch {
        // One automatic retry gives the one-click flow a chance to recover.
      }
    }
    const shapeError = quiz && validateQuizShape(quiz, input.settings.questionCount, input.settings.optionCount, mediaRefs, input.settings.level);
    if (!quiz || shapeError) {
      if (attempt === 0) continue;
      throw invalidQuiz();
    }
    balanceQuizAnswerPositions(quiz, options.random);
    quiz.model = request.model;
    return quiz;
  }
  throw invalidQuiz();
}
