export interface BoardImageSignaturePart {
  readonly at: number;
  readonly bytes?: readonly number[];
  readonly text?: string;
}
export interface BoardImageFormat {
  readonly name: string;
  readonly mime: string;
  readonly ext: string;
  readonly signatures: readonly (readonly BoardImageSignaturePart[])[];
}
export const BOARD_IMAGE_FORMATS: readonly BoardImageFormat[];
export const BOARD_IMAGE_ACCEPT: string;
export function listBoardImageFormats(conjunction: "and" | "or"): string;
export function detectBoardImageFormat(bytes: Uint8Array): BoardImageFormat | null;
