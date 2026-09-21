export interface RequestOutput {
  handle(request: Request): Promise<Response>
}
