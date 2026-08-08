import { QueryClient, QueryFunction } from "@tanstack/react-query";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly responseText: string;

  constructor(status: number, responseText: string, retryAfterMs: number | null) {
    super(`${status}: ${responseText}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.responseText = responseText;
  }
}

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new ApiRequestError(
      res.status,
      text,
      parseRetryAfterMs(res.headers.get("Retry-After")),
    );
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    // Handle hierarchical query keys with params
    // e.g., ['/api/endpoint', { hours: 12, limit: 4 }] => /api/endpoint?hours=12&limit=4
    let url: string;
    if (queryKey.length === 2 && typeof queryKey[1] === 'object' && queryKey[1] !== null) {
      const baseUrl = queryKey[0] as string;
      const params = new URLSearchParams();
      Object.entries(queryKey[1] as Record<string, unknown>).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      });
      url = params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;
    } else {
      url = queryKey.join("/") as string;
    }

    const res = await fetch(url, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
