const COMMON_QUESTION_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "by", "for", "from", "how", "if", "in", "is", "it", "of", "on", "or", "the", "then", "to", "what", "when", "which", "why", "with", "would"
]);

function result(failures) {
  return { passed: failures.length === 0, failures };
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function wordPattern(term) {
  const source = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|\\b)${source}(?:\\b|$)`, "i");
}

function outputText(quiz) {
  if (!quiz || typeof quiz !== "object") return "";
  const fields = [quiz.title, quiz.source_summary];
  for (const question of quiz.questions || []) {
    fields.push(
      question.prompt,
      ...(question.options || []),
      question.explanation,
      ...(question.option_feedback || []),
      question.evidence,
      question.image_alt
    );
  }
  return fields.filter(Boolean).join("\n");
}

function termsIn(value, terms = []) {
  const text = normalize(value);
  return terms.filter((term) => wordPattern(term).test(text));
}

function contentTokens(value) {
  return new Set(normalize(value).split(" ").filter((word) => word.length > 2 && !COMMON_QUESTION_WORDS.has(word)));
}

function contentBigrams(value) {
  const words = normalize(value).split(" ").filter((word) => word.length > 2 && !COMMON_QUESTION_WORDS.has(word));
  return new Set(words.slice(1).map((word, index) => `${words[index]} ${word}`));
}

function jaccard(left, right) {
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function overlapCoefficient(left, right) {
  const smaller = Math.min(left.size, right.size);
  if (!smaller) return 0;
  return [...left].filter((word) => right.has(word)).length / smaller;
}

function challengeEvidenceParts(evidence) {
  const match = String(evidence || "").match(/^Evidence A:\s*([^;]+?)\s*;\s*Evidence B:\s*([^;]+)$/i);
  return match ? [match[1].trim(), match[2].trim()] : [];
}

function groundedTokenCount(value, fixture) {
  const source = contentTokens(fixture.page.text);
  return [...contentTokens(value)].filter((word) => source.has(word)).length;
}

function isDerivedFromShownNumbers(number, outputNumbers, sourceNumbers) {
  const target = Number.parseFloat(number);
  if (!Number.isFinite(target)) return false;
  const operands = [...new Set(outputNumbers.filter((value) => sourceNumbers.has(value)).map((value) => Number.parseFloat(value)))];
  for (let left = 0; left < operands.length; left += 1) {
    for (let right = left + 1; right < operands.length; right += 1) {
      if (Math.abs(Math.abs(operands[left] - operands[right]) - target) < 0.0001) return true;
    }
  }
  return false;
}

function numberTokens(value) {
  return (String(value || "").match(/\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?\b/g) || [])
    .map((number) => number.replaceAll(",", ""));
}

function questionLabel(index) {
  return `Question ${index + 1}`;
}

export function gradeExactCounts(quiz, fixture) {
  const failures = [];
  const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
  const expectedQuestions = fixture.settings.questionCount;
  const expectedOptions = fixture.settings.optionCount;
  if (questions.length !== expectedQuestions) failures.push(`Expected ${expectedQuestions} questions, received ${questions.length}.`);

  questions.forEach((question, index) => {
    if (!Array.isArray(question.options) || question.options.length !== expectedOptions) {
      failures.push(`${questionLabel(index)} must have exactly ${expectedOptions} options.`);
    }
    if ((question.options || []).some((option) => /\b(?:a|an|and|as|at|by|for|from|of|or|the|to|with)$/i.test(String(option).trim()))) {
      failures.push(`${questionLabel(index)} has an answer option that ends mid-thought.`);
    }
    if (!Number.isInteger(question.answer_index) || question.answer_index < 0 || question.answer_index >= expectedOptions) {
      failures.push(`${questionLabel(index)} has no single valid answer index.`);
    }
    if (!Array.isArray(question.option_feedback) || question.option_feedback.length !== expectedOptions) {
      failures.push(`${questionLabel(index)} must have exactly ${expectedOptions} feedback entries.`);
    }
  });
  return result(failures);
}

export function gradeAnswerPositionBalance(quiz) {
  const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
  const optionCount = questions[0]?.options?.length || 0;
  const expectedPositions = Math.min(questions.length, optionCount);
  const positions = new Set(questions.map((question) => question.answer_index));
  const failures = expectedPositions > 1 && positions.size < expectedPositions
    ? [`Correct answers use ${positions.size} position${positions.size === 1 ? "" : "s"}; expected ${expectedPositions}.`]
    : [];
  return result(failures);
}

export function gradeEnglishOnly(quiz, fixture) {
  const failures = [];
  const text = outputText(quiz);
  if (/[¿¡]/.test(text)) failures.push("Output contains non-English punctuation.");
  for (const term of fixture.expectations.forbiddenLanguageTerms || []) {
    if (wordPattern(term).test(normalize(text))) failures.push(`Output copied non-English source term: ${term}.`);
  }
  return result(failures);
}

export function gradeGroundingAndEvidence(quiz, fixture) {
  const failures = [];
  const terms = fixture.expectations.groundingTerms || [];
  const allOutput = outputText(quiz);

  for (const pattern of fixture.expectations.forbiddenOutputPatterns || []) {
    if (pattern.test(allOutput)) failures.push(`Output followed or repeated forbidden page content: ${pattern}.`);
  }

  for (const [index, question] of (quiz?.questions || []).entries()) {
    const evidence = String(question.evidence || "").trim();
    if (!evidence) {
      failures.push(`${questionLabel(index)} has no evidence.`);
      continue;
    }
    // The product schema permits up to 319 characters. Challenge evidence also
    // limits each of its two supports to 21 words, which is the useful brevity
    // check for two-source answers.
    if (evidence.length >= 320) failures.push(`${questionLabel(index)} evidence is not concise.`);
    if (termsIn(evidence, terms).length === 0) failures.push(`${questionLabel(index)} evidence does not use a fixture-grounded concept.`);

    const support = [question.options?.[question.answer_index], question.explanation, question.evidence].join(" ");
    if (termsIn(support, terms).length === 0) failures.push(`${questionLabel(index)} answer and feedback are not tied to source evidence.`);

    const sourceNumbers = new Set(numberTokens(`${fixture.page.text} ${(fixture.expectations.groundingTerms || []).join(" ")}`));
    const outputNumbers = numberTokens(support);
    for (const number of outputNumbers) {
      const describesCalculation = /\b(?:add(?:ing|ed)?|calculat(?:e|ed|ing)|divid(?:e|ed|ing)|sum|total|weight(?:ed|ing))\b/i.test(support);
      const isShownCalculation = describesCalculation || isDerivedFromShownNumbers(number, outputNumbers, sourceNumbers);
      if (!sourceNumbers.has(number) && !isShownCalculation) failures.push(`${questionLabel(index)} introduces the unsupported number ${number}.`);
    }
  }
  return result(failures);
}

export function gradeNoDuplicateQuestions(quiz, fixture) {
  const failures = [];
  const questions = quiz?.questions || [];
  const groundingTerms = fixture?.expectations?.groundingTerms || [];
  for (let left = 0; left < questions.length; left += 1) {
    const leftPrompt = normalize(questions[left].prompt).replace(/^(scenario|comparison|counterfactual)\s+/, "");
    for (let right = left + 1; right < questions.length; right += 1) {
      const rightPrompt = normalize(questions[right].prompt).replace(/^(scenario|comparison|counterfactual)\s+/, "");
      if (leftPrompt === rightPrompt || jaccard(contentTokens(leftPrompt), contentTokens(rightPrompt)) >= 0.8) {
        failures.push(`Questions ${left + 1} and ${right + 1} are duplicates or near-duplicates.`);
      }
      const leftConcepts = new Set(termsIn(`${questions[left].prompt} ${questions[left].evidence}`, groundingTerms));
      const rightConcepts = new Set(termsIn(`${questions[right].prompt} ${questions[right].evidence}`, groundingTerms));
      const testedClaimOverlap = jaccard(
        contentTokens(`${questions[left].prompt} ${questions[left].options?.[questions[left].answer_index]}`),
        contentTokens(`${questions[right].prompt} ${questions[right].options?.[questions[right].answer_index]}`)
      );
      if (
        leftConcepts.size >= 2 &&
        rightConcepts.size >= 2 &&
        overlapCoefficient(leftConcepts, rightConcepts) >= 0.9 &&
        testedClaimOverlap >= 0.4
      ) {
        failures.push(`Questions ${left + 1} and ${right + 1} test the same source concepts.`);
      }
    }
  }
  return result(failures);
}

export function gradeChallengeContract(quiz, fixture) {
  const failures = [];
  if (fixture.settings.level !== "challenge") return result(failures);

  const source = normalize(fixture.page.text);
  const conceptGroups = fixture.expectations.conceptGroups || [];
  for (const [index, question] of (quiz?.questions || []).entries()) {
    if (!/^(Scenario|Comparison|Counterfactual):/.test(String(question.prompt || ""))) {
      failures.push(`${questionLabel(index)} does not use a new scenario, comparison, or counterfactual frame.`);
    }
    const promptWithoutFrame = normalize(question.prompt).replace(/^(scenario|comparison|counterfactual)\s+/, "");
    if (promptWithoutFrame.split(" ").length >= 5 && source.includes(promptWithoutFrame)) {
      failures.push(`${questionLabel(index)} copies its task from the source instead of creating a new frame.`);
    }

    const evidenceParts = challengeEvidenceParts(question.evidence);
    if (evidenceParts.length !== 2) {
      failures.push(`${questionLabel(index)} does not provide exactly two labeled supports.`);
    } else {
      const partGroups = evidenceParts.map((part) => conceptGroups
        .map((terms, groupIndex) => termsIn(part, terms).length ? groupIndex : -1)
        .filter((groupIndex) => groupIndex >= 0));
      const visualPart = evidenceParts.findIndex((part) => /^Visual:/i.test(part));
      const usesVisual = question.image_ref && question.image_ref !== "none";
      if (usesVisual) {
        if (visualPart < 0) failures.push(`${questionLabel(index)} does not label its visual support.`);
        const textPart = evidenceParts[visualPart === 0 ? 1 : 0];
        const sourceConceptTerms = [
          ...(fixture.expectations.groundingTerms || []),
          ...(fixture.expectations.conceptGroups || []).flat()
        ];
        if (!textPart || (termsIn(textPart, sourceConceptTerms).length === 0 && groundedTokenCount(textPart, fixture) < 2)) {
          failures.push(`${questionLabel(index)} does not combine the visual with a grounded source idea.`);
        }
      } else {
        if (partGroups.some((groups) => groups.length === 0)) failures.push(`${questionLabel(index)} has a support that is not grounded in a source idea.`);
        const distinctPair = (partGroups[0] || []).some((left) => (partGroups[1] || []).some((right) => left !== right));
        if (!distinctPair) failures.push(`${questionLabel(index)} does not synthesize two distinct source ideas.`);
      }
    }

    const normalizedOptions = (question.options || []).map(normalize);
    if (new Set(normalizedOptions).size !== normalizedOptions.length) failures.push(`${questionLabel(index)} has ambiguous duplicate options.`);
    for (let left = 0; left < normalizedOptions.length; left += 1) {
      for (let right = left + 1; right < normalizedOptions.length; right += 1) {
        const tokenOverlap = jaccard(contentTokens(normalizedOptions[left]), contentTokens(normalizedOptions[right]));
        const orderedOverlap = jaccard(contentBigrams(normalizedOptions[left]), contentBigrams(normalizedOptions[right]));
        if (tokenOverlap >= 0.93 && orderedOverlap >= 0.7) {
          failures.push(`${questionLabel(index)} options ${left + 1} and ${right + 1} are too similar for one unambiguous answer.`);
        }
      }
    }
    for (const [optionIndex, option] of normalizedOptions.entries()) {
      if (option.split(" ").length >= 3 && source.includes(option)) {
        failures.push(`${questionLabel(index)} option ${optionIndex + 1} copies an answer from the source.`);
      }
    }
  }
  return result(failures);
}

export function gradeVisualNecessity(quiz, fixture) {
  const failures = [];
  const questions = quiz?.questions || [];
  const visualQuestions = questions.filter((question) => question.image_ref && question.image_ref !== "none");
  const expectation = fixture.expectations.visual;

  if (expectation === "required") {
    const allowed = new Set(fixture.expectations.meaningfulImageRefs || []);
    if (!visualQuestions.some((question) => allowed.has(question.image_ref))) failures.push("No question requires the meaningful visual.");
  }
  if (expectation === "forbidden" && visualQuestions.length) failures.push("A question uses media that the fixture marks as unnecessary or decorative.");

  visualQuestions.forEach((question, index) => {
    if (!String(question.image_alt || "").trim()) failures.push(`Visual question ${index + 1} has no neutral image description.`);
    if (!/\bVisual:/i.test(String(question.evidence || ""))) failures.push(`Visual question ${index + 1} does not state the visible proof.`);
  });
  return result(failures);
}

export function gradeExplanationQuality(quiz, fixture) {
  const failures = [];
  const terms = fixture.expectations.groundingTerms || [];
  for (const [index, question] of (quiz?.questions || []).entries()) {
    if (!/^Correct:\s+\S/.test(String(question.explanation || ""))) {
      failures.push(`${questionLabel(index)} explanation does not state why the correct answer fits.`);
    }
    if (!Array.isArray(question.option_feedback)) continue;
    question.option_feedback.forEach((feedback, optionIndex) => {
      const isCorrect = optionIndex === question.answer_index;
      if (isCorrect && !/^Fits:\s+\S/.test(String(feedback || ""))) {
        failures.push(`${questionLabel(index)} correct-option feedback must begin Fits:.`);
      }
      if (!isCorrect && !/^Fails:\s+\S/.test(String(feedback || ""))) {
        failures.push(`${questionLabel(index)} wrong-option feedback must begin Fails:.`);
      }
      if (!isCorrect && !/\bCorrect:\s+\S/.test(String(feedback || ""))) {
        failures.push(`${questionLabel(index)} wrong-option feedback does not explain why the correct answer fits.`);
      }
      if (termsIn(feedback, terms).length === 0 && groundedTokenCount(`${question.options?.[optionIndex] || ""} ${feedback}`, fixture) < 2) {
        failures.push(`${questionLabel(index)} option ${optionIndex + 1} feedback has no concise source evidence.`);
      }
    });
  }
  return result(failures);
}

export function gradeQuizDeterministically(quiz, fixture) {
  const checks = {
    exactCounts: gradeExactCounts(quiz, fixture),
    answerPositionBalance: gradeAnswerPositionBalance(quiz),
    englishOnly: gradeEnglishOnly(quiz, fixture),
    groundingAndEvidence: gradeGroundingAndEvidence(quiz, fixture),
    noDuplicateQuestions: gradeNoDuplicateQuestions(quiz, fixture),
    challengeContract: gradeChallengeContract(quiz, fixture),
    visualNecessity: gradeVisualNecessity(quiz, fixture),
    explanationQuality: gradeExplanationQuality(quiz, fixture)
  };
  const failures = Object.entries(checks).flatMap(([name, check]) => check.failures.map((failure) => `${name}: ${failure}`));
  return { passed: failures.length === 0, checks, failures };
}
