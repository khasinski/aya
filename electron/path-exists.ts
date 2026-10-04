import { promises as fs } from "node:fs";

export const pathExists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);
