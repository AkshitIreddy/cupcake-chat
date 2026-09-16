export function draftGenerationIsCurrent(submitted: number, current: number): boolean {
  return submitted === current;
}

export function shouldRestoreFailedDraft(options: {
  accepted: boolean;
  sent: boolean;
  submittedGeneration: number;
  currentGeneration: number;
}): boolean {
  return (
    options.accepted &&
    !options.sent &&
    draftGenerationIsCurrent(options.submittedGeneration, options.currentGeneration)
  );
}
