import { invoke } from "@tauri-apps/api/core"

export async function postJsonViaNativeHttp(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<string> {
  return invoke<string>("post_json_via_native_http", { url, headers, body })
}
