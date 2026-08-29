export function sourceTaskId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function findUnexpectedEmptyRetries({
  tasks = [],
  results = [],
  previous = null,
  today,
}) {
  const previousHealth = new Map(
    (previous?._meta?.sourceHealth ?? []).map((health) => [health.id, health]),
  );
  const previousEvents = Array.isArray(previous?.events) ? previous.events : [];

  return tasks.flatMap((task, index) => {
    const result = results[index];
    if (!result || result.error || (result.events?.length ?? 0) > 0) return [];

    const knownSources = previousHealth.get(sourceTaskId(task.name))?.sources ?? [];
    if (knownSources.length === 0) return [];

    const knownSourceSet = new Set(knownSources);
    const previousFutureEventCount = previousEvents.filter((event) => (
      knownSourceSet.has(event?.source) && String(event?.date || "") >= today
    )).length;
    if (previousFutureEventCount === 0) return [];

    return [{
      index,
      name: task.name,
      knownSources,
      previousFutureEventCount,
    }];
  });
}

export function finalizeUnexpectedEmptyRetry(result, candidate) {
  if (result?.error || (result?.events?.length ?? 0) > 0) return result;
  const sourceLabel = candidate.knownSources.join(", ");
  return {
    events: result?.events ?? [],
    error: `unexpected empty result after retry; previous snapshot still has ${candidate.previousFutureEventCount} future event(s) from ${sourceLabel}`,
  };
}
