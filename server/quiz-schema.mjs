export function buildQuizSchema(questionCount, optionCount, imageRefs) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "source_summary", "questions"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 90 },
      source_summary: { type: "string", minLength: 1, maxLength: 260 },
      questions: {
        type: "array",
        minItems: questionCount,
        maxItems: questionCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "options", "answer_index", "explanation", "evidence", "image_ref", "image_alt"],
          properties: {
            prompt: { type: "string", minLength: 8, maxLength: 260 },
            options: {
              type: "array",
              minItems: optionCount,
              maxItems: optionCount,
              items: { type: "string", minLength: 1, maxLength: 150 }
            },
            answer_index: { type: "integer", minimum: 0, maximum: optionCount - 1 },
            explanation: { type: "string", minLength: 1, maxLength: 360 },
            evidence: { type: "string", minLength: 1, maxLength: 260 },
            image_ref: { type: "string", enum: imageRefs },
            image_alt: { type: "string", maxLength: 180 }
          }
        }
      }
    }
  };
}

export function validateQuizShape(quiz, questionCount, optionCount, imageRefs) {
  if (!quiz || typeof quiz !== "object" || !Array.isArray(quiz.questions)) return "The model did not return a quiz.";
  if (quiz.questions.length !== questionCount) return `Expected ${questionCount} questions.`;
  for (const [index, question] of quiz.questions.entries()) {
    if (typeof question.prompt !== "string" || question.prompt.length < 8) return `Question ${index + 1} has no usable prompt.`;
    if (!Array.isArray(question.options) || question.options.length !== optionCount) return `Question ${index + 1} has the wrong number of options.`;
    if (!Number.isInteger(question.answer_index) || question.answer_index < 0 || question.answer_index >= optionCount) return `Question ${index + 1} has an invalid answer.`;
    if (!imageRefs.includes(question.image_ref)) return `Question ${index + 1} refers to missing media.`;
  }
  return null;
}
