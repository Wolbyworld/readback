export function buildQuizSchema(questionCount, optionCount, imageRefs, level = "apply") {
  const challenge = level === "challenge";
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "source_summary", "questions"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 90 },
      source_summary: { type: "string", minLength: 1, maxLength: 260, pattern: "^[^\\n]+[.!?]$" },
      questions: {
        type: "array",
        minItems: questionCount,
        maxItems: questionCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "options", "answer_index", "explanation", "option_feedback", "evidence", "image_ref", "image_alt"],
          properties: {
            prompt: {
              type: "string",
              minLength: 8,
              maxLength: 260,
              ...(challenge ? { pattern: "^(Scenario|Comparison|Counterfactual):" } : {})
            },
            options: {
              type: "array",
              minItems: optionCount,
              maxItems: optionCount,
              items: { type: "string", minLength: 1, maxLength: 150 }
            },
            answer_index: { type: "integer", minimum: 0, maximum: optionCount - 1 },
            explanation: { type: "string", minLength: 10, maxLength: 360, pattern: "^Correct:" },
            option_feedback: {
              type: "array",
              minItems: optionCount,
              maxItems: optionCount,
              items: { type: "string", minLength: 12, maxLength: 300, pattern: "^(Fits:|Fails:)" }
            },
            evidence: {
              type: "string",
              minLength: 1,
              maxLength: 320,
              ...(challenge ? { pattern: "^Evidence A: [^;]+; Evidence B: [^;]+$" } : {})
            },
            image_ref: { type: "string", enum: imageRefs },
            image_alt: { type: "string", maxLength: 180 }
          }
        }
      }
    }
  };
}

const UNEXPECTED_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Thai}]/u;
const DANGLING_END = /\b(?:a|an|and|as|at|by|for|from|of|or|the|to|with)$/i;

function learnerText(question) {
  return [question.prompt, ...(question.options || []), question.explanation, ...(question.option_feedback || []), question.evidence, question.image_alt];
}

export function validateQuizShape(quiz, questionCount, optionCount, imageRefs, level = "apply") {
  if (!quiz || typeof quiz !== "object" || !Array.isArray(quiz.questions)) return "The model did not return a quiz.";
  if (quiz.questions.length !== questionCount) return `Expected ${questionCount} questions.`;
  for (const [index, question] of quiz.questions.entries()) {
    if (typeof question.prompt !== "string" || question.prompt.length < 8 || question.prompt.length >= 260) return `Question ${index + 1} has no usable prompt.`;
    if (level === "challenge" && !/^(Scenario|Comparison|Counterfactual):/.test(question.prompt)) return `Question ${index + 1} does not use a challenge frame.`;
    if (!Array.isArray(question.options) || question.options.length !== optionCount) return `Question ${index + 1} has the wrong number of options.`;
    if (question.options.some((option) => typeof option !== "string" || !option.trim() || option.length >= 150)) return `Question ${index + 1} has an unusable option.`;
    if (question.options.some((option) => DANGLING_END.test(option.trim()))) return `Question ${index + 1} has an incomplete option.`;
    if (new Set(question.options.map((option) => String(option).trim().toLowerCase())).size !== optionCount) return `Question ${index + 1} has duplicate options.`;
    if (!Number.isInteger(question.answer_index) || question.answer_index < 0 || question.answer_index >= optionCount) return `Question ${index + 1} has an invalid answer.`;
    if (typeof question.explanation !== "string" || !question.explanation.startsWith("Correct:") || question.explanation.length >= 360) return `Question ${index + 1} has no usable explanation.`;
    if (!Array.isArray(question.option_feedback) || question.option_feedback.length !== optionCount) return `Question ${index + 1} has incomplete option feedback.`;
    for (const [optionIndex, feedback] of question.option_feedback.entries()) {
      const expectedPrefix = optionIndex === question.answer_index ? "Fits:" : "Fails:";
      if (typeof feedback !== "string" || !feedback.startsWith(expectedPrefix) || feedback.length >= 300) return `Question ${index + 1} has invalid feedback for option ${optionIndex + 1}.`;
      if (optionIndex !== question.answer_index && !feedback.includes("Correct:")) return `Question ${index + 1} does not correct option ${optionIndex + 1}'s misconception.`;
    }
    if (typeof question.evidence !== "string" || !question.evidence.trim() || question.evidence.length >= 320) return `Question ${index + 1} has no evidence.`;
    if (level === "challenge" && !/^Evidence A: [^;]+; Evidence B: [^;]+$/.test(question.evidence)) return `Question ${index + 1} does not cite exactly two challenge supports.`;
    if (!imageRefs.includes(question.image_ref)) return `Question ${index + 1} refers to missing media.`;
    if (question.image_ref === "none" && question.image_alt !== "") return `Question ${index + 1} describes media that it does not use.`;
    if (question.image_ref !== "none" && (typeof question.image_alt !== "string" || !question.image_alt.trim())) return `Question ${index + 1} has no media description.`;
    if (question.image_ref !== "none" && !/\bVisual:/i.test(question.evidence)) return `Question ${index + 1} does not identify its visual evidence.`;
    if (learnerText(question).some((value) => typeof value === "string" && UNEXPECTED_SCRIPT.test(value))) return `Question ${index + 1} contains non-English script.`;
  }
  if (typeof quiz.title !== "string" || !quiz.title.trim() || quiz.title.length >= 90 || UNEXPECTED_SCRIPT.test(quiz.title)) return "The quiz has no usable title.";
  if (typeof quiz.source_summary !== "string" || !quiz.source_summary.trim() || quiz.source_summary.length >= 260 || !/[.!?]$/.test(quiz.source_summary.trim()) || DANGLING_END.test(quiz.source_summary.trim()) || UNEXPECTED_SCRIPT.test(quiz.source_summary)) return "The quiz has no usable summary.";
  return null;
}
