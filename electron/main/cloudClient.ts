import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

export class CloudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

/**
 * Client HTTP/WebSocket bas niveau vers le backend cloud — ne connaît rien de la logique
 * d'authentification (rotation de token, stockage `safeStorage`...), c'est le rôle de
 * `auth.ts`. Prend un `getAccessToken` en callback plutôt qu'une dépendance directe sur
 * `AuthManager` : évite un import circulaire (`AuthManager` a besoin de `CloudClient` pour
 * appeler `/api/auth/login`, qui lui-même ne nécessite PAS de token).
 */
export class CloudClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getAccessToken: () => string | null
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = { auth: true }): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false) {
      const token = this.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new CloudApiError((json && json.error) || `Erreur HTTP ${res.status}`, res.status);
    }
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown, opts?: { auth?: boolean }): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /** Upload/download bruts (archive d'état gzip) — pas du JSON, cf. profileManager.ts (phase C). */
  async putBinary(path: string, data: Buffer): Promise<{ stateVersion: number; stateUpdatedAt: string }> {
    const token = this.getAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/gzip', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      // Les types DOM de `fetch` (ce projet inclut `lib: ["DOM"]` pour le reste du code
      // renderer-adjacent) ne connaissent pas `Buffer` comme `BodyInit` valide, alors que le
      // vrai `fetch` de Node (Undici) l'accepte très bien à l'exécution — juste un désaccord de
      // typage entre deux définitions, pas un vrai problème de type.
      body: data as unknown as BodyInit,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new CloudApiError(text || `Erreur HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as { stateVersion: number; stateUpdatedAt: string };
  }

  async getBinary(path: string): Promise<Buffer | null> {
    const token = this.getAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new CloudApiError(`Erreur HTTP ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  connectSocket(token: string): Socket {
    return io(this.baseUrl, { auth: { token }, transports: ['websocket'] });
  }
}
