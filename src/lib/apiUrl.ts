/**
 * Returns the backend API URL for the responsive Web / PWA application.
 * Relative `/api/...` paths resolve directly against the active web origin.
 */
export function getApiUrl(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
