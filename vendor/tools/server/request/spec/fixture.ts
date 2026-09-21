import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
export const token = "test-token-not-a-real-secret-1234567890"
export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/tools", {method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json", ...headers}, body: JSON.stringify(body)})
}
