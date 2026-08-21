export function shouldPauseProductionViews(
  isProduction: boolean,
  pauseFlag: string | boolean | undefined,
): boolean {
  return isProduction && (pauseFlag === true || pauseFlag === "true");
}