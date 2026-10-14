// "@supabase/supabase-js" の代わり(scripts/_lib/api-path-hooks.mjs)。テストが globalThis.__FAKE_DB__ に置いた偽の DB を返す
export function createClient() {
  if (!globalThis.__FAKE_DB__) throw new Error("偽の DB がありません(globalThis.__FAKE_DB__)");
  return new Proxy({}, { get: (_t, k) => globalThis.__FAKE_DB__[k] });
}
