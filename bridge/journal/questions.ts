/** Only named user-input tools expose question payloads, never arbitrary tool arguments. */
export function toolQuestions(name: unknown, args: unknown): Array<{ title: string; options: string[] }> | undefined {
  if (typeof name !== "string" || !/(?:^|\.)request_user_input(?:_async)?$/.test(name) || typeof args !== "string" || args.length > 20_000) return;
  try {
    const value: unknown = JSON.parse(args);
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
  } catch { return; }
}
