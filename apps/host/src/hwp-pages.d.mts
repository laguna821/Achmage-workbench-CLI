export function hangulPages(path: string, format: string): Promise<{ page: number; width: number; height: number; svg: string }[]>;
export function hangulFirstPage(path: string, format: string): Promise<{ width: number; height: number; svg: string } | null>;
