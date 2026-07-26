export interface ProjectAuthority {
  announceProjectServer(
    server: { readonly port: number; readonly url: string },
    signal?: AbortSignal
  ): Promise<void>;
  release(): Promise<void>;
}
