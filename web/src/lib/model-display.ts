/** Display only: selection and provider requests retain the original model ID. */
export function modelDisplayName(model: string): string {
  const current = model.match(
    /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8}|-latest)?$/i,
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
