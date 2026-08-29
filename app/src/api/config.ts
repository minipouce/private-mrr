import * as SecureStore from 'expo-secure-store';

/**
 * URL du serveur et jeton d'API.
 *
 * Le jeton est conservé dans SecureStore — chiffré par le keystore Android —
 * et jamais dans AsyncStorage, qui est lisible en clair sur un appareil rooté.
 */
const URL_KEY = 'mrr.server_url';
const TOKEN_KEY = 'mrr.api_token';

export interface ServerConfig {
  baseUrl: string;
  token: string;
}

let cached: ServerConfig | null = null;

export async function loadConfig(): Promise<ServerConfig | null> {
  if (cached) return cached;

  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (!baseUrl || !token) return null;

  cached = { baseUrl, token };
  return cached;
}

export async function saveConfig(baseUrl: string, token: string): Promise<void> {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  await Promise.all([
    SecureStore.setItemAsync(URL_KEY, normalized),
    SecureStore.setItemAsync(TOKEN_KEY, token.trim()),
  ]);
  cached = { baseUrl: normalized, token: token.trim() };
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(URL_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
  ]);
  cached = null;
}

export function peekConfig(): ServerConfig | null {
  return cached;
}
