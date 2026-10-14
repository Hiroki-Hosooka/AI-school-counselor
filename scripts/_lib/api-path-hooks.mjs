// ============================================================================
//  画面と同じ API の経路のテスト(scripts/test-api-path.mjs)のための読み込みの差し替え(2026年10月14日)
//   ・"@/..."(tsconfig の paths)を、テストする作業ツリーの src/ に向ける(環境変数 API_PATH_ROOT)
//   ・"@supabase/supabase-js" を、メモリ上の偽の DB(scripts/_lib/fake-supabase.mjs)に差し替える
//  route.ts(TypeScript)は Node の型の取り除き(Node 22.18 以降は既定で有効)でそのまま読む
// ============================================================================
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname);
const FAKE = pathToFileURL(path.join(here, "fake-supabase-module.mjs")).href;

export async function resolve(specifier, context, next) {
  if (specifier === "@supabase/supabase-js") return { url: FAKE, shortCircuit: true };
  if (specifier.startsWith("@/")) {
    const root = process.env.API_PATH_ROOT;
    return next(pathToFileURL(path.join(root, "src", specifier.slice(2))).href, context);
  }
  return next(specifier, context);
}
