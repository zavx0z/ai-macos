export interface ServerOutput {
  url: string
  close(): Promise<void>
}
