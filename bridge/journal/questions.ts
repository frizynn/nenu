type Questions = Array<{ title: string; options: string[] }>;

/** Only named user-input tools expose question payloads, never arbitrary tool arguments. */
export function toolQuestions(name: unknown, args: unknown): Questions | undefined {
  if (typeof name !== "string" || !/(?:^|\.)request_user_input(?:_async)?$/.test(name) || typeof args !== "string" || args.length > 20_000) return;
  try {
    return questionList(JSON.parse(args));
  } catch { return; }
}

/** Claude's AskUserQuestion input is already an object: `{questions:[{question, header, options:[{label}]}]}`. */
export function askUserQuestions(name: unknown, input: unknown): Questions | undefined {
  return name === "AskUserQuestion" ? questionList(input) : undefined;
}

function questionList(value: unknown): Questions | undefined {
  if (!value || typeof value !== "object" || !("questions" in value) || !Array.isArray(value.questions)) return;
  const questions = value.questions.slice(0, 3).flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const title = "title" in row ? row.title : "question" in row ? row.question : null;
    if (typeof title !== "string" || !title.trim()) return [];
    const values = "options" in row && Array.isArray(row.options) ? row.options : [];
    const options = values.slice(0, 10).flatMap((option: unknown) => {
      const label = typeof option === "string" ? option : option && typeof option === "object" && "label" in option ? option.label : null;
      return typeof label === "string" ? [label.slice(0, 300)] : [];
    });
    return [{ title: title.slice(0, 2000), options }];
  });
  return questions.length ? questions : undefined;
}
