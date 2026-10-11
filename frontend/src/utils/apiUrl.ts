/**
 * Get API URL with proper defaults for development and production
 * Defaults to a same-origin relative path ("/api"):
 * - dev: resolved by the Vite proxy
 * - prod: resolved by the backend that serves the SPA (or an nginx proxy)
 * This keeps media/API URLs working from any client (LAN devices, phones),
 * unlike an absolute http://localhost:5551 default which only works on the
 * machine running the backend. Set VITE_API_URL explicitly only when the
 * frontend and backend live on different origins.
 */
export const getApiUrl = (): string => {
  return import.meta.env.VITE_API_URL || "/api";
};

/**
 * Get backend URL with proper defaults for development and production
 * Defaults to "" (same-origin relative URLs) for the same reason as
 * getApiUrl(). Set VITE_BACKEND_URL explicitly only for cross-origin
 * frontend/backend deployments.
 */
export const getBackendUrl = (): string => {
  return import.meta.env.VITE_BACKEND_URL || "";
};
