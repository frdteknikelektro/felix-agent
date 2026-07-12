// Thin typed fetch wrapper around the Felix REST API. Cookies carry the owner
// session; a 401 means the session expired, which the app turns into a redirect
// to /login.

import { withBase } from "./base";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super(401, "unauthorized");
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(withBase(path), {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) throw new UnauthorizedError();

  const text = await res.text();
  const data = text ? safeParse(text) : undefined;

  if (!res.ok) {
    const code = (data as { error?: string })?.error ?? `http_${res.status}`;
    throw new ApiError(res.status, code, code);
  }
  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),

  // Auth
  login: (secret: string) => request<void>("POST", "/api/login", { secret }),
  logout: () => request<void>("POST", "/api/logout"),
};

/** Unwrap a `{ items: T[] }` envelope used by list endpoints. */
export async function getList<T>(path: string): Promise<T[]> {
  const data = await api.get<{ items: T[] }>(path);
  return data.items ?? [];
}
