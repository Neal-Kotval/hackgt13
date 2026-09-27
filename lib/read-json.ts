// Parses a JSON API response. A proxy or restart error page (CloudFront's HTML 502/504 while
// the server is busy or restarting) becomes a readable message instead of
// "Unexpected token '<', "<!DOCTYPE "... is not valid JSON".
export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`AgentCloud didn't respond in time (HTTP ${response.status}). Try again in a moment.`);
  }
}
