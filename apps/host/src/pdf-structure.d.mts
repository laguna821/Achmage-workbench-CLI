type Handler = (...args: any[]) => any;
export function pdfStructure(directory: string, isGranted: (owner: number, path: string) => boolean): {
  pickTarget(owner: number, source: string, path: string, kind: string): Promise<string | null>;
  handlers: Record<string, Handler>;
  running(): number;
  close(): number;
};
