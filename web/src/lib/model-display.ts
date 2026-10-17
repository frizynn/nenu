/** Display only: selection and provider requests retain the original model ID. */
export function modelDisplayName(model: string): string {
  const current = model.match(
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8}|-latest)?$/i,
  );
  const legacy = model.match(
    /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8}|-latest)?$/i,
  );
  const family = current?.[1] ?? legacy?.[3];
  if (!family) return model;
  const major = current?.[2] ?? legacy?.[1];
  const minor = current?.[3] ?? legacy?.[2];
  return `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ""}`;
}

/**
 * The catalogue row a reported model stands for: the row of that exact name, else the one row its
 * display name begins with as a word (`claude-opus-5-5` reads "Opus 5.5", so the row "Opus"). None
 * when no row, or more than one, fits: a guessed mark would say the wrong model runs.
 */
export function catalogRowFor(names: readonly string[], model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (names.includes(model)) return model;
  const shown = modelDisplayName(model).toLowerCase();
  const family = names.filter((name) => shown.startsWith(`${name.toLowerCase()} `));
  return family.length === 1 ? family[0] : undefined;
}
