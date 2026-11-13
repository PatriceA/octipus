export const PACKAGES: string[];
export const ZOD3_ONLY: RegExp;
export function patchSource(source: string): string;
export function patchBotbuilder(from: string): { patched: string[]; remaining: string[] };
